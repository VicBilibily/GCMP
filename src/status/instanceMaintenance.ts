import * as vscode from 'vscode';
import { LeaderElectionService } from './leaderElectionService';
import { UserActivityService } from './userActivityService';
import { StatusLogger } from '../utils/runtime/statusLogger';

export function registerInstanceMaintenanceTask(
    context: vscode.ExtensionContext,
    task: () => Promise<void>
): vscode.Disposable {
    const remoteName = vscode.env.remoteName;
    let disposed = false;
    let inFlight = false;
    let timer: NodeJS.Timeout | undefined;
    const run = async (): Promise<void> => {
        if (
            disposed ||
            inFlight ||
            vscode.env.remoteName !== remoteName ||
            (remoteName !== undefined && !UserActivityService.isUserActive())
        ) {
            return;
        }
        inFlight = true;
        try {
            await task();
        } catch (error) {
            StatusLogger.warn('[InstanceMaintenance] Periodic task failed:', error);
        } finally {
            inFlight = false;
        }
    };
    if (remoteName === undefined) {
        LeaderElectionService.registerPeriodicTask(run);
    } else {
        timer = setInterval(run, 60_000);
    }
    const registration = new vscode.Disposable(() => {
        disposed = true;
        if (timer) {
            clearInterval(timer);
            timer = undefined;
        }
    });
    context.subscriptions.push(registration);
    return registration;
}
