import assert from 'node:assert/strict';
import * as vscode from 'vscode';

import { ApiKeyManager } from '../../src/utils/config/apiKeyManager';
import { InterInstanceBus, type StatusUpdatedEvent } from '../../src/interInstance';
import type { QuotaStatusAdapter } from '../../src/quota/statusAdapters/types';
import {
    BaseStatusBarItem,
    type BaseStatusBarItemConfig,
    type CachedStatusData
} from '../../src/status/baseStatusBarItem';
import type { MultiKeyStatusData } from '../../src/status/multiKeyQuotaTracker';
import { ProviderQuotaStatusBar } from '../../src/status/providerQuotaStatusBar';
import { ConfigSetStore, type ConfigSetItem, type ConfigSetSwitchMode } from '../../src/utils/config/configSetStore';

const slot = 'quota-status-test';
const multiCacheKey = `${slot}.multiKeyStatusData`;

interface UsageData {
    source: string;
    usage: number;
    balance: number;
}

const dataA: UsageData = { source: 'a', usage: 90, balance: -1 };
const dataB: UsageData = { source: 'b', usage: 10, balance: 100 };
const dataC: UsageData = { source: 'c', usage: 20, balance: 100 };

function deferred() {
    let resolve!: () => void;
    const promise = new Promise<void>(done => {
        resolve = done;
    });
    return { promise, resolve };
}

class TestStatusBar extends ProviderQuotaStatusBar<UsageData> {
    attach(context: vscode.ExtensionContext, item: vscode.StatusBarItem): void {
        this.context = context;
        this.statusBarItem = item;
        this.initialized = true;
    }

    run(manual = true): Promise<void> {
        return this.executeApiQuery(manual);
    }

    invalidate(): void {
        this.onApiKeyChangeDetected();
    }

    seed(data: UsageData): void {
        this.lastStatusData = { data, timestamp: Date.now() };
        this.updateStatusBarUI(data);
    }

    get cached(): CachedStatusData<UsageData> | null {
        return this.lastStatusData;
    }

    get loading(): boolean {
        return this.isLoading;
    }

    get multi(): MultiKeyStatusData<UsageData> | undefined {
        return Reflect.get(this, 'multiKeyStatus') as MultiKeyStatusData<UsageData> | undefined;
    }

    get pendingCollection(): Promise<void> | undefined {
        return Reflect.get(this, 'multiKeyCollecting') as Promise<void> | undefined;
    }

    receive(data: UsageData): void {
        const handler: (event: StatusUpdatedEvent) => void = Reflect.get(this, 'handleStatusUpdatedEvent');
        handler.call(this, {
            type: 'statusUpdated',
            timestamp: Date.now(),
            senderInstanceId: 'test-leader',
            payload: { providerKey: slot, data: { data, timestamp: Date.now() }, source: 'api' }
        });
    }

    poll(): void {
        const handler: unknown = Reflect.get(this, 'onCachePolled');
        if (typeof handler === 'function') {
            handler.call(this);
        }
    }

    collect(): Promise<void> {
        const handler: (slot: string) => Promise<void> = Reflect.get(this, 'collectMultiKey');
        return handler.call(this, slot);
    }
}

class BaseStatusBarProbe extends BaseStatusBarItem<UsageData> {
    private readonly query: () => Promise<UsageData>;

    constructor(query: () => Promise<UsageData>) {
        const config: BaseStatusBarItemConfig = {
            id: 'quota-base-status-test',
            name: 'Quota base status test',
            alignment: vscode.StatusBarAlignment.Right,
            priority: 1,
            refreshCommand: 'gcmp.quotaBaseStatusTest.refresh',
            cacheKeyPrefix: 'quota-base-status-test',
            logPrefix: 'quota-base-status-test',
            icon: '$(info)'
        };
        super(config);
        this.query = query;
    }

    attach(context: vscode.ExtensionContext, item: vscode.StatusBarItem): void {
        this.context = context;
        this.statusBarItem = item;
        this.initialized = true;
    }

    run(manual = true): Promise<void> {
        return this.executeApiQuery(manual);
    }

    invalidate(): void {
        this.onApiKeyChangeDetected();
    }

    seed(data: UsageData): void {
        this.lastStatusData = { data, timestamp: Date.now() };
        this.updateStatusBarUI(data);
    }

    get cached(): CachedStatusData<UsageData> | null {
        return this.lastStatusData;
    }

    protected getDisplayText(data: UsageData): string {
        return `${this.config.icon} ${data.usage}%`;
    }

    protected generateTooltip(data: UsageData): vscode.MarkdownString {
        return new vscode.MarkdownString(`${data.usage}%`);
    }

    protected async performApiQuery(): Promise<{ success: boolean; data?: UsageData }> {
        return { success: true, data: await this.query() };
    }

    protected shouldHighlightWarning(): boolean {
        return false;
    }

    protected async shouldShowStatusBar(): Promise<boolean> {
        return true;
    }
}

suite('multi-key quota status bar', () => {
    let runtimeKey: string | undefined;
    let activeId: string;
    let mode: ConfigSetSwitchMode;
    let items: ConfigSetItem[];
    let keys: Map<string, string>;
    let now: number;
    let query: (apiKey: string) => Promise<UsageData>;
    let calls: string[];
    let writes: Map<string, unknown>;
    let storedMulti: ReturnType<typeof deferred>;
    let published: Array<Parameters<typeof InterInstanceBus.publish>[0]>;
    let bar: TestStatusBar;
    let item: vscode.StatusBarItem;
    let context: vscode.ExtensionContext;
    let restore: () => void;

    function tooltip(): string {
        assert.ok(item.tooltip instanceof vscode.MarkdownString);
        return item.tooltip.value;
    }

    function snapshot(usageA = 90, usageB = 10): MultiKeyStatusData<UsageData> {
        return {
            timestamp: now,
            entries: [
                {
                    configId: 'a',
                    label: 'A',
                    isActive: activeId === 'a',
                    keyHash: 'a',
                    status: 'success',
                    data: { ...dataA, usage: usageA },
                    timestamp: now
                },
                {
                    configId: 'b',
                    label: 'B',
                    isActive: activeId === 'b',
                    keyHash: 'b',
                    status: 'success',
                    data: { ...dataB, usage: usageB },
                    timestamp: now
                }
            ]
        };
    }

    async function activate(id: string): Promise<void> {
        activeId = id;
        runtimeKey = keys.get(id);
        bar.invalidate();
        await bar.run(false);
    }

    async function waitForQuery(started: ReturnType<typeof deferred>, work: Promise<void>): Promise<void> {
        await Promise.race([
            started.promise,
            work.then(() => {
                throw new Error('Query completed before reaching the expected boundary.');
            })
        ]);
    }

    setup(() => {
        const original = {
            getApiKey: ApiKeyManager.getApiKey,
            hasValidApiKey: ApiKeyManager.hasValidApiKey,
            list: ConfigSetStore.list,
            active: ConfigSetStore.getActiveId,
            savedKey: ConfigSetStore.getApiKey,
            mode: ConfigSetStore.getSwitchMode,
            publish: InterInstanceBus.publish,
            now: Date.now
        };
        runtimeKey = 'fake-a';
        activeId = 'a';
        mode = 'balance';
        items = [
            { id: 'a', label: 'A' },
            { id: 'b', label: 'B' }
        ];
        keys = new Map([
            ['a', 'fake-a'],
            ['b', 'fake-b'],
            ['c', 'fake-c']
        ]);
        now = original.now();
        calls = [];
        writes = new Map();
        storedMulti = deferred();
        published = [];
        query = async apiKey =>
            apiKey === 'fake-a' ? dataA
            : apiKey === 'fake-b' ? dataB
            : dataC;

        ApiKeyManager.getApiKey = async provider =>
            provider === slot ? runtimeKey : original.getApiKey.call(ApiKeyManager, provider);
        ApiKeyManager.hasValidApiKey = async provider =>
            provider === slot ? !!runtimeKey : original.hasValidApiKey.call(ApiKeyManager, provider);
        ConfigSetStore.list = provider => (provider === slot ? items : original.list.call(ConfigSetStore, provider));
        ConfigSetStore.getActiveId = provider =>
            provider === slot ? activeId : original.active.call(ConfigSetStore, provider);
        ConfigSetStore.getApiKey = async (provider, id) =>
            provider === slot ? keys.get(id) : original.savedKey.call(ConfigSetStore, provider, id);
        ConfigSetStore.getSwitchMode = provider =>
            provider === slot ? mode : original.mode.call(ConfigSetStore, provider);
        InterInstanceBus.publish = event => {
            published.push(event);
        };
        Date.now = () => now;
        restore = () => {
            ApiKeyManager.getApiKey = original.getApiKey;
            ApiKeyManager.hasValidApiKey = original.hasValidApiKey;
            ConfigSetStore.list = original.list;
            ConfigSetStore.getActiveId = original.active;
            ConfigSetStore.getApiKey = original.savedKey;
            ConfigSetStore.getSwitchMode = original.mode;
            InterInstanceBus.publish = original.publish;
            Date.now = original.now;
        };

        const globalState: vscode.Memento = {
            get<T>(key: string, defaultValue?: T): T {
                return (writes.has(key) ? writes.get(key) : defaultValue) as T;
            },
            keys: () => Array.from(writes.keys()),
            async update(key: string, value: unknown): Promise<void> {
                if (value === undefined) {
                    writes.delete(key);
                } else {
                    writes.set(key, value);
                }
                if (key === multiCacheKey && value !== undefined) {
                    storedMulti.resolve();
                }
            }
        };
        context = { globalState, subscriptions: [] } as unknown as vscode.ExtensionContext;
        const adapter: QuotaStatusAdapter<UsageData> = {
            async query(apiKey) {
                calls.push(apiKey);
                return query(apiKey);
            },
            summary: data => `${data.usage}%`,
            tables: () => [],
            balance: data => data.balance,
            highlightWarning: (data, threshold) => data.usage >= threshold
        };
        bar = new TestStatusBar({
            config: {
                id: slot,
                name: 'Quota status test',
                alignment: vscode.StatusBarAlignment.Right,
                priority: 1,
                refreshCommand: 'gcmp.quotaStatusTest.refresh',
                cacheKeyPrefix: slot,
                logPrefix: slot,
                apiKeyProvider: slot,
                icon: '$(info)'
            },
            adapter,
            title: () => 'Quota status test'
        });
        item = vscode.window.createStatusBarItem(slot, vscode.StatusBarAlignment.Right, 1);
        bar.attach(context, item);
    });

    teardown(() => {
        bar.dispose();
        restore();
    });

    test('stable refresh reuses active query and renders a compact two-key table', async () => {
        await bar.run();
        assert.equal(bar.cached?.data.source, 'a');
        assert.equal(item.backgroundColor?.id, 'statusBarItem.errorBackground');
        assert.match(tooltip(), /\| \*\*A\*\* \| \*\*90%\*\* \|\n\| B \| 10% \|/);
        assert.deepEqual(calls, ['fake-a', 'fake-b']);
    });

    test('inactive negative balance and high usage do not highlight a healthy active key', async () => {
        activeId = 'b';
        runtimeKey = 'fake-b';
        await bar.run();
        assert.equal(bar.cached?.data.source, 'b');
        assert.equal(item.backgroundColor, undefined);
    });

    test('off mode queries only the active key', async () => {
        mode = 'off';
        await bar.run();
        assert.deepEqual(calls, ['fake-a']);
        assert.doesNotMatch(tooltip(), /\| Name \| Usage \|/);
    });

    test('base key invalidation does not skip a fresh cached result', async () => {
        let queryCount = 0;
        const probe = new BaseStatusBarProbe(async () => {
            queryCount++;
            return dataB;
        });
        const probeItem = vscode.window.createStatusBarItem(
            'quota-base-status-test',
            vscode.StatusBarAlignment.Right,
            1
        );
        probe.attach(context, probeItem);
        probe.seed(dataA);
        probe.invalidate();
        await probe.run(false);
        assert.equal(queryCount, 1);
        assert.equal(probe.cached?.data.source, 'b');
        probe.dispose();
        probeItem.dispose();
    });

    test('continuous key rotation has a bounded automatic retry chain', async () => {
        mode = 'off';
        const rotatingKeys = ['fake-b', 'fake-c', 'fake-a', 'fake-b', 'fake-c', 'fake-a', 'fake-b', 'fake-c'];
        let attempts = 0;
        query = async apiKey => {
            if (attempts < rotatingKeys.length) {
                const nextKey = rotatingKeys[attempts];
                attempts++;
                runtimeKey = nextKey;
                activeId =
                    nextKey === 'fake-a' ? 'a'
                    : nextKey === 'fake-b' ? 'b'
                    : 'c';
                bar.invalidate();
            } else {
                attempts++;
            }
            return (
                apiKey === 'fake-a' ? dataA
                : apiKey === 'fake-b' ? dataB
                : dataC
            );
        };
        await bar.run();
        assert.ok(attempts <= 4, `automatic retry chain exceeded its bound: ${attempts}`);
    });

    test('switch during the primary query refreshes the newly active key', async () => {
        const started = deferred();
        const release = deferred();
        let held = false;
        query = async apiKey => {
            if (apiKey === 'fake-a' && !held) {
                held = true;
                started.resolve();
                await release.promise;
            }
            return apiKey === 'fake-a' ? dataA : dataB;
        };
        const work = bar.run();
        await waitForQuery(started, work);
        await activate('b');
        release.resolve();
        await work;
        assert.equal(bar.cached?.data.source, 'b');
        assert.equal(item.backgroundColor, undefined);
    });

    test('switch during secondary collection never commits or broadcasts the old active data', async () => {
        const started = deferred();
        const release = deferred();
        query = async apiKey => {
            if (apiKey === 'fake-b') {
                started.resolve();
                await release.promise;
            }
            return apiKey === 'fake-a' ? dataA : dataB;
        };
        const work = bar.run();
        await waitForQuery(started, work);
        await activate('b');
        release.resolve();
        await work;
        assert.equal(bar.cached?.data.source, 'b');
        assert.equal(item.backgroundColor, undefined);
        assert.equal(bar.multi?.entries.find(entry => entry.isActive)?.configId, 'b');
        assert.equal(published.length, 1);
        assert.equal((published[0].payload as { data: CachedStatusData<UsageData> }).data.data.source, 'b');
    });

    test('consecutive switches do not reuse B results for C', async () => {
        const startedA = deferred();
        const releaseA = deferred();
        const startedB = deferred();
        const releaseB = deferred();
        items.push({ id: 'c', label: 'C' });
        query = async apiKey => {
            if (apiKey === 'fake-a') {
                startedA.resolve();
                await releaseA.promise;
                return dataA;
            }
            if (apiKey === 'fake-b') {
                startedB.resolve();
                await releaseB.promise;
                return dataB;
            }
            return dataC;
        };
        const work = bar.run();
        await waitForQuery(startedA, work);
        await activate('b');
        releaseA.resolve();
        await waitForQuery(startedB, work);
        await activate('c');
        releaseB.resolve();
        await work;
        assert.equal(bar.cached?.data.source, 'c');
        assert.equal(bar.multi?.entries.find(entry => entry.configId === 'c')?.data?.source, 'c');
    });

    test('removing the runtime key during a query prevents stale cache writes', async () => {
        const started = deferred();
        const release = deferred();
        query = async () => {
            started.resolve();
            await release.promise;
            return dataA;
        };
        const work = bar.run();
        await waitForQuery(started, work);
        runtimeKey = undefined;
        bar.invalidate();
        await bar.run(false);
        release.resolve();
        await work;
        assert.equal(bar.cached, null);
        assert.equal(writes.has(`${slot}.statusData`), false);
        assert.equal(published.length, 0);
    });

    test('identity validation catches consecutive switches even before their events arrive', async () => {
        items.push({ id: 'c', label: 'C' });
        let rotations = 0;
        query = async apiKey => {
            if (apiKey === 'fake-a' && rotations === 0) {
                rotations++;
                activeId = 'b';
                runtimeKey = 'fake-b';
            } else if (apiKey === 'fake-b' && rotations === 1) {
                rotations++;
                activeId = 'c';
                runtimeKey = 'fake-c';
            }
            return (
                apiKey === 'fake-a' ? dataA
                : apiKey === 'fake-b' ? dataB
                : dataC
            );
        };
        await bar.run();
        assert.equal(bar.cached?.data.source, 'c');
        assert.equal(bar.multi?.entries.find(entry => entry.configId === 'c')?.data?.source, 'c');
        assert.equal(published.length, 1);
    });

    test('first cache read uses a valid multi-key snapshot without extra requests', () => {
        writes.set(multiCacheKey, snapshot(80, 70));
        bar.seed({ ...dataA, usage: 80 });
        assert.match(tooltip(), /\| B \| 70% \|/);
        assert.equal(calls.length, 0);
    });

    test('follower status events pick up newer multi-key cache instead of expired memory', () => {
        writes.set(multiCacheKey, snapshot(80, 70));
        bar.seed({ ...dataA, usage: 80 });
        now += 11 * 60 * 1000;
        writes.set(multiCacheKey, snapshot(60, 20));
        bar.receive({ ...dataA, usage: 60 });
        assert.match(item.text, /60%/);
        assert.match(tooltip(), /\| \*\*A\*\* \| \*\*60%\*\* \|\n\| B \| 20% \|/);
        assert.equal(calls.length, 0);
    });

    test('config label changes invalidate the cached multi-key rows', async () => {
        writes.set(multiCacheKey, snapshot(80, 70));
        bar.seed({ ...dataA, usage: 80 });
        assert.match(tooltip(), /\| B \| 70% \|/);
        items = [
            { id: 'a', label: 'A' },
            { id: 'b', label: 'Renamed' }
        ];
        bar.seed({ ...dataA, usage: 80 });
        await bar.pendingCollection;
        bar.seed({ ...dataA, usage: 80 });
        assert.match(tooltip(), /\| Renamed \| 10% \|/);
        assert.doesNotMatch(tooltip(), /\| B \| 70% \|/);
    });

    test('cache polling redraws a snapshot delivered after the primary status event', () => {
        writes.set(multiCacheKey, snapshot(80, 70));
        bar.seed({ ...dataA, usage: 80 });
        now += 1000;
        bar.receive({ ...dataA, usage: 60 });
        writes.set(multiCacheKey, snapshot(60, 20));
        bar.poll();
        assert.match(tooltip(), /\| B \| 20% \|/);
        assert.equal(calls.length, 0);
    });

    test('expired in-memory and persisted snapshots are discarded and recollected', async () => {
        writes.set(multiCacheKey, snapshot(80, 70));
        bar.seed({ ...dataA, usage: 80 });
        now += 11 * 60 * 1000;
        bar.seed(dataA);
        assert.equal(bar.multi, undefined);
        await storedMulti.promise;
        await bar.pendingCollection;
        await bar.run(false);
        assert.match(tooltip(), /\| B \| 10% \|/);
    });

    test('lazy collection redraws the assigned tooltip despite the fresh primary cache', async () => {
        bar.seed(dataA);
        await storedMulti.promise;
        await bar.pendingCollection;
        await bar.run(false);
        assert.equal(bar.multi?.entries.length, 2);
        assert.match(tooltip(), /\| B \| 10% \|/);
    });

    test('invalidated collection cannot resurrect multi-key cache', async () => {
        const started = deferred();
        const release = deferred();
        query = async apiKey => {
            if (apiKey === 'fake-b') {
                started.resolve();
                await release.promise;
            }
            return apiKey === 'fake-a' ? dataA : dataB;
        };
        const work = bar.collect();
        await waitForQuery(started, work);
        activeId = 'b';
        runtimeKey = 'fake-b';
        bar.invalidate();
        release.resolve();
        await work;
        assert.equal(bar.multi, undefined);
        assert.equal(writes.has(multiCacheKey), false);
    });

    test('late lazy collection does not replace a displayed manual-refresh error', async () => {
        const started = deferred();
        const release = deferred();
        query = async apiKey => {
            if (apiKey === 'fake-b') {
                started.resolve();
                await release.promise;
            }
            return apiKey === 'fake-a' ? dataA : dataB;
        };
        bar.seed(dataA);
        const lazyWork = bar.pendingCollection;
        assert.ok(lazyWork);
        await waitForQuery(started, lazyWork);
        query = async () => {
            throw new Error('manual query failed');
        };
        await bar.run();
        const errorTooltip = item.tooltip;
        assert.match(item.text, /ERR/);
        release.resolve();
        await lazyWork;
        assert.match(item.text, /ERR/);
        assert.equal(item.tooltip, errorTooltip);
    });

    test('older collection cannot overwrite a more recent completed collection', async () => {
        const started = deferred();
        const release = deferred();
        let held = false;
        query = async apiKey => {
            if (apiKey === 'fake-b' && !held) {
                held = true;
                started.resolve();
                await release.promise;
                return { ...dataB, usage: 99 };
            }
            return apiKey === 'fake-a' ? dataA : dataB;
        };
        const oldWork = bar.collect();
        await waitForQuery(started, oldWork);
        await bar.collect();
        release.resolve();
        await oldWork;
        assert.equal(bar.multi?.entries.find(entry => entry.configId === 'b')?.data?.usage, 10);
        assert.equal((writes.get(multiCacheKey) as MultiKeyStatusData<UsageData>).entries[1].data?.usage, 10);
    });

    test('disposed collection cannot repopulate cleared memory or persistence', async () => {
        const started = deferred();
        const release = deferred();
        query = async apiKey => {
            if (apiKey === 'fake-b') {
                started.resolve();
                await release.promise;
            }
            return apiKey === 'fake-a' ? dataA : dataB;
        };
        const work = bar.collect();
        await waitForQuery(started, work);
        bar.dispose();
        release.resolve();
        await work;
        assert.equal(bar.multi, undefined);
        assert.equal(writes.has(multiCacheKey), false);
    });

    test('old query cannot unlock a reinitialized status bar using the same context', async () => {
        const startedA = deferred();
        const releaseA = deferred();
        const startedB = deferred();
        const releaseB = deferred();
        mode = 'off';
        query = async apiKey => {
            if (apiKey === 'fake-a') {
                startedA.resolve();
                await releaseA.promise;
                return dataA;
            }
            startedB.resolve();
            await releaseB.promise;
            return dataB;
        };
        const oldWork = bar.run();
        await waitForQuery(startedA, oldWork);
        bar.dispose();
        activeId = 'b';
        runtimeKey = 'fake-b';
        item = vscode.window.createStatusBarItem(`${slot}-new`, vscode.StatusBarAlignment.Right, 1);
        bar.attach(context, item);
        const newWork = bar.run();
        await waitForQuery(startedB, newWork);
        releaseA.resolve();
        await oldWork;
        try {
            assert.equal(bar.loading, true);
            assert.deepEqual(bar.cached, null);
            assert.equal(published.length, 0);
        } finally {
            releaseB.resolve();
            await newWork;
        }
        assert.deepEqual(bar.cached, { data: dataB, timestamp: now });
    });
});
