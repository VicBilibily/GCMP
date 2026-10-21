import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import { test } from 'node:test';
import { AtomicJsonFile } from '../../../atomicJsonFile';
import { fingerprint, publicationFixture, publicationStats } from '../../../fileLogger/refresh/publicationCacheFixture';
import { StatsPublication } from '../../../fileLogger/refresh/statsPublication';

test('reconciliation discovers only the latest committed statistics', async context => {
    const f = await publicationFixture(context, true);
    await f.save(3);
    await f.save(4);
    const latest = publicationStats(4);
    assert.deepEqual(await f.publication.readPendingStats(f.statsPath), latest);
    assert.equal(await f.publication.acknowledge(f.statsPath, fingerprint(publicationStats(3)), () => true), false);
    assert.equal(await f.publication.acknowledge(f.statsPath, fingerprint(latest), () => true), true);
    assert.equal(await f.publication.readPendingStats(f.statsPath), undefined);
    assert.deepEqual(await new StatsPublication().readPendingStats(f.statsPath), latest);
});

test('invalid legacy protocol files cannot block committed statistics', async context => {
    const f = await publicationFixture(context, true);
    for (const value of ['{', 'null', '42', JSON.stringify({ pending: [], baseVersion: false })]) {
        await fs.writeFile(f.markerPath, value);
        await fs.writeFile(f.receiptPath, value);
        const publication = new StatsPublication();
        assert.deepEqual(await publication.readPendingStats(f.statsPath), f.current);
        assert.equal(await publication.acknowledge(f.statsPath, fingerprint(f.current), () => true), true);
        assert.equal(await fs.readFile(f.markerPath, 'utf8'), value);
        assert.equal(await fs.readFile(f.receiptPath, 'utf8'), value);
    }
});

test('failed parsing leaves the next reconciliation retryable', async context => {
    const f = await publicationFixture(context, true);
    await fs.writeFile(f.statsPath, '{');
    await assert.rejects(f.publication.readPendingStats(f.statsPath), SyntaxError);
    await AtomicJsonFile.writeJsonAtomically(f.statsPath, publicationStats(3));
    assert.deepEqual(await f.publication.readPendingStats(f.statsPath), publicationStats(3));
    assert.equal(await f.publication.acknowledge(f.statsPath, fingerprint(publicationStats(3)), () => true), true);
    assert.equal(await f.publication.readPendingStats(f.statsPath), undefined);
});

test('retiring a deleted date drops only its in-memory confirmation', async context => {
    const f = await publicationFixture(context, true);
    f.publication.retain(new Set());
    assert.deepEqual(await f.publication.readPendingStats(f.statsPath), f.current);
    assert.deepEqual((await fs.readdir(f.dir)).sort(), ['stats.json']);
});
