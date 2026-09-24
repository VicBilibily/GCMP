import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, rename, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import test, { type TestContext } from 'node:test';
import { DateUtils } from '../../usages/fileLogger/dateUtils';
import { StatsCalculator } from '../../usages/fileLogger/statsCalculator';
import type { DateIndex, DateIndexEntry, TokenUsageStatsFromFile } from '../../usages/fileLogger/types';
import type { HostMessage, WebViewMessage } from './types';

const require = createRequire(import.meta.url);
const NodeModule = require('node:module') as {
    prototype: { require: (id: string) => unknown };
};

test('opening usages view reconciles a stale index once, without slowing event refreshes', async t => {
    const dir = await mkdtemp(join(tmpdir(), 'gcmp-usages-index-'));
    const originalRequire = NodeModule.prototype.require;
    let onStatsUpdate: () => void = () => {};
    let resolveNextList: ((message: { dateList: Array<{ date: string; total_requests: number }> }) => void) | undefined;
    let nextList = new Promise<{ dateList: Array<{ date: string; total_requests: number }> }>(resolve => {
        resolveNextList = resolve;
    });
    let onDispose: () => void = () => {};
    const detailDates: string[] = [];
    const messages: HostMessage[] = [];
    const panel = {
        webview: {
            html: '',
            onDidReceiveMessage: () => ({ dispose() {} }),
            postMessage: (message: HostMessage) => {
                messages.push(message);
                if (message.command === 'updateDateList') {
                    resolveNextList?.(message);
                } else if (message.command === 'updateDateDetails') {
                    detailDates.push((message as unknown as { date: string }).date);
                }
                return Promise.resolve(true);
            }
        },
        onDidDispose: (listener: () => void) => {
            onDispose = listener;
            return { dispose() {} };
        },
        reveal() {},
        dispose: () => onDispose()
    };

    try {
        NodeModule.prototype.require = function (id: string): unknown {
            if (id === 'vscode') {
                return {
                    window: { createWebviewPanel: () => panel },
                    ViewColumn: { One: 1 },
                    ExtensionMode: { Development: 2 },
                    env: { language: 'zh-cn' }
                };
            }
            if (id.endsWith('/statusLogger')) {
                return { StatusLogger: { debug() {}, warn() {}, error() {} } };
            }
            if (id.endsWith('/usagesManager')) {
                return {
                    TokenUsagesManager: {
                        get instance() {
                            return manager;
                        }
                    }
                };
            }
            if (id.endsWith('/l10n')) {
                return { t: (_key: string, fallback: string) => fallback };
            }
            if (id.endsWith('/utils') && id.includes('usagesView')) {
                return { getTodayDateString: () => '2026-09-23' };
            }
            if (id.endsWith('/aggregation')) {
                return {
                    buildNativeCostSplitIndex: () => ({}),
                    buildRequestTotals: () => ({}),
                    buildSessionGroupSummaries: () => [],
                    summarizeSessionRecords: () => ({})
                };
            }
            if (id.endsWith('/multiDayView')) {
                return { MultiDayView: class {} };
            }
            if (id.endsWith('/liveMetrics')) {
                return { onLiveMetrics: () => ({ dispose() {} }), getActiveMetricsSnapshot: () => [] };
            }
            if (id.endsWith('/interInstance')) {
                return { InterInstanceBus: { subscribe: () => ({ dispose() {} }) } };
            }
            return originalRequire.call(this, id);
        };
        const { LogIndexManager } = await import('../../usages/fileLogger/logIndexManager');
        const { TokenUsagesView } = await import('./index');
        const indexManager = new LogIndexManager(dir);
        const usagesDir = join(dir, 'usages');
        await mkdir(join(usagesDir, '2026-09-22'), { recursive: true });
        await writeFile(
            join(usagesDir, '2026-09-22', 'stats.json'),
            JSON.stringify({
                total: {
                    actualInput: 7,
                    cacheTokens: 1,
                    outputTokens: 2,
                    requests: 3,
                    estimatedCost: 0.1,
                    estimatedCostRmb: 0.7
                }
            })
        );
        await writeFile(
            indexManager.getIndexPath(),
            JSON.stringify({
                dates: {
                    '2026-09-22': {
                        total_input: 0,
                        total_cache: 0,
                        total_output: 0,
                        total_requests: 0,
                        total_cost: 0,
                        total_cost_rmb: 0
                    },
                    '2026-09-21': {
                        total_input: 5,
                        total_cache: 0,
                        total_output: 0,
                        total_requests: 1,
                        total_cost: 0,
                        total_cost_rmb: 0
                    }
                },
                versionTimestamp: 42
            })
        );
        let reconciliations = 0;
        let failRegeneration = false;
        const logger = {
            regenerateOutdatedStats: async () => {
                if (failRegeneration) {
                    throw new Error('stats rebuild failed');
                }
                return {};
            },
            getIndex: async () => {
                reconciliations++;
                return indexManager.getIndex();
            },
            getIndexFast: () => indexManager.getIndexFast()
        };
        const manager = {
            getFileLogger: () => logger,
            getAllDateSummaries: async () =>
                Object.entries(await logger.getIndexFast()).map(([date, entry]) => ({
                    date,
                    total_requests: entry.total_requests
                })),
            onStatsUpdate: (listener: () => void) => {
                onStatsUpdate = listener;
                return { dispose() {} };
            }
        };
        const view = new TokenUsagesView({ subscriptions: [] } as never);
        Object.defineProperty(view, 'getWebviewContent', { value: () => '' });
        let detailCallCount = 0;
        let blockFirstDetail = false;
        let releaseFirstDetail: (() => void) | undefined;
        Object.defineProperty(view, 'updateDateDetailsInternal', {
            configurable: true,
            value: async () => {
                detailCallCount += 1;
                if (blockFirstDetail && detailCallCount === 1) {
                    await new Promise<void>(resolve => {
                        releaseFirstDetail = resolve;
                    });
                }
            }
        });
        view.show();
        const firstList = await nextList;
        assert.deepEqual(firstList.dateList, [{ date: '2026-09-22', total_requests: 3 }]);
        assert.equal(reconciliations, 1);
        assert.deepEqual((await indexManager.getIndexFast())['2026-09-22']?.total_input, 7);
        assert.equal((await readFile(indexManager.getIndexPath(), 'utf8')).includes('2026-09-21'), false);
        assert.equal((await readFile(indexManager.getIndexPath(), 'utf8')).includes('"versionTimestamp": 42'), true);

        blockFirstDetail = true;
        const viewInternals = view as unknown as { updateDateDetails(date: string): Promise<void> };
        const firstDetail = viewInternals.updateDateDetails('2026-09-23');
        await new Promise<void>(resolve => setImmediate(resolve));
        const secondDetail = viewInternals.updateDateDetails('2026-09-23');
        await new Promise<void>(resolve => setImmediate(resolve));
        assert.equal(detailCallCount, 1);
        const release = releaseFirstDetail;
        assert.ok(release);
        release();
        await Promise.all([firstDetail, secondDetail]);
        assert.equal(detailCallCount, 2);

        nextList = new Promise(resolve => {
            resolveNextList = resolve;
        });
        onStatsUpdate();
        await nextList;
        assert.equal(reconciliations, 1);
        view.dispose();

        await writeFile(indexManager.getIndexPath(), JSON.stringify({ dates: {} }));
        failRegeneration = true;
        nextList = new Promise(resolve => {
            resolveNextList = resolve;
        });
        view.show();
        assert.deepEqual((await nextList).dateList, [{ date: '2026-09-22', total_requests: 3 }]);
        assert.equal(reconciliations, 2);

        const realDetailRefresh = (
            Object.getPrototypeOf(view) as {
                updateDateDetailsInternal: (panel: unknown, date: string) => Promise<void>;
            }
        ).updateDateDetailsInternal;
        Object.defineProperty(view, 'updateDateDetailsInternal', { configurable: true, value: realDetailRefresh });
        let signalHistoryStarted!: () => void;
        let releaseHistory!: () => void;
        const historyStarted = new Promise<void>(resolve => {
            signalHistoryStarted = resolve;
        });
        const historyBlocked = new Promise<void>(resolve => {
            releaseHistory = resolve;
        });
        Object.assign(manager, {
            getDateStatsFromFile: async (date: string) => {
                if (date === '2026-09-22') {
                    signalHistoryStarted();
                    await historyBlocked;
                }
                return { providers: {}, hourly: {} };
            },
            getDateRecords: async () => []
        });
        const actions = view as unknown as {
            handleMessage: (message: WebViewMessage) => Promise<void>;
            doSmartRefresh: () => Promise<void>;
            currentSelectedDate: string;
            panel: typeof panel | undefined;
        };
        const selection = actions.handleMessage({ command: 'selectDate', date: '2026-09-22' });
        await historyStarted;
        const automaticRefresh = actions.doSmartRefresh();
        releaseHistory();
        await Promise.all([selection, automaticRefresh]);
        assert.equal(actions.currentSelectedDate, '2026-09-22');
        assert.equal(detailDates.at(-1), '2026-09-22');

        const today = DateUtils.getTodayDateString();
        let signalTodayStarted!: () => void;
        let releaseToday!: () => void;
        const todayStarted = new Promise<void>(resolve => {
            signalTodayStarted = resolve;
        });
        const todayBlocked = new Promise<void>(resolve => {
            releaseToday = resolve;
        });
        Object.assign(manager, {
            getDateStatsFromFile: async (date: string) => {
                if (date === today) {
                    signalTodayStarted();
                    await todayBlocked;
                }
                return { providers: {}, hourly: {} };
            }
        });
        detailDates.length = 0;
        actions.currentSelectedDate = today;
        const oldRefresh = actions.doSmartRefresh();
        await todayStarted;
        const latestSelection = actions.handleMessage({ command: 'selectDate', date: '2026-09-22' });
        releaseToday();
        await Promise.all([oldRefresh, latestSelection]);
        assert.deepEqual(detailDates, ['2026-09-22']);
        assert.equal(actions.currentSelectedDate, '2026-09-22');

        await t.test('history read failure reports an error and permits retry', async () => {
            Object.assign(manager, {
                getDateStatsFromFile: async () => ({ providers: {}, hourly: {} }),
                getDateRecords: async () => {
                    throw new Error('transient read failure');
                }
            });
            messages.length = 0;
            await actions.handleMessage({ command: 'selectDate', date: '2026-09-22' });
            assert.deepEqual(messages, [{ command: 'dateLoadError', date: '2026-09-22' }]);
            Object.assign(manager, { getDateRecords: async () => [] });
            await actions.handleMessage({ command: 'selectDate', date: '2026-09-22' });
            assert.equal(messages.at(-1)?.command, 'updateDateDetails');
        });

        await t.test('initial summary failure is reported even before a date list arrives', async () => {
            Object.assign(manager, {
                getDateStatsFromFile: async () => {
                    throw new Error('stats unavailable');
                },
                getDateRecords: async () => []
            });
            messages.length = 0;
            await actions.handleMessage({ command: 'getInitialData' });
            assert.deepEqual(messages[0], { command: 'dateLoadError', date: today });
            assert.equal(messages[1]?.command, 'updateDateList');
        });

        for (const obsolete of ['selection', 'panel'] as const) {
            await t.test(`late error is ignored after ${obsolete} changes`, async () => {
                let signalRead!: () => void;
                let rejectRead!: (error: Error) => void;
                const started = new Promise<void>(resolve => {
                    signalRead = resolve;
                });
                const pending = new Promise<never>((_resolve, reject) => {
                    rejectRead = reject;
                });
                Object.assign(manager, {
                    getDateStatsFromFile: async () => ({ providers: {}, hourly: {} }),
                    getDateRecords: async () => {
                        signalRead();
                        return pending;
                    }
                });
                messages.length = 0;
                const selection = actions.handleMessage({ command: 'selectDate', date: '2026-09-22' });
                await started;
                if (obsolete === 'selection') {
                    actions.currentSelectedDate = '2026-09-21';
                } else {
                    actions.panel = undefined;
                }
                rejectRead(new Error('late read failure'));
                await selection;
                assert.deepEqual(messages, []);
                actions.panel = panel;
            });
        }
        view.dispose();
    } finally {
        NodeModule.prototype.require = originalRequire;
        await rm(dir, { recursive: true, force: true });
    }
});

test('fast index reads recover failures without making healthy reads scan all dates', async t => {
    const { LogIndexManager } = await import('../../usages/fileLogger/logIndexManager');
    const { AtomicJsonFile } = await import('../../usages/atomicJsonFile');
    const today = DateUtils.getTodayDateString();
    const yesterday = DateUtils.getDateStringDaysAgo(1);

    async function createFixture(context: TestContext) {
        const dir = await mkdtemp(join(tmpdir(), 'gcmp-index-recovery-'));
        context.after(() => rm(dir, { recursive: true, force: true }));
        const index = new LogIndexManager(dir);
        const stats = StatsCalculator.aggregateLogs([]);
        stats.total.requests = 1;
        for (const date of [today, yesterday]) {
            const folder = join(dir, 'usages', date);
            await mkdir(folder, { recursive: true });
            await writeFile(join(folder, 'stats.json'), JSON.stringify(stats));
        }
        await index.setVersionTimestamp(42);
        await index.getIndex();
        const internals = index as unknown as { getAllStatsDates(): Promise<string[]> };
        const getAllStatsDates = internals.getAllStatsDates.bind(index);
        let scans = 0;
        internals.getAllStatsDates = async () => {
            scans++;
            return getAllStatsDates();
        };
        return {
            index,
            stats,
            internals,
            indexPath: index.getIndexPath(),
            statsPath: (date: string) => join(dir, 'usages', date, 'stats.json'),
            scans: () => scans
        };
    }

    await t.test('healthy reads and successful incremental writes do not reconcile', async context => {
        const fixture = await createFixture(context);
        const updated: TokenUsageStatsFromFile = {
            ...fixture.stats,
            total: { ...fixture.stats.total, requests: 2 }
        };
        await writeFile(fixture.statsPath(today), JSON.stringify(updated));
        await fixture.index.updateIndex(today, updated.total);
        for (let attempt = 0; attempt < 4; attempt++) {
            assert.equal((await fixture.index.getIndexFast())[today].total_requests, 2);
        }
        assert.equal(fixture.scans(), 0);
    });

    for (const damage of ['missing', 'malformed', 'invalid-shape', 'recreated-partial', 'updated-partial'] as const) {
        await t.test(`${damage} index is repaired once for concurrent readers`, async context => {
            const fixture = await createFixture(context);
            if (damage === 'missing' || damage === 'recreated-partial' || damage === 'updated-partial') {
                await rename(fixture.indexPath, `${fixture.indexPath}.saved`);
                if (damage === 'recreated-partial') {
                    await fixture.index.setVersionTimestamp(42);
                } else if (damage === 'updated-partial') {
                    await fixture.index.updateIndex(today, fixture.stats.total);
                }
            } else {
                await writeFile(fixture.indexPath, damage === 'malformed' ? '{' : '{"dates":[]}');
            }
            const results = await Promise.all(Array.from({ length: 4 }, () => fixture.index.getIndexFast()));
            for (const result of results) {
                assert.deepEqual(Object.keys(result).sort(), [today, yesterday].sort());
                assert.equal(result[today].total_requests, 1);
            }
            const saved = JSON.parse(await readFile(fixture.indexPath, 'utf8')) as DateIndex;
            assert.equal(JSON.stringify(saved.dates), JSON.stringify(results[0]));
            if (damage === 'recreated-partial') {
                assert.equal(saved.versionTimestamp, 42);
            }
            assert.equal(fixture.scans(), 1);
            await fixture.index.getIndexFast();
            assert.equal(fixture.scans(), 1);
        });
    }

    const validEntry: DateIndexEntry = {
        total_input: 0,
        total_cache: 0,
        total_output: 0,
        total_requests: 1,
        total_cost: 0
    };
    const invalidEntries: Record<string, unknown> = {
        null: null,
        array: [],
        primitive: 1,
        'missing-fields': {},
        'string-input': { ...validEntry, total_input: '1' },
        'null-cache': { ...validEntry, total_cache: null },
        'missing-output': { ...validEntry, total_output: undefined },
        'null-requests': { ...validEntry, total_requests: null },
        'null-cost': { ...validEntry, total_cost: null },
        'string-rmb': { ...validEntry, total_cost_rmb: '1' },
        'null-native-usd': { ...validEntry, native_total_cost: null },
        'string-native-rmb': { ...validEntry, native_total_cost_rmb: '1' }
    };
    for (const [damage, entry] of Object.entries(invalidEntries)) {
        await t.test(`${damage} index entry is repaired once for concurrent readers`, async context => {
            const fixture = await createFixture(context);
            const previous = JSON.parse(await readFile(fixture.indexPath, 'utf8')) as DateIndex;
            await writeFile(
                fixture.indexPath,
                JSON.stringify({ ...previous, dates: { ...previous.dates, [yesterday]: entry } })
            );
            const results = await Promise.all(Array.from({ length: 4 }, () => fixture.index.getIndexFast()));
            for (const result of results) {
                assert.equal(result[today].total_requests, 1);
                assert.equal(result[yesterday].total_requests, 1);
            }
            const saved = JSON.parse(await readFile(fixture.indexPath, 'utf8')) as DateIndex;
            assert.equal(JSON.stringify(saved.dates), JSON.stringify(results[0]));
            assert.equal(fixture.scans(), 1);
            await fixture.index.getIndexFast();
            assert.equal(fixture.scans(), 1);
        });
    }

    await t.test('invalid entries cannot be used as a fallback when recovery fails', async context => {
        const fixture = await createFixture(context);
        const previous = JSON.parse(await readFile(fixture.indexPath, 'utf8')) as DateIndex;
        const damaged = JSON.stringify({ ...previous, dates: { ...previous.dates, [yesterday]: null } });
        await writeFile(fixture.indexPath, damaged);
        await writeFile(fixture.statsPath(yesterday), '{');
        for (let attempt = 0; attempt < 2; attempt++) {
            await assert.rejects(fixture.index.getIndexFast(), SyntaxError);
            assert.equal(await readFile(fixture.indexPath, 'utf8'), damaged);
        }
        await writeFile(fixture.statsPath(yesterday), JSON.stringify(fixture.stats));
        assert.equal((await fixture.index.getIndexFast())[yesterday].total_requests, 1);
        assert.equal(fixture.scans(), 3);
        await fixture.index.getIndexFast();
        assert.equal(fixture.scans(), 3);
    });

    await t.test('legacy entries without optional costs retain the healthy fast path', async context => {
        const fixture = await createFixture(context);
        const previous = JSON.parse(await readFile(fixture.indexPath, 'utf8')) as DateIndex;
        const legacy: DateIndex = { ...previous, dates: { [today]: validEntry, [yesterday]: validEntry } };
        const content = JSON.stringify(legacy);
        await writeFile(fixture.indexPath, content);
        for (let attempt = 0; attempt < 3; attempt++) {
            assert.deepEqual(await fixture.index.getIndexFast(), legacy.dates);
        }
        assert.equal(await readFile(fixture.indexPath, 'utf8'), content);
        assert.equal(fixture.scans(), 0);
    });

    for (const partialWrite of ['version', 'date'] as const) {
        await t.test(`a partial ${partialWrite} index is not used as a complete recovery fallback`, async context => {
            const fixture = await createFixture(context);
            await rename(fixture.indexPath, `${fixture.indexPath}.saved`);
            if (partialWrite === 'version') {
                await fixture.index.setVersionTimestamp(42);
            } else {
                await fixture.index.updateIndex(today, fixture.stats.total);
            }
            const partial = await readFile(fixture.indexPath, 'utf8');
            await writeFile(fixture.statsPath(yesterday), '{');
            await assert.rejects(fixture.index.getIndexFast(), SyntaxError);
            assert.equal(await readFile(fixture.indexPath, 'utf8'), partial);
            await writeFile(fixture.statsPath(yesterday), JSON.stringify(fixture.stats));
            assert.equal(Object.keys(await fixture.index.getIndexFast()).length, 2);
        });
    }

    await t.test('failed update and failed recovery keep the old index and remain retryable', async context => {
        const fixture = await createFixture(context);
        const previous = await readFile(fixture.indexPath, 'utf8');
        const updated = { ...fixture.stats, total: { ...fixture.stats.total, requests: 2 } };
        await writeFile(fixture.statsPath(today), JSON.stringify(updated));
        const write = AtomicJsonFile.writeJsonAtomically;
        context.after(() => {
            AtomicJsonFile.writeJsonAtomically = write;
        });
        let failures = 2;
        AtomicJsonFile.writeJsonAtomically = async (file, value, serializer) => {
            if (file === fixture.indexPath && failures-- > 0) {
                throw new Error('Injected index write failure');
            }
            return write.call(AtomicJsonFile, file, value, serializer);
        };
        await fixture.index.updateIndex(today, updated.total);
        assert.deepEqual(await fixture.index.getIndexFast(), (JSON.parse(previous) as DateIndex).dates);
        assert.equal(await readFile(fixture.indexPath, 'utf8'), previous);
        assert.equal((await fixture.index.getIndexFast())[today].total_requests, 2);
        assert.equal(fixture.scans(), 2);
        const saved = JSON.parse(await readFile(fixture.indexPath, 'utf8')) as DateIndex;
        assert.equal(saved.versionTimestamp, 42);
        await fixture.index.getIndexFast();
        assert.equal(fixture.scans(), 2);
    });

    await t.test('a failed date removal is retried without affecting the remaining date', async context => {
        const fixture = await createFixture(context);
        const previous = await readFile(fixture.indexPath, 'utf8');
        await rename(fixture.statsPath(yesterday), `${fixture.statsPath(yesterday)}.saved`);
        const write = AtomicJsonFile.writeJsonAtomically;
        context.after(() => {
            AtomicJsonFile.writeJsonAtomically = write;
        });
        let failNext = true;
        AtomicJsonFile.writeJsonAtomically = async (file, value, serializer) => {
            if (file === fixture.indexPath && failNext) {
                failNext = false;
                throw new Error('Injected index write failure');
            }
            return write.call(AtomicJsonFile, file, value, serializer);
        };
        await fixture.index.removeDate(yesterday);
        assert.equal(await readFile(fixture.indexPath, 'utf8'), previous);
        const recovered = await fixture.index.getIndexFast();
        assert.deepEqual(Object.keys(recovered), [today]);
        assert.equal(recovered[today].total_requests, 1);
        assert.equal(fixture.scans(), 1);
    });

    await t.test('an unreadable stats file cannot turn recovery into a partial index', async context => {
        const fixture = await createFixture(context);
        const previous = await readFile(fixture.indexPath, 'utf8');
        const updated = { ...fixture.stats, total: { ...fixture.stats.total, requests: 2 } };
        await writeFile(fixture.statsPath(today), JSON.stringify(updated));
        await writeFile(fixture.statsPath(yesterday), '{');
        const write = AtomicJsonFile.writeJsonAtomically;
        context.after(() => {
            AtomicJsonFile.writeJsonAtomically = write;
        });
        let failNext = true;
        AtomicJsonFile.writeJsonAtomically = async (file, value, serializer) => {
            if (file === fixture.indexPath && failNext) {
                failNext = false;
                throw new Error('Injected index write failure');
            }
            return write.call(AtomicJsonFile, file, value, serializer);
        };
        await fixture.index.updateIndex(today, updated.total);
        await assert.rejects(fixture.index.getIndex(), SyntaxError);
        assert.deepEqual(await fixture.index.getIndexFast(), (JSON.parse(previous) as DateIndex).dates);
        assert.equal(await readFile(fixture.indexPath, 'utf8'), previous);
        await writeFile(fixture.statsPath(yesterday), 'null');
        await assert.rejects(fixture.index.getIndex(), /Invalid date stats/);
        assert.deepEqual(await fixture.index.getIndexFast(), (JSON.parse(previous) as DateIndex).dates);
        assert.equal(await readFile(fixture.indexPath, 'utf8'), previous);
        await writeFile(fixture.statsPath(yesterday), JSON.stringify(fixture.stats));
        const recovered = await fixture.index.getIndexFast();
        assert.equal(recovered[today].total_requests, 2);
        assert.equal(recovered[yesterday].total_requests, 1);
    });

    await t.test('a failed directory scan is not mistaken for an empty index', async context => {
        const fixture = await createFixture(context);
        await writeFile(fixture.indexPath, '{');
        const getAllStatsDates = fixture.internals.getAllStatsDates;
        fixture.internals.getAllStatsDates = async () => {
            throw new Error('Injected directory scan failure');
        };
        await assert.rejects(fixture.index.getIndexFast(), /Injected directory scan failure/);
        assert.equal(await readFile(fixture.indexPath, 'utf8'), '{');
        fixture.internals.getAllStatsDates = getAllStatsDates;
        assert.equal(Object.keys(await fixture.index.getIndexFast()).length, 2);
    });

    await t.test('a truly empty storage recovers once and then uses the fast path', async context => {
        const dir = await mkdtemp(join(tmpdir(), 'gcmp-empty-index-'));
        context.after(() => rm(dir, { recursive: true, force: true }));
        const index = new LogIndexManager(dir);
        const internals = index as unknown as { getAllStatsDates(): Promise<string[]> };
        const getAllStatsDates = internals.getAllStatsDates.bind(index);
        let scans = 0;
        internals.getAllStatsDates = async () => {
            scans++;
            return getAllStatsDates();
        };
        assert.deepEqual(await index.getIndexFast(), {});
        assert.deepEqual(await index.getIndexFast(), {});
        assert.equal(scans, 1);
        assert.deepEqual(JSON.parse(await readFile(index.getIndexPath(), 'utf8')), { dates: {} });
    });
});
