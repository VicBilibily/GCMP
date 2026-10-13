import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';
import { AtomicJsonFile } from '../../../atomicJsonFile';
import { DateUtils } from '../../../fileLogger/dateUtils';
import type { DateIndex } from '../../../fileLogger/types';
import { createUsageHost } from '../../../tests/hostFixture';
import { snapshotFixture } from '../../../tests/snapshotFixture';

test('index retry and readonly operations preserve commit observations', async suite => {
    const host = await createUsageHost();
    const { LogIndexManager } = await import('../../../fileLogger/logIndexManager');
    try {
        for (const existed of [true, false]) {
            await suite.test(
                `new statistics in previously existing date directory=${existed} are not omitted`,
                async c => {
                    const f = await snapshotFixture(host, c);
                    const manager = new LogIndexManager(f.dir);
                    const path = manager.getIndexPath();
                    const before = JSON.parse(await readFile(path, 'utf8')) as DateIndex;
                    before.dates[f.date].total_requests = 0;
                    await writeFile(path, JSON.stringify(before));
                    const date = DateUtils.getDateStringDaysAgo(9);
                    const folder = join(f.dir, 'usages', date);
                    if (existed) {
                        await mkdir(folder, { recursive: true });
                    }
                    const body = await readFile(f.statsPath, 'utf8');
                    const original = AtomicJsonFile.writeJsonAtomically.bind(AtomicJsonFile);
                    let first = true;
                    c.mock.method(
                        AtomicJsonFile,
                        'writeJsonAtomically',
                        async (...args: Parameters<typeof original>) => {
                            if (first && args[0] === path) {
                                first = false;
                                await mkdir(folder, { recursive: true });
                                await writeFile(join(folder, 'stats.json'), body);
                            }
                            return original(...args);
                        }
                    );
                    const result = await manager.getIndex();
                    assert.equal(result[date]?.total_requests, 1);
                    assert.equal(result[f.date]?.total_requests, 1);
                    assert.equal(
                        (JSON.parse(await readFile(path, 'utf8')) as DateIndex).dates[date]?.total_requests,
                        1
                    );
                }
            );
        }
        await suite.test('persistent competing index writes stop after three CAS observations', async c => {
            const f = await snapshotFixture(host, c);
            const manager = new LogIndexManager(f.dir);
            const path = manager.getIndexPath();
            const before = JSON.parse(await readFile(path, 'utf8')) as DateIndex;
            before.dates[f.date].total_requests = 0;
            await writeFile(path, JSON.stringify(before));
            const original = AtomicJsonFile.writeJsonAtomically.bind(AtomicJsonFile);
            let attempts = 0;
            c.mock.method(AtomicJsonFile, 'writeJsonAtomically', async (...args: Parameters<typeof original>) => {
                if (args[0] === path) {
                    attempts++;
                    const current = JSON.parse(await readFile(path, 'utf8')) as DateIndex;
                    current.versionTimestamp = (current.versionTimestamp ?? 0) + 1;
                    await writeFile(path, JSON.stringify(current));
                }
                return original(...args);
            });
            await assert.rejects(manager.getIndex(), /observations changed/);
            assert.equal(attempts, 3);
            assert.equal((JSON.parse(await readFile(path, 'utf8')) as DateIndex).dates[f.date].total_requests, 0);
        });
        await suite.test('a follower cannot change version metadata or remove shared dates', async c => {
            const f = await snapshotFixture(host, c);
            const manager = (f.fileLogger as unknown as { indexManager: InstanceType<typeof LogIndexManager> })
                .indexManager;
            const path = manager.getIndexPath();
            const before = await readFile(path, 'utf8');
            host.state.leaderId = 'other';
            const writes = c.mock.method(AtomicJsonFile, 'writeJsonAtomically');
            await manager.setVersionTimestamp(999);
            await manager.removeDate(f.date);
            assert.equal(await readFile(path, 'utf8'), before);
            assert.equal(writes.mock.calls.filter(call => call.arguments[0] === path).length, 0);
        });
    } finally {
        host.restore();
    }
});
