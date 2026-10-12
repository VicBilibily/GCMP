import assert from 'node:assert/strict';
import type { ChildProcess } from 'node:child_process';
import test from 'node:test';
import { releaseChild } from './fixture';

for (const state of ['absent', 'disconnected']) {
    test(`reclaim child cleanup does not send on an ${state} child`, async () => {
        let sends = 0;
        const child = {
            connected: false,
            send: () => {
                sends++;
                return true;
            }
        };
        await releaseChild(state === 'absent' ? undefined : child);
        assert.equal(sends, 0);
    });
}

for (const code of [undefined, 'EPIPE', 'ERR_IPC_CHANNEL_CLOSED']) {
    test(`reclaim child cleanup settles through its send callback: ${code ?? 'success'}`, async () => {
        let complete: ((error: Error | null) => void) | undefined;
        const child = {
            connected: true,
            send: ((...args: unknown[]) => {
                assert.deepEqual(args[0], { kind: 'release' });
                assert.equal(typeof args[1], 'function');
                complete = args[1] as (error: Error | null) => void;
                return false;
            }) as ChildProcess['send']
        };
        let settled = false;
        const pending = releaseChild(child).then(() => {
            settled = true;
        });
        await Promise.resolve();
        assert.equal(settled, false);
        assert.ok(complete);
        complete(code ? Object.assign(new Error('channel ended'), { code }) : null);
        await pending;
        assert.equal(settled, true);
    });
}

for (const code of [undefined, 'EIO', 'ERR_IPC_DISCONNECTED']) {
    test(`reclaim child cleanup preserves unexpected send errors: ${code ?? 'no code'}`, async () => {
        const failure = Object.assign(new Error('unexpected send failure'), { code });
        const child = {
            connected: true,
            send: ((...args: unknown[]) => {
                assert.equal(typeof args[1], 'function');
                const complete = args[1] as (error: Error | null) => void;
                queueMicrotask(() => complete(failure));
                return false;
            }) as ChildProcess['send']
        };
        await assert.rejects(releaseChild(child), error => error === failure);
    });
}
