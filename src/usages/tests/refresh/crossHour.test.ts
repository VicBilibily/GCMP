import assert from 'node:assert/strict';
import { appendFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';
import { StatsCalculator } from '../../fileLogger/statsCalculator';
import type { TokenRequestLog } from '../../fileLogger/types';
import { createUsageHost } from '../hostFixture';
import { refreshClock, refreshFixture, terminal } from './fixture';

test('cross-hour statistics keep one request with incremental refresh', async suite => {
    const host = await createUsageHost();
    try {
        for (const status of ['completed', 'failed', 'cancelled'] as const) {
            for (const acrossHour of [false, true]) {
                for (const warm of [false, true]) {
                    await suite.test(`${status}: acrossHour=${acrossHour}, warm=${warm}`, async context => {
                        host.reset();
                        refreshClock(context);
                        const f = await refreshFixture(host, context);
                        const start = new Date(`${f.date}T10:59:59`).getTime();
                        let now = start;
                        context.mock.method(Date, 'now', () => now);
                        const id = await f.manager.recordEstimatedTokens({
                            providerKey: 'test',
                            displayName: 'Test',
                            modelId: 'test',
                            modelName: 'Test',
                            estimatedInputTokens: 10
                        });
                        await f.idleWrites();
                        if (warm) {
                            assert.equal((await f.fileLogger.getDateStats(f.date)).total.requests, 1);
                        }
                        const read = context.mock.method(f.internals.readManager, 'readHourLogs');
                        now += acrossHour ? 2000 : 500;
                        f.manager.updateActualTokens({ ...terminal(id), status });
                        await f.idleWrites();
                        const stats = await f.fileLogger.getDateStats(f.date);
                        const raw = await f.fileLogger.readDateLogs(f.date);
                        const direct = StatsCalculator.aggregateLogs(raw);
                        const details = await f.fileLogger.getRequestDetails(f.date);
                        assert.equal(raw.length, 2);
                        assert.equal(details.length, 1);
                        assert.equal(stats.total.requests, 1);
                        assert.equal(stats.total.completedRequests, status === 'completed' ? 1 : 0);
                        assert.equal(stats.total.failedRequests, status === 'failed' ? 1 : 0);
                        assert.equal(stats.total.cancelledRequests, status === 'cancelled' ? 1 : 0);
                        assert.equal(stats.total.actualInput, direct.total.actualInput);
                        assert.equal(stats.total.outputTokens, direct.total.outputTokens);
                        assert.equal(stats.providers.test.requests, 1);
                        assert.equal(stats.providers.test.models.test.requests, 1);
                        assert.equal(stats.hourly?.['10'].requests, 1);
                        if (acrossHour) {
                            assert.equal(stats.hourly?.['11'].requests, 0);
                        }
                        if (warm && acrossHour) {
                            assert.equal(read.mock.calls[0].arguments[1], 11);
                        }
                        assert.equal((await f.fileLogger.getDateStats(f.date, true)).total.requests, 1);
                    });
                }
            }
        }
        await suite.test(
            'later title updates and changed raw files preserve ownership without rereading old hours',
            async context => {
                host.reset();
                refreshClock(context);
                const f = await refreshFixture(host, context);
                const folder = join(f.dir, 'usages', f.date);
                const start = new Date(`${f.date}T09:59:59`).getTime();
                const estimated: TokenRequestLog = {
                    requestId: `${start}_cross-hour`,
                    timestamp: start,
                    isoTime: new Date(start).toISOString(),
                    providerKey: 'test',
                    providerName: 'Test',
                    modelId: 'test',
                    modelName: 'Test',
                    estimatedInput: 10,
                    status: 'estimated',
                    rawUsage: null
                };
                const completed = {
                    ...estimated,
                    timestamp: start + 2000,
                    status: 'completed' as const,
                    rawUsage: { prompt_tokens: 10, completion_tokens: 5 }
                };
                await mkdir(folder, { recursive: true });
                const first = join(folder, '09.jsonl'),
                    second = join(folder, '10.jsonl');
                await writeFile(first, JSON.stringify(estimated) + '\n');
                await writeFile(second, JSON.stringify(completed) + '\n');
                const stats = await f.fileLogger.getDateStats(f.date);
                assert.equal(stats.total.requests, 1);
                const read = context.mock.method(f.internals.readManager, 'readHourLogs');
                const aggregate = context.mock.method(StatsCalculator, 'aggregateLogs');
                const titled = {
                    ...completed,
                    timestamp: start + 3602000,
                    sessionId: 'session',
                    sessionTitle: 'Title'
                };
                await writeFile(join(folder, '11.jsonl'), JSON.stringify(titled) + '\n');
                const updated = await f.fileLogger.getDateStats(f.date);
                assert.equal(updated.total.requests, 1);
                assert.equal(updated.total.actualInput, 10);
                assert.equal(updated.total.outputTokens, 5);
                assert.deepEqual(
                    read.mock.calls.map(call => call.arguments[1]),
                    [11]
                );
                assert.equal(
                    aggregate.mock.calls.some(call =>
                        call.arguments[0].some(row => row.requestId === estimated.requestId)
                    ),
                    true
                );
                const oldContents = await readFile(first, 'utf8');
                await appendFile(first, JSON.stringify({ ...estimated, requestId: 'late-old-hour' }) + '\n');
                assert.equal((await f.fileLogger.getDateStats(f.date)).total.requests, 2);
                assert.deepEqual(
                    read.mock.calls.map(call => call.arguments[1]),
                    [11, 9]
                );
                await writeFile(first, oldContents);
                assert.equal((await f.fileLogger.getDateStats(f.date, true)).total.requests, 1);
            }
        );
        await suite.test('a cold reader corrects an old persisted double-count cache', async context => {
            host.reset();
            refreshClock(context);
            const f = await refreshFixture(host, context);
            const start = new Date(`${f.date}T10:59:59`).getTime();
            let now = start;
            context.mock.method(Date, 'now', () => now);
            const id = await f.manager.recordEstimatedTokens({
                providerKey: 'test',
                displayName: 'Test',
                modelId: 'test',
                modelName: 'Test',
                estimatedInputTokens: 10
            });
            await f.idleWrites();
            now += 2000;
            f.manager.updateActualTokens(terminal(id));
            await f.idleWrites();
            const old = await f.fileLogger.getDateStats(f.date, true);
            old.total.requests = 2;
            old.versionTimestamp = new Date('2026-10-06T00:00:00+08:00').getTime();
            await writeFile(join(f.dir, 'usages', f.date, 'stats.json'), JSON.stringify(old));
            const internals = f.fileLogger as unknown as { initCacheVersionTimestamp(): Promise<void> };
            await internals.initCacheVersionTimestamp();
            assert.equal((await f.fileLogger.getDateStats(f.date)).total.requests, 1);
        });
    } finally {
        host.restore();
    }
});
