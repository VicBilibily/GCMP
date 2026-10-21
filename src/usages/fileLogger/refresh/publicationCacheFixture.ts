import { createHash } from 'node:crypto';
import * as fs from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { TestContext } from 'node:test';
import { AtomicJsonFile } from '../../atomicJsonFile';
import { StatsCalculator } from '../statsCalculator';
import { StatsPublication } from './statsPublication';

export function publicationStats(requests: number) {
    const stats = StatsCalculator.aggregateLogs([]);
    stats.total.requests = requests;
    return stats;
}

export const fingerprint = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');

export async function publicationFixture(context: TestContext, acknowledgePrevious = false) {
    const dir = await fs.mkdtemp(join(tmpdir(), 'gcmp-publication-cache-'));
    context.after(() => fs.rm(dir, { recursive: true, force: true }));
    const publication = new StatsPublication(),
        statsPath = join(dir, 'stats.json');
    const markerPath = join(dir, 'stats-publication.json'),
        receiptPath = join(dir, 'stats-published.json');
    const save = async (requests: number) => {
        const stats = publicationStats(requests);
        await AtomicJsonFile.runExclusive(statsPath, async () => {
            await AtomicJsonFile.writeJsonAtomically(statsPath, stats);
        });
        return stats;
    };
    await save(1);
    if (acknowledgePrevious) {
        await publication.acknowledge(statsPath, fingerprint(publicationStats(1)), () => true);
    }
    const current = await save(2);
    await publication.acknowledge(statsPath, fingerprint(current), () => true);
    return { dir, publication, statsPath, markerPath, receiptPath, current, save };
}

export function countStatsReads(context: TestContext) {
    const require = createRequire(import.meta.url);
    const promises = require('node:fs/promises') as typeof fs;
    const read = promises.readFile;
    let reads = 0;
    context.mock.method(promises, 'readFile', (async (...args: Parameters<typeof read>) => {
        const result = await read(...args);
        if (String(args[0]).endsWith('stats.json')) {
            reads++;
        }
        return result;
    }) as typeof read);
    return () => reads;
}
