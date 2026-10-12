import assert from 'node:assert/strict';
import { fork } from 'node:child_process';
import { once } from 'node:events';
import * as fs from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { withReclaimGuard } from '../../reclaimGuard';
import { bounded, fixture, gate, promises, releaseChild, write } from './fixture';

for (const aged of [false, true]) {
    test(
        `a living reclaimer preserves its guard across a second process: aged=${aged}`,
        { timeout: 25000 },
        async context => {
            const f = await fixture(context, true),
                entered = gate(),
                release = gate(),
                rm = promises.rm;
            let paused = false;
            context.mock.method(promises, 'rm', async (...args: Parameters<typeof rm>) => {
                if (!paused && String(args[0]) === f.lock) {
                    paused = true;
                    entered.release();
                    await release.promise;
                }
                return rm(...args);
            });
            const writing = write(f.path, 2).then(
                () => null,
                (error: unknown) => String(error)
            );
            const messages: string[] = [],
                waits = new Map<string, ReturnType<typeof gate>>();
            let childError: string | null | undefined;
            const wait = (kind: string): Promise<void> => {
                if (messages.includes(kind)) {
                    return Promise.resolve();
                }
                const pending = gate();
                waits.set(kind, pending);
                return pending.promise;
            };
            let child: ReturnType<typeof fork> | undefined, exited: Promise<unknown[]> | undefined;
            try {
                await bounded(entered.promise);
                if (aged) {
                    await fs.utimes(f.guard, new Date(0), new Date(0));
                }
                child = fork(
                    fileURLToPath(new URL('./guardWorker.ts', import.meta.url)),
                    [f.path, String(process.pid)],
                    {
                        execArgv: ['--import=tsx'],
                        stdio: ['ignore', 'inherit', 'inherit', 'ipc']
                    }
                );
                child.on('message', (message: { kind: string; error?: string | null }) => {
                    messages.push(message.kind);
                    if (message.kind === 'finished') {
                        childError = message.error;
                    }
                    waits.get(message.kind)?.release();
                });
                exited = once(child, 'exit');
                void exited.catch(() => undefined);
                await bounded(wait('ready'));
                child.send({ kind: 'write' });
                await bounded(Promise.race([wait('retained'), wait('rename-entered')]));
                if (messages.includes('retained')) {
                    assert.deepEqual(JSON.parse(await fs.readFile(join(f.lock, 'owner.json'), 'utf8')), f.dead);
                }
                child.send({ kind: 'revoke' });
                await bounded(wait('revoked'));
                release.release();
                assert.equal(await bounded(writing), null);
                assert.deepEqual(JSON.parse(await fs.readFile(f.path, 'utf8')), { requests: 2 });
                await releaseChild(child);
                await bounded(wait('finished'));
                assert.equal((await bounded(exited))[0], 0);
                assert.deepEqual(JSON.parse(await fs.readFile(f.path, 'utf8')), { requests: 2 });
                assert.equal(messages.includes('rename-entered'), false);
                assert.match(childError ?? '', /write permission expired/i);
                assert.deepEqual(await fs.readdir(f.dir), ['stats.json']);
            } finally {
                release.release();
                await releaseChild(child);
                await writing;
                if (child && child.exitCode === null && child.signalCode === null) {
                    child.kill();
                }
                if (exited) {
                    await exited;
                }
            }
        }
    );
}

test('a delayed dead-guard remover cannot delete a replacement live guard', { timeout: 20000 }, async context => {
    const f = await fixture(context, true),
        firstEntered = gate(),
        firstRelease = gate();
    const secondEntered = gate(),
        secondRelease = gate(),
        rm = promises.rm;
    const owner = `${f.dead.pid}.${f.dead.token}`,
        marker = join(f.guard, owner);
    await fs.mkdir(f.guard);
    await fs.writeFile(marker, '');
    await fs.utimes(f.guard, new Date(0), new Date(0));
    let intercepted = false,
        permitted = true;
    context.mock.method(promises, 'rm', async (...args: Parameters<typeof rm>) => {
        const target = String(args[0]);
        if (!intercepted && [f.guard, marker].includes(target)) {
            intercepted = true;
            firstEntered.release();
            await firstRelease.promise;
        } else if (target === f.lock) {
            secondEntered.release();
            await secondRelease.promise;
        }
        return rm(...args);
    });
    const first = write(f.path, 1, () => permitted).then(
        () => null,
        (error: unknown) => String(error)
    );
    let second: Promise<string | null> | undefined;
    try {
        await bounded(firstEntered.promise);
        second = write(f.path, 2).then(
            () => null,
            (error: unknown) => String(error)
        );
        await bounded(secondEntered.promise);
        const held = await fs.readdir(f.guard);
        permitted = false;
        firstRelease.release();
        assert.match((await bounded(first)) ?? '', /write permission expired/i);
        assert.deepEqual(await fs.readdir(f.guard), held);
    } finally {
        permitted = false;
        firstRelease.release();
        secondRelease.release();
        await first;
        if (second) {
            assert.equal(await second, null);
        }
    }
    assert.deepEqual(JSON.parse(await fs.readFile(f.path, 'utf8')), { requests: 2 });
    assert.deepEqual(await fs.readdir(f.dir), ['stats.json']);
});

test('a delayed ended-guard release preserves a second process replacement', { timeout: 20000 }, async context => {
    const f = await fixture(context, true),
        entered = gate(),
        release = gate(),
        rmdir = promises.rmdir;
    let paused = false;
    context.mock.method(promises, 'rmdir', async (...args: Parameters<typeof rmdir>) => {
        if (!paused && String(args[0]) === f.guard) {
            paused = true;
            entered.release();
            await release.promise;
        }
        return rmdir(...args);
    });
    const first = withReclaimGuard(f.guard, async () => true);
    let child: ReturnType<typeof fork> | undefined, exited: Promise<unknown[]> | undefined;
    const messages: string[] = [],
        waiting = new Map<string, ReturnType<typeof gate>>();
    let childError: string | null | undefined;
    const wait = (kind: string) => {
        if (messages.includes(kind)) {
            return Promise.resolve();
        }
        const pending = gate();
        waiting.set(kind, pending);
        return pending.promise;
    };
    try {
        await bounded(entered.promise);
        assert.deepEqual(await fs.readdir(f.guard), []);
        await fs.utimes(f.guard, new Date(0), new Date(0));
        child = fork(
            fileURLToPath(new URL('./guardWorker.ts', import.meta.url)),
            [f.path, String(process.pid), 'reclaim'],
            {
                execArgv: ['--import=tsx'],
                stdio: ['ignore', 'inherit', 'inherit', 'ipc']
            }
        );
        child.on('message', (message: { kind: string; error?: string | null }) => {
            messages.push(message.kind);
            if (message.kind === 'finished') {
                childError = message.error;
            }
            waiting.get(message.kind)?.release();
        });
        exited = once(child, 'exit');
        void exited.catch(() => undefined);
        await bounded(wait('ready'));
        child.send({ kind: 'write' });
        await bounded(wait('guard-held'));
        const owner = await fs.readdir(f.guard);
        assert.equal(owner.length, 1);
        assert.ok(owner[0].startsWith(`${child.pid}.`));
        release.release();
        assert.equal(await bounded(first), true);
        assert.deepEqual(await fs.readdir(f.guard), owner);
        await releaseChild(child);
        await bounded(wait('finished'));
        assert.equal(childError, null);
        assert.equal((await bounded(exited))[0], 0);
        assert.deepEqual(JSON.parse(await fs.readFile(f.path, 'utf8')), { requests: 1 });
        assert.deepEqual(await fs.readdir(f.dir), ['stats.json']);
    } finally {
        release.release();
        await releaseChild(child);
        await first;
        if (child && child.exitCode === null && child.signalCode === null) {
            child.kill();
        }
        if (exited) {
            await exited;
        }
    }
});
