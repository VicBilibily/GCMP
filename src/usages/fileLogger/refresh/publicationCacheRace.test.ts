import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import { createRequire } from 'node:module';
import test from 'node:test';
import { AtomicJsonFile } from '../../atomicJsonFile';
import { StatsPublication } from './statsPublication';
import { countStatsReads, fingerprint, publicationFixture, publicationStats } from './publicationCacheFixture';

for (const mode of ['replace', 'same-mtime', 'in-place-same-size', 'missing-then-replace'] as const) {
    test(`a cached acknowledgement cannot hide externally replaced statistics: ${mode}`, async context => {
        const f = await publicationFixture(context);
        assert.equal(await f.publication.readPendingStats(f.statsPath), undefined);
        const before = await fs.stat(f.statsPath);
        const next = publicationStats(3);
        await fs.writeFile(f.markerPath, JSON.stringify({ pending: [fingerprint(next), fingerprint(f.current)] }));
        if (mode === 'missing-then-replace') {
            await fs.unlink(f.statsPath);
            assert.equal(await f.publication.readPendingStats(f.statsPath), undefined);
        }
        if (mode === 'in-place-same-size') {
            const content = JSON.stringify(next, null, 2);
            assert.equal(Buffer.byteLength(content), before.size);
            await fs.writeFile(f.statsPath, content);
        } else {
            await AtomicJsonFile.writeJsonAtomically(f.statsPath, next);
        }
        if (mode === 'same-mtime' || mode === 'in-place-same-size') {
            await fs.utimes(f.statsPath, before.atime, before.mtime);
        }
        const reads = countStatsReads(context);
        assert.deepEqual(await f.publication.readPendingStats(f.statsPath), next);
        assert.equal(reads(), 1);
        assert.equal(await f.publication.isPending(f.statsPath, fingerprint(next)), true);
    });
}

test('a late receipt cannot reuse a cached acknowledgement for another fingerprint', async context => {
    const f = await publicationFixture(context);
    assert.equal(await f.publication.readPendingStats(f.statsPath), undefined);
    await fs.writeFile(f.receiptPath, JSON.stringify(fingerprint(publicationStats(1))));
    assert.deepEqual(await f.publication.readPendingStats(f.statsPath), f.current);
    assert.equal(await f.publication.isPending(f.statsPath, fingerprint(f.current)), true);
});

test('a cross-process replacement during the full read cannot cache the previous fingerprint for the new file', async context => {
    const f = await publicationFixture(context);
    const require = createRequire(import.meta.url);
    const promises = require('node:fs/promises') as typeof fs;
    const read = promises.readFile;
    let replaced = false;
    const next = publicationStats(3);
    context.mock.method(promises, 'readFile', (async (...args: Parameters<typeof read>) => {
        const content = await read(...args);
        if (!replaced && String(args[0]) === f.statsPath) {
            replaced = true;
            await AtomicJsonFile.writeJsonAtomically(f.statsPath, next);
            await fs.writeFile(f.markerPath, JSON.stringify({ pending: [fingerprint(next), fingerprint(f.current)] }));
        }
        return content;
    }) as typeof read);
    assert.equal(await f.publication.readPendingStats(f.statsPath), undefined);
    assert.equal(replaced, true);
    assert.deepEqual(await f.publication.readPendingStats(f.statsPath), next);
});

for (const mode of ['invalid-stats', 'invalid-marker', 'invalid-receipt'] as const) {
    test(`a warm cache cannot hide corrupt disk data: ${mode}`, async context => {
        const f = await publicationFixture(context);
        assert.equal(await f.publication.readPendingStats(f.statsPath), undefined);
        const target =
            mode === 'invalid-stats' ? f.statsPath
            : mode === 'invalid-marker' ? f.markerPath
            : f.receiptPath;
        await fs.writeFile(target, '{');
        await assert.rejects(f.publication.readPendingStats(f.statsPath), SyntaxError);
    });
}

test('cache hits never mutate markers or receipts owned by another process', async context => {
    const f = await publicationFixture(context);
    assert.equal(await f.publication.readPendingStats(f.statsPath), undefined);
    const before = await Promise.all([fs.readFile(f.markerPath, 'utf8'), fs.readFile(f.receiptPath, 'utf8')]);
    const reads = countStatsReads(context);
    assert.equal(await f.publication.readPendingStats(f.statsPath), undefined);
    assert.equal(reads(), 0);
    assert.deepEqual(
        await Promise.all([fs.readFile(f.markerPath, 'utf8'), fs.readFile(f.receiptPath, 'utf8')]),
        before
    );
    assert.equal(await new StatsPublication().isPending(f.statsPath, fingerprint(f.current)), false);
});
