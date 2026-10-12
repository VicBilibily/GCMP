import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import test from 'node:test';
import { fixture, promises, record, seedOwner } from './fixture';

for (const code of ['EPERM', 'EACCES', 'EBUSY']) {
    for (const failures of [1, 3]) {
        test(`snapshot owner reads recover ${failures} transient ${code} failures without replaying the write`, async context => {
            const f = await fixture(context),
                readFile = promises.readFile,
                rename = promises.rename;
            await seedOwner(f);
            let reads = 0,
                writes = 0;
            context.mock.method(promises, 'readFile', (async (...args: Parameters<typeof readFile>) => {
                if (String(args[0]) === f.ownerPath && reads++ < failures) {
                    throw Object.assign(new Error('injected owner read'), { code });
                }
                return readFile(...args);
            }) as typeof readFile);
            context.mock.method(promises, 'rename', async (...args: Parameters<typeof rename>) => {
                if (String(args[1]) === f.path) {
                    writes++;
                }
                return rename(...args);
            });
            await f.snapshot.upsertRecord(f.date, record('added'));
            assert.ok(reads > failures);
            assert.equal(writes, 1);
            assert.deepEqual(await f.ids(), ['added', 'base']);
            await assert.rejects(fs.stat(f.lock), { code: 'ENOENT' });
        });
    }
}

for (const code of ['EPERM', 'EACCES', 'EBUSY']) {
    test(`persistent snapshot owner ${code} expires without stealing a live lock`, async context => {
        const f = await fixture(context),
            readFile = promises.readFile;
        const owner = await seedOwner(f, { pid: process.pid, token: 'unrelated-live-owner' });
        const initial = await fs.readFile(f.path, 'utf8');
        const injected = Object.assign(new Error('persistent owner read'), { code });
        let now = Date.now(),
            reads = 0;
        context.mock.method(Date, 'now', () => now);
        context.mock.method(promises, 'readFile', (async (...args: Parameters<typeof readFile>) => {
            if (String(args[0]) === f.ownerPath) {
                reads++;
                now += 750;
                throw injected;
            }
            return readFile(...args);
        }) as typeof readFile);
        await assert.rejects(f.snapshot.upsertRecord(f.date, record('blocked')), (error: unknown) => {
            assert.ok(error instanceof Error);
            assert.match(error.message, /Timed out waiting/);
            assert.equal((error as Error & { cause?: unknown }).cause, injected);
            return true;
        });
        assert.ok(reads > 1 && reads < 10);
        assert.equal(await readFile(f.ownerPath, 'utf8'), owner);
        assert.equal(await readFile(f.path, 'utf8'), initial);
        await assert.rejects(fs.stat(f.guard), { code: 'ENOENT' });
    });
}

for (const code of ['EIO', 'EINVAL']) {
    test(`snapshot owner ${code} is not retried or treated as a missing owner`, async context => {
        const f = await fixture(context),
            readFile = promises.readFile;
        const owner = await seedOwner(f),
            injected = Object.assign(new Error('nonretryable owner read'), { code });
        let reads = 0;
        context.mock.method(promises, 'readFile', (async (...args: Parameters<typeof readFile>) => {
            if (String(args[0]) === f.ownerPath) {
                reads++;
                throw injected;
            }
            return readFile(...args);
        }) as typeof readFile);
        await assert.rejects(f.snapshot.upsertRecord(f.date, record('blocked')), error => error === injected);
        assert.equal(reads, 1);
        assert.equal(await readFile(f.ownerPath, 'utf8'), owner);
        assert.deepEqual(await f.ids(), ['base']);
    });
}

for (const change of ['released', 'replaced'] as const) {
    test(`snapshot retry rereads ownership after the first failure: ${change}`, async context => {
        const f = await fixture(context),
            readFile = promises.readFile;
        await seedOwner(f);
        const replacement = JSON.stringify({ pid: process.pid, token: 'replacement-owner' });
        let reads = 0,
            now = Date.now();
        context.mock.method(Date, 'now', () => now);
        context.mock.method(promises, 'readFile', (async (...args: Parameters<typeof readFile>) => {
            if (String(args[0]) === f.ownerPath) {
                reads++;
                if (reads === 1) {
                    if (change === 'released') {
                        await fs.rm(f.lock, { recursive: true });
                    } else {
                        await fs.writeFile(f.ownerPath, replacement);
                    }
                    throw Object.assign(new Error('owner changed during failed read'), { code: 'EPERM' });
                }
                if (change === 'replaced') {
                    now += 750;
                }
            }
            return readFile(...args);
        }) as typeof readFile);
        const writing = f.snapshot.upsertRecord(f.date, record('added'));
        if (change === 'released') {
            await writing;
            assert.deepEqual(await f.ids(), ['added', 'base']);
        } else {
            await assert.rejects(writing, /Timed out waiting/);
            assert.equal(await readFile(f.ownerPath, 'utf8'), replacement);
            assert.deepEqual(await f.ids(), ['base']);
        }
        assert.ok(reads > 1);
    });
}
