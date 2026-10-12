import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';
import { fixture, promises, record } from './fixture';

for (const owner of ['live', 'unknown'] as const) {
    test(`an aged ${owner} snapshot reclaim guard is not recursively stolen`, async context => {
        const f = await fixture(context);
        await fs.mkdir(f.guard);
        const marker = join(f.guard, owner === 'live' ? `${process.pid}.${f.dead.token}` : 'unknown-owner');
        await fs.writeFile(marker, '');
        await fs.utimes(f.guard, new Date(0), new Date(0));
        let now = Date.now();
        context.mock.method(Date, 'now', () => {
            now += 500;
            return now;
        });
        await assert.rejects(f.snapshot.upsertRecord(f.date, record('blocked')), /Timed out waiting/);
        assert.equal(await fs.readFile(marker, 'utf8'), '');
        assert.deepEqual(await f.ids(), ['base']);
    });
}

test('a fresh dead-PID snapshot reclaim guard is recovered without aging', async context => {
    const f = await fixture(context),
        stat = promises.stat;
    await fs.mkdir(f.guard);
    await fs.writeFile(join(f.guard, `${f.dead.pid}.${f.dead.token}`), '');
    let ageReads = 0;
    context.mock.method(promises, 'stat', (async (...args: Parameters<typeof stat>) => {
        if (String(args[0]) === f.guard) {
            ageReads++;
        }
        return stat(...args);
    }) as typeof stat);
    await f.snapshot.upsertRecord(f.date, record('added'));
    assert.equal(ageReads, 0);
    assert.deepEqual(await f.ids(), ['added', 'base']);
    await assert.rejects(fs.stat(f.guard), { code: 'ENOENT' });
});

test('a snapshot owner initialized after an orphan observation is not recursively removed', async context => {
    const f = await fixture(context),
        stat = promises.stat;
    await fs.mkdir(f.lock);
    await fs.utimes(f.lock, new Date(0), new Date(0));
    const owner = JSON.stringify({ pid: process.pid, token: 'initialization-resumed' });
    let observed = false,
        now = Date.now();
    context.mock.method(Date, 'now', () => now);
    context.mock.method(promises, 'stat', (async (...args: Parameters<typeof stat>) => {
        const value = await stat(...args);
        if (String(args[0]) === f.lock && !observed) {
            observed = true;
            await fs.writeFile(f.ownerPath, owner);
            now += 3000;
        }
        return value;
    }) as typeof stat);
    await assert.rejects(f.snapshot.upsertRecord(f.date, record('blocked')), /Timed out waiting/);
    assert.equal(observed, true);
    assert.equal(await fs.readFile(f.ownerPath, 'utf8'), owner);
    assert.deepEqual(await f.ids(), ['base']);
});
