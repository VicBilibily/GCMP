import assert from 'node:assert/strict';
import { readFile, stat, utimes } from 'node:fs/promises';
import test from 'node:test';
import { createUsageHost } from './hostFixture';
import { gate, sharedSnapshotFixture, snapshotFixture, snapshotPage, snapshotRow } from './snapshotFixture';

test('historical snapshot refresh converges without rewriting unchanged stats', { timeout: 30000 }, async suite => {
    const host = await createUsageHost();
    try {
        for (const mode of ['title', 'equal-mtime', 'future-mtime'] as const) {
            await suite.test(
                `${mode}: unchanged snapshot is acknowledged once without a rebuilt date`,
                async context => {
                    const f = await snapshotFixture(host, context);
                    if (mode === 'title') {
                        await f.changeTitle();
                    } else if (mode === 'equal-mtime') {
                        await f.equalMtime();
                    } else {
                        const future = new Date(Date.now() + 60_000);
                        await utimes(f.snapshotPath, future, future);
                    }
                    assert.equal(await f.privateStats.needsRegeneration(f.date), true);
                    const initialMtime = (await stat(f.statsPath)).mtimeMs;
                    const reads = context.mock.method(f.internals.snapshotManager, 'read');
                    for (let round = 0; round < 3; round++) {
                        assert.deepEqual(await f.fileLogger.regenerateOutdatedStats(), {});
                        assert.equal((await f.fileLogger.getDateStats(f.date)).total.requests, 1);
                        assert.equal(await f.privateStats.needsRegeneration(f.date), false);
                    }
                    assert.equal(reads.mock.callCount(), 1);
                    assert.equal(await readFile(f.statsPath, 'utf8'), f.originalStats);
                    assert.equal((await stat(f.statsPath)).mtimeMs, initialMtime);
                }
            );
        }

        for (const mode of ['stable', 'title', 'equal-mtime', 'new-record'] as const) {
            await suite.test(`${mode}: shared-file follower page stops scheduling itself`, async context => {
                const { leader, follower, background } = await sharedSnapshotFixture(host, context);
                if (mode === 'title') {
                    await leader.changeTitle();
                }
                if (mode === 'equal-mtime') {
                    await leader.equalMtime();
                }
                if (mode === 'new-record') {
                    await leader.internals.snapshotManager.upsertRecord(
                        leader.date,
                        snapshotRow(leader.date, 'second', 10)
                    );
                }
                host.events.length = 0;
                context.mock.timers.enable({ apis: ['setTimeout'] });
                const page = await snapshotPage(host, context, follower.extensionContext, leader.date, background);
                try {
                    await page.query();
                    await page.settle();
                    for (let round = 0; round < 3; round++) {
                        context.mock.timers.tick(5000);
                        await page.settle();
                    }
                    const changed = mode === 'new-record';
                    assert.equal(page.queries, changed ? 2 : 1);
                    assert.equal(
                        host.events.filter(item => item.event.type === 'tokenUsageUpdated').length,
                        changed ? 1 : 0
                    );
                    const replies = host.events.filter(item => item.event.type === 'statsRefreshCompleted');
                    assert.equal(replies.length, page.queries);
                    assert.ok(replies.every(item => item.alsoFallback));
                    const analyses = page.messages.filter(message => message.command === 'updateMultiDayAnalysis');
                    assert.equal(analyses.length, page.queries);
                    assert.ok(analyses.every(message => message.data?.summary.totalTokens === (changed ? 30 : 15)));
                    assert.deepEqual(await leader.privateStats.getOutdatedDates(), []);
                    assert.equal(
                        host.warnings.some(message => message.includes('timed out')),
                        false
                    );
                    if (!changed) {
                        assert.equal(await readFile(leader.statsPath, 'utf8'), leader.originalStats);
                    }
                } finally {
                    page.view.dispose();
                    await page.settle();
                }
            });
        }

        await suite.test('concurrent no-change rebuilds produce no false change results', async context => {
            const f = await snapshotFixture(host, context);
            await f.changeTitle();
            const results = await Promise.all(Array.from({ length: 4 }, () => f.fileLogger.regenerateOutdatedStats()));
            assert.deepEqual(results, [{}, {}, {}, {}]);
            assert.deepEqual(await f.privateStats.getOutdatedDates(), []);
            assert.equal(await readFile(f.statsPath, 'utf8'), f.originalStats);
        });

        await suite.test(
            'a real rebuild arriving after timeout still refreshes the shared-file page',
            async context => {
                const { leader, follower, background } = await sharedSnapshotFixture(host, context);
                await leader.internals.snapshotManager.upsertRecord(leader.date, snapshotRow(leader.date, 'late', 10));
                const entered = gate();
                const release = gate();
                const read = leader.internals.snapshotManager.read.bind(leader.internals.snapshotManager);
                let first = true;
                context.mock.method(leader.internals.snapshotManager, 'read', async (date: string) => {
                    if (first && date === leader.date) {
                        first = false;
                        entered.release();
                        await release.promise;
                    }
                    return read(date);
                });
                context.mock.timers.enable({ apis: ['setTimeout'] });
                const page = await snapshotPage(host, context, follower.extensionContext, leader.date, background);
                const work = page.query();
                try {
                    await entered.promise;
                    context.mock.timers.tick(10_000);
                    await work;
                    assert.equal(page.queries, 1);
                    const published = new Promise<void>(resolve => {
                        follower.extensionContext.subscriptions.push(
                            host.run('follower', () => host.bus.subscribe('tokenUsageUpdated', () => resolve()))
                        );
                    });
                    release.release();
                    await published;
                    context.mock.timers.tick(5000);
                    await page.settle();
                    assert.equal(page.queries, 2);
                    const latest = page.messages.filter(message => message.command === 'updateMultiDayAnalysis').at(-1);
                    assert.equal(latest?.data?.summary.totalTokens, 30);
                    for (let round = 0; round < 2; round++) {
                        context.mock.timers.tick(5000);
                        await page.settle();
                    }
                    assert.equal(page.queries, 2);
                } finally {
                    release.release();
                    await work;
                    page.view.dispose();
                    await page.settle();
                }
            }
        );
    } finally {
        host.restore();
    }
});
