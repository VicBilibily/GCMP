import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';
import { AtomicJsonFile } from '../../../atomicJsonFile';
import { DateUtils } from '../../../fileLogger/dateUtils';
import { StatsPublication } from '../../../fileLogger/refresh/statsPublication';
import type { StatsRefreshResult } from '../../../fileLogger/refresh/statsRefreshQueue';
import type { TokenRequestLog } from '../../../fileLogger/types';
import { createUsageHost } from '../../hostFixture';
import { gate } from '../fixture';

test('offline fallback publication retains only revalidated result-specific permission', async suite => {
    const host = await createUsageHost();
    try {
        for (const scenario of ['offline', 'owner', 'heartbeat', 'replacement', 'disposed', 'unrelated'] as const) {
            await suite.test(scenario, async context => {
                host.reset();
                context.mock.timers.enable({ apis: ['setTimeout'] });
                const f = await host.fixture(context, 'follower');
                const date = DateUtils.getTodayDateString();
                const row: TokenRequestLog = {
                    requestId: 'offline-request',
                    timestamp: Date.now(),
                    isoTime: new Date().toISOString(),
                    providerKey: 'test',
                    providerName: 'Test',
                    modelId: 'test',
                    modelName: 'Test',
                    estimatedInput: 10,
                    status: 'completed',
                    rawUsage: { prompt_tokens: 10, completion_tokens: 5 }
                };
                const folder = join(f.dir, 'usages', date);
                await mkdir(folder, { recursive: true });
                await writeFile(
                    join(folder, `${String(new Date().getHours()).padStart(2, '0')}.jsonl`),
                    JSON.stringify(row) + '\n'
                );
                host.state.leaderId = scenario === 'owner' ? 'follower' : 'leader';
                host.state.deliver = false;
                host.state.heartbeatFresh = scenario === 'owner';
                const internal = f.fileLogger as unknown as {
                    doRefreshCurrentStats(date: string): Promise<StatsRefreshResult | undefined>;
                };
                const work = host.run('follower', () => internal.doRefreshCurrentStats(date));
                if (scenario !== 'owner') {
                    context.mock.timers.tick(10000);
                }
                const result = await work;
                assert.ok(result);
                assert.equal(result.changed, true);
                const allowed = scenario === 'offline' || scenario === 'owner';
                if (allowed) {
                    host.run('follower', () => f.manager.notifyStatsUpdate(result));
                    await f.fileLogger.flush();
                    const changes: boolean[] = [result.changed];
                    for (let round = 0; round < 2; round++) {
                        const pending = host.run('follower', () => internal.doRefreshCurrentStats(date));
                        if (scenario === 'offline') {
                            context.mock.timers.tick(10000);
                        }
                        const next = await pending;
                        assert.ok(next);
                        changes.push(next.changed);
                        host.run('follower', () => f.manager.notifyStatsUpdate(next));
                        await f.fileLogger.flush();
                    }
                    assert.deepEqual(changes, [true, false, false]);
                    assert.equal(host.events.filter(item => item.event.type === 'tokenUsageUpdated').length, 1);
                } else {
                    const entered = gate(),
                        blocked = gate();
                    const held = AtomicJsonFile.runExclusive(join(folder, 'stats.json'), async () => {
                        entered.release();
                        await blocked.promise;
                    });
                    await entered.promise;
                    let disposal: Promise<void> | undefined;
                    try {
                        host.run('follower', () =>
                            f.manager.notifyStatsUpdate(scenario === 'unrelated' ? { ...result } : result)
                        );
                        if (scenario === 'heartbeat') {
                            host.state.heartbeatFresh = true;
                        }
                        if (scenario === 'replacement') {
                            host.state.leaderId = 'successor';
                        }
                        if (scenario === 'disposed') {
                            disposal = f.fileLogger.dispose();
                        }
                    } finally {
                        blocked.release();
                    }
                    await held;
                    await disposal;
                    await f.fileLogger.flush();
                    const cached = await f.internals.logStatsManager.readSavedStats(date);
                    assert.ok(cached);
                    const fingerprint = createHash('sha256').update(JSON.stringify(cached)).digest('hex');
                    assert.equal(await new StatsPublication().isPending(join(folder, 'stats.json'), fingerprint), true);
                    assert.equal(host.events.filter(item => item.event.type === 'tokenUsageUpdated').length, 1);
                }
            });
        }
    } finally {
        host.restore();
    }
});
