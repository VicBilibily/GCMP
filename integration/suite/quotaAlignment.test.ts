import assert from 'node:assert/strict';

import * as vscode from 'vscode';

import { getQuotaMetricType, isQuotaSupportedSlot } from '../../src/quota/common';
import {
    clinepassStatusAdapter,
    minimaxStatusAdapter,
    type ClinePassStatusData,
    type MiniMaxStatusData
} from '../../src/quota/statusAdapters';
import { ProviderQuotaStatusBar } from '../../src/status/providerQuotaStatusBar';

/** 暴露 protected 渲染方法的测试壳 */
class TestStatusBar<T> extends ProviderQuotaStatusBar<T> {
    renderText(data: T): string {
        return this.getDisplayText(data);
    }
}

suite('quota alignment', () => {
    test('OpenCode slot is supported by the shared quota layer', () => {
        assert.equal(isQuotaSupportedSlot('opencode'), true);
        assert.equal(getQuotaMetricType('opencode'), 'usage');
    });

    test('MiniMax adapter summary drives the generic status bar text', () => {
        const data: MiniMaxStatusData = {
            limits: [
                { label: 'Every 5 Hours', limitType: '5h', remaining: 82, remainMs: 0, resetTime: 0 },
                { label: 'Weekly quota', limitType: 'weekly', remaining: 64, remainMs: 0, resetTime: 0 }
            ]
        };

        const bar = new TestStatusBar({
            config: {
                id: 'test.minimax',
                name: 'Test MiniMax',
                alignment: vscode.StatusBarAlignment.Right,
                priority: 98,
                refreshCommand: 'gcmp.refreshMiniMaxUsage',
                apiKeyProvider: 'minimax-token',
                cacheKeyPrefix: 'minimax',
                logPrefix: 'MiniMax Status Bar',
                icon: '$(gcmp-minimax)'
            },
            adapter: minimaxStatusAdapter,
            title: () => 'MiniMax Token Plan Usage'
        });

        assert.equal(minimaxStatusAdapter.summary(data), '64% (82%)');
        assert.equal(bar.renderText(data), '$(gcmp-minimax) 64% (82%)');
    });

    test('ClinePass adapter summary drives the generic status bar text', () => {
        const data: ClinePassStatusData = {
            limits: [
                { type: 'weekly', percentUsed: 40, resetsAt: '2026-08-20T00:00:00.000Z' },
                { type: 'monthly', percentUsed: 15, resetsAt: '2026-09-01T00:00:00.000Z' },
                { type: 'five_hour', percentUsed: 12, resetsAt: '2026-08-16T08:00:00.000Z' }
            ],
            lastUpdated: '2026/08/16 08:00:00'
        };

        const bar = new TestStatusBar({
            config: {
                id: 'test.clinepass',
                name: 'Test ClinePass',
                alignment: vscode.StatusBarAlignment.Right,
                priority: 26,
                refreshCommand: 'gcmp.clinepass.refreshUsage',
                apiKeyProvider: 'clinepass',
                cacheKeyPrefix: 'clinepass',
                logPrefix: 'ClinePass Status Bar',
                icon: '$(gcmp-cline)'
            },
            adapter: clinepassStatusAdapter,
            title: () => 'ClinePass Usage'
        });

        assert.equal(clinepassStatusAdapter.summary(data), '60% (88%)');
        assert.equal(bar.renderText(data), '$(gcmp-cline) 60% (88%)');
    });
});
