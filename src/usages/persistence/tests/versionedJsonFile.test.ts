import assert from 'node:assert/strict';
import { mkdtemp, readFile, rename, rm, stat, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import { VersionedJsonFile } from '../versionedJsonFile';

interface Value {
    count: number;
    nested: { value: number };
}
const gate = () => {
    let release!: () => void;
    const promise = new Promise<void>(resolve => {
        release = resolve;
    });
    return { promise, release };
};
async function fixture(t: TestContext, maxEntries = 32, maxBytes = 8 * 1024 * 1024) {
    const dir = await mkdtemp(join(tmpdir(), 'gcmp-json-cache-'));
    t.after(() => rm(dir, { recursive: true, force: true }));
    const path = join(dir, 'stats.json');
    const json = (count: number) => JSON.stringify({ count, nested: { value: count } });
    await writeFile(path, json(1));
    let reads = 0;
    const reader = new VersionedJsonFile<Value>(
        value => {
            const result = value as Value;
            assert.equal(typeof result.count, 'number');
            return result;
        },
        maxEntries,
        maxBytes
    );
    const read = async () => {
        reads++;
        return readFile(path, 'utf8');
    };
    return {
        dir,
        path,
        reader,
        read,
        json,
        get reads() {
            return reads;
        }
    };
}

test('stable sequential and concurrent JSON reads reuse one body without sharing mutable values', async t => {
    const f = await fixture(t);
    const values = await Promise.all(Array.from({ length: 20 }, () => f.reader.read(f.path, f.read)));
    assert.equal(f.reads, 1);
    values[0].value.nested.value = 99;
    assert.equal(values[1].value.nested.value, 1);
    assert.equal((await f.reader.read(f.path, f.read)).value.nested.value, 1);
    assert.equal(f.reads, 1);
});

test('atomic replacement with restored mtime and equal size invalidates parsed JSON', async t => {
    const f = await fixture(t);
    await f.reader.read(f.path, f.read);
    const old = await stat(f.path);
    const replacement = join(f.dir, 'replacement');
    await writeFile(replacement, f.json(2));
    await utimes(replacement, old.atime, old.mtime);
    await rename(replacement, f.path);
    assert.equal((await f.reader.read(f.path, f.read)).value.count, 2);
    assert.equal(f.reads, 2);
});

test('JSON replacement during read is retried and cannot fill cache with old data', async t => {
    const f = await fixture(t);
    const entered = gate();
    const release = gate();
    let first = true;
    const pending = f.reader.read(f.path, async () => {
        const text = await f.read();
        if (first) {
            first = false;
            entered.release();
            await release.promise;
        }
        return text;
    });
    await entered.promise;
    await writeFile(join(f.dir, 'new'), f.json(2));
    await rename(join(f.dir, 'new'), f.path);
    release.release();
    assert.equal((await pending).value.count, 2);
    assert.equal((await f.reader.read(f.path, f.read)).value.count, 2);
    assert.equal(f.reads, 2);
});

test('explicit invalidation rejects late cache refill', async t => {
    const f = await fixture(t);
    const entered = gate();
    const release = gate();
    const pending = f.reader.read(f.path, async () => {
        const text = await f.read();
        entered.release();
        await release.promise;
        return text;
    });
    await entered.promise;
    f.reader.invalidate(f.path);
    release.release();
    await pending;
    await f.reader.read(f.path, f.read);
    assert.equal(f.reads, 2);
});

test('read failures and missing files are not cached', async t => {
    const f = await fixture(t);
    await assert.rejects(
        f.reader.read(f.path, () => Promise.reject(new Error('EACCES'))),
        /EACCES/
    );
    assert.equal((await f.reader.read(f.path, f.read)).value.count, 1);
    await rm(f.path);
    await assert.rejects(f.reader.read(f.path, f.read), { code: 'ENOENT' });
    await writeFile(f.path, f.json(2));
    assert.equal((await f.reader.read(f.path, f.read)).value.count, 2);
});

test('invalidating one file preserves another file in-flight cache fill', async t => {
    const f = await fixture(t);
    const other = join(f.dir, 'other.json');
    await writeFile(other, f.json(2));
    await f.reader.read(other);
    const entered = gate();
    const release = gate();
    const pending = f.reader.read(f.path, async () => {
        const text = await f.read();
        entered.release();
        await release.promise;
        return text;
    });
    await entered.promise;
    f.reader.invalidate(other);
    release.release();
    await pending;
    await f.reader.read(f.path, f.read);
    assert.equal(f.reads, 1);
});

test('invalid JSON is not cached and repaired content is read normally', async t => {
    const f = await fixture(t);
    await writeFile(f.path, '{');
    await assert.rejects(f.reader.read(f.path, f.read), SyntaxError);
    await writeFile(f.path, f.json(3));
    assert.equal((await f.reader.read(f.path, f.read)).value.count, 3);
});

test('JSON cache eviction enforces entry and byte budgets', async t => {
    const f = await fixture(t, 1);
    await f.reader.read(f.path, f.read);
    const second = join(f.dir, 'index.json');
    await writeFile(second, f.json(2));
    await f.reader.read(second);
    await f.reader.read(f.path, f.read);
    assert.equal(f.reads, 2);
    const small = await fixture(t, 32, 1);
    await small.reader.read(small.path, small.read);
    await small.reader.read(small.path, small.read);
    assert.equal(small.reads, 2);
});
