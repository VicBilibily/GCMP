import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { AtomicJsonFile } from '../../atomicJsonFile';

const write = AtomicJsonFile.writeJsonAtomically as (
    path: string,
    value: unknown,
    serializer?: (value: unknown) => string,
    canWrite?: () => boolean
) => Promise<void>;
const promises = createRequire(import.meta.url)('node:fs/promises') as typeof fs;

for (const phase of ['entry', 'temporary-file', 'rename-retry'] as const) {
    test(`guarded atomic writes reject lost permission at ${phase}`, async context => {
        const dir = await fs.mkdtemp(join(tmpdir(), 'gcmp-atomic-permission-'));
        context.after(() => fs.rm(dir, { recursive: true, force: true }));
        const path = join(dir, 'stats.json');
        await fs.writeFile(path, JSON.stringify({ requests: 2 }));
        let permitted = phase !== 'entry';
        if (phase === 'temporary-file') {
            const original = promises.writeFile;
            context.mock.method(promises, 'writeFile', (async (...args: Parameters<typeof original>) => {
                await original(...args);
                if (String(args[0]).startsWith(`${path}.`) && String(args[0]).endsWith('.tmp')) {
                    permitted = false;
                }
            }) as typeof original);
        }
        if (phase === 'rename-retry') {
            const original = promises.rename;
            let first = true;
            context.mock.method(promises, 'rename', async (...args: Parameters<typeof original>) => {
                if (String(args[1]) === path && first) {
                    first = false;
                    permitted = false;
                    throw Object.assign(new Error('busy destination'), { code: 'EBUSY' });
                }
                return original(...args);
            });
        }
        await assert.rejects(
            write.call(AtomicJsonFile, path, { requests: 1 }, undefined, () => permitted),
            /write permission expired/i
        );
        assert.deepEqual(JSON.parse(await fs.readFile(path, 'utf8')), { requests: 2 });
        assert.deepEqual(await fs.readdir(dir), ['stats.json']);
    });
}

test('guarded writes retain their serializer and ordinary writes remain compatible', async context => {
    const dir = await fs.mkdtemp(join(tmpdir(), 'gcmp-atomic-control-'));
    context.after(() => fs.rm(dir, { recursive: true, force: true }));
    const path = join(dir, 'stats.json');
    await write.call(
        AtomicJsonFile,
        path,
        { requests: 1 },
        value => JSON.stringify(value),
        () => true
    );
    assert.equal(await fs.readFile(path, 'utf8'), '{"requests":1}');
    await AtomicJsonFile.writeJsonAtomically(path, { requests: 2 });
    assert.deepEqual(JSON.parse(await fs.readFile(path, 'utf8')), { requests: 2 });
    assert.deepEqual(await fs.readdir(dir), ['stats.json']);
});

test('guard exceptions clean temporary files without changing saved statistics', async context => {
    const dir = await fs.mkdtemp(join(tmpdir(), 'gcmp-atomic-error-'));
    context.after(() => fs.rm(dir, { recursive: true, force: true }));
    const path = join(dir, 'stats.json');
    await fs.writeFile(path, '{"requests":2}');
    const original = promises.writeFile;
    let prepared = false;
    context.mock.method(promises, 'writeFile', (async (...args: Parameters<typeof original>) => {
        await original(...args);
        if (String(args[0]).startsWith(`${path}.`) && String(args[0]).endsWith('.tmp')) {
            prepared = true;
        }
    }) as typeof original);
    await assert.rejects(
        write.call(AtomicJsonFile, path, { requests: 1 }, undefined, () => {
            if (prepared) {
                throw new Error('authority unavailable');
            }
            return true;
        }),
        /authority unavailable/
    );
    assert.equal(await fs.readFile(path, 'utf8'), '{"requests":2}');
    assert.deepEqual(await fs.readdir(dir), ['stats.json']);
});
