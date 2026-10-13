import assert from 'node:assert/strict';
import test from 'node:test';
import { createUsageHost } from '../hostFixture';
import { initializeLogger } from './fixture';

test('initialization readiness propagates background cleanup failure instead of waiting for success', async c => {
    const host = await createUsageHost();
    try {
        const f = await host.fixture(c);
        const failure = new Error('Injected startup cleanup failure');
        c.mock.method(f.internals.snapshotManager, 'compactHistoricalDates', async () => {
            throw failure;
        });
        let timer: ReturnType<typeof setTimeout> | undefined;
        try {
            await assert.rejects(
                Promise.race([
                    initializeLogger(host, c, f.fileLogger),
                    new Promise<never>((_, reject) => {
                        timer = setTimeout(() => reject(new Error('Initialization readiness did not settle')), 1000);
                    })
                ]),
                error => error === failure
            );
        } finally {
            clearTimeout(timer);
        }
    } finally {
        host.restore();
    }
});
