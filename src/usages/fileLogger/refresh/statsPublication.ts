import * as fs from 'fs/promises';
import { createHash } from 'crypto';
import { AtomicJsonFile } from '../../atomicJsonFile';
import type { TokenUsageStatsFromFile } from '../types';

export class StatsPublication {
    private readonly versions = new Map<string, { signature: string; fingerprint: string }>();
    private readonly applied = new Map<string, string>();

    async readPendingStats(statsPath: string): Promise<TokenUsageStatsFromFile | undefined> {
        return AtomicJsonFile.runExclusive(statsPath, async () => {
            const current = await this.readCommitted(statsPath, true);
            return current?.fingerprint !== this.applied.get(statsPath) ? current?.stats : undefined;
        });
    }

    private async readCommitted(
        statsPath: string,
        includeStats = false
    ): Promise<
        | {
              signature: string;
              fingerprint: string;
              stats?: TokenUsageStatsFromFile;
          }
        | undefined
    > {
        try {
            const signature = await this.statsVersion(statsPath);
            const cached = this.versions.get(statsPath);
            if (
                cached?.signature === signature &&
                (!includeStats || cached.fingerprint === this.applied.get(statsPath))
            ) {
                return cached;
            }
            const stats = JSON.parse(await fs.readFile(statsPath, 'utf8')) as TokenUsageStatsFromFile;
            if (!stats?.total || typeof stats.total !== 'object' || Array.isArray(stats.total)) {
                throw new Error('Invalid statistics publication data');
            }
            const fingerprint = createHash('sha256').update(JSON.stringify(stats)).digest('hex');
            if ((await this.statsVersion(statsPath)) !== signature) {
                this.versions.delete(statsPath);
                return;
            }
            this.versions.set(statsPath, { signature, fingerprint });
            return { signature, stats, fingerprint };
        } catch (error) {
            this.versions.delete(statsPath);
            if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
                return;
            }
            throw error;
        }
    }

    retain(statsPaths: ReadonlySet<string>): void {
        for (const entries of [this.versions, this.applied]) {
            for (const statsPath of entries.keys()) {
                if (!statsPaths.has(statsPath)) {
                    entries.delete(statsPath);
                }
            }
        }
    }

    async isPending(statsPath: string, fingerprint: string): Promise<boolean> {
        return AtomicJsonFile.runExclusive(statsPath, async () => {
            if (this.applied.get(statsPath) === fingerprint) {
                return false;
            }
            return (await this.readCommitted(statsPath))?.fingerprint === fingerprint;
        });
    }

    async acknowledge(statsPath: string, fingerprint: string, canWrite: () => boolean): Promise<boolean> {
        return AtomicJsonFile.runExclusive(statsPath, async () => {
            if (!canWrite()) {
                return false;
            }
            const current = await this.readCommitted(statsPath);
            if (!canWrite() || current?.fingerprint !== fingerprint) {
                return false;
            }
            if (!canWrite()) {
                return false;
            }
            this.applied.set(statsPath, fingerprint);
            return true;
        });
    }

    private async statsVersion(statsPath: string): Promise<string> {
        try {
            const stats = await fs.stat(statsPath, { bigint: true });
            return `${stats.dev}:${stats.ino}:${stats.size}:${stats.mtimeNs}:${stats.ctimeNs}`;
        } catch (error) {
            if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
                return 'missing';
            }
            throw error;
        }
    }
}
