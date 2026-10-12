import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import { sep } from 'node:path';
import test from 'node:test';
import { finishPendingRelease } from '../../lockRelease';
import { fixture, promises, record, seedOwner } from './fixture';

for (const primaryCode of ['EIO', 'EINVAL', 'ENOSPC', 'EPERM', 'EACCES', 'EBUSY']) {
    for (const cleanupCode of ['EIO', 'EPERM', 'EACCES', 'EBUSY']) {
        test(`snapshot keeps both reclaim errors and only retries transient pairs: ${primaryCode}/${cleanupCode}`, async context => {
            const f = await fixture(context);
            await seedOwner(f);
            const readFile = promises.readFile,
                rm = promises.rm,
                rename = promises.rename;
            const primary = Object.assign(new Error('owner read failed'), { code: primaryCode });
            const cleanup = Object.assign(new Error('reclaim release failed'), { code: cleanupCode });
            let readFailures = 0,
                cleanupFailures = 0,
                writes = 0;
            context.mock.method(promises, 'readFile', (async (...args: Parameters<typeof readFile>) => {
                if (String(args[0]) === f.ownerPath && readFailures === 0) {
                    readFailures++;
                    throw primary;
                }
                return readFile(...args);
            }) as typeof readFile);
            context.mock.method(promises, 'rm', async (...args: Parameters<typeof rm>) => {
                if (String(args[0]).startsWith(f.guard + sep) && cleanupFailures === 0) {
                    cleanupFailures++;
                    throw cleanup;
                }
                return rm(...args);
            });
            context.mock.method(promises, 'rename', async (...args: Parameters<typeof rename>) => {
                await rename(...args);
                if (String(args[1]) === f.path) {
                    writes++;
                }
            });
            const retryable = [primaryCode, cleanupCode].every(code => ['EPERM', 'EACCES', 'EBUSY'].includes(code));
            try {
                const writing = f.snapshot.upsertRecord(f.date, record('added'));
                if (retryable) {
                    await writing;
                    assert.equal(writes, 1);
                    assert.deepEqual(await f.ids(), ['added', 'base']);
                } else {
                    await assert.rejects(writing, (error: unknown) => {
                        assert.ok(error instanceof AggregateError);
                        assert.equal(error.errors.length, 2);
                        assert.equal(error.errors[0], primary);
                        assert.equal(error.errors[1], cleanup);
                        return true;
                    });
                    assert.equal(writes, 0);
                    assert.deepEqual(await f.ids(), ['base']);
                }
                assert.equal(readFailures, 1);
                assert.equal(cleanupFailures, 1);
            } finally {
                await finishPendingRelease(f.guard);
            }
            await assert.rejects(fs.stat(f.guard), { code: 'ENOENT' });
        });
    }
}

for (const phase of ['before', 'after'] as const) {
    for (const code of ['EIO', 'EPERM']) {
        test(`snapshot initialization preserves its error and a fatal release error: ${phase}/${code}`, async context => {
            const f = await fixture(context),
                writeFile = promises.writeFile,
                rm = promises.rm,
                rmdir = promises.rmdir,
                rename = promises.rename;
            const primary = Object.assign(new Error('owner initialization failed'), { code });
            const cleanup = Object.assign(new Error('initialization release failed'), { code: 'EIO' });
            let primaryThrown = false,
                cleanupThrown = false,
                writes = 0;
            context.mock.method(promises, 'writeFile', async (...args: Parameters<typeof writeFile>) => {
                if (String(args[0]) === f.ownerPath && !primaryThrown) {
                    primaryThrown = true;
                    if (phase === 'after') {
                        await writeFile(...args);
                    }
                    throw primary;
                }
                return writeFile(...args);
            });
            context.mock.method(promises, 'rm', async (...args: Parameters<typeof rm>) => {
                if (phase === 'after' && String(args[0]) === f.lock && !cleanupThrown) {
                    cleanupThrown = true;
                    throw cleanup;
                }
                return rm(...args);
            });
            context.mock.method(promises, 'rmdir', async (...args: Parameters<typeof rmdir>) => {
                if (phase === 'before' && String(args[0]) === f.lock && !cleanupThrown) {
                    cleanupThrown = true;
                    throw cleanup;
                }
                return rmdir(...args);
            });
            context.mock.method(promises, 'rename', async (...args: Parameters<typeof rename>) => {
                await rename(...args);
                if (String(args[1]) === f.path) {
                    writes++;
                }
            });
            try {
                await assert.rejects(f.snapshot.upsertRecord(f.date, record('blocked')), (error: unknown) => {
                    assert.ok(error instanceof AggregateError);
                    assert.equal(error.errors[0], primary);
                    assert.equal(error.errors[1], cleanup);
                    return true;
                });
                assert.equal(primaryThrown, true);
                assert.equal(cleanupThrown, true);
                assert.equal(writes, 0);
                assert.deepEqual(await f.ids(), ['base']);
            } finally {
                await finishPendingRelease(f.lock);
            }
            await assert.rejects(fs.stat(f.lock), { code: 'ENOENT' });
        });
    }
}

test('snapshot business and fatal release errors both survive without replaying the operation', async context => {
    const f = await fixture(context),
        rm = promises.rm;
    const primary = new Error('snapshot business failed');
    const cleanup = Object.assign(new Error('snapshot release failed'), { code: 'EIO' });
    const internal = f.snapshot as unknown as { writeSnapshotStoreLocked: () => Promise<void> };
    let bodies = 0,
        cleanupThrown = false;
    context.mock.method(internal, 'writeSnapshotStoreLocked', async () => {
        bodies++;
        throw primary;
    });
    context.mock.method(promises, 'rm', async (...args: Parameters<typeof rm>) => {
        if (String(args[0]) === f.lock && !cleanupThrown) {
            cleanupThrown = true;
            throw cleanup;
        }
        return rm(...args);
    });
    try {
        await assert.rejects(f.snapshot.upsertRecord(f.date, record('blocked')), (error: unknown) => {
            assert.ok(error instanceof AggregateError);
            assert.equal(error.errors[0], primary);
            assert.equal(error.errors[1], cleanup);
            return true;
        });
        assert.equal(bodies, 1);
        assert.equal(cleanupThrown, true);
        assert.deepEqual(await f.ids(), ['base']);
    } finally {
        await finishPendingRelease(f.lock);
    }
});

for (const fatal of ['none', 'publish', 'public-cleanup', 'temporary-cleanup']) {
    test(`nested publication cleanup only retries when every error is transient: ${fatal}`, async context => {
        const f = await fixture(context),
            rename = promises.rename,
            rm = promises.rm;
        await seedOwner(f);
        const primary = Object.assign(new Error('published then failed'), {
            code: fatal === 'publish' ? 'EIO' : 'EPERM'
        });
        const cleanup = Object.assign(new Error('public cleanup failed'), {
            code: fatal === 'public-cleanup' ? 'EIO' : 'EACCES'
        });
        const temporary = Object.assign(new Error('temporary cleanup failed'), {
            code: fatal === 'temporary-cleanup' ? 'EIO' : 'EBUSY'
        });
        let publicationFailed = false,
            publicFailed = false,
            temporaryFailed = false,
            writes = 0;
        context.mock.method(promises, 'rename', async (...args: Parameters<typeof rename>) => {
            await rename(...args);
            if (String(args[1]) === f.guard && !publicationFailed) {
                publicationFailed = true;
                throw primary;
            }
            if (String(args[1]) === f.path) {
                writes++;
            }
        });
        context.mock.method(promises, 'rm', async (...args: Parameters<typeof rm>) => {
            const path = String(args[0]);
            if (path.startsWith(f.guard + sep) && !publicFailed) {
                publicFailed = true;
                throw cleanup;
            }
            if (path.startsWith(f.guard + '.') && path.endsWith('.tmp') && !temporaryFailed) {
                temporaryFailed = true;
                throw temporary;
            }
            return rm(...args);
        });
        const flatten = (error: unknown): unknown[] =>
            error instanceof AggregateError ? error.errors.flatMap(flatten) : [error];
        try {
            const writing = f.snapshot.upsertRecord(f.date, record('added'));
            if (fatal === 'none') {
                await writing;
                assert.equal(writes, 1);
                assert.deepEqual(await f.ids(), ['added', 'base']);
            } else {
                await assert.rejects(writing, (error: unknown) => {
                    const errors = flatten(error);
                    assert.equal(errors.length, 3);
                    assert.equal(errors[0], primary);
                    assert.equal(errors[1], cleanup);
                    assert.equal(errors[2], temporary);
                    return true;
                });
                assert.equal(writes, 0);
                assert.deepEqual(await f.ids(), ['base']);
            }
            assert.equal(publicationFailed && publicFailed && temporaryFailed, true);
        } finally {
            await finishPendingRelease(f.guard);
        }
    });
}
