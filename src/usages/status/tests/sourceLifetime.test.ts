import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { createUsageHost } from '../../tests/hostFixture';
import { gate, snapshotFixture, snapshotRow } from '../../tests/snapshotFixture';
import type { TokenUsageStatsFromFile } from '../../fileLogger/types';

interface Calculation {
    calculateDateStats(date: string, force: boolean): Promise<TokenUsageStatsFromFile>;
}

test('statistics source identity survives late completion and same-instance reelection', async t => {
    const host = await createUsageHost();
    t.after(() => host.restore());

    await t.test('old-term forced calculation keeps provenance and cannot overwrite saved statistics', async c => {
        const f = await snapshotFixture(host, c);
        let term = 'leader:1';
        f.internals.logStatsManager.setCanWriteStats(
            () => true,
            () => term
        );
        const internals = f.internals.logStatsManager as unknown as Calculation;
        const calculate = internals.calculateDateStats.bind(internals);
        const entered = gate();
        const release = gate();
        c.mock.method(internals, 'calculateDateStats', async (...args: Parameters<typeof calculate>) => {
            const value = await calculate(...args);
            entered.release();
            await release.promise;
            return value;
        });
        const before = await readFile(f.statsPath, 'utf8');
        const pending = f.internals.logStatsManager.getDateStats(f.date, true);
        await entered.promise;
        term = 'leader:2';
        release.release();
        const old = await pending;
        assert.equal(f.internals.logStatsManager.getResultSource(old)?.authorityTerm, 'leader:1');
        assert.equal(await readFile(f.statsPath, 'utf8'), before);
    });

    await t.test('new-term request queues behind old calculation instead of sharing its result', async c => {
        const f = await snapshotFixture(host, c);
        let term = 'leader:1';
        f.internals.logStatsManager.setCanWriteStats(
            () => true,
            () => term
        );
        const internals = f.internals.logStatsManager as unknown as Calculation;
        const calculate = internals.calculateDateStats.bind(internals);
        const entered = gate();
        const release = gate();
        let first = true;
        c.mock.method(internals, 'calculateDateStats', async (...args: Parameters<typeof calculate>) => {
            const value = await calculate(...args);
            if (first) {
                first = false;
                entered.release();
                await release.promise;
            }
            return value;
        });
        const oldRequest = f.internals.logStatsManager.getDateStats(f.date, true);
        await entered.promise;
        term = 'leader:2';
        await f.internals.snapshotManager.buildSnapshotFromLogs(f.date, [snapshotRow(f.date, 'second')]);
        let finished = false;
        const currentRequest = f.internals.logStatsManager.getDateStats(f.date).then(value => {
            finished = true;
            return value;
        });
        await new Promise<void>(resolve => setImmediate(resolve));
        assert.equal(finished, false);
        release.release();
        const [old, current] = await Promise.all([oldRequest, currentRequest]);
        assert.equal(current.total.requests, 2);
        assert.equal(f.internals.logStatsManager.getResultSource(old)?.authorityTerm, 'leader:1');
        assert.equal(f.internals.logStatsManager.getResultSource(current)?.authorityTerm, 'leader:2');
        assert.ok(
            f.internals.logStatsManager.getResultSource(current)!.revision >
                f.internals.logStatsManager.getResultSource(old)!.revision
        );
        assert.equal((await f.privateStats.loadStats(f.date))?.total.requests, 2);
    });

    await t.test('an unowned calculation cannot borrow later ownership to overwrite a successor', async c => {
        const f = await snapshotFixture(host, c);
        await f.internals.snapshotManager.upsertRecord(f.date, snapshotRow(f.date, 'second', 10));
        host.state.leaderId = 'successor';
        const calculation = f.internals.logStatsManager as unknown as Calculation;
        const original = calculation.calculateDateStats.bind(calculation);
        const entered = gate(),
            release = gate();
        c.mock.method(calculation, 'calculateDateStats', async (...args: Parameters<typeof original>) => {
            const result = await original(...args);
            entered.release();
            await release.promise;
            return result;
        });
        const old = f.internals.logStatsManager.getDateStats(f.date, true);
        const { TokenFileLogger } = await import('../../fileLogger');
        const successor = host.run('successor', () => new TokenFileLogger(f.extensionContext));
        (
            successor as unknown as { logStatsManager: typeof f.internals.logStatsManager }
        ).logStatsManager.updateCodeVersionTimestamp(1);
        try {
            await entered.promise;
            await f.internals.snapshotManager.upsertRecord(f.date, snapshotRow(f.date, 'third', 11));
            assert.equal((await host.run('successor', () => successor.getDateStats(f.date, true))).total.requests, 3);
            host.state.leaderId = 'leader';
            release.release();
            const result = await old;
            assert.equal(f.fileLogger.getStatsSource(result)?.authorityTerm, undefined);
            assert.equal(result.total.requests, 2);
            assert.equal(
                (JSON.parse(await readFile(f.statsPath, 'utf8')) as TokenUsageStatsFromFile).total.requests,
                3
            );
            assert.equal((await f.internals.snapshotManager.read(f.date))?.length, 3);
        } finally {
            release.release();
            await old;
            await successor.dispose();
        }
    });

    await t.test('an initially denied calculation cannot acquire permission without a term change', async c => {
        const f = await snapshotFixture(host, c);
        await f.internals.snapshotManager.upsertRecord(f.date, snapshotRow(f.date, 'second', 10));
        let allowed = false;
        f.internals.logStatsManager.setCanWriteStats(() => allowed);
        const calculation = f.internals.logStatsManager as unknown as Calculation;
        const original = calculation.calculateDateStats.bind(calculation);
        const entered = gate(),
            release = gate();
        c.mock.method(calculation, 'calculateDateStats', async (...args: Parameters<typeof original>) => {
            const result = await original(...args);
            entered.release();
            await release.promise;
            return result;
        });
        const before = await readFile(f.statsPath, 'utf8');
        const pending = f.internals.logStatsManager.getDateStats(f.date, true);
        try {
            await entered.promise;
            allowed = true;
            release.release();
            assert.equal((await pending).total.requests, 2);
            assert.equal(await readFile(f.statsPath, 'utf8'), before);
        } finally {
            release.release();
            await pending;
        }
    });

    await t.test('disposing during initialization prevents late subscriptions and activation', async c => {
        const { TokenFileLogger } = await import('../../fileLogger');
        const { TokenUsagesManager } = await import('../../usagesManager');
        const f = await host.fixture(c);
        const Manager = TokenUsagesManager as unknown as new () => typeof TokenUsagesManager.instance;
        const manager = new Manager();
        const entered = gate();
        const release = gate();
        c.mock.method(TokenFileLogger.prototype, 'initialize', async () => {
            entered.release();
            await release.promise;
        });
        const initialize = manager.initialize(f.extensionContext);
        await entered.promise;
        await manager.dispose();
        release.release();
        await initialize;
        assert.equal((manager as unknown as { initialized: boolean }).initialized, false);
        assert.equal(await manager.getStatusSnapshot(), undefined);
        assert.equal(host.periodic.length, 0);
    });
});
