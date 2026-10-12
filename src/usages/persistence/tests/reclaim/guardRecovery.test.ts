import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { bounded, fixture, gate, promises, write } from './fixture';

for (const phase of ['owner-write', 'publish-before', 'publish-after'] as const) {
    test(`a failed reclaim publication is cleaned without touching the main owner: ${phase}`, async context => {
        const f = await fixture(context, true),
            writeFile = promises.writeFile,
            rename = promises.rename;
        let injected = false;
        context.mock.method(promises, 'writeFile', (async (...args: Parameters<typeof writeFile>) => {
            await writeFile(...args);
            if (phase === 'owner-write' && !injected && String(args[0]).startsWith(`${f.guard}.`)) {
                injected = true;
                throw Object.assign(new Error('injected reclaim publication failure'), { code: 'EIO' });
            }
        }) as typeof writeFile);
        context.mock.method(promises, 'rename', async (...args: Parameters<typeof rename>) => {
            if (phase !== 'owner-write' && !injected && String(args[1]) === f.guard) {
                injected = true;
                if (phase === 'publish-after') {
                    await rename(...args);
                }
                throw Object.assign(new Error('injected reclaim publication failure'), { code: 'EIO' });
            }
            return rename(...args);
        });
        await assert.rejects(write(f.path, 1), /injected reclaim publication/);
        assert.equal(injected, true);
        assert.deepEqual(JSON.parse(await fs.readFile(join(f.lock, 'owner.json'), 'utf8')), f.dead);
        assert.deepEqual((await fs.readdir(f.dir)).sort(), ['stats.json', 'stats.json.commit.lock']);
        await write(f.path, 2);
        assert.deepEqual(JSON.parse(await fs.readFile(f.path, 'utf8')), { requests: 2 });
        assert.deepEqual(await fs.readdir(f.dir), ['stats.json']);
    });
}

for (const phase of ['EBUSY', 'EPERM', 'EACCES', 'partial-owner', 'empty-directory'] as const) {
    test(
        `an ended reclaim guard retries cleanup without another writer: ${phase}`,
        { timeout: 10000 },
        async context => {
            const f = await fixture(context, true),
                cleaned = gate(),
                rm = promises.rm,
                rmdir = promises.rmdir;
            let injected = false;
            context.mock.method(promises, 'rm', async (...args: Parameters<typeof rm>) => {
                if (phase !== 'empty-directory' && !injected && dirname(String(args[0])) === f.guard) {
                    injected = true;
                    if (phase === 'partial-owner') {
                        await rm(...args);
                    }
                    throw Object.assign(new Error('injected reclaim release failure'), {
                        code: phase === 'partial-owner' ? 'EIO' : phase
                    });
                }
                return rm(...args);
            });
            context.mock.method(promises, 'rmdir', async (...args: Parameters<typeof rmdir>) => {
                if (String(args[0]) === f.guard) {
                    if (phase === 'empty-directory' && !injected) {
                        injected = true;
                        throw Object.assign(new Error('injected reclaim release failure'), { code: 'EBUSY' });
                    }
                    await rmdir(...args);
                    cleaned.release();
                    return;
                }
                return rmdir(...args);
            });
            await assert.rejects(write(f.path, 1), /injected reclaim release/);
            assert.equal(injected, true);
            await bounded(cleaned.promise);
            assert.deepEqual(await fs.readdir(f.dir), ['stats.json']);
            await write(f.path, 2);
            assert.deepEqual(JSON.parse(await fs.readFile(f.path, 'utf8')), { requests: 2 });
        }
    );
}
