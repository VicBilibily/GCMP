import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import * as fs from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';
import { removeAbandonedReclaimGuard, withReclaimGuard } from '../../reclaimGuard';
import { bounded, fixture, gate, promises, write } from './fixture';

for (const owner of ['live', 'unknown'] as const) {
    for (const aged of [false, true]) {
        test(`a ${owner} reclaim owner is retained when permission expires: aged=${aged}`, async context => {
            const f = await fixture(context),
                marker = owner === 'live' ? `${process.pid}.${randomUUID()}` : 'unrecognized';
            await fs.mkdir(f.guard);
            await fs.writeFile(join(f.guard, marker), '');
            if (aged) {
                await fs.utimes(f.guard, new Date(0), new Date(0));
            }
            let permitted = true;
            const stat = promises.stat,
                readdir = promises.readdir;
            context.mock.method(promises, 'stat', (async (...args: Parameters<typeof stat>) => {
                const value = await stat(...args);
                if (String(args[0]) === f.guard) {
                    permitted = false;
                }
                return value;
            }) as typeof stat);
            context.mock.method(promises, 'readdir', (async (...args: Parameters<typeof readdir>) => {
                const value = await readdir(...args);
                if (String(args[0]) === f.guard) {
                    permitted = false;
                }
                return value;
            }) as typeof readdir);
            await assert.rejects(
                write(f.path, 1, () => permitted),
                /write permission expired/i
            );
            assert.deepEqual(await fs.readdir(f.guard), [marker]);
            assert.deepEqual(JSON.parse(await fs.readFile(f.path, 'utf8')), { requests: 0 });
        });
    }
}

for (const aged of [false, true]) {
    test(`a dead reclaim owner is recoverable without waiting for its age: aged=${aged}`, async context => {
        const f = await fixture(context),
            stat = promises.stat;
        await fs.mkdir(f.guard);
        await fs.writeFile(join(f.guard, `${f.dead.pid}.${f.dead.token}`), '');
        if (aged) {
            await fs.utimes(f.guard, new Date(0), new Date(0));
        }
        let now = Date.now();
        context.mock.method(Date, 'now', () => now);
        context.mock.method(promises, 'stat', (async (...args: Parameters<typeof stat>) => {
            const value = await stat(...args);
            if (String(args[0]) === f.guard) {
                now += 11000;
            }
            return value;
        }) as typeof stat);
        await write(f.path, 2);
        assert.deepEqual(JSON.parse(await fs.readFile(f.path, 'utf8')), { requests: 2 });
        assert.deepEqual(await fs.readdir(f.dir), ['stats.json']);
    });
}

test(
    'a reclaimer publishes its process and unique owner before deleting the main lock',
    { timeout: 10000 },
    async context => {
        const f = await fixture(context, true),
            entered = gate(),
            release = gate(),
            rm = promises.rm;
        context.mock.method(promises, 'rm', async (...args: Parameters<typeof rm>) => {
            if (String(args[0]) === f.lock) {
                entered.release();
                await release.promise;
            }
            return rm(...args);
        });
        const writing = write(f.path, 2);
        try {
            await bounded(entered.promise);
            const owners = await fs.readdir(f.guard);
            assert.equal(owners.length, 1);
            assert.match(owners[0], new RegExp(`^${process.pid}\\.[0-9a-f-]{36}$`));
            assert.deepEqual(JSON.parse(await fs.readFile(join(f.lock, 'owner.json'), 'utf8')), f.dead);
        } finally {
            release.release();
            await writing;
        }
        assert.deepEqual(await fs.readdir(f.dir), ['stats.json']);
    }
);

test('a fully prepared guard cannot replace another live guard', async context => {
    const f = await fixture(context),
        entered = gate(),
        release = gate();
    const first = withReclaimGuard(f.guard, async () => {
        entered.release();
        await release.promise;
        return true;
    });
    try {
        await bounded(entered.promise);
        const owner = await fs.readdir(f.guard);
        let enteredSecond = false;
        assert.equal(
            await withReclaimGuard(f.guard, async () => {
                enteredSecond = true;
                return true;
            }),
            false
        );
        assert.equal(enteredSecond, false);
        assert.deepEqual(await fs.readdir(f.guard), owner);
    } finally {
        release.release();
        assert.equal(await first, true);
    }
    assert.deepEqual(await fs.readdir(f.dir), ['stats.json']);
});

test('a paused guard initializer cannot overwrite a fully published successor', async context => {
    const f = await fixture(context),
        entered = gate(),
        release = gate(),
        held = gate(),
        finish = gate();
    const writeFile = promises.writeFile;
    let paused = false,
        firstEntered = false;
    context.mock.method(promises, 'writeFile', (async (...args: Parameters<typeof writeFile>) => {
        if (!paused && String(args[0]).startsWith(`${f.guard}.`)) {
            paused = true;
            entered.release();
            await release.promise;
        }
        return writeFile(...args);
    }) as typeof writeFile);
    const first = withReclaimGuard(f.guard, async () => {
        firstEntered = true;
        return true;
    });
    let second: Promise<boolean> | undefined;
    try {
        await bounded(entered.promise);
        await assert.rejects(fs.stat(f.guard), { code: 'ENOENT' });
        second = withReclaimGuard(f.guard, async () => {
            held.release();
            await finish.promise;
            return true;
        });
        await bounded(held.promise);
        const owner = await fs.readdir(f.guard);
        release.release();
        assert.equal(await bounded(first), false);
        assert.equal(firstEntered, false);
        assert.deepEqual(await fs.readdir(f.guard), owner);
    } finally {
        release.release();
        finish.release();
        await first;
        if (second) {
            assert.equal(await second, true);
        }
    }
    assert.deepEqual(await fs.readdir(f.dir), ['stats.json']);
});

test('an expired empty-guard observation cannot remove a newly published owner', async context => {
    const f = await fixture(context),
        entered = gate(),
        release = gate(),
        held = gate(),
        finish = gate();
    await fs.mkdir(f.guard);
    await fs.utimes(f.guard, new Date(0), new Date(0));
    const rmdir = promises.rmdir;
    let paused = false;
    context.mock.method(promises, 'rmdir', async (...args: Parameters<typeof rmdir>) => {
        if (!paused && String(args[0]) === f.guard) {
            paused = true;
            entered.release();
            await release.promise;
        }
        return rmdir(...args);
    });
    const first = removeAbandonedReclaimGuard(f.guard);
    let second: Promise<boolean> | undefined;
    try {
        await bounded(entered.promise);
        assert.equal(await removeAbandonedReclaimGuard(f.guard), true);
        second = withReclaimGuard(f.guard, async () => {
            held.release();
            await finish.promise;
            return true;
        });
        await bounded(held.promise);
        const owner = await fs.readdir(f.guard);
        release.release();
        assert.equal(await bounded(first), false);
        assert.deepEqual(await fs.readdir(f.guard), owner);
    } finally {
        release.release();
        finish.release();
        await first;
        if (second) {
            assert.equal(await second, true);
        }
    }
    assert.deepEqual(await fs.readdir(f.dir), ['stats.json']);
});
