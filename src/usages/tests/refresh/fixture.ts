import assert from 'node:assert/strict';
import { AsyncResource } from 'node:async_hooks';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { performance } from 'node:perf_hooks';
import { join } from 'node:path';
import type { Mock, TestContext } from 'node:test';
import type * as vscode from 'vscode';
import { DateUtils } from '../../fileLogger/dateUtils';
import type { TokenRequestLog, TokenUsageStatsFromFile } from '../../fileLogger/types';
import { createUsageHost, type LoggerInternals } from '../hostFixture';

export type UsageHost = Awaited<ReturnType<typeof createUsageHost>>;
export const nextTurn = () => new Promise<void>(resolve => setImmediate(resolve));
export async function until(condition: () => boolean): Promise<void> {
    const deadline = performance.now() + 3000;
    while (!condition()) {
        assert.ok(performance.now() < deadline, 'refresh did not settle');
        await new Promise<void>(resolve => setTimeout(resolve, 5));
    }
    await nextTurn();
}
export function gate() {
    let release!: () => void;
    const promise = new Promise<void>(resolve => {
        release = resolve;
    });
    return { promise, release };
}
export function refreshClock(context: TestContext) {
    const original = globalThis.setTimeout;
    const pending = new Map<NodeJS.Timeout, () => void>();
    context.mock.method(globalThis, 'setTimeout', ((...args: Parameters<typeof setTimeout>) => {
        if (args[1] !== 1000) {
            return original(...args);
        }
        const timer = original(() => {}, 60000);
        timer.unref();
        pending.set(
            timer,
            AsyncResource.bind(() => args[0](undefined))
        );
        return timer;
    }) as typeof setTimeout);
    context.after(() => {
        for (const timer of pending.keys()) {
            clearTimeout(timer);
        }
    });
    return {
        fire() {
            for (const [timer, callback] of [...pending]) {
                pending.delete(timer);
                clearTimeout(timer);
                callback();
            }
        },
        async settle(condition: () => boolean) {
            const deadline = performance.now() + 3000;
            while (!condition()) {
                assert.ok(performance.now() < deadline, 'scheduled refresh did not settle');
                this.fire();
                await new Promise<void>(resolve => original(resolve, 5));
            }
            await nextTurn();
        }
    };
}
interface StatsInternals {
    calculateDateStats(date: string, force: boolean): Promise<TokenUsageStatsFromFile>;
}
export async function refreshFixture(
    host: UsageHost,
    context: TestContext,
    id = 'leader',
    shared?: vscode.ExtensionContext
) {
    const f = await host.fixture(context, id);
    if (shared) {
        await f.fileLogger.dispose();
        const { TokenFileLogger } = await import('../../fileLogger');
        f.fileLogger = host.run(id, () => new TokenFileLogger(shared));
        f.internals = f.fileLogger as unknown as LoggerInternals;
        Object.assign(f.manager, { fileLogger: f.fileLogger });
    } else {
        (f.internals.refreshCurrentStats as Mock<LoggerInternals['refreshCurrentStats']>).mock.restore();
    }
    const date = DateUtils.getTodayDateString();
    const counters = {
        calculations: 0,
        active: 0,
        peak: 0,
        notifications: 0,
        refreshes: 0,
        readsActive: 0,
        refreshesActive: 0
    };
    const getStats = f.internals.logStatsManager.getDateStats.bind(f.internals.logStatsManager);
    context.mock.method(f.internals.logStatsManager, 'getDateStats', async (...args: Parameters<typeof getStats>) => {
        counters.readsActive++;
        try {
            return await getStats(...args);
        } finally {
            counters.readsActive--;
        }
    });
    const stats = f.internals.logStatsManager as unknown as StatsInternals;
    const calculate = stats.calculateDateStats.bind(stats);
    context.mock.method(stats, 'calculateDateStats', async (...args: Parameters<typeof calculate>) => {
        counters.calculations++;
        counters.active++;
        counters.peak = Math.max(counters.peak, counters.active);
        try {
            return await calculate(...args);
        } finally {
            counters.active--;
        }
    });
    const refresh = f.internals.doRefreshCurrentStats.bind(f.internals);
    context.mock.method(f.internals, 'doRefreshCurrentStats', async (...args: Parameters<typeof refresh>) => {
        counters.refreshes++;
        counters.refreshesActive++;
        try {
            return await refresh(...args);
        } finally {
            counters.refreshesActive--;
        }
    });
    const listener = f.manager.onStatsUpdate(() => counters.notifications++);
    context.after(() => listener.dispose());
    return {
        ...f,
        id,
        date,
        counters,
        settled() {
            return until(() => counters.readsActive === 0 && counters.refreshesActive === 0);
        },
        async seed(count = 8) {
            const timestamp = Date.now();
            const rows: TokenRequestLog[] = Array.from({ length: count }, (_, i) => ({
                requestId: `${timestamp}_${id}_${i}`,
                timestamp,
                isoTime: new Date(timestamp).toISOString(),
                providerKey: 'test',
                providerName: 'Test',
                modelId: 'test',
                modelName: 'Test',
                estimatedInput: 10,
                rawUsage: null,
                status: 'estimated'
            }));
            const path = f.internals.pathManager.getLogPathFromDate(new Date(timestamp));
            await mkdir(path.dateFolder, { recursive: true });
            await writeFile(path.fullPath, rows.map(row => JSON.stringify(row)).join('\n') + '\n');
            const pending = (f.fileLogger as unknown as { pendingLogs: Map<string, TokenRequestLog> }).pendingLogs;
            for (const row of rows) {
                pending.set(row.requestId, row);
            }
            const stats = await host.run('leader', () => f.fileLogger.getDateStats(date, true));
            await f.internals.logStatsManager.markStatsPublished(date, stats);
            counters.calculations = 0;
            counters.peak = 0;
            return rows.map(row => row.requestId);
        },
        async idleWrites() {
            await f.fileLogger.flush();
            const reads = f.manager as unknown as { dateStatsReads: Map<string, Promise<unknown>> };
            await Promise.allSettled([...reads.dateStatsReads.values()]);
            await nextTurn();
        },
        saved() {
            return readFile(join(shared?.globalStorageUri.fsPath ?? f.dir, 'usages', date, 'stats.json'), 'utf8').then(
                value => JSON.parse(value) as TokenUsageStatsFromFile
            );
        },
        broadcasts() {
            return host.events.filter(
                item => item.event.type === 'tokenUsageUpdated' && item.event.senderInstanceId === id
            );
        },
        holdRead() {
            const entered = gate(),
                blocked = gate();
            const original = f.internals.readManager.readHourLogs.bind(f.internals.readManager);
            let first = true;
            context.mock.method(
                f.internals.readManager,
                'readHourLogs',
                async (...args: Parameters<typeof original>) => {
                    const value = await original(...args);
                    if (first) {
                        first = false;
                        entered.release();
                        await blocked.promise;
                    }
                    return value;
                }
            );
            return { entered: entered.promise, release: blocked.release };
        }
    };
}
export const terminal = (requestId: string) => ({
    requestId,
    status: 'completed' as const,
    rawUsage: { prompt_tokens: 10, completion_tokens: 5 }
});
