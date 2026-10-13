import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFile, writeFile } from 'node:fs/promises';
import test from 'node:test';
import { createUsageHost } from '../../tests/hostFixture';
import { gate, snapshotFixture } from '../../tests/snapshotFixture';
import { statisticsFiles, indexFiles } from '../statisticsFiles';

const require = createRequire(import.meta.url);
const fs = require('node:fs/promises') as typeof import('node:fs/promises');

test('statistics queries reuse bodies while preserving source checks and object provenance', async t => {
    const host = await createUsageHost();
    try {
        const f = await snapshotFixture(host, t);
        statisticsFiles.invalidate(f.statsPath);
        const reads = t.mock.method(fs, 'readFile');
        const count = () => reads.mock.calls.filter(call => String(call.arguments[0]) === f.statsPath).length;
        const first = await f.internals.logStatsManager.getDateStats(f.date);
        assert.equal(count(), 1);
        const results = await Promise.all(
            Array.from({ length: 20 }, () => f.internals.logStatsManager.getDateStats(f.date))
        );
        assert.equal(count(), 1);
        first.total.requests = 99;
        assert.equal(results[0].total.requests, 1);
        assert.equal((await f.internals.logStatsManager.getDateStats(f.date)).total.requests, 1);
        await f.changeTitle();
        assert.equal(await f.privateStats.needsRegeneration(f.date), true);
        await f.internals.logStatsManager.getDateStats(f.date);
        assert.equal(await f.privateStats.needsRegeneration(f.date), false);
    } finally {
        host.restore();
    }
});

test('statistics query detects replacement during its freshness check', async t => {
    const host = await createUsageHost();
    try {
        const f = await snapshotFixture(host, t);
        const original = f.privateStats.needsRegeneration.bind(f.privateStats);
        const entered = gate();
        const release = gate();
        let first = true;
        t.mock.method(f.privateStats, 'needsRegeneration', async (...args: Parameters<typeof original>) => {
            const result = await original(...args);
            if (first) {
                first = false;
                entered.release();
                await release.promise;
            }
            return result;
        });
        const query = f.internals.logStatsManager.getDateStats(f.date);
        await entered.promise;
        const next = JSON.parse(
            await readFile(f.statsPath, 'utf8')
        ) as import('../../fileLogger/types').TokenUsageStatsFromFile;
        next.total.requests = 2;
        await writeFile(f.statsPath, JSON.stringify(next));
        release.release();
        assert.equal((await query).total.requests, 2);
    } finally {
        host.restore();
    }
});

test('index reads reuse parsed versions without sharing mutable update state', async t => {
    const host = await createUsageHost();
    try {
        const f = await snapshotFixture(host, t);
        const manager = new (await import('../../fileLogger/logIndexManager')).LogIndexManager(f.dir);
        const path = manager.getIndexPath();
        indexFiles.invalidate(path);
        const reads = t.mock.method(fs, 'readFile');
        const first = await manager.getIndexFast();
        await manager.getIndexFast();
        assert.equal(reads.mock.calls.filter(call => String(call.arguments[0]) === path).length, 1);
        first[f.date].total_requests = 99;
        assert.equal((await manager.getIndexFast())[f.date].total_requests, 1);
        await manager.updateIndex(f.date, { ...(await f.privateStats.loadStats(f.date))!.total, requests: 2 });
        assert.equal((await manager.getIndexFast())[f.date].total_requests, 2);
    } finally {
        host.restore();
    }
});

test('shared statistics parsing preserves index summaries without accepting incomplete status data', async t => {
    const host = await createUsageHost();
    try {
        const f = await snapshotFixture(host, t);
        const saved = (await f.privateStats.loadStats(f.date))!;
        const manager = new (await import('../../fileLogger/logIndexManager')).LogIndexManager(f.dir);
        await writeFile(f.statsPath, JSON.stringify({ total: saved.total }));
        const reads = t.mock.method(fs, 'readFile');
        const count = () => reads.mock.calls.filter(call => String(call.arguments[0]) === f.statsPath).length;
        assert.equal((await manager.getIndex())[f.date]?.total_requests, 1);
        assert.equal(await f.internals.logStatsManager.readSavedStats(f.date), null);
        assert.equal(count(), 1);
        await writeFile(f.statsPath, JSON.stringify(saved));
        assert.equal((await f.internals.logStatsManager.readSavedStats(f.date))?.total.requests, 1);
        assert.equal(count(), 2);
    } finally {
        host.restore();
    }
});
