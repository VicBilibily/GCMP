/*---------------------------------------------------------------------------------------------
 *  Token Usage Status Bar
 *  Token 用量状态栏 - 显示今日 Token 用量
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { TokenUsagesManager } from '../usages/usagesManager';
import { StatusLogger } from '../utils/runtime/statusLogger';
import { DateUtils } from '../usages/fileLogger/dateUtils';
import { UserActivityService } from './userActivityService';
import { InterInstanceBus, type TokenUsageUpdatedEvent } from '../interInstance';
import { LeaderElectionService } from './leaderElectionService';
import type { UsageStatusSnapshot, UsageStatusStats } from '../usages/status/snapshot';
import { UsageStatusPresentation } from './tokenUsage/presentation';
import { t } from '../utils/runtime/l10n';

export class TokenUsageStatusBar {
    private statusBarItem: vscode.StatusBarItem | undefined;
    private readonly usagesManager: TokenUsagesManager;
    private readonly presentation = new UsageStatusPresentation();
    private readonly subscriptions: vscode.Disposable[] = [];
    private updateTimer: NodeJS.Timeout | undefined;
    private delayedUpdateTimer: NodeJS.Timeout | undefined;
    private refreshInFlight: Promise<void> | undefined;
    private refreshPending = false;
    private refreshGeneration = 0;
    private disposed = false;
    private lastStatsDate: string | undefined;
    private lastStats: UsageStatusStats | undefined;
    private lastUpdateTime = 0;
    private readonly UPDATE_INTERVAL = 30000;
    private readonly UPDATE_COOLDOWN = 10000;

    constructor(private context: vscode.ExtensionContext) {
        this.usagesManager = TokenUsagesManager.instance;
    }

    async initialize(): Promise<void> {
        if (this.statusBarItem || this.disposed) {
            return;
        }
        this.statusBarItem = vscode.window.createStatusBarItem(
            'gcmp.statusBar.tokenUsage',
            vscode.StatusBarAlignment.Right,
            11
        );

        this.statusBarItem.name = 'GCMP: Token Usage';
        this.statusBarItem.command = 'gcmp.tokenUsage.showDetails';

        this.subscriptions.push(
            this.usagesManager.onStatusSnapshot(snapshot => {
                this.applySnapshot(snapshot);
            }),
            InterInstanceBus.subscribe<TokenUsageUpdatedEvent>('tokenUsageUpdated', event => {
                if (
                    !this.disposed &&
                    this.usagesManager.isStatusFileMode() &&
                    event.payload.date === DateUtils.getTodayDateString()
                ) {
                    void this.updateDisplay();
                }
            }),
            LeaderElectionService.onLeaderChanged(() => {
                this.refreshCachedPresentation();
            }),
            vscode.workspace.onDidChangeConfiguration(event => {
                if (event.affectsConfiguration('gcmp.debug.captureHar')) {
                    this.refreshCachedPresentation();
                }
            })
        );

        this.context.subscriptions.push(this.statusBarItem, ...this.subscriptions);
        void this.updateDisplay();
        this.startPeriodicUpdate();
        StatusLogger.debug('[TokenUsageStatusBar] Initialized');
    }

    private startPeriodicUpdate(): void {
        if (this.updateTimer) {
            clearInterval(this.updateTimer);
        }

        this.updateTimer = setInterval(() => {
            void this.periodicUpdate();
        }, this.UPDATE_INTERVAL);

        StatusLogger.debug(`[TokenUsageStatusBar] Started periodic updates (${this.UPDATE_INTERVAL}ms)`);
    }

    private stopPeriodicUpdate(): void {
        if (this.updateTimer) {
            clearInterval(this.updateTimer);
            this.updateTimer = undefined;
            StatusLogger.debug('[TokenUsageStatusBar] Stopped periodic updates');
        }
    }

    private async periodicUpdate(): Promise<void> {
        if (this.disposed) {
            return;
        }
        if (!UserActivityService.isUserActive()) {
            StatusLogger.trace('[TokenUsageStatusBar] User inactive. Skipping update.');
            return;
        }

        const timeSinceLastUpdate = Date.now() - this.lastUpdateTime;
        if (timeSinceLastUpdate < this.UPDATE_COOLDOWN) {
            StatusLogger.trace(
                `[TokenUsageStatusBar] Last update was ${timeSinceLastUpdate}ms ago. Waiting for the next cycle.`
            );
            return;
        }

        await this.updateDisplay();
    }

    async updateDisplay(): Promise<void> {
        if (!this.statusBarItem || this.disposed) {
            return;
        }

        this.refreshPending = true;
        if (this.refreshInFlight) {
            return this.refreshInFlight;
        }

        const execution = this.runRefreshLoop();
        const shared = execution.finally(() => {
            if (this.refreshInFlight === shared) {
                this.refreshInFlight = undefined;
            }
            if (this.refreshPending && !this.disposed) {
                void this.updateDisplay();
            }
        });
        this.refreshInFlight = shared;
        return shared;
    }

    private async runRefreshLoop(): Promise<void> {
        while (this.refreshPending && !this.disposed) {
            this.refreshPending = false;
            const generation = ++this.refreshGeneration;
            await this.updateDisplayOnce(generation);
        }
    }

    private async updateDisplayOnce(generation: number): Promise<void> {
        if (!this.statusBarItem || this.disposed) {
            return;
        }

        const today = DateUtils.getTodayDateString();
        if (this.lastStatsDate !== today) {
            this.lastStats = undefined;
            this.lastStatsDate = undefined;
            this.renderLoading();
        }

        try {
            const snapshot = await this.usagesManager.getStatusSnapshot();
            if (!this.canApplyRefresh(generation, today)) {
                return;
            }

            if (!snapshot || snapshot.date !== today) {
                this.lastStats = undefined;
                this.lastStatsDate = undefined;
                this.renderLoading();
                return;
            }
            this.applySnapshot(snapshot);
        } catch (err) {
            StatusLogger.error('[TokenUsageStatusBar] Failed to update display:', err);
            if (this.canApplyRefresh(generation, today)) {
                if (!this.lastStats || this.lastStatsDate !== today) {
                    this.renderLoading();
                }
            }
        }
    }

    private applySnapshot(snapshot: UsageStatusSnapshot): void {
        if (!this.statusBarItem || this.disposed || snapshot.date !== DateUtils.getTodayDateString()) {
            return;
        }

        this.refreshGeneration += 1;
        const changed = this.lastStatsDate !== snapshot.date || this.lastStats !== snapshot.stats;
        this.lastStats = snapshot.stats;
        this.lastStatsDate = snapshot.date;
        if (changed) {
            this.renderStatusBar(snapshot.stats);
        }
        this.lastUpdateTime = Date.now();
    }

    private canApplyRefresh(generation: number, date: string): boolean {
        return (
            !this.disposed &&
            !!this.statusBarItem &&
            generation === this.refreshGeneration &&
            date === DateUtils.getTodayDateString()
        );
    }

    private refreshCachedPresentation(): void {
        if (this.disposed || !this.statusBarItem) {
            return;
        }
        const today = DateUtils.getTodayDateString();
        if (!this.lastStats || this.lastStatsDate !== today) {
            void this.updateDisplay();
            return;
        }
        this.renderStatusBar(this.lastStats);
    }

    private renderStatusBar(stats: UsageStatusStats): void {
        if (!this.statusBarItem || this.disposed) {
            return;
        }

        const { text, tooltip } = this.presentation.render(stats);
        this.statusBarItem.text = text;
        this.statusBarItem.tooltip = tooltip;
        this.statusBarItem.show();
    }

    private renderLoading(): void {
        if (!this.statusBarItem || this.disposed) {
            return;
        }
        this.statusBarItem.text = this.presentation.icon();
        this.statusBarItem.tooltip = t('Loading token usage...', '正在加载 Token 统计...');
        this.statusBarItem.show();
    }

    async checkAndShowStatus(): Promise<void> {
        if (this.statusBarItem && !this.disposed) {
            this.statusBarItem.show();
        }
    }

    delayedUpdate(delayMs: number = 1000): void {
        if (this.disposed) {
            return;
        }
        if (this.delayedUpdateTimer) {
            clearTimeout(this.delayedUpdateTimer);
        }
        this.delayedUpdateTimer = setTimeout(() => {
            this.delayedUpdateTimer = undefined;
            void this.updateDisplay();
        }, delayMs);
    }

    dispose(): void {
        this.disposed = true;
        this.refreshPending = false;
        this.refreshGeneration += 1;
        if (this.delayedUpdateTimer) {
            clearTimeout(this.delayedUpdateTimer);
            this.delayedUpdateTimer = undefined;
        }
        this.stopPeriodicUpdate();
        for (const subscription of this.subscriptions.splice(0)) {
            subscription.dispose();
        }
        this.statusBarItem?.dispose();
        this.statusBarItem = undefined;
        this.lastStats = undefined;
        this.lastStatsDate = undefined;
    }
}
