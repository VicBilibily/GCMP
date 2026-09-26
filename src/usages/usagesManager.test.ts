import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';

import { DateUtils } from './fileLogger/dateUtils';
import type { TokenRequestLog } from './fileLogger/types';

const require = createRequire(import.meta.url);
const NodeModule = require('node:module') as {
    prototype: { require: (id: string) => unknown };
};

function createLog(requestId: string, date: string, sessionId: string, sessionTitle?: string): TokenRequestLog {
    const timestamp = new Date(`${date}T00:00:00`).getTime();
    return {
        requestId,
        timestamp,
        isoTime: new Date(timestamp).toISOString(),
        providerKey: 'test',
        providerName: 'Test',
        modelId: 'test',
        modelName: 'Test',
        estimatedInput: 1,
        rawUsage: null,
        status: 'completed',
        sessionId,
        sessionTitle
    };
}

test('optional historical title hydration preserves readable usage records', async t => {
    const originalRequire = NodeModule.prototype.require;
    NodeModule.prototype.require = function (id: string): unknown {
        if (id === 'vscode') {
            return { window: {}, env: { language: 'zh-cn' } };
        }
        if (id.endsWith('/leaderElectionService')) {
            return {
                LeaderElectionService: {
                    getLeaderId: () => 'self',
                    getInstanceId: () => 'self',
                    isLeader: () => false
                }
            };
        }
        if (id.endsWith('/interInstance')) {
            return {
                InterInstanceBus: {
                    subscribe: () => ({ dispose() {} }),
                    hasCompatibleUsagesQueryTransport: () => false
                }
            };
        }
        if (id.endsWith('/liveMetrics')) {
            return { onLiveMetrics: () => ({ dispose() {} }) };
        }
        return originalRequire.call(this, id);
    };

    try {
        const { TokenUsagesManager } = await import('./usagesManager');
        const { TokenFileLogger } = await import('./fileLogger');
        const { SessionTitleService } = await import('./sessionTitleService');
        const today = DateUtils.getTodayDateString();
        const yesterday = DateUtils.getDateStringDaysAgo(1);
        const olderDate = DateUtils.getDateStringDaysAgo(2);

        async function createFixture(context: TestContext, logsByDate: Record<string, TokenRequestLog[]>) {
            const dir = await mkdtemp(join(tmpdir(), 'gcmp-historical-titles-'));
            const logger = new TokenFileLogger({ globalStorageUri: { fsPath: dir } } as never);
            context.after(async () => {
                await logger.dispose();
                await rm(dir, { recursive: true, force: true });
            });
            const { readManager, snapshotManager } = logger as unknown as {
                readManager: import('./fileLogger/logReadManager').LogReadManager;
                snapshotManager: import('./fileLogger/snapshotManager').SnapshotManager;
            };
            snapshotManager.buildSnapshotFromLogs = async () => {};
            for (const [date, logs] of Object.entries(logsByDate)) {
                const folder = join(dir, 'usages', date);
                await mkdir(folder, { recursive: true });
                await writeFile(join(folder, '00.jsonl'), logs.map(log => JSON.stringify(log)).join('\n') + '\n');
            }
            logger.getIndexFast = async () =>
                Object.fromEntries(
                    Object.entries(logsByDate).map(([date, logs]) => [
                        date,
                        {
                            total_input: logs.length,
                            total_cache: 0,
                            total_output: 0,
                            total_requests: logs.length,
                            total_cost: 0
                        }
                    ])
                );
            const detailsReads: string[] = [];
            const getRequestDetails = logger.getRequestDetails.bind(logger);
            logger.getRequestDetails = async date => {
                detailsReads.push(date);
                return getRequestDetails(date);
            };
            const titleCache = new Map<string, { title: string | null; checkedAt: number }>();
            const manager = Object.create(TokenUsagesManager.prototype) as typeof TokenUsagesManager.instance;
            Object.assign(manager, {
                fileLogger: logger,
                historicalSessionTitleCache: titleCache
            });
            return { manager, logger, readManager, detailsReads, titleCache };
        }

        for (const method of ['getDateRecords', 'getRecentRecords'] as const) {
            await t.test(`${method} retries failed history without hiding current records`, async context => {
                const sessionId = `historical-retry-${method}`;
                const { manager, readManager, titleCache, detailsReads } = await createFixture(context, {
                    [today]: [createLog('current-request', today, sessionId)],
                    [yesterday]: [createLog('historical-request', yesterday, sessionId, '恢复的会话标题')]
                });
                const readHourLogs = readManager.readHourLogs.bind(readManager);
                let failHistory = true;
                readManager.readHourLogs = async (...args) => {
                    if (args[0] === yesterday && failHistory) {
                        throw Object.assign(new Error('Historical file is busy'), { code: 'EBUSY' });
                    }
                    return readHourLogs(...args);
                };
                const getRecords = () =>
                    method === 'getDateRecords' ? manager.getDateRecords(today) : manager.getRecentRecords();
                const records = await getRecords();
                assert.equal(records.length, 1);
                assert.equal(records[0].requestId, 'current-request');
                assert.equal(records[0].sessionTitle, undefined);
                assert.equal(titleCache.has(sessionId), false);
                assert.equal(detailsReads.filter(date => date === yesterday).length, 1);
                await assert.rejects(manager.getDateRecords(yesterday), /Historical file is busy/);

                failHistory = false;
                const recovered = await getRecords();
                assert.equal(recovered.length, 1);
                assert.equal(recovered[0].sessionTitle, '恢复的会话标题');
                assert.equal(titleCache.get(sessionId)?.title, '恢复的会话标题');
                assert.equal(detailsReads.filter(date => date === yesterday).length, 3);

                failHistory = true;
                assert.equal((await getRecords())[0].sessionTitle, '恢复的会话标题');
                assert.equal(detailsReads.filter(date => date === yesterday).length, 3);
            });
        }

        await t.test('a failed history date does not prevent finding titles in older readable dates', async context => {
            const resolvedSessionId = 'older-readable-title';
            const unresolvedSessionId = 'incomplete-history-title';
            const { manager, readManager, titleCache, detailsReads } = await createFixture(context, {
                [today]: [
                    createLog('resolved-current', today, resolvedSessionId),
                    createLog('unresolved-current', today, unresolvedSessionId)
                ],
                [yesterday]: [createLog('unrelated-history', yesterday, 'unrelated-history')],
                [olderDate]: [createLog('older-request', olderDate, resolvedSessionId, '更早日期的标题')]
            });
            const readHourLogs = readManager.readHourLogs.bind(readManager);
            readManager.readHourLogs = async (...args) => {
                if (args[0] === yesterday) {
                    throw new Error('Unreadable history date');
                }
                return readHourLogs(...args);
            };
            const records = await manager.getDateRecords(today);
            assert.equal(records.length, 2);
            assert.equal(
                records.find(record => record.sessionId === resolvedSessionId)?.sessionTitle,
                '更早日期的标题'
            );
            assert.equal(titleCache.get(resolvedSessionId)?.title, '更早日期的标题');
            assert.equal(titleCache.has(unresolvedSessionId), false);
            assert.ok(detailsReads.includes(olderDate));
            assert.equal((await manager.getRecentRecords()).length, 2);
            assert.equal(detailsReads.filter(date => date === yesterday).length, 2);
        });

        for (const method of ['getDateRecords', 'getRecentRecords'] as const) {
            for (const indexState of ['missing', 'incomplete', 'unreadable'] as const) {
                await t.test(`${method} finds historical titles with an ${indexState} index`, async context => {
                    const sessionId = `${method}-${indexState}-index`;
                    const { manager, logger, titleCache } = await createFixture(context, {
                        [today]: [createLog('current', today, sessionId)],
                        [yesterday]: [createLog('history', yesterday, sessionId, '不依赖索引的标题')]
                    });
                    const completeIndex = await logger.getIndexFast();
                    let indexReads = 0;
                    logger.getIndexFast = async () => {
                        indexReads++;
                        if (indexState === 'unreadable') {
                            throw new Error('Index is unavailable');
                        }
                        return indexState === 'incomplete' ? { [today]: completeIndex[today] } : {};
                    };
                    const records =
                        method === 'getDateRecords' ?
                            await manager.getDateRecords(today)
                        :   await manager.getRecentRecords();
                    assert.equal(records.length, 1);
                    assert.equal(records[0].sessionTitle, '不依赖索引的标题');
                    assert.equal(titleCache.get(sessionId)?.title, '不依赖索引的标题');
                    assert.equal(indexReads, 0);
                });
            }
        }

        await t.test('title lookup includes the seventh prior day but excludes older dates', async context => {
            const sessionId = 'lookback-boundary';
            const lastDate = DateUtils.getDateStringDaysAgo(7);
            const excludedDate = DateUtils.getDateStringDaysAgo(8);
            const { manager, detailsReads } = await createFixture(context, {
                [today]: [createLog('today-boundary', today, sessionId)],
                [lastDate]: [createLog('included-boundary', lastDate, sessionId, '七天前的标题')],
                [excludedDate]: [createLog('excluded-boundary', excludedDate, sessionId, '不应读取的标题')]
            });
            assert.equal((await manager.getDateRecords(today))[0].sessionTitle, '七天前的标题');
            assert.ok(detailsReads.includes(lastDate));
            assert.equal(detailsReads.includes(excludedDate), false);
        });

        await t.test('a complete history scan still caches genuine title misses', async context => {
            const sessionId = 'complete-history-miss';
            const { manager, detailsReads, titleCache } = await createFixture(context, {
                [today]: [createLog('untitled-current', today, sessionId)],
                [yesterday]: [createLog('untitled-history', yesterday, sessionId)]
            });
            assert.equal((await manager.getDateRecords(today)).length, 1);
            assert.equal(titleCache.get(sessionId)?.title, null);
            assert.equal(detailsReads.filter(date => date === yesterday).length, 1);
            assert.equal((await manager.getDateRecords(today)).length, 1);
            assert.equal((await manager.getRecentRecords()).length, 1);
            assert.equal(detailsReads.filter(date => date === yesterday).length, 1);
        });

        await t.test('date overview does not wait for optional historical title hydration', async context => {
            const sessionId = 'background-overview-title';
            const { manager, logger } = await createFixture(context, {
                [today]: [createLog('background-current', today, sessionId)],
                [yesterday]: [createLog('background-history', yesterday, sessionId, '后台恢复标题')]
            });
            const getRequestDetails = logger.getRequestDetails.bind(logger);
            let todayReads = 0;
            let signalHydrationStarted!: () => void;
            let releaseHydration!: () => void;
            const hydrationStarted = new Promise<void>(resolve => {
                signalHydrationStarted = resolve;
            });
            const hydrationBlocked = new Promise<void>(resolve => {
                releaseHydration = resolve;
            });
            context.after(() => releaseHydration());
            logger.getRequestDetails = async date => {
                if (date === today && ++todayReads === 2) {
                    signalHydrationStarted();
                    await hydrationBlocked;
                }
                return getRequestDetails(date);
            };

            const overview = manager.getDateOverview(today);
            await hydrationStarted;
            assert.equal(
                await Promise.race([
                    overview.then(() => true),
                    new Promise<boolean>(resolve => setImmediate(() => resolve(false)))
                ]),
                true
            );
            assert.equal((await overview).allSummary.requestCount, 1);

            releaseHydration();
            await (
                manager as unknown as {
                    backgroundSessionTitleHydration: Promise<void> | undefined;
                }
            ).backgroundSessionTitleHydration;
            assert.equal(SessionTitleService.instance.getTitle(sessionId), '后台恢复标题');
        });

        await t.test('date overview builds the official first page from the same complete read', async () => {
            const date = '2026-09-20';
            const completed = createLog('overview-completed', date, 'overview-session');
            const pendingTimestamp = completed.timestamp + 1000;
            const pending: TokenRequestLog = {
                ...createLog('overview-pending', date, 'overview-session'),
                timestamp: pendingTimestamp,
                isoTime: new Date(pendingTimestamp).toISOString(),
                status: 'estimated',
                rawUsage: null
            };
            let fullReads = 0;
            const manager = Object.create(TokenUsagesManager.prototype) as typeof TokenUsagesManager.instance;
            Object.assign(manager, {
                fileLogger: {
                    getRequestDetails: async () => {
                        fullReads++;
                        return [completed];
                    },
                    getPendingLogs: () => [pending]
                },
                historicalSessionTitleCache: new Map(),
                backgroundSessionTitleIds: new Set(),
                scheduleSessionTitleHydration() {}
            });

            const overview = await manager.getDateOverview(date);
            assert.equal(fullReads, 1);
            assert.deepEqual(
                overview.initialRecordsPage?.records.map(record => record.requestId),
                ['overview-pending', 'overview-completed']
            );
            assert.equal(overview.initialRecordsPage?.totalItems, 2);
            assert.equal(overview.initialRecordsPage?.summary, overview.allSummary);
            assert.equal(overview.initialRecordsPage?.totals, overview.allTotals);
        });

        await t.test('remote title hydration seeds the current process title cache', async () => {
            const sessionId = 'remote-hydrated-title';
            const titleCache = new Map<string, { title: string | null; checkedAt: number }>();
            SessionTitleService.instance.registerSession(sessionId, '恢复历史会话标题');
            const manager = Object.create(TokenUsagesManager.prototype) as typeof TokenUsagesManager.instance;
            Object.assign(manager, {
                historicalSessionTitleCache: titleCache,
                usagesQueryCoordinator: {
                    run: async () => '远端恢复标题'
                }
            });

            assert.equal(await manager.hydrateSessionTitle(sessionId), '远端恢复标题');
            assert.equal(SessionTitleService.instance.getTitle(sessionId), '远端恢复标题');
            assert.equal(titleCache.get(sessionId)?.title, '远端恢复标题');
        });

        await t.test('remote overview seeds returned titles in the follower process', async () => {
            const sessionId = 'remote-overview-title';
            const manager = Object.create(TokenUsagesManager.prototype) as typeof TokenUsagesManager.instance;
            Object.assign(manager, {
                initialized: true,
                historicalSessionTitleCache: new Map(),
                backgroundSessionTitleIds: new Set(),
                usagesQueryCoordinator: {
                    run: async () => ({
                        allSummary: {},
                        allTotals: {},
                        nativeSplitIndex: {},
                        sessionGroups: [
                            {
                                sessionId,
                                displayId: sessionId,
                                title: 'Follower 会话标题',
                                summary: {},
                                totals: {},
                                recordCount: 1
                            }
                        ]
                    })
                }
            });

            await manager.getDateOverview(today);
            assert.equal(SessionTitleService.instance.getTitle(sessionId), 'Follower 会话标题');
        });

        await t.test('known local title bypasses remote hydration', async () => {
            const sessionId = 'known-local-title';
            let remoteCalls = 0;
            SessionTitleService.instance.rememberResolvedTitle(sessionId, '本地正式标题');
            const manager = Object.create(TokenUsagesManager.prototype) as typeof TokenUsagesManager.instance;
            Object.assign(manager, {
                historicalSessionTitleCache: new Map(),
                usagesQueryCoordinator: {
                    run: async () => {
                        remoteCalls += 1;
                        return '远端过期标题';
                    }
                }
            });

            assert.equal(await manager.hydrateSessionTitle(sessionId), '本地正式标题');
            assert.equal(remoteCalls, 0);
            assert.equal(SessionTitleService.instance.getTitle(sessionId), '本地正式标题');
        });

        await t.test('known historical title bypasses remote hydration', async () => {
            const sessionId = 'known-historical-title';
            let remoteCalls = 0;
            const manager = Object.create(TokenUsagesManager.prototype) as typeof TokenUsagesManager.instance;
            Object.assign(manager, {
                historicalSessionTitleCache: new Map([[sessionId, { title: '历史正式标题', checkedAt: Date.now() }]]),
                usagesQueryCoordinator: {
                    run: async () => {
                        remoteCalls += 1;
                        return '远端过期标题';
                    }
                }
            });

            assert.equal(await manager.hydrateSessionTitle(sessionId), '历史正式标题');
            assert.equal(remoteCalls, 0);
            assert.equal(SessionTitleService.instance.getTitle(sessionId), '历史正式标题');
        });

        await t.test('local title resolved during remote hydration wins over the remote result', async () => {
            const sessionId = 'concurrent-local-title';
            let resolveRemote!: (title: string) => void;
            const manager = Object.create(TokenUsagesManager.prototype) as typeof TokenUsagesManager.instance;
            Object.assign(manager, {
                historicalSessionTitleCache: new Map(),
                usagesQueryCoordinator: {
                    run: () =>
                        new Promise<string>(resolve => {
                            resolveRemote = resolve;
                        })
                }
            });

            const hydration = manager.hydrateSessionTitle(sessionId);
            SessionTitleService.instance.rememberResolvedTitle(sessionId, '并发生成标题');
            resolveRemote('远端过期标题');

            assert.equal(await hydration, '并发生成标题');
            assert.equal(SessionTitleService.instance.getTitle(sessionId), '并发生成标题');
        });
    } finally {
        NodeModule.prototype.require = originalRequire;
    }
});
