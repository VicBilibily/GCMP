import * as fs from 'fs/promises';
import { existsSync, type BigIntStats } from 'fs';
import { join } from 'path';
import { randomUUID } from 'crypto';
import { finishPendingRelease, releaseLock, withLockCleanup } from './lockRelease';
import { removeAbandonedReclaimGuard, withReclaimGuard } from './reclaimGuard';

interface LockOwner {
    pid: number;
    token: string;
}

type OwnerFileIdentity = Pick<BigIntStats, 'dev' | 'ino' | 'birthtimeNs'>;

interface DirectoryLockOptions {
    waitMs: number;
    retryMs: number;
    orphanMs: number;
    reclaimOrphanMs: number;
    timeoutMessage: string;
    ownershipLost: () => Error;
    assertActive?: () => void;
    isProcessAlive?: (pid: number) => boolean;
    retryTransient?: boolean;
}

async function readOwner(lockPath: string): Promise<LockOwner | undefined> {
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

function isProcessAlive(pid: number): boolean {
    try {
        process.kill(pid, 0);
        return true;
    } catch (error) {
        return (error as NodeJS.ErrnoException).code !== 'ESRCH';
    }
}

function isRetryable(error: unknown, options: DirectoryLockOptions): boolean {
    if (!options.retryTransient) {
        return false;
    }
    if (error instanceof AggregateError) {
        return error.errors.length > 0 && error.errors.every((cause: unknown) => isRetryable(cause, options));
    }
    return ['EPERM', 'EACCES', 'EBUSY'].includes((error as NodeJS.ErrnoException | undefined)?.code ?? '');
}

function timeout(message: string, cause: unknown): Error {
    return Object.assign(new Error(message), { cause });
}

async function retryIo<T>(
    operation: () => Promise<T>,
    deadline: number,
    options: DirectoryLockOptions,
    message: string
): Promise<T> {
    while (true) {
        try {
            return await operation();
        } catch (error) {
            if (!isRetryable(error, options)) {
                throw error;
            }
            if (Date.now() >= deadline) {
                throw timeout(message, error);
            }
            await new Promise<void>(resolve => setTimeout(resolve, options.retryMs));
        }
    }
}

async function releaseOwnedLock(
    lockPath: string,
    token: string,
    options: DirectoryLockOptions,
    ownerIdentity?: OwnerFileIdentity
): Promise<void> {
    let started = false;
    await retryIo(
        () => {
            if (started) {
                return finishPendingRelease(lockPath);
            }
            started = true;
            return releaseLock(lockPath, async () => {
                const owner = await readOwner(lockPath);
                if (owner?.pid === process.pid && owner.token === token) {
                    await fs.rm(lockPath, { recursive: true, force: true });
                } else if (!owner) {
                    if (ownerIdentity) {
                        const ownerPath = join(lockPath, 'owner.json');
                        try {
                            const current = await fs.stat(ownerPath, { bigint: true });
                            if (
                                current.dev !== ownerIdentity.dev ||
                                current.ino !== ownerIdentity.ino ||
                                current.birthtimeNs !== ownerIdentity.birthtimeNs
                            ) {
                                return;
                            }
                            await fs.rm(ownerPath, { force: true });
                        } catch (error) {
                            if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
                                throw error;
                            }
                        }
                    }
                    try {
                        await fs.rmdir(lockPath);
                    } catch (error) {
                        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
                            throw error;
                        }
                    }
                }
            });
        },
        Date.now() + options.waitMs,
        options,
        `Timed out releasing directory lock: ${lockPath}`
    );
}

async function reclaim(lockPath: string, reclaimPath: string, options: DirectoryLockOptions): Promise<boolean> {
    return withReclaimGuard(reclaimPath, async () => {
        const owner = await readOwner(lockPath);
        if (owner) {
            if ((options.isProcessAlive ?? isProcessAlive)(owner.pid)) {
                return false;
            }
        } else {
            try {
                if (Date.now() - (await fs.stat(lockPath)).mtimeMs < options.orphanMs) {
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

export async function withDirectoryLock<T>(
    lockPath: string,
    options: DirectoryLockOptions,
    operation: () => Promise<T>
): Promise<T> {
    const reclaimPath = `${lockPath}.reclaim`;
    const token = randomUUID(),
        deadline = Date.now() + options.waitMs;
    let lastError: unknown;
    while (true) {
        options.assertActive?.();
        if (Date.now() >= deadline) {
            throw timeout(options.timeoutMessage, lastError);
        }
        try {
            await finishPendingRelease(lockPath);
            if (existsSync(reclaimPath)) {
                if (await removeAbandonedReclaimGuard(reclaimPath, options.reclaimOrphanMs)) {
                    continue;
                }
            } else {
                try {
                    await fs.mkdir(lockPath);
                    let ownerIdentity: OwnerFileIdentity | undefined;
                    try {
                        const ownerPath = join(lockPath, 'owner.json');
                        const ownerFile = await fs.open(ownerPath, 'wx');
                        await withLockCleanup(
                            async () => {
                                ownerIdentity = await ownerFile.stat({ bigint: true });
                                await fs.writeFile(ownerPath, JSON.stringify({ pid: process.pid, token }), {
                                    flag: 'r+'
                                });
                            },
                            () => ownerFile.close()
                        );
                    } catch (error) {
                        await withLockCleanup(
                            async () => {
                                throw error;
                            },
                            () => releaseOwnedLock(lockPath, token, options, ownerIdentity)
                        );
                    }
                    break;
                } catch (error) {
                    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') {
                        throw error;
                    }
                    if (await reclaim(lockPath, reclaimPath, options)) {
                        continue;
                    }
                }
            }
        } catch (error) {
            if (!isRetryable(error, options)) {
                throw error;
            }
            lastError = error;
        }
        if (Date.now() >= deadline) {
            throw timeout(options.timeoutMessage, lastError);
        }
        await new Promise<void>(resolve => setTimeout(resolve, options.retryMs));
    }
    return withLockCleanup(
        async () => {
            options.assertActive?.();
            const owner = await retryIo(() => readOwner(lockPath), deadline, options, options.timeoutMessage);
            options.assertActive?.();
            if (owner?.pid !== process.pid || owner.token !== token) {
                throw options.ownershipLost();
            }
            return operation();
        },
        () => releaseOwnedLock(lockPath, token, options)
    );
}
