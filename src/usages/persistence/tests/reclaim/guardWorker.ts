import * as fs from 'node:fs/promises';
import { createRequire } from 'node:module';
import { AtomicJsonFile } from '../../../atomicJsonFile';

const path = process.argv[2],
    parentPid = Number(process.argv[3]);
const holdReclaim = process.argv[4] === 'reclaim';
const promises = createRequire(import.meta.url)('node:fs/promises') as typeof fs;
const rename = promises.rename,
    stat = promises.stat,
    kill = process.kill;
const rm = promises.rm;
let permitted = true,
    observed = false,
    release!: () => void;
const blocked = new Promise<void>(resolve => {
    release = resolve;
});
process.kill = (pid, signal) => {
    const result = kill(pid, signal);
    if (!observed && pid === parentPid) {
        observed = true;
        process.send?.({ kind: 'retained' });
    }
    return result;
};
promises.stat = (async (...args: Parameters<typeof stat>) => {
    const value = await stat(...args);
    if (!observed && String(args[0]) === `${path}.commit.lock.reclaim` && Date.now() - Number(value.mtimeMs) < 60000) {
        observed = true;
        process.send?.({ kind: 'retained' });
    }
    return value;
}) as typeof stat;
promises.rename = async (...args: Parameters<typeof rename>) => {
    if (!holdReclaim && String(args[1]) === path) {
        process.send?.({ kind: 'rename-entered' });
        await blocked;
    }
    return rename(...args);
};
promises.rm = async (...args: Parameters<typeof rm>) => {
    if (holdReclaim && String(args[0]) === `${path}.commit.lock`) {
        process.send?.({ kind: 'guard-held' });
        await blocked;
    }
    return rm(...args);
};
process.on('message', (message: { kind: 'write' | 'revoke' | 'release' }) => {
    if (message.kind === 'revoke') {
        permitted = false;
        process.send?.({ kind: 'revoked' });
    } else if (message.kind === 'release') {
        release();
    } else {
        void AtomicJsonFile.writeJsonAtomically(path, { requests: 1 }, undefined, () => permitted).then(
            () => {
                process.send?.({ kind: 'finished', error: null });
                process.disconnect();
            },
            (error: unknown) => {
                process.send?.({ kind: 'finished', error: String(error) });
                process.disconnect();
            }
        );
    }
});
process.send?.({ kind: 'ready' });
