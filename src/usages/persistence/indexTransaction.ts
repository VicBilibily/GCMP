import { readdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { AtomicJsonFile } from '../atomicJsonFile';
import { getFileVersionSync } from './versionedJsonFile';

export class IndexVersionChangedError extends Error {}

export class IndexTransaction {
    private version = 'missing';

    constructor(
        private readonly path: string,
        private readonly capturePermission: () => () => boolean
    ) {}

    observe(version: string): void {
        this.version = version;
    }

    run<T>(operation: (canWrite: () => boolean) => Promise<T>, additional?: () => boolean): Promise<T> {
        const permission = this.capturePermission();
        const allowed = permission() && (additional?.() ?? true);
        const canWrite = () => allowed && permission() && (additional?.() ?? true);
        return AtomicJsonFile.runExclusive(this.path, async () => {
            for (let attempt = 0; ; attempt++) {
                try {
                    return await operation(canWrite);
                } catch (error) {
                    if (!(error instanceof IndexVersionChangedError) || attempt >= 2) {
                        throw error;
                    }
                }
            }
        });
    }

    guard(canWrite: () => boolean, sources?: ReadonlyMap<string, string>, dates?: string[]): () => boolean {
        const version = this.version;
        return () => {
            if (!canWrite()) {
                return false;
            }
            if (
                getFileVersionSync(this.path) !== version ||
                (sources && [...sources].some(([path, expected]) => getFileVersionSync(path) !== expected)) ||
                (dates && this.dates().join('\0') !== dates.join('\0'))
            ) {
                throw new IndexVersionChangedError('Date index observations changed before commit');
            }
            return true;
        };
    }

    private dates(): string[] {
        return readdirSync(dirname(this.path), { withFileTypes: true })
            .filter(entry => entry.isDirectory() && /^\d{4}-\d{2}-\d{2}$/.test(entry.name))
            .map(entry => entry.name)
            .sort()
            .reverse();
    }
}
