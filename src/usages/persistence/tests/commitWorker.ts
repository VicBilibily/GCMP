import { createRequire } from 'node:module';
import * as fs from 'node:fs/promises';
import { AtomicJsonFile } from '../../atomicJsonFile';

const promises = createRequire(import.meta.url)('node:fs/promises') as typeof fs;
process.once('message', (message: { path: string }) => {
    const original = promises.writeFile;
    promises.writeFile = (async (...args: Parameters<typeof original>) => {
        await original(...args);
        if (String(args[0]).startsWith(`${message.path}.`) && String(args[0]).endsWith('.tmp')) {
            process.send?.({ kind: 'prepared' });
        }
    }) as typeof original;
    const write = AtomicJsonFile.writeJsonAtomically as (
        path: string,
        value: unknown,
        serializer: undefined,
        canWrite: () => boolean
    ) => Promise<void>;
    void write
        .call(AtomicJsonFile, message.path, { requests: 2 }, undefined, () => true)
        .then(
            () => {
                process.send?.({ kind: 'done' }, undefined, undefined, () => process.disconnect());
            },
            (error: unknown) => {
                console.error(error);
                process.exitCode = 1;
                process.disconnect();
            }
        );
});
process.send?.({ kind: 'ready' });
