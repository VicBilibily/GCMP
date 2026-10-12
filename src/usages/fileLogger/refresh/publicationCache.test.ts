import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';
import { AtomicJsonFile } from '../../atomicJsonFile';
import { StatsPublication } from './statsPublication';
import { countStatsReads, fingerprint, publicationFixture, publicationStats } from './publicationCacheFixture';

for (const restart of [false, true]) {
    test(`confirmed previous versions need no full statistics read, restart=${restart}`, async context => {
        const f = await publicationFixture(context, true);
        const reader = restart ? new StatsPublication() : f.publication;
        const reads = countStatsReads(context);
        for (let round = 0; round < 3; round++) {
            assert.equal(await reader.readPendingStats(f.statsPath), undefined);
            assert.equal(reads(), 0);
        }
        const marker = JSON.parse(await readFile(f.markerPath, 'utf8')) as { pending: string[] };
        assert.deepEqual(marker.pending, [fingerprint(f.current)]);
    });
}

test('a cold two-version marker reads once then uses only lightweight file metadata', async context => {
    const f = await publicationFixture(context);
    const reader = new StatsPublication(),
        reads = countStatsReads(context);
    const marker = await readFile(f.markerPath, 'utf8');
    for (let round = 0; round < 3; round++) {
        assert.equal(await reader.readPendingStats(f.statsPath), undefined);
        assert.equal(reads(), 1);
    }
    assert.equal(await readFile(f.markerPath, 'utf8'), marker);
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

test('metadata eviction permits safe rereads while the most recent 256 dates stay lightweight', async context => {
    const f = await publicationFixture(context);
    const stats = publicationStats(2),
        current = fingerprint(stats);
    const paths: string[] = [];
    for (let index = 0; index < 257; index++) {
        const folder = join(f.dir, String(index)),
            path = join(folder, 'stats.json');
        await AtomicJsonFile.writeJsonAtomically(path, stats);
        await AtomicJsonFile.writeJsonAtomically(join(folder, 'stats-publication.json'), {
            pending: [current, 'older']
        });
        await AtomicJsonFile.writeJsonAtomically(join(folder, 'stats-published.json'), current);
        assert.equal(await f.publication.readPendingStats(path), undefined);
        paths.push(path);
    }
    const reads = countStatsReads(context);
    assert.equal(await f.publication.readPendingStats(paths[256]), undefined);
    assert.equal(reads(), 0);
    assert.equal(await f.publication.readPendingStats(paths[0]), undefined);
    assert.equal(reads(), 1);
});

for (const confirmed of [false, true]) {
    test(`an uncommitted successor preserves the saved publication state, confirmed=${confirmed}`, async context => {
        const f = await publicationFixture(context);
        if (!confirmed) {
            await writeFile(f.receiptPath, JSON.stringify(fingerprint(publicationStats(1))));
        }
        await f.publication.prepare(f.statsPath, fingerprint(publicationStats(3)));
        const result = await new StatsPublication().readPendingStats(f.statsPath);
        assert.deepEqual(result, confirmed ? undefined : f.current);
        assert.equal(await f.publication.isPending(f.statsPath, fingerprint(f.current)), !confirmed);
    });
}

test('preparing a newer intent never rewrites a previously persisted acknowledgement', async context => {
    const f = await publicationFixture(context);
    const receipt = await readFile(f.receiptPath, 'utf8');
    await f.publication.prepare(f.statsPath, fingerprint(publicationStats(3)));
    assert.equal(await readFile(f.receiptPath, 'utf8'), receipt);
    assert.equal(await f.publication.isPending(f.statsPath, fingerprint(publicationStats(3))), true);
});
