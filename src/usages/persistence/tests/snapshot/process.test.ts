import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import type { SnapshotFile } from '../../../fileLogger/snapshotMerge';
import { bounded, fixture, gate, record } from './fixture';

test(
    'a real second process cannot merge before the first snapshot read-merge-write finishes',
    { timeout: 20000 },
    async context => {
        const f = await fixture(context),
            reached = gate(),
            resume = gate(),
            waiting = gate();
        const internal = f.snapshot as unknown as {
            mergeWithLatestSnapshot: (date: string, store: SnapshotFile) => Promise<SnapshotFile>;
        };
        const original = internal.mergeWithLatestSnapshot.bind(f.snapshot);
        context.mock.method(internal, 'mergeWithLatestSnapshot', async (...args: Parameters<typeof original>) => {
            const value = await original(...args);
            reached.release();
            await resume.promise;
            return value;
        });
        const first = f.snapshot.upsertRecord(f.date, record('main'));
        void first.catch(() => undefined);
        await bounded(reached.promise);
        const child = spawn(
            process.execPath,
            ['--import=tsx', fileURLToPath(new URL('./worker.ts', import.meta.url)), f.dir, f.date],
            {
                stdio: ['ignore', 'pipe', 'pipe', 'ipc']
            }
        );
        let stderr = '',
            merged: string[] | undefined,
            done = false;
        assert.ok(child.stderr);
        child.stderr.on('data', data => {
            stderr += String(data);
        });
        child.on('message', (message: unknown) => {
            if (!message || typeof message !== 'object' || !('type' in message)) {
                return;
            }
            if (message.type === 'waiting') {
                waiting.release();
            }
            if (message.type === 'done') {
                done = true;
            }
            if (message.type === 'merged' && 'ids' in message && Array.isArray(message.ids)) {
                merged = message.ids.filter((value): value is string => typeof value === 'string');
            }
        });
        const exited = new Promise<number | null>((resolve, reject) => {
            child.once('exit', resolve);
            child.once('error', reject);
        });
        void exited.catch(() => undefined);
        try {
            await bounded(waiting.promise);
            assert.equal(merged, undefined);
            assert.equal(done, false);
            resume.release();
            await bounded(first);
            assert.equal(await bounded(exited), 0, stderr);
            assert.equal(done, true);
            assert.deepEqual(merged, ['base', 'child', 'main']);
            assert.deepEqual(await f.ids(), ['base', 'child', 'main']);
        } finally {
            resume.release();
            await first.catch(() => undefined);
            if (child.exitCode === null) {
                child.kill();
            }
            await bounded(exited).catch(() => undefined);
        }
    }
);
