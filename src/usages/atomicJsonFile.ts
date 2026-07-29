import * as fs from 'fs/promises';
import * as path from 'path';

export class AtomicJsonFile {
    private static readonly queues = new Map<string, Promise<void>>();
    private static readonly LOCK_TOKEN_SEPARATOR = ':';

    static async runExclusive<T>(filePath: string, operation: () => Promise<T>): Promise<T> {
        const previous = this.queues.get(filePath) ?? Promise.resolve();
        let release!: () => void;
        const current = new Promise<void>(resolve => {
            release = resolve;
        });
        const tail = previous.catch(() => undefined).then(() => current);

        this.queues.set(filePath, tail);
        await previous.catch(() => undefined);

        try {
            return await operation();
        } finally {
            release();
            if (this.queues.get(filePath) === tail) {
                this.queues.delete(filePath);
            }
        }
    }

    /** 锁文件残留判定阈值：持锁进程崩溃后，超过此时长的锁文件视为死锁并被接管 */
    private static readonly FILE_LOCK_STALE_MS = 30 * 1000;
    /** 持锁期间心跳刷新 mtime，避免慢磁盘/长 I/O 被误判为残留锁 */
    private static readonly FILE_LOCK_HEARTBEAT_MS = 2000;

    /**
     * 跨进程互斥执行 read-modify-write。
     * runExclusive 只串行化本进程；不同 VS Code 窗口运行在不同 Extension Host 进程，
     * 进程内锁无法阻止两个窗口同时"读旧文件→各自合并→先后 rename"导致的丢更新。
     * 这里用 `<file>.lock` 独占创建（wx，各平台原子）实现跨进程锁，
     * 与 runExclusive 嵌套使用：进程内排队 + 进程间互斥。
     */
    static async runFileLocked<T>(filePath: string, operation: () => Promise<T>): Promise<T> {
        const lockPath = `${filePath}.lock`;
        const release = await this.acquireFileLock(lockPath);
        try {
            return await operation();
        } finally {
            await release();
        }
    }

    private static async acquireFileLock(lockPath: string): Promise<() => Promise<void>> {
        for (;;) {
            try {
                // wx：文件已存在即失败，创建本身即加锁（记录 pid 便于排查残留）
                const token = this.createLockToken();
                const handle = await fs.open(lockPath, 'wx');
                await handle.writeFile(token);
                await handle.close();
                const heartbeat = setInterval(() => {
                    void fs.utimes(lockPath, new Date(), new Date()).catch(() => undefined);
                }, this.FILE_LOCK_HEARTBEAT_MS);
                heartbeat.unref?.();
                return async () => {
                    clearInterval(heartbeat);
                    // 仅释放自己创建的锁：避免 stale 接管后旧持有者恢复执行，把新持有者的锁误删掉。
                    await this.removeLockIfOwned(lockPath, token);
                };
            } catch (error) {
                const code = (error as NodeJS.ErrnoException)?.code;
                if (code !== 'EEXIST') {
                    throw error;
                }
                // 锁文件过旧视为残留（持有者已崩溃），强制接管
                try {
                    const stat = await fs.stat(lockPath);
                    if (Date.now() - stat.mtimeMs > this.FILE_LOCK_STALE_MS) {
                        const staleToken = await this.readLockToken(lockPath);
                        if (staleToken) {
                            await this.removeLockIfOwned(lockPath, staleToken);
                        } else {
                            // 极少数情况下进程可能在写入 token 前崩溃，退化到 mtime 二次确认后清理残留空锁。
                            await this.removeLockIfUnchanged(lockPath, stat.mtimeMs);
                        }
                        continue;
                    }
                } catch {
                    // 锁文件恰好被释放，直接重试
                }
                // 不能退化为无锁执行，否则 read-modify-write 会重新暴露丢更新窗口
                await new Promise(resolve => setTimeout(resolve, 30));
            }
        }
    }

    private static createLockToken(): string {
        return [process.pid, Date.now().toString(36), Math.random().toString(36).slice(2)].join(
            this.LOCK_TOKEN_SEPARATOR
        );
    }

    private static normalizeLockToken(value: string): string | undefined {
        const token = value.trim();
        return token || undefined;
    }

    private static async readLockToken(lockPath: string): Promise<string | undefined> {
        try {
            return this.normalizeLockToken(await fs.readFile(lockPath, 'utf-8'));
        } catch {
            return undefined;
        }
    }

    private static async removeLockIfOwned(lockPath: string, expectedToken: string): Promise<void> {
        try {
            const currentToken = await this.readLockToken(lockPath);
            if (currentToken !== expectedToken) {
                return;
            }
            await fs.rm(lockPath, { force: true }).catch(() => undefined);
        } catch {
            // 文件已被其他持有者接管或释放，忽略即可
        }
    }

    private static async removeLockIfUnchanged(lockPath: string, expectedMtimeMs: number): Promise<void> {
        try {
            const stat = await fs.stat(lockPath);
            if (stat.mtimeMs !== expectedMtimeMs) {
                return;
            }
            await fs.rm(lockPath, { force: true }).catch(() => undefined);
        } catch {
            // 锁文件已变化或不存在，无需处理
        }
    }

    static async writeJsonAtomically(
        filePath: string,
        value: unknown,
        serializer: (value: unknown) => string = value => JSON.stringify(value, null, 2)
    ): Promise<void> {
        const serialized = serializer(value);
        const dirPath = path.dirname(filePath);
        const tempPath = `${filePath}.${process.pid}.${Date.now().toString(36)}.${Math.random().toString(36).slice(2)}.tmp`;

        await fs.mkdir(dirPath, { recursive: true });

        try {
            await fs.writeFile(tempPath, serialized, 'utf-8');
            // rename 在 POSIX 上原子替换已存在目标；Windows (NTFS) 上同样会替换已存在文件
            await this.renameWithRetry(tempPath, filePath);
        } catch (error) {
            await fs.rm(tempPath, { force: true }).catch(() => undefined);
            throw error;
        }
    }

    /**
     * Windows 上 rename 替换目标文件时，若目标被其他句柄（本进程的 readFile、
     * 杀毒软件、Windows Search 索引等）瞬时占用，会抛 EPERM/EBUSY/EACCES。
     * 对这些瞬时错误退避重试，覆盖外部进程的短时占用。
     */
    private static readonly RENAME_RETRYABLE_CODES = new Set(['EPERM', 'EBUSY', 'EACCES', 'EEXIST']);
    private static async renameWithRetry(src: string, dest: string, retries = 5): Promise<void> {
        let lastError: unknown;
        for (let attempt = 0; attempt <= retries; attempt++) {
            try {
                await fs.rename(src, dest);
                return;
            } catch (error) {
                lastError = error;
                const code = (error as NodeJS.ErrnoException)?.code;
                if (!code || !this.RENAME_RETRYABLE_CODES.has(code)) {
                    throw error;
                }
                if (attempt < retries) {
                    // 线性退避：30/60/90/120/150ms，覆盖杀软扫描与本进程 readFile 的短时占用
                    await new Promise(resolve => setTimeout(resolve, 30 * (attempt + 1)));
                }
            }
        }
        throw lastError;
    }
}
