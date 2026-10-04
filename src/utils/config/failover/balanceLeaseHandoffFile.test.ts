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
    isBalanceLeaseHandoffNewer,
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

for (const sample of [
    { name: 'aged during recovery', capturedOffset: -25_000, accepted: true },
    { name: 'captured while recovery was queued', capturedOffset: 2_500, accepted: true },
    { name: 'exact admission expiry boundary', capturedOffset: -30_000, accepted: true },
    { name: 'expired before admission', capturedOffset: -30_001, accepted: false },
    { name: 'future relative to the read clock', capturedOffset: 6_501, accepted: false }
]) {
    test(`recovery admission preserves freshness rules: ${sample.name}`, async t => {
        const dir = await directory(t);
        const startedAt = Date.now();
        const handoff = snapshot(startedAt + sample.capturedOffset);
        await writeBalanceLeaseHandoff(handoff, dir);
        assert.deepEqual(
            await readBalanceLeaseHandoff(dir, startedAt + 5_500, startedAt),
            sample.accepted ? handoff : undefined
        );
        assert.deepEqual(await fs.readdir(dir), [fileName(handoff.sourceAuthorityTerm)]);
    });
}

for (const expired of [false, true]) {
    test(`admission never restores an older lease over a newer empty term: expired=${expired}`, async t => {
        const dir = await directory(t);
        const startedAt = Date.now();
        await writeBalanceLeaseHandoff(snapshot(startedAt - 25_000), dir);
        const empty = {
            ...snapshot(startedAt - (expired ? 30_001 : 25_000), 'leader-b:2'),
            leases: []
        };
        await writeBalanceLeaseHandoff(empty, dir);
        assert.deepEqual(await readBalanceLeaseHandoff(dir, startedAt + 5_500, startedAt), expired ? undefined : empty);
    });
}

for (const clock of ['live', 'fixed'] as const) {
    for (const capturedOffset of [2_500, 6_500, 6_501, -31_001]) {
        test(`observation clock: ${clock}, capture offset ${capturedOffset}`, async t => {
            const dir = await directory(t);
            const startedAt = Date.now();
            let now = startedAt;
            t.mock.method(Date, 'now', () => now);
            await writeBalanceLeaseHandoff(snapshot(startedAt - 40_000), dir);
            const replacement = snapshot(startedAt + capturedOffset);
            const original = AtomicJsonFile.runExclusive;
            let refresh = true;
            t.mock.method(
                AtomicJsonFile,
                'runExclusive',
                async <T>(path: string, operation: () => Promise<T>): Promise<T> => {
                    if (refresh) {
                        refresh = false;
                        now = startedAt + 2_500;
                        await writeBalanceLeaseHandoff(replacement, dir);
                        now = startedAt + 5_500;
                    }
                    return (original<T>).call(AtomicJsonFile, path, operation);
                }
            );
            const expected = clock === 'live' && (capturedOffset === 2_500 || capturedOffset === 6_500);
            assert.deepEqual(
                await readBalanceLeaseHandoff(dir, clock === 'fixed' ? startedAt : undefined, startedAt),
                expected ? replacement : undefined
            );
            assert.deepEqual(await fs.readdir(dir), [fileName(replacement.sourceAuthorityTerm)]);
        });
    }
}

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

for (const revision of [0, -1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1, '1', null]) {
    test(`快照序号拒绝非法值：${String(revision)}`, async t => {
        const dir = await directory(t);
        const invalid = { ...snapshot(), revision };
        assert.equal(isValidBalanceLeaseHandoff(invalid), false);
        await fs.writeFile(join(dir, fileName(invalid.sourceAuthorityTerm)), JSON.stringify(invalid));
        assert.equal(await readBalanceLeaseHandoff(dir), undefined);
        if (typeof revision === 'number') {
            const invalidNumber = { ...snapshot(), revision };
            await assert.rejects(writeBalanceLeaseHandoff(invalidNumber, dir), /Invalid/);
        }
    });
}

for (const revision of [undefined, 1, Number.MAX_SAFE_INTEGER]) {
    test(`快照序号持久化兼容：${revision}`, async t => {
        const dir = await directory(t);
        const value = revision === undefined ? snapshot() : { ...snapshot(), revision };
        assert.equal(isValidBalanceLeaseHandoff(value), true);
        await writeBalanceLeaseHandoff(value, dir);
        assert.deepEqual(await readBalanceLeaseHandoff(dir), value);
    });
}

for (const legacy of [false, true]) {
    for (const offset of [-500, 0, 500]) {
        for (const lateOlderWrite of [false, true]) {
            test(`同任期序号与旧格式时钟兼容：${legacy}, ${offset}, ${lateOlderWrite}`, async t => {
                const dir = await directory(t);
                const now = Date.now();
                const older = legacy ? snapshot(now) : { ...snapshot(now), revision: 7 };
                const newer = { ...snapshot(now + offset), revision: 8, leases: [] };
                assert.equal(isBalanceLeaseHandoffNewer(newer, older), !legacy || offset > 0);
                assert.equal(isBalanceLeaseHandoffNewer(older, newer), legacy && offset < 0);
                for (const value of lateOlderWrite ? [newer, older] : [older, newer]) {
                    await writeBalanceLeaseHandoff(value, dir);
                }
                const expected =
                    !legacy || offset > 0 ? newer
                    : offset < 0 || lateOlderWrite ? older
                    : newer;
                assert.deepEqual(await readBalanceLeaseHandoff(dir, now + 500), expected);
            });
        }
    }
}

for (const revised of [false, true]) {
    test(`较旧任期的高序号不能覆盖新任期：${revised}`, async t => {
        const dir = await directory(t);
        const now = Date.now();
        const older = { ...snapshot(now + 500), revision: Number.MAX_SAFE_INTEGER };
        const successor = snapshot(now, 'leader-b:2');
        const newer = revised ? { ...successor, revision: 1 } : successor;
        assert.equal(isBalanceLeaseHandoffNewer(newer, older), true);
        await writeBalanceLeaseHandoff(newer, dir);
        await writeBalanceLeaseHandoff(older, dir);
        assert.deepEqual(await readBalanceLeaseHandoff(dir, now + 500), newer);
    });
}

for (const offset of [-30_001, 1_001]) {
    test(`高序号不能绕过快照时效：${offset}`, async t => {
        const dir = await directory(t);
        const now = Date.now();
        const expired = { ...snapshot(now + offset), revision: 10 };
        await writeBalanceLeaseHandoff(expired, dir);
        assert.equal(await readBalanceLeaseHandoff(dir, now), undefined);
    });
}
