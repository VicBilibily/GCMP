import assert from 'node:assert/strict';
import { readFile, stat } from 'node:fs/promises';
import test from 'node:test';
import { createUsageHost } from '../hostFixture';
import { sharedSnapshotFixture } from '../snapshotFixture';
import { initializeLogger, rebuildWithLateWrite, type BoundStats } from './fixture';

test('historical stats recover across leader handoff and full initialization', { timeout: 30000 }, async suite => {
    const host = await createUsageHost();
    try {
        const { TokenFileLogger } = await import('../../fileLogger');
        for (const recovery of ['same-leader', 'promotion', 'restart'] as const) {
            for (const source of ['snapshot', 'raw'] as const) {
                for (const phase of ['snapshot-read', 'stats-write'] as const) {
                    await suite.test(`${recovery}/${source}/${phase}`, async context => {
                        const { leader, follower } = await sharedSnapshotFixture(host, context);
                        await initializeLogger(host, context, leader.fileLogger);
                        const initial = await leader.fileLogger.getDateStats(leader.date);
                        assert.ok(initial.versionTimestamp && initial.versionTimestamp > 1);
                        await initializeLogger(host, context, follower.fileLogger, 'follower');
                        assert.equal(
                            (await host.run('follower', () => follower.fileLogger.getDateStats(leader.date))).total
                                .requests,
                            1
                        );
                        await rebuildWithLateWrite(leader, context, source, phase);
                        let reader = leader.fileLogger;
                        let owner = 'leader';
                        if (recovery === 'promotion') {
                            await leader.fileLogger.dispose();
                            host.state.leaderId = 'follower';
                            reader = follower.fileLogger;
                            owner = 'follower';
                        } else if (recovery === 'restart') {
                            await leader.fileLogger.dispose();
                            reader = host.run('leader', () => new TokenFileLogger(leader.extensionContext));
                            context.after(() => reader.dispose());
                            await initializeLogger(host, context, reader);
                        }
                        const rebuilt = await host.run(owner, () => reader.regenerateOutdatedStats());
                        const result = await host.run(owner, () => reader.getDateStats(leader.date));
                        const saved = JSON.parse(await readFile(leader.statsPath, 'utf8')) as BoundStats;
                        assert.equal(result.total.requests, 3);
                        assert.equal(result.total.actualInput + result.total.outputTokens, 45);
                        assert.equal(saved.total.requests, 3);
                        assert.equal(saved.versionTimestamp, initial.versionTimestamp);
                        assert.equal(rebuilt[leader.date]?.total.requests, 3);
                        const bytes = await readFile(leader.statsPath, 'utf8');
                        const mtime = (await stat(leader.statsPath)).mtimeMs;
                        for (let round = 0; round < 3; round++) {
                            assert.deepEqual(await host.run(owner, () => reader.regenerateOutdatedStats()), {});
                        }
                        assert.equal(await readFile(leader.statsPath, 'utf8'), bytes);
                        assert.equal((await stat(leader.statsPath)).mtimeMs, mtime);
                    });
                }
            }
        }
    } finally {
        host.restore();
    }
});
