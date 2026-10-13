import assert from 'node:assert/strict';
import { fork } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { AtomicJsonFile } from '../../../atomicJsonFile';
import type { StatsPublication } from '../../../fileLogger/refresh/statsPublication';
import type { DateIndex, TokenUsageStatsFromFile } from '../../../fileLogger/types';
import { createUsageHost } from '../../../tests/hostFixture';
import { gate, snapshotFixture, snapshotRow } from '../../../tests/snapshotFixture';
import { getFileVersionSync } from '../../versionedJsonFile';

test('source-based index updates and prepared stats reject superseded versions without an owner', async suite => {
    const host = await createUsageHost();
    const { LogIndexManager } = await import('../../../fileLogger/logIndexManager');
    try {
        for (const source of ['index-and-stats', 'stats-only']) {
            await suite.test(`${source}: updateIndex rereads saved stats after a paused commit`, async c => {
                const f = await snapshotFixture(host, c);
                host.state.leaderId = undefined;
                await f.internals.snapshotManager.upsertRecord(f.date, snapshotRow(f.date, 'second', 10));
                assert.equal((await f.fileLogger.getDateStats(f.date, true)).total.requests, 2);
                const index = (f.fileLogger as unknown as { indexManager: InstanceType<typeof LogIndexManager> })
                    .indexManager;
                const indexPath = index.getIndexPath();
                const before = await readFile(indexPath, 'utf8');
                assert.equal((JSON.parse(before) as DateIndex).dates[f.date].total_requests, 2);
                const indexVersion = getFileVersionSync(indexPath);
                const statsVersion = getFileVersionSync(f.statsPath);
                const permission = f.internals.logStatsManager.captureWritePermission();
                const entered = gate(),
                    release = gate();
                const original = AtomicJsonFile.writeJsonAtomically.bind(AtomicJsonFile);
                const attempts: number[] = [];
                c.mock.method(AtomicJsonFile, 'writeJsonAtomically', async (...args: Parameters<typeof original>) => {
                    if (args[0] === indexPath) {
                        attempts.push((args[1] as DateIndex).dates[f.date].total_requests);
                        if (attempts.length === 1) {
                            entered.release();
                            await release.promise;
                        }
                    }
                    return original(...args);
                });
                const old = index.updateIndex(f.date, undefined);
                try {
                    await Promise.race([entered.promise, old]);
                    assert.deepEqual(attempts, [2]);
                    assert.equal(host.state.leaderId, undefined);
                    assert.equal(permission(), true);
                    if (source === 'index-and-stats') {
                        await f.internals.snapshotManager.upsertRecord(f.date, snapshotRow(f.date, 'third', 11));
                        const child = fork(
                            fileURLToPath(new URL('./worker.ts', import.meta.url)),
                            [f.dir, f.date, 'startup'],
                            { execArgv: ['--import=tsx'], stdio: ['ignore', 'pipe', 'pipe', 'ipc'] }
                        );
                        let output = '';
                        let errors = '';
                        child.stdout?.on('data', (chunk: Buffer) => {
                            output += String(chunk);
                        });
                        child.stderr?.on('data', (chunk: Buffer) => {
                            errors += String(chunk);
                        });
                        await new Promise<void>((resolve, reject) => {
                            child.once('error', reject);
                            child.once('close', code =>
                                code === 0 ? resolve() : reject(new Error(`Worker exit ${code}: ${output}${errors}`))
                            );
                        });
                        assert.equal((JSON.parse(output) as { requests: number }).requests, 3);
                        assert.equal(
                            (JSON.parse(await readFile(indexPath, 'utf8')) as DateIndex).dates[f.date].total_requests,
                            3
                        );
                        assert.notEqual(getFileVersionSync(indexPath), indexVersion);
                    } else {
                        const stats = JSON.parse(await readFile(f.statsPath, 'utf8')) as TokenUsageStatsFromFile;
                        stats.total.requests = 3;
                        await writeFile(f.statsPath, JSON.stringify(stats));
                        assert.equal(await readFile(indexPath, 'utf8'), before);
                        assert.equal(getFileVersionSync(indexPath), indexVersion);
                    }
                    assert.equal(
                        (JSON.parse(await readFile(f.statsPath, 'utf8')) as TokenUsageStatsFromFile).total.requests,
                        3
                    );
                    assert.notEqual(getFileVersionSync(f.statsPath), statsVersion);
                    release.release();
                    assert.equal((await old)?.total.requests, 3);
                    assert.deepEqual(attempts, [2, 3]);
                    assert.equal(
                        (JSON.parse(await readFile(indexPath, 'utf8')) as DateIndex).dates[f.date].total_requests,
                        3
                    );
                    assert.equal(
                        (JSON.parse(await readFile(f.statsPath, 'utf8')) as TokenUsageStatsFromFile).total.requests,
                        3
                    );
                    assert.equal((await new LogIndexManager(f.dir).getIndexFast())[f.date].total_requests, 3);
                    assert.equal(host.state.leaderId, undefined);
                    assert.equal(permission(), true);
                } finally {
                    release.release();
                    await old;
                }
            });
        }
        await suite.test('completed prepare cannot overwrite a newer unowned process commit', async c => {
            const f = await snapshotFixture(host, c);
            host.state.leaderId = undefined;
            await f.internals.snapshotManager.upsertRecord(f.date, snapshotRow(f.date, 'second', 10));
            const publication = (f.internals.logStatsManager as unknown as { publication: StatsPublication })
                .publication;
            const prepare = publication.prepare.bind(publication);
            const permission = f.internals.logStatsManager.captureWritePermission();
            const entered = gate(),
                release = gate();
            let prepared = 0;
            let fingerprint = '';
            c.mock.method(publication, 'prepare', async (...args: Parameters<typeof prepare>) => {
                await prepare(...args);
                prepared++;
                fingerprint = args[1];
                entered.release();
                await release.promise;
            });
            const old = f.fileLogger.getDateStats(f.date, true);
            try {
                await Promise.race([entered.promise, old]);
                assert.equal(prepared, 1);
                const markerPath = join(f.dir, 'usages', f.date, 'stats-publication.json');
                const marker = JSON.parse(await readFile(markerPath, 'utf8')) as { pending: string[] };
                assert.ok(marker.pending.includes(fingerprint));
                assert.equal(
                    (JSON.parse(await readFile(f.statsPath, 'utf8')) as TokenUsageStatsFromFile).total.requests,
                    1
                );
                assert.equal(host.state.leaderId, undefined);
                assert.equal(permission(), true);
                await f.internals.snapshotManager.upsertRecord(f.date, snapshotRow(f.date, 'third', 11));
                const child = fork(fileURLToPath(new URL('./worker.ts', import.meta.url)), [f.dir, f.date, 'startup'], {
                    execArgv: ['--import=tsx'],
                    stdio: ['ignore', 'pipe', 'pipe', 'ipc']
                });
                let output = '';
                let errors = '';
                child.stdout?.on('data', (chunk: Buffer) => {
                    output += String(chunk);
                });
                child.stderr?.on('data', (chunk: Buffer) => {
                    errors += String(chunk);
                });
                await new Promise<void>((resolve, reject) => {
                    child.once('error', reject);
                    child.once('close', code =>
                        code === 0 ? resolve() : reject(new Error(`Worker exit ${code}: ${output}${errors}`))
                    );
                });
                assert.equal((JSON.parse(output) as { requests: number }).requests, 3);
                const committed = await readFile(f.statsPath, 'utf8');
                const statsVersion = getFileVersionSync(f.statsPath);
                const indexPath = join(f.dir, 'usages', 'index.json');
                const indexVersion = getFileVersionSync(indexPath);
                assert.equal((JSON.parse(committed) as TokenUsageStatsFromFile).total.requests, 3);
                assert.equal(
                    (JSON.parse(await readFile(indexPath, 'utf8')) as DateIndex).dates[f.date].total_requests,
                    3
                );
                release.release();
                const result = await old;
                assert.equal(result.total.requests, 2);
                assert.equal(f.fileLogger.getStatsSource(result)?.authorityTerm, undefined);
                assert.equal(f.fileLogger.getStatsSource(result)?.stale, true);
                assert.equal(await f.internals.logStatsManager.hasStatsChanged(f.date, result), false);
                assert.equal((await f.internals.snapshotManager.read(f.date))?.length, 3);
                assert.equal(await readFile(f.statsPath, 'utf8'), committed);
                assert.equal(getFileVersionSync(f.statsPath), statsVersion);
                assert.equal(getFileVersionSync(indexPath), indexVersion);
                assert.equal(
                    (JSON.parse(await readFile(f.statsPath, 'utf8')) as TokenUsageStatsFromFile).total.requests,
                    3
                );
                assert.equal(
                    (JSON.parse(await readFile(indexPath, 'utf8')) as DateIndex).dates[f.date].total_requests,
                    3
                );
                assert.equal((await publication.readPendingStats(f.statsPath))?.total.requests, 3);
                assert.equal(host.state.leaderId, undefined);
                assert.equal(permission(), true);
            } finally {
                release.release();
                await old;
            }
        });
    } finally {
        host.restore();
    }
});
