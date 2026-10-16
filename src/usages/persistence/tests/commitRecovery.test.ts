import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import { AtomicJsonFile } from '../../atomicJsonFile';
import { finishPendingRelease } from '../lockRelease';

const promises = createRequire(import.meta.url)('node:fs/promises') as typeof fs;
const write = (path: string, requests: number) =>
    AtomicJsonFile.writeJsonAtomically(path, { requests }, undefined, () => true);
function gate() {
    let release!: () => void;
    const promise = new Promise<void>(resolve => {
        release = resolve;
    });
    return { promise, release };
}
async function bounded(promise: Promise<void>): Promise<void> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
        await Promise.race([
            promise,
            new Promise<never>((_, reject) => {
                timer = setTimeout(() => reject(new Error('finished commit lock was not released')), 5000);
            })
        ]);
    } finally {
        clearTimeout(timer);
    }
}
async function fixture(context: TestContext) {
    const dir = await fs.mkdtemp(join(tmpdir(), 'gcmp-release-recovery-'));
    context.after(() => fs.rm(dir, { recursive: true, force: true }));
    return { dir, path: join(dir, 'stats.json'), lock: join(dir, 'stats.json.commit.lock') };
}

for (const failure of ['EBUSY', 'EPERM', 'EACCES', 'owner-read'] as const) {
    test(`finished commit cleanup recovers without another write: ${failure}`, { timeout: 10000 }, async context => {
        const f = await fixture(context),
            cleaned = gate();
        const rm = promises.rm,
            readFile = promises.readFile,
            rename = promises.rename;
        let committed = false,
            injected = false;
        context.mock.method(promises, 'rename', async (...args: Parameters<typeof rename>) => {
            await rename(...args);
            if (String(args[1]) === f.path) {
                committed = true;
            }
        });
        context.mock.method(promises, 'readFile', (async (...args: Parameters<typeof readFile>) => {
            if (failure === 'owner-read' && committed && !injected && String(args[0]) === join(f.lock, 'owner.json')) {
                injected = true;
                throw Object.assign(new Error('injected cleanup read failure'), { code: 'EIO' });
            }
            return readFile(...args);
        }) as typeof readFile);
        context.mock.method(promises, 'rm', async (...args: Parameters<typeof rm>) => {
            const target = String(args[0]) === f.lock;
            if (failure !== 'owner-read' && target && !injected) {
                injected = true;
                throw Object.assign(new Error('injected cleanup failure'), { code: failure });
            }
            await rm(...args);
            if (target) {
                cleaned.release();
            }
        });
        await assert.rejects(write(f.path, 1), /injected cleanup/);
        assert.equal(committed, true);
        assert.equal(injected, true);
        await bounded(cleaned.promise);
        assert.deepEqual(await fs.readdir(f.dir), ['stats.json']);
        await write(f.path, 2);
        assert.deepEqual(JSON.parse(await fs.readFile(f.path, 'utf8')), { requests: 2 });
    });
}

test('repeated cleanup failures retain the ended owner until recovery succeeds', { timeout: 10000 }, async context => {
    const f = await fixture(context),
        cleaned = gate(),
        rm = promises.rm;
    let failures = 0;
    context.mock.method(promises, 'rm', async (...args: Parameters<typeof rm>) => {
        if (String(args[0]) === f.lock && failures < 3) {
            failures++;
            const owner = JSON.parse(await fs.readFile(join(f.lock, 'owner.json'), 'utf8')) as { pid: number };
            assert.equal(owner.pid, process.pid);
            throw Object.assign(new Error('injected recurring cleanup failure'), { code: 'EBUSY' });
        }
        await rm(...args);
        if (String(args[0]) === f.lock) {
            cleaned.release();
        }
    });
    await assert.rejects(write(f.path, 1), /injected recurring/);
    await bounded(cleaned.promise);
    assert.equal(failures, 3);
    await write(f.path, 2);
    assert.deepEqual(JSON.parse(await fs.readFile(f.path, 'utf8')), { requests: 2 });
    assert.deepEqual(await fs.readdir(f.dir), ['stats.json']);
});

for (const phase of ['partial', 'empty'] as const) {
    for (const code of ['ENOSPC', 'EIO'] as const) {
        test(`owner initialization cleans its ${phase} file after ${code}`, async context => {
            const fixtureState = await fixture(context);
            const ownerPath = join(fixtureState.lock, 'owner.json');
            const writeFile = promises.writeFile;
            const failure = Object.assign(new Error('injected incomplete owner write'), { code });
            const openFile = promises.open.bind(promises);
            const openHandles = new Set<fs.FileHandle>();
            context.mock.method(promises, 'open', async (...args: Parameters<typeof openFile>) => {
                const handle = await openFile(...args);
                if (String(args[0]) === ownerPath) {
                    openHandles.add(handle);
                    const close = handle.close.bind(handle);
                    context.mock.method(handle, 'close', async () => {
                        await close();
                        openHandles.delete(handle);
                    });
                }
                return handle;
            });
            let injected = false;
            context.mock.method(promises, 'writeFile', async (...args: Parameters<typeof writeFile>) => {
                if (!injected && String(args[0]) === ownerPath) {
                    injected = true;
                    await writeFile(args[0], phase === 'partial' ? '{"pid":' : '', args[2]);
                    throw failure;
                }
                return writeFile(...args);
            });
            try {
                await assert.rejects(
                    write(fixtureState.path, 1),
                    error => error === failure || (error instanceof AggregateError && error.errors.includes(failure))
                );
                assert.equal(injected, true);
                assert.equal(openHandles.size, 0);
                await assert.rejects(fs.stat(fixtureState.lock), { code: 'ENOENT' });
                await write(fixtureState.path, 2);
                assert.equal(openHandles.size, 0);
                assert.deepEqual(JSON.parse(await fs.readFile(fixtureState.path, 'utf8')), { requests: 2 });
                assert.deepEqual(await fs.readdir(fixtureState.dir), ['stats.json']);
            } finally {
                await Promise.all([...openHandles].map(handle => handle.close()));
                await fs.rm(fixtureState.lock, { recursive: true, force: true });
                await finishPendingRelease(fixtureState.lock);
            }
        });
    }
}

test('owner initialization cleanup retries a transient partial-file removal failure', async context => {
    const fixtureState = await fixture(context);
    const ownerPath = join(fixtureState.lock, 'owner.json');
    const writeFile = promises.writeFile;
    const remove = promises.rm;
    const rmdir = promises.rmdir;
    const cleaned = gate();
    const writeFailure = Object.assign(new Error('injected partial owner write'), { code: 'ENOSPC' });
    const cleanupFailure = Object.assign(new Error('injected partial owner cleanup'), { code: 'EBUSY' });
    let injected = false;
    let removals = 0;
    context.mock.method(promises, 'writeFile', async (...args: Parameters<typeof writeFile>) => {
        if (!injected && String(args[0]) === ownerPath) {
            injected = true;
            await writeFile(args[0], '{"pid":', args[2]);
            throw writeFailure;
        }
        return writeFile(...args);
    });
    context.mock.method(promises, 'rm', async (...args: Parameters<typeof remove>) => {
        if (String(args[0]) === ownerPath && ++removals === 1) {
            throw cleanupFailure;
        }
        return remove(...args);
    });
    context.mock.method(promises, 'rmdir', async (...args: Parameters<typeof rmdir>) => {
        await rmdir(...args);
        if (String(args[0]) === fixtureState.lock) {
            cleaned.release();
        }
    });
    try {
        await assert.rejects(write(fixtureState.path, 1), error => {
            assert.ok(error instanceof AggregateError);
            assert.deepEqual(error.errors, [writeFailure, cleanupFailure]);
            return true;
        });
        await bounded(cleaned.promise);
        await finishPendingRelease(fixtureState.lock);
        assert.equal(removals, 2);
        await write(fixtureState.path, 2);
        assert.deepEqual(await fs.readdir(fixtureState.dir), ['stats.json']);
    } finally {
        await remove(fixtureState.lock, { recursive: true, force: true });
        await finishPendingRelease(fixtureState.lock);
    }
});

test('owner initialization cleanup preserves a replacement incomplete owner file', async context => {
    const fixtureState = await fixture(context);
    const ownerPath = join(fixtureState.lock, 'owner.json');
    const writeFile = promises.writeFile;
    const failure = Object.assign(new Error('injected owner replacement'), { code: 'EIO' });
    let injected = false;
    context.mock.method(promises, 'writeFile', async (...args: Parameters<typeof writeFile>) => {
        if (!injected && String(args[0]) === ownerPath) {
            injected = true;
            await writeFile(args[0], '{"pid":', args[2]);
            await fs.rename(ownerPath, join(fixtureState.dir, 'original-owner'));
            await writeFile(ownerPath, '{"replacement":', { flag: 'wx' });
            throw failure;
        }
        return writeFile(...args);
    });
    try {
        await assert.rejects(write(fixtureState.path, 1));
        assert.equal(injected, true);
        assert.equal(await fs.readFile(ownerPath, 'utf8'), '{"replacement":');
        assert.equal(await fs.readFile(join(fixtureState.dir, 'original-owner'), 'utf8'), '{"pid":');
    } finally {
        await fs.rm(fixtureState.lock, { recursive: true, force: true });
        await finishPendingRelease(fixtureState.lock);
    }
});

for (const phase of ['partial-removal', 'owner-initialization'] as const) {
    test(`ended ownership recovers after partial filesystem effects: ${phase}`, { timeout: 10000 }, async context => {
        const f = await fixture(context),
            cleaned = gate();
        const rm = promises.rm,
            rmdir = promises.rmdir,
            writeFile = promises.writeFile;
        let injected = false;
        context.mock.method(promises, 'writeFile', (async (...args: Parameters<typeof writeFile>) => {
            await writeFile(...args);
            if (phase === 'owner-initialization' && !injected && String(args[0]) === join(f.lock, 'owner.json')) {
                injected = true;
                throw Object.assign(new Error('injected initialization failure'), { code: 'EIO' });
            }
        }) as typeof writeFile);
        context.mock.method(promises, 'rm', async (...args: Parameters<typeof rm>) => {
            if (phase === 'partial-removal' && !injected && String(args[0]) === f.lock) {
                injected = true;
                await fs.unlink(join(f.lock, 'owner.json'));
                throw Object.assign(new Error('injected partial cleanup failure'), { code: 'EBUSY' });
            }
            await rm(...args);
            if (String(args[0]) === f.lock) {
                cleaned.release();
            }
        });
        context.mock.method(promises, 'rmdir', async (...args: Parameters<typeof rmdir>) => {
            await rmdir(...args);
            if (String(args[0]) === f.lock) {
                cleaned.release();
            }
        });
        await assert.rejects(write(f.path, 1), /injected/);
        assert.equal(injected, true);
        await bounded(cleaned.promise);
        await write(f.path, 2);
        assert.deepEqual(JSON.parse(await fs.readFile(f.path, 'utf8')), { requests: 2 });
        assert.deepEqual(await fs.readdir(f.dir), ['stats.json']);
    });
}

test(
    'concurrent next writers share the pending release instead of removing a new active lock',
    { timeout: 15000 },
    async context => {
        const f = await fixture(context),
            entered = gate(),
            release = gate(),
            rm = promises.rm;
        let attempts = 0,
            released = false;
        context.mock.method(promises, 'rm', async (...args: Parameters<typeof rm>) => {
            if (String(args[0]) === f.lock && !released) {
                attempts++;
                if (attempts === 1) {
                    throw Object.assign(new Error('injected cleanup failure'), { code: 'EBUSY' });
                }
                entered.release();
                await release.promise;
            }
            return rm(...args);
        });
        await assert.rejects(write(f.path, 1), /injected cleanup/);
        const next = [write(f.path, 2), write(f.path, 3)];
        const settled = Promise.allSettled(next);
        try {
            await bounded(entered.promise);
            assert.equal(attempts, 2);
        } finally {
            released = true;
            release.release();
            await settled;
        }
        const results = await settled;
        assert.ok(results.every(result => result.status === 'fulfilled'));
        assert.ok([2, 3].includes((JSON.parse(await fs.readFile(f.path, 'utf8')) as { requests: number }).requests));
        assert.deepEqual(await fs.readdir(f.dir), ['stats.json']);
    }
);
