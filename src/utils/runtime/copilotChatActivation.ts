import * as vscode from 'vscode';
import { Logger } from './logger';

export function activateCopilotChatInBackground(refreshModels: () => void): vscode.Disposable {
    let disposed = false;
    const disposable = new vscode.Disposable(() => {
        disposed = true;
    });

    void (async () => {
        try {
            const extension = vscode.extensions.getExtension('github.copilot-chat');
            if (!extension) {
                return;
            }
            await extension.activate();
        } catch {
            if (!disposed) {
                Logger.warn('Copilot Chat activation unavailable; model information refresh may be delayed');
            }
            return;
        }

        if (disposed) {
            return;
        }

        try {
            refreshModels();
        } catch {
            if (!disposed) {
                Logger.warn('Model information refresh failed after Copilot Chat activation');
            }
        }
    })();

    return disposable;
}
