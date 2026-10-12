import assert from 'node:assert/strict';
import { fork } from 'node:child_process';
import { once } from 'node:events';
import * as fs from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { AtomicJsonFile } from '../../atomicJsonFile';

const promises = createRequire(import.meta.url)('node:fs/promises') as typeof fs;
function gate() {
    let release!: () => void;
    const promise = new Promise<void>(resolve => {
        release = resolve;
    });
    return { promise, release };
}
async function bounded<T>(promise: Promise<T>): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
        return await Promise.race([
            promise,
            new Promise<never>((_, reject) => {
                timer = setTimeout(() => reject(new Error('commit boundary not reached')), 5000);
            })
        ]);
    } finally {
        clearTimeout(timer);
    }
}

for (const aged of [false, true]) {
    test(
        `a recovered initializer retains its commit against reclamation: aged=${aged}`,
        { timeout: 20000 },
        async context => {
            const dir = await fs.mkdtemp(join(tmpdir(), 'gcmp-initializer-race-'));
            context.after(() => fs.rm(dir, { recursive: true, force: true }));
            const path = join(dir, 'stats.json'),
                lock = `${path}.commit.lock`;
            await fs.writeFile(path, '{"requests":0}');
            const ownerEntered = gate(),
                ownerRelease = gate(),
                renameEntered = gate(),
                renameRelease = gate();
            const writeFile = promises.writeFile,
                rename = promises.rename;
            let permitted = true,
                initialized = false;
            context.mock.method(promises, 'writeFile', (async (...args: Parameters<typeof writeFile>) => {
                if (!initialized && String(args[0]) === join(lock, 'owner.json')) {
                    initialized = true;
                    ownerEntered.release();
                    await ownerRelease.promise;
                }
                return writeFile(...args);
            }) as typeof writeFile);
            context.mock.method(promises, 'rename', async (...args: Parameters<typeof rename>) => {
                if (String(args[1]) === path) {
                    renameEntered.release();
                    await renameRelease.promise;
                }
                return rename(...args);
            });
            const writing = AtomicJsonFile.writeJsonAtomically(path, { requests: 1 }, undefined, () => permitted).then(
                () => null,
                (error: unknown) => String(error)
            );
            let child: ReturnType<typeof fork> | undefined, exited: Promise<unknown[]> | undefined;
            const messages: string[] = [];
            const waiting = new Map<string, ReturnType<typeof gate>>();
            const wait = (kind: string) => {
                if (messages.includes(kind)) {
                    return Promise.resolve();
                }
                const pending = gate();
                waiting.set(kind, pending);
                return pending.promise;
            };
            try {
                await bounded(ownerEntered.promise);
                if (aged) {
                    await fs.utimes(lock, new Date(0), new Date(0));
                }
                child = fork(
                    fileURLToPath(new URL('./reclaimWorker.ts', import.meta.url)),
                    [path, aged ? 'reclaim' : 'normal'],
                    {
                        execArgv: ['--import=tsx'],
                        stdio: ['ignore', 'inherit', 'inherit', 'ipc']
                    }
                );
                child.on('message', (message: { kind: string }) => {
                    messages.push(message.kind);
                    waiting.get(message.kind)?.release();
                });
                exited = once(child, 'exit');
                await bounded(wait('ready'));
                child.send({ kind: 'write' });
                if (aged) {
                    await bounded(wait('reclaiming'));
                }
                ownerRelease.release();
                await bounded(renameEntered.promise);
                const owner = JSON.parse(await fs.readFile(join(lock, 'owner.json'), 'utf8')) as { pid: number };
                assert.equal(owner.pid, process.pid);
                if (aged) {
                    permitted = false;
                    child.send({ kind: 'release' });
                    await bounded(Promise.race([wait('removed'), wait('retained')]));
                    if (messages.includes('removed')) {
                        await bounded(wait('done'));
                        assert.equal((JSON.parse(await fs.readFile(path, 'utf8')) as { requests: number }).requests, 2);
                    } else {
                        assert.equal(messages.includes('done'), false);
                        assert.equal(
                            (JSON.parse(await fs.readFile(join(lock, 'owner.json'), 'utf8')) as { pid: number }).pid,
                            process.pid
                        );
                        assert.equal((JSON.parse(await fs.readFile(path, 'utf8')) as { requests: number }).requests, 0);
                    }
                }
                renameRelease.release();
                assert.equal(await writing, null);
                await bounded(wait('done'));
                assert.equal((await bounded(exited))[0], 0);
                assert.deepEqual(JSON.parse(await fs.readFile(path, 'utf8')), { requests: 2 });
                if (aged) {
                    assert.ok(messages.includes('retained'));
                }
                assert.deepEqual(await fs.readdir(dir), ['stats.json']);
            } finally {
                ownerRelease.release();
                renameRelease.release();
                if (child?.connected) {
                    child.send({ kind: 'release' });
                }
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
