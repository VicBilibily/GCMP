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
import { ChatGPTStatusBar, type ChatGPTStatusData } from '../../src/status/chatgptStatusBar';
import { GrokStatusBar, type GrokStatusData } from '../../src/status/grokStatusBar';
import { CliAuthFactory } from '../../src/cli/auth/cliAuthFactory';
import type { CodexCliAuth } from '../../src/cli/auth/codexCliAuth';
import { ConfigManager } from '../../src/utils/config/configManager';
import { ConfigSetStore, type ConfigSetItem, type ConfigSetSwitchMode } from '../../src/utils/config/configSetStore';
import { cacheRequestBalance, getCachedRequestBalance, hashRequestApiKey } from '../../src/quota/requestBalance';
import {
    clinepassStatusAdapter,
    commandcodeStatusAdapter,
    deepseekStatusAdapter,
    moonshotStatusAdapter,
    minimaxStatusAdapter,
    kimiStatusAdapter,
    opencodeStatusAdapter,
    zhipuStatusAdapter
} from '../../src/quota/statusAdapters';
import * as quotaStatusBarRegistry from '../../src/status/quotaStatusBarRegistry';
import type { RequestStatusData } from '../../src/usages/fileLogger/types';
const {
    createClinePassStatusBar,
    createCommandCodeStatusBar,
    createDeepSeekStatusBar,
    createMoonshotStatusBar,
    createMiniMaxStatusBar,
    createKimiStatusBar,
    createOpenCodeStatusBar,
    createZhipuStatusBar
} = quotaStatusBarRegistry;

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

    receive(data: UsageData, requestBalanceKeyHash?: string, timestamp = Date.now()): void {
        const handler: (event: StatusUpdatedEvent) => void = Reflect.get(this, 'handleStatusUpdatedEvent');
        handler.call(this, {
            type: 'statusUpdated',
            timestamp: Date.now(),
            senderInstanceId: 'test-leader',
            payload: { providerKey: slot, data: { data, timestamp, requestBalanceKeyHash }, source: 'api' }
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
    for (const [name, createBar] of Object.entries(quotaStatusBarRegistry)) {
        test(`${name} exposes raw request status data`, () => {
            const nativeBar = createBar();
            try {
                const adapter: Pick<QuotaStatusAdapter<unknown>, 'requestStatus'> = Reflect.get(nativeBar, 'adapter');
                assert.equal(typeof adapter.requestStatus, 'function', `${name} is missing requestStatus`);
            } finally {
                nativeBar.dispose();
            }
        });
    }

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

    function statusReplay<TRaw>(
        label: string,
        provider: RequestStatusData['provider'],
        adapter: QuotaStatusAdapter<TRaw>,
        createBar: () => ProviderQuotaStatusBar<TRaw>,
        createData: () => TRaw
    ): void {
        for (const source of ['query', 'event', 'cache'] as const) {
            test(`${label} raw status replays text and tooltip data offline after ${source}`, async () => {
                mode = 'off';
                const requestKey = `raw-${label}-${source}`;
                runtimeKey = requestKey;
                const nativeBar = createBar();
                const data = createData();
                const display: (data: TRaw) => string = Reflect.get(nativeBar, 'getDisplayText');
                const expectedText = display.call(nativeBar, data);
                const expectedTables = adapter.tables(data);
                const expectedDetails = adapter.details?.(data);
                const originalQuery = adapter.query;
                const originalNow = Date.now;
                const originalGetApiKey = ApiKeyManager.getApiKey;
                const originalHasValidApiKey = ApiKeyManager.hasValidApiKey;
                const originalGetSwitchMode = ConfigSetStore.getSwitchMode;
                ApiKeyManager.getApiKey = async candidate =>
                    candidate === provider ? requestKey : originalGetApiKey.call(ApiKeyManager, candidate);
                ApiKeyManager.hasValidApiKey = async candidate =>
                    candidate === provider ? true : originalHasValidApiKey.call(ApiKeyManager, candidate);
                ConfigSetStore.getSwitchMode = candidate =>
                    candidate === provider ? 'off' : originalGetSwitchMode.call(ConfigSetStore, candidate);
                let queries = 0;
                adapter.query = async () => {
                    queries++;
                    return data;
                };
                try {
                    if (source === 'query') {
                        const queryStatus: () => Promise<{ success: boolean; error?: string }> = Reflect.get(
                            nativeBar,
                            'performApiQuery'
                        );
                        const result = await queryStatus.call(nativeBar);
                        assert.equal(result.success, true, result.error);
                    } else {
                        const receive: (data: TRaw, hash: string, timestamp: number) => void = Reflect.get(
                            nativeBar,
                            source === 'event' ? 'onStatusUpdatedFromEvent' : 'onStatusRestoredFromCache'
                        );
                        receive.call(nativeBar, data, hashRequestApiKey(requestKey), now);
                    }
                    const value = getCachedRequestBalance(provider, requestKey);
                    const saved = JSON.parse(JSON.stringify(value)) as typeof value;
                    assert.equal(saved?.statusSnapshots?.length, 1);
                    const snapshot = saved?.statusSnapshots?.[0];
                    assert.ok(snapshot && snapshot.provider === provider);
                    assert.equal(snapshot.version, 1);
                    assert.equal(snapshot.queriedAt, now);
                    const expectedData = JSON.parse(JSON.stringify(data)) as TRaw;
                    if (typeof expectedData === 'object' && expectedData !== null) {
                        Reflect.deleteProperty(expectedData, 'lastUpdated');
                        if (provider === 'zhipu') {
                            Reflect.deleteProperty(expectedData, 'nextResetTime');
                        }
                        if (provider === 'minimax-token') {
                            const minimax = expectedData as unknown as Extract<
                                RequestStatusData,
                                { provider: 'minimax-token' }
                            >['data'];
                            for (const limit of minimax.limits) {
                                Reflect.deleteProperty(limit, 'label');
                                Reflect.deleteProperty(limit, 'remainMs');
                            }
                        }
                    }
                    const expectedStatus = { provider, data: expectedData } as unknown as RequestStatusData;
                    if (expectedStatus.provider === 'commandcode') {
                        for (const window of [expectedStatus.data.fiveHour, expectedStatus.data.weekly]) {
                            if (window) {
                                Reflect.deleteProperty(window, 'exceeded');
                            }
                        }
                    } else if (expectedStatus.provider === 'kimi') {
                        for (const detail of [
                            expectedStatus.data.summary,
                            ...expectedStatus.data.windows.map(window => window.detail)
                        ]) {
                            Reflect.deleteProperty(detail, 'limit');
                            Reflect.deleteProperty(detail, 'used');
                        }
                    } else if (expectedStatus.provider === 'opencode') {
                        for (const window of expectedStatus.data.windows) {
                            Reflect.deleteProperty(window, 'status');
                        }
                    }
                    assert.deepEqual(snapshot.data, expectedData);
                    const replayData = snapshot.data as unknown as TRaw;
                    assert.equal(Reflect.has(snapshot, 'context'), false);
                    now += 61_000;
                    Date.now = () => snapshot.queriedAt;
                    assert.equal(display.call(nativeBar, replayData), expectedText);
                    assert.deepEqual(adapter.tables(replayData), expectedTables);
                    assert.deepEqual(adapter.details?.(replayData), expectedDetails);
                    assert.equal(queries, source === 'query' ? 1 : 0);
                    assert.equal(getCachedRequestBalance(provider, 'unrelated-replay-key'), undefined);
                    assert.equal(JSON.stringify(saved).includes(requestKey), false);
                } finally {
                    Date.now = originalNow;
                    adapter.query = originalQuery;
                    ApiKeyManager.getApiKey = originalGetApiKey;
                    ApiKeyManager.hasValidApiKey = originalHasValidApiKey;
                    ConfigSetStore.getSwitchMode = originalGetSwitchMode;
                    nativeBar.dispose();
                }
            });
        }
    }

    statusReplay('deepseek', 'deepseek', deepseekStatusAdapter, createDeepSeekStatusBar, () => {
        const primaryBalance = {
            currency: 'CNY',
            total_balance: '12.50000000',
            topped_up_balance: '10.0000',
            granted_balance: '2.50000000'
        };
        return {
            primaryBalance,
            allBalances: [
                primaryBalance,
                { currency: 'USD', total_balance: '0.0000', topped_up_balance: '-1.0000', granted_balance: '1.0000' }
            ],
            lastUpdated: new Date(now).toISOString()
        };
    });
    statusReplay('moonshot', 'moonshot', moonshotStatusAdapter, createMoonshotStatusBar, () => ({
        balanceInfo: { available_balance: 0, cash_balance: -2, voucher_balance: 2 },
        lastUpdated: new Date(now).toISOString()
    }));
    statusReplay('commandcode', 'commandcode', commandcodeStatusAdapter, createCommandCodeStatusBar, () => ({
        planId: 'individual-pro',
        monthlyCredits: 3,
        purchasedCredits: 10,
        freeCredits: 2,
        totalCredits: 15,
        fiveHour: { used: 35, cap: 100, exceeded: false, resetAt: new Date(now + 60_000).toISOString() },
        weekly: { used: 70, cap: 200, exceeded: false, resetAt: new Date(now + 300_000).toISOString() },
        lastUpdated: new Date(now).toISOString()
    }));
    statusReplay('clinepass', 'clinepass', clinepassStatusAdapter, createClinePassStatusBar, () => ({
        limits: [
            { type: 'five_hour' as const, percentUsed: 10, resetsAt: new Date(now + 60_000).toISOString() },
            { type: 'weekly' as const, percentUsed: 25, resetsAt: new Date(now + 300_000).toISOString() },
            { type: 'monthly' as const, percentUsed: 40 }
        ],
        lastUpdated: new Date(now).toISOString()
    }));
    statusReplay('zhipu-account', 'zhipu', zhipuStatusAdapter, createZhipuStatusBar, () => ({
        limits: [{ type: 'TOKENS_LIMIT' as const, unit: 6, percentage: 35, nextResetTime: now + 300_000 }],
        account: { balance: 10, availableBalance: 8, rechargeAmount: 40, giveAmount: 2, totalSpendAmount: 34 },
        nextResetTime: now + 300_000
    }));
    statusReplay('zhipu-quota-only', 'zhipu', zhipuStatusAdapter, createZhipuStatusBar, () => ({
        limits: [{ type: 'TOKENS_LIMIT' as const, unit: 3, percentage: 20, nextResetTime: now + 60_000 }],
        nextResetTime: now + 60_000
    }));

    statusReplay('minimax', 'minimax-token', minimaxStatusAdapter, createMiniMaxStatusBar, () => ({
        limits: [
            { label: '5 Hours', limitType: '5h' as const, remaining: 65, remainMs: 60000, resetTime: now + 60000 },
            { label: 'Weekly', limitType: 'weekly' as const, remaining: 80 },
            { label: 'Weekly lower', limitType: 'weekly' as const, remaining: 70 }
        ]
    }));
    statusReplay('kimi', 'kimi', kimiStatusAdapter, createKimiStatusBar, () => ({
        summary: {
            limit: 100,
            used: 25,
            remaining: 75,
            resetTime: new Date(now + 60000).toISOString(),
            period: 'monthly' as const
        },
        windows: [{ duration: 5, timeUnit: 'TIME_UNIT_HOUR', detail: { limit: 100, used: 10, remaining: 90 } }],
        parallel: { limit: 10 },
        boosterWallet: {
            balance: { amountLeft: '1250000000' },
            topupLimit: { currency: 'USD' },
            status: 'STATUS_ACTIVE',
            monthlyChargeLimitEnabled: false,
            monthlyChargeLimit: { currency: 'USD', priceInCents: '100' },
            monthlyUsed: { currency: 'CNY', priceInCents: '250' }
        }
    }));
    statusReplay('opencode', 'opencode', opencodeStatusAdapter, createOpenCodeStatusBar, () => ({
        windows: [
            {
                type: 'rolling' as const,
                usedPercent: 10,
                remainingPercent: 90,
                status: 'ok',
                resetAt: new Date(now + 60000).toISOString()
            },
            { type: 'weekly' as const, usedPercent: 25, remainingPercent: 75, status: 'ok' },
            { type: 'monthly' as const, usedPercent: 40, remainingPercent: 60, status: 'ok' }
        ],
        lastUpdated: new Date(now).toISOString()
    }));

    for (const provider of ['codex', 'grok'] as const) {
        test(`${provider} query binds its actual credential even if login changes before completion`, async () => {
            const originalAuth = CliAuthFactory.ensureAuthenticated;
            const originalInstance = CliAuthFactory.getInstance;
            const originalFetch = ConfigManager.fetchWithProxy;
            const requestKey = `private-${provider}-query-token`;
            let activeKey = requestKey;
            const nativeBar = provider === 'codex' ? new ChatGPTStatusBar() : new GrokStatusBar();
            let queryCount = 0;
            CliAuthFactory.ensureAuthenticated = async () => ({
                access_token: activeKey,
                refresh_token: 'test-refresh',
                expiry_date: now + 3600000
            });
            CliAuthFactory.getInstance = candidate =>
                candidate === 'codex' ?
                    ({ getAccountId: async () => 'private-account' } as unknown as CodexCliAuth)
                :   originalInstance.call(CliAuthFactory, candidate);
            ConfigManager.fetchWithProxy = async (_url, options) => {
                queryCount++;
                assert.equal(new Headers(options?.headers).get('Authorization'), `Bearer ${requestKey}`);
                activeKey = `${requestKey}-changed`;
                return new Response(
                    JSON.stringify(
                        provider === 'codex' ?
                            {
                                user_id: 'private-user',
                                account_id: 'private-account',
                                email: 'private-email',
                                plan_type: 'plus',
                                rate_limit: {
                                    allowed: true,
                                    limit_reached: false,
                                    primary_window: {
                                        used_percent: 25,
                                        limit_window_seconds: 604800,
                                        reset_after_seconds: 3600,
                                        reset_at: Math.floor(now / 1000) + 3600
                                    }
                                }
                            }
                        :   { config: { creditUsagePercent: 25, subscriptionTier: 'SuperGrok' } }
                    ),
                    { status: 200 }
                );
            };
            try {
                const queryStatus: () => Promise<{
                    success: boolean;
                    error?: string;
                    requestBalanceKeyHash?: string;
                    queriedAt?: number;
                }> = Reflect.get(nativeBar, 'performApiQuery');
                const result = await queryStatus.call(nativeBar);
                assert.equal(result.success, true, result.error);
                assert.equal(result.requestBalanceKeyHash, hashRequestApiKey(requestKey));
                assert.equal(result.queriedAt, now);
                const saved = getCachedRequestBalance(provider, requestKey);
                assert.equal(saved?.statusSnapshots?.[0].provider, provider);
                assert.equal(getCachedRequestBalance(provider, activeKey), undefined);
                assert.doesNotMatch(
                    JSON.stringify(saved),
                    /private-user|private-account|private-email|private-.*-token/
                );
                assert.equal(queryCount, 1);
            } finally {
                CliAuthFactory.ensureAuthenticated = originalAuth;
                CliAuthFactory.getInstance = originalInstance;
                ConfigManager.fetchWithProxy = originalFetch;
                nativeBar.dispose();
            }
        });
        for (const source of ['event', 'cache'] as const) {
            test(`${provider} records credential-scoped raw status after ${source}`, () => {
                const nativeBar = provider === 'codex' ? new ChatGPTStatusBar() : new GrokStatusBar();
                const requestKey = `private-${provider}-${source}-token`;
                const data: ChatGPTStatusData | GrokStatusData =
                    provider === 'codex' ?
                        {
                            userId: 'private-user',
                            accountId: 'private-account',
                            email: 'private-email',
                            planType: 'pro',
                            rateLimit: {
                                allowed: true,
                                limit_reached: false,
                                primary_window: {
                                    used_percent: 25,
                                    limit_window_seconds: 2592000,
                                    reset_after_seconds: 3600,
                                    reset_at: Math.floor(now / 1000) + 3600
                                }
                            },
                            codeReviewUsedPercent: 5,
                            lastUpdated: new Date(now).toISOString()
                        }
                    :   {
                            usage: {
                                type: 'weekly',
                                usedPercent: 25,
                                remainingPercent: 75,
                                windowMinutes: 10080,
                                subscriptionTier: 'SuperGrok',
                                resetAt: new Date(now + 3600000).toISOString()
                            },
                            lastUpdated: new Date(now).toISOString()
                        };
                try {
                    const receive: (data: ChatGPTStatusData | GrokStatusData, hash: string, timestamp: number) => void =
                        Reflect.get(
                            nativeBar,
                            source === 'event' ? 'onStatusUpdatedFromEvent' : 'onStatusRestoredFromCache'
                        );
                    receive.call(nativeBar, data, hashRequestApiKey(requestKey), now);
                    const saved = getCachedRequestBalance(provider, requestKey);
                    assert.ok(saved?.statusSnapshots?.length);
                    assert.deepEqual(saved.entries, []);
                    assert.equal(saved.statusSnapshots[0].provider, provider);
                    assert.equal(saved.queriedAt, now);
                    assert.equal(getCachedRequestBalance(provider, `${requestKey}-other`), undefined);
                    assert.doesNotMatch(
                        JSON.stringify(saved),
                        /private-user|private-account|private-email|private-.*-token/
                    );
                } finally {
                    nativeBar.dispose();
                }
            });
        }
    }

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
            requestBalance: data => [{ id: slot, balance: data.balance, currency: 'USD' }],
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
        assert.equal(getCachedRequestBalance(slot, 'fake-a')?.entries[0].balance, dataA.balance);
        assert.equal(getCachedRequestBalance(slot, 'fake-b')?.entries[0].balance, dataB.balance);
        assert.equal(JSON.stringify([...writes.values()]).includes('fake-a'), false);
        assert.equal(JSON.stringify([...writes.values()]).includes('fake-b'), false);
    });

    test('slow sibling keeps each key balance and the original primary query timestamp', async () => {
        const startedAt = now;
        const started = deferred();
        const release = deferred();
        query = async apiKey => {
            if (apiKey === 'fake-b') {
                started.resolve();
                await release.promise;
                return dataB;
            }
            return dataA;
        };
        const work = bar.run();
        try {
            await waitForQuery(started, work);
            now += 2_000;
            cacheRequestBalance(slot, 'fake-a', [{ id: slot, balance: 20, currency: 'USD' }], now);
            now += 1_000;
            release.resolve();
            await work;
            assert.equal(getCachedRequestBalance(slot, 'fake-a')?.entries[0].balance, 20);
            assert.equal(getCachedRequestBalance(slot, 'fake-a')?.queriedAt, startedAt + 2_000);
            assert.equal(getCachedRequestBalance(slot, 'fake-b')?.entries[0].balance, dataB.balance);
            assert.equal(getCachedRequestBalance(slot, 'fake-b')?.queriedAt, now);
            assert.equal(bar.multi?.entries[0].timestamp, startedAt);
            assert.equal(bar.multi?.entries[1].timestamp, now);
            assert.equal(bar.cached?.timestamp, startedAt);
            const event = published.find(event => event.type === 'statusUpdated');
            assert.ok(event && event.type === 'statusUpdated');
            const broadcast = (event as StatusUpdatedEvent).payload.data as CachedStatusData<UsageData>;
            assert.equal(broadcast.timestamp, startedAt);
            assert.equal(broadcast.requestBalanceKeyHash, hashRequestApiKey('fake-a'));
            assert.deepEqual(calls, ['fake-a', 'fake-b']);
        } finally {
            release.resolve();
            await work;
        }
    });

    test('restoration preserves newer balances independently for each full key hash', () => {
        keys.set('a', 'restore-key-a');
        keys.set('b', 'restore-key-b');
        runtimeKey = keys.get('a');
        const cached = snapshot();
        for (const entry of cached.entries) {
            entry.requestBalanceKeyHash = hashRequestApiKey(keys.get(entry.configId)!);
            entry.keyHash = entry.requestBalanceKeyHash.slice(0, 16);
        }
        cached.entries[0].timestamp = now - 3_000;
        cached.entries[0].data = { ...dataA, balance: 100 };
        cached.entries[1].timestamp = now - 500;
        cached.entries[1].data = { ...dataB, balance: 7 };
        cacheRequestBalance(slot, 'restore-key-a', [{ id: slot, balance: 20, currency: 'USD' }], now - 1_000);
        writes.set(multiCacheKey, cached);
        bar.poll();
        assert.equal(getCachedRequestBalance(slot, 'restore-key-a')?.entries[0].balance, 20);
        assert.equal(getCachedRequestBalance(slot, 'restore-key-a')?.queriedAt, now - 1_000);
        assert.equal(getCachedRequestBalance(slot, 'restore-key-b')?.entries[0].balance, 7);
        assert.equal(getCachedRequestBalance(slot, 'restore-key-b')?.queriedAt, now - 500);
        assert.equal(getCachedRequestBalance(slot, 'restore-key-c'), undefined);
        assert.deepEqual(calls, []);
    });

    for (const invalid of ['missing-hash', 'short-hash', 'missing-time', 'expired', 'future'] as const) {
        test(`restoration cannot attribute a ${invalid} entry using the current key or aggregate time`, () => {
            const firstKey = `restore-${invalid}-a`;
            const secondKey = `restore-${invalid}-b`;
            keys.set('a', firstKey);
            keys.set('b', secondKey);
            runtimeKey = firstKey;
            const cached = snapshot();
            for (const entry of cached.entries) {
                entry.requestBalanceKeyHash = hashRequestApiKey(keys.get(entry.configId)!);
                entry.keyHash = entry.requestBalanceKeyHash.slice(0, 16);
            }
            const first = cached.entries[0];
            if (invalid === 'missing-hash') {
                delete first.requestBalanceKeyHash;
            } else if (invalid === 'short-hash') {
                first.requestBalanceKeyHash = first.keyHash;
            } else if (invalid === 'missing-time') {
                Reflect.deleteProperty(first, 'timestamp');
            } else {
                first.timestamp = invalid === 'expired' ? now - 360_000 : now + 60_000;
            }
            writes.set(multiCacheKey, cached);
            bar.poll();
            assert.equal(getCachedRequestBalance(slot, firstKey), undefined);
            assert.equal(getCachedRequestBalance(slot, secondKey)?.entries[0].balance, dataB.balance);
            assert.deepEqual(calls, []);
        });
    }

    test('primary key rotation associates the retried result only with the consumed key', async () => {
        mode = 'off';
        runtimeKey = 'rotation-key-a';
        keys.set('a', runtimeKey);
        keys.set('b', 'rotation-key-b');
        const startedAt = now;
        query = async apiKey => {
            if (apiKey === 'rotation-key-a') {
                now += 1_000;
                runtimeKey = 'rotation-key-b';
                activeId = 'b';
                return dataA;
            }
            now += 2_000;
            return dataB;
        };
        await bar.run();
        assert.equal(getCachedRequestBalance(slot, 'rotation-key-a'), undefined);
        assert.equal(getCachedRequestBalance(slot, 'rotation-key-b')?.entries[0].balance, dataB.balance);
        assert.equal(getCachedRequestBalance(slot, 'rotation-key-b')?.queriedAt, startedAt + 3_000);
        assert.equal(bar.cached?.requestBalanceKeyHash, hashRequestApiKey('rotation-key-b'));
        assert.equal(bar.cached?.timestamp, startedAt + 3_000);
        assert.deepEqual(calls, ['rotation-key-a', 'rotation-key-b']);
    });

    test('an inactive key replaced during its query cannot receive the former key balance', async () => {
        query = async apiKey => {
            if (apiKey === 'fake-b') {
                keys.set('b', 'replacement-key-b');
                return dataB;
            }
            return dataA;
        };
        await bar.run();
        assert.equal(bar.multi?.entries[1].status, 'stale');
        assert.equal(bar.multi?.entries[1].requestBalanceKeyHash, hashRequestApiKey('fake-b'));
        assert.equal(getCachedRequestBalance(slot, 'replacement-key-b'), undefined);
    });

    test('broadcast balance stays with the sender key rather than the receiver active key', () => {
        mode = 'off';
        runtimeKey = 'broadcast-receiver-key';
        bar.receive(dataA, hashRequestApiKey('broadcast-sender-key'), now - 1_000);
        assert.equal(getCachedRequestBalance(slot, 'broadcast-sender-key')?.entries[0].balance, dataA.balance);
        assert.equal(getCachedRequestBalance(slot, 'broadcast-sender-key')?.queriedAt, now - 1_000);
        assert.equal(getCachedRequestBalance(slot, runtimeKey), undefined);
        assert.deepEqual(calls, []);
    });

    for (const invalid of ['future', 'missing', 'nan', 'infinity', 'string', 'negative'] as const) {
        test(`invalid broadcast time does not change state or block a valid balance: ${invalid}`, () => {
            const apiKey = `broadcast-time-${invalid}`;
            const hash = hashRequestApiKey(apiKey);
            const timestamp = {
                future: now + 60_000,
                missing: undefined,
                nan: NaN,
                infinity: Infinity,
                string: String(now),
                negative: -1
            }[invalid];
            const handler: (event: StatusUpdatedEvent) => void = Reflect.get(bar, 'handleStatusUpdatedEvent');
            const receiveInvalid = () =>
                handler.call(bar, {
                    type: 'statusUpdated',
                    timestamp: now,
                    senderInstanceId: 'test-leader',
                    payload: {
                        providerKey: slot,
                        source: 'api',
                        data: { data: { ...dataA, balance: 100 }, timestamp, requestBalanceKeyHash: hash }
                    }
                });
            const initial = { cached: bar.cached, writes: new Map(writes), text: item.text };
            receiveInvalid();
            assert.deepEqual(bar.cached, initial.cached);
            assert.deepEqual(writes, initial.writes);
            assert.equal(item.text, initial.text);
            assert.equal(getCachedRequestBalance(slot, apiKey), undefined);

            bar.receive({ ...dataA, balance: 20 }, hash, now - 1000);
            const previous = { cached: bar.cached, writes: new Map(writes), text: item.text };
            receiveInvalid();
            assert.deepEqual(bar.cached, previous.cached);
            assert.deepEqual(writes, previous.writes);
            assert.equal(item.text, previous.text);
            assert.equal(getCachedRequestBalance(slot, apiKey)?.entries[0].balance, 20);

            bar.receive({ ...dataB, balance: 10 }, hash, now);
            assert.equal(bar.cached?.timestamp, now);
            assert.equal(getCachedRequestBalance(slot, apiKey)?.entries[0].balance, 10);
            assert.deepEqual(calls, []);
        });
    }

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
        assert.deepEqual(bar.cached, {
            data: dataB,
            timestamp: now,
            requestBalanceKeyHash: hashRequestApiKey('fake-b')
        });
    });
});
