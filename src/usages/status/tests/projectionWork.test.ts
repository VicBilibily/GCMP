import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';
import type { UsageStatusSnapshotEvent } from '../../../interInstance/eventProtocol';
import type { TokenUsageStatsFromFile } from '../../fileLogger/types';
import { createUsageHost } from '../../tests/hostFixture';
import { refreshClock, refreshFixture, terminal } from '../../tests/refresh/fixture';
import { isUsageStatusSnapshot, projectUsageStatus, type LatestUsageStatus, type UsageStatusStats } from '../snapshot';

function assertProjection(stats: UsageStatusStats): void {
    const fields = [
        'actualInput',
        'cacheTokens',
        'outputTokens',
        'requests',
        'costedRequests',
        'rmbExactRequests',
        'estimatedCost',
        'estimatedCostRmb',
        'firstTokenLatency',
        'outputSpeeds',
        'nativeCosts'
    ];
    assert.deepEqual(Object.keys(stats).sort(), ['providers', 'total']);
    assert.ok(Object.isFrozen(stats));
    assert.ok(Object.isFrozen(stats.providers));
    for (const total of [stats.total, ...Object.values(stats.providers)]) {
        const allowed = total === stats.total ? fields : [...fields, 'providerName'];
        assert.ok(Object.keys(total).every(key => allowed.includes(key)));
        assert.ok(Object.isFrozen(total));
        if (total.nativeCosts) {
            assert.deepEqual(Object.keys(total.nativeCosts).sort(), ['totalRmb', 'totalUsd']);
            assert.ok(Object.isFrozen(total.nativeCosts));
        }
    }
}

function measureProviders<T>(c: TestContext, stats: TokenUsageStatsFromFile, operation: () => T) {
    const entries = c.mock.method(Object, 'entries');
    try {
        const result = operation();
        // 只计完整来源的枚举，不把轻量 IPC 校验算作重复投影。
        const enumerations = entries.mock.calls.filter(call => call.arguments[0] === stats.providers).length;
        return { result, enumerations };
    } finally {
        entries.mock.restore();
    }
}

function watchReads(c: TestContext, f: Awaited<ReturnType<typeof refreshFixture>>) {
    const latest = c.mock.method(f.fileLogger, 'getLatestStatusStats');
    const saved = c.mock.method(f.fileLogger, 'readSavedStats');
    const owned = c.mock.method(f.fileLogger, 'getDateStats');
    return {
        latest,
        assertCalls(expected = 1) {
            assert.equal(latest.mock.calls.length, expected);
            if (expected) {
                assert.deepEqual(latest.mock.calls[0].arguments, [f.date]);
            }
            assert.equal(saved.mock.calls.length, 0);
            assert.equal(owned.mock.calls.length, 0);
        }
    };
}

test('status snapshots reuse existing lightweight projections', async suite => {
    const host = await createUsageHost();
    const { UsageStatusSnapshots } = await import('../usageStatusSnapshots');
    const publications: UsageStatusSnapshotEvent['payload'][] = [];
    Object.assign(host.bus, {
        publishIpcOnly(event: Pick<UsageStatusSnapshotEvent, 'type' | 'payload'>) {
            publications.push(event.payload);
            return true;
        }
    });

    async function prepare(c: TestContext, fileMode: boolean, withLatest = true) {
        host.reset();
        publications.length = 0;
        if (fileMode) {
            host.state.leaderId = undefined;
        }
        const clock = refreshClock(c);
        const f = await refreshFixture(host, c);
        const status = new UsageStatusSnapshots(
            fileMode,
            date => f.fileLogger.readSavedStats(date),
            date => f.fileLogger.getDateStats(date),
            stats => f.fileLogger.getStatsSource(stats),
            withLatest ? date => f.fileLogger.getLatestStatusStats(date) : undefined
        );
        Object.assign(f.manager, { statusSnapshots: status });
        const ids = await f.seed(1);
        await f.fileLogger.updateActualTokens(terminal(ids[0]));
        let done = false;
        const work = f.fileLogger.refreshStats(f.date).finally(() => {
            done = true;
        });
        await clock.settle(() => done);
        const result = await work;
        assert.ok(result?.changed);
        assert.equal(result.delegated, false);
        assert.equal(result.stats.total.actualInput, 10);
        assert.equal(result.stats.total.outputTokens, 5);
        assert.ok(Object.keys(result.stats.providers.test.models).length > 0);
        const source = f.fileLogger.getStatsSource(result.stats);
        const latest = f.fileLogger.getLatestStatusStats(f.date);
        assert.ok(source);
        assert.ok(latest);
        assert.equal(latest.source, source);
        assert.notEqual(source.stale, true);
        assert.equal(source.authorityTerm, fileMode ? undefined : 'leader:1');
        assert.ok(Object.isFrozen(source));
        assert.ok(Object.isFrozen(latest));
        assertProjection(latest.stats);
        assert.deepEqual(latest.stats, projectUsageStatus(result.stats));
        assert.equal(status.peek(), undefined);
        assert.equal(publications.length, 0);
        return { ...f, status, result, source, latest };
    }

    try {
        for (const fileMode of [false, true]) {
            const mode = fileMode ? 'fileMode' : 'owned IPC';
            await suite.test(`${mode}: notify reuses latest identity with zero full-provider enumerations`, async c => {
                const f = await prepare(c, fileMode);
                const reads = watchReads(c, f);
                const current = c.mock.method(f.status, 'isCurrent');
                const measured = measureProviders(c, f.result.stats, () => f.manager.notifyStatsUpdate(f.result));
                await f.internals.logStatsManager.flushStatsPublications();
                const snapshot = f.status.peek();
                assert.ok(snapshot);
                assert.equal(snapshot.stats, f.latest.stats);
                assert.equal(measured.enumerations, 0);
                assertProjection(snapshot.stats);
                assert.ok(Object.isFrozen(snapshot));
                assert.ok(isUsageStatusSnapshot(snapshot));
                assert.equal(snapshot.authorityTerm, fileMode ? 'file' : 'leader:1');
                reads.assertCalls();
                assert.equal(current.mock.calls.length, 1);
                assert.equal(current.mock.calls[0].result, true);
                assert.equal(f.broadcasts().length, 1);
                assert.equal(publications.length, fileMode ? 0 : 1);
                if (!fileMode) {
                    assert.equal(publications[0].snapshot, snapshot);
                }
            });

            await suite.test(`${mode}: newer real latest takes over an old result without copying`, async c => {
                const f = await prepare(c, fileMode);
                await f.fileLogger.recordEstimatedTokens({
                    requestId: `${Date.now()}_newer`,
                    providerKey: 'test',
                    providerName: 'Test',
                    modelId: 'test',
                    modelName: 'Test',
                    estimatedInput: 10
                });
                await f.fileLogger.flush();
                const full = await f.fileLogger.getDateStats(f.date, true);
                const latest = f.fileLogger.getLatestStatusStats(f.date);
                assert.ok(latest);
                assert.equal(full.total.requests, 2);
                assert.equal(latest.source, f.fileLogger.getStatsSource(full));
                assert.ok(latest.source.revision > f.source.revision);
                assert.ok(Object.isFrozen(latest));
                assertProjection(latest.stats);
                const reads = watchReads(c, f);
                const current = c.mock.method(f.status, 'isCurrent');
                f.manager.notifyStatsUpdate(f.result);
                const snapshot = f.status.peek();
                assert.ok(snapshot);
                assert.equal(snapshot.stats, latest.stats);
                assert.notEqual(snapshot.stats, f.latest.stats);
                assert.equal(snapshot.stats.total.requests, 2);
                assert.ok(isUsageStatusSnapshot(snapshot));
                assertProjection(snapshot.stats);
                reads.assertCalls();
                assert.equal(current.mock.calls.length, 1);
                assert.equal(current.mock.calls[0].result, false);
                assert.equal(f.broadcasts().length, 0);
                assert.equal(publications.length, fileMode ? 0 : 1);
                if (!fileMode) {
                    assert.equal(publications[0].snapshot.stats, latest.stats);
                }
            });

            await suite.test(`${mode}: independent update without latest really projects full statistics`, async c => {
                const f = await prepare(c, fileMode, false);
                const reads = watchReads(c, f);
                const measured = measureProviders(c, f.result.stats, () => f.status.update(f.date, f.result.stats));
                const snapshot = measured.result;
                assert.ok(snapshot);
                assert.equal(snapshot, f.status.peek());
                assert.notEqual(snapshot.stats, f.result.stats);
                assert.notEqual(snapshot.stats, f.latest.stats);
                assert.deepEqual(snapshot.stats, f.latest.stats);
                assert.ok(measured.enumerations > 0);
                assertProjection(snapshot.stats);
                assert.ok(isUsageStatusSnapshot(snapshot));
                reads.assertCalls(0);
            });

            await suite.test(`${mode}: independent invalid statistics still throw without latest`, async c => {
                const f = await prepare(c, fileMode, false);
                const reads = watchReads(c, f);
                f.result.stats.total.requests = -1;
                assert.throws(() => f.status.update(f.date, f.result.stats), /Invalid usage status statistics/);
                assert.equal(f.status.peek(), undefined);
                assert.equal(publications.length, 0);
                reads.assertCalls(0);
            });

            await suite.test(`${mode}: equal revision cannot substitute a different source identity`, async c => {
                const f = await prepare(c, fileMode);
                const mismatched: LatestUsageStatus = Object.freeze({
                    source: Object.freeze({ ...f.source }),
                    stats: Object.freeze({
                        ...f.latest.stats,
                        total: Object.freeze({ ...f.latest.stats.total, actualInput: 999 })
                    })
                });
                assert.notEqual(mismatched.source, f.source);
                assert.equal(mismatched.source.revision, f.source.revision);
                const reads = watchReads(c, f);
                reads.latest.mock.mockImplementation(() => mismatched);
                const measured = measureProviders(c, f.result.stats, () => f.status.update(f.date, f.result.stats));
                const snapshot = measured.result;
                assert.ok(snapshot);
                assert.notEqual(snapshot.stats, mismatched.stats);
                assert.notEqual(snapshot.stats, f.latest.stats);
                assert.deepEqual(snapshot.stats, f.latest.stats);
                assert.equal(snapshot.stats.total.actualInput, 10);
                assert.ok(measured.enumerations > 0);
                assertProjection(snapshot.stats);
                assert.ok(isUsageStatusSnapshot(snapshot));
                reads.assertCalls();
            });
        }

        await suite.test('owner first get reuses latest without an existing snapshot or a new read', async c => {
            const f = await prepare(c, false);
            const reads = watchReads(c, f);
            assert.equal(f.status.peek(), undefined);
            const snapshot = await f.status.get();
            assert.ok(snapshot);
            assert.equal(snapshot, f.status.peek());
            assert.equal(snapshot.stats, f.latest.stats);
            assertProjection(snapshot.stats);
            assert.ok(Object.isFrozen(snapshot));
            assert.ok(isUsageStatusSnapshot(snapshot));
            assert.equal(publications.length, 1);
            assert.equal(publications[0].snapshot.stats, f.latest.stats);
            reads.assertCalls();
        });
    } finally {
        host.restore();
    }
});
