import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import test from 'node:test';
import { bounded, fixture, gate, promises, record } from './fixture';

for (const phase of ['read', 'remove'] as const) {
    for (const code of ['EPERM', 'EACCES', 'EBUSY']) {
        test(`snapshot release retries ${phase} ${code} without repeating a committed write`, async context => {
            const f = await fixture(context),
                readFile = promises.readFile,
                rm = promises.rm,
                rename = promises.rename;
            let writes = 0,
                failures = 0;
            context.mock.method(promises, 'rename', async (...args: Parameters<typeof rename>) => {
                await rename(...args);
                if (String(args[1]) === f.path) {
                    writes++;
                }
            });
            context.mock.method(promises, 'readFile', (async (...args: Parameters<typeof readFile>) => {
                if (phase === 'read' && writes > 0 && failures < 3 && String(args[0]) === f.ownerPath) {
                    failures++;
                    throw Object.assign(new Error('release read failure'), { code });
                }
                return readFile(...args);
            }) as typeof readFile);
            context.mock.method(promises, 'rm', async (...args: Parameters<typeof rm>) => {
                if (phase === 'remove' && writes > 0 && failures < 3 && String(args[0]) === f.lock) {
                    failures++;
                    throw Object.assign(new Error('release removal failure'), { code });
                }
                return rm(...args);
            });
            await f.snapshot.upsertRecord(f.date, record('added'));
            assert.equal(failures, 3);
            assert.equal(writes, 1);
            assert.deepEqual(await f.ids(), ['added', 'base']);
            await assert.rejects(fs.stat(f.lock), { code: 'ENOENT' });
            await f.snapshot.upsertRecord(f.date, record('later'));
            assert.equal(writes, 2);
            assert.deepEqual(await f.ids(), ['added', 'base', 'later']);
        });
    }
}

test('a partial snapshot release finishes the empty directory instead of leaving a live-PID orphan', async context => {
    const f = await fixture(context),
        rm = promises.rm;
    let injected = false;
    context.mock.method(promises, 'rm', async (...args: Parameters<typeof rm>) => {
        if (!injected && String(args[0]) === f.lock) {
            injected = true;
            await fs.unlink(f.ownerPath);
            throw Object.assign(new Error('partial release'), { code: 'EBUSY' });
        }
        return rm(...args);
    });
    await f.snapshot.upsertRecord(f.date, record('added'));
    assert.equal(injected, true);
    await assert.rejects(fs.stat(f.lock), { code: 'ENOENT' });
    assert.deepEqual(await f.ids(), ['added', 'base']);
});

test(
    'a permanent snapshot release reports a bounded error and later cleanup does not replay the operation',
    { timeout: 10000 },
    async context => {
        const f = await fixture(context),
            rm = promises.rm,
            rename = promises.rename,
            clean = gate();
        const injected = Object.assign(new Error('persistent release failure'), { code: 'EPERM' });
        let failing = true,
            writes = 0,
            now = Date.now();
        context.mock.method(Date, 'now', () => now);
        context.mock.method(promises, 'rename', async (...args: Parameters<typeof rename>) => {
            await rename(...args);
            if (String(args[1]) === f.path) {
                writes++;
            }
        });
        context.mock.method(promises, 'rm', async (...args: Parameters<typeof rm>) => {
            if (String(args[0]) === f.lock && failing) {
                now += 750;
                throw injected;
            }
            await rm(...args);
            if (String(args[0]) === f.lock) {
                clean.release();
            }
        });
        try {
            await assert.rejects(f.snapshot.upsertRecord(f.date, record('added')), (error: unknown) => {
                assert.ok(error instanceof Error);
                assert.match(error.message, /Timed out.*releas/i);
                assert.equal((error as Error & { cause?: unknown }).cause, injected);
                return true;
            });
            assert.equal(writes, 1);
            assert.deepEqual(await f.ids(), ['added', 'base']);
        } finally {
            failing = false;
        }
        await bounded(clean.promise);
        await f.snapshot.upsertRecord(f.date, record('later'));
        assert.equal(writes, 2);
        assert.deepEqual(await f.ids(), ['added', 'base', 'later']);
    }
);

test('a business write EPERM is not retried by snapshot lock acquisition', async context => {
    const f = await fixture(context);
    const internal = f.snapshot as unknown as {
        writeSnapshotStoreLocked: (date: string, store: unknown) => Promise<void>;
    };
    const injected = Object.assign(new Error('business failure'), { code: 'EPERM' });
    let calls = 0;
    context.mock.method(internal, 'writeSnapshotStoreLocked', async () => {
        calls++;
        throw injected;
    });
    await assert.rejects(f.snapshot.upsertRecord(f.date, record('blocked')), error => error === injected);
    assert.equal(calls, 1);
    assert.deepEqual(await f.ids(), ['base']);
    await assert.rejects(fs.stat(f.lock), { code: 'ENOENT' });
});
