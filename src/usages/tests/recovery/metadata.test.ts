import assert from 'node:assert/strict';
import fs from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';
import { AtomicJsonFile } from '../../atomicJsonFile';
import type { DateIndex } from '../../fileLogger/types';
import { createUsageHost } from '../hostFixture';
import { snapshotFixture, snapshotRow } from '../snapshotFixture';
import { rebuildWithLateWrite } from './fixture';

test(
    'source metadata failures preserve pending work without blocking index updates',
    { timeout: 30000 },
    async suite => {
        const host = await createUsageHost();
        try {
            for (const fault of ['none', 'stat-EACCES', 'stat-ENOENT', 'read-EACCES'] as const) {
                for (const source of ['snapshot', 'raw'] as const) {
                    await suite.test(`${fault}/${source}: late writes survive recovery`, async context => {
                        const f = await snapshotFixture(host, context);
                        await rebuildWithLateWrite(f, context, source);
                        let attempts = 0;
                        if (fault !== 'none') {
                            const original = fs.statSync.bind(fs);
                            const failed =
                                fault.startsWith('stat-') ?
                                    context.mock.method(fs, 'statSync', (...args: Parameters<typeof original>) => {
                                        if (String(args[0]) === f.snapshotPath) {
                                            attempts++;
                                            throw Object.assign(new Error('Injected source metadata failure'), {
                                                code: fault.slice(5)
                                            });
                                        }
                                        return original(...args);
                                    })
                                :   context.mock.method(f.internals.snapshotManager, 'read', async () => {
                                        attempts++;
                                        throw Object.assign(new Error('Injected source read failure'), {
                                            code: 'EACCES'
                                        });
                                    });
                            const before = await readFile(f.statsPath, 'utf8');
                            try {
                                assert.deepEqual(await f.fileLogger.regenerateOutdatedStats(), {});
                                assert.ok(attempts > 0);
                                assert.equal(await readFile(f.statsPath, 'utf8'), before);
                                const pending = f.privateStats as unknown as {
                                    snapshotVersions: Map<string, { source: string; pending?: boolean }>;
                                };
                                assert.equal(pending.snapshotVersions.get(f.date)?.pending, true);
                            } finally {
                                failed.mock.restore();
                            }
                        }
                        assert.equal(await f.privateStats.needsRegeneration(f.date), true);
                        const rebuilt = await f.fileLogger.regenerateOutdatedStats();
                        assert.equal(rebuilt[f.date]?.total.requests, 3);
                        assert.equal((await f.fileLogger.getDateStats(f.date)).total.requests, 3);
                        for (let round = 0; round < 3; round++) {
                            assert.deepEqual(await f.fileLogger.regenerateOutdatedStats(), {});
                        }
                    });
                }
            }

            for (const code of ['EACCES', 'ENOENT'] as const) {
                await suite.test(`${code}: post-save metadata failure still updates the index`, async context => {
                    const f = await snapshotFixture(host, context);
                    await f.internals.snapshotManager.upsertRecord(f.date, snapshotRow(f.date, 'second', 10));
                    const original = fs.statSync.bind(fs);
                    let written = false;
                    let attempts = 0;
                    const failed = context.mock.method(fs, 'statSync', (...args: Parameters<typeof original>) => {
                        if (written && String(args[0]) === f.snapshotPath) {
                            attempts++;
                            throw Object.assign(new Error('Injected post-save metadata failure'), { code });
                        }
                        return original(...args);
                    });
                    const write = AtomicJsonFile.writeJsonAtomically.bind(AtomicJsonFile);
                    context.mock.method(
                        AtomicJsonFile,
                        'writeJsonAtomically',
                        async (...args: Parameters<typeof write>) => {
                            await write(...args);
                            if (args[0] === f.statsPath) {
                                written = true;
                            }
                        }
                    );
                    try {
                        const result = await f.fileLogger.getDateStats(f.date);
                        assert.equal(result.total.requests, 2);
                        assert.ok(attempts > 0);
                        const index = JSON.parse(
                            await readFile(join(f.dir, 'usages', 'index.json'), 'utf8')
                        ) as DateIndex;
                        assert.equal(index.dates[f.date]?.total_requests, 2);
                    } finally {
                        failed.mock.restore();
                    }
                    const saved = await readFile(f.statsPath, 'utf8');
                    assert.deepEqual(await f.fileLogger.regenerateOutdatedStats(), {});
                    assert.equal(await readFile(f.statsPath, 'utf8'), saved);
                    assert.equal(await f.privateStats.needsRegeneration(f.date), false);
                });
            }

            await suite.test(
                'a genuinely missing historical directory can still produce empty stats',
                async context => {
                    host.reset();
                    const f = await host.fixture(context);
                    f.internals.logStatsManager.updateCodeVersionTimestamp(1);
                    const date = '2000-01-01';
                    const result = await f.fileLogger.getDateStats(date);
                    assert.equal(result.total.requests, 0);
                    assert.equal((await f.fileLogger.getDateStats(date)).total.requests, 0);
                    assert.deepEqual(await f.fileLogger.regenerateOutdatedStats(), {});
                }
            );
        } finally {
            host.restore();
        }
    }
);
