import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import type { InterInstanceEvent, UsagesQueryCompletedEvent, UsagesQueryRequestedEvent } from '../../interInstance';
import type { LiveStreamMetricEvent } from '../../handlers/liveMetrics';
import { DateUtils } from '../fileLogger/dateUtils';
import type { TokenRequestLog } from '../fileLogger/types';
import type { TokenUsagesManager } from '../usagesManager';
import type { SessionTitleService } from '../sessionTitleService';
import type { LogReadManager } from '../fileLogger/logReadManager';

const require = createRequire(import.meta.url);
const NodeModule = require('node:module') as {
    prototype: { require: (id: string) => unknown };
};

test('remote usages queries preserve caller pending state without retaining full-day records', async t => {
    const originalRequire = NodeModule.prototype.require;
    type Instance = 'leader' | 'follower';
    let currentInstance: Instance = 'follower';
    const subscriptions = new Map<Instance, Map<string, (event: InterInstanceEvent) => void>>();
    const liveListeners = new Set<(event: LiveStreamMetricEvent) => void>();
    const requests: UsagesQueryRequestedEvent[] = [];
    const responses: UsagesQueryCompletedEvent[] = [];
    let beforeRemoteQuery: (() => Promise<void>) | undefined;
    let dispatchToLeader: (event: UsagesQueryRequestedEvent) => Promise<void>;
    let transportFailure = false;
    let remoteExecutions = 0;

    const bus = {
        subscribe(type: string, handler: (event: InterInstanceEvent) => void) {
            const handlers =
                subscriptions.get(currentInstance) ?? new Map<string, (event: InterInstanceEvent) => void>();
            subscriptions.set(currentInstance, handlers);
            handlers.set(type, handler);
            return { dispose: () => handlers.delete(type) };
        },
        onAuthorityChanged: () => ({ dispose() {} }),
        hasCompatibleUsagesQueryTransport: () => true,
        getAuthorityTerm: () => 'leader:1',
        publishIpcOnly(event: Omit<UsagesQueryRequestedEvent, 'timestamp' | 'senderInstanceId'>) {
            if (transportFailure) {
                return false;
            }
            const request = JSON.parse(
                JSON.stringify({ ...event, timestamp: Date.now(), senderInstanceId: 'follower' })
            ) as UsagesQueryRequestedEvent;
            requests.push(request);
            void dispatchToLeader(request);
            return true;
        },
        publishToInstance(target: string, event: Omit<UsagesQueryCompletedEvent, 'timestamp' | 'senderInstanceId'>) {
            assert.equal(target, 'follower');
            responses.push(
                JSON.parse(
                    JSON.stringify({ ...event, timestamp: Date.now(), senderInstanceId: 'leader' })
                ) as UsagesQueryCompletedEvent
            );
            return 'sent' as const;
        }
    };
    NodeModule.prototype.require = function (id: string): unknown {
        if (id === 'vscode') {
            return { window: {}, env: { language: 'zh-cn' } };
        }
        if (id.endsWith('/interInstance')) {
            return { InterInstanceBus: bus };
        }
        if (id.endsWith('/leaderElectionService')) {
            return {
                LeaderElectionService: {
                    isLeader: () => currentInstance === 'leader',
                    getInstanceId: () => currentInstance,
                    getLeaderId: () => 'leader',
                    onLeaderChanged: () => ({ dispose() {} }),
                    registerPeriodicTask() {}
                }
            };
        }
        if (id.endsWith('/liveMetrics')) {
            return {
                onLiveMetrics(listener: (event: LiveStreamMetricEvent) => void) {
                    liveListeners.add(listener);
                    return { dispose: () => liveListeners.delete(listener) };
                }
            };
        }
        if (id.endsWith('/statusLogger')) {
            return { StatusLogger: { trace() {}, debug() {}, info() {}, warn() {}, error() {} } };
        }
        return originalRequire.call(this, id);
    };

    try {
        const managerModule = await import('../usagesManager');
        const titleModule = await import('../sessionTitleService');
        const Manager = managerModule.TokenUsagesManager as unknown as new () => TokenUsagesManager;
        const Titles = titleModule.SessionTitleService as unknown as new () => SessionTitleService;
        const titleHost = titleModule.SessionTitleService as unknown as { instance: SessionTitleService };
        const originalTitles = titleHost.instance;
        t.after(() => {
            titleHost.instance = originalTitles;
        });
        const today = DateUtils.getTodayDateString();
        const sessionA = '011167a7-47e1-4e78-82b2-32285c6dbf92';
        const sessionB = 'd9117794-1667-4856-bbf9-09209fd9d3cb';

        async function fixture(context: TestContext) {
            requests.length = 0;
            responses.length = 0;
            beforeRemoteQuery = undefined;
            transportFailure = false;
            remoteExecutions = 0;
            const dir = await mkdtemp(join(tmpdir(), 'gcmp-pending-query-'));
            const extensionContext = { globalStorageUri: { fsPath: dir } };
            const leaderTitles = new Titles();
            const followerTitles = new Titles();
            const leader = new Manager();
            const follower = new Manager();
            context.after(async () => {
                await follower.dispose();
                await leader.dispose();
                await rm(dir, { recursive: true, force: true });
            });
            currentInstance = 'leader';
            titleHost.instance = leaderTitles;
            await leader.initialize(extensionContext as never);
            currentInstance = 'follower';
            titleHost.instance = followerTitles;
            await follower.initialize(extensionContext as never);
            const coordinator = (
                leader as unknown as {
                    usagesQueryCoordinator: { handleRequested: (event: UsagesQueryRequestedEvent) => Promise<void> };
                }
            ).usagesQueryCoordinator;
            dispatchToLeader = async event => {
                await beforeRemoteQuery?.();
                currentInstance = 'leader';
                titleHost.instance = leaderTitles;
                try {
                    remoteExecutions += 1;
                    await coordinator.handleRequested(event);
                } finally {
                    currentInstance = 'follower';
                    titleHost.instance = followerTitles;
                }
                const response = responses.find(value => value.payload.requestId === event.payload.requestId);
                assert.ok(response);
                subscriptions.get('follower')?.get('usagesQueryCompleted')?.(response);
            };
            const logger = follower.getFileLogger();
            async function addPending(sessionId: string | undefined, timestamp = Date.now() - 1000) {
                const requestId = `${timestamp}_${Math.random().toString(36).slice(2)}`;
                await logger.recordEstimatedTokens({
                    requestId,
                    providerKey: 'test',
                    providerName: 'Test',
                    modelId: 'test',
                    modelName: 'Test',
                    estimatedInput: 10,
                    timestamp,
                    sessionId,
                    requestKind: 'main-agent',
                    otelTraceContext: { traceId: '1234567890abcdef1234567890abcdef', spanId: '1234567890abcdef' }
                });
                for (const listener of liveListeners) {
                    listener({
                        type: 'streamingUpdate',
                        requestId,
                        requestStartTime: timestamp,
                        providerName: 'Test',
                        modelName: 'Test',
                        streamStartTime: timestamp + 250,
                        estimatedOutputTokens: 25,
                        tokensPerSecond: 12.5
                    });
                }
                return { requestId, timestamp };
            }
            return { leader, follower, logger, addPending, leaderTitles, followerTitles };
        }

        for (const kind of ['recentRecords', 'dateOverview', 'recordsPage', 'trackRecords'] as const) {
            await t.test(`${kind} merges caller metrics and title before aggregation and paging`, async context => {
                const { follower, logger, addPending, leaderTitles } = await fixture(context);
                const first = await addPending(undefined, Date.now() - 2000);
                const second = await addPending(sessionB, Date.now() - 1000);
                await follower.backfillResolvedSessionTitle(sessionA, '本窗正式标题', first.requestId);
                leaderTitles.rememberResolvedTitle(sessionA, 'Leader 旧标题', Date.now() + 1000);
                const before = await logger.readDateLogs(today);

                switch (kind) {
                    case 'recentRecords': {
                        const records = await follower.getRecentRecords(2);
                        assert.deepEqual(
                            records.map(record => record.requestId),
                            [second.requestId, first.requestId]
                        );
                        assert.equal(records[1].streamStartTime, first.timestamp + 250);
                        assert.equal(records[1].outputSpeed, 12.5);
                        assert.equal(records[1].sessionId, sessionA);
                        assert.equal(records[1].sessionTitle, '本窗正式标题');
                        break;
                    }
                    case 'dateOverview': {
                        const overview = await follower.getDateOverview(today);
                        assert.equal(overview.allSummary.requestCount, 2);
                        assert.equal(overview.allSummary.completedCount, 0);
                        assert.equal(overview.allTotals.totalCost, 0);
                        assert.equal(overview.sessionGroups.length, 2);
                        assert.equal(
                            overview.sessionGroups.find(group => group.sessionId === sessionA)?.title,
                            '本窗正式标题'
                        );
                        assert.equal(
                            overview.sessionGroups.find(group => group.sessionId === sessionA)?.recordCount,
                            1
                        );
                        assert.deepEqual(
                            overview.initialRecordsPage?.records.map(record => record.requestId),
                            [second.requestId, first.requestId]
                        );
                        assert.equal(overview.initialRecordsPage?.records[1]?.streamStartTime, first.timestamp + 250);
                        assert.equal(overview.initialRecordsPage?.records[1]?.outputSpeed, 12.5);
                        assert.equal(overview.initialRecordsPage?.records[1]?.sessionTitle, '本窗正式标题');
                        break;
                    }
                    case 'recordsPage': {
                        const page = await follower.getRecordsPage({
                            date: today,
                            mode: 'session',
                            sessionId: sessionA,
                            page: 1,
                            pageSize: 1
                        });
                        assert.equal(page.totalItems, 1);
                        assert.equal(page.summary.requestCount, 1);
                        assert.equal(page.records[0]?.requestId, first.requestId);
                        assert.equal(page.records[0]?.sessionTitle, '本窗正式标题');
                        const next = await follower.getRecordsPage({ date: today, mode: 'all', page: 2, pageSize: 1 });
                        assert.equal(next.totalItems, 2);
                        assert.equal(next.records[0]?.requestId, first.requestId);
                        break;
                    }
                    case 'trackRecords': {
                        const result = await follower.getTrackRecords({
                            date: today,
                            sessionIds: [sessionA, sessionB],
                            limitPerSession: 1
                        });
                        assert.deepEqual(
                            result.groups.map(group => group.records.map(record => record.requestId)),
                            [[first.requestId], [second.requestId]]
                        );
                        assert.equal(result.groups[0].records[0]?.sessionTitle, '本窗正式标题');
                        assert.equal(result.groups[0].records[0]?.outputSpeed, 12.5);
                        break;
                    }
                }
                assert.ok(remoteExecutions > 0);
                assert.equal(
                    responses.every(response => response.payload.error === undefined),
                    true
                );
                assert.deepEqual(await logger.readDateLogs(today), before);
                const cache = (logger as unknown as { readManager: { hourDetailsCache: Map<string, unknown> } })
                    .readManager.hourDetailsCache;
                assert.equal(cache.size, 0);
            });
        }

        await t.test('remote recent records can skip session title hydration', async context => {
            const { leader, follower, addPending } = await fixture(context);
            const { requestId } = await addPending(sessionA);
            let hydrationCalls = 0;
            (
                leader as unknown as {
                    hydrateSessionTitles(sessionIds: Iterable<string>): Promise<void>;
                }
            ).hydrateSessionTitles = async () => {
                hydrationCalls += 1;
            };

            const records = await follower.getRecentRecords(1, { hydrateSessionTitles: false });

            assert.equal(records[0]?.requestId, requestId);
            assert.equal(hydrationCalls, 0);
            assert.deepEqual(requests.at(-1)?.payload.query, {
                kind: 'recentRecords',
                limit: 1,
                hydrateSessionTitles: false
            });
        });

        await t.test('date overview hydrates session titles beyond the initial records page', async context => {
            const { follower, logger, addPending } = await fixture(context);
            const sessionIds = Array.from(
                { length: 21 },
                (_, index) => `00000000-0000-4000-8000-${String(index).padStart(12, '0')}`
            );
            const baseTimestamp = Date.now() - sessionIds.length * 1000;
            for (const [index, sessionId] of sessionIds.entries()) {
                const { requestId } = await addPending(sessionId, baseTimestamp + index * 1000);
                await logger.updateActualTokens({ requestId, status: 'completed' });
            }

            const hydratedSessionIds = new Set<string>();
            const followerInternals = follower as unknown as {
                scheduleSessionTitleHydration: (sessionIds: Iterable<string>) => void;
            };
            followerInternals.scheduleSessionTitleHydration = sessionIdsToHydrate => {
                for (const sessionId of sessionIdsToHydrate) {
                    hydratedSessionIds.add(sessionId);
                }
            };

            const overview = await follower.getDateOverview(today);

            assert.equal(overview.initialRecordsPage?.records.length, 20);
            assert.equal(overview.sessionGroups.length, 21);
            assert.deepEqual([...hydratedSessionIds].sort(), [...sessionIds].sort());
        });

        await t.test(
            'late generated title for an existing session survives isolated instance title caches',
            async context => {
                const { follower, followerTitles, addPending } = await fixture(context);
                followerTitles.registerSession(sessionA, '合成的标题匹配文本');
                const { requestId } = await addPending(sessionA);
                followerTitles.rememberRequest(sessionA, requestId);
                const resolved = followerTitles.resolveGeneratedTitleDetails('合成的标题匹配文本', '稍后生成的标题');
                assert.ok(resolved);
                await follower.backfillResolvedSessionTitle(resolved.sessionId, resolved.title, resolved.requestId);
                assert.equal((await follower.getRecentRecords(1))[0]?.sessionTitle, resolved.title);
                assert.equal((await follower.getDateOverview(today)).sessionGroups[0]?.title, resolved.title);
            }
        );

        await t.test('cross-midnight pending is included in recent results and only its source date', async context => {
            const { follower, addPending } = await fixture(context);
            const yesterday = DateUtils.getDateStringDaysAgo(1);
            const { requestId } = await addPending(sessionA, new Date(`${yesterday}T23:59:00`).getTime());
            assert.equal((await follower.getRecentRecords(1))[0]?.requestId, requestId);
            assert.equal((await follower.getDateOverview(today)).allSummary.requestCount, 0);
            assert.equal((await follower.getDateOverview(yesterday)).allSummary.requestCount, 1);
        });

        for (const status of ['completed', 'cancelled', 'failed'] as const) {
            await t.test(`${status} written during transit wins over the estimated pending snapshot`, async context => {
                const { follower, logger, addPending } = await fixture(context);
                const { requestId, timestamp } = await addPending(sessionA);
                beforeRemoteQuery = async () => {
                    beforeRemoteQuery = undefined;
                    await logger.updateActualTokens({
                        requestId,
                        sessionId: sessionA,
                        sessionTitle: '终态标题',
                        status,
                        rawUsage: { prompt_tokens: 20, completion_tokens: 8, total_tokens: 28 },
                        estimatedCost: 0.25,
                        streamStartTime: timestamp + 250,
                        streamEndTime: timestamp + 1000
                    });
                };
                const page = await follower.getRecordsPage({ date: today, mode: 'all', page: 1, pageSize: 20 });
                assert.equal(page.records.length, 1);
                assert.equal(page.records[0].status, status);
                assert.equal(page.records[0].sessionTitle, '终态标题');
                assert.equal(page.records[0].totalTokens, 28);
                assert.equal(page.totals.totalCost, status === 'completed' ? 0.25 : 0);
                assert.equal(page.summary.completedCount, status === 'completed' ? 1 : 0);
            });
        }

        await t.test(
            'pending metadata refreshes between queries without changing leader cached raw records',
            async context => {
                const { follower, leader, logger, addPending } = await fixture(context);
                const { requestId } = await addPending(sessionA);
                await follower.backfillResolvedSessionTitle(sessionA, '第一版标题', requestId);
                assert.equal((await follower.getRecentRecords(1))[0]?.sessionTitle, '第一版标题');
                await follower.backfillResolvedSessionTitle(sessionA, '第二版标题', requestId);
                assert.equal((await follower.getRecentRecords(1))[0]?.sessionTitle, '第二版标题');
                const leaderRaw = await leader.getFileLogger().getRequestDetails(today);
                assert.equal(leaderRaw[0]?.sessionTitle, undefined);
                assert.equal((await logger.readDateLogs(today)).length, 1);
            }
        );

        for (const status of ['completed', 'cancelled', 'failed'] as const) {
            await t.test(`updated pending title survives transition to ${status} in all queries`, async context => {
                const { follower, leader, logger, addPending, leaderTitles, followerTitles } = await fixture(context);
                const { requestId, timestamp } = await addPending(sessionA, Date.now());
                const initialLogs = await logger.readDateLogs(today);
                const historicalTitles = (
                    leader as unknown as {
                        historicalSessionTitleCache: Map<string, { title: string | null }>;
                    }
                ).historicalSessionTitleCache;
                const cachedPendingTitles: Array<string | null | undefined> = [];

                async function queryTitles(): Promise<Array<string | undefined>> {
                    const recent = await follower.getRecentRecords(1);
                    const overview = await follower.getDateOverview(today);
                    const page = await follower.getRecordsPage({
                        date: today,
                        mode: 'session',
                        sessionId: sessionA,
                        page: 1,
                        pageSize: 20
                    });
                    const track = await follower.getTrackRecords({
                        date: today,
                        sessionIds: [sessionA, sessionB],
                        limitPerSession: 1
                    });
                    return [
                        recent[0]?.sessionTitle,
                        overview.sessionGroups.find(group => group.sessionId === sessionA)?.title,
                        page.records[0]?.sessionTitle,
                        track.groups[0].records[0]?.sessionTitle
                    ];
                }

                for (const [index, title] of ['第一版标题', '第二版标题'].entries()) {
                    followerTitles.rememberResolvedTitle(sessionA, title, timestamp + index + 1);
                    await follower.backfillResolvedSessionTitle(sessionA, title, requestId);
                    assert.deepEqual(
                        await queryTitles(),
                        Array.from({ length: 4 }, () => title)
                    );
                    cachedPendingTitles.push(leaderTitles.getTitle(sessionA), historicalTitles.get(sessionA)?.title);
                    assert.deepEqual(await logger.readDateLogs(today), initialLogs);
                }

                await logger.updateActualTokens({
                    requestId,
                    status,
                    sessionTitle: '第二版标题',
                    rawUsage: { prompt_tokens: 20, completion_tokens: 8, total_tokens: 28 },
                    estimatedCost: 0.25,
                    streamStartTime: timestamp + 250,
                    streamEndTime: timestamp + 1000
                });
                const raw = await logger.getRequestDetails(today);
                assert.equal(raw.length, 1);
                assert.equal(raw[0].timestamp, timestamp);
                assert.equal(raw[0].status, status);
                assert.equal(raw[0].sessionTitle, '第二版标题');
                assert.equal(logger.getPendingLogs().length, 0);
                assert.deepEqual(
                    await queryTitles(),
                    Array.from({ length: 4 }, () => '第二版标题')
                );
                assert.ok(cachedPendingTitles.every(title => title === undefined || title === null));
                assert.equal(leaderTitles.getTitle(sessionA), '第二版标题');
                assert.equal(historicalTitles.get(sessionA)?.title, '第二版标题');
                assert.ok(remoteExecutions >= 12);

                transportFailure = true;
                assert.deepEqual(
                    await queryTitles(),
                    Array.from({ length: 4 }, () => '第二版标题')
                );
                const local = await follower.getRecentRecords(1);
                assert.equal(local[0]?.status, status);
                assert.equal(local[0]?.totalTokens, 28);
            });
        }

        await t.test('empty recent results remain a successful remote query', async context => {
            const { follower } = await fixture(context);
            assert.deepEqual(await follower.getRecentRecords(1), []);
            assert.equal(remoteExecutions, 1);
            assert.equal(responses[0]?.payload.error, undefined);
            assert.deepEqual(responses[0]?.payload.result, { kind: 'recentRecords', value: [] });
        });

        await t.test('estimated pending added during a remote query invalidates the response', async context => {
            const { follower, logger } = await fixture(context);
            const getPendingLogs = logger.getPendingLogs.bind(logger);
            const timestamp = Date.now();
            const latePending: TokenRequestLog = {
                requestId: `${timestamp}_late-pending`,
                timestamp,
                isoTime: new Date(timestamp).toISOString(),
                providerKey: 'test',
                providerName: 'Test',
                modelId: 'test',
                modelName: 'Test',
                estimatedInput: 10,
                status: 'estimated',
                rawUsage: null,
                sessionId: sessionA,
                sessionTitle: '晚到请求'
            };
            beforeRemoteQuery = async () => {
                beforeRemoteQuery = undefined;
                logger.getPendingLogs = () => [...getPendingLogs(), latePending];
            };

            const overview = await follower.getDateOverview(today);
            assert.equal(overview.allSummary.requestCount, 1);
            assert.equal(overview.sessionGroups[0]?.title, '晚到请求');
            assert.equal(remoteExecutions, 1);
        });

        await t.test('pending title changed during a remote query invalidates the response', async context => {
            const { follower, addPending, followerTitles } = await fixture(context);
            const { requestId, timestamp } = await addPending(sessionA);
            beforeRemoteQuery = async () => {
                beforeRemoteQuery = undefined;
                followerTitles.rememberResolvedTitle(sessionA, '查询中更新的标题', timestamp + 1);
                await follower.backfillResolvedSessionTitle(sessionA, '查询中更新的标题', requestId);
            };

            const page = await follower.getRecordsPage({ date: today, mode: 'all', page: 1, pageSize: 20 });
            assert.equal(page.records[0]?.sessionTitle, '查询中更新的标题');
            assert.equal(remoteExecutions, 1);
        });

        await t.test(
            'stable date queries reuse prepared records and refresh after another host writes',
            async context => {
                const { follower, leader, logger, addPending } = await fixture(context);
                const first = await addPending(sessionA, Date.now() - 2000);
                await logger.updateActualTokens({
                    requestId: first.requestId,
                    status: 'completed',
                    sessionTitle: '第一条记录',
                    rawUsage: { prompt_tokens: 20, completion_tokens: 8, total_tokens: 28 }
                });

                const leaderLogger = leader.getFileLogger();
                const getRequestDetails = leaderLogger.getRequestDetails.bind(leaderLogger);
                let dateReads = 0;
                context.mock.method(leaderLogger, 'getRequestDetails', async (date: string) => {
                    if (date === today) {
                        dateReads += 1;
                    }
                    return getRequestDetails(date);
                });

                assert.equal((await follower.getDateOverview(today)).allSummary.requestCount, 1);
                assert.equal(
                    (await follower.getRecordsPage({ date: today, mode: 'all', page: 1, pageSize: 20 })).totalItems,
                    1
                );
                assert.equal(
                    (
                        await follower.getTrackRecords({
                            date: today,
                            sessionIds: [sessionA, sessionB],
                            limitPerSession: 1
                        })
                    ).groups[0].records.length,
                    1
                );
                assert.equal(dateReads, 1);

                const second = await addPending(sessionB, Date.now() - 1000);
                await logger.updateActualTokens({
                    requestId: second.requestId,
                    status: 'completed',
                    sessionTitle: '第二条记录',
                    rawUsage: { prompt_tokens: 10, completion_tokens: 4, total_tokens: 14 }
                });
                assert.equal(
                    (await follower.getRecordsPage({ date: today, mode: 'all', page: 1, pageSize: 20 })).totalItems,
                    2
                );
                assert.equal(dateReads, 2);
            }
        );

        for (const failure of ['hourly-read', 'directory-scan'] as const) {
            await t.test(`remote recent ${failure} failure falls back and recovers`, async context => {
                const { follower, leader, logger, addPending } = await fixture(context);
                const { requestId } = await addPending(sessionA, Date.now());
                await logger.updateActualTokens({
                    requestId,
                    status: 'completed',
                    sessionTitle: '读取失败回退标题',
                    rawUsage: { prompt_tokens: 20, completion_tokens: 8, total_tokens: 28 }
                });
                transportFailure = true;
                const expected = await follower.getRecentRecords(1);
                assert.equal(expected[0]?.status, 'completed');
                assert.equal(expected[0]?.totalTokens, 28);
                transportFailure = false;

                let failLeaderRead = true;
                let injectedFailures = 0;
                const leaderLogger = leader.getFileLogger() as unknown as { readManager: LogReadManager };
                if (failure === 'hourly-read') {
                    const readHourLogs = leaderLogger.readManager.readHourLogs.bind(leaderLogger.readManager);
                    context.mock.method(
                        leaderLogger.readManager,
                        'readHourLogs',
                        (...args: Parameters<LogReadManager['readHourLogs']>) => {
                            if (failLeaderRead) {
                                injectedFailures += 1;
                                return Promise.reject(new Error('Injected leader hourly read failure'));
                            }
                            return readHourLogs(...args);
                        }
                    );
                } else {
                    const fs = require('node:fs') as typeof import('node:fs');
                    const readdirSync = fs.readdirSync;
                    context.mock.method(fs, 'readdirSync', (...args: unknown[]) => {
                        if (failLeaderRead && currentInstance === 'leader') {
                            injectedFailures += 1;
                            throw new Error('Injected leader directory read failure');
                        }
                        return Reflect.apply(readdirSync, fs, args);
                    });
                }

                assert.deepEqual(await follower.getRecentRecords(1), expected);
                assert.ok(injectedFailures > 0);
                assert.equal(remoteExecutions, 1);
                assert.equal(responses.at(-1)?.payload.error, 'query-failed');

                if (failure === 'hourly-read') {
                    logger.clearDetailCaches();
                    const localReader = (logger as unknown as { readManager: LogReadManager }).readManager;
                    const readHourLogs = localReader.readHourLogs.bind(localReader);
                    context.mock.method(localReader, 'readHourLogs', async () => {
                        throw new Error('Injected local hourly read failure');
                    });
                    assert.deepEqual(await follower.getRecentRecords(1), []);
                    assert.equal(responses.at(-1)?.payload.error, 'query-failed');
                    localReader.readHourLogs = readHourLogs;
                }

                failLeaderRead = false;
                const recovered = await follower.getRecentRecords(1);
                assert.deepEqual(JSON.parse(JSON.stringify(recovered)), JSON.parse(JSON.stringify(expected)));
                assert.equal(responses.at(-1)?.payload.error, undefined);
                const cache = (logger as unknown as { readManager: { hourDetailsCache: Map<string, unknown> } })
                    .readManager.hourDetailsCache;
                assert.equal(cache.size, 0);
            });
        }

        for (const status of ['completed', 'cancelled', 'failed'] as const) {
            for (const timing of ['before-query', 'during-flush', 'during-request'] as const) {
                await t.test(`unwritten ${status} ${timing} stays local until persisted`, async context => {
                    const { follower, logger, addPending } = await fixture(context);
                    const { requestId, timestamp } = await addPending(sessionA, Date.now());
                    const initialLogs = await logger.readDateLogs(today);
                    const writer = (
                        logger as unknown as {
                            writeManager: { writeLogInternal: (log: TokenRequestLog) => Promise<void> };
                        }
                    ).writeManager;
                    const writeLog = writer.writeLogInternal.bind(writer);
                    let failTerminalWrite = true;
                    context.mock.method(writer, 'writeLogInternal', async (log: TokenRequestLog) => {
                        if (failTerminalWrite && log.status !== 'estimated') {
                            throw new Error('Injected terminal write failure');
                        }
                        await writeLog(log);
                    });
                    const terminal = {
                        requestId,
                        status,
                        sessionTitle: '未落盘终态标题',
                        rawUsage: { prompt_tokens: 20, completion_tokens: 8, total_tokens: 28 },
                        estimatedCost: 0.25,
                        streamStartTime: timestamp + 250,
                        streamEndTime: timestamp + 1000
                    };
                    const failWrite = () =>
                        assert.rejects(logger.updateActualTokens(terminal), /Injected terminal write failure/);
                    if (timing === 'before-query') {
                        await failWrite();
                    } else if (timing === 'during-flush') {
                        const flush = logger.flush.bind(logger);
                        let pendingFailure = true;
                        context.mock.method(logger, 'flush', async () => {
                            if (pendingFailure) {
                                pendingFailure = false;
                                await failWrite();
                            }
                            await flush();
                        });
                    } else {
                        beforeRemoteQuery = async () => {
                            beforeRemoteQuery = undefined;
                            await failWrite();
                        };
                    }

                    async function assertTerminalQueries(): Promise<void> {
                        const recent = await follower.getRecentRecords(1);
                        const overview = await follower.getDateOverview(today);
                        const page = await follower.getRecordsPage({ date: today, mode: 'all', page: 1, pageSize: 20 });
                        const sessionPage = await follower.getRecordsPage({
                            date: today,
                            mode: 'session',
                            sessionId: sessionA,
                            page: 1,
                            pageSize: 20
                        });
                        const track = await follower.getTrackRecords({
                            date: today,
                            sessionIds: [sessionA, sessionB],
                            limitPerSession: 1
                        });
                        for (const records of [recent, page.records, sessionPage.records, track.groups[0].records]) {
                            assert.equal(records.length, 1);
                            assert.equal(records[0].requestId, requestId);
                            assert.equal(records[0].status, status);
                            assert.equal(records[0].totalTokens, 28);
                            assert.equal(records[0].estimatedCost, 0.25);
                            assert.equal(records[0].sessionTitle, '未落盘终态标题');
                        }
                        for (const summary of [overview.allSummary, page.summary, sessionPage.summary]) {
                            assert.equal(summary.requestCount, 1);
                            assert.equal(summary.completedCount, status === 'completed' ? 1 : 0);
                            assert.equal(summary.cancelledCount, status === 'cancelled' ? 1 : 0);
                            assert.equal(summary.failedCount, status === 'failed' ? 1 : 0);
                        }
                        assert.equal(overview.allTotals.totalCost, status === 'completed' ? 0.25 : 0);
                        assert.equal(overview.sessionGroups[0]?.title, '未落盘终态标题');
                    }

                    await assertTerminalQueries();
                    assert.equal(remoteExecutions, timing === 'during-request' ? 1 : 0);
                    assert.equal(logger.getPendingLogs()[0]?.status, status);
                    assert.deepEqual(await logger.readDateLogs(today), initialLogs);
                    assert.ok(
                        requests.every(request =>
                            request.payload.pendingRecords?.every(
                                log => log.status === 'estimated' && log.rawUsage === null && !('estimatedCost' in log)
                            )
                        )
                    );

                    const executionsBeforeOtherDate = remoteExecutions;
                    assert.equal(
                        (await follower.getDateOverview(DateUtils.getDateStringDaysAgo(1))).allSummary.requestCount,
                        0
                    );
                    assert.equal(remoteExecutions, executionsBeforeOtherDate + 1);

                    failTerminalWrite = false;
                    await logger.updateActualTokens(terminal);
                    assert.equal(logger.getPendingLogs().length, 0);
                    const executionsBeforeRecovery = remoteExecutions;
                    await assertTerminalQueries();
                    assert.equal(remoteExecutions, executionsBeforeRecovery + 5);
                });
            }
        }

        await t.test('delivery failure uses fresh local pending state', async context => {
            const { follower, addPending } = await fixture(context);
            const { requestId } = await addPending(sessionA);
            await follower.backfillResolvedSessionTitle(sessionA, '本地回退标题', requestId);
            transportFailure = true;
            assert.equal((await follower.getRecentRecords(1))[0]?.sessionTitle, '本地回退标题');
            assert.equal(
                (await follower.getDateOverview(today)).initialRecordsPage?.records[0]?.sessionTitle,
                '本地回退标题'
            );
            assert.equal(remoteExecutions, 0);
        });

        for (const boundary of ['record-count', 'byte-size'] as const) {
            await t.test(`oversized ${boundary} pending falls back without truncating records`, async context => {
                const { follower, logger } = await fixture(context);
                const timestamp = Date.now();
                const count = boundary === 'record-count' ? 101 : 100;
                const pending: TokenRequestLog[] = Array.from({ length: count }, (_, index) => ({
                    requestId: `${timestamp}_${index}`,
                    timestamp,
                    isoTime: new Date(timestamp).toISOString(),
                    providerKey: 'test',
                    providerName: 'Test',
                    modelId: 'test',
                    modelName: 'Test',
                    estimatedInput: 10,
                    rawUsage: null,
                    status: 'estimated',
                    sessionId: sessionA,
                    sessionTitle: boundary === 'byte-size' ? '题'.repeat(2000) : '本地标题'
                }));
                logger.getPendingLogs = () => pending;
                const overview = await follower.getDateOverview(today);
                assert.equal(overview.allSummary.requestCount, count);
                assert.equal(requests.length, 0);
                assert.equal(remoteExecutions, 0);
            });
        }
    } finally {
        NodeModule.prototype.require = originalRequire;
    }
});
