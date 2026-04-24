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

    static async writeJsonAtomically(filePath: string, value: unknown): Promise<void> {
        const serialized = JSON.stringify(value, null, 2);
        const dirPath = path.dirname(filePath);
        const tempPath = `${filePath}.${process.pid}.${Date.now().toString(36)}.${Math.random().toString(36).slice(2)}.tmp`;

        await fs.mkdir(dirPath, { recursive: true });

        try {
            await fs.writeFile(tempPath, serialized, 'utf-8');
            // rename 在 POSIX 上原子替换已存在目标；Windows (NTFS) 上同样会替换已存在文件
            await fs.rename(tempPath, filePath);
        } catch (error) {
            await fs.rm(tempPath, { force: true }).catch(() => undefined);
            throw error;
        }
    }
}
