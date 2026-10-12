import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import { AtomicJsonFile } from '../../atomicJsonFile';
import { StatsPublication } from './statsPublication';

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

test('publication markers survive new instances and acknowledged versions do not repeat', async context => {
    const f = await fixture(context);
    await f.publication.prepare(f.statsPath, 'version-one');
    const replacement = new StatsPublication();
    assert.equal(await replacement.isPending(f.statsPath, 'version-one'), true);
    assert.equal(await replacement.acknowledge(f.statsPath, 'version-one', () => true), true);
    assert.equal(await new StatsPublication().isPending(f.statsPath, 'version-one'), false);
});

test('an old acknowledgement cannot clear a newer persisted publication version', async context => {
    const f = await fixture(context);
    await f.publication.prepare(f.statsPath, 'old');
    await f.publication.prepare(f.statsPath, 'new');
    assert.equal(await f.publication.acknowledge(f.statsPath, 'old', () => true), false);
    assert.equal(await new StatsPublication().isPending(f.statsPath, 'new'), true);
});

test('a prepared version does not advertise a previous stats file if its write has not completed', async context => {
    const f = await fixture(context);
    await f.publication.prepare(f.statsPath, 'new');
    assert.equal(await f.publication.isPending(f.statsPath, 'old'), false);
    assert.equal(await f.publication.isPending(f.statsPath, 'new'), true);
});

test('repeated failed stats writes preserve the on-disk pending version with a bounded marker', async context => {
    const f = await fixture(context);
    await f.publication.prepare(f.statsPath, 'persisted');
    for (let attempt = 0; attempt < 5; attempt++) {
        await f.publication.prepare(f.statsPath, `attempt-${attempt}`, 'persisted');
        assert.equal(await new StatsPublication().isPending(f.statsPath, 'persisted'), true);
        const marker = JSON.parse(await readFile(f.markerPath, 'utf8')) as { pending: string[] };
        assert.equal(marker.pending.length, 2);
    }
    assert.equal(await f.publication.acknowledge(f.statsPath, 'persisted', () => true), true);
    assert.equal(await f.publication.isPending(f.statsPath, 'attempt-4'), true);
});

test('failed acknowledgement writes retain a recoverable pending marker', async context => {
    const f = await fixture(context);
    await f.publication.prepare(f.statsPath, 'version');
    const write = AtomicJsonFile.writeJsonAtomically.bind(AtomicJsonFile);
    const mocked = context.mock.method(
        AtomicJsonFile,
        'writeJsonAtomically',
        async (...args: Parameters<typeof write>) => {
            if (args[0] === f.markerPath || args[0] === f.acknowledgementPath) {
                throw new Error('marker write unavailable');
            }
            await write(...args);
        }
    );
    await assert.rejects(
        f.publication.acknowledge(f.statsPath, 'version', () => true),
        /marker write unavailable/
    );
    assert.equal(await new StatsPublication().isPending(f.statsPath, 'version'), true);
    mocked.mock.restore();
    assert.equal(await f.publication.acknowledge(f.statsPath, 'version', () => true), true);
});

for (const revokeOn of [1, 2, 3]) {
    test(`publication permission is rechecked at boundary ${revokeOn}`, async context => {
        const f = await fixture(context);
        await f.publication.prepare(f.statsPath, 'version');
        let calls = 0;
        assert.equal(await f.publication.acknowledge(f.statsPath, 'version', () => ++calls < revokeOn), false);
        assert.equal(calls, revokeOn);
        assert.equal(await new StatsPublication().isPending(f.statsPath, 'version'), true);
    });
}

test('acknowledgements serialize with a newer stats write and cannot overwrite its marker', async context => {
    const f = await fixture(context);
    await f.publication.prepare(f.statsPath, 'old');
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
        await f.publication.prepare(f.statsPath, 'new');
    });
    await started;
    const acknowledging = f.publication.acknowledge(f.statsPath, 'old', () => true);
    release();
    await writing;
    assert.equal(await acknowledging, false);
    assert.equal(await f.publication.isPending(f.statsPath, 'new'), true);
});

test('legacy statistics without a publication marker keep their cache-hit contract', async context => {
    const f = await fixture(context);
    assert.equal(await f.publication.isPending(f.statsPath, 'version'), false);
    assert.equal(await f.publication.acknowledge(f.statsPath, 'version', () => true), false);
    await assert.rejects(readFile(f.markerPath), { code: 'ENOENT' });
});

test('a late acknowledgement without a shared process lock cannot erase a newer pending version', async context => {
    const f = await fixture(context);
    await f.publication.prepare(f.statsPath, 'old');
    const write = AtomicJsonFile.writeJsonAtomically.bind(AtomicJsonFile);
    let release!: () => void;
    let entered!: () => void;
    const gate = new Promise<void>(resolve => {
        release = resolve;
    });
    const started = new Promise<void>(resolve => {
        entered = resolve;
    });
    context.mock.method(AtomicJsonFile, 'writeJsonAtomically', async (...args: Parameters<typeof write>) => {
        entered();
        await gate;
        return write(...args);
    });
    const old = f.publication.acknowledge(f.statsPath, 'old', () => true);
    try {
        await started;
        await writeFile(f.markerPath, JSON.stringify({ pending: ['new', 'old'] }));
        await writeFile(f.acknowledgementPath, JSON.stringify('new'));
    } finally {
        release();
        await old;
    }
    const marker = JSON.parse(await readFile(f.markerPath, 'utf8')) as { pending: string[] };
    assert.ok(marker.pending.includes('new'));
    assert.equal(await new StatsPublication().isPending(f.statsPath, 'new'), true);
    await f.publication.acknowledge(f.statsPath, 'new', () => true);
    assert.equal(await new StatsPublication().isPending(f.statsPath, 'new'), false);
});

test('invalid publication metadata is not accepted as an acknowledgement', async context => {
    const f = await fixture(context);
    await writeFile(f.markerPath, JSON.stringify({ fingerprint: 'version', published: 'true' }));
    await assert.rejects(f.publication.isPending(f.statsPath, 'version'), /Invalid statistics publication marker/);
    await assert.rejects(
        f.publication.acknowledge(f.statsPath, 'version', () => true),
        /Invalid statistics publication marker/
    );
});
