import assert from 'node:assert/strict';
import { fork } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { AtomicJsonFile } from '../../../atomicJsonFile';
import type { DateIndex, TokenUsageStatsFromFile } from '../../../fileLogger/types';
import { createUsageHost } from '../../../tests/hostFixture';
import { gate, snapshotFixture, snapshotRow } from '../../../tests/snapshotFixture';

test('post-save index updates preserve newer committed summaries', async suite => {
    const host = await createUsageHost();
    const { LogIndexManager } = await import('../../../fileLogger/logIndexManager');
    try {
        for (const paused of [false, true]) {
            await suite.test(`old continuation held after stats lock release=${paused}`, async c => {
                const f = await snapshotFixture(host, c);
                host.state.leaderId = undefined;
                await f.internals.snapshotManager.upsertRecord(f.date, snapshotRow(f.date, 'second', 10));
                const entered = gate(),
                    release = gate();
                const exclusive = AtomicJsonFile.runExclusive.bind(AtomicJsonFile);
                let holds = 0;
                c.mock.method(AtomicJsonFile, 'runExclusive', async <T>(path: string, operation: () => Promise<T>) => {
                    const result = await exclusive(path, operation);
                    if (paused && holds === 0 && path === f.statsPath && result === undefined) {
                        holds++;
                        entered.release();
                        await release.promise;
                    }
                    return result;
                });
                const old = f.fileLogger.getDateStats(f.date, true);
                try {
                    if (paused) {
                        await entered.promise;
                    } else {
                        assert.equal((await old).total.requests, 2);
                    }
                    assert.equal(holds, paused ? 1 : 0);
                    assert.equal(await exclusive(f.statsPath, async () => true), true);
                    assert.equal(
                        (JSON.parse(await readFile(f.statsPath, 'utf8')) as TokenUsageStatsFromFile).total.requests,
                        2
                    );
                    await f.internals.snapshotManager.upsertRecord(f.date, snapshotRow(f.date, 'third', 11));
                    const child = fork(
                        fileURLToPath(new URL('./worker.ts', import.meta.url)),
                        [f.dir, f.date, 'startup'],
                        {
                            execArgv: ['--import=tsx'],
                            stdio: ['ignore', 'pipe', 'pipe', 'ipc']
                        }
                    );
                    let output = '';
                    let errors = '';
                    child.stdout?.on('data', chunk => {
                        output += String(chunk);
                    });
                    child.stderr?.on('data', chunk => {
                        errors += String(chunk);
                    });
                    await new Promise<void>((resolve, reject) => {
                        child.once('error', reject);
                        child.once('close', code =>
                            code === 0 ? resolve() : reject(new Error(`Worker exit ${code}: ${output}${errors}`))
                        );
                    });
                    assert.equal((JSON.parse(output) as { requests: number }).requests, 3);
                    const indexPath = join(f.dir, 'usages', 'index.json');
                    assert.equal(
                        (JSON.parse(await readFile(indexPath, 'utf8')) as DateIndex).dates[f.date].total_requests,
                        3
                    );
                    assert.equal(
                        (JSON.parse(await readFile(f.statsPath, 'utf8')) as TokenUsageStatsFromFile).total.requests,
                        3
                    );
                    release.release();
                    const result = await old;
                    assert.equal(result.total.requests, 2);
                    if (paused) {
                        assert.equal(f.fileLogger.getStatsSource(result)?.authorityTerm, undefined);
                        assert.equal(f.fileLogger.getStatsSource(result)?.stale, true);
                        assert.equal(await f.internals.logStatsManager.hasStatsChanged(f.date, result), false);
                        assert.deepEqual(
                            host.events.filter(item => item.event.type === 'tokenUsageUpdated'),
                            []
                        );
                        f.manager.notifyStatsUpdate({
                            date: f.date,
                            stats: result,
                            changed: true,
                            delegated: false
                        });
                        assert.deepEqual(
                            host.events.filter(item => item.event.type === 'tokenUsageUpdated'),
                            []
                        );
                    }
                    const stats = JSON.parse(await readFile(f.statsPath, 'utf8')) as TokenUsageStatsFromFile;
                    const index = JSON.parse(await readFile(indexPath, 'utf8')) as DateIndex;
                    const fast = await new LogIndexManager(f.dir).getIndexFast();
                    assert.equal(stats.total.requests, 3);
                    assert.equal(index.dates[f.date].total_requests, 3);
                    assert.equal(fast[f.date].total_requests, 3);
                } finally {
                    release.release();
                    await old;
                }
            });
        }
    } finally {
        host.restore();
    }
});
