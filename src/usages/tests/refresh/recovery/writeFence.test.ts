import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import * as fs from 'node:fs/promises';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import test from 'node:test';
import { AtomicJsonFile } from '../../../atomicJsonFile';
import { DateUtils } from '../../../fileLogger/dateUtils';
import { StatsPublication } from '../../../fileLogger/refresh/statsPublication';
import type { TokenRequestLog } from '../../../fileLogger/types';
import { createUsageHost } from '../../hostFixture';
import { gate } from '../fixture';

const promises = createRequire(import.meta.url)('node:fs/promises') as typeof fs;

test(
    'statistics writes fence every persisted artifact after shared ownership changes',
    { timeout: 30000 },
    async suite => {
        const host = await createUsageHost();
        try {
            for (const artifact of ['marker', 'stats', 'index'] as const) {
                for (const phase of ['call', 'temporary-file', 'rename-retry'] as const) {
                    await suite.test(`${artifact}/${phase}`, async context => {
                        host.reset();
                        const f = await host.fixture(context);
                        const date = DateUtils.getDateStringDaysAgo(7);
                        const timestamp = new Date(`${date}T12:00:00`).getTime();
                        const row: TokenRequestLog = {
                            requestId: 'original',
                            timestamp,
                            isoTime: new Date(timestamp).toISOString(),
                            providerKey: 'p',
                            providerName: 'P',
                            modelId: 'm',
                            modelName: 'M',
                            estimatedInput: 10,
                            rawUsage: null,
                            status: 'estimated'
                        };
                        await f.internals.snapshotManager.buildSnapshotFromLogs(date, [row]);
                        const folder = join(f.dir, 'usages', date);
                        const paths = {
                            marker: join(folder, 'stats-publication.json'),
                            stats: join(folder, 'stats.json'),
                            index: join(f.dir, 'usages', 'index.json')
                        };
                        const entered = gate(),
                            release = gate();
                        let first = true;
                        if (phase === 'call') {
                            const original = AtomicJsonFile.writeJsonAtomically;
                            context.mock.method(
                                AtomicJsonFile,
                                'writeJsonAtomically',
                                async (...args: Parameters<typeof original>) => {
                                    if (args[0] === paths[artifact] && first) {
                                        first = false;
                                        entered.release();
                                        await release.promise;
                                    }
                                    return original.apply(AtomicJsonFile, args);
                                }
                            );
                        } else if (phase === 'temporary-file') {
                            const original = promises.writeFile;
                            context.mock.method(promises, 'writeFile', (async (
                                ...args: Parameters<typeof original>
                            ) => {
                                await original(...args);
                                if (
                                    String(args[0]).startsWith(`${paths[artifact]}.`) &&
                                    String(args[0]).endsWith('.tmp') &&
                                    first
                                ) {
                                    first = false;
                                    entered.release();
                                    await release.promise;
                                }
                            }) as typeof original);
                        } else {
                            const original = promises.rename;
                            context.mock.method(promises, 'rename', async (...args: Parameters<typeof original>) => {
                                if (String(args[1]) === paths[artifact] && first) {
                                    first = false;
                                    entered.release();
                                    await release.promise;
                                    throw Object.assign(new Error('busy destination'), { code: 'EBUSY' });
                                }
                                return original(...args);
                            });
                        }
                        const writing = f.fileLogger.getDateStats(date, true);
                        const successor = host.emptyStats();
                        successor.total.requests = 2;
                        const fingerprint = createHash('sha256').update(JSON.stringify(successor)).digest('hex');
                        const index = {
                            dates: {
                                [date]: {
                                    total_input: 0,
                                    total_cache: 0,
                                    total_output: 0,
                                    total_requests: 2,
                                    total_cost: 0
                                }
                            }
                        };
                        const expected = {
                            marker: JSON.stringify({ pending: [fingerprint] }),
                            stats: JSON.stringify(successor),
                            index: JSON.stringify(index)
                        };
                        let timer: ReturnType<typeof setTimeout> | undefined;
                        try {
                            await Promise.race([
                                entered.promise,
                                new Promise<never>((_, reject) => {
                                    timer = setTimeout(() => reject(new Error('write boundary not reached')), 5000);
                                })
                            ]);
                            host.state.leaderId = 'successor';
                            await fs.writeFile(paths.marker, expected.marker);
                            await fs.writeFile(paths.stats, expected.stats);
                            await fs.writeFile(paths.index, expected.index);
                            await fs.writeFile(join(folder, 'stats-published.json'), JSON.stringify(fingerprint));
                        } finally {
                            clearTimeout(timer);
                            release.release();
                            await writing;
                        }
                        for (const key of ['marker', 'stats', 'index'] as const) {
                            assert.equal(await fs.readFile(paths[key], 'utf8'), expected[key], key);
                        }
                        assert.equal(await new StatsPublication().isPending(paths.stats, fingerprint), false);
                        assert.equal(await new StatsPublication().readPendingStats(paths.stats), undefined);
                    });
                }
            }
        } finally {
            host.restore();
        }
    }
);
