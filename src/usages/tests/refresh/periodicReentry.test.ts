import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import test, { type TestContext } from 'node:test';
import type { LeaderElectionService } from '../../../status/leaderElectionService';
import { DateUtils } from '../../fileLogger/dateUtils';
import type { StatsPublication } from '../../fileLogger/refresh/statsPublication';
import type { TokenUsageStatsFromFile } from '../../fileLogger/types';
import type { JsonFileSnapshot } from '../../persistence/versionedJsonFile';
import { createUsageHost } from '../hostFixture';
import { initializeLogger } from '../recovery/fixture';
import { gate, nextTurn, refreshClock } from './fixture';

type Phase = 'maintenance' | 'today' | 'recovery';
type Authority = Pick<typeof LeaderElectionService, 'getOwnedAuthorityTerm'>;
interface IndexInternals {
    getAllStatsDates(): Promise<string[]>;
    loadStats(date: string): Promise<JsonFileSnapshot<Pick<TokenUsageStatsFromFile, 'total'>> | null>;
}
interface Work {
    promise: Promise<void>;
    settled: boolean;
}

test('periodic usage callback skips reentry across the entire cycle', { timeout: 30000 }, async suite => {
    const host = await createUsageHost();
    try {
        const require = createRequire(import.meta.url);
        const modules = require('node:module') as { prototype: { require(id: string): unknown } };
        const originalRequire = modules.prototype.require;
        let capturedAuthority: Authority | undefined;
        // 仅隔离宿主回调重入，不模拟真实操作系统调度或选举。
        const capture = suite.mock.method(modules.prototype, 'require', function (this: object, id: string): unknown {
            const value = originalRequire.call(this, id);
            if (id.endsWith('/leaderElectionService')) {
                capturedAuthority = (value as { LeaderElectionService: Authority }).LeaderElectionService;
            }
            return value;
        });
        const { registerUsageRefreshHandlers } = await import('../../usageActivation').finally(() => {
            capture.mock.restore();
        });
        assert.ok(capturedAuthority);
        const authority = capturedAuthority;

        async function fixture(context: TestContext, phase: Phase, fail = false) {
            host.reset();
            const clock = refreshClock(context);
            const f = await host.fixture(context);
            await initializeLogger(host, context, f.fileLogger);
            const today = DateUtils.getTodayDateString();
            const history = DateUtils.getDateStringDaysAgo(1);
            for (const date of [history, today]) {
                await host.run('leader', async () => {
                    await f.fileLogger.recordEstimatedTokens({
                        requestId: `${date}_periodic-reentry`,
                        providerKey: 'test',
                        providerName: 'Test',
                        modelId: 'test',
                        modelName: 'Test',
                        estimatedInput: 10,
                        timestamp: new Date(`${date}T09:00:00`).getTime()
                    });
                    await f.fileLogger.flush();
                    assert.equal((await f.fileLogger.getDateStats(date)).total.requests, 1);
                });
            }
            await host.run('leader', () => f.fileLogger.getIndex());
            const term = { value: 'leader:1' };
            context.mock.method(authority, 'getOwnedAuthorityTerm', () => term.value);
            let now = Date.now();
            context.mock.method(Date, 'now', () => now);
            const blocked = gate();
            let entered = false;
            let faults = 0;
            const failure = Object.assign(new Error(`Injected periodic ${phase} failure`), { code: 'EIO' });
            async function checkpoint(current: Phase): Promise<void> {
                if (current !== phase || entered) {
                    return;
                }
                entered = true;
                await blocked.promise;
            }
            function rejectOnce(current: Phase): void {
                if (fail && current === phase && faults === 0) {
                    faults++;
                    throw failure;
                }
            }
            const index = (f.fileLogger as unknown as { indexManager: IndexInternals }).indexManager;
            const scans = context.mock.method(index, 'getAllStatsDates');
            const load = index.loadStats.bind(index);
            const loads = context.mock.method(index, 'loadStats', async (...args: Parameters<typeof load>) => {
                const value = await load(...args);
                await checkpoint('maintenance');
                rejectOnce('maintenance');
                return value;
            });
            const maintenance = context.mock.method(f.fileLogger, 'getIndex');
            const statsManager = f.internals.logStatsManager;
            const readToday = statsManager.getDateStats.bind(statsManager);
            context.mock.method(statsManager, 'getDateStats', async (...args: Parameters<typeof readToday>) => {
                const stats = await readToday(...args);
                await checkpoint('today');
                return stats;
            });
            const refresh = f.fileLogger.refreshStats.bind(f.fileLogger);
            const refreshes = context.mock.method(
                f.fileLogger,
                'refreshStats',
                async (...args: Parameters<typeof refresh>) => {
                    const result = await refresh(...args);
                    rejectOnce('today');
                    return result;
                }
            );
            const publication = (statsManager as unknown as { publication: StatsPublication }).publication;
            const readPending = publication.readPendingStats.bind(publication);
            context.mock.method(publication, 'readPendingStats', async (...args: Parameters<typeof readPending>) => {
                const stats = await readPending(...args);
                await checkpoint('recovery');
                return stats;
            });
            const recover = statsManager.recoverStatsPublications.bind(statsManager);
            const recoveries = context.mock.method(f.fileLogger, 'recoverStatsPublications');
            const historyRuns = context.mock.method(
                statsManager,
                'recoverStatsPublications',
                async (...args: Parameters<typeof recover>) => {
                    await recover(...args);
                    rejectOnce('recovery');
                }
            );
            const raw = context.mock.method(f.internals.readManager, 'readHourLogs');
            const snapshots = context.mock.method(f.internals.snapshotManager, 'read');
            host.run('leader', () => registerUsageRefreshHandlers(f.extensionContext));
            assert.equal(host.periodic.length, 1);
            const callback = host.periodic[0];
            assert.ok(callback);
            const pending: Work[] = [];
            function start(): Work {
                const work: Work = { promise: host.run('leader', callback), settled: false };
                pending.push(work);
                void work.promise.then(
                    () => {
                        work.settled = true;
                    },
                    () => {
                        work.settled = true;
                    }
                );
                return work;
            }
            async function finish(work: Work): Promise<void> {
                await clock.settle(() => work.settled);
                await work.promise;
                await host.run('leader', () => f.fileLogger.flush());
            }
            return {
                term,
                scans,
                loads,
                maintenance,
                refreshes,
                recoveries,
                historyRuns,
                start,
                finish,
                release: blocked.release,
                faults: () => faults,
                advance() {
                    now += 60001;
                },
                async waitUntilBlocked(work: Work) {
                    await clock.settle(() => entered || work.settled);
                    assert.equal(entered, true, `${phase} gate was not reached`);
                    assert.equal(work.settled, false, 'first callback must still be pending');
                },
                counts() {
                    return {
                        maintenance: maintenance.mock.callCount(),
                        scans: scans.mock.callCount(),
                        loads: loads.mock.callCount(),
                        today: refreshes.mock.callCount(),
                        recovery: recoveries.mock.callCount(),
                        history: historyRuns.mock.callCount()
                    };
                },
                assertPublications() {
                    for (const call of refreshes.mock.calls) {
                        assert.equal(call.arguments[0], today);
                    }
                    for (const call of recoveries.mock.calls) {
                        assert.deepEqual(call.arguments[1], [today]);
                    }
                    for (const date of [today, history]) {
                        const updates = host.events.filter(
                            item => item.event.type === 'tokenUsageUpdated' && item.event.payload.date === date
                        );
                        assert.equal(updates.length, 1, `one real publication for ${date}`);
                        const update = updates[0].event;
                        assert.equal(update.type, 'tokenUsageUpdated');
                        if (update.type === 'tokenUsageUpdated') {
                            assert.equal(update.payload.totalRequests, 1);
                        }
                    }
                    assert.equal(raw.mock.callCount(), 0);
                    assert.equal(snapshots.mock.callCount(), 0);
                },
                async drain() {
                    blocked.release();
                    try {
                        await clock.settle(() => pending.every(work => work.settled));
                    } finally {
                        await Promise.allSettled(pending.map(work => work.promise));
                        await host.run('leader', () => f.fileLogger.flush());
                    }
                }
            };
        }

        for (const phase of ['maintenance', 'today', 'recovery'] as const) {
            await suite.test(`same-term reentry resolves immediately while ${phase} is pending`, async context => {
                const f = await fixture(context, phase);
                try {
                    const first = f.start();
                    await f.waitUntilBlocked(first);
                    const before = f.counts();
                    assert.deepEqual(before, {
                        maintenance: 1,
                        scans: 1,
                        loads: phase === 'maintenance' ? 1 : 2,
                        today: phase === 'maintenance' ? 0 : 1,
                        recovery: phase === 'recovery' ? 1 : 0,
                        history: phase === 'recovery' ? 1 : 0
                    });
                    f.advance();
                    const second = f.start();
                    await nextTurn();
                    const observed = { firstSettled: first.settled, secondSettled: second.settled, ...f.counts() };
                    assert.equal(observed.firstSettled, false);
                    assert.equal(observed.scans, before.scans, 'serial index must not start a second scan');
                    assert.equal(observed.loads, before.loads, 'serial index must not start a second load');
                    assert.deepEqual(
                        observed,
                        { firstSettled: false, secondSettled: true, ...before },
                        'reentry must resolve without queueing maintenance, today refresh or recovery'
                    );
                    f.release();
                    await f.finish(first);
                    await f.finish(second);
                    assert.deepEqual(f.counts(), {
                        maintenance: 1,
                        scans: 1,
                        loads: 2,
                        today: 1,
                        recovery: 1,
                        history: 1
                    });
                    f.advance();
                    await f.finish(f.start());
                    assert.deepEqual(f.counts(), {
                        maintenance: 1,
                        scans: 1,
                        loads: 2,
                        today: 2,
                        recovery: 2,
                        history: 2
                    });
                    f.assertPublications();
                } finally {
                    await f.drain();
                }
            });
        }

        await suite.test(
            'maintenance failure still refreshes today and releases the cycle for retry',
            async context => {
                const f = await fixture(context, 'maintenance', true);
                try {
                    const first = f.start();
                    await f.waitUntilBlocked(first);
                    assert.equal(f.refreshes.mock.callCount(), 0);
                    f.release();
                    await f.finish(first);
                    assert.equal(f.faults(), 1);
                    assert.equal(f.maintenance.mock.callCount(), 1);
                    assert.equal(f.refreshes.mock.callCount(), 1);
                    assert.equal(f.recoveries.mock.callCount(), 1);
                    f.assertPublications();
                    f.advance();
                    await f.finish(f.start());
                    assert.equal(f.maintenance.mock.callCount(), 2, 'failed term must retry maintenance');
                    const scans = f.scans.mock.callCount();
                    const loads = f.loads.mock.callCount();
                    f.advance();
                    await f.finish(f.start());
                    assert.equal(f.maintenance.mock.callCount(), 2, 'successful retry must reconcile the term');
                    assert.equal(f.scans.mock.callCount(), scans);
                    assert.equal(f.loads.mock.callCount(), loads);
                    assert.equal(f.refreshes.mock.callCount(), 3);
                    assert.equal(f.recoveries.mock.callCount(), 3);
                    assert.equal(f.historyRuns.mock.callCount(), 3);
                    f.assertPublications();
                } finally {
                    await f.drain();
                }
            }
        );

        for (const phase of ['today', 'recovery'] as const) {
            await suite.test(
                `${phase} rejection releases the cycle without resetting the reconciled term`,
                async context => {
                    const f = await fixture(context, phase, true);
                    try {
                        const first = f.start();
                        await f.waitUntilBlocked(first);
                        f.release();
                        await f.finish(first);
                        assert.equal(f.faults(), 1);
                        assert.equal(f.maintenance.mock.callCount(), 1);
                        assert.equal(f.refreshes.mock.callCount(), 1);
                        assert.equal(f.recoveries.mock.callCount(), phase === 'today' ? 0 : 1);
                        for (let round = 2; round <= 3; round++) {
                            f.advance();
                            await f.finish(f.start());
                            assert.deepEqual(f.counts(), {
                                maintenance: 1,
                                scans: 1,
                                loads: 2,
                                today: round,
                                recovery: phase === 'today' ? round - 1 : round,
                                history: phase === 'today' ? round - 1 : round
                            });
                            f.assertPublications();
                        }
                    } finally {
                        await f.drain();
                    }
                }
            );
        }

        for (const nextTerm of ['leader:2', 'leader:1'] as const) {
            await suite.test(`term changes during maintenance; next ${nextTerm} must reconcile`, async context => {
                const f = await fixture(context, 'maintenance');
                try {
                    const first = f.start();
                    await f.waitUntilBlocked(first);
                    f.term.value = 'leader:2';
                    f.release();
                    await f.finish(first);
                    assert.equal(f.maintenance.mock.callCount(), 1);
                    f.term.value = nextTerm;
                    f.advance();
                    await f.finish(f.start());
                    assert.equal(
                        f.maintenance.mock.callCount(),
                        2,
                        'interrupted term must not be recorded as successful'
                    );
                    assert.equal(f.scans.mock.callCount(), 2);
                    assert.equal(f.loads.mock.callCount(), 4);
                    f.advance();
                    await f.finish(f.start());
                    assert.deepEqual(f.counts(), {
                        maintenance: 2,
                        scans: 2,
                        loads: 4,
                        today: 3,
                        recovery: 3,
                        history: 3
                    });
                    f.assertPublications();
                } finally {
                    await f.drain();
                }
            });
        }
    } finally {
        host.restore();
    }
});
