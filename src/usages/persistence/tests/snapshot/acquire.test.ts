import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import test from 'node:test';
import { finishPendingRelease } from '../../lockRelease';
import { fixture, promises, record } from './fixture';

for (const phase of ['mkdir', 'initialize-before', 'initialize-after', 'confirm'] as const) {
    for (const code of ['EPERM', 'EACCES', 'EBUSY']) {
        test(`snapshot acquisition retries ${phase} ${code} before exactly one business write`, async context => {
            const f = await fixture(context);
            const mkdir = promises.mkdir,
                writeFile = promises.writeFile,
                readFile = promises.readFile,
                rename = promises.rename;
            let failures = 0,
                writes = 0,
                initialized = 0;
            const fail = () => {
                failures++;
                throw Object.assign(new Error('acquisition failure'), { code });
            };
            context.mock.method(promises, 'mkdir', (async (...args: Parameters<typeof mkdir>) => {
                if (phase === 'mkdir' && String(args[0]) === f.lock && failures < 3) {
                    fail();
                }
                return mkdir(...args);
            }) as typeof mkdir);
            context.mock.method(promises, 'writeFile', async (...args: Parameters<typeof writeFile>) => {
                const owner = String(args[0]) === f.ownerPath;
                if (owner && phase === 'initialize-before' && failures < 3) {
                    fail();
                }
                await writeFile(...args);
                if (owner) {
                    initialized++;
                }
                if (owner && phase === 'initialize-after' && failures < 3) {
                    fail();
                }
            });
            context.mock.method(promises, 'readFile', (async (...args: Parameters<typeof readFile>) => {
                if (phase === 'confirm' && writes === 0 && String(args[0]) === f.ownerPath && failures < 3) {
                    fail();
                }
                return readFile(...args);
            }) as typeof readFile);
            context.mock.method(promises, 'rename', async (...args: Parameters<typeof rename>) => {
                await rename(...args);
                if (String(args[1]) === f.path) {
                    writes++;
                }
            });
            await f.snapshot.upsertRecord(f.date, record('added'));
            assert.equal(failures, 3);
            assert.equal(initialized, phase === 'initialize-after' ? 4 : 1);
            assert.equal(writes, 1);
            assert.deepEqual(await f.ids(), ['added', 'base']);
            await assert.rejects(fs.stat(f.lock), { code: 'ENOENT' });
        });
    }
}

test('persistent ownership confirmation failure cannot enter the snapshot business operation', async context => {
    const f = await fixture(context),
        readFile = promises.readFile,
        rename = promises.rename;
    const injected = Object.assign(new Error('persistent confirmation failure'), { code: 'EPERM' });
    let failing = true,
        now = Date.now(),
        writes = 0,
        reads = 0;
    context.mock.method(Date, 'now', () => now);
    context.mock.method(promises, 'readFile', (async (...args: Parameters<typeof readFile>) => {
        if (failing && String(args[0]) === f.ownerPath) {
            reads++;
            now += 750;
            throw injected;
        }
        return readFile(...args);
    }) as typeof readFile);
    context.mock.method(promises, 'rename', async (...args: Parameters<typeof rename>) => {
        await rename(...args);
        if (String(args[1]) === f.path) {
            writes++;
        }
    });
    try {
        await assert.rejects(f.snapshot.upsertRecord(f.date, record('blocked')), (error: unknown) => {
            assert.ok(error instanceof Error);
            assert.match(error.message, /Timed out/);
            assert.equal((error as Error & { cause?: unknown }).cause, injected);
            return true;
        });
        assert.equal(writes, 0);
        assert.ok(reads > 1 && reads < 10);
        assert.deepEqual(await f.ids(), ['base']);
    } finally {
        failing = false;
        await finishPendingRelease(f.lock);
    }
    await assert.rejects(fs.stat(f.lock), { code: 'ENOENT' });
});

for (const phase of ['read', 'remove'] as const) {
    test(`retrying snapshot release ${phase} does not delete a replacement owner`, async context => {
        const f = await fixture(context),
            readFile = promises.readFile,
            rm = promises.rm,
            rename = promises.rename;
        const replacement = JSON.stringify({ pid: process.pid, token: 'replacement-owner' });
        let written = false,
            failed = false;
        const replace = async () => {
            failed = true;
            await fs.writeFile(f.ownerPath, replacement);
            throw Object.assign(new Error('release ownership changed'), { code: 'EPERM' });
        };
        context.mock.method(promises, 'rename', async (...args: Parameters<typeof rename>) => {
            await rename(...args);
            if (String(args[1]) === f.path) {
                written = true;
            }
        });
        context.mock.method(promises, 'readFile', (async (...args: Parameters<typeof readFile>) => {
            if (phase === 'read' && written && !failed && String(args[0]) === f.ownerPath) {
                await replace();
            }
            return readFile(...args);
        }) as typeof readFile);
        context.mock.method(promises, 'rm', async (...args: Parameters<typeof rm>) => {
            if (phase === 'remove' && written && !failed && String(args[0]) === f.lock) {
                await replace();
            }
            return rm(...args);
        });
        await f.snapshot.upsertRecord(f.date, record('added'));
        assert.equal(failed, true);
        assert.equal(await fs.readFile(f.ownerPath, 'utf8'), replacement);
        assert.deepEqual(await f.ids(), ['added', 'base']);
    });
}
