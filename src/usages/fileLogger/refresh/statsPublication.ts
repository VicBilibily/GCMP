import * as fs from 'fs/promises';
import * as path from 'path';
import { createHash } from 'crypto';
import { AtomicJsonFile } from '../../atomicJsonFile';
import type { TokenUsageStatsFromFile } from '../types';

interface PublicationMarker {
    pending: string[];
}

export class StatsPublication {
    private static readonly MAX_CACHED_VERSIONS = 256;
    private readonly versions = new Map<string, { signature: string; fingerprint: string }>();

    async readPendingStats(statsPath: string): Promise<TokenUsageStatsFromFile | undefined> {
        return AtomicJsonFile.runExclusive(statsPath, async () => {
            const marker = await this.read(statsPath);
            if (!marker?.pending.length) {
                return;
            }
            const published = await this.readAcknowledgement(statsPath);
            if (marker.pending.every(fingerprint => fingerprint === published)) {
                return;
            }
            try {
                const signature = await this.statsVersion(statsPath);
                const cached = this.versions.get(statsPath);
                if (cached?.signature === signature && cached.fingerprint === published) {
                    return;
                }
                const stats = JSON.parse(await fs.readFile(statsPath, 'utf8')) as TokenUsageStatsFromFile;
                if (!stats?.total || typeof stats.total !== 'object' || Array.isArray(stats.total)) {
                    throw new Error('Invalid statistics publication data');
                }
                const fingerprint = createHash('sha256').update(JSON.stringify(stats)).digest('hex');
                if ((await this.statsVersion(statsPath)) === signature) {
                    this.versions.delete(statsPath);
                    this.versions.set(statsPath, { signature, fingerprint });
                    if (this.versions.size > StatsPublication.MAX_CACHED_VERSIONS) {
                        this.versions.delete(this.versions.keys().next().value!);
                    }
                }
                return marker.pending.includes(fingerprint) && fingerprint !== published ? stats : undefined;
            } catch (error) {
                this.versions.delete(statsPath);
                if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
                    return;
                }
                throw error;
            }
        });
    }

    async prepare(
        statsPath: string,
        fingerprint: string,
        previousFingerprint?: string,
        canWrite?: () => boolean
    ): Promise<void> {
        if (previousFingerprint === undefined) {
            try {
                const previous: unknown = JSON.parse(await fs.readFile(statsPath, 'utf8'));
                previousFingerprint = createHash('sha256').update(JSON.stringify(previous)).digest('hex');
            } catch (error) {
                if ((error as NodeJS.ErrnoException).code !== 'ENOENT' && !(error instanceof SyntaxError)) {
                    throw error;
                }
            }
        }
        const marker = await this.read(statsPath);
        const pending = new Set([fingerprint]);
        if (
            previousFingerprint &&
            marker?.pending.includes(previousFingerprint) &&
            (await this.readAcknowledgement(statsPath)) !== previousFingerprint
        ) {
            pending.add(previousFingerprint);
        }
        await AtomicJsonFile.writeJsonAtomically(
            this.markerPath(statsPath),
            { pending: [...pending] },
            undefined,
            canWrite
        );
    }

    async isPending(statsPath: string, fingerprint: string): Promise<boolean> {
        return AtomicJsonFile.runExclusive(statsPath, async () => {
            const marker = await this.read(statsPath);
            return (
                Boolean(marker?.pending.includes(fingerprint)) &&
                (await this.readAcknowledgement(statsPath)) !== fingerprint
            );
        });
    }

    async acknowledge(statsPath: string, fingerprint: string, canWrite: () => boolean): Promise<boolean> {
        return AtomicJsonFile.runExclusive(statsPath, async () => {
            if (!canWrite()) {
                return false;
            }
            const marker = await this.read(statsPath);
            if (!canWrite() || !marker?.pending.includes(fingerprint)) {
                return false;
            }
            const published = await this.readAcknowledgement(statsPath);
            if (!canWrite()) {
                return false;
            }
            if (published !== fingerprint) {
                await AtomicJsonFile.writeJsonAtomically(this.acknowledgementPath(statsPath), fingerprint);
            }
            return true;
        });
    }

    private async statsVersion(statsPath: string): Promise<string> {
        const stats = await fs.stat(statsPath, { bigint: true });
        return `${stats.dev}:${stats.ino}:${stats.size}:${stats.mtimeNs}:${stats.ctimeNs}`;
    }

    private markerPath(statsPath: string): string {
        return path.join(path.dirname(statsPath), 'stats-publication.json');
    }

    private acknowledgementPath(statsPath: string): string {
        return path.join(path.dirname(statsPath), 'stats-published.json');
    }

    private async readAcknowledgement(statsPath: string): Promise<string | undefined> {
        try {
            const fingerprint: unknown = JSON.parse(await fs.readFile(this.acknowledgementPath(statsPath), 'utf8'));
            if (typeof fingerprint !== 'string') {
                throw new Error('Invalid statistics publication acknowledgement');
            }
            return fingerprint;
        } catch (error) {
            if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
                return undefined;
            }
            throw error;
        }
    }

    private async read(statsPath: string): Promise<PublicationMarker | undefined> {
        try {
            const marker: unknown = JSON.parse(await fs.readFile(this.markerPath(statsPath), 'utf8'));
            if (
                typeof marker !== 'object' ||
                marker === null ||
                !('pending' in marker) ||
                !Array.isArray(marker.pending) ||
                marker.pending.length > 2 ||
                !marker.pending.every((value: unknown) => typeof value === 'string')
            ) {
                throw new Error('Invalid statistics publication marker');
            }
            return { pending: marker.pending as string[] };
        } catch (error) {
            if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
                return undefined;
            }
            throw error;
        }
    }
}
