import assert from 'node:assert/strict';
import { stat, utimes, writeFile } from 'node:fs/promises';
import type { TestContext } from 'node:test';
import { AtomicJsonFile } from '../../atomicJsonFile';
import type { TokenFileLogger } from '../../fileLogger';
import type { TokenUsageStatsFromFile } from '../../fileLogger/types';
import type { LoggerInternals } from '../hostFixture';
import { gate, snapshotRow, type snapshotFixture, type UsageHost } from '../snapshotFixture';

export type RecoveryFixture = Awaited<ReturnType<typeof snapshotFixture>>;
export type BoundStats = TokenUsageStatsFromFile & { snapshotSourceVersion?: string };

export async function initializeLogger(
    host: UsageHost,
    context: TestContext,
    logger: TokenFileLogger,
    owner = 'leader'
): Promise<void> {
    const { snapshotManager } = logger as unknown as LoggerInternals;
    const entered = gate();
    const original = snapshotManager.sanitizeHistoricalSnapshots.bind(snapshotManager);
    let work: Promise<number> | undefined;
    const wrapped = context.mock.method(
        snapshotManager,
        'sanitizeHistoricalSnapshots',
        (...args: Parameters<typeof original>) => {
            work = original(...args);
            entered.release();
            return work;
        }
    );
    try {
        await host.run(owner, () => logger.initialize());
        await entered.promise;
        assert.ok(work);
        await work;
    } finally {
        wrapped.mock.restore();
    }
}

export async function rebuildWithLateWrite(
    f: RecoveryFixture,
    context: TestContext,
    source: 'snapshot' | 'raw',
    phase: 'snapshot-read' | 'stats-write' = 'snapshot-read'
): Promise<void> {
    const { SnapshotManager } = await import('../../fileLogger/snapshotManager');
    await f.internals.snapshotManager.upsertRecord(f.date, snapshotRow(f.date, 'second', 10));
    const entered = gate();
    const release = gate();
    let first = true;
    let blocked: { mock: { restore(): void } };
    if (phase === 'snapshot-read') {
        const read = f.internals.snapshotManager.read.bind(f.internals.snapshotManager);
        blocked = context.mock.method(f.internals.snapshotManager, 'read', async (date: string) => {
            const records = await read(date);
            if (first && date === f.date) {
                first = false;
                entered.release();
                await release.promise;
            }
            return records;
        });
    } else {
        const write = AtomicJsonFile.writeJsonAtomically.bind(AtomicJsonFile);
        blocked = context.mock.method(
            AtomicJsonFile,
            'writeJsonAtomically',
            async (...args: Parameters<typeof write>) => {
                if (first && args[0] === f.statsPath) {
                    first = false;
                    entered.release();
                    await release.promise;
                }
                return write(...args);
            }
        );
    }
    const reading = f.fileLogger.getDateStats(f.date);
    try {
        await entered.promise;
        const external = new SnapshotManager(f.internals.pathManager, () => {});
        const late = snapshotRow(f.date, 'third', 11);
        const sourcePath = source === 'raw' ? f.internals.pathManager.getHourFilePath(f.date, 11) : f.snapshotPath;
        if (source === 'raw') {
            await writeFile(sourcePath, JSON.stringify(late) + '\n', { flag: 'wx' });
        } else {
            await external.upsertRecord(f.date, late);
        }
        const sourceTime = new Date(Date.now() - 1000);
        await utimes(sourcePath, sourceTime, sourceTime);
        release.release();
        assert.equal((await reading).total.requests, 2);
        assert.equal((await external.read(f.date))?.length, 3);
        assert.ok((await stat(sourcePath)).mtimeMs < (await stat(f.statsPath)).mtimeMs);
        assert.equal(await f.privateStats.needsRegeneration(f.date), true);
    } finally {
        release.release();
        await reading;
        blocked.mock.restore();
    }
}
