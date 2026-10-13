import type * as vscode from 'vscode';
import { createUsageHost } from '../../../tests/hostFixture';

async function main(): Promise<void> {
    const [dir, date, startup] = process.argv.slice(2);
    const host = await createUsageHost();
    if (startup === 'startup') {
        host.state.leaderId = undefined;
    }
    const { TokenFileLogger } = await import('../../../fileLogger');
    const logger = new TokenFileLogger({
        globalStorageUri: { fsPath: dir },
        extensionPath: dir,
        subscriptions: []
    } as unknown as vscode.ExtensionContext);
    try {
        (
            logger as unknown as { logStatsManager: { updateCodeVersionTimestamp(value: number): void } }
        ).logStatsManager.updateCodeVersionTimestamp(1);
        const stats = await logger.getDateStats(date, true);
        process.stdout.write(JSON.stringify({ requests: stats.total.requests }));
    } finally {
        await logger.dispose();
        host.restore();
    }
}
void main().catch(error => {
    console.error(error);
    process.exitCode = 1;
});
