import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';
import type { DateIndex, TokenUsageStatsFromFile } from '../../../fileLogger/types';
import { createUsageHost, type LoggerInternals } from '../../../tests/hostFixture';
import { snapshotFixture, snapshotRow, gate } from '../../../tests/snapshotFixture';

interface Calculation {
    calculateDateStats(date: string, force: boolean): Promise<TokenUsageStatsFromFile>;
}

test('initially allowed no-owner writes cannot regain stale permission after an authority ABA', async suite => {
    const host = await createUsageHost();
    try {
        const { TokenFileLogger } = await import('../../../fileLogger');
        for (const returnsUnowned of [false, true]) {
            await suite.test(`successor releases authority=${returnsUnowned}`, async c => {
                const f = await snapshotFixture(host, c);
                await f.internals.snapshotManager.upsertRecord(f.date, snapshotRow(f.date, 'second', 10));
                host.state.leaderId = undefined;
                const calculation = f.internals.logStatsManager as unknown as Calculation;
                const original = calculation.calculateDateStats.bind(calculation);
                const entered = gate();
                const release = gate();
                const blocked = c.mock.method(
                    calculation,
                    'calculateDateStats',
                    async (...args: Parameters<typeof original>) => {
                        const result = await original(...args);
                        assert.equal(result.total.requests, 2);
                        entered.release();
                        await release.promise;
                        return result;
                    }
                );
                const old = f.fileLogger.getDateStats(f.date, true);
                const successor = host.run('successor', () => new TokenFileLogger(f.extensionContext));
                const internals = successor as unknown as LoggerInternals;
                internals.logStatsManager.updateCodeVersionTimestamp(1);
                try {
                    await entered.promise;
                    host.state.leaderId = 'successor';
                    await f.internals.snapshotManager.upsertRecord(f.date, snapshotRow(f.date, 'third', 11));
                    const current = await host.run('successor', () => successor.getDateStats(f.date, true));
                    assert.equal(current.total.requests, 3);
                    await host.run('successor', () => internals.logStatsManager.markStatsPublished(f.date, current));
                    assert.equal(
                        (JSON.parse(await readFile(f.statsPath, 'utf8')) as TokenUsageStatsFromFile).total.requests,
                        3
                    );
                    assert.equal(
                        (JSON.parse(await readFile(join(f.dir, 'usages', 'index.json'), 'utf8')) as DateIndex).dates[
                            f.date
                        ].total_requests,
                        3
                    );
                    await successor.dispose();
                    if (returnsUnowned) {
                        host.state.leaderId = undefined;
                    }
                    release.release();
                    const result = await old;
                    assert.equal(result.total.requests, 2);
                    assert.equal(f.fileLogger.getStatsSource(result)?.authorityTerm, undefined);
                    assert.equal(f.fileLogger.getStatsSource(result)?.stale, true);
                    assert.equal(await f.internals.logStatsManager.hasStatsChanged(f.date, result), false);
                    const notifications = host.events.length;
                    f.manager.notifyStatsUpdate({ date: f.date, stats: result, changed: true, delegated: false });
                    assert.equal(host.events.length, notifications);
                    const stats = JSON.parse(await readFile(f.statsPath, 'utf8')) as TokenUsageStatsFromFile;
                    const index = JSON.parse(await readFile(join(f.dir, 'usages', 'index.json'), 'utf8')) as DateIndex;
                    const sourceCount = (await f.internals.snapshotManager.read(f.date))?.length;
                    assert.equal(sourceCount, 3);
                    assert.equal(stats.total.requests, 3);
                    assert.equal(index.dates[f.date].total_requests, 3);
                } finally {
                    release.release();
                    try {
                        await old;
                    } finally {
                        blocked.mock.restore();
                        try {
                            await successor.dispose();
                        } finally {
                            await f.manager.dispose();
                        }
                    }
                }
            });
        }

        for (const changesGeneration of [false, true]) {
            const name =
                changesGeneration ?
                    'initial permission rejects ABA generation changes with the same boolean and owned term'
                :   'initial permission remains writable within the same generation';
            await suite.test(name, async c => {
                host.reset();
                const f = await host.fixture(c);
                const manager = f.internals.logStatsManager;
                let allowed = true;
                let ownedTerm: string | undefined;
                let generation = 1;
                try {
                    manager.setCanWriteStats(
                        () => allowed,
                        () => ownedTerm,
                        () => generation
                    );
                    const permission = manager.captureWritePermission();
                    assert.equal(permission(), true);
                    if (changesGeneration) {
                        allowed = false;
                        ownedTerm = 'successor:1';
                        generation++;
                        allowed = true;
                        ownedTerm = undefined;
                        generation++;
                    }
                    assert.equal(allowed, true);
                    assert.equal(ownedTerm, undefined);
                    assert.equal(permission(), !changesGeneration);
                    assert.equal(manager.captureWritePermission()(), true);
                } finally {
                    await f.manager.dispose();
                }
            });
        }
        await suite.test('an observed revocation stays revoked even without generation metadata', async c => {
            host.reset();
            const f = await host.fixture(c);
            let allowed = true;
            f.internals.logStatsManager.setCanWriteStats(() => allowed);
            const permission = f.internals.logStatsManager.captureWritePermission();
            assert.equal(permission(), true);
            allowed = false;
            assert.equal(permission(), false);
            allowed = true;
            assert.equal(permission(), false);
            assert.equal(f.internals.logStatsManager.captureWritePermission()(), true);
        });
        await suite.test('file logger captures the existing bus authority generation', async c => {
            host.reset();
            host.state.leaderId = undefined;
            let generation = 1;
            Object.assign(host.bus, { getConfirmedLeaderAuthority: () => ({ authorityTerm: undefined, generation }) });
            const f = await host.fixture(c);
            const permission = f.internals.logStatsManager.captureWritePermission();
            assert.equal(permission(), true);
            generation += 2;
            assert.equal(permission(), false);
            assert.equal(f.internals.logStatsManager.captureWritePermission()(), true);
        });
    } finally {
        host.restore();
    }
});
