import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import test, { type TestContext } from 'node:test';
import type { ExtensionContext, StatusBarItem } from 'vscode';
import { notifyRequestCompleted } from './requestCompletion';
import type { ProviderQuotaStatusBar } from './providerQuotaStatusBar';
import type { StatusBarManager } from './statusBarManager';

const require = createRequire(import.meta.url);
const NodeModule = require('node:module') as { prototype: { require(id: string): unknown } };
type RegisteredStatusBar = Parameters<typeof StatusBarManager.registerStatusBar>[1];

function createStatusBar(delayedUpdate: (delayMs?: number) => void): RegisteredStatusBar {
    return {
        initialize: () => Promise.resolve(),
        checkAndShowStatus: () => Promise.resolve(),
        delayedUpdate,
        dispose() {}
    };
}

test('request completion refresh scheduling', async context => {
    const originalRequire = NodeModule.prototype.require;
    NodeModule.prototype.require = function (id: string): unknown {
        if (id === 'vscode') {
            return { window: {}, env: { language: 'en' } };
        }
        if (id.endsWith('/statusLogger')) {
            return { StatusLogger: { trace() {}, debug() {}, info() {}, warn() {}, error() {} } };
        }
        if (id.endsWith('/l10n')) {
            return { t: (english: string) => english };
        }
        if (id.endsWith('/configManager')) {
            return { ConfigManager: { getProviderBalanceWarningThreshold: () => 0 } };
        }
        if (id.endsWith('/configSetStore')) {
            return { ConfigSetStore: { list: () => [], getActiveId: () => undefined, getSwitchMode: () => 'off' } };
        }
        if (id.endsWith('/apiKeyManager')) {
            return {
                ApiKeyManager: { getApiKey: async () => 'completion-test-key', hasValidApiKey: async () => true }
            };
        }
        if (id.endsWith('/leaderElectionService')) {
            return { LeaderElectionService: { getLeaderId: () => 'self', getInstanceId: () => 'self' } };
        }
        if (id.endsWith('/interInstance')) {
            return { InterInstanceBus: { publish() {}, subscribe: () => ({ dispose() {} }) } };
        }
        if (
            /\/(chatgptStatusBar|grokStatusBar|compatibleStatusBar|tokenUsageStatusBar|quotaStatusBarRegistry)$/.test(
                id
            )
        ) {
            return {};
        }
        return originalRequire.call(this, id);
    };
    let manager: typeof StatusBarManager;
    let nativeStatusBar: typeof ProviderQuotaStatusBar;
    try {
        ({ StatusBarManager: manager } = await import('./statusBarManager'));
        ({ ProviderQuotaStatusBar: nativeStatusBar } = await import('./providerQuotaStatusBar'));
    } finally {
        NodeModule.prototype.require = originalRequire;
    }

    interface BalanceData {
        balance: number;
        currency: string;
    }

    class NativeStatusBarProbe extends nativeStatusBar<BalanceData> {
        constructor(providerKey: string, query: () => Promise<BalanceData>) {
            super({
                config: {
                    id: providerKey,
                    name: providerKey,
                    refreshCommand: `${providerKey}.refresh`,
                    apiKeyProvider: providerKey,
                    cacheKeyPrefix: providerKey,
                    logPrefix: providerKey,
                    icon: '$(credit-card)',
                    priority: 1,
                    alignment: 2
                },
                title: () => providerKey,
                adapter: {
                    query,
                    summary: data => `${data.balance} ${data.currency}`,
                    tables: () => [],
                    requestBalance: data => [{ id: 'wallet', ...data }]
                }
            });
            this.context = { globalState: { update: async () => {} } } as unknown as ExtensionContext;
            this.statusBarItem = { show() {}, hide() {}, dispose() {} } as unknown as StatusBarItem;
            this.initialized = true;
            manager.registerStatusBar(providerKey, this);
        }

        run(manual = false): Promise<void> {
            return this.executeApiQuery(manual);
        }

        get balance(): number | undefined {
            return this.lastStatusData?.data.balance;
        }

        seedCache(balance: number): void {
            this.lastStatusData = { data: { balance, currency: 'USD' }, timestamp: Date.now() };
        }

        protected override getDisplayText(data: BalanceData): string {
            return `${data.balance} ${data.currency}`;
        }

        protected override updateStatusBarUI(): void {}
    }

    async function advanceTimers(t: TestContext, milliseconds: number): Promise<void> {
        t.mock.timers.tick(milliseconds);
        await new Promise<void>(resolve => setImmediate(resolve));
        t.mock.timers.tick(0);
        await new Promise<void>(resolve => setImmediate(resolve));
    }

    await context.test('continuous notifications do not postpone the first refresh or exceed one per 30 seconds', t => {
        t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: 100000 });
        const calls: Array<{ at: number; delay: number | undefined }> = [];
        manager.registerStatusBar(
            'deepseek',
            createStatusBar(delay => calls.push({ at: Date.now(), delay }))
        );
        try {
            for (let count = 0; count < 20; count++) {
                notifyRequestCompleted('deepseek');
            }
            t.mock.timers.tick(1000);
            notifyRequestCompleted('deepseek');
            t.mock.timers.tick(1000);
            assert.deepEqual(calls, [{ at: 102000, delay: 0 }]);
            for (let count = 0; count < 29; count++) {
                notifyRequestCompleted('deepseek');
                t.mock.timers.tick(1000);
            }
            assert.equal(calls.length, 1);
            t.mock.timers.tick(1000);
            assert.deepEqual(calls, [
                { at: 102000, delay: 0 },
                { at: 132000, delay: 0 }
            ]);
        } finally {
            manager.disposeAll();
        }
    });

    await context.test('a request during cooldown retains one trailing refresh after requests stop', t => {
        t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: 100000 });
        const calls: number[] = [];
        manager.registerStatusBar(
            'moonshot',
            createStatusBar(() => calls.push(Date.now()))
        );
        try {
            manager.notifyRequestCompleted('moonshot');
            t.mock.timers.tick(2000);
            t.mock.timers.tick(1000);
            manager.notifyRequestCompleted('moonshot');
            t.mock.timers.tick(28999);
            assert.deepEqual(calls, [102000]);
            t.mock.timers.tick(1);
            assert.deepEqual(calls, [102000, 132000]);
        } finally {
            manager.disposeAll();
        }
    });

    await context.test('compatible notifications refresh only their provider and have independent cooldowns', t => {
        t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: 100000 });
        const calls: Array<{ provider: string | number | undefined; delay: number | undefined }> = [];
        manager.registerStatusBar('compatible', {
            ...createStatusBar(() => {}),
            delayedUpdate: (provider?: string | number, delay?: number) => calls.push({ provider, delay })
        });
        try {
            manager.notifyRequestCompleted('custom-first');
            manager.notifyRequestCompleted('custom-first');
            manager.notifyRequestCompleted('custom-second');
            t.mock.timers.tick(2000);
            assert.deepEqual(calls, [
                { provider: 'custom-first', delay: 0 },
                { provider: 'custom-second', delay: 0 }
            ]);
        } finally {
            manager.disposeAll();
        }
    });

    await context.test('native aliases route to the registered quota status bar', t => {
        t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: 100000 });
        const calls: Array<number | undefined> = [];
        manager.registerStatusBar(
            'minimax',
            createStatusBar(delay => calls.push(delay))
        );
        try {
            manager.notifyRequestCompleted('minimax-token');
            t.mock.timers.tick(2000);
            assert.deepEqual(calls, [0]);
        } finally {
            manager.disposeAll();
        }
    });

    await context.test('notifications without a registered status bar are ignored', t => {
        t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: 100000 });
        const calls: number[] = [];
        try {
            manager.notifyRequestCompleted('unregistered');
            manager.registerStatusBar(
                'unregistered',
                createStatusBar(() => calls.push(Date.now()))
            );
            t.mock.timers.tick(60000);
            assert.deepEqual(calls, []);
        } finally {
            manager.disposeAll();
        }
    });

    await context.test('dispose clears pending refreshes and resets the cooldown', t => {
        t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: 100000 });
        const calls: number[] = [];
        manager.registerStatusBar(
            'deepseek',
            createStatusBar(() => calls.push(Date.now()))
        );
        try {
            manager.notifyRequestCompleted('deepseek');
            t.mock.timers.tick(2000);
            manager.notifyRequestCompleted('deepseek');
            manager.disposeAll();
            manager.registerStatusBar(
                'deepseek',
                createStatusBar(() => calls.push(Date.now()))
            );
            manager.notifyRequestCompleted('deepseek');
            t.mock.timers.tick(2000);
            assert.deepEqual(calls, [102000, 104000]);
            t.mock.timers.tick(60000);
            assert.equal(calls.length, 2);
        } finally {
            manager.disposeAll();
        }
    });

    await context.test('native refresh failures do not suppress compatible refreshes or remove throttling', t => {
        t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: 100000 });
        const calls: Array<string | number | undefined> = [];
        manager.registerStatusBar(
            'deepseek',
            createStatusBar(() => {
                throw new Error('refresh failed');
            })
        );
        manager.registerStatusBar('compatible', {
            ...createStatusBar(() => {}),
            delayedUpdate: (provider?: string | number) => calls.push(provider)
        });
        try {
            manager.notifyRequestCompleted('deepseek');
            assert.doesNotThrow(() => t.mock.timers.tick(2000));
            assert.deepEqual(calls, ['deepseek']);
            manager.notifyRequestCompleted('deepseek');
            t.mock.timers.tick(29999);
            assert.equal(calls.length, 1);
            assert.doesNotThrow(() => t.mock.timers.tick(1));
            assert.deepEqual(calls, ['deepseek', 'deepseek']);
        } finally {
            manager.disposeAll();
        }
    });

    for (const scenario of [
        { name: 'short successful query', duration: 0, fails: false },
        { name: 'query finishing just before the throttle boundary', duration: 29000, fails: false },
        { name: 'query longer than the throttle interval', duration: 40000, fails: false },
        { name: 'failed query', duration: 0, fails: true }
    ]) {
        await context.test(`busy native refresh retains one bounded follow-up after ${scenario.name}`, async t => {
            t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: 100000 });
            const providerKey = 'busy-native';
            const calls: number[] = [];
            let release!: () => void;
            const held = new Promise<void>(resolve => {
                release = resolve;
            });
            let started!: () => void;
            const firstStarted = new Promise<void>(resolve => {
                started = resolve;
            });
            const native = new NativeStatusBarProbe(providerKey, async () => {
                calls.push(Date.now());
                if (calls.length === 1) {
                    started();
                    await held;
                    if (scenario.fails) {
                        throw new Error('first query failed');
                    }
                    return { balance: 20, currency: 'USD' };
                }
                return { balance: 19, currency: 'USD' };
            });
            const work = native.run();
            try {
                await firstStarted;
                for (let count = 0; count < 20; count++) {
                    notifyRequestCompleted(providerKey);
                }
                await advanceTimers(t, 2000);
                assert.deepEqual(calls, [100000]);
                await advanceTimers(t, scenario.duration);
                release();
                await work;
                const nextRefreshAt = Math.max(132000, Date.now() + 5000);
                await advanceTimers(t, nextRefreshAt - Date.now() - 1);
                assert.equal(calls.length, 1);
                await advanceTimers(t, 1);
                assert.deepEqual(calls, [100000, nextRefreshAt]);
                assert.equal(native.balance, 19);
                await advanceTimers(t, 60000);
                assert.equal(calls.length, 2);
            } finally {
                release();
                await work;
                manager.disposeAll();
            }
        });
    }

    for (const scenario of [
        'notification-during-query',
        'notification-after-query',
        'cache-update',
        'manual-query'
    ] as const) {
        await context.test(`pending native follow-up survives interleaving: ${scenario}`, async t => {
            t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: 100000 });
            const providerKey = `interleaving-${scenario}`;
            const calls: number[] = [];
            let release!: () => void;
            const held = new Promise<void>(resolve => {
                release = resolve;
            });
            let started!: () => void;
            const firstStarted = new Promise<void>(resolve => {
                started = resolve;
            });
            const native = new NativeStatusBarProbe(providerKey, async () => {
                calls.push(Date.now());
                if (calls.length === 1) {
                    started();
                    await held;
                    return { balance: 20, currency: 'USD' };
                }
                return { balance: 19, currency: 'USD' };
            });
            const work = native.run();
            try {
                await firstStarted;
                notifyRequestCompleted(providerKey);
                await advanceTimers(t, 2000);
                await advanceTimers(t, 1000);
                if (scenario === 'notification-during-query') {
                    notifyRequestCompleted(providerKey);
                }
                await advanceTimers(t, 28000);
                assert.deepEqual(calls, [100000]);
                release();
                await work;
                if (scenario === 'notification-after-query') {
                    notifyRequestCompleted(providerKey);
                } else if (scenario === 'manual-query') {
                    await native.run(true);
                }
                await advanceTimers(t, 1000);
                await advanceTimers(t, 1000);
                await advanceTimers(t, 2000);
                if (scenario === 'cache-update') {
                    native.seedCache(20);
                }
                await advanceTimers(t, 1000);
                if (scenario === 'cache-update') {
                    assert.deepEqual(calls, [100000]);
                    await advanceTimers(t, 29999);
                    assert.equal(calls.length, 1);
                    await advanceTimers(t, 1);
                }
                assert.deepEqual(calls, [
                    100000,
                    scenario === 'manual-query' ? 131000
                    : scenario === 'cache-update' ? 166000
                    : 136000
                ]);
                assert.equal(native.balance, 19);
                await advanceTimers(t, 60000);
                assert.equal(calls.length, 2);
            } finally {
                release();
                await work;
                manager.disposeAll();
            }
        });
    }

    await context.test('fresh cache without a pending follow-up retains the automatic query skip', async t => {
        t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: 100000 });
        let queries = 0;
        const native = new NativeStatusBarProbe('fresh-native', async () => {
            queries++;
            return { balance: 20, currency: 'USD' };
        });
        try {
            await native.run();
            notifyRequestCompleted('fresh-native');
            await advanceTimers(t, 2000);
            await advanceTimers(t, 60000);
            assert.equal(queries, 1);
        } finally {
            manager.disposeAll();
        }
    });

    await context.test(
        'busy native refresh lets a queued manual query satisfy the completion notification',
        async t => {
            t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: 100000 });
            let release!: () => void;
            const held = new Promise<void>(resolve => {
                release = resolve;
            });
            let started!: () => void;
            const firstStarted = new Promise<void>(resolve => {
                started = resolve;
            });
            let calls = 0;
            const native = new NativeStatusBarProbe('manual-native', async () => {
                calls++;
                if (calls === 1) {
                    started();
                    await held;
                }
                return { balance: calls === 1 ? 20 : 19, currency: 'USD' };
            });
            const work = native.run();
            try {
                await firstStarted;
                notifyRequestCompleted('manual-native');
                await advanceTimers(t, 2000);
                await native.run(true);
                release();
                await work;
                await advanceTimers(t, 0);
                assert.equal(calls, 2);
                assert.equal(native.balance, 19);
                await advanceTimers(t, 60000);
                assert.equal(calls, 2);
            } finally {
                release();
                await work;
                manager.disposeAll();
            }
        }
    );

    for (const disposeWhileBusy of [true, false]) {
        await context.test(
            `busy native refresh cancels follow-up when disposed ${disposeWhileBusy ? 'during' : 'after'} the query`,
            async t => {
                t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: 100000 });
                let release!: () => void;
                const held = new Promise<void>(resolve => {
                    release = resolve;
                });
                let calls = 0;
                new NativeStatusBarProbe('dispose-native', async () => {
                    calls++;
                    await held;
                    return { balance: 20, currency: 'USD' };
                });
                try {
                    notifyRequestCompleted('dispose-native');
                    await advanceTimers(t, 2000);
                    assert.equal(calls, 1);
                    notifyRequestCompleted('dispose-native');
                    await advanceTimers(t, 30000);
                    assert.equal(calls, 1);
                    if (disposeWhileBusy) {
                        manager.disposeAll();
                    }
                    release();
                    await advanceTimers(t, 0);
                    manager.disposeAll();
                    await advanceTimers(t, 60000);
                    assert.equal(calls, 1);
                } finally {
                    release();
                    manager.disposeAll();
                }
            }
        );
    }
});
