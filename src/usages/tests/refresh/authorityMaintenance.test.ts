import assert from 'node:assert/strict';
import { access, readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import type { LeaderElectionService } from '../../../status/leaderElectionService';
import type { TokenFileLogger } from '../../fileLogger';
import { DateUtils } from '../../fileLogger/dateUtils';
import type { LogIndexManager } from '../../fileLogger/logIndexManager';
import type { DateIndex, TokenUsageStatsFromFile } from '../../fileLogger/types';
import type { JsonFileSnapshot } from '../../persistence/versionedJsonFile';
import { createUsageHost, type LoggerInternals } from '../hostFixture';
import { initializeLogger } from '../recovery/fixture';
import { refreshClock, refreshFixture, type UsageHost } from './fixture';

type Fixture = Awaited<ReturnType<UsageHost['fixture']>>;
type Authority = Pick<typeof LeaderElectionService, 'getOwnedAuthorityTerm'>;
interface IndexInternals {
    needsRecovery: boolean;
    getAllStatsDates(): Promise<string[]>;
    loadStats(date: string): Promise<JsonFileSnapshot<Pick<TokenUsageStatsFromFile, 'total'>> | null>;
}
interface StatsInternals {
    getCodeVersionTimestamp(): number;
    calculateDateStats(date: string, force: boolean): Promise<TokenUsageStatsFromFile>;
}
const indexOf = (logger: TokenFileLogger) => (logger as unknown as { indexManager: LogIndexManager }).indexManager;
const stateOf = (logger: TokenFileLogger) => indexOf(logger) as unknown as IndexInternals;
const statsOf = (logger: TokenFileLogger) =>
    (logger as unknown as LoggerInternals).logStatsManager as unknown as StatsInternals;

function observe(context: TestContext, f: Fixture) {
    const scans = context.mock.method(stateOf(f.fileLogger), 'getAllStatsDates');
    const loads = context.mock.method(stateOf(f.fileLogger), 'loadStats');
    const calculations = context.mock.method(statsOf(f.fileLogger), 'calculateDateStats');
    const raw = context.mock.method(f.internals.readManager, 'readHourLogs');
    const snapshots = context.mock.method(f.internals.snapshotManager, 'read');
    return {
        scans,
        loads,
        assertNoRecalculation() {
            assert.equal(calculations.mock.callCount(), 0);
            assert.equal(raw.mock.callCount(), 0);
            assert.equal(snapshots.mock.callCount(), 0);
        }
    };
}

async function append(host: UsageHost, f: Fixture, date: string, suffix: string): Promise<void> {
    await host.run('leader', async () => {
        await f.fileLogger.recordEstimatedTokens({
            requestId: `${date}_${suffix}`,
            providerKey: 'test',
            providerName: 'Test',
            modelId: 'test',
            modelName: 'Test',
            estimatedInput: 10,
            timestamp: new Date(`${date}T09:00:00`).getTime()
        });
        await f.fileLogger.flush();
    });
}

test('periodic index maintenance follows owned authority terms', { timeout: 30000 }, async suite => {
    const host = await createUsageHost();
    try {
        const require = createRequire(import.meta.url);
        const modules = require('node:module') as { prototype: { require(id: string): unknown } };
        const originalRequire = modules.prototype.require;
        let capturedAuthority: Authority | undefined;
        // 任期与身份由隔离宿主控制，不代表真实操作系统选举。
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

        async function fixture(context: TestContext) {
            host.reset();
            const clock = refreshClock(context);
            const f = await host.fixture(context);
            await initializeLogger(host, context, f.fileLogger);
            const today = DateUtils.getTodayDateString();
            const history = DateUtils.getDateStringDaysAgo(1);
            const version = statsOf(f.fileLogger).getCodeVersionTimestamp();
            assert.ok(version > 1);
            for (const date of [history, today]) {
                await append(host, f, date, 'first');
                const stats = await host.run('leader', () => f.fileLogger.getDateStats(date));
                assert.equal(stats.total.requests, 1);
                assert.equal(stats.versionTimestamp, version);
                await host.run('leader', () => f.internals.logStatsManager.markStatsPublished(date, stats));
            }
            await host.run('leader', () => f.fileLogger.getIndex());
            const indexPath = indexOf(f.fileLogger).getIndexPath();
            const indexBody = await readFile(indexPath, 'utf8');
            const before = JSON.parse(indexBody) as DateIndex;
            assert.equal(before.versionTimestamp, version);
            assert.deepEqual(Object.keys(before.dates).sort(), [history, today].sort());
            for (const date of [history, today]) {
                assert.equal(before.dates[date]?.total_requests, 1);
            }
            const statsPath = join(f.dir, 'usages', history, 'stats.json');
            const todayPath = join(f.dir, 'usages', today, 'stats.json');
            const todayBody = await readFile(todayPath, 'utf8');
            return {
                ...f,
                clock,
                today,
                history,
                version,
                indexPath,
                indexBody,
                before,
                statsPath,
                todayPath,
                todayBody
            };
        }

        function register(f: Fixture, id: string, clock: ReturnType<typeof refreshClock>) {
            host.run(id, () => registerUsageRefreshHandlers(f.extensionContext));
            assert.equal(host.periodic.length, 1);
            const callback = host.periodic[0];
            assert.ok(callback);
            return async () => {
                let done = false;
                const pending = host.run(id, callback);
                void pending.then(
                    () => {
                        done = true;
                    },
                    () => {
                        done = true;
                    }
                );
                await clock.settle(() => done);
                await pending;
                await host.run(id, () => f.fileLogger.flush());
            };
        }

        for (const interrupted of [true, false]) {
            await suite.test(
                interrupted ?
                    'a warmed follower repairs the missed historical index commit'
                :   'completed index handoff control',
                async context => {
                    const owner = await fixture(context);
                    const follower = await refreshFixture(host, context, 'follower', owner.extensionContext);
                    await initializeLogger(host, context, follower.fileLogger, 'follower');
                    assert.equal(statsOf(follower.fileLogger).getCodeVersionTimestamp(), owner.version);
                    assert.deepEqual(
                        await host.run('follower', () => follower.fileLogger.getIndexFast()),
                        owner.before.dates
                    );
                    assert.equal(stateOf(follower.fileLogger).needsRecovery, false);
                    const observed = observe(context, follower);
                    const maintenance = context.mock.method(follower.fileLogger, 'getIndex');
                    await append(host, owner, owner.history, 'second');
                    const index = indexOf(owner.fileLogger);
                    const update = index.updateIndex.bind(index);
                    const handoff = context.mock.method(
                        index,
                        'updateIndex',
                        async (...args: Parameters<typeof update>) => {
                            assert.equal(args[0], owner.history);
                            assert.equal(args[1], undefined);
                            assert.ok(args[2]);
                            assert.equal(args[2](), true);
                            const saved = JSON.parse(
                                await readFile(owner.statsPath, 'utf8')
                            ) as TokenUsageStatsFromFile;
                            assert.equal(saved.total.requests, 2);
                            await assert.rejects(access(`${owner.statsPath}.commit.lock`), { code: 'ENOENT' });
                            if (interrupted) {
                                host.state.leaderId = 'follower';
                            }
                            const result = await update(...args);
                            if (interrupted) {
                                assert.equal(result, undefined);
                                assert.equal(args[2](), false);
                            } else {
                                assert.equal(result?.total.requests, 2);
                                host.state.leaderId = 'follower';
                            }
                            return result;
                        }
                    );
                    try {
                        const saved = await host.run('leader', () => owner.fileLogger.getDateStats(owner.history));
                        assert.equal(saved.total.requests, 2);
                        assert.equal(handoff.mock.callCount(), 1);
                    } finally {
                        handoff.mock.restore();
                    }
                    const statsBody = await readFile(owner.statsPath, 'utf8');
                    if (interrupted) {
                        assert.equal(await readFile(owner.indexPath, 'utf8'), owner.indexBody);
                    }
                    assert.equal(
                        (await host.run('follower', () => follower.fileLogger.getDateStats(owner.history))).total
                            .requests,
                        2
                    );
                    const fast = await host.run('follower', () => follower.fileLogger.getIndexFast());
                    assert.equal(fast[owner.history]?.total_requests, interrupted ? 1 : 2);
                    assert.equal(stateOf(follower.fileLogger).needsRecovery, false);
                    assert.equal(observed.scans.mock.callCount(), 0);
                    assert.equal(observed.loads.mock.callCount(), 0);
                    observed.assertNoRecalculation();
                    const tick = register(follower, 'follower', owner.clock);
                    await tick();
                    await assertBodies();
                    observed.assertNoRecalculation();
                    await assertIndex();
                    if (interrupted) {
                        assert.equal(maintenance.mock.callCount(), 1);
                        assert.equal(observed.scans.mock.callCount(), 1);
                        assert.deepEqual(
                            observed.loads.mock.calls.map(call => call.arguments[0]).sort(),
                            [owner.history, owner.today].sort()
                        );
                    }
                    const counts = [
                        maintenance.mock.callCount(),
                        observed.scans.mock.callCount(),
                        observed.loads.mock.callCount()
                    ];
                    for (let round = 0; round < 3; round++) {
                        await tick();
                        await assertIndex();
                        await assertBodies();
                        observed.assertNoRecalculation();
                        assert.deepEqual(
                            [
                                maintenance.mock.callCount(),
                                observed.scans.mock.callCount(),
                                observed.loads.mock.callCount()
                            ],
                            counts
                        );
                    }
                    async function assertBodies() {
                        assert.equal(await readFile(owner.statsPath, 'utf8'), statsBody);
                        assert.equal(await readFile(owner.todayPath, 'utf8'), owner.todayBody);
                    }
                    async function assertIndex() {
                        const disk = JSON.parse(await readFile(owner.indexPath, 'utf8')) as DateIndex;
                        assert.deepEqual(Object.keys(disk.dates).sort(), [owner.history, owner.today].sort());
                        assert.equal(disk.dates[owner.history]?.total_requests, 2);
                        assert.deepEqual(disk.dates[owner.today], owner.before.dates[owner.today]);
                        assert.equal(disk.versionTimestamp, owner.version);
                        assert.deepEqual(
                            await host.run('follower', () => follower.fileLogger.getIndexFast()),
                            disk.dates
                        );
                    }
                }
            );
        }

        await suite.test(
            'first-per-term maintenance precedes today and never becomes an hourly scan',
            async context => {
                const f = await fixture(context);
                const observed = observe(context, f);
                const order: string[] = [];
                const getIndex = f.fileLogger.getIndex.bind(f.fileLogger);
                const maintenance = context.mock.method(f.fileLogger, 'getIndex', () => {
                    order.push('maintenance');
                    return getIndex();
                });
                const refresh = f.fileLogger.refreshStats.bind(f.fileLogger);
                context.mock.method(f.fileLogger, 'refreshStats', (...args: Parameters<typeof refresh>) => {
                    assert.equal(args[0], f.today);
                    order.push('today');
                    return refresh(...args);
                });
                const intervals = context.mock.method(globalThis, 'setInterval');
                let now = Date.now();
                context.mock.method(Date, 'now', () => now);
                const tick = register(f, 'leader', f.clock);
                await tick();
                assert.deepEqual(order, ['maintenance', 'today']);
                assert.equal(maintenance.mock.callCount(), 1);
                assert.equal(observed.scans.mock.callCount(), 1);
                assert.equal(observed.loads.mock.callCount(), 2);
                for (const hours of [0, 1, 3, 6]) {
                    now += hours * 60 * 60 * 1000;
                    await tick();
                }
                assert.deepEqual(order, ['maintenance', 'today', 'today', 'today', 'today', 'today']);
                assert.equal(maintenance.mock.callCount(), 1);
                assert.equal(observed.scans.mock.callCount(), 1);
                assert.equal(observed.loads.mock.callCount(), 2);
                assert.equal(intervals.mock.callCount(), 0);
                observed.assertNoRecalculation();
            }
        );

        await suite.test('a new owned term on the same instance gets one new maintenance', async context => {
            const f = await fixture(context);
            const observed = observe(context, f);
            let term = 'leader:1';
            context.mock.method(authority, 'getOwnedAuthorityTerm', () => term);
            const maintenance = context.mock.method(f.fileLogger, 'getIndex');
            const tick = register(f, 'leader', f.clock);
            await tick();
            assert.equal(maintenance.mock.callCount(), 1);
            term = 'leader:2';
            await tick();
            assert.equal(maintenance.mock.callCount(), 2);
            await tick();
            assert.equal(maintenance.mock.callCount(), 2);
            assert.equal(observed.scans.mock.callCount(), 2);
            assert.equal(observed.loads.mock.callCount(), 4);
            observed.assertNoRecalculation();
        });

        for (const role of ['follower', 'no leader', 'leader without owned term'] as const) {
            await suite.test(`no owned term skips maintenance/${role}`, async context => {
                const f = await fixture(context);
                host.state.leaderId =
                    role === 'follower' ? 'other'
                    : role === 'no leader' ? undefined
                    : 'leader';
                context.mock.method(authority, 'getOwnedAuthorityTerm', () => undefined);
                const observed = observe(context, f);
                const maintenance = context.mock.method(f.fileLogger, 'getIndex');
                const today = context.mock.method(f.fileLogger, 'refreshStats', async () => undefined);
                const tick = register(f, 'leader', f.clock);
                for (let round = 0; round < 3; round++) {
                    await tick();
                }
                assert.equal(maintenance.mock.callCount(), 0);
                assert.equal(observed.scans.mock.callCount(), 0);
                assert.equal(observed.loads.mock.callCount(), 0);
                assert.deepEqual(
                    today.mock.calls.map(call => call.arguments[0]),
                    [f.today, f.today, f.today]
                );
                observed.assertNoRecalculation();
            });
        }

        await suite.test('failed maintenance preserves today refresh/push and retries next cycle', async context => {
            const f = await fixture(context);
            await append(host, f, f.today, 'second');
            const failure = Object.assign(new Error('Injected authority maintenance failure'), { code: 'EIO' });
            const getIndex = f.fileLogger.getIndex.bind(f.fileLogger);
            let attempts = 0;
            const order: string[] = [];
            context.mock.method(f.fileLogger, 'getIndex', async () => {
                order.push('maintenance');
                if (++attempts === 1) {
                    throw failure;
                }
                return getIndex();
            });
            const refresh = f.fileLogger.refreshStats.bind(f.fileLogger);
            context.mock.method(f.fileLogger, 'refreshStats', (...args: Parameters<typeof refresh>) => {
                order.push('today');
                return refresh(...args);
            });
            const tick = register(f, 'leader', f.clock);
            const updates = () =>
                host.events.filter(
                    item => item.event.type === 'tokenUsageUpdated' && item.event.payload.date === f.today
                );
            await tick();
            assert.equal(
                (JSON.parse(await readFile(f.todayPath, 'utf8')) as TokenUsageStatsFromFile).total.requests,
                2
            );
            assert.equal(updates().length, 1);
            const update = updates()[0].event;
            assert.equal(update.type, 'tokenUsageUpdated');
            if (update.type === 'tokenUsageUpdated') {
                assert.equal(update.payload.totalRequests, 2);
            }
            assert.equal(attempts, 1);
            assert.deepEqual(order, ['maintenance', 'today']);
            await tick();
            assert.equal(attempts, 2);
            await tick();
            assert.equal(attempts, 2);
            assert.deepEqual(order, ['maintenance', 'today', 'maintenance', 'today', 'today']);
            assert.equal(updates().length, 1);
        });

        await suite.test('ownership lost during maintenance does not mark the old term successful', async context => {
            const f = await fixture(context);
            const observed = observe(context, f);
            const getIndex = f.fileLogger.getIndex.bind(f.fileLogger);
            let attempts = 0;
            context.mock.method(f.fileLogger, 'getIndex', async () => {
                attempts++;
                const entries = await getIndex();
                if (attempts === 1) {
                    host.state.leaderId = 'successor';
                }
                return entries;
            });
            const refresh = f.fileLogger.refreshStats.bind(f.fileLogger);
            context.mock.method(f.fileLogger, 'refreshStats', (...args: Parameters<typeof refresh>) =>
                host.state.leaderId === 'leader' ? refresh(...args) : Promise.resolve(undefined)
            );
            const tick = register(f, 'leader', f.clock);
            await tick();
            assert.equal(attempts, 1);
            assert.equal(host.state.leaderId, 'successor');
            await tick();
            assert.equal(attempts, 1);
            host.state.leaderId = 'leader';
            await tick();
            assert.equal(attempts, 2);
            await tick();
            assert.equal(attempts, 2);
            assert.equal(observed.scans.mock.callCount(), 2);
            assert.equal(observed.loads.mock.callCount(), 4);
            observed.assertNoRecalculation();
        });
    } finally {
        host.restore();
    }
});
