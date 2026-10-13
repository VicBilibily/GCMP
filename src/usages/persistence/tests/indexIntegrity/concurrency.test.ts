import assert from 'node:assert/strict';
import { fork } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { AtomicJsonFile } from '../../../atomicJsonFile';
import { createUsageHost } from '../../../tests/hostFixture';
import { snapshotFixture, snapshotRow, gate } from '../../../tests/snapshotFixture';
import type { DateIndex, TokenUsageStatsFromFile } from '../../../fileLogger/types';

test('index commits reject stale cross-process and source-file observations', async suite => {
    const host = await createUsageHost();
    const { LogIndexManager } = await import('../../../fileLogger/logIndexManager');
    try {
        for (const source of ['index-and-stats', 'stats-only']) {
            await suite.test(`${source}: a late reconciliation uses the current saved version`, async c => {
                const f = await snapshotFixture(host, c);
                const manager = new LogIndexManager(f.dir);
                const path = manager.getIndexPath();
                const stale = JSON.parse(await readFile(path, 'utf8')) as DateIndex;
                stale.dates[f.date].total_requests = 0;
                await writeFile(path, JSON.stringify(stale));
                const entered = gate(),
                    release = gate();
                const original = AtomicJsonFile.writeJsonAtomically.bind(AtomicJsonFile);
                let first = true;
                c.mock.method(AtomicJsonFile, 'writeJsonAtomically', async (...args: Parameters<typeof original>) => {
                    if (first && args[0] === path) {
                        first = false;
                        entered.release();
                        await release.promise;
                    }
                    return original(...args);
                });
                const old = manager.getIndex();
                try {
                    await entered.promise;
                    if (source === 'index-and-stats') {
                        await f.internals.snapshotManager.upsertRecord(f.date, snapshotRow(f.date, 'second', 10));
                        const child = fork(fileURLToPath(new URL('./worker.ts', import.meta.url)), [f.dir, f.date], {
                            execArgv: ['--import=tsx'],
                            stdio: ['ignore', 'pipe', 'pipe', 'ipc']
                        });
                        let output = '';
                        child.stdout?.on('data', chunk => {
                            output += String(chunk);
                        });
                        child.stderr?.on('data', chunk => {
                            output += String(chunk);
                        });
                        await new Promise<void>((resolve, reject) => {
                            child.once('error', reject);
                            child.once('exit', code =>
                                code === 0 ? resolve() : reject(new Error(`Worker exit ${code}: ${output}`))
                            );
                        });
                        assert.equal(
                            (JSON.parse(await readFile(path, 'utf8')) as DateIndex).dates[f.date].total_requests,
                            2
                        );
                    } else {
                        const stats = JSON.parse(await readFile(f.statsPath, 'utf8')) as TokenUsageStatsFromFile;
                        stats.total.requests = 2;
                        await writeFile(f.statsPath, JSON.stringify(stats));
                    }
                    release.release();
                    assert.equal((await old)[f.date].total_requests, 2);
                    assert.equal(
                        (JSON.parse(await readFile(path, 'utf8')) as DateIndex).dates[f.date].total_requests,
                        2
                    );
                } finally {
                    release.release();
                    await old;
                }
            });
        }
        await suite.test('a follower can reconcile in memory without modifying the shared index', async c => {
            const f = await snapshotFixture(host, c);
            const path = new LogIndexManager(f.dir).getIndexPath();
            const before = await readFile(path, 'utf8');
            const stats = JSON.parse(await readFile(f.statsPath, 'utf8')) as TokenUsageStatsFromFile;
            stats.total.requests = 2;
            await writeFile(f.statsPath, JSON.stringify(stats));
            host.state.leaderId = 'other';
            const writes = c.mock.method(AtomicJsonFile, 'writeJsonAtomically');
            assert.equal((await f.fileLogger.getIndex())[f.date].total_requests, 2);
            assert.equal(await readFile(path, 'utf8'), before);
            assert.equal(writes.mock.calls.filter(call => call.arguments[0] === path).length, 0);
        });
        await suite.test('ownership lost during reconciliation cannot save its old index', async c => {
            const f = await snapshotFixture(host, c);
            const path = new LogIndexManager(f.dir).getIndexPath();
            const before = await readFile(path, 'utf8');
            const stats = JSON.parse(await readFile(f.statsPath, 'utf8')) as TokenUsageStatsFromFile;
            stats.total.requests = 2;
            await writeFile(f.statsPath, JSON.stringify(stats));
            const original = AtomicJsonFile.writeJsonAtomically.bind(AtomicJsonFile);
            c.mock.method(AtomicJsonFile, 'writeJsonAtomically', async (...args: Parameters<typeof original>) => {
                if (args[0] === path) {
                    host.state.leaderId = 'other';
                }
                return original(...args);
            });
            await f.fileLogger.getIndex();
            assert.equal(await readFile(path, 'utf8'), before);
        });
    } finally {
        host.restore();
    }
});
