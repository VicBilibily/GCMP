import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { TestContext } from 'node:test';
import type { StatsRefreshResult, StatsResultSource } from '../../../fileLogger/refresh/statsRefreshQueue';
import type { DateIndex, TokenUsageStatsFromFile } from '../../../fileLogger/types';
import { gate, refreshClock, refreshFixture, type UsageHost } from '../../../tests/refresh/fixture';
import { bounded } from '../../../tests/refresh/publication/fixture';
import type { UsageStatusSnapshots } from '../../usageStatusSnapshots';

export type PauseBoundary = 'registered' | 'returned';
export type LifecycleFixture = Awaited<ReturnType<typeof refreshFixture>> & {
    status: UsageStatusSnapshots;
    statsPath: string;
    registered: TokenUsageStatsFromFile;
    originalSource: StatsResultSource;
    updates: number[];
    resume(): Promise<StatsRefreshResult>;
    publications(): number[];
    acknowledgements(): number[];
    flushPublications(): Promise<void>;
};

export async function withPausedRefresh(
    host: UsageHost,
    context: TestContext,
    boundary: PauseBoundary,
    run: (fixture: LifecycleFixture) => Promise<void>
): Promise<void> {
    host.reset();
    const clock = refreshClock(context);
    const f = await refreshFixture(host, context);
    const { UsageStatusSnapshots } = await import('../../usageStatusSnapshots');
    const status = new UsageStatusSnapshots(
        true,
        date => f.fileLogger.readSavedStats(date),
        date => f.fileLogger.getDateStats(date),
        stats => f.fileLogger.getStatsSource(stats),
        date => f.fileLogger.getLatestStatusStats(date)
    );
    Object.assign(f.manager, { statusSnapshots: status });
    const updates: number[] = [];
    const listener = status.onUpdate(snapshot => updates.push(snapshot.stats.total.requests));
    const entered = gate();
    const release = gate();
    let work: Promise<StatsRefreshResult> | undefined;
    let restoreChanged: (() => void) | undefined;
    try {
        await f.seed(1);
        assert.equal((await f.manager.getStatusSnapshot())?.stats.total.requests, 1);
        updates.length = 0;
        host.state.leaderId = undefined;
        const manager = f.internals.logStatsManager;
        const changed = manager.hasStatsChanged.bind(manager);
        let registered: TokenUsageStatsFromFile | undefined;
        let originalSource: StatsResultSource | undefined;
        const intercept = context.mock.method(
            manager,
            'hasStatsChanged',
            async (...args: Parameters<typeof changed>) => {
                if (!registered && args[0] === f.date && args[1].total.requests === 2) {
                    registered = args[1];
                    originalSource = f.fileLogger.getStatsSource(registered);
                    assert.ok(originalSource);
                    assert.ok(Object.isFrozen(originalSource));
                    assert.notEqual(originalSource.stale, true);
                    assert.equal(originalSource.authorityTerm, undefined);
                    if (boundary === 'registered') {
                        entered.release();
                        await release.promise;
                    }
                }
                return changed(...args);
            }
        );
        restoreChanged = () => intercept.mock.restore();
        await f.fileLogger.recordEstimatedTokens({
            requestId: `${Date.now()}_local_${process.pid}`,
            providerKey: 'test',
            providerName: 'Test',
            modelId: 'test',
            modelName: 'Test',
            estimatedInput: 10
        });
        await f.fileLogger.flush();
        work = f.fileLogger.refreshStats(f.date).then(async result => {
            assert.ok(result);
            assert.equal(result.stats, registered);
            assert.equal(result.stats.total.requests, 2);
            if (boundary === 'returned') {
                assert.equal(result.changed, true);
                entered.release();
                await release.promise;
            }
            return result;
        });
        void work.catch(() => undefined);
        clock.fire();
        await bounded(
            Promise.race([
                entered.promise,
                work.then(() => {
                    throw new Error('Refresh settled before the notification boundary');
                })
            ]),
            `${boundary} source pause`,
            10000,
            context.signal
        );
        assert.ok(registered);
        assert.ok(originalSource);
        assert.deepEqual(f.broadcasts(), []);
        const acknowledgements = context.mock.method(f.fileLogger, 'markStatsPublished');
        const running = work;
        await run({
            ...f,
            status,
            statsPath: join(f.dir, 'usages', f.date, 'stats.json'),
            registered,
            originalSource,
            updates,
            async resume() {
                release.release();
                return bounded(running, 'refresh notification result', 10000, context.signal);
            },
            publications: () =>
                f
                    .broadcasts()
                    .flatMap(item =>
                        item.event.type === 'tokenUsageUpdated' ? [item.event.payload.totalRequests] : []
                    ),
            acknowledgements: () => acknowledgements.mock.calls.map(call => call.arguments[0].stats.total.requests),
            flushPublications: () =>
                bounded(manager.flushStatsPublications(), 'publication completion', 10000, context.signal)
        });
    } finally {
        entered.release();
        release.release();
        try {
            if (work) {
                await bounded(
                    work.catch(() => undefined),
                    'refresh terminal cleanup',
                    15000
                );
            }
        } finally {
            restoreChanged?.();
            listener.dispose();
            status.dispose();
            await bounded(f.fileLogger.dispose(), 'logger terminal cleanup', 10000);
        }
    }
}

export async function diskState(f: LifecycleFixture) {
    const [stats, index, marker, receipt] = await Promise.all([
        readFile(f.statsPath, 'utf8'),
        readFile(join(f.dir, 'usages', 'index.json'), 'utf8'),
        readLegacy(join(f.dir, 'usages', f.date, 'stats-publication.json')),
        readLegacy(join(f.dir, 'usages', f.date, 'stats-published.json'))
    ]);
    return { stats, index, marker, receipt };
}

async function readLegacy(path: string): Promise<string | undefined> {
    try {
        return await readFile(path, 'utf8');
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
            return undefined;
        }
        throw error;
    }
}

export function assertDiskCount(state: Awaited<ReturnType<typeof diskState>>, date: string, count: number): void {
    assert.equal((JSON.parse(state.stats) as TokenUsageStatsFromFile).total.requests, count);
    assert.equal((JSON.parse(state.index) as DateIndex).dates[date].total_requests, count);
}
