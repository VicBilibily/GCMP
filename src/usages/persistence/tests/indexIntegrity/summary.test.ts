import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import test from 'node:test';
import { createUsageHost } from '../../../tests/hostFixture';
import { snapshotFixture } from '../../../tests/snapshotFixture';

test('index reconciliation validates numeric summaries without requiring provider details', async suite => {
    const host = await createUsageHost();
    const { LogIndexManager } = await import('../../../fileLogger/logIndexManager');
    try {
        for (const [field, value] of [
            ['requests', 'broken'],
            ['requests', -1],
            ['requests', 0.5],
            ['actualInput', null],
            ['cacheTokens', -1],
            ['outputTokens', '5'],
            ['estimatedCost', '0'],
            ['estimatedCostRmb', null],
            ['nativeCosts', { totalUsd: -1, totalRmb: 0 }]
        ] as const) {
            await suite.test(`${field}=${JSON.stringify(value)} cannot replace a valid index`, async c => {
                const f = await snapshotFixture(host, c);
                const manager = new LogIndexManager(f.dir);
                const indexBefore = await readFile(manager.getIndexPath(), 'utf8');
                const saved = JSON.parse(await readFile(f.statsPath, 'utf8')) as { total: Record<string, unknown> };
                saved.total[field] = value;
                await writeFile(f.statsPath, JSON.stringify(saved));
                await assert.rejects(manager.getIndex(), /Invalid date stats/);
                assert.equal(await readFile(manager.getIndexPath(), 'utf8'), indexBefore);
            });
        }
        await suite.test('total-only legacy costs default to zero without coercing invalid values', async c => {
            const f = await snapshotFixture(host, c);
            const manager = new LogIndexManager(f.dir);
            await writeFile(
                f.statsPath,
                JSON.stringify({ total: { actualInput: 10, cacheTokens: 0, outputTokens: 5, requests: 1 } })
            );
            const index = await manager.getIndex();
            assert.equal(index[f.date].total_requests, 1);
            assert.equal(index[f.date].total_cost, 0);
            assert.equal((await manager.getIndexFast())[f.date].total_cost, 0);
        });
    } finally {
        host.restore();
    }
});

test('fast index reads repair invalid numeric summaries from saved statistics', async suite => {
    const host = await createUsageHost();
    const { LogIndexManager } = await import('../../../fileLogger/logIndexManager');
    try {
        for (const [field, value] of [
            ['total_requests', -1],
            ['total_requests', 0.5],
            ['total_input', -1],
            ['total_cache', -1],
            ['total_output', -1],
            ['total_cost', -1],
            ['total_cost_rmb', -1],
            ['native_total_cost', -1],
            ['native_total_cost_rmb', -1]
        ] as const) {
            await suite.test(`${field}=${value} cannot be returned as a valid index`, async c => {
                const f = await snapshotFixture(host, c);
                const manager = new LogIndexManager(f.dir);
                const index = JSON.parse(await readFile(manager.getIndexPath(), 'utf8')) as {
                    dates: Record<string, Record<string, unknown>>;
                };
                index.dates[f.date][field] = value;
                await writeFile(manager.getIndexPath(), JSON.stringify(index));
                const result = await manager.getIndexFast();
                assert.equal(result[f.date].total_requests, 1);
                assert.ok((result[f.date][field] ?? 0) >= 0);
            });
        }
    } finally {
        host.restore();
    }
});
