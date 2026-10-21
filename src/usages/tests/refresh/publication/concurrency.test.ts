import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { access, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';
import type { DateIndex, TokenUsageStatsFromFile } from '../../../fileLogger/types';
import { getFileVersionSync } from '../../../persistence/versionedJsonFile';
import { createUsageHost } from '../../hostFixture';
import { gate, snapshotFixture, snapshotRow } from '../../snapshotFixture';
import { bounded, startWorker } from './fixture';
import type { PublicationInternals } from './worker';

const fingerprint = (value: TokenUsageStatsFromFile) =>
    createHash('sha256').update(JSON.stringify(value)).digest('hex');
interface StatsLocation {
    dir: string;
    date: string;
    statsPath: string;
}
async function exists(path: string): Promise<boolean> {
    try {
        await access(path);
        return true;
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
            throw error;
        }
        return false;
    }
}
async function observe(f: StatsLocation) {
    const folder = join(f.dir, 'usages', f.date);
    const stats = JSON.parse(await readFile(f.statsPath, 'utf8')) as TokenUsageStatsFromFile;
    const index = JSON.parse(await readFile(join(f.dir, 'usages', 'index.json'), 'utf8')) as DateIndex;
    const statsFingerprint = fingerprint(stats);
    return {
        stats: stats.total.requests,
        index: index.dates[f.date].total_requests,
        statsFingerprint,
        markerExists: await exists(join(folder, 'stats-publication.json')),
        acknowledgementExists: await exists(join(folder, 'stats-published.json')),
        statsVersion: getFileVersionSync(f.statsPath),
        statsCommitLock: await exists(`${f.statsPath}.commit.lock`),
        markerCommitLock: await exists(join(folder, 'stats-publication.json.commit.lock'))
    };
}

test(
    'unowned concurrent publication must recover the committed S3 after worker exit',
    { timeout: 120000 },
    async suite => {
        const host = await createUsageHost();
        const { StatsPublication } = await import('../../../fileLogger/refresh/statsPublication');
        try {
            for (const scenario of ['control: A reaches save first', 'race: B reaches save first'] as const) {
                await suite.test(scenario, { timeout: 55000 }, async c => {
                    const f = await snapshotFixture(host, c);
                    const initial = JSON.parse(f.originalStats) as TokenUsageStatsFromFile;
                    await f.internals.logStatsManager.markStatsPublished(f.date, initial);
                    assert.equal(initial.total.requests, 1);
                    assert.deepEqual(await new StatsPublication().readPendingStats(f.statsPath), initial);
                    const initialVersion = getFileVersionSync(f.statsPath);
                    assert.equal((await observe(f)).acknowledgementExists, false);
                    host.state.leaderId = undefined;
                    await f.internals.snapshotManager.upsertRecord(f.date, snapshotRow(f.date, 'second', 10));
                    const stats = f.internals.logStatsManager as unknown as PublicationInternals;
                    const calculate = stats.calculateDateStats.bind(stats);
                    const save = stats.saveDateStats.bind(stats);
                    const permission = f.internals.logStatsManager.captureWritePermission();
                    const calculated = gate(),
                        allowPrepare = gate(),
                        prepared = gate(),
                        allowSave = gate();
                    let aCalculated = 0,
                        aPrepares = 0;
                    let aVersion = '',
                        aFingerprint = '';
                    c.mock.method(stats, 'calculateDateStats', async (...args: Parameters<typeof calculate>) => {
                        const result = await calculate(...args);
                        aCalculated = result.total.requests;
                        calculated.release();
                        await allowPrepare.promise;
                        return result;
                    });
                    c.mock.method(stats, 'saveDateStats', async (...args: Parameters<typeof save>) => {
                        aVersion = args[4];
                        aPrepares++;
                        aFingerprint = fingerprint(args[1]);
                        prepared.release();
                        await allowSave.promise;
                        return save(...args);
                    });
                    let worker: ReturnType<typeof startWorker> | undefined;
                    const old = f.fileLogger.getDateStats(f.date, true);
                    void old.catch(() => undefined);
                    const wait = <T>(work: Promise<T>, label: string) => bounded(work, label, 15000, c.signal);
                    const waitA = (entered: Promise<void>, label: string) =>
                        wait(
                            Promise.race([
                                entered,
                                old.then(() => {
                                    throw new Error(`A completed before ${label}`);
                                })
                            ]),
                            label
                        );
                    try {
                        await waitA(calculated.promise, 'A calculation complete');
                        assert.equal(aCalculated, 2);
                        let firstPrepare: Awaited<ReturnType<typeof observe>> | undefined;
                        if (scenario.startsWith('control')) {
                            allowPrepare.release();
                            await waitA(prepared.promise, 'A prepare returned');
                            firstPrepare = await observe(f);
                        }
                        worker = startWorker(f.dir, f.date);
                        const bPrepared = await wait(worker.prepared, 'B prepare returned');
                        if (scenario.startsWith('race')) {
                            firstPrepare = await observe(f);
                            allowPrepare.release();
                            await waitA(prepared.promise, 'A prepare returned after B');
                        }
                        assert.ok(firstPrepare, 'First prepare checkpoint must be captured');
                        const beforeCommit = await observe(f);
                        await wait(worker.send('commit'), 'release B');
                        const bSaved = await wait(worker.saved, 'B saved statistics and index');
                        const bExit = await wait(worker.closed, 'B normal exit');
                        const committed = await observe(f);
                        const indexVersion = getFileVersionSync(join(f.dir, 'usages', 'index.json'));
                        allowSave.release();
                        const result = await wait(old, 'A stale save rejected');
                        const after = await observe(f);
                        const pending = await wait(
                            new StatsPublication().readPendingStats(f.statsPath),
                            'fresh publication recovery'
                        );
                        const aStale = f.fileLogger.getStatsSource(result)?.stale === true;
                        assert.equal(aPrepares, 1);
                        assert.equal(aVersion, initialVersion);
                        assert.equal(bPrepared.expectedVersion, initialVersion);
                        assert.equal(bPrepared.requests, 3);
                        assert.equal(bPrepared.unowned, true);
                        assert.equal(bPrepared.canCommit, true);
                        assert.notEqual(bPrepared.pid, process.pid);
                        for (const checkpoint of [firstPrepare, beforeCommit]) {
                            assert.equal(checkpoint.stats, 1);
                            assert.equal(checkpoint.statsVersion, initialVersion);
                            assert.equal(checkpoint.statsCommitLock, false);
                            assert.equal(checkpoint.markerCommitLock, false);
                        }
                        assert.deepEqual(bExit, { code: 0, signal: null });
                        assert.equal(bSaved.requests, 3);
                        assert.equal(bSaved.snapshotRequests, 3);
                        assert.equal(bSaved.publications, 0);
                        assert.equal(bSaved.diskRequests, 3);
                        assert.equal(bSaved.indexRequests, 3);
                        assert.equal(bSaved.stale, false);
                        assert.equal(bSaved.fingerprint, after.statsFingerprint);
                        assert.notEqual(aFingerprint, bPrepared.fingerprint);
                        assert.equal(result.total.requests, 2);
                        assert.equal(aStale, true);
                        assert.equal(permission(), true);
                        assert.equal(host.state.leaderId, undefined);
                        assert.equal(await f.internals.logStatsManager.hasStatsChanged(f.date, result), false);
                        assert.equal(after.stats, 3);
                        assert.equal(after.index, 3);
                        assert.equal(after.statsFingerprint, committed.statsFingerprint);
                        assert.equal(after.statsVersion, committed.statsVersion);
                        assert.notEqual(committed.statsVersion, initialVersion);
                        assert.equal(getFileVersionSync(join(f.dir, 'usages', 'index.json')), indexVersion);
                        assert.equal(after.acknowledgementExists, false);
                        assert.equal(after.markerExists, false);
                        assert.equal(host.events.filter(item => item.event.type === 'tokenUsageUpdated').length, 0);
                        assert.equal(
                            pending?.total.requests,
                            3,
                            'Fresh recovery must find saved S3 despite stale A prepare'
                        );
                        assert.ok(pending);
                        assert.equal(fingerprint(pending), after.statsFingerprint);
                    } finally {
                        calculated.release();
                        prepared.release();
                        allowPrepare.release();
                        allowSave.release();
                        try {
                            await worker?.stop();
                        } finally {
                            await bounded(
                                old.then(
                                    () => undefined,
                                    () => undefined
                                ),
                                'A cleanup'
                            );
                        }
                    }
                });
            }
        } finally {
            host.restore();
        }
    }
);
