import assert from 'node:assert/strict';
import { readFile, stat, utimes } from 'node:fs/promises';
import { join } from 'node:path';
import type { TestContext } from 'node:test';
import type * as vscode from 'vscode';
import { DateUtils } from '../fileLogger/dateUtils';
import type { TokenRequestLog, TokenUsageStatsFromFile } from '../fileLogger/types';
import type { MultiDayAnalysisResult } from '../multiDay/types';
import { createUsageHost, type LoggerInternals } from './hostFixture';

export type UsageHost = Awaited<ReturnType<typeof createUsageHost>>;

export interface SnapshotStatsInternals {
    needsRegeneration(date: string): Promise<boolean>;
    getOutdatedDates(): Promise<string[]>;
    loadStats(date: string): Promise<TokenUsageStatsFromFile | null>;
}

export function snapshotRow(date: string, suffix = 'first', hour = 9): TokenRequestLog {
    const timestamp = new Date(`${date}T${String(hour).padStart(2, '0')}:00:00`).getTime();
    return {
        requestId: `${timestamp}_${suffix}`,
        timestamp,
        isoTime: new Date(timestamp).toISOString(),
        providerKey: 'test',
        providerName: 'Test',
        modelId: 'test',
        modelName: 'Test',
        estimatedInput: 10,
        status: 'completed',
        rawUsage: { prompt_tokens: 10, completion_tokens: 5 },
        sessionId: 'snapshot-session',
        sessionTitle: '原始标题',
        streamStartTime: timestamp + 100,
        streamEndTime: timestamp + 1000
    };
}

export function gate() {
    let release!: () => void;
    const promise = new Promise<void>(resolve => {
        release = resolve;
    });
    return { promise, release };
}

export async function snapshotFixture(host: UsageHost, context: TestContext) {
    host.reset();
    const f = await host.fixture(context, 'leader');
    const date = DateUtils.getDateStringDaysAgo(7);
    const row = snapshotRow(date);
    f.internals.logStatsManager.updateCodeVersionTimestamp(1);
    await f.internals.snapshotManager.buildSnapshotFromLogs(date, [row]);
    const statsPath = join(f.dir, 'usages', date, 'stats.json');
    const snapshotPath = f.internals.pathManager.getSnapshotFilePath(date);
    const statsTime = Math.floor(Date.now() / 1000) * 1000 - 3000;
    await utimes(snapshotPath, new Date(statsTime - 3000), new Date(statsTime - 3000));
    await f.fileLogger.getDateStats(date);
    await utimes(statsPath, new Date(statsTime), new Date(statsTime));
    const privateStats = f.internals.logStatsManager as unknown as SnapshotStatsInternals;
    assert.equal(await privateStats.needsRegeneration(date), false);
    const originalStats = await readFile(statsPath, 'utf8');
    async function changeTitle(title = '回填标题') {
        assert.equal(
            await f.fileLogger.backfillSessionTitle({
                requestId: row.requestId,
                sessionId: row.sessionId!,
                sessionTitle: title
            }),
            true
        );
    }
    async function equalMtime() {
        const time = (await stat(statsPath)).mtime;
        await utimes(snapshotPath, time, time);
        assert.equal((await stat(snapshotPath)).mtimeMs, (await stat(statsPath)).mtimeMs);
    }
    return { ...f, date, row, statsPath, snapshotPath, privateStats, originalStats, changeTitle, equalMtime };
}

export async function sharedSnapshotFixture(host: UsageHost, context: TestContext) {
    const leader = await snapshotFixture(host, context);
    const follower = await host.fixture(context, 'follower');
    await follower.fileLogger.dispose();
    const { TokenFileLogger } = await import('../fileLogger');
    const sharedLogger = host.run('follower', () => new TokenFileLogger(leader.extensionContext));
    Object.assign(follower.manager, { fileLogger: sharedLogger });
    follower.fileLogger = sharedLogger;
    follower.internals = sharedLogger as unknown as LoggerInternals;
    follower.internals.logStatsManager.updateCodeVersionTimestamp(1);
    context.mock.method(follower.internals, 'refreshCurrentStats', () => {});
    const background = new Set<Promise<unknown>>();
    const getStats = leader.manager.getDateStats.bind(leader.manager);
    context.mock.method(leader.manager, 'getDateStats', (...args: Parameters<typeof getStats>) => {
        const work = getStats(...args);
        background.add(work);
        void work.then(
            () => background.delete(work),
            () => background.delete(work)
        );
        return work;
    });
    const { registerUsageRefreshHandlers } = await import('../usageActivation');
    host.run('leader', () => registerUsageRefreshHandlers(leader.extensionContext));
    return { leader, follower, background };
}

export async function snapshotPage(
    host: UsageHost,
    context: TestContext,
    extensionContext: vscode.ExtensionContext,
    date: string,
    background: Set<Promise<unknown>>
) {
    const { MultiDayView } = await import('../../ui/multiDayView');
    interface Query {
        command: string;
        dateFrom: string;
        dateTo: string;
        requestId: number;
    }
    interface Reply {
        command: string;
        data?: MultiDayAnalysisResult;
    }
    let receive!: (message: Query) => Promise<void>;
    let onDispose: (() => void) | undefined;
    let queries = 0;
    const pending = new Set<Promise<void>>();
    const messages: Reply[] = [];
    const failures: unknown[] = [];
    function query() {
        const work = host.run('follower', () =>
            receive({
                command: 'getMultiDayAnalysis',
                dateFrom: date,
                dateTo: date,
                requestId: ++queries
            })
        );
        pending.add(work);
        void work.then(
            () => pending.delete(work),
            error => {
                pending.delete(work);
                failures.push(error);
            }
        );
        return work;
    }
    host.state.createPanel = () =>
        ({
            webview: {
                html: '',
                onDidReceiveMessage(callback: typeof receive) {
                    receive = callback;
                    return { dispose() {} };
                },
                postMessage(message: Reply) {
                    messages.push(message);
                    if (message.command === 'refreshMultiDayAnalysis') {
                        void query();
                    }
                    return Promise.resolve(true);
                }
            },
            onDidDispose(callback: () => void) {
                onDispose = callback;
                return { dispose() {} };
            },
            reveal() {},
            dispose() {
                onDispose?.();
            }
        }) as unknown as vscode.WebviewPanel;
    const view = host.run('follower', () => new MultiDayView(extensionContext));
    context.mock.method(view as unknown as { getWebviewContent(): string }, 'getWebviewContent', () => '');
    host.run('follower', () => view.show());
    context.after(() => view.dispose());
    return {
        view,
        query,
        messages,
        get queries() {
            return queries;
        },
        async settle() {
            do {
                await Promise.all([...pending, ...background]);
                await new Promise<void>(resolve => setImmediate(resolve));
            } while (pending.size || background.size);
            assert.deepEqual(failures, []);
            assert.equal(
                messages.some(message => message.command === 'multiDayError'),
                false
            );
        }
    };
}
