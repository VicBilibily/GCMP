import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import fs from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';
import { DateUtils } from '../../../fileLogger/dateUtils';
import type { DateIndex, TokenUsageStatsFromFile } from '../../../fileLogger/types';
import { createUsageHost } from '../../../tests/hostFixture';
import { snapshotFixture, snapshotRow } from '../../../tests/snapshotFixture';
import { indexFiles } from '../../statisticsFiles';

test('index body read failures preserve valid multi-date indexes', async suite => {
    const host = await createUsageHost();
    const { LogIndexManager } = await import('../../../fileLogger/logIndexManager');
    const faults = [
        { name: 'no fault', code: undefined, persistent: false },
        { name: 'transient EIO', code: 'EIO', persistent: false },
        { name: 'transient EACCES', code: 'EACCES', persistent: false },
        { name: 'transient EPERM', code: 'EPERM', persistent: false },
        { name: 'persistent EIO', code: 'EIO', persistent: true }
    ] as const;
    try {
        for (const action of ['updateIndex', 'setVersionTimestamp'] as const) {
            for (const fault of faults) {
                await suite.test(`${action}/${fault.name}`, async c => {
                    const f = await snapshotFixture(host, c);
                    const other = DateUtils.getDateStringDaysAgo(8);
                    await f.internals.snapshotManager.buildSnapshotFromLogs(other, [snapshotRow(other, 'other')]);
                    await f.fileLogger.getDateStats(other);
                    const manager = new LogIndexManager(f.dir);
                    const path = manager.getIndexPath();
                    const beforeBytes = await fs.readFile(path);
                    const before = JSON.parse(beforeBytes.toString('utf8')) as DateIndex;
                    const dates = [f.date, other].sort();
                    assert.deepEqual(Object.keys(before.dates).sort(), dates);
                    assert.deepEqual((await indexFiles.read(path)).value, before);
                    const saved = JSON.parse(await fs.readFile(f.statsPath, 'utf8')) as TokenUsageStatsFromFile;
                    indexFiles.invalidate(path);
                    const injected = Object.assign(new Error(`Injected index body read: ${fault.name}`), {
                        code: fault.code
                    });
                    const read = fs.readFile.bind(fs);
                    let bodyReads = 0;
                    let failures = 0;
                    const blocked = c.mock.method(fs, 'readFile', ((...args: Parameters<typeof read>) => {
                        if (String(args[0]) === path) {
                            bodyReads++;
                            if (fault.code && (fault.persistent || failures === 0)) {
                                failures++;
                                return Promise.reject(injected);
                            }
                        }
                        return read(...args);
                    }) as typeof fs.readFile);
                    try {
                        const operation =
                            action === 'updateIndex' ?
                                manager.updateIndex(f.date, saved.total)
                            :   manager.setVersionTimestamp(42);
                        if (fault.code && action === 'setVersionTimestamp') {
                            await assert.rejects(operation, error => {
                                assert.strictEqual(error, injected);
                                return true;
                            });
                        } else {
                            await operation;
                        }
                    } finally {
                        blocked.mock.restore();
                        assert.ok(bodyReads > 0);
                        assert.equal(
                            failures,
                            fault.persistent ? bodyReads
                            : fault.code ? 1
                            : 0
                        );
                    }
                    for (const statsPath of [f.statsPath, join(f.dir, 'usages', other, 'stats.json')]) {
                        assert.equal(existsSync(statsPath), true);
                    }
                    const afterBytes = await fs.readFile(path);
                    const after = JSON.parse(afterBytes.toString('utf8')) as DateIndex;
                    if (fault.code) {
                        assert.deepEqual(afterBytes, beforeBytes);
                    } else if (action === 'setVersionTimestamp') {
                        assert.equal(after.versionTimestamp, 42);
                    }
                    assert.deepEqual(after.dates, before.dates);
                    indexFiles.invalidate(path);
                    const fresh = await new LogIndexManager(f.dir).getIndexFast();
                    assert.deepEqual(Object.keys(fresh).sort(), dates);
                    assert.deepEqual(fresh, before.dates);
                });
            }
        }
    } finally {
        host.restore();
    }
});
