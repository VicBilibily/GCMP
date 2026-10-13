import assert from 'node:assert/strict';
import test from 'node:test';
import { AtomicJsonFile } from '../../atomicJsonFile';
import { createUsageHost } from '../hostFixture';
import { snapshotFixture } from '../snapshotFixture';
import { rebuildWithLateWrite } from './fixture';

test('recovery phase waits observe completion, failure and cancellation and restore their mocks', async suite => {
    const host = await createUsageHost();
    try {
        for (const phase of ['snapshot-read', 'stats-write'] as const) {
            for (const outcome of ['completed', 'failed', 'cancelled'] as const) {
                await suite.test(`${phase}/${outcome}`, async context => {
                    const f = await snapshotFixture(host, context);
                    const saved = await f.fileLogger.getDateStats(f.date);
                    const failure = new Error(`Injected recovery ${outcome}`);
                    const controller = new AbortController();
                    const waitingContext = new Proxy(context, {
                        get(target, property) {
                            return property === 'signal' ? controller.signal : Reflect.get(target, property, target);
                        }
                    });
                    const originalRead = f.internals.snapshotManager.read;
                    const originalWrite = AtomicJsonFile.writeJsonAtomically;
                    context.mock.method(f.fileLogger, 'getDateStats', () => {
                        if (outcome === 'cancelled') {
                            controller.abort(failure);
                        }
                        const reading = outcome === 'failed' ? Promise.reject(failure) : Promise.resolve(saved);
                        void reading.catch(() => {});
                        return reading;
                    });
                    let timer: ReturnType<typeof setTimeout> | undefined;
                    try {
                        await assert.rejects(
                            Promise.race([
                                rebuildWithLateWrite(f, waitingContext, 'snapshot', phase),
                                new Promise<never>((_, reject) => {
                                    timer = setTimeout(
                                        () => reject(new Error('Recovery phase wait did not settle')),
                                        1000
                                    );
                                })
                            ]),
                            error =>
                                outcome === 'completed' ?
                                    error instanceof Error && error.message.includes(`did not enter ${phase}`)
                                :   error === failure
                        );
                        assert.equal(f.internals.snapshotManager.read, originalRead);
                        assert.equal(AtomicJsonFile.writeJsonAtomically, originalWrite);
                    } finally {
                        clearTimeout(timer);
                    }
                });
            }
        }
    } finally {
        host.restore();
    }
});
