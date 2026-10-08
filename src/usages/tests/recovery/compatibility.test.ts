import assert from 'node:assert/strict';
import { readFile, stat, unlink, utimes, writeFile } from 'node:fs/promises';
import test, { type TestContext } from 'node:test';
import { AtomicJsonFile } from '../../atomicJsonFile';
import { createUsageHost, type LoggerInternals } from '../hostFixture';
import { snapshotFixture, snapshotRow } from '../snapshotFixture';
import type { BoundStats, RecoveryFixture } from './fixture';

test('persisted source versions remain compatible with legacy and unchanged stats', { timeout: 30000 }, async suite => {
    const host = await createUsageHost();
    try {
        const { SnapshotManager } = await import('../../fileLogger/snapshotManager');
        const { TokenFileLogger } = await import('../../fileLogger');
        function coldLogger(f: RecoveryFixture, context: TestContext) {
            const logger = host.run('leader', () => new TokenFileLogger(f.extensionContext));
            const internals = logger as unknown as LoggerInternals;
            internals.logStatsManager.updateCodeVersionTimestamp(1);
            context.after(() => logger.dispose());
            return { logger, internals };
        }
        async function fixture(context: TestContext, legacy: boolean) {
            const f = await snapshotFixture(host, context);
            if (legacy) {
                const saved = JSON.parse(await readFile(f.statsPath, 'utf8')) as BoundStats;
                delete saved.snapshotSourceVersion;
                await writeFile(f.statsPath, JSON.stringify(saved));
            }
            return f;
        }
        for (const legacy of [false, true]) {
            await suite.test(
                `legacy=${legacy}: unchanged cold stats do not rewrite or rescan repeatedly`,
                async context => {
                    const f = await fixture(context, legacy);
                    const { logger, internals } = coldLogger(f, context);
                    const read = context.mock.method(internals.snapshotManager, 'read');
                    const bytes = await readFile(f.statsPath, 'utf8');
                    const mtime = (await stat(f.statsPath)).mtimeMs;
                    for (let round = 0; round < 3; round++) {
                        assert.deepEqual(await logger.regenerateOutdatedStats(), {});
                        assert.equal((await logger.getDateStats(f.date)).total.requests, 1);
                    }
                    assert.equal(await readFile(f.statsPath, 'utf8'), bytes);
                    assert.equal((await stat(f.statsPath)).mtimeMs, mtime);
                    assert.equal(read.mock.callCount(), legacy ? 1 : 0);
                }
            );

            await suite.test(`legacy=${legacy}: a cold reader detects a same-mtime replacement`, async context => {
                const f = await fixture(context, legacy);
                const previous = await stat(f.snapshotPath);
                const external = new SnapshotManager(f.internals.pathManager, () => {});
                await external.upsertRecord(f.date, snapshotRow(f.date, 'second', 10));
                await utimes(f.snapshotPath, previous.atime, previous.mtime);
                assert.equal((await stat(f.snapshotPath)).mtimeMs, previous.mtimeMs);
                assert.ok(previous.mtimeMs < (await stat(f.statsPath)).mtimeMs);
                const { logger } = coldLogger(f, context);
                const rebuilt = await logger.regenerateOutdatedStats();
                assert.equal((await logger.getDateStats(f.date)).total.requests, 2);
                assert.equal(rebuilt[f.date]?.total.requests, 2);
                assert.deepEqual(await logger.regenerateOutdatedStats(), {});
            });

            await suite.test(`legacy=${legacy}: title-only changes converge without writing stats`, async context => {
                const f = await fixture(context, legacy);
                await f.changeTitle();
                const bytes = await readFile(f.statsPath, 'utf8');
                const mtime = (await stat(f.statsPath)).mtimeMs;
                for (let instance = 0; instance < 2; instance++) {
                    const { logger, internals } = coldLogger(f, context);
                    const read = context.mock.method(internals.snapshotManager, 'read');
                    for (let round = 0; round < 3; round++) {
                        assert.deepEqual(await logger.regenerateOutdatedStats(), {});
                    }
                    assert.equal(read.mock.callCount(), 1);
                }
                assert.equal(await readFile(f.statsPath, 'utf8'), bytes);
                assert.equal((await stat(f.statsPath)).mtimeMs, mtime);
            });

            await suite.test(`legacy=${legacy}: a cold reader retries a failed same-mtime save`, async context => {
                const f = await fixture(context, legacy);
                const bytes = await readFile(f.statsPath, 'utf8');
                const previous = await stat(f.snapshotPath);
                const external = new SnapshotManager(f.internals.pathManager, () => {});
                await external.upsertRecord(f.date, snapshotRow(f.date, 'second', 10));
                await utimes(f.snapshotPath, previous.atime, previous.mtime);
                assert.equal((await stat(f.snapshotPath)).mtimeMs, previous.mtimeMs);
                const write = AtomicJsonFile.writeJsonAtomically.bind(AtomicJsonFile);
                let attempts = 0;
                const failure = context.mock.method(
                    AtomicJsonFile,
                    'writeJsonAtomically',
                    async (...args: Parameters<typeof write>) => {
                        if (args[0] === f.statsPath) {
                            attempts++;
                            throw Object.assign(new Error('Injected stats write failure'), { code: 'EACCES' });
                        }
                        return write(...args);
                    }
                );
                try {
                    await assert.rejects(f.fileLogger.getDateStats(f.date, true), { code: 'EACCES' });
                    assert.equal(attempts, 1);
                    assert.equal(await readFile(f.statsPath, 'utf8'), bytes);
                } finally {
                    failure.mock.restore();
                }
                const { logger } = coldLogger(f, context);
                const rebuilt = await logger.regenerateOutdatedStats();
                assert.equal((await logger.getDateStats(f.date)).total.requests, 2);
                assert.equal(rebuilt[f.date]?.total.requests, 2);
                assert.deepEqual(await logger.regenerateOutdatedStats(), {});
            });
        }

        await suite.test('a successful snapshot rebuild persists the captured source version', async context => {
            const f = await snapshotFixture(host, context);
            const saved = JSON.parse(await readFile(f.statsPath, 'utf8')) as BoundStats;
            assert.equal(typeof saved.snapshotSourceVersion, 'string');
            assert.ok(saved.snapshotSourceVersion?.includes('requests.jsonl'));
            const { logger, internals } = coldLogger(f, context);
            const read = context.mock.method(internals.snapshotManager, 'read');
            assert.equal((await logger.getDateStats(f.date)).total.requests, 1);
            assert.equal(read.mock.callCount(), 0);
        });

        await suite.test(
            'a removed snapshot falls back to raw and drops its obsolete source version',
            async context => {
                const f = await snapshotFixture(host, context);
                await writeFile(f.internals.pathManager.getHourFilePath(f.date, 9), JSON.stringify(f.row) + '\n', {
                    flag: 'wx'
                });
                await writeFile(
                    f.internals.pathManager.getHourFilePath(f.date, 10),
                    JSON.stringify(snapshotRow(f.date, 'second', 10)) + '\n',
                    { flag: 'wx' }
                );
                await unlink(f.snapshotPath);
                const { logger } = coldLogger(f, context);
                const result = (await logger.getDateStats(f.date)) as BoundStats;
                assert.equal(result.total.requests, 2);
                assert.equal(result.snapshotSourceVersion, undefined);
                assert.deepEqual(await logger.regenerateOutdatedStats(), {});
            }
        );
    } finally {
        host.restore();
    }
});
