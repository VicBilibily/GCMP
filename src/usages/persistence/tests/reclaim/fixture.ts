import assert from 'node:assert/strict';
import { spawnSync, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import * as fs from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type TestContext } from 'node:test';
import { AtomicJsonFile } from '../../../atomicJsonFile';

export const promises = createRequire(import.meta.url)('node:fs/promises') as typeof fs;
export const write = (path: string, requests: number, canWrite = () => true) =>
    AtomicJsonFile.writeJsonAtomically(path, { requests }, undefined, canWrite);
export function gate() {
    let release!: () => void;
    const promise = new Promise<void>(resolve => {
        release = resolve;
    });
    return { promise, release };
}
export async function bounded<T>(promise: Promise<T>): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
        return await Promise.race([
            promise,
            new Promise<never>((_, reject) => {
                timer = setTimeout(() => reject(new Error('reclaim boundary not reached')), 6000);
            })
        ]);
    } finally {
        clearTimeout(timer);
    }
}
export async function fixture(context: TestContext, deadLock = false) {
    const dir = await fs.mkdtemp(join(tmpdir(), 'gcmp-reclaim-owner-'));
    context.after(() => fs.rm(dir, { recursive: true, force: true }));
    const path = join(dir, 'stats.json'),
        lock = `${path}.commit.lock`,
        guard = `${lock}.reclaim`;
    const child = spawnSync(process.execPath, ['-e', ''], { stdio: 'ignore' });
    assert.equal(child.status, 0);
    assert.throws(() => process.kill(child.pid, 0), { code: 'ESRCH' });
    const dead = { pid: child.pid, token: randomUUID() };
    await fs.writeFile(path, '{"requests":0}');
    if (deadLock) {
        await fs.mkdir(lock);
        await fs.writeFile(join(lock, 'owner.json'), JSON.stringify(dead));
    }
    return { dir, path, lock, guard, dead };
}

export async function releaseChild(child: Pick<ChildProcess, 'connected' | 'send'> | undefined): Promise<void> {
    if (!child?.connected) {
        return;
    }
    await new Promise<void>((resolve, reject) => {
        child.send({ kind: 'release' }, (error: Error | null) => {
            if (error && !['EPIPE', 'ERR_IPC_CHANNEL_CLOSED'].includes((error as NodeJS.ErrnoException).code ?? '')) {
                reject(error);
            } else {
                resolve();
            }
        });
    });
}
