import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import * as fs from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import { promisify } from 'node:util';
import type { ApiKeyBalanceLeaseHandoff } from '../../../interInstance/eventProtocol';
import { AtomicJsonFile } from '../../../usages/atomicJsonFile';
import {
    isValidBalanceLeaseHandoff,
    readBalanceLeaseHandoff,
    writeBalanceLeaseHandoff
} from './balanceLeaseHandoffFile';

function snapshot(now = Date.now(), sourceAuthorityTerm = 'leader-a:1'): ApiKeyBalanceLeaseHandoff {
    return {
        sourceAuthorityTerm,
        capturedAt: now,
        leases: [
            {
                leaseId: 'lease-a',
                slot: 'slot',
                balanceKey: 's:session',
                configId: 'config-a',
                credentialId: 'fingerprint-a',
                ownerInstanceId: 'follower-a',
                expiresAt: now + 30_000
            }
        ]
    };
}

async function directory(t: TestContext): Promise<string> {
    const result = await fs.mkdtemp(join(tmpdir(), 'gcmp-balance-file-'));
    t.after(() => fs.rm(result, { recursive: true, force: true }));
    return result;
}

function fileName(term: string): string {
    return `${createHash('sha256').update(term).digest('hex')}.json`;
}

test('missing snapshot directory has no handoff', async t => {
    const dir = await directory(t);
    assert.equal(await readBalanceLeaseHandoff(join(dir, 'missing')), undefined);
});

test('snapshot remains available to a later takeover attempt', async t => {
    const dir = await directory(t);
    const handoff = snapshot();
    await writeBalanceLeaseHandoff(handoff, dir);
    assert.deepEqual(await readBalanceLeaseHandoff(dir), handoff);
    assert.deepEqual(await readBalanceLeaseHandoff(dir), handoff);
});

test('late writes of an older term cannot hide a newer term snapshot', async t => {
    const dir = await directory(t);
    const now = Date.now();
    const newer = snapshot(now, 'leader-b:2');
    await writeBalanceLeaseHandoff(newer, dir);
    await writeBalanceLeaseHandoff(snapshot(now + 500, 'leader-a:1'), dir);
    assert.deepEqual(await readBalanceLeaseHandoff(dir, now + 500), newer);
});

test('older captures cannot overwrite the same term snapshot', async t => {
    const dir = await directory(t);
    const now = Date.now();
    const newer = snapshot(now);
    await writeBalanceLeaseHandoff(newer, dir);
    await writeBalanceLeaseHandoff(snapshot(now - 500), dir);
    assert.deepEqual(await readBalanceLeaseHandoff(dir), newer);
});

test('an empty successor snapshot prevents resurrection of released leases', async t => {
    const dir = await directory(t);
    const now = Date.now();
    await writeBalanceLeaseHandoff(snapshot(now), dir);
    const empty = { ...snapshot(now, 'leader-b:2'), leases: [] };
    await writeBalanceLeaseHandoff(empty, dir);
    assert.deepEqual(await readBalanceLeaseHandoff(dir), empty);
});

test('expired active-term snapshots are ignored without consuming the producer file', async t => {
    const dir = await directory(t);
    const now = Date.now();
    await writeBalanceLeaseHandoff(snapshot(now - 30_001), dir);
    assert.equal(await readBalanceLeaseHandoff(dir, now), undefined);
    assert.deepEqual(await fs.readdir(dir), [fileName('leader-a:1')]);
});

test('a producer refresh after an expired read is not deleted by the reader', async t => {
    const dir = await directory(t);
    const now = Date.now();
    await writeBalanceLeaseHandoff(snapshot(now - 30_001), dir);
    const refreshed = snapshot(now);
    const original = AtomicJsonFile.runExclusive.bind(AtomicJsonFile);
    let refreshAfterRead = true;
    t.mock.method(
        AtomicJsonFile,
        'runExclusive',
        async <T>(filePath: string, operation: () => Promise<T>): Promise<T> => {
            const result = await original(filePath, operation);
            if (refreshAfterRead) {
                refreshAfterRead = false;
                await writeBalanceLeaseHandoff(refreshed, dir);
            }
            return result;
        }
    );
    assert.equal(await readBalanceLeaseHandoff(dir, now), undefined);
    assert.deepEqual(await readBalanceLeaseHandoff(dir, now), refreshed);
});

test('expired retired-term files are cleaned after a newer term is observed', async t => {
    const dir = await directory(t);
    const now = Date.now();
    await writeBalanceLeaseHandoff(snapshot(now - 30_001), dir);
    const current = snapshot(now, 'leader-b:2');
    await writeBalanceLeaseHandoff(current, dir);
    assert.deepEqual(await readBalanceLeaseHandoff(dir, now), current);
    assert.deepEqual(await fs.readdir(dir), [fileName(current.sourceAuthorityTerm)]);
});

test('an expired newer term cannot fall back to a refreshed older term', async t => {
    const dir = await directory(t);
    const now = Date.now();
    await writeBalanceLeaseHandoff(snapshot(now - 30_001, 'leader-b:2'), dir);
    await writeBalanceLeaseHandoff(snapshot(now), dir);
    assert.equal(await readBalanceLeaseHandoff(dir, now), undefined);
});

test('future, malformed and mismatched filename snapshots are never imported', async t => {
    const dir = await directory(t);
    const now = Date.now();
    await fs.writeFile(join(dir, fileName('leader-a:1')), '{', 'utf8');
    assert.equal(await readBalanceLeaseHandoff(dir), undefined);
    await fs.writeFile(join(dir, fileName('leader-a:1')), JSON.stringify(snapshot(now, 'other:2')), 'utf8');
    assert.equal(await readBalanceLeaseHandoff(dir), undefined);
    await writeBalanceLeaseHandoff(snapshot(now + 1_001, 'leader-future:3'), dir);
    assert.equal(await readBalanceLeaseHandoff(dir, now), undefined);
});

test('duplicate lease ids and overlong expiry are rejected at the file boundary', async t => {
    const dir = await directory(t);
    const valid = snapshot();
    const duplicate = { ...valid, leases: [valid.leases[0], valid.leases[0]] };
    assert.equal(isValidBalanceLeaseHandoff(duplicate), false);
    await assert.rejects(writeBalanceLeaseHandoff(duplicate, dir), /Invalid/);
    valid.leases[0].expiresAt = valid.capturedAt + 31_001;
    assert.equal(isValidBalanceLeaseHandoff(valid), false);
    await assert.rejects(writeBalanceLeaseHandoff(valid, dir), /Invalid/);
});

test('extra key and request fields are not serialized', async t => {
    const dir = await directory(t);
    const value = snapshot();
    const extended = {
        ...value,
        apiKey: 'do-not-persist',
        leases: [{ ...value.leases[0], apiKey: 'do-not-persist', requestId: 'retry-state' }]
    };
    await writeBalanceLeaseHandoff(extended, dir);
    const raw = await fs.readFile(join(dir, fileName(value.sourceAuthorityTerm)), 'utf8');
    assert.equal(raw.includes('do-not-persist'), false);
    assert.equal(raw.includes('retry-state'), false);
    assert.deepEqual(await readBalanceLeaseHandoff(dir), value);
});

test('oversized files are ignored before reading their JSON', async t => {
    const dir = await directory(t);
    await fs.writeFile(join(dir, fileName('leader-a:1')), ' '.repeat(2 * 1024 * 1024 + 1), 'utf8');
    assert.equal(await readBalanceLeaseHandoff(dir), undefined);
});

test('separate Node processes persist different authority terms without overwriting each other', async t => {
    const dir = await directory(t);
    const now = Date.now();
    const moduleUrl = new URL('./balanceLeaseHandoffFile.ts', import.meta.url).href;
    const code =
        'const m = await import(process.argv[1]); const write = m.writeBalanceLeaseHandoff ?? m.default.writeBalanceLeaseHandoff; await write(JSON.parse(process.argv[2]), process.argv[3]);';
    const run = promisify(execFile);
    const older = snapshot(now, 'leader-a:1');
    const newer = snapshot(now, 'leader-b:2');
    await Promise.all(
        [older, newer].map(value =>
            run(process.execPath, [
                '--import=tsx',
                '--input-type=module',
                '--eval',
                code,
                moduleUrl,
                JSON.stringify(value),
                dir
            ])
        )
    );
    assert.equal((await fs.readdir(dir)).length, 2);
    assert.deepEqual(await readBalanceLeaseHandoff(dir), newer);
});
