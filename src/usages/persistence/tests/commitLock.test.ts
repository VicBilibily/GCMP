import assert from 'node:assert/strict';
import { fork, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import * as fs from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { AtomicJsonFile } from '../../atomicJsonFile';

const write = AtomicJsonFile.writeJsonAtomically as (
    path: string,
    value: unknown,
    serializer: undefined,
    canWrite: () => boolean
) => Promise<void>;
const promises = createRequire(import.meta.url)('node:fs/promises') as typeof fs;

test('a live commit owner is not stolen and waiting permission can expire', { timeout: 3000 }, async context => {
    const dir = await fs.mkdtemp(join(tmpdir(), 'gcmp-commit-live-'));
    context.after(() => fs.rm(dir, { recursive: true, force: true }));
    const path = join(dir, 'stats.json'),
        lock = `${path}.commit.lock`;
    await fs.writeFile(path, '{"requests":2}');
    await fs.mkdir(lock);
    const owner = JSON.stringify({ pid: process.pid, token: 'other-live-owner' });
    await fs.writeFile(join(lock, 'owner.json'), owner);
    await fs.utimes(lock, new Date(0), new Date(0));
    let permitted = true;
    const timer = setTimeout(() => {
        permitted = false;
    }, 40);
    try {
        await assert.rejects(
            write.call(AtomicJsonFile, path, { requests: 1 }, undefined, () => permitted),
            /write permission expired/i
        );
        assert.equal(await fs.readFile(path, 'utf8'), '{"requests":2}');
        assert.equal(await fs.readFile(join(lock, 'owner.json'), 'utf8'), owner);
    } finally {
        clearTimeout(timer);
    }
});

test('a dead commit owner is reclaimed without leaking lock or temporary files', async context => {
    const dir = await fs.mkdtemp(join(tmpdir(), 'gcmp-commit-dead-'));
    context.after(() => fs.rm(dir, { recursive: true, force: true }));
    const child = spawnSync(process.execPath, ['-e', ''], { stdio: 'ignore' });
    assert.equal(child.status, 0);
    assert.throws(() => process.kill(child.pid, 0), { code: 'ESRCH' });
    const path = join(dir, 'stats.json'),
        lock = `${path}.commit.lock`;
    await fs.mkdir(lock);
    await fs.writeFile(join(lock, 'owner.json'), JSON.stringify({ pid: child.pid, token: 'exited' }));
    await write.call(AtomicJsonFile, path, { requests: 2 }, undefined, () => true);
    assert.deepEqual(JSON.parse(await fs.readFile(path, 'utf8')), { requests: 2 });
    assert.deepEqual(await fs.readdir(dir), ['stats.json']);
});

for (const suffix of ['.commit.lock', '.commit.lock.reclaim']) {
    test(`abandoned ownerless metadata is recovered: ${suffix}`, async context => {
        const dir = await fs.mkdtemp(join(tmpdir(), 'gcmp-commit-orphan-'));
        context.after(() => fs.rm(dir, { recursive: true, force: true }));
        const path = join(dir, 'stats.json'),
            abandoned = `${path}${suffix}`;
        await fs.mkdir(abandoned);
        await fs.utimes(abandoned, new Date(0), new Date(0));
        await write.call(AtomicJsonFile, path, { requests: 2 }, undefined, () => true);
        assert.deepEqual(JSON.parse(await fs.readFile(path, 'utf8')), { requests: 2 });
        assert.deepEqual(await fs.readdir(dir), ['stats.json']);
    });
}

test('commit wait timeout preserves the live owner and destination', async context => {
    const dir = await fs.mkdtemp(join(tmpdir(), 'gcmp-commit-timeout-'));
    context.after(() => fs.rm(dir, { recursive: true, force: true }));
    const path = join(dir, 'stats.json'),
        lock = `${path}.commit.lock`;
    await fs.writeFile(path, '{"requests":2}');
    await fs.mkdir(lock);
    const owner = JSON.stringify({ pid: process.pid, token: 'live-owner' });
    await fs.writeFile(join(lock, 'owner.json'), owner);
    let now = Date.now();
    context.mock.method(Date, 'now', () => now);
    const mkdir = promises.mkdir;
    context.mock.method(promises, 'mkdir', (async (...args: Parameters<typeof mkdir>) => {
        if (String(args[0]) === lock) {
            now += 11000;
        }
        return mkdir(...args);
    }) as typeof mkdir);
    await assert.rejects(
        write.call(AtomicJsonFile, path, { requests: 1 }, undefined, () => true),
        /Timed out waiting/
    );
    assert.equal(await fs.readFile(path, 'utf8'), '{"requests":2}');
    assert.equal(await fs.readFile(join(lock, 'owner.json'), 'utf8'), owner);
    assert.deepEqual((await fs.readdir(dir)).sort(), ['stats.json', 'stats.json.commit.lock']);
});

test(
    'a real second process cannot replace statistics inside another guarded rename',
    { timeout: 10000 },
    async context => {
        const dir = await fs.mkdtemp(join(tmpdir(), 'gcmp-commit-process-'));
        context.after(() => fs.rm(dir, { recursive: true, force: true }));
        const path = join(dir, 'stats.json');
        await fs.writeFile(path, '{"requests":0}');
        let enter!: () => void, release!: () => void;
        const entered = new Promise<void>(resolve => {
            enter = resolve;
        });
        const blocked = new Promise<void>(resolve => {
            release = resolve;
        });
        const rename = promises.rename;
        context.mock.method(promises, 'rename', async (...args: Parameters<typeof rename>) => {
            if (String(args[1]) === path) {
                enter();
                await blocked;
            }
            return rename(...args);
        });
        const first = write.call(AtomicJsonFile, path, { requests: 1 }, undefined, () => true);
        let child: ReturnType<typeof fork> | undefined;
        let exited: Promise<unknown[]> | undefined;
        try {
            await entered;
            const owner = JSON.parse(await fs.readFile(`${path}.commit.lock/owner.json`, 'utf8')) as { pid: number };
            assert.equal(owner.pid, process.pid);
            child = fork(fileURLToPath(new URL('./commitWorker.ts', import.meta.url)), [], {
                execArgv: ['--import=tsx'],
                stdio: ['ignore', 'inherit', 'inherit', 'ipc']
            });
            exited = once(child, 'exit');
            const [ready] = await once(child, 'message');
            assert.deepEqual(ready, { kind: 'ready' });
            const prepared = once(child, 'message');
            child.send({ path });
            assert.deepEqual((await prepared)[0], { kind: 'prepared' });
            assert.equal(await fs.readFile(path, 'utf8'), '{"requests":0}');
            const done = once(child, 'message');
            release();
            await first;
            assert.deepEqual((await done)[0], { kind: 'done' });
            assert.equal((await exited)[0], 0);
            assert.deepEqual(JSON.parse(await fs.readFile(path, 'utf8')), { requests: 2 });
            assert.deepEqual(await fs.readdir(dir), ['stats.json']);
        } finally {
            release();
            await first;
            if (child?.connected) {
                child.kill();
            }
            if (exited) {
                await exited;
            }
        }
    }
);
