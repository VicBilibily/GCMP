import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import test from 'node:test';

import {
    DEFAULT_BALANCE_WARNING_THRESHOLD,
    getBalanceAlertLevel,
    getHighestBalanceAlertLevel,
    resolveBalanceWarningThreshold
} from './balanceWarning';

const require = createRequire(import.meta.url);
const NodeModule = require('node:module') as {
    prototype: { require: (id: string) => unknown };
};

test('balance warning threshold defaults to 20 for missing or invalid overrides', () => {
    assert.equal(resolveBalanceWarningThreshold(undefined), DEFAULT_BALANCE_WARNING_THRESHOLD);
    assert.equal(resolveBalanceWarningThreshold(Number.NaN), DEFAULT_BALANCE_WARNING_THRESHOLD);
    assert.equal(resolveBalanceWarningThreshold(-1), DEFAULT_BALANCE_WARNING_THRESHOLD);
    assert.equal(resolveBalanceWarningThreshold('10'), DEFAULT_BALANCE_WARNING_THRESHOLD);
});

test('balance warning threshold accepts finite non-negative overrides', () => {
    assert.equal(resolveBalanceWarningThreshold(0), 0);
    assert.equal(resolveBalanceWarningThreshold(12.5), 12.5);
});

test('balance alert level uses red only for negative balances', () => {
    assert.equal(getBalanceAlertLevel(-0.01, 20), 'error');
    assert.equal(getBalanceAlertLevel(0, 20), 'warning');
});

test('balance alert level includes the warning threshold boundary', () => {
    assert.equal(getBalanceAlertLevel(20, 20), 'warning');
    assert.equal(getBalanceAlertLevel(20.01, 20), 'none');
});

test('balance alert level ignores missing and non-finite balances', () => {
    assert.equal(getBalanceAlertLevel(undefined, 20), 'none');
    assert.equal(getBalanceAlertLevel(Number.NaN, 20), 'none');
    assert.equal(getBalanceAlertLevel(Number.POSITIVE_INFINITY, 20), 'none');
});

test('multiple balances use error over warning over normal', () => {
    assert.equal(
        getHighestBalanceAlertLevel([
            { balance: 100, warningThreshold: 50 },
            { balance: 20, warningThreshold: 20 }
        ]),
        'warning'
    );
    assert.equal(
        getHighestBalanceAlertLevel([
            { balance: 100, warningThreshold: 50 },
            { balance: 20, warningThreshold: 20 },
            { balance: -1, warningThreshold: 0 }
        ]),
        'error'
    );
    assert.equal(getHighestBalanceAlertLevel([{ balance: 21, warningThreshold: 20 }]), 'none');
});

test('special compatible unlimited balance is not highlighted', () => {
    assert.equal(getBalanceAlertLevel(Number.MAX_SAFE_INTEGER, 20), 'none');
});

test('AIHubMix preserves finite negative balances and recognizes the unlimited sentinel', async () => {
    let responseBody: unknown = { object: 'list', total_usage: -1 };
    const originalRequire = NodeModule.prototype.require;
    NodeModule.prototype.require = function (id: string): unknown {
        if (id.endsWith('/statusLogger')) {
            return { StatusLogger: { debug() {}, warn() {} } };
        }
        if (id.endsWith('/logger')) {
            return { Logger: { error() {} } };
        }
        if (id.endsWith('/apiKeyManager')) {
            return { ApiKeyManager: {} };
        }
        if (id.endsWith('/knownProviders')) {
            return { KnownProviders: { aihubmix: {} } };
        }
        if (id.endsWith('/configManager')) {
            return {
                ConfigManager: {
                    getProviderOverrides: () => ({}),
                    fetchWithProxy: async () => ({ ok: true, json: async () => responseBody })
                }
            };
        }
        return originalRequire.call(this, id);
    };

    let queryModule: typeof import('../../quota/compatible/providers/aihubmixBalanceQuery');
    try {
        queryModule = await import('../../quota/compatible/providers/aihubmixBalanceQuery');
    } finally {
        NodeModule.prototype.require = originalRequire;
    }

    const query = new queryModule.AiHubMixBalanceQuery();
    const negativeBalance = (await query.queryBalance('aihubmix', 'test-key')).balance;
    assert.equal(negativeBalance, -1);
    assert.equal(getBalanceAlertLevel(negativeBalance, 20), 'error');

    responseBody = { object: 'list', total_usage: -0.000002 };
    assert.equal((await query.queryBalance('aihubmix', 'test-key')).balance, Number.MAX_SAFE_INTEGER);

    responseBody = { object: 'list', total_usage: 0 };
    assert.equal((await query.queryBalance('aihubmix', 'test-key')).balance, 0);
});

test('provider override changes preserve refresh errors until a successful query', async () => {
    const originalRequire = NodeModule.prototype.require;
    const statusBar = {
        text: '',
        tooltip: '' as string,
        backgroundColor: undefined as { id: string } | undefined,
        show() {},
        hide() {},
        dispose() {}
    };
    let onConfigChanged: ((event: { affectsConfiguration: (key: string) => boolean }) => void) | undefined;
    NodeModule.prototype.require = function (id: string): unknown {
        if (id === 'vscode') {
            return {
                window: { createStatusBarItem: () => statusBar },
                workspace: {
                    onDidChangeConfiguration: (listener: typeof onConfigChanged) => {
                        onConfigChanged = listener;
                        return { dispose() {} };
                    }
                },
                commands: { registerCommand: () => ({ dispose() {} }) },
                ThemeColor: class {
                    constructor(public id: string) {}
                }
            };
        }
        if (id.endsWith('/statusLogger')) {
            return { StatusLogger: { trace() {}, debug() {}, info() {}, warn() {}, error() {} } };
        }
        if (id.endsWith('/leaderElectionService')) {
            return { LeaderElectionService: { registerPeriodicTask() {} } };
        }
        if (id.endsWith('/interInstance')) {
            return { InterInstanceBus: { subscribe: () => ({ dispose() {} }), publish() {} } };
        }
        if (id.endsWith('/apiKeyManager')) {
            return { ApiKeyManager: {} };
        }
        if (id.endsWith('/l10n')) {
            return { t: (english: string) => english };
        }
        if (id.endsWith('/format')) {
            return { formatCompactCountdown: () => '' };
        }
        return originalRequire.call(this, id);
    };

    let baseModule: typeof import('../../status/baseStatusBarItem');
    try {
        baseModule = await import('../../status/baseStatusBarItem');
    } finally {
        NodeModule.prototype.require = originalRequire;
    }

    let warningThreshold = 20;
    const results: Array<{ success: boolean; data?: { balance: number }; error?: string }> = [
        { success: true, data: { balance: 100 } }
    ];
    let initialPaint!: () => void;
    const painted = new Promise<void>(resolve => {
        initialPaint = resolve;
    });
    class TestStatusBar extends baseModule.BaseStatusBarItem<{ balance: number }> {
        protected getDisplayText(data: { balance: number }): string {
            initialPaint();
            return String(data.balance);
        }
        protected generateTooltip(data: { balance: number }): string {
            return `Balance: ${data.balance}`;
        }
        protected performApiQuery(): Promise<{ success: boolean; data?: { balance: number }; error?: string }> {
            return Promise.resolve(results.shift() ?? { success: false, error: 'No response' });
        }
        protected shouldHighlightWarning(data: { balance: number }): boolean {
            return data.balance <= warningThreshold;
        }
        protected shouldShowStatusBar(): Promise<boolean> {
            return Promise.resolve(true);
        }
        async refreshForTest(): Promise<void> {
            await this.executeApiQuery(true);
        }
    }

    const status = new TestStatusBar({
        id: 'test.balance',
        name: 'Test Balance',
        alignment: 1,
        priority: 1,
        refreshCommand: 'test.balance.refresh',
        cacheKeyPrefix: 'test.balance',
        logPrefix: 'test',
        icon: '$(test)'
    });
    const context = {
        subscriptions: [],
        globalState: { get: () => undefined, update: () => Promise.resolve() }
    } as unknown as Parameters<TestStatusBar['initialize']>[0];

    try {
        await status.initialize(context);
        await painted;
        assert.equal(statusBar.text, '100');

        warningThreshold = 120;
        onConfigChanged?.({ affectsConfiguration: key => key === 'gcmp.providerOverrides' });
        assert.equal(statusBar.backgroundColor?.id, 'statusBarItem.warningBackground');

        results.push({ success: false, error: 'Unavailable' });
        await status.refreshForTest();
        assert.equal(statusBar.text, '$(test) ERR');
        const errorTooltip = statusBar.tooltip;

        warningThreshold = 0;
        onConfigChanged?.({ affectsConfiguration: key => key === 'gcmp.providerOverrides' });
        assert.equal(statusBar.text, '$(test) ERR');
        assert.equal(statusBar.tooltip, errorTooltip);

        results.push({ success: true, data: { balance: 100 } });
        await status.refreshForTest();
        assert.equal(statusBar.text, '100');
        assert.equal(statusBar.backgroundColor, undefined);
    } finally {
        status.dispose();
    }
});
