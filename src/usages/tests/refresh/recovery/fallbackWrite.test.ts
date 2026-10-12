import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import * as fs from 'node:fs/promises';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import test from 'node:test';
import { DateUtils } from '../../../fileLogger/dateUtils';
import type { StatsRefreshResult } from '../../../fileLogger/refresh/statsRefreshQueue';
import type { TokenRequestLog } from '../../../fileLogger/types';
import { createUsageHost } from '../../hostFixture';
import { gate } from '../fixture';

test(
    'fallback write permission is revalidated after temporary statistics are prepared',
    { timeout: 30000 },
    async suite => {
        const host = await createUsageHost();
        const promises = createRequire(import.meta.url)('node:fs/promises') as typeof fs;
        try {
            for (const scenario of ['offline', 'owner', 'heartbeat', 'replacement', 'disposed'] as const) {
                await suite.test(scenario, async context => {
                    host.reset();
                    context.mock.timers.enable({ apis: ['setTimeout'] });
                    const f = await host.fixture(context, 'follower');
                    const date = DateUtils.getTodayDateString(),
                        folder = join(f.dir, 'usages', date);
                    const path = join(folder, 'stats.json');
                    const row: TokenRequestLog = {
                        requestId: 'fallback',
                        timestamp: Date.now(),
                        isoTime: new Date().toISOString(),
                        providerKey: 'p',
                        providerName: 'P',
                        modelId: 'm',
                        modelName: 'M',
                        estimatedInput: 10,
                        rawUsage: null,
                        status: 'estimated'
                    };
                    await fs.mkdir(folder, { recursive: true });
                    await fs.writeFile(
                        join(folder, `${String(new Date().getHours()).padStart(2, '0')}.jsonl`),
                        JSON.stringify(row) + '\n'
                    );
                    host.state.leaderId = scenario === 'owner' ? 'follower' : 'leader';
                    host.state.heartbeatFresh = scenario === 'owner';
                    host.state.deliver = false;
                    const entered = gate(),
                        release = gate(),
                        original = promises.writeFile;
                    let paused = false;
                    context.mock.method(promises, 'writeFile', (async (...args: Parameters<typeof original>) => {
                        await original(...args);
                        if (!paused && String(args[0]).startsWith(`${path}.`) && String(args[0]).endsWith('.tmp')) {
                            paused = true;
                            entered.release();
                            await release.promise;
                        }
                    }) as typeof original);
                    const internal = f.fileLogger as unknown as {
                        doRefreshCurrentStats(date: string): Promise<StatsRefreshResult | undefined>;
                    };
                    const work = host.run('follower', () => internal.doRefreshCurrentStats(date));
                    if (scenario !== 'owner') {
                        context.mock.timers.tick(10000);
                    }
                    let disposal: Promise<void> | undefined;
                    const allowed = scenario === 'offline' || scenario === 'owner';
                    const successor = host.emptyStats();
                    successor.total.requests = 2;
                    const fingerprint = createHash('sha256').update(JSON.stringify(successor)).digest('hex');
                    try {
                        await entered.promise;
                        if (scenario === 'heartbeat') {
                            host.state.heartbeatFresh = true;
                        }
                        if (scenario === 'replacement') {
                            host.state.leaderId = 'successor';
                        }
                        if (scenario === 'disposed') {
                            disposal = f.fileLogger.dispose();
                        }
                        if (!allowed) {
                            await fs.writeFile(path, JSON.stringify(successor));
                            await fs.writeFile(
                                join(folder, 'stats-publication.json'),
                                JSON.stringify({ pending: [fingerprint] })
                            );
                            await fs.writeFile(join(folder, 'stats-published.json'), JSON.stringify(fingerprint));
                        }
                    } finally {
                        release.release();
                    }
                    const result = await work;
                    await disposal;
                    assert.equal(JSON.parse(await fs.readFile(path, 'utf8')).total.requests, allowed ? 1 : 2);
                    if (allowed) {
                        assert.ok(result);
                        assert.equal(result.changed, true);
                        host.run('follower', () => f.manager.notifyStatsUpdate(result));
                        await f.fileLogger.flush();
                        assert.equal(host.events.filter(item => item.event.type === 'tokenUsageUpdated').length, 1);
                    } else {
                        assert.equal(result, undefined);
                        assert.equal(host.events.filter(item => item.event.type === 'tokenUsageUpdated').length, 0);
                        assert.deepEqual(
                            JSON.parse(await fs.readFile(join(folder, 'stats-publication.json'), 'utf8')),
                            { pending: [fingerprint] }
                        );
                    }
                });
            }
        } finally {
            host.restore();
        }
    }
);
