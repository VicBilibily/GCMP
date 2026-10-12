import { join } from 'node:path';
import type { SnapshotFile } from '../../../fileLogger/snapshotMerge';
import { loadSnapshot, promises, record } from './fixture';

async function main(): Promise<void> {
    const [dir, date] = process.argv.slice(2);
    const modules = await loadSnapshot();
    const paths = new modules.LogPathManager(dir);
    const snapshot = new modules.SnapshotManager(paths, () => {});
    const lock = join(paths.getDateFolderPath(date), '.requests.lock');
    const mkdir = promises.mkdir;
    let attempts = 0;
    promises.mkdir = (async (...args: Parameters<typeof mkdir>) => {
        if (String(args[0]) === lock && ++attempts === 2) {
            process.send?.({ type: 'waiting' });
        }
        return mkdir(...args);
    }) as typeof mkdir;
    const internal = snapshot as unknown as {
        mergeWithLatestSnapshot: (date: string, store: SnapshotFile) => Promise<SnapshotFile>;
    };
    const merge = internal.mergeWithLatestSnapshot.bind(snapshot);
    internal.mergeWithLatestSnapshot = async (...args) => {
        const value = await merge(...args);
        process.send?.({ type: 'merged', ids: Object.keys(value).sort() });
        return value;
    };
    try {
        await snapshot.upsertRecord(date, record('child'));
        process.send?.({ type: 'done' });
    } finally {
        promises.mkdir = mkdir;
        modules.restore();
    }
}
void main().then(
    () => {
        process.disconnect?.();
    },
    error => {
        console.error(error);
        process.exitCode = 1;
        process.disconnect?.();
    }
);
