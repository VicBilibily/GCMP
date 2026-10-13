import assert from 'node:assert/strict';
import fs from 'node:fs';
import { readFile, rename, writeFile } from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import { AtomicJsonFile } from '../../../atomicJsonFile';
import { StatsPublication } from '../../../fileLogger/refresh/statsPublication';
import type { StatsRefreshResult } from '../../../fileLogger/refresh/statsRefreshQueue';
import { getFileVersionSync } from '../../../persistence/versionedJsonFile';
import { createUsageHost } from '../../../tests/hostFixture';
import { gate } from '../../../tests/refresh/fixture';
import { bounded } from '../../../tests/refresh/publication/fixture';
import { assertDiskCount, diskState, withPausedRefresh, type LifecycleFixture } from './fixture';
import { externalCommit, type PublicationState } from './lateWorker';

type DiskState = Awaited<ReturnType<typeof diskState>>;
type Fault = 'missing file restored' | 'one-shot metadata EIO' | 'same-content replacement restored';

async function assertRejected(
    f: LifecycleFixture,
    result: StatsRefreshResult,
    force: boolean,
    before: DiskState,
    pendingRequests: number | undefined
): Promise<void> {
    f.manager.notifyStatsUpdate(result, force);
    await f.flushPublications();
    assert.deepEqual(f.publications(), [], 'A superseded result must not broadcast request count 2');
    assert.deepEqual(f.acknowledgements(), [], 'A superseded result must not ACK request count 2');
    assert.equal(f.fileLogger.getStatsSource(result.stats)?.stale, true);
    assert.notEqual(f.status.peek()?.stats.total.requests, 2);
    assert.notEqual(f.fileLogger.getLatestStatusStats(f.date)?.stats.total.requests, 2);
    assert.equal(f.updates.includes(2), false);
    assert.deepEqual(await diskState(f), before, 'Old publication must preserve stats, index, intent and receipt');
    assert.equal((await new StatsPublication().readPendingStats(f.statsPath))?.total.requests, pendingRequests);
}

async function publishFreshThree(
    f: LifecycleFixture,
    old: StatsRefreshResult,
    state: PublicationState,
    before: DiskState
): Promise<void> {
    const saved = await f.fileLogger.readSavedStats(f.date);
    assert.ok(saved);
    assert.equal(saved.total.requests, 3);
    assert.notEqual(f.fileLogger.getStatsSource(saved)?.stale, true);
    await assertRejected(f, { ...old, changed: true }, true, before, state === 'pending' ? 3 : undefined);
    f.manager.notifyStatsUpdate({ date: f.date, stats: saved, changed: true, delegated: false });
    await f.flushPublications();
    assert.deepEqual(f.publications(), [3]);
    assert.deepEqual(f.acknowledgements(), [3]);
    assert.deepEqual(f.updates, [3]);
    assert.equal(f.status.peek()?.stats.total.requests, 3);
    assert.equal((await f.manager.getStatusSnapshot())?.stats.total.requests, 3);
    assert.equal(f.fileLogger.getLatestStatusStats(f.date)?.stats.total.requests, 3);
    assert.equal(await new StatsPublication().readPendingStats(f.statsPath), undefined);
    const acknowledged = await diskState(f);
    assertDiskCount(acknowledged, f.date, 3);
    assert.equal(acknowledged.stats, before.stats);
    assert.equal(acknowledged.index, before.index);
    assert.equal(acknowledged.marker, before.marker);
    if (state === 'acknowledged') {
        assert.equal(acknowledged.receipt, before.receipt);
    }
    f.manager.notifyStatsUpdate({ ...old, changed: true }, true);
    await f.flushPublications();
    assert.deepEqual(f.publications(), [3]);
    assert.deepEqual(f.acknowledgements(), [3]);
    assert.deepEqual(f.updates, [3]);
    assert.equal(f.fileLogger.getStatsSource(old.stats)?.stale, true);
    assert.deepEqual(await diskState(f), acknowledged);
    assert.equal(
        await new StatsPublication().readPendingStats(f.statsPath),
        undefined,
        'A late old ACK must not turn acknowledged 3 back into pending'
    );
}

async function invalidateAndRestore(f: LifecycleFixture, context: TestContext, fault: Fault): Promise<void> {
    const before = await diskState(f);
    const version = getFileVersionSync(f.statsPath);
    if (fault === 'one-shot metadata EIO') {
        const original = fs.statSync.bind(fs);
        let injected = 0;
        const failed = context.mock.method(fs, 'statSync', (...args: Parameters<typeof original>) => {
            if (String(args[0]) === f.statsPath && injected === 0) {
                injected++;
                throw Object.assign(new Error('Injected source metadata failure'), { code: 'EIO' });
            }
            return original(...args);
        });
        try {
            syncBuiltinESMExports();
            assert.equal(f.fileLogger.getStatsSource(f.registered)?.stale, true);
            assert.equal(injected, 1, 'The actual source lookup must consume the one-shot stat failure');
        } finally {
            failed.mock.restore();
            syncBuiltinESMExports();
        }
        assert.equal(getFileVersionSync(f.statsPath), version);
    } else {
        const parked = `${f.statsPath}.parked`;
        const replacement = `${f.statsPath}.replacement`;
        if (fault === 'same-content replacement restored') {
            await writeFile(replacement, before.stats);
        }
        await rename(f.statsPath, parked);
        try {
            if (fault === 'same-content replacement restored') {
                await rename(replacement, f.statsPath);
                assert.notEqual(getFileVersionSync(f.statsPath), version);
                assert.equal(await readFile(f.statsPath, 'utf8'), before.stats);
            } else {
                assert.equal(getFileVersionSync(f.statsPath), 'missing');
            }
            assert.equal(f.fileLogger.getStatsSource(f.registered)?.stale, true);
        } finally {
            await rename(parked, f.statsPath);
        }
    }
    assert.notEqual(getFileVersionSync(f.statsPath), 'missing');
    assert.deepEqual(await diskState(f), before);
    assert.equal(
        f.fileLogger.getStatsSource(f.registered)?.stale,
        true,
        'Restored content and readable metadata must not revive a previously invalidated result'
    );
    assert.ok(Object.isFrozen(f.originalSource));
}

test('registered notification lifecycle across external commits and recovery', { timeout: 600000 }, async suite => {
    const host = await createUsageHost();
    try {
        for (const boundary of ['registered', 'returned'] as const) {
            for (const state of ['none', 'pending', 'acknowledged'] as const) {
                for (const force of [false, true]) {
                    await suite.test(`${boundary}/${state}/force=${force}`, { timeout: 60000 }, async context => {
                        await withPausedRefresh(host, context, boundary, async f => {
                            const version = getFileVersionSync(f.statsPath);
                            assertDiskCount(await diskState(f), f.date, 2);
                            if (state !== 'none') {
                                await externalCommit(f.dir, f.date, state, context.signal);
                                assert.notEqual(getFileVersionSync(f.statsPath), version);
                            }
                            const before = await diskState(f);
                            assertDiskCount(before, f.date, state === 'none' ? 2 : 3);
                            const pending =
                                state === 'acknowledged' ? undefined
                                : state === 'pending' ? 3
                                : 2;
                            assert.equal(
                                (await new StatsPublication().readPendingStats(f.statsPath))?.total.requests,
                                pending
                            );
                            const result = await f.resume();
                            assert.equal(result.stats.total.requests, 2);
                            if (state === 'none') {
                                assert.equal(result.changed, true);
                                f.manager.notifyStatsUpdate(result, force);
                                await f.flushPublications();
                                assert.deepEqual(f.publications(), [2]);
                                assert.deepEqual(f.acknowledgements(), [2]);
                                assert.deepEqual(f.updates, [2]);
                                assert.equal(f.status.peek()?.stats.total.requests, 2);
                                assert.equal((await f.manager.getStatusSnapshot())?.stats.total.requests, 2);
                                assert.notEqual(f.fileLogger.getStatsSource(result.stats)?.stale, true);
                                assert.equal(await new StatsPublication().readPendingStats(f.statsPath), undefined);
                                const after = await diskState(f);
                                assertDiskCount(after, f.date, 2);
                                assert.equal(after.stats, before.stats);
                                assert.equal(after.index, before.index);
                                assert.equal(after.marker, before.marker);
                            } else {
                                await assertRejected(f, result, force, before, pending);
                                await publishFreshThree(f, result, state, before);
                            }
                        });
                    });
                }
            }
        }
        const faults: Fault[] = ['missing file restored', 'one-shot metadata EIO', 'same-content replacement restored'];
        for (const fault of faults) {
            for (const state of ['pending', 'acknowledged'] as const) {
                await suite.test(`${fault}/${state}/force=true`, { timeout: 60000 }, async context => {
                    await withPausedRefresh(host, context, 'returned', async f => {
                        const result = await f.resume();
                        assert.equal(result.changed, true);
                        await invalidateAndRestore(f, context, fault);
                        const restored = await diskState(f);
                        assertDiskCount(restored, f.date, 2);
                        await assertRejected(f, result, true, restored, 2);
                        await externalCommit(f.dir, f.date, state, context.signal);
                        const current = await diskState(f);
                        assertDiskCount(current, f.date, 3);
                        await assertRejected(f, result, true, current, state === 'pending' ? 3 : undefined);
                        await publishFreshThree(f, result, state, current);
                    });
                });
            }
        }
        for (const boundary of ['ack queued', 'ack marker read', 'ack receipt read'] as const) {
            for (const state of ['pending', 'acknowledged'] as const) {
                await suite.test(`${boundary}/${state}`, { timeout: 60000 }, async context => {
                    await withPausedRefresh(host, context, 'returned', async f => {
                        const result = await f.resume();
                        assert.equal(result.stats.total.requests, 2);
                        assert.equal(result.changed, true);
                        const initial = await bounded(diskState(f), 'initial ACK disk state', 10000, context.signal);
                        assertDiskCount(initial, f.date, 2);
                        const entered = gate();
                        const release = gate();
                        const checks: boolean[] = [];
                        const passedChecks =
                            boundary === 'ack queued' ? []
                            : boundary === 'ack marker read' ? [true]
                            : [true, true];
                        const acknowledge = StatsPublication.prototype.acknowledge;
                        const acknowledgements = context.mock.method(
                            StatsPublication.prototype,
                            'acknowledge',
                            function (this: StatsPublication, ...args: Parameters<typeof acknowledge>) {
                                const [statsPath, fingerprint, canWrite] = args;
                                return acknowledge.call(this, statsPath, fingerprint, () => {
                                    const allowed = canWrite();
                                    checks.push(allowed);
                                    return allowed;
                                });
                            }
                        );
                        let holder: Promise<void> | undefined;
                        let work: Promise<void> | undefined;
                        let restoreRead: (() => void) | undefined;
                        let intercepted = 0;
                        let settled = false;
                        try {
                            if (boundary === 'ack queued') {
                                holder = AtomicJsonFile.runExclusive(f.statsPath, async () => {
                                    entered.release();
                                    await bounded(release.promise, 'release ACK queue', 45000, context.signal);
                                });
                                void holder.catch(() => undefined);
                                await bounded(
                                    Promise.race([
                                        entered.promise,
                                        holder.then(() => {
                                            throw new Error('Queue holder settled before the ACK pause');
                                        })
                                    ]),
                                    'ACK queue held',
                                    10000,
                                    context.signal
                                );
                            } else {
                                const target = join(
                                    f.dir,
                                    'usages',
                                    f.date,
                                    boundary === 'ack marker read' ? 'stats-publication.json' : 'stats-published.json'
                                );
                                const read = fs.promises.readFile;
                                const paused = context.mock.method(fs.promises, 'readFile', (async (
                                    ...args: Parameters<typeof read>
                                ) => {
                                    const pause = String(args[0]) === target && intercepted === 0;
                                    if (pause) {
                                        intercepted++;
                                    }
                                    const content = await read(...args);
                                    if (pause) {
                                        assert.equal(
                                            content,
                                            boundary === 'ack marker read' ? initial.marker : initial.receipt
                                        );
                                        assert.deepEqual(checks, passedChecks);
                                        entered.release();
                                        await bounded(release.promise, 'release ACK read', 45000, context.signal);
                                    }
                                    return content;
                                }) as typeof read);
                                restoreRead = () => paused.mock.restore();
                                syncBuiltinESMExports();
                            }
                            work = f.internals.logStatsManager.markStatsPublished(f.date, result.stats);
                            void work.then(
                                () => {
                                    settled = true;
                                },
                                () => {
                                    settled = true;
                                }
                            );
                            if (boundary !== 'ack queued') {
                                await bounded(
                                    Promise.race([
                                        entered.promise,
                                        work.then(() => {
                                            throw new Error('ACK settled before the file read pause');
                                        })
                                    ]),
                                    boundary,
                                    10000,
                                    context.signal
                                );
                            }
                            assert.equal(acknowledgements.mock.callCount(), 1);
                            assert.equal(acknowledgements.mock.calls[0].arguments[0], f.statsPath);
                            assert.deepEqual(checks, passedChecks);
                            assert.equal(intercepted, boundary === 'ack queued' ? 0 : 1);
                            await externalCommit(f.dir, f.date, state, context.signal);
                            const current = await bounded(
                                diskState(f),
                                'external ACK disk state',
                                10000,
                                context.signal
                            );
                            assertDiskCount(current, f.date, 3);
                            assert.equal(settled, false, 'Old ACK must still be waiting after the external commit');
                            assert.deepEqual(checks, passedChecks);
                            release.release();
                            await bounded(work, 'old ACK completion', 10000, context.signal);
                            if (holder) {
                                await bounded(holder, 'ACK queue completion', 10000, context.signal);
                            }
                            assert.deepEqual(
                                checks,
                                [...passedChecks, false],
                                'The ACK guard must reject the old source'
                            );
                            assert.deepEqual(
                                await bounded(diskState(f), 'rejected ACK disk state', 10000, context.signal),
                                current,
                                'Old ACK must preserve stats, index, intent and receipt bytes'
                            );
                            assert.notEqual(f.fileLogger.getLatestStatusStats(f.date)?.stats.total.requests, 2);
                            assert.equal(f.fileLogger.getStatsSource(result.stats)?.stale, true);
                            assert.deepEqual(f.acknowledgements(), []);
                            await assertRejected(f, result, true, current, state === 'pending' ? 3 : undefined);
                            await publishFreshThree(f, result, state, current);
                        } finally {
                            entered.release();
                            release.release();
                            try {
                                await bounded(Promise.allSettled([holder, work]), 'ACK terminal cleanup', 15000);
                            } finally {
                                restoreRead?.();
                                syncBuiltinESMExports();
                                acknowledgements.mock.restore();
                            }
                        }
                    });
                });
            }
        }
    } finally {
        host.restore();
    }
});
