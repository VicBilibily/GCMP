import { before, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert';
import { createRequire } from 'node:module';
import type { BalanceQueryResult } from '../compatible/balanceQuery';
import type { CompatibleStatusData } from '../../status/compatibleStatusBar';
import type { CompatibleProviderCacheData } from '../../status/compatibleStatusBarCache';
import type { CachedStatusData } from '../../status/baseStatusBarItem';
import { parseEventsFromBuffer, serializeEvent, type StatusUpdatedEvent } from '../../interInstance/eventProtocol';
import type { QuotaQueryResult } from '../types';
import type { ConfigSetRow, ConfigUsageState, SlotState } from '../../ui/configSetManager/types';
import type { ExtensionContext, StatusBarItem } from 'vscode';

const require = createRequire(import.meta.url);
const NodeModule = require('node:module') as {
    prototype: { require: (id: string) => unknown };
};

let compatible: typeof import('./compatible');
let statusModule: typeof import('../../status/compatibleStatusBar');
let usageModule: typeof import('../../ui/configSetManager/components/usage');
let queryResult: BalanceQueryResult;
let queryCount = 0;
let warningThreshold = 20;
let entryId = 'test_provider::default';
const broadcasts: unknown[] = [];

class MockMarkdownString {
    value = '';
    supportHtml = false;
    appendMarkdown(value: string): this {
        this.value += value;
        return this;
    }
}

before(async () => {
    const originalRequire = NodeModule.prototype.require;
    NodeModule.prototype.require = function (id: string): unknown {
        if (id === 'vscode') {
            return { StatusBarAlignment: { Right: 2 }, MarkdownString: MockMarkdownString };
        }
        if (id.endsWith('/balanceQueryManager')) {
            return {
                BalanceQueryManager: {
                    getCustomUsageDisplayName: () => undefined,
                    getBaseProviderId: (id: string) => id.split('::')[0],
                    getRegisteredProviders: () => [entryId],
                    getRegisteredProvidersForBaseProvider: () => [entryId],
                    requiresApiKey: () => false,
                    queryBalance: async () => {
                        queryCount++;
                        return queryResult;
                    }
                }
            };
        }
        if (id.endsWith('/statusLogger')) {
            return { StatusLogger: { debug() {}, info() {}, warn() {}, error() {} } };
        }
        if (id.endsWith('/l10n')) {
            return {
                t: (english: string, _chinese: string, ...args: unknown[]) =>
                    english.replace(/\{(\d+)\}/g, (_match, index: string) => String(args[Number(index)]))
            };
        }
        if (id === '../common') {
            return originalRequire.call(this, '../format');
        }
        if (id.endsWith('/compatibleModelManager')) {
            return { CompatibleModelManager: { getModels: () => [{ provider: 'test_provider' }] } };
        }
        if (id.endsWith('/knownProviders')) {
            return { InnerProviders: {}, resolveBuiltinProviderConfig: () => undefined };
        }
        if (id.endsWith('/configManager')) {
            return { ConfigManager: { getProviderBalanceWarningThreshold: () => warningThreshold } };
        }
        if (id.endsWith('/apiKeyManager') || id.endsWith('/leaderElectionService')) {
            return {};
        }
        if (id.endsWith('/interInstance')) {
            return { InterInstanceBus: { publish: (event: unknown) => broadcasts.push(event) } };
        }
        return originalRequire.call(this, id);
    };
    try {
        compatible = await import('./compatible');
        statusModule = await import('../../status/compatibleStatusBar');
        usageModule = await import('../../ui/configSetManager/components/usage');
    } finally {
        NodeModule.prototype.require = originalRequire;
    }
});

beforeEach(() => {
    entryId = 'test_provider::default';
});

describe('formatCompatibleQuotaEntries', () => {
    it('formats single balance result as single entry', () => {
        const result: BalanceQueryResult = {
            balance: 100,
            currency: 'USD',
            paid: 80,
            granted: 20
        };

        const entries = compatible.formatCompatibleQuotaEntries('test_provider', result);
        assert.equal(entries.length, 1);
        assert.equal(entries[0].summary, '$100.00');
        assert.equal(entries[0].tables?.length, 1);
        assert.deepStrictEqual(entries[0].tables?.[0].rows, [['$80.00', '$20.00', '$100.00']]);
    });

    it('expands multiple items into multiple entries', () => {
        const result: BalanceQueryResult = {
            balance: 150,
            currency: 'USD',
            items: [
                {
                    displayName: 'Token额度',
                    balance: 150000,
                    currency: 'Tokens'
                },
                {
                    displayName: '现金账户',
                    balance: 50,
                    currency: 'CNY',
                    paid: 30,
                    granted: 20
                }
            ]
        };

        const entries = compatible.formatCompatibleQuotaEntries('test_provider', result);
        assert.equal(entries.length, 2);

        assert.equal(entries[0].label, 'Token额度');
        assert.equal(entries[0].summary, '150000 Tokens');
        assert.equal(entries[0].tables, undefined);

        assert.equal(entries[1].label, '现金账户');
        assert.equal(entries[1].summary, '¥50.00');
        assert.equal(entries[1].tables?.length, 1);
        assert.deepStrictEqual(entries[1].tables?.[0].rows, [['¥30.00', '¥20.00', '¥50.00']]);
    });

    it('queries one endpoint once and returns every quota', async () => {
        queryCount = 0;
        queryResult = {
            balance: 100,
            currency: 'USD',
            items: [
                { displayName: 'A', balance: 100, currency: 'USD' },
                { displayName: 'B', balance: 30, currency: 'CNY' }
            ]
        };
        const result = await compatible.queryCompatibleProviderQuota('test_provider', 'test-key', 'updated');
        assert.equal(queryCount, 1);
        assert.equal(result.quotaEntries?.length, 2);
        assert.equal(result.lastUpdated, 'updated');
    });
});

describe('compatible multi-quota status', () => {
    function createStatus() {
        class TestStatusBar extends statusModule.CompatibleStatusBar {
            writes = new Map<string, unknown>();
            displayed: CompatibleStatusData | undefined;
            constructor() {
                super();
                this.context = {
                    globalState: {
                        get: (key: string) => this.writes.get(key),
                        update: async (key: string, value: unknown) => {
                            this.writes.set(key, value);
                        }
                    }
                } as unknown as ExtensionContext;
                this.initialized = true;
                this.statusBarItem = { show() {}, hide() {} } as StatusBarItem;
            }
            async queryAll(): Promise<CompatibleStatusData> {
                const result = await this.performApiQuery(true);
                assert.ok(result.data);
                this.lastStatusData = { data: result.data, timestamp: Date.now() };
                return result.data;
            }
            async refreshProvider(): Promise<CompatibleStatusData> {
                const refresh: (id: string) => Promise<void> = Reflect.get(this, 'performProviderUpdate');
                await refresh.call(this, 'test_provider');
                assert.ok(this.lastStatusData);
                return this.lastStatusData.data;
            }
            async queryAutomatic(): Promise<CompatibleStatusData> {
                const result = await this.performApiQuery(false);
                assert.ok(result.data);
                return result.data;
            }
            async publishFullRefresh(): Promise<void> {
                await this.executeApiQuery(true);
            }
            restoreCaches(): void {
                const load: () => void = Reflect.get(this, 'loadProviderCaches');
                load.call(this);
                const read: () => void = Reflect.get(this, 'updateFromCache');
                read.call(this);
            }
            receive(data: CompatibleStatusData, providerKey: string, timestamp = Date.now()): void {
                const event: StatusUpdatedEvent = {
                    type: 'statusUpdated',
                    payload: { providerKey, data: { data, timestamp }, source: 'api' },
                    timestamp,
                    senderInstanceId: 'fixture-peer'
                };
                const { events } = parseEventsFromBuffer(serializeEvent(event));
                assert.equal(events.length, 1);
                const handle: (event: StatusUpdatedEvent) => void = Reflect.get(this, 'handleStatusUpdatedEvent');
                handle.call(this, events[0] as StatusUpdatedEvent);
            }
            snapshot(): CachedStatusData<CompatibleStatusData> | null {
                return this.lastStatusData;
            }
            providerCache(id: string): CompatibleProviderCacheData | undefined {
                const caches: Map<string, CompatibleProviderCacheData> = Reflect.get(this, 'providerCaches');
                return caches.get(id);
            }
            alert(data: CompatibleStatusData): string {
                return (
                    this.shouldHighlightError(data) ? 'error'
                    : this.shouldHighlightWarning(data) ? 'warning'
                    : 'none'
                );
            }
            text(data: CompatibleStatusData): string {
                return this.getDisplayText(data);
            }
            tooltip(data: CompatibleStatusData): string {
                return this.generateTooltip(data).value;
            }
            protected override updateStatusBarUI(data: CompatibleStatusData): void {
                this.displayed = data;
            }
        }
        return new TestStatusBar();
    }

    function setResult(secondBalance: number, secondName = 'B'): void {
        queryResult = {
            balance: 100,
            currency: 'USD',
            items: [
                { displayName: 'A', balance: 100, currency: 'USD' },
                { displayName: secondName, balance: secondBalance, currency: 'CNY', paid: secondBalance, granted: 0 }
            ]
        };
    }

    it('preserves every item from full refresh through targeted refresh, cache and broadcast', async () => {
        const status = createStatus();
        queryCount = 0;
        broadcasts.length = 0;
        setResult(30);
        const initial = await status.queryAll();
        assert.deepStrictEqual(initial.providers[0].items, queryResult.items);
        setResult(5);
        const refreshed = await status.refreshProvider();
        assert.equal(queryCount, 2);
        assert.deepStrictEqual(refreshed.providers[0].items, queryResult.items);
        const cache = status.writes.get('compatible.v2.provider.test_provider::default') as CompatibleProviderCacheData;
        assert.deepStrictEqual(cache.balance.items, queryResult.items);
        assert.strictEqual(status.displayed, refreshed);
        assert.equal(broadcasts.length, 1);
        assert.ok(JSON.stringify(broadcasts[0]).includes('"balance":5'));
        assert.ok(status.text(refreshed).includes('¥5.00'));
        assert.ok(status.tooltip(refreshed).includes('test\\_provider / B'));
    });

    for (const [balance, threshold, expected] of [
        [-1, 0, 'error'],
        [20, 20, 'warning'],
        [21, 20, 'none']
    ] as const) {
        it(`examines second quota ${balance} with threshold ${threshold}`, async () => {
            warningThreshold = threshold;
            setResult(balance);
            const status = createStatus();
            assert.equal(status.alert(await status.queryAll()), expected);
        });
    }

    it('renders response-derived quota names as text rather than Markdown or HTML', async () => {
        setResult(30, '[click](command:test) | <b>name</b>\nnext');
        const status = createStatus();
        const tooltip = status.tooltip(await status.queryAll());
        assert.ok(tooltip.includes('\\[click\\]\\(command:test\\) \\| \\<b\\>name\\</b\\> next'));
        assert.equal(tooltip.includes('[click](command:test)'), false);
    });

    function balanceData(balance: number): CompatibleStatusData {
        return {
            providers: [
                {
                    providerId: entryId,
                    providerName: 'fixture',
                    balance,
                    currency: 'CNY',
                    lastUpdated: new Date(),
                    success: true,
                    items: [{ balance, currency: 'CNY' }]
                }
            ],
            successCount: 1,
            totalCount: 1
        };
    }

    for (const id of ['test_provider::default', 'review%3A%3Ateam::default']) {
        it(`ignores legacy provider cache ${id} and queries the current balance`, async () => {
            entryId = id;
            const status = createStatus();
            const legacy = { balance: balanceData(101).providers[0], timestamp: Date.now() };
            status.writes.set(`compatible.provider.${id}`, legacy);
            status.restoreCaches();
            queryCount = 0;
            queryResult = { balance: 401, currency: 'CNY' };
            const current = await status.queryAutomatic();
            assert.equal(current.providers[0].balance, 401);
            assert.equal(queryCount, 1);
            assert.strictEqual(status.writes.get(`compatible.provider.${id}`), legacy);
            assert.ok(status.writes.has(`compatible.v2.provider.${id}`));
        });

        it(`does not display a legacy full-status cache for ${id}`, () => {
            entryId = id;
            const status = createStatus();
            const legacy = { data: balanceData(101), timestamp: Date.now() };
            status.writes.set('compatible.statusData', legacy);
            status.restoreCaches();
            assert.equal(status.snapshot(), null);
            assert.equal(status.displayed, undefined);
            assert.strictEqual(status.writes.get('compatible.statusData'), legacy);
        });

        it(`rejects legacy NDJSON updates for ${id} before changing UI or any cache`, () => {
            entryId = id;
            const status = createStatus();
            status.receive(balanceData(101), 'compatible');
            assert.equal(status.snapshot(), null);
            assert.equal(status.displayed, undefined);
            assert.equal(status.providerCache(id), undefined);
            assert.equal(status.writes.size, 0);
        });
    }

    it('loads both current caches and reuses the provider balance without another query', async () => {
        entryId = 'review%3A%3Ateam::default';
        const status = createStatus();
        const data = balanceData(401);
        status.writes.set(`compatible.v2.provider.${entryId}`, { balance: data.providers[0], timestamp: Date.now() });
        status.writes.set('compatible.v2.statusData', { data, timestamp: Date.now() });
        status.restoreCaches();
        assert.strictEqual(status.displayed, data);
        queryCount = 0;
        assert.equal((await status.queryAutomatic()).providers[0].balance, 401);
        assert.equal(queryCount, 0);
    });

    it('accepts current NDJSON updates and ignores newer legacy messages', () => {
        entryId = 'review%3A%3Ateam::default';
        const status = createStatus();
        const timestamp = Date.now();
        status.receive(balanceData(401), 'compatible.v2', timestamp);
        assert.equal(status.snapshot()?.data.providers[0].balance, 401);
        assert.equal(status.displayed?.providers[0].balance, 401);
        assert.equal(status.providerCache(entryId)?.balance.balance, 401);
        assert.ok(status.writes.has('compatible.v2.statusData'));
        assert.ok(status.writes.has(`compatible.v2.provider.${entryId}`));
        status.receive(balanceData(101), 'compatible', timestamp + 1_000);
        assert.equal(status.snapshot()?.data.providers[0].balance, 401);
        assert.equal(status.displayed?.providers[0].balance, 401);
        assert.equal(status.providerCache(entryId)?.balance.balance, 401);
        assert.equal(status.writes.has('compatible.statusData'), false);
    });

    it('publishes full and targeted refreshes only in the current namespace', async () => {
        const status = createStatus();
        broadcasts.length = 0;
        queryResult = { balance: 401, currency: 'CNY' };
        await status.publishFullRefresh();
        await status.refreshProvider();
        assert.equal(broadcasts.length, 2);
        for (const broadcast of broadcasts) {
            const event = broadcast as Pick<StatusUpdatedEvent, 'type' | 'payload'>;
            assert.equal(event.payload.providerKey, 'compatible.v2');
        }
        assert.ok(status.writes.has('compatible.v2.statusData'));
        assert.ok(status.writes.has(`compatible.v2.provider.${entryId}`));
        assert.equal(status.writes.has('compatible.statusData'), false);
    });
});

describe('compatible quota panel rendering', () => {
    class TestElement {
        className = '';
        children: TestElement[] = [];
        private text = '';
        constructor(readonly tagName: string) {}
        set textContent(value: string) {
            this.text = value;
        }
        get textContent(): string {
            return this.text + this.children.map(child => child.textContent).join('');
        }
        appendChild(child: TestElement): TestElement {
            this.children.push(child);
            return child;
        }
        addEventListener(): void {}
    }

    function renderQuota(result: QuotaQueryResult): TestElement {
        const originalDocument = Object.getOwnPropertyDescriptor(globalThis, 'document');
        Object.defineProperty(globalThis, 'document', {
            configurable: true,
            value: {
                documentElement: { lang: 'zh-cn' },
                createElement: (tagName: string) => new TestElement(tagName)
            }
        });
        const row: ConfigSetRow = { id: 'test-config', label: '默认配置', isActive: true };
        const slot: SlotState = {
            slot: 'test_provider',
            displayName: 'Test',
            isMain: true,
            hasSite: false,
            switchMode: 'off',
            hasUsage: true,
            usageMetricType: 'balance',
            rows: [row]
        };
        const usageState: ConfigUsageState = {
            slot: slot.slot,
            id: row.id,
            supported: true,
            loading: false,
            metricType: result.metricType,
            summary: result.summary,
            tables: result.tables,
            usageEntries: result.quotaEntries,
            lastUpdated: result.lastUpdated
        };
        try {
            return usageModule.renderConfigUsage(slot, row, usageState) as unknown as TestElement;
        } finally {
            if (originalDocument) {
                Object.defineProperty(globalThis, 'document', originalDocument);
            } else {
                Reflect.deleteProperty(globalThis, 'document');
            }
        }
    }

    function findElements(element: TestElement, className: string): TestElement[] {
        return [
            ...(element.className.split(' ').includes(className) ? [element] : []),
            ...element.children.flatMap(child => findElements(child, className))
        ];
    }

    it('shows the label and balance for a single named quota without a table', async () => {
        queryResult = {
            balance: 10,
            currency: 'USD',
            items: [{ displayName: '套餐 A', balance: 10, currency: 'USD' }]
        };
        const result = await compatible.queryCompatibleProviderQuota('test_provider', 'test-key', 'updated');
        const panel = renderQuota(result);
        assert.deepStrictEqual(
            findElements(panel, 'csm-slot-usage-entry-label').map(element => element.textContent),
            ['套餐 A']
        );
        assert.deepStrictEqual(
            findElements(panel, 'csm-slot-usage-entry-summary').map(element => element.textContent),
            ['$10.00']
        );
        assert.equal(findElements(panel, 'csm-slot-usage-table').length, 0);
    });

    it('keeps the name and balance above the details for a single named quota', async () => {
        queryResult = {
            balance: 50,
            currency: 'CNY',
            items: [{ displayName: '现金钱包', balance: 50, currency: 'CNY', paid: 30, granted: 20 }]
        };
        const panel = renderQuota(
            await compatible.queryCompatibleProviderQuota('test_provider', 'test-key', 'updated')
        );
        assert.deepStrictEqual(
            findElements(panel, 'csm-slot-usage-entry-label').map(element => element.textContent),
            ['现金钱包']
        );
        assert.deepStrictEqual(
            findElements(panel, 'csm-slot-usage-entry-summary').map(element => element.textContent),
            ['¥50.00']
        );
        assert.equal(findElements(panel, 'csm-slot-usage-table').length, 1);
        assert.ok(panel.textContent.includes('¥30.00'));
        assert.ok(panel.textContent.includes('¥20.00'));
    });

    it('preserves compact rendering for a single unnamed legacy balance', async () => {
        queryResult = { balance: 100, currency: 'USD' };
        const panel = renderQuota(
            await compatible.queryCompatibleProviderQuota('test_provider', 'test-key', 'updated')
        );
        assert.deepStrictEqual(
            findElements(panel, 'csm-slot-usage-summary').map(element => element.textContent),
            ['$100.00']
        );
        assert.equal(findElements(panel, 'csm-slot-usage-entry-head').length, 0);
    });

    for (const withItems of [false, true]) {
        it(`renders a single unnamed ${withItems ? 'item' : 'legacy balance'} detail table only once`, async () => {
            const item = { balance: 50, currency: 'USD', paid: 30, granted: 20 };
            queryResult = { ...item, items: withItems ? [item] : undefined };
            const result = await compatible.queryCompatibleProviderQuota('test_provider', 'test-key', 'updated');
            assert.equal(result.tables?.length, 1);
            assert.equal(result.quotaEntries?.length, 1);
            assert.equal(result.quotaEntries?.[0]?.label, undefined);
            assert.equal(result.quotaEntries?.[0]?.tables?.length, 1);

            const panel = renderQuota(result);
            assert.equal(findElements(panel, 'csm-slot-usage-table').length, 1);
            assert.deepStrictEqual(
                findElements(panel, 'csm-slot-usage-summary').map(element => element.textContent),
                ['$50.00']
            );
            assert.equal(findElements(panel, 'csm-slot-usage-entry-head').length, 0);
            assert.ok(panel.textContent.includes('$30.00'));
            assert.ok(panel.textContent.includes('$20.00'));
        });
    }

    for (const tables of [undefined, []]) {
        it(`keeps unnamed entry details when top-level tables are ${tables === undefined ? 'absent' : 'empty'}`, async () => {
            queryResult = { balance: 50, currency: 'USD', paid: 30, granted: 20 };
            const result = await compatible.queryCompatibleProviderQuota('test_provider', 'test-key', 'updated');
            const panel = renderQuota({ ...result, tables });
            assert.equal(findElements(panel, 'csm-slot-usage-table').length, 1);
            assert.equal(findElements(panel, 'csm-slot-usage-entry-head').length, 0);
            assert.ok(panel.textContent.includes('$50.00'));
            assert.ok(panel.textContent.includes('$30.00'));
            assert.ok(panel.textContent.includes('$20.00'));
        });
    }

    it('still renders every quota and its own unit for multiple items', async () => {
        queryResult = {
            balance: 10,
            currency: 'USD',
            items: [
                { displayName: '钱包', balance: 10, currency: 'USD', paid: 7, granted: 3 },
                { displayName: '套餐', balance: 20, currency: 'Tokens', paid: 12, granted: 8 }
            ]
        };
        const panel = renderQuota(
            await compatible.queryCompatibleProviderQuota('test_provider', 'test-key', 'updated')
        );
        assert.deepStrictEqual(
            findElements(panel, 'csm-slot-usage-entry-label').map(element => element.textContent),
            ['钱包', '套餐']
        );
        assert.deepStrictEqual(
            findElements(panel, 'csm-slot-usage-entry-summary').map(element => element.textContent),
            ['$10.00', '20 Tokens']
        );
        assert.equal(findElements(panel, 'csm-slot-usage-table').length, 2);
    });

    it('renders a single response-derived name as literal text', async () => {
        const displayName = '<b>额度</b> | [名称]';
        queryResult = { balance: 10, currency: 'USD', items: [{ displayName, balance: 10, currency: 'USD' }] };
        const panel = renderQuota(
            await compatible.queryCompatibleProviderQuota('test_provider', 'test-key', 'updated')
        );
        assert.deepStrictEqual(
            findElements(panel, 'csm-slot-usage-entry-label').map(element => element.textContent),
            [displayName]
        );
    });
});
