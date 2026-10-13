import * as fs from 'node:fs/promises';
import { statSync, type BigIntStats } from 'node:fs';

export interface JsonFileSnapshot<T> {
    value: T;
    version: string;
}

interface CacheEntry<T> extends JsonFileSnapshot<T> {
    bytes: number;
}

function version(stat: BigIntStats): string {
    return `${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeNs}:${stat.ctimeNs}`;
}

export async function getFileVersion(filePath: string): Promise<string> {
    return version(await fs.stat(filePath, { bigint: true }));
}

export function getFileVersionSync(filePath: string): string {
    try {
        return version(statSync(filePath, { bigint: true }));
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
            return 'missing';
        }
        throw error;
    }
}

export class VersionedJsonFile<T> {
    private readonly cache = new Map<string, CacheEntry<T>>();
    private readonly reads = new Map<
        string,
        { version: string; token: object; promise: Promise<JsonFileSnapshot<T>> }
    >();
    private bytes = 0;

    constructor(
        private readonly decode: (value: unknown) => T,
        private readonly maxEntries = 32,
        private readonly maxBytes = 8 * 1024 * 1024
    ) {}

    async read(
        filePath: string,
        readContent: () => Promise<string> = () => fs.readFile(filePath, 'utf8')
    ): Promise<JsonFileSnapshot<T>> {
        try {
            const version = await getFileVersion(filePath);
            const cached = this.cache.get(filePath);
            if (cached?.version === version) {
                this.cache.delete(filePath);
                this.cache.set(filePath, cached);
                return { value: structuredClone(cached.value), version };
            }
            this.remove(filePath);
            let current = this.reads.get(filePath);
            if (!current || current.version !== version) {
                const token = {};
                const promise = this.readStable(filePath, version, token, readContent);
                current = { version, token, promise };
                this.reads.set(filePath, current);
                void promise
                    .finally(() => {
                        if (this.reads.get(filePath)?.promise === promise) {
                            this.reads.delete(filePath);
                        }
                    })
                    .catch(() => undefined);
            }
            const snapshot = await current.promise;
            return { value: structuredClone(snapshot.value), version: snapshot.version };
        } catch (error) {
            this.remove(filePath);
            throw error;
        }
    }

    invalidate(filePath: string): void {
        this.reads.delete(filePath);
        this.remove(filePath);
    }

    private async readStable(
        filePath: string,
        version: string,
        token: object,
        readContent: () => Promise<string>
    ): Promise<JsonFileSnapshot<T>> {
        for (let attempt = 0; attempt < 3; attempt++) {
            const content = await readContent();
            const latestVersion = await getFileVersion(filePath);
            if (latestVersion !== version) {
                version = latestVersion;
                continue;
            }
            const snapshot = { value: this.decode(JSON.parse(content) as unknown), version };
            const bytes = Buffer.byteLength(content);
            if (this.reads.get(filePath)?.token === token && bytes <= this.maxBytes) {
                this.remove(filePath);
                this.cache.set(filePath, { ...snapshot, bytes });
                this.bytes += bytes;
                while (this.cache.size > this.maxEntries || this.bytes > this.maxBytes) {
                    this.remove(this.cache.keys().next().value!);
                }
            }
            return snapshot;
        }
        throw new Error(`File changed repeatedly while reading: ${filePath}`);
    }

    private remove(filePath: string): void {
        const cached = this.cache.get(filePath);
        if (cached) {
            this.bytes -= cached.bytes;
            this.cache.delete(filePath);
        }
    }
}
