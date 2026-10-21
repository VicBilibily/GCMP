import assert from 'node:assert/strict';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import type { UsageStatusSnapshotEvent } from '../../../interInstance/eventProtocol';
import { StatsPublication } from '../../fileLogger/refresh/statsPublication';
import type { StatsResultSource } from '../../fileLogger/refresh/statsRefreshQueue';
import type { TokenUsageStatsFromFile } from '../../fileLogger/types';
import { getFileVersionSync } from '../../persistence/versionedJsonFile';
import { createUsageHost } from '../../tests/hostFixture';
import { refreshClock, refreshFixture, terminal } from '../../tests/refresh/fixture';

test('statistics notification source validation work', async suite => {
    const host = await createUsageHost();
    const { UsageStatusSnapshots } = await import('../usageStatusSnapshots');
    const snapshotPublications: UsageStatusSnapshotEvent['payload'][] = [];
    Object.assign(host.bus, {
        publishIpcOnly(event: Pick<UsageStatusSnapshotEvent, 'type' | 'payload'>) {
            snapshotPublications.push(event.payload);
            return true;
        }
    });

    async function prepare(c: TestContext, fileMode: boolean) {
        host.reset();
        snapshotPublications.length = 0;
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
            date => f.fileLogger.getLatestStatusStats(date)
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
        assert.equal(result.stats.total.requests, 1);
        assert.equal(result.stats.total.completedRequests, 1);
        assert.equal(result.stats.total.actualInput, 10);
        assert.equal(result.stats.total.outputTokens, 5);
        assert.equal(JSON.stringify(await f.saved()), JSON.stringify(result.stats));
        const statsPath = join(f.dir, 'usages', f.date, 'stats.json');
        const savedBody = readFileSync(statsPath, 'utf8');
        const version = getFileVersionSync(statsPath);
        assert.notEqual(version, 'missing');
        const source = f.fileLogger.getStatsSource(result.stats);
        assert.ok(source);
        assert.ok(Object.isFrozen(source));
        assert.notEqual(source.stale, true);
        assert.equal(source.authorityTerm, fileMode ? undefined : 'leader:1');
        assert.equal(f.fileLogger.getLatestStatusStats(f.date)?.source, source);
        assert.deepEqual(await new StatsPublication().readPendingStats(statsPath), await f.saved());
        assert.equal(f.broadcasts().length, 0);
        assert.equal(snapshotPublications.length, 0);
        assert.equal(status.peek(), undefined);

        let measuring = false;
        let inAck = false;
        const steps: string[] = [];
        const sourceChecks: Array<{ stats: TokenUsageStatsFromFile; source: StatsResultSource | undefined }> = [];
        const getSource = f.internals.logStatsManager.getResultSource.bind(f.internals.logStatsManager);
        c.mock.method(f.internals.logStatsManager, 'getResultSource', (stats: TokenUsageStatsFromFile) => {
            const current = getSource(stats);
            if (measuring && !inAck) {
                sourceChecks.push({ stats, source: current });
                steps.push('source');
            }
            return current;
        });
        const acknowledge = f.fileLogger.markStatsPublished.bind(f.fileLogger);
        const acknowledgements = c.mock.method(
            f.fileLogger,
            'markStatsPublished',
            (...args: Parameters<typeof acknowledge>) => {
                inAck = true;
                try {
                    return acknowledge(...args);
                } finally {
                    inAck = false;
                }
            }
        );
        const updates: number[] = [];
        const listener = status.onUpdate(snapshot => {
            updates.push(snapshot.stats.total.requests);
            if (measuring) {
                steps.push('update');
            }
        });
        c.after(() => listener.dispose());
        const statusUpdates = c.mock.method(status, 'update');
        const currentChecks = c.mock.method(status, 'isCurrent');
        return {
            ...f,
            status,
            result,
            source,
            statsPath,
            savedBody,
            version,
            steps,
            sourceChecks,
            acknowledgements,
            updates,
            statusUpdates,
            currentChecks,
            measure<T>(operation: () => T): T {
                measuring = true;
                try {
                    return operation();
                } finally {
                    measuring = false;
                }
            }
        };
    }

    try {
        for (const fileMode of [false, true]) {
            const mode = fileMode ? 'fileMode' : 'owned IPC';
            await suite.test(
                `${mode}: notification reuses the entry source and validates again after update`,
                async c => {
                    const f = await prepare(c, fileMode);
                    f.measure(() => f.manager.notifyStatsUpdate(f.result));
                    const firstChecks = [...f.sourceChecks];
                    f.measure(() => f.manager.notifyStatsUpdate(f.result));
                    await f.internals.logStatsManager.flushStatsPublications();
                    f.measure(() => f.manager.notifyStatsUpdate(f.result));
                    await f.internals.logStatsManager.flushStatsPublications();

                    assert.deepEqual(f.sourceChecks, firstChecks);
                    assert.deepEqual(f.updates, [1]);
                    assert.equal(f.status.peek()?.stats.total.actualInput, 10);
                    assert.equal(f.status.peek()?.stats.total.outputTokens, 5);
                    assert.equal(f.status.peek()?.authorityTerm, fileMode ? 'file' : 'leader:1');
                    assert.equal(snapshotPublications.length, fileMode ? 0 : 1);
                    if (!fileMode) {
                        assert.equal(snapshotPublications[0].snapshot, f.status.peek());
                    }
                    assert.equal(f.counters.notifications, 1);
                    assert.deepEqual(
                        f
                            .broadcasts()
                            .map(({ event }) => (event.type === 'tokenUsageUpdated' ? event.payload : undefined)),
                        [{ date: f.date, totalTokens: 15, totalRequests: 1 }]
                    );
                    assert.equal(f.acknowledgements.mock.calls.length, 1);
                    assert.equal(f.acknowledgements.mock.calls[0].arguments[0], f.result);
                    assert.equal(
                        await (
                            f.internals.logStatsManager as unknown as { publication: StatsPublication }
                        ).publication.readPendingStats(f.statsPath),
                        undefined
                    );
                    assert.equal(getFileVersionSync(f.statsPath), f.version);
                    assert.equal(f.statusUpdates.mock.calls.length, 1);
                    assert.equal(f.currentChecks.mock.calls.length, 1);
                    assert.equal(f.currentChecks.mock.calls[0].arguments[0], f.result.stats);
                    assert.ok(firstChecks.every(check => check.stats === f.result.stats && check.source === f.source));
                    assert.equal(firstChecks.length, 2);
                    assert.deepEqual(f.steps, ['source', 'update', 'source']);
                    const updateArguments: readonly unknown[] = f.statusUpdates.mock.calls[0].arguments;
                    assert.equal(updateArguments[2], f.source);
                }
            );

            await suite.test(`${mode}: independent update validates its own source exactly once`, async c => {
                const f = await prepare(c, fileMode);
                const snapshot = f.measure(() => f.status.update(f.date, f.result.stats));
                assert.ok(snapshot);
                assert.equal(snapshot, f.status.peek());
                assert.equal(snapshot.stats.total.actualInput, 10);
                assert.equal(snapshot.stats.total.outputTokens, 5);
                assert.deepEqual(f.sourceChecks, [{ stats: f.result.stats, source: f.source }]);
                assert.deepEqual(f.steps, ['source', 'update']);
                assert.equal(f.statusUpdates.mock.calls[0].arguments.length, 2);

                writeFileSync(f.statsPath, `${f.savedBody}\n`);
                assert.notEqual(getFileVersionSync(f.statsPath), f.version);
                assert.equal(
                    f.measure(() => f.status.update(f.date, f.result.stats)),
                    undefined
                );
                assert.equal(f.sourceChecks.length, 2);
                assert.equal(f.sourceChecks[1].stats, f.result.stats);
                assert.equal(f.sourceChecks[1].source?.revision, f.source.revision);
                assert.equal(f.sourceChecks[1].source?.stale, true);
                assert.equal(f.status.peek(), snapshot);
                assert.deepEqual(f.updates, [1]);
                assert.equal(snapshotPublications.length, fileMode ? 0 : 1);
                assert.equal(f.currentChecks.mock.calls.length, 0);
                assert.equal(f.acknowledgements.mock.calls.length, 0);
                assert.equal(f.broadcasts().length, 0);
                assert.equal(f.counters.notifications, 0);
            });

            await suite.test(
                `${mode}: synchronous subscriber file replacement rejects the old stats broadcast and ACK`,
                async c => {
                    const f = await prepare(c, fileMode);
                    const receiptPath = join(f.dir, 'usages', f.date, 'stats-published.json');
                    assert.equal(existsSync(receiptPath), false);
                    let replaced = false;
                    const listener = f.status.onUpdate(() => {
                        writeFileSync(f.statsPath, `${f.savedBody}\n`);
                        replaced = true;
                    });
                    c.after(() => listener.dispose());

                    f.measure(() => f.manager.notifyStatsUpdate(f.result));
                    assert.equal(replaced, true);
                    assert.notEqual(getFileVersionSync(f.statsPath), f.version);
                    assert.equal(f.sourceChecks[0].source, f.source);
                    assert.equal(f.sourceChecks.at(-1)?.stats, f.result.stats);
                    assert.equal(f.sourceChecks.at(-1)?.source?.stale, true);
                    assert.ok(f.steps.lastIndexOf('source') > f.steps.indexOf('update'));
                    assert.equal(f.currentChecks.mock.calls.length, 1);
                    assert.equal(f.currentChecks.mock.calls[0].result, false);
                    assert.deepEqual(f.updates, [1]);
                    assert.equal(f.broadcasts().length, 0);
                    assert.equal(f.acknowledgements.mock.calls.length, 0);
                    assert.equal(f.counters.notifications, 0);

                    f.measure(() => f.manager.notifyStatsUpdate(f.result));
                    await f.internals.logStatsManager.flushStatsPublications();
                    assert.deepEqual(f.updates, [1]);
                    assert.equal(f.broadcasts().length, 0);
                    assert.equal(f.acknowledgements.mock.calls.length, 0);
                    assert.equal(existsSync(receiptPath), false);
                    assert.deepEqual(await new StatsPublication().readPendingStats(f.statsPath), await f.saved());
                    const current = await f.fileLogger.readSavedStats(f.date);
                    assert.ok(current);
                    assert.equal(JSON.stringify(current), JSON.stringify(f.result.stats));
                    const currentSource = f.fileLogger.getStatsSource(current);
                    assert.ok(currentSource);
                    assert.notEqual(currentSource.stale, true);
                    assert.ok(currentSource.revision > f.source.revision);
                    assert.equal(currentSource.authorityTerm, f.source.authorityTerm);
                }
            );
        }
    } finally {
        host.restore();
    }
});
