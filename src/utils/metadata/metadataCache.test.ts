import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { readMetadataSnapshot, writeMetadataSnapshot } from './metadataCache';

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
