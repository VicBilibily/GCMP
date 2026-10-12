import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import { sep } from 'node:path';
import test from 'node:test';
import { finishPendingRelease } from '../../lockRelease';
import { withReclaimGuard } from '../../reclaimGuard';
import { fixture, promises } from './fixture';

for (const code of ['EIO', 'EPERM', 'EACCES', 'EBUSY']) {
    test(`reclaim preserves a failed operation alongside its failed release: ${code}`, async context => {
        const f = await fixture(context),
            rm = promises.rm;
        const primary = new Error('reclaim failed');
        const cleanup = Object.assign(new Error('release failed'), { code });
        let cleanups = 0;
        context.mock.method(promises, 'rm', async (...args: Parameters<typeof rm>) => {
            if (String(args[0]).startsWith(f.guard + sep) && cleanups++ === 0) {
                throw cleanup;
            }
            return rm(...args);
        });
        try {
            await assert.rejects(
                withReclaimGuard(f.guard, async () => {
                    throw primary;
                }),
                (error: unknown) => {
                    assert.ok(error instanceof AggregateError);
                    assert.equal(error.errors.length, 2);
                    assert.equal(error.errors[0], primary);
                    assert.equal(error.errors[1], cleanup);
                    return true;
                }
            );
        } finally {
            await finishPendingRelease(f.guard);
        }
        await assert.rejects(fs.stat(f.guard), { code: 'ENOENT' });
    });
}

for (const phase of ['owner', 'publish-before', 'publish-after', 'publish-after-double']) {
    test(`reclaim initialization keeps primary and nested cleanup errors: ${phase}`, async context => {
        const f = await fixture(context, true),
            writeFile = promises.writeFile,
            rename = promises.rename,
            rm = promises.rm;
        const primary = Object.assign(new Error('publication failed'), { code: 'EIO' });
        const cleanup = Object.assign(new Error('publication cleanup failed'), { code: 'EPERM' });
        const temporaryCleanup = Object.assign(new Error('temporary cleanup failed'), { code: 'EBUSY' });
        let publicFailed = false,
            privateFailed = false;
        context.mock.method(promises, 'writeFile', async (...args: Parameters<typeof writeFile>) => {
            if (phase === 'owner' && String(args[0]).startsWith(f.guard + '.')) {
                throw primary;
            }
            return writeFile(...args);
        });
        context.mock.method(promises, 'rename', async (...args: Parameters<typeof rename>) => {
            if (String(args[1]) === f.guard) {
                if (phase.startsWith('publish-after')) {
                    await rename(...args);
                }
                throw primary;
            }
            return rename(...args);
        });
        context.mock.method(promises, 'rm', async (...args: Parameters<typeof rm>) => {
            const path = String(args[0]);
            if (phase.startsWith('publish-after') && path.startsWith(f.guard + sep) && !publicFailed) {
                publicFailed = true;
                throw cleanup;
            }
            if (path.startsWith(f.guard + '.') && path.endsWith('.tmp') && !privateFailed) {
                privateFailed = true;
                if (!phase.startsWith('publish-after')) {
                    throw cleanup;
                }
                if (phase === 'publish-after-double') {
                    throw temporaryCleanup;
                }
            }
            return rm(...args);
        });
        const flatten = (value: unknown): unknown[] =>
            value instanceof AggregateError ? value.errors.flatMap(flatten) : [value];
        let operations = 0;
        try {
            await assert.rejects(
                withReclaimGuard(f.guard, async () => {
                    operations++;
                    return true;
                }),
                (error: unknown) => {
                    assert.ok(error instanceof AggregateError);
                    const errors = flatten(error);
                    assert.equal(errors[0], primary);
                    assert.equal(errors[1], cleanup);
                    assert.equal(errors.length, phase === 'publish-after-double' ? 3 : 2);
                    if (phase === 'publish-after-double') {
                        assert.equal(errors[2], temporaryCleanup);
                    }
                    return true;
                }
            );
            assert.equal(operations, 0);
            assert.deepEqual(JSON.parse(await fs.readFile(f.path, 'utf8')), { requests: 0 });
        } finally {
            await finishPendingRelease(f.guard);
        }
    });
}

for (const primary of [undefined, null, false, '']) {
    test(`reclaim preserves falsy thrown values when release also fails: ${String(primary)}`, async context => {
        const f = await fixture(context),
            rm = promises.rm;
        const cleanup = Object.assign(new Error('release failed'), { code: 'EIO' });
        let failed = false;
        context.mock.method(promises, 'rm', async (...args: Parameters<typeof rm>) => {
            if (String(args[0]).startsWith(f.guard + sep) && !failed) {
                failed = true;
                throw cleanup;
            }
            return rm(...args);
        });
        try {
            await assert.rejects(
                withReclaimGuard(f.guard, async () => {
                    throw primary;
                }),
                (error: unknown) => {
                    assert.ok(error instanceof AggregateError);
                    assert.equal(error.errors[0], primary);
                    assert.equal(error.errors[1], cleanup);
                    return true;
                }
            );
        } finally {
            await finishPendingRelease(f.guard);
        }
    });
}

for (const phase of ['operation', 'cleanup']) {
    test(`a single reclaim failure keeps the original error identity: ${phase}`, async context => {
        const f = await fixture(context),
            rm = promises.rm;
        const failure = Object.assign(new Error('single error'), { code: 'EIO' });
        let failed = false;
        context.mock.method(promises, 'rm', async (...args: Parameters<typeof rm>) => {
            if (phase === 'cleanup' && String(args[0]).startsWith(f.guard + sep) && !failed) {
                failed = true;
                throw failure;
            }
            return rm(...args);
        });
        try {
            await assert.rejects(
                withReclaimGuard(f.guard, async () => {
                    if (phase === 'operation') {
                        throw failure;
                    }
                    return true;
                }),
                error => error === failure
            );
        } finally {
            await finishPendingRelease(f.guard);
        }
    });
}
