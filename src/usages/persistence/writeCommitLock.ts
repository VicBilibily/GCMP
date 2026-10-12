import * as fs from 'fs/promises';
import { existsSync } from 'fs';
import { join } from 'path';
import { randomUUID } from 'crypto';
import { finishPendingRelease, releaseLock } from './lockRelease';
import { removeAbandonedReclaimGuard, withReclaimGuard } from './reclaimGuard';

export class WritePermissionLostError extends Error {
    constructor() {
        super('Statistics write permission expired');
        this.name = 'WritePermissionLostError';
    }
}

interface CommitOwner {
    pid: number;
    token: string;
}

async function readOwner(lockPath: string): Promise<CommitOwner | undefined> {
    let content: string;
    try {
        content = await fs.readFile(join(lockPath, 'owner.json'), 'utf8');
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
            return undefined;
        }
        throw error;
    }
    try {
        const owner: unknown = JSON.parse(content);
        if (
            owner &&
            typeof owner === 'object' &&
            'pid' in owner &&
            'token' in owner &&
            typeof owner.pid === 'number' &&
            Number.isInteger(owner.pid) &&
            owner.pid > 0 &&
            typeof owner.token === 'string'
        ) {
            return { pid: owner.pid, token: owner.token };
        }
    } catch {
        return undefined;
    }
    return undefined;
}

function releaseOwnedLock(lockPath: string, token: string): Promise<void> {
    return releaseLock(lockPath, async () => {
        const owner = await readOwner(lockPath);
        if (owner?.pid === process.pid && owner.token === token) {
            await fs.rm(lockPath, { recursive: true, force: true });
        } else if (!owner) {
            try {
                await fs.rmdir(lockPath);
            } catch (error) {
                if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
                    throw error;
                }
            }
        }
    });
}

async function reclaim(lockPath: string, reclaimPath: string): Promise<boolean> {
    return withReclaimGuard(reclaimPath, async () => {
        const owner = await readOwner(lockPath);
        if (owner) {
            try {
                process.kill(owner.pid, 0);
                return false;
            } catch (error) {
                if ((error as NodeJS.ErrnoException).code !== 'ESRCH') {
                    return false;
                }
            }
        } else {
            try {
                if (Date.now() - (await fs.stat(lockPath)).mtimeMs < 60000) {
                    return false;
                }
                // 初始化可能刚写入 owner，非递归删除不能越过这个边界。
                await fs.rmdir(lockPath);
                return true;
            } catch (error) {
                if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
                    return true;
                }
                if (['ENOTEMPTY', 'EEXIST'].includes((error as NodeJS.ErrnoException).code ?? '')) {
                    return false;
                }
                throw error;
            }
        }
        await fs.rm(lockPath, { recursive: true, force: true });
        return true;
    });
}

export async function withWriteCommitLock<T>(
    filePath: string,
    canWrite: () => boolean,
    operation: () => Promise<T>
): Promise<T> {
    const lockPath = `${filePath}.commit.lock`,
        reclaimPath = `${lockPath}.reclaim`;
    const token = randomUUID(),
        deadline = Date.now() + 10000;
    while (true) {
        if (!canWrite()) {
            throw new WritePermissionLostError();
        }
        await finishPendingRelease(lockPath);
        if (existsSync(reclaimPath)) {
            if (await removeAbandonedReclaimGuard(reclaimPath)) {
                continue;
            }
        } else {
            try {
                await fs.mkdir(lockPath);
                try {
                    await fs.writeFile(join(lockPath, 'owner.json'), JSON.stringify({ pid: process.pid, token }), {
                        flag: 'wx'
                    });
                } catch (error) {
                    await releaseOwnedLock(lockPath, token).catch(() => undefined);
                    throw error;
                }
                break;
            } catch (error) {
                if ((error as NodeJS.ErrnoException).code !== 'EEXIST') {
                    throw error;
                }
                if (await reclaim(lockPath, reclaimPath)) {
                    continue;
                }
            }
        }
        if (Date.now() >= deadline) {
            throw new Error(`Timed out waiting for statistics commit: ${filePath}`);
        }
        await new Promise<void>(resolve => setTimeout(resolve, 25));
    }
    try {
        if (!canWrite() || (await readOwner(lockPath))?.token !== token) {
            throw new WritePermissionLostError();
        }
        return await operation();
    } finally {
        await releaseOwnedLock(lockPath, token);
    }
}
