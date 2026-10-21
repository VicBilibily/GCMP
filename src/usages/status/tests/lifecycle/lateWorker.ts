import assert from 'node:assert/strict';
import { fork } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { TokenFileLogger } from '../../../fileLogger';
import type { DateIndex, TokenUsageStatsFromFile } from '../../../fileLogger/types';
import { createUsageHost, type LoggerInternals } from '../../../tests/hostFixture';
import { bounded } from '../../../tests/refresh/publication/fixture';

export type PublicationState = 'pending' | 'acknowledged';
export interface WorkerReport {
    kind: 'saved';
    pid: number;
    requests: number;
    disk: number;
    index: number;
    unowned: boolean;
    stale: boolean;
    acknowledged: boolean;
    pendingRequests?: number;
}
type WorkerMessage = WorkerReport | { kind: 'failure'; message: string };

export async function externalCommit(
    dir: string,
    date: string,
    state: PublicationState,
    signal: AbortSignal
): Promise<WorkerReport> {
    const child = fork(
        fileURLToPath(new URL('./lateWorker.ts', import.meta.url)),
        ['--lifecycle-worker', dir, date, state],
        {
            cwd: fileURLToPath(new URL('../../../../../', import.meta.url)),
            execArgv: ['--import=tsx'],
            stdio: ['ignore', 'pipe', 'pipe', 'ipc']
        }
    );
    let report: WorkerReport | undefined;
    let failure: string | undefined;
    let stderr = '';
    let ended = false;
    child.stdout?.resume();
    child.stderr?.on('data', (chunk: Buffer) => {
        stderr = (stderr + chunk.toString()).slice(-8192);
    });
    child.on('error', (error: Error) => {
        failure = error.message;
    });
    child.on('message', (message: WorkerMessage) => {
        if (message.kind === 'saved') {
            report = message;
        } else {
            failure = message.message;
        }
    });
    const closed = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(resolve => {
        child.once('close', (code, exitSignal) => {
            ended = true;
            resolve({ code, signal: exitSignal });
        });
    });
    try {
        const exit = await bounded(closed, 'external writer normal exit', 25000, signal);
        assert.deepEqual(exit, { code: 0, signal: null }, failure ?? stderr);
        assert.equal(failure, undefined);
        assert.ok(report, stderr);
        assert.notEqual(report.pid, process.pid);
        assert.equal(report.requests, 3);
        assert.equal(report.disk, 3);
        assert.equal(report.index, 3);
        assert.equal(report.unowned, true);
        assert.equal(report.stale, false);
        assert.equal(report.acknowledged, state === 'acknowledged');
        assert.equal(report.pendingRequests, 3);
        return report;
    } finally {
        if (!ended) {
            child.kill();
        }
        await bounded(closed, 'owned worker terminal cleanup', 5000);
    }
}

async function send(message: WorkerMessage): Promise<void> {
    await new Promise<void>((resolve, reject) => {
        if (!process.send || !process.connected) {
            reject(new Error('Parent IPC disconnected'));
            return;
        }
        process.send(message, undefined, undefined, error => (error ? reject(error) : resolve()));
    });
}

async function workerMain(): Promise<void> {
    const [, dir, date, state] = process.argv.slice(2);
    const host = await createUsageHost();
    let logger: TokenFileLogger | undefined;
    try {
        if (!dir || !date || (state !== 'pending' && state !== 'acknowledged')) {
            throw new Error('Invalid lifecycle worker arguments');
        }
        host.state.leaderId = undefined;
        const { TokenFileLogger } = await import('../../../fileLogger');
        const { StatsPublication } = await import('../../../fileLogger/refresh/statsPublication');
        logger = new TokenFileLogger({
            globalStorageUri: { fsPath: dir },
            extensionPath: dir,
            subscriptions: []
        } as unknown as ConstructorParameters<typeof TokenFileLogger>[0]);
        await logger.recordEstimatedTokens({
            requestId: `${Date.now()}_external_${process.pid}`,
            providerKey: 'test',
            providerName: 'Test',
            modelId: 'test',
            modelName: 'Test',
            estimatedInput: 10
        });
        await logger.flush();
        const stats = await logger.getDateStats(date, true);
        if (state === 'acknowledged') {
            await (logger as unknown as LoggerInternals).logStatsManager.markStatsPublished(date, stats);
        }
        const statsPath = join(dir, 'usages', date, 'stats.json');
        const disk = JSON.parse(await readFile(statsPath, 'utf8')) as TokenUsageStatsFromFile;
        const index = JSON.parse(await readFile(join(dir, 'usages', 'index.json'), 'utf8')) as DateIndex;
        const pending = await new StatsPublication().readPendingStats(statsPath);
        await send({
            kind: 'saved',
            pid: process.pid,
            requests: stats.total.requests,
            disk: disk.total.requests,
            index: index.dates[date].total_requests,
            unowned: host.state.leaderId === undefined,
            stale: logger.getStatsSource(stats)?.stale === true,
            acknowledged: state === 'acknowledged',
            pendingRequests: pending?.total.requests
        });
    } catch (error) {
        process.exitCode = 1;
        await send({ kind: 'failure', message: error instanceof Error ? error.message : String(error) }).catch(
            () => undefined
        );
    } finally {
        try {
            await logger?.dispose();
        } finally {
            host.restore();
            if (process.connected) {
                process.disconnect();
            }
        }
    }
}

if (process.argv[2] === '--lifecycle-worker') {
    void workerMain().catch((error: unknown) => {
        console.error(error);
        process.exitCode = 1;
        if (process.connected) {
            process.disconnect();
        }
    });
}
