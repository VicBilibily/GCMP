import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';
import { AtomicJsonFile } from '../../atomicJsonFile';
import { StatsPublication } from './statsPublication';
import { countStatsReads, fingerprint, publicationFixture, publicationStats } from './publicationCacheFixture';

for (const restart of [false, true]) {
    test(`applied versions stay lightweight after initial reconciliation, restart=${restart}`, async context => {
        const f = await publicationFixture(context, true);
        const reader = restart ? new StatsPublication() : f.publication;
        const reads = countStatsReads(context);
        if (restart) {
            assert.deepEqual(await reader.readPendingStats(f.statsPath), f.current);
            await reader.acknowledge(f.statsPath, fingerprint(f.current), () => true);
        }
        for (let round = 0; round < 3; round++) {
            assert.equal(await reader.readPendingStats(f.statsPath), undefined);
            assert.equal(reads(), restart ? 1 : 0);
        }
        await assert.rejects(readFile(f.markerPath), { code: 'ENOENT' });
    });
}

test('a cold tracker reads the current version once and acknowledges only in memory', async context => {
    const f = await publicationFixture(context);
    const reader = new StatsPublication(),
        reads = countStatsReads(context);
    assert.deepEqual(await reader.readPendingStats(f.statsPath), f.current);
    await reader.acknowledge(f.statsPath, fingerprint(f.current), () => true);
    for (let round = 0; round < 3; round++) {
        assert.equal(await reader.readPendingStats(f.statsPath), undefined);
        assert.equal(reads(), 1);
    }
    await assert.rejects(readFile(f.receiptPath), { code: 'ENOENT' });
});

test('a pending disk fingerprint can be reused after its acknowledgement without retaining statistics', async context => {
    const f = await publicationFixture(context);
    const latest = await f.save(3);
    const reads = countStatsReads(context);
    assert.deepEqual(await f.publication.readPendingStats(f.statsPath), latest);
    assert.equal(reads(), 1);
    assert.equal(await f.publication.acknowledge(f.statsPath, fingerprint(latest), () => true), true);
    for (let round = 0; round < 3; round++) {
        assert.equal(await f.publication.readPendingStats(f.statsPath), undefined);
        assert.equal(reads(), 1);
    }
});

test('all historical dates stay lightweight and deleted dates release their metadata', async context => {
    const f = await publicationFixture(context);
    const stats = publicationStats(2),
        current = fingerprint(stats);
    const paths: string[] = [];
    for (let index = 0; index < 257; index++) {
        const folder = join(f.dir, String(index)),
            path = join(folder, 'stats.json');
        await AtomicJsonFile.writeJsonAtomically(path, stats);
        assert.deepEqual(await f.publication.readPendingStats(path), stats);
        await f.publication.acknowledge(path, current, () => true);
        paths.push(path);
    }
    const reads = countStatsReads(context);
    assert.equal(await f.publication.readPendingStats(paths[256]), undefined);
    assert.equal(reads(), 0);
    assert.equal(await f.publication.readPendingStats(paths[0]), undefined);
    assert.equal(reads(), 0);
    f.publication.retain(new Set([paths[256]]));
    assert.deepEqual(await f.publication.readPendingStats(paths[0]), stats);
    assert.equal(reads(), 1);
});

for (const confirmed of [false, true]) {
    test(`uncommitted legacy intent cannot change local application state, confirmed=${confirmed}`, async context => {
        const f = await publicationFixture(context);
        const tracker = confirmed ? f.publication : new StatsPublication();
        await writeFile(f.markerPath, JSON.stringify({ pending: [fingerprint(publicationStats(3))] }));
        const result = await tracker.readPendingStats(f.statsPath);
        assert.deepEqual(result, confirmed ? undefined : f.current);
        assert.equal(await tracker.isPending(f.statsPath, fingerprint(f.current)), !confirmed);
    });
}

test('reconciliation never creates a persistent acknowledgement', async context => {
    const f = await publicationFixture(context);
    const next = await f.save(3);
    assert.equal(await f.publication.isPending(f.statsPath, fingerprint(next)), true);
    await f.publication.acknowledge(f.statsPath, fingerprint(next), () => true);
    await assert.rejects(readFile(f.receiptPath), { code: 'ENOENT' });
});
