import assert from 'node:assert/strict';
import fs, { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { readMetadataSnapshot, withMetadataCacheTransaction, writeMetadataSnapshot } from './metadataCache';
import { AtomicJsonFile, WritePermissionLostError } from '../../usages/atomicJsonFile';

async function withTempDir(run: (dir: string) => Promise<void>): Promise<void> {
    const dir = await mkdtemp(path.join(tmpdir(), 'gcmp-metadata-'));
    try {
        await run(dir);
    } finally {
        await rm(dir, { recursive: true, force: true });
    }
}

const VALID_PAYLOAD = JSON.stringify({
    schemaVersion: 1,
    contentHash: '368f63c6bb20',
    cli: {
        claudeCode: { version: '2.1.263' },
        codexTui: { version: '0.153.4', originator: 'codex-tui' }
    }
});

function deferred(): { promise: Promise<void>; resolve: () => void } {
    let resolve!: () => void;
    const promise = new Promise<void>(done => {
        resolve = done;
    });
    return { promise, resolve };
}

for (const expiresWhileWaiting of [false, true]) {
    test(`cache transactions serialize reads and writes, waiting permission expires=${expiresWhileWaiting}`, async context => {
        await withTempDir(async directory => {
            const file = path.join(directory, 'metadata', 'metadata.json');
            const entered = deferred();
            const release = deferred();
            const waiting = deferred();
            const originalMkdir = fs.mkdir;
            let attempts = 0;
            let allowed = true;
            const events: string[] = [];
            context.mock.method(fs, 'mkdir', async (...args: Parameters<typeof fs.mkdir>) => {
                if (String(args[0]) === `${file}.refresh.lock` && ++attempts === 2) {
                    waiting.resolve();
                }
                return originalMkdir(...args);
            });
            const first = withMetadataCacheTransaction(
                file,
                () => true,
                async () => {
                    events.push('first-entered');
                    entered.resolve();
                    await release.promise;
                    await writeMetadataSnapshot(file, VALID_PAYLOAD, () => true);
                    events.push('first-committed');
                }
            );
            let second: Promise<void> | undefined;
            let outcome: Promise<void> | undefined;
            try {
                await entered.promise;
                second = withMetadataCacheTransaction(
                    file,
                    () => allowed,
                    async () => {
                        events.push('second-entered');
                        assert.equal((await readMetadataSnapshot(file))?.cli.codexTuiVersion, '0.153.4');
                    }
                );
                outcome = expiresWhileWaiting ? assert.rejects(second, WritePermissionLostError) : second;
                await waiting.promise;
                assert.deepEqual(events, ['first-entered']);
                allowed = !expiresWhileWaiting;
                release.resolve();
                await Promise.all([first, outcome]);
                assert.deepEqual(
                    events,
                    expiresWhileWaiting ?
                        ['first-entered', 'first-committed']
                    :   ['first-entered', 'first-committed', 'second-entered']
                );
                assert.deepEqual(await readdir(path.dirname(file)), ['metadata.json']);
            } finally {
                release.resolve();
                await Promise.allSettled([first, second, outcome]);
            }
        });
    });
}

test('cache transaction rejects expired permission before creating files', async () => {
    await withTempDir(async directory => {
        await assert.rejects(
            withMetadataCacheTransaction(
                path.join(directory, 'nested', 'metadata.json'),
                () => false,
                async () => assert.fail('Expired transaction must not run')
            ),
            WritePermissionLostError
        );
        assert.deepEqual(await readdir(directory), []);
    });
});

test('cache transaction releases its lock after an operation fails', async () => {
    await withTempDir(async directory => {
        const file = path.join(directory, 'metadata.json');
        const failure = new Error('Cache operation failed');
        await assert.rejects(
            withMetadataCacheTransaction(
                file,
                () => true,
                async () => {
                    throw failure;
                }
            ),
            failure
        );
        await withMetadataCacheTransaction(
            file,
            () => true,
            () => writeMetadataSnapshot(file, VALID_PAYLOAD, () => true)
        );
        assert.equal(await readFile(file, 'utf8'), VALID_PAYLOAD);
        assert.deepEqual(await readdir(directory), ['metadata.json']);
    });
});

test('write + read roundtrip returns parsed snapshot with recomputed content hash', async () => {
    await withTempDir(async dir => {
        const file = path.join(dir, 'metadata', 'gcmp-metadata.json');
        await writeMetadataSnapshot(file, VALID_PAYLOAD);
        const snapshot = await readMetadataSnapshot(file);
        assert.equal(snapshot?.cli.claudeCodeVersion, '2.1.263');
        assert.equal(snapshot?.cli.codexTuiVersion, '0.153.4');
        assert.equal(snapshot?.cli.codexTuiOriginator, 'codex-tui');
        assert.equal(snapshot?.contentHash, '368f63c6bb20');
    });
});

test('readMetadataSnapshot returns undefined when file is missing', async () => {
    await withTempDir(async dir => {
        assert.equal(await readMetadataSnapshot(path.join(dir, 'missing.json')), undefined);
    });
});

test('readMetadataSnapshot returns undefined for invalid JSON or unsupported schemaVersion', async () => {
    await withTempDir(async dir => {
        const badJson = path.join(dir, 'bad.json');
        await writeMetadataSnapshot(badJson, 'not-json');
        assert.equal(await readMetadataSnapshot(badJson), undefined);

        const badSchema = path.join(dir, 'schema.json');
        await writeMetadataSnapshot(badSchema, JSON.stringify({ schemaVersion: 2, cli: {} }));
        assert.equal(await readMetadataSnapshot(badSchema), undefined);
    });
});

test('guarded metadata writes commit while permission remains valid', async () => {
    await withTempDir(async dir => {
        const file = path.join(dir, 'metadata.json');
        await writeMetadataSnapshot(file, VALID_PAYLOAD, () => true);
        assert.equal(await readFile(file, 'utf8'), VALID_PAYLOAD);
        assert.deepEqual(await readdir(dir), ['metadata.json']);
    });
});

for (const phase of ['before', 'queued', 'written', 'rename-retry'] as const) {
    test(`guarded metadata write preserves previous cache after permission expires: ${phase}`, async context => {
        await withTempDir(async dir => {
            const file = path.join(dir, 'metadata.json');
            await writeFile(file, VALID_PAYLOAD);
            let allowed = phase !== 'before';
            let release: (() => void) | undefined;
            let held: Promise<void> | undefined;
            const updated = JSON.stringify({ schemaVersion: 1, cli: { codexTui: { version: '0.200.0' } } });
            if (phase === 'queued') {
                const blocked = new Promise<void>(resolve => {
                    release = resolve;
                });
                held = AtomicJsonFile.runExclusive(file, () => blocked);
            }
            if (phase === 'written') {
                const original = fs.writeFile;
                context.mock.method(fs, 'writeFile', async (...args: Parameters<typeof fs.writeFile>) => {
                    await original(...args);
                    if (String(args[0]).startsWith(`${file}.`) && String(args[0]).endsWith('.tmp')) {
                        allowed = false;
                    }
                });
            }
            let renameAttempts = 0;
            if (phase === 'rename-retry') {
                context.mock.method(fs, 'rename', async () => {
                    renameAttempts++;
                    allowed = false;
                    throw Object.assign(new Error('Transient rename failure'), { code: 'EBUSY' });
                });
            }
            try {
                const pending = writeMetadataSnapshot(file, updated, () => allowed);
                if (phase === 'queued') {
                    allowed = false;
                    release?.();
                }
                await assert.rejects(pending, WritePermissionLostError);
                assert.equal(await readFile(file, 'utf8'), VALID_PAYLOAD);
                assert.deepEqual(await readdir(dir), ['metadata.json']);
                assert.equal(renameAttempts, phase === 'rename-retry' ? 1 : 0);
            } finally {
                release?.();
                await held;
            }
        });
    });
}
