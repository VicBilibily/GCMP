import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { appendFile } from 'node:fs/promises';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import { StatsPublication } from '../../fileLogger/refresh/statsPublication';
import type { TokenUsageStatsFromFile } from '../../fileLogger/types';
import { createUsageHost } from '../hostFixture';
import { gate, nextTurn, refreshClock, refreshFixture, terminal } from './fixture';

type RefreshFixture = Awaited<ReturnType<typeof refreshFixture>>;
interface PublicationInternals {
    statsFingerprint(stats: Pick<TokenUsageStatsFromFile, 'total'>): string;
    publication: Pick<StatsPublication, 'isPending' | 'acknowledge'>;
}

function publicationWork(context: TestContext, f: RefreshFixture) {
    const stats = f.internals.logStatsManager;
    const internals = stats as unknown as PublicationInternals;
    const fingerprint = internals.statsFingerprint.bind(internals);
    const pending = internals.publication.isPending.bind(internals.publication);
    const hashes = context.mock.method(internals, 'statsFingerprint', (...args: Parameters<typeof fingerprint>) =>
        fingerprint(...args)
    );
    const checks = context.mock.method(internals.publication, 'isPending', (...args: Parameters<typeof pending>) =>
        pending(...args)
    );
    const flushes = context.mock.method(stats, 'flushStatsPublications');
    return {
        hashes,
        checks,
        flushes,
        restore() {
            hashes.mock.restore();
            checks.mock.restore();
            flushes.mock.restore();
        }
    };
}

async function localUpdates<T>(context: TestContext, f: RefreshFixture, operation: () => Promise<T>) {
    const emitter = (f.fileLogger as unknown as { readonly eventEmitter?: EventEmitter }).eventEmitter;
    if (emitter) {
        assert.equal(emitter.listenerCount('update'), 0);
    }
    const emit = EventEmitter.prototype.emit;
    let updates = 0;
    const spy = context.mock.method(
        EventEmitter.prototype,
        'emit',
        function (this: EventEmitter, eventName: string | symbol, ...args: unknown[]): boolean {
            if (eventName === 'update' && this === emitter) {
                updates++;
            }
            return emit.call(this, eventName, ...args);
        }
    );
    try {
        return { value: await operation(), updates };
    } finally {
        spy.mock.restore();
    }
}

async function refreshResult(f: RefreshFixture, clock: ReturnType<typeof refreshClock>) {
    let done = false;
    const work = f.fileLogger.refreshStats(f.date).finally(() => {
        done = true;
    });
    await clock.settle(() => done);
    const result = await work;
    await f.settled();
    assert.ok(result);
    assert.equal(result.delegated, false);
    return result;
}

test('statistics publication avoids redundant hashing and logger-local events', async suite => {
    const host = await createUsageHost();
    async function prepare(context: TestContext) {
        host.reset();
        const clock = refreshClock(context);
        const f = await refreshFixture(host, context);
        const [requestId] = await f.seed(1);
        return { ...f, clock, requestId, statsPath: join(f.dir, 'usages', f.date, 'stats.json') };
    }
    async function completed(context: TestContext, cached: boolean) {
        const f = await prepare(context);
        await f.fileLogger.updateActualTokens(terminal(f.requestId));
        let result = await refreshResult(f, f.clock);
        assert.equal(f.counters.calculations, 1);
        if (cached) {
            const first = result;
            result = await refreshResult(f, f.clock);
            assert.notEqual(result.stats, first.stats);
            assert.equal(f.counters.calculations, 1);
        }
        assert.equal(result.changed, true);
        assert.equal(result.stats.total.requests, 1);
        assert.equal(result.stats.total.completedRequests, 1);
        assert.equal(result.stats.total.actualInput, 10);
        assert.equal(result.stats.total.outputTokens, 5);
        assert.equal(JSON.stringify(await f.saved()), JSON.stringify(result.stats));
        const source = f.fileLogger.getStatsSource(result.stats);
        assert.ok(source);
        assert.notEqual(source.stale, true);
        assert.deepEqual(await new StatsPublication().readPendingStats(f.statsPath), await f.saved());
        assert.equal(f.counters.notifications, 0);
        assert.equal(f.broadcasts().length, 0);
        return { ...f, result };
    }
    try {
        for (const kind of ['rebuilt', 'cached'] as const) {
            for (const acknowledged of [false, true]) {
                await suite.test(`${kind}/${acknowledged ? 'ACK' : 'pending'}: short-circuit work`, async context => {
                    const cached = kind === 'cached';
                    const f = await completed(context, cached);
                    const stats = f.internals.logStatsManager;
                    if (acknowledged) {
                        await stats.markStatsPublished(f.date, f.result.stats);
                        assert.equal(await new StatsPublication().readPendingStats(f.statsPath), undefined);
                    }
                    const work = publicationWork(context, f);
                    try {
                        assert.equal(await stats.hasStatsChanged(f.date, f.result.stats), !cached || !acknowledged);
                        assert.equal(work.flushes.mock.callCount(), 1);
                        assert.equal(work.checks.mock.callCount(), cached ? 1 : 0);
                        assert.equal(work.hashes.mock.callCount(), cached ? 1 : 0);
                        if (cached) {
                            const hash = work.hashes.mock.calls[0];
                            assert.equal(hash.arguments[0], f.result.stats);
                            assert.deepEqual(work.checks.mock.calls[0].arguments, [f.statsPath, hash.result]);
                            assert.equal(await work.checks.mock.calls[0].result, !acknowledged);
                        }
                    } finally {
                        work.restore();
                    }
                });
            }
            await suite.test(`${kind}: stale entry skips flush, hashing and pending lookup`, async context => {
                const f = await completed(context, kind === 'cached');
                await appendFile(f.statsPath, '\n');
                const work = publicationWork(context, f);
                try {
                    assert.equal(await f.internals.logStatsManager.hasStatsChanged(f.date, f.result.stats), false);
                    assert.equal(f.fileLogger.getStatsSource(f.result.stats)?.stale, true);
                    assert.equal(work.flushes.mock.callCount(), 0);
                    assert.equal(work.hashes.mock.callCount(), 0);
                    assert.equal(work.checks.mock.callCount(), 0);
                } finally {
                    work.restore();
                }
            });
        }

        for (const scenario of ['ACK-cache', 'stale-rebuilt', 'stale-cache'] as const) {
            await suite.test(`${scenario}: change detection waits for the real queued ACK`, async context => {
                const f = await completed(context, scenario !== 'stale-rebuilt');
                const stats = f.internals.logStatsManager;
                const { publication } = stats as unknown as PublicationInternals;
                const acknowledge = publication.acknowledge.bind(publication);
                const blocked = gate();
                let entered = false;
                const ackSpy = context.mock.method(
                    publication,
                    'acknowledge',
                    async (...args: Parameters<typeof acknowledge>) => {
                        entered = true;
                        await blocked.promise;
                        return acknowledge(...args);
                    }
                );
                const queuedAck = stats.markStatsPublished(f.date, f.result.stats);
                const work = publicationWork(context, f);
                let settled = false;
                const checking = stats.hasStatsChanged(f.date, f.result.stats).finally(() => {
                    settled = true;
                });
                try {
                    await nextTurn();
                    assert.equal(entered, true);
                    assert.equal(work.flushes.mock.callCount(), 1);
                    assert.equal(settled, false);
                    assert.equal(work.hashes.mock.callCount(), 0);
                    assert.equal(work.checks.mock.callCount(), 0);
                    const stale = scenario !== 'ACK-cache';
                    if (stale) {
                        await appendFile(f.statsPath, '\n');
                    }
                    blocked.release();
                    await queuedAck;
                    assert.equal(await checking, false);
                    assert.equal(f.fileLogger.getStatsSource(f.result.stats)?.stale === true, stale);
                    assert.equal(await ackSpy.mock.calls[0].result, !stale);
                    const pending = await new StatsPublication().readPendingStats(f.statsPath);
                    assert.deepEqual(pending, stale ? await f.saved() : undefined);
                    if (!stale) {
                        assert.equal(work.hashes.mock.callCount(), 1);
                        assert.equal(work.checks.mock.callCount(), 1);
                        assert.equal(await work.checks.mock.calls[0].result, false);
                    }
                } finally {
                    blocked.release();
                    await Promise.allSettled([queuedAck, checking]);
                    work.restore();
                    ackSpy.mock.restore();
                }
            });
        }

        await suite.test('logger has no local emitter, subscription API or notification method', async context => {
            const f = await prepare(context);
            assert.deepEqual(
                ['eventEmitter', 'onStatsUpdate', 'notifyUpdate'].filter(name => name in f.fileLogger),
                []
            );
        });

        for (const phase of [
            'estimated',
            'completed',
            'failed',
            'cancelled',
            'pending-title',
            'disk-title',
            'refresh-changed',
            'refresh-unchanged'
        ] as const) {
            await suite.test(`${phase}: logger-only work preserves data without local updates`, async context => {
                const f = await prepare(context);
                const requestId = phase === 'estimated' ? `${Date.now()}_extra` : f.requestId;
                if (phase === 'disk-title' || phase === 'refresh-changed') {
                    await f.fileLogger.updateActualTokens(terminal(requestId));
                }
                const measured = await localUpdates(context, f, async () => {
                    if (phase === 'estimated') {
                        await f.fileLogger.recordEstimatedTokens({
                            requestId,
                            providerKey: 'test',
                            providerName: 'Test',
                            modelId: 'test',
                            modelName: 'Test',
                            estimatedInput: 10
                        });
                    } else if (phase === 'pending-title' || phase === 'disk-title') {
                        assert.equal(
                            await f.fileLogger.backfillSessionTitle({
                                requestId,
                                sessionId: 'publication-session',
                                sessionTitle: '回填标题'
                            }),
                            true
                        );
                    } else if (phase === 'refresh-changed' || phase === 'refresh-unchanged') {
                        return refreshResult(f, f.clock);
                    } else {
                        await f.fileLogger.updateActualTokens({ ...terminal(requestId), status: phase });
                    }
                    return undefined;
                });
                if (phase === 'pending-title') {
                    const pending = f.fileLogger.getPendingLogs().find(row => row.requestId === requestId);
                    assert.equal(pending?.sessionId, 'publication-session');
                    assert.equal(pending?.sessionTitle, '回填标题');
                    await f.fileLogger.updateActualTokens(terminal(requestId));
                }
                const details = await f.fileLogger.getRequestDetails(f.date);
                const row = details.find(value => value.requestId === requestId);
                assert.ok(row);
                const estimated = phase === 'estimated' || phase === 'refresh-unchanged';
                const status =
                    estimated ? 'estimated'
                    : phase === 'failed' || phase === 'cancelled' ? phase
                    : 'completed';
                assert.equal(details.length, phase === 'estimated' ? 2 : 1);
                assert.equal(row.status, status);
                assert.equal(row.estimatedInput, 10);
                assert.deepEqual(row.rawUsage, estimated ? null : terminal(requestId).rawUsage);
                if (phase === 'pending-title' || phase === 'disk-title') {
                    assert.equal(row.sessionId, 'publication-session');
                    assert.equal(row.sessionTitle, '回填标题');
                }
                assert.equal(f.fileLogger.getPendingLogs().length, estimated ? details.length : 0);
                const stats = measured.value?.stats ?? (await f.fileLogger.getDateStats(f.date, true));
                assert.equal(stats.total.requests, details.length);
                assert.equal(stats.total.completedRequests, status === 'completed' ? 1 : 0);
                assert.equal(stats.total.failedRequests, status === 'failed' ? 1 : 0);
                assert.equal(stats.total.cancelledRequests, status === 'cancelled' ? 1 : 0);
                assert.equal(stats.total.actualInput, estimated ? 0 : 10);
                assert.equal(stats.total.outputTokens, estimated ? 0 : 5);
                assert.equal(JSON.stringify(await f.saved()), JSON.stringify(stats));
                if (phase === 'refresh-changed' || phase === 'refresh-unchanged') {
                    assert.ok(measured.value);
                    assert.equal(measured.value.changed, phase === 'refresh-changed');
                    assert.equal(f.counters.calculations, phase === 'refresh-changed' ? 1 : 0);
                }
                assert.equal(f.counters.notifications, 0);
                assert.equal(f.broadcasts().length, 0);
                assert.equal(measured.updates, 0);
            });
        }

        for (const phase of ['estimated', 'completed'] as const) {
            await suite.test(`${phase}: Manager keeps one notification, broadcast and durable ACK`, async context => {
                const f = await prepare(context);
                const stats = f.internals.logStatsManager;
                const { publication } = stats as unknown as PublicationInternals;
                const acknowledge = publication.acknowledge.bind(publication);
                let pendingBeforeAck: TokenUsageStatsFromFile | undefined;
                const acknowledgements = context.mock.method(
                    publication,
                    'acknowledge',
                    async (...args: Parameters<typeof acknowledge>) => {
                        pendingBeforeAck = await new StatsPublication().readPendingStats(f.statsPath);
                        return acknowledge(...args);
                    }
                );
                const publications = context.mock.method(f.fileLogger, 'markStatsPublished');
                if (phase === 'estimated') {
                    await f.manager.recordEstimatedTokens({
                        providerKey: 'test',
                        displayName: 'Test',
                        modelId: 'test',
                        modelName: 'Test',
                        estimatedInputTokens: 10
                    });
                } else {
                    f.manager.updateActualTokens(terminal(f.requestId));
                }
                await f.idleWrites();
                assert.equal(f.counters.notifications, 0);
                assert.equal(f.broadcasts().length, 0);
                await f.clock.settle(() => f.counters.notifications === 1);
                await f.settled();
                await stats.flushStatsPublications();
                const saved = await f.saved();
                assert.equal(saved.total.requests, phase === 'estimated' ? 2 : 1);
                assert.equal(saved.total.completedRequests, phase === 'completed' ? 1 : 0);
                assert.equal(saved.total.actualInput, phase === 'completed' ? 10 : 0);
                assert.equal(saved.total.outputTokens, phase === 'completed' ? 5 : 0);
                assert.deepEqual(pendingBeforeAck, saved);
                assert.equal(publications.mock.callCount(), 1);
                assert.equal(acknowledgements.mock.callCount(), 1);
                assert.equal(await acknowledgements.mock.calls[0].result, true);
                assert.equal(await new StatsPublication().readPendingStats(f.statsPath), undefined);
                const next = await refreshResult(f, f.clock);
                assert.equal(next.changed, false);
                f.manager.notifyStatsUpdate(next);
                await stats.flushStatsPublications();
                assert.equal(f.counters.calculations, 1);
                assert.equal(f.counters.notifications, 1);
                assert.equal(publications.mock.callCount(), 1);
                assert.equal(acknowledgements.mock.callCount(), 1);
                assert.deepEqual(
                    f.broadcasts().map(({ event }) => (event.type === 'tokenUsageUpdated' ? event.payload : undefined)),
                    [{ date: f.date, totalTokens: phase === 'completed' ? 15 : 0, totalRequests: saved.total.requests }]
                );
            });
        }
    } finally {
        host.restore();
    }
});
