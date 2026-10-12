import * as fs from 'node:fs/promises';
import { createRequire } from 'node:module';
import { AtomicJsonFile } from '../../atomicJsonFile';

const path = process.argv[2],
    intercept = process.argv[3] === 'reclaim';
const promises = createRequire(import.meta.url)('node:fs/promises') as typeof fs;
let release!: () => void,
    intercepted = false;
const waiting = new Promise<void>(resolve => {
    release = resolve;
});
async function remove(operation: () => Promise<void>, target: string): Promise<void> {
    const selected = intercept && !intercepted && target === `${path}.commit.lock`;
    if (selected) {
        intercepted = true;
        process.send?.({ kind: 'reclaiming' });
        await waiting;
    }
    try {
        await operation();
        if (selected) {
            process.send?.({ kind: 'removed' });
        }
    } catch (error) {
        if (selected && ['ENOTEMPTY', 'EEXIST'].includes((error as NodeJS.ErrnoException).code ?? '')) {
            process.send?.({ kind: 'retained' });
        }
        throw error;
    }
}
if (intercept) {
    const rm = promises.rm,
        rmdir = promises.rmdir;
    promises.rm = (...args: Parameters<typeof rm>) => remove(() => rm(...args), String(args[0]));
    promises.rmdir = (...args: Parameters<typeof rmdir>) => remove(() => rmdir(...args), String(args[0]));
}
process.on('message', (message: { kind: string }) => {
    if (message.kind === 'release') {
        release();
    }
    if (message.kind !== 'write') {
        return;
    }
    void AtomicJsonFile.writeJsonAtomically(path, { requests: 2 }, undefined, () => true).then(
        () => {
            process.send?.({ kind: 'done' });
            process.disconnect();
        },
        (error: unknown) => {
            console.error(error);
            process.exitCode = 1;
            process.disconnect();
        }
    );
});
process.send?.({ kind: 'ready' });
