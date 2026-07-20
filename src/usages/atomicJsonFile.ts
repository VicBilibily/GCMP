import * as fs from 'fs/promises';
import * as path from 'path';

export class AtomicJsonFile {
    private static readonly queues = new Map<string, Promise<void>>();

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
