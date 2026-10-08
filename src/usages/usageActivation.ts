import * as vscode from 'vscode';
import { InterInstanceBus } from '../interInstance';
import { LeaderElectionService } from '../status/leaderElectionService';
import { TokenUsagesManager } from './usagesManager';
import { DateUtils } from './fileLogger/dateUtils';
import { Logger } from '../utils/runtime/logger';

export function registerUsageRefreshHandlers(context: vscode.ExtensionContext): void {
    context.subscriptions.push(
        InterInstanceBus.subscribe('statsRefreshRequested', event => {
            if (!LeaderElectionService.isLeader()) {
                return;
            }
            const payload = event.payload as {
                requestId: string;
                date?: string;
                regenerateAll: boolean;
                requestedBy: string;
            };
            Logger.trace(
                `[InterInstanceBus] Received statsRefreshRequested from ${payload.requestedBy}` +
                    (payload.regenerateAll ? ' (regenerateAll)' : ` (date=${payload.date ?? 'today'})`)
            );
            const fileLogger = TokenUsagesManager.instance.getFileLogger();
            void (async () => {
                try {
                    await fileLogger.flush();
                    if (payload.regenerateAll) {
                        const results = await fileLogger.regenerateOutdatedStats();
                        InterInstanceBus.publish(
                            {
                                type: 'statsRefreshCompleted',
                                payload: { requestId: payload.requestId, regeneratedDates: Object.keys(results) }
                            },
                            { alsoFallback: true }
                        );
                        TokenUsagesManager.instance.notifyStatsUpdate();
                        return;
                    }

                    const dateStr = payload.date ?? DateUtils.getTodayDateString();
                    // 每日 context 只读：自动刷新只处理今日，历史日期不在此路径上重算。
                    if (dateStr !== DateUtils.getTodayDateString()) {
                        InterInstanceBus.publish(
                            {
                                type: 'statsRefreshCompleted',
                                payload: { requestId: payload.requestId, regeneratedDates: [] }
                            },
                            { alsoFallback: true }
                        );
                        return;
                    }
                    await fileLogger.getDateStats(dateStr);
                    InterInstanceBus.publish(
                        {
                            type: 'statsRefreshCompleted',
                            payload: { requestId: payload.requestId, regeneratedDates: [dateStr] }
                        },
                        { alsoFallback: true }
                    );
                    TokenUsagesManager.instance.notifyStatsUpdate();
                } catch (error) {
                    Logger.warn(`[InterInstanceBus] Failed to refresh stats: ${error}`);
                    InterInstanceBus.publish(
                        {
                            type: 'statsRefreshCompleted',
                            payload: { requestId: payload.requestId, regeneratedDates: [] }
                        },
                        { alsoFallback: true }
                    );
                }
            })();
        })
    );

    LeaderElectionService.registerPeriodicTask(async () => {
        try {
            const fileLogger = TokenUsagesManager.instance.getFileLogger();
            const today = DateUtils.getTodayDateString();
            await fileLogger.flush();
            await fileLogger.getDateStats(today);
            TokenUsagesManager.instance.notifyStatsUpdate();
        } catch (error) {
            Logger.trace(`[LeaderTask] Failed to refresh today stats: ${error}`);
        }
    });
}
