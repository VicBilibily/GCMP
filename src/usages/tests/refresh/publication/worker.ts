import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { TokenFileLogger } from '../../../fileLogger';
import type { StatsPublication } from '../../../fileLogger/refresh/statsPublication';
import type { DateIndex, TokenUsageStatsFromFile } from '../../../fileLogger/types';
import { createUsageHost, type LoggerInternals } from '../../hostFixture';
import { gate, snapshotRow } from '../../snapshotFixture';

export interface PublicationInternals {
    publication: StatsPublication;
    calculateDateStats(date: string, force: boolean): Promise<TokenUsageStatsFromFile>;
    saveDateStats(
        date: string,
        stats: TokenUsageStatsFromFile,
        term: string | undefined,
        permission: () => boolean,
        expectedVersion: string
    ): Promise<boolean>;
}
interface Prepared {
    kind: 'prepared';
    pid: number;
    fingerprint: string;
    expectedVersion: string;
    requests: number;
    unowned: boolean;
    canCommit: boolean;
}
interface Saved {
    kind: 'saved';
    requests: number;
    diskRequests: number;
    indexRequests: number;
    snapshotRequests: number;
    fingerprint: string;
    stale: boolean;
    publications: number;
}
export type PublicationReport = Prepared | Saved | { kind: 'failure'; message: string };

async function sendReport(report: PublicationReport): Promise<void> {
    await new Promise<void>((resolve, reject) => {
        if (!process.send || !process.connected) {
            reject(new Error('Parent IPC disconnected'));
            return;
        }
        process.send(report, undefined, undefined, error => (error ? reject(error) : resolve()));
    });
}

async function workerMain(): Promise<void> {
    const [, dir, date] = process.argv.slice(2);
    const commit = gate();
    let stopped = false;
    const stop = () => {
        stopped = true;
        commit.release();
    };
    const onCommand = (message: unknown) => {
        if (message === 'commit') {
            commit.release();
        } else if (message === 'stop') {
            stop();
        }
    };
    process.on('message', onCommand);
    process.once('disconnect', stop);
    const watchdog = setTimeout(() => {
        commit.release();
        console.error('Publication worker lifetime deadline exceeded');
        process.exit(1);
    }, 45000);
    watchdog.unref();
    let host: Awaited<ReturnType<typeof createUsageHost>> | undefined;
    let logger: TokenFileLogger | undefined;
    try {
        if (!dir || !date) {
            throw new Error('Missing worker directory/date');
        }
        host = await createUsageHost();
        host.state.leaderId = undefined;
        const { TokenFileLogger } = await import('../../../fileLogger');
        logger = new TokenFileLogger({
            globalStorageUri: { fsPath: dir },
            extensionPath: dir,
            subscriptions: []
        } as unknown as ConstructorParameters<typeof TokenFileLogger>[0]);
        const internals = logger as unknown as LoggerInternals;
        internals.logStatsManager.updateCodeVersionTimestamp(1);
        if (stopped) {
            return;
        }
        await internals.snapshotManager.upsertRecord(date, snapshotRow(date, 'third', 11));
        const snapshotRequests = (await internals.snapshotManager.read(date))?.length ?? 0;
        const stats = internals.logStatsManager as unknown as PublicationInternals;
        const save = stats.saveDateStats.bind(stats);
        const prepare = stats.publication.prepare.bind(stats.publication);
        let expectedVersion = '',
            requests = 0,
            fingerprint = '';
        stats.saveDateStats = (...args: Parameters<typeof save>) => {
            expectedVersion = args[4];
            requests = args[1].total.requests;
            return save(...args);
        };
        const workerHost = host;
        stats.publication.prepare = async (...args: Parameters<typeof prepare>) => {
            await prepare(...args);
            fingerprint = args[1];
            await sendReport({
                kind: 'prepared',
                pid: process.pid,
                fingerprint,
                expectedVersion,
                requests,
                unowned: workerHost.state.leaderId === undefined,
                canCommit: args[3]?.() === true
            });
            await commit.promise;
            if (stopped) {
                throw new Error('Worker stopped before statistics commit');
            }
        };
        if (stopped) {
            return;
        }
        const result = await logger.getDateStats(date, true);
        const saved = JSON.parse(
            await readFile(join(dir, 'usages', date, 'stats.json'), 'utf8')
        ) as TokenUsageStatsFromFile;
        const index = JSON.parse(await readFile(join(dir, 'usages', 'index.json'), 'utf8')) as DateIndex;
        await sendReport({
            kind: 'saved',
            requests: result.total.requests,
            diskRequests: saved.total.requests,
            indexRequests: index.dates[date].total_requests,
            snapshotRequests,
            fingerprint,
            stale: logger.getStatsSource(result)?.stale === true,
            publications: host.events.filter(item => item.event.type === 'tokenUsageUpdated').length
        });
    } catch (error) {
        if (!stopped) {
            process.exitCode = 1;
            await sendReport({
                kind: 'failure',
                message: error instanceof Error ? error.message : String(error)
            }).catch(() => undefined);
        }
    } finally {
        commit.release();
        try {
            await logger?.dispose();
        } finally {
            host?.restore();
            process.off('message', onCommand);
            process.off('disconnect', stop);
            if (process.connected) {
                process.disconnect();
            }
            clearTimeout(watchdog);
        }
    }
}

if (process.argv[2] === '--publication-worker') {
    void workerMain().catch((error: unknown) => {
        console.error(error instanceof Error ? error.message : String(error));
        process.exitCode = 1;
        if (process.connected) {
            process.disconnect();
        }
    });
}
