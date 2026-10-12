import * as fs from 'fs/promises';
import { existsSync } from 'fs';
import { join } from 'path';
import { randomUUID } from 'crypto';
import { finishPendingRelease, releaseLock, withLockCleanup } from './lockRelease';

async function removeEmptyGuard(reclaimPath: string): Promise<boolean> {
    try {
        await fs.rmdir(reclaimPath);
        return true;
    } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (code === 'ENOENT') {
            return true;
        }
        if (code === 'ENOTEMPTY' || code === 'EEXIST') {
            return false;
        }
        throw error;
    }
}

async function removeOwner(reclaimPath: string, owner: string): Promise<void> {
    await fs.rm(join(reclaimPath, owner), { force: true });
    await removeEmptyGuard(reclaimPath);
}

export async function removeAbandonedReclaimGuard(reclaimPath: string, orphanMs = 60000): Promise<boolean> {
    await finishPendingRelease(reclaimPath);
    try {
        const entries = await fs.readdir(reclaimPath, { withFileTypes: true });
        if (entries.length === 0) {
            if (Date.now() - (await fs.stat(reclaimPath)).mtimeMs < orphanMs) {
                return false;
            }
            return await removeEmptyGuard(reclaimPath);
        }
        const entry = entries[0];
        if (entries.length !== 1 || !entry.isFile()) {
            return false;
        }
        const match = /^(\d+)\.([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/.exec(entry.name);
        const pid = Number(match?.[1]);
        if (!match || !Number.isSafeInteger(pid) || pid <= 0) {
            return false;
        }
        try {
            process.kill(pid, 0);
            return false;
        } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== 'ESRCH') {
                return false;
            }
        }
        await fs.rm(join(reclaimPath, entry.name), { force: true });
        return await removeEmptyGuard(reclaimPath);
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
            return true;
        }
        throw error;
    }
}

export async function withReclaimGuard(reclaimPath: string, operation: () => Promise<boolean>): Promise<boolean> {
    await finishPendingRelease(reclaimPath);
    const owner = `${process.pid}.${randomUUID()}`,
        temporary = `${reclaimPath}.${owner}.tmp`;
    await fs.mkdir(temporary);
    let published = false;
    return withLockCleanup(
        async () => {
            await fs.writeFile(join(temporary, owner), '', { flag: 'wx' });
            try {
                // 整目录发布使所有权与标记同时可见，非空目录不能被另一代替换。
                await fs.rename(temporary, reclaimPath);
                published = true;
            } catch (error) {
                if (existsSync(join(reclaimPath, owner))) {
                    return withLockCleanup(
                        async () => {
                            throw error;
                        },
                        () => releaseLock(reclaimPath, () => removeOwner(reclaimPath, owner))
                    );
                }
                if (
                    ['EEXIST', 'ENOTEMPTY', 'EPERM', 'EACCES', 'EBUSY'].includes(
                        (error as NodeJS.ErrnoException).code ?? ''
                    ) &&
                    existsSync(reclaimPath)
                ) {
                    return false;
                }
                throw error;
            }
            return withLockCleanup(operation, () => releaseLock(reclaimPath, () => removeOwner(reclaimPath, owner)));
        },
        async () => {
            if (!published) {
                await fs.rm(temporary, { recursive: true, force: true });
            }
        }
    );
}
