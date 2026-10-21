import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import { AtomicJsonFile } from '../../atomicJsonFile';
import { StatsPublication } from './statsPublication';
import { fingerprint, publicationStats } from './publicationCacheFixture';

async function fixture(context: TestContext) {
    const dir = await mkdtemp(join(tmpdir(), 'gcmp-publication-'));
    context.after(() => rm(dir, { recursive: true, force: true }));
    const statsPath = join(dir, 'stats.json');
    return {
        publication: new StatsPublication(),
        statsPath,
        markerPath: join(dir, 'stats-publication.json'),
        acknowledgementPath: join(dir, 'stats-published.json')
    };
}

test('committed statistics are discovered without publication files', async context => {
    const f = await fixture(context);
    const stats = publicationStats(3);
    await writeFile(f.statsPath, JSON.stringify(stats));
    assert.deepEqual(await f.publication.readPendingStats(f.statsPath), stats);
});

test('committed statistics are acknowledged in memory without sidecar files', async context => {
    const f = await fixture(context);
    const stats = publicationStats(3);
    await writeFile(f.statsPath, JSON.stringify(stats));
    assert.equal(await f.publication.acknowledge(f.statsPath, fingerprint(stats), () => true), true);
    assert.equal(await f.publication.readPendingStats(f.statsPath), undefined);
    assert.deepEqual(await readdir(join(f.statsPath, '..')), ['stats.json']);
});

test('restarts rediscover the latest committed version rather than persisted acknowledgements', async context => {
    const f = await fixture(context);
    const stats = publicationStats(2);
    await writeFile(f.statsPath, JSON.stringify(stats));
    await f.publication.acknowledge(f.statsPath, fingerprint(stats), () => true);
    assert.deepEqual(await new StatsPublication().readPendingStats(f.statsPath), stats);
});

test('an old acknowledgement cannot hide a newer committed statistics file', async context => {
    const f = await fixture(context);
    const previous = publicationStats(2);
    const latest = publicationStats(3);
    await writeFile(f.statsPath, JSON.stringify(previous));
    await f.publication.readPendingStats(f.statsPath);
    await AtomicJsonFile.writeJsonAtomically(f.statsPath, latest);
    assert.equal(await f.publication.acknowledge(f.statsPath, fingerprint(previous), () => true), false);
    assert.deepEqual(await f.publication.readPendingStats(f.statsPath), latest);
});

test('legacy publication files are ignored even when corrupt', async context => {
    const f = await fixture(context);
    const stats = publicationStats(2);
    await writeFile(f.statsPath, JSON.stringify(stats));
    await writeFile(f.markerPath, '{');
    await writeFile(f.acknowledgementPath, '{');
    assert.deepEqual(await f.publication.readPendingStats(f.statsPath), stats);
    assert.equal(await f.publication.acknowledge(f.statsPath, fingerprint(stats), () => true), true);
    assert.equal(await readFile(f.markerPath, 'utf8'), '{');
    assert.equal(await readFile(f.acknowledgementPath, 'utf8'), '{');
});

for (const revokeOn of [1, 2, 3]) {
    test(`publication permission is rechecked at boundary ${revokeOn}`, async context => {
        const f = await fixture(context);
        const stats = publicationStats(2);
        await writeFile(f.statsPath, JSON.stringify(stats));
        let calls = 0;
        assert.equal(await f.publication.acknowledge(f.statsPath, fingerprint(stats), () => ++calls < revokeOn), false);
        assert.equal(calls, revokeOn);
        assert.equal(await f.publication.isPending(f.statsPath, fingerprint(stats)), true);
    });
}

test('acknowledgements serialize with a newer stats write without modifying that write', async context => {
    const f = await fixture(context);
    const previous = publicationStats(2);
    const latest = publicationStats(3);
    await writeFile(f.statsPath, JSON.stringify(previous));
    let release!: () => void;
    let entered!: () => void;
    const gate = new Promise<void>(resolve => {
        release = resolve;
    });
    const started = new Promise<void>(resolve => {
        entered = resolve;
    });
    const writing = AtomicJsonFile.runExclusive(f.statsPath, async () => {
        entered();
        await gate;
        await AtomicJsonFile.writeJsonAtomically(f.statsPath, latest);
    });
    await started;
    const acknowledging = f.publication.acknowledge(f.statsPath, fingerprint(previous), () => true);
    release();
    await writing;
    assert.equal(await acknowledging, false);
    assert.equal(await f.publication.isPending(f.statsPath, fingerprint(latest)), true);
});

test('missing statistics remain retryable when a file later appears', async context => {
    const f = await fixture(context);
    assert.equal(await f.publication.isPending(f.statsPath, 'version'), false);
    assert.equal(await f.publication.acknowledge(f.statsPath, 'version', () => true), false);
    await assert.rejects(readFile(f.markerPath), { code: 'ENOENT' });
    const stats = publicationStats(2);
    await writeFile(f.statsPath, JSON.stringify(stats));
    assert.deepEqual(await f.publication.readPendingStats(f.statsPath), stats);
});
