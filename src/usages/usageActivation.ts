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
                    if (payload.regenerateAll) {
                        await fileLogger.flush();
                        const results = await fileLogger.regenerateOutdatedStats();
                        const regeneratedDates = Object.keys(results);
                        InterInstanceBus.publish(
                            {
                                type: 'statsRefreshCompleted',
                                payload: { requestId: payload.requestId, regeneratedDates }
                            },
                            { alsoFallback: true }
                        );
                        for (const date of regeneratedDates) {
                            TokenUsagesManager.instance.notifyStatsUpdate({
                                date,
                                stats: results[date],
                                changed: true,
                                delegated: false
                            });
                        }
                        return;
                    }

                    const dateStr = payload.date ?? DateUtils.getTodayDateString();
                    const result = await fileLogger.refreshStats(dateStr, true);
                    InterInstanceBus.publish(
                        {
                            type: 'statsRefreshCompleted',
                            payload: { requestId: payload.requestId, regeneratedDates: result ? [dateStr] : [] }
                        },
                        { alsoFallback: true }
                    );
                    if (result) {
                        TokenUsagesManager.instance.notifyStatsUpdate(result);
                    }
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

    let periodicRefreshInFlight = false;
    LeaderElectionService.registerPeriodicTask(async () => {
        if (periodicRefreshInFlight) {
            return;
        }
        periodicRefreshInFlight = true;
        try {
            const fileLogger = TokenUsagesManager.instance.getFileLogger();
            if (LeaderElectionService.getOwnedAuthorityTerm?.()) {
                try {
                    await fileLogger.getIndex();
                } catch (error) {
                    Logger.trace(`[LeaderTask] Failed to reconcile usage index: ${error}`);
                }
            }
            const today = DateUtils.getTodayDateString();
            const result = await fileLogger.refreshStats(today);
            if (result) {
                TokenUsagesManager.instance.notifyStatsUpdate(result);
            }
            await fileLogger.recoverStatsPublications(
                pending => TokenUsagesManager.instance.notifyStatsUpdate(pending),
                [today]
            );
        } catch (error) {
            Logger.trace(`[LeaderTask] Failed to refresh today stats: ${error}`);
        } finally {
            periodicRefreshInFlight = false;
        }
    });
}
