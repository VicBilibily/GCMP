import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';
import { DateUtils } from '../../../usages/fileLogger/dateUtils';
import type { UsageStatusSnapshot } from '../../../usages/status/snapshot';
import { allowedCommands, createStatusBarHost, deferred, settle, snapshot, tooltip } from './fixture';

test(
    'token usage status bar consumes lightweight statistics snapshots',
    { concurrency: false },
    async (t: TestContext) => {
        const host = await createStatusBarHost(t);

        await t.test(
            'initialization, ordinary and periodic refresh never read date statistics or request details',
            async c => {
                const { bar, item } = await host.start(c);
                assert.equal(host.state.reads, 1);
                assert.equal(item.command, 'gcmp.tokenUsage.showDetails');
                assert.equal(item.text, '$(layers) 150 $0.02');
                await bar.initialize();
                assert.equal(host.state.created, 1);
                await bar.updateDisplay();
                assert.equal(host.state.reads, 2);
                c.mock.timers.tick(30000);
                await settle();
                assert.equal(host.state.reads, 3);
                assert.equal(host.state.dateReads, 0);
                assert.equal(host.state.detailReads, 0);
            }
        );

        await t.test('local push mode ignores today and historical tokenUsageUpdated events', async c => {
            const { item } = await host.start(c);
            const before = { ...item };
            host.emitUsage(DateUtils.getTodayDateString());
            host.emitUsage(DateUtils.getDateStringDaysAgo(1));
            await settle();
            assert.equal(host.state.reads, 1);
            assert.deepEqual({ ...item }, before);
        });

        await t.test('startup file statistics render until an authoritative push replaces them', async c => {
            const { item } = await host.start(c, async () => ({ ...snapshot(4), authorityTerm: 'file' }));
            assert.equal(item.text, '$(layers) 300 $0.04');
            host.snapshots.emit(snapshot(2));
            assert.equal(item.text, '$(layers) 150 $0.02');
            assert.equal(host.state.reads, 1);
            assert.equal(host.state.dateReads, 0);
            assert.equal(host.state.detailReads, 0);
        });

        await t.test('file mode only queries for tokenUsageUpdated payloads dated today', async c => {
            await host.start(c);
            host.state.fileMode = true;
            host.emitUsage(DateUtils.getDateStringDaysAgo(1));
            host.emitUsage('2026-10-14');
            await settle();
            assert.equal(host.state.reads, 1);
            host.emitUsage(DateUtils.getTodayDateString());
            await settle();
            assert.equal(host.state.reads, 2);
        });

        await t.test('in-flight refreshes share one read and a burst becomes one pending read', async c => {
            const first = deferred<UsageStatusSnapshot>();
            const second = deferred<UsageStatusSnapshot>();
            const { bar, item } = await host.start(c, () => (host.state.reads === 1 ? first.promise : second.promise));
            let finished = false;
            const pending = Promise.all(Array.from({ length: 12 }, () => bar.updateDisplay()));
            void pending.then(() => {
                finished = true;
            });
            assert.equal(host.state.reads, 1);
            first.resolve(snapshot());
            await settle();
            assert.equal(host.state.reads, 2);
            assert.equal(finished, false);
            second.resolve(snapshot(4));
            await pending;
            await settle();
            assert.equal(host.state.reads, 2);
            assert.equal(finished, true);
            assert.equal(item.text, '$(layers) 300 $0.04');
        });

        await t.test('a pushed snapshot cannot be overwritten by a late older query result', async c => {
            const { bar, item } = await host.start(c);
            const late = deferred<UsageStatusSnapshot>();
            host.state.read = () => late.promise;
            const refresh = bar.updateDisplay();
            host.snapshots.emit(snapshot(8));
            const pushed = tooltip(item);
            assert.equal(item.text, '$(layers) 600 $0.08');
            assert.equal(host.state.reads, 2);
            late.resolve(snapshot());
            await refresh;
            assert.equal(tooltip(item), pushed);
            assert.equal(item.text, '$(layers) 600 $0.08');
            assert.equal(host.state.reads, 2);
        });

        await t.test(
            'midnight rejects both old-date pushes and a query begun yesterday without inventing zero',
            async c => {
                const late = deferred<UsageStatusSnapshot>();
                const { bar, item } = await host.start(c, () => late.promise);
                const yesterday = snapshot();
                c.mock.timers.setTime(new Date(2026, 9, 14).getTime());
                const before = { ...item };
                host.snapshots.emit(yesterday);
                assert.deepEqual({ ...item }, before);
                late.resolve(yesterday);
                await settle();
                assert.equal(item.text, '$(layers)');
                assert.match(tooltip(item).value, /正在加载 Token 统计\.\.\./);
                assert.equal(host.state.reads, 1);
                host.state.read = async () => yesterday;
                await bar.updateDisplay();
                assert.match(tooltip(item).value, /正在加载 Token 统计\.\.\./);
                host.snapshots.emit(snapshot(4));
                assert.equal(item.text, '$(layers) 300 $0.04');
                assert.equal(host.state.reads, 2);
            }
        );

        await t.test('a cached previous day is discarded at midnight even if the new read fails', async c => {
            const { bar, item } = await host.start(c);
            c.mock.timers.setTime(new Date(2026, 9, 14).getTime());
            host.state.read = async () => {
                throw new Error('Unavailable today');
            };
            await bar.updateDisplay();
            assert.equal(item.text, '$(layers)');
            assert.match(tooltip(item).value, /正在加载 Token 统计\.\.\./);
            assert.equal(host.state.errors.length, 1);
        });

        await t.test(
            'role and HAR configuration rerender cached data, including PID and the HAR command link',
            async c => {
                const { item } = await host.start(c);
                assert.match(tooltip(item).value, /从实例/);
                assert.doesNotMatch(tooltip(item).value, /PID|command:gcmp\.har\.revealCurrent/);
                host.state.leader = true;
                host.role.emit();
                assert.match(item.text, /^\$\(layers-dot\)/);
                assert.match(tooltip(item).value, /主实例/);
                host.state.har = true;
                const shows = item.shows;
                host.configure('gcmp.unrelated');
                assert.equal(item.shows, shows);
                host.configure();
                assert.ok(tooltip(item).value.includes(`PID ${process.pid}`));
                assert.match(tooltip(item).value, /\[打开 HAR 文件\]\(command:gcmp\.har\.revealCurrent\)/);
                host.state.har = false;
                host.configure();
                assert.doesNotMatch(tooltip(item).value, /PID|command:gcmp\.har\.revealCurrent/);
                await settle();
                assert.equal(host.state.reads, 1);
            }
        );

        await t.test('inactive cycles and the periodic cooldown skip queries after a recent push', async c => {
            await host.start(c);
            host.state.active = false;
            c.mock.timers.tick(30000);
            await settle();
            assert.equal(host.state.reads, 1);
            host.state.active = true;
            c.mock.timers.tick(29000);
            host.snapshots.emit(snapshot(4));
            c.mock.timers.tick(1000);
            await settle();
            assert.equal(host.state.reads, 1);
            c.mock.timers.tick(30000);
            await settle();
            assert.equal(host.state.reads, 2);
        });

        await t.test('delayed updates replace the previous timer and query once at the new deadline', async c => {
            const { bar } = await host.start(c);
            bar.delayedUpdate(5);
            bar.delayedUpdate(20);
            c.mock.timers.tick(19);
            await settle();
            assert.equal(host.state.reads, 1);
            c.mock.timers.tick(1);
            await settle();
            assert.equal(host.state.reads, 2);
        });

        await t.test(
            'dispose removes subscriptions and prevents deferred, periodic, pending and late work',
            async c => {
                const { bar, item } = await host.start(c);
                const late = deferred<UsageStatusSnapshot>();
                host.state.read = () => late.promise;
                const refreshes = Promise.all([bar.updateDisplay(), bar.updateDisplay()]);
                const queuedPush = [...host.snapshots.listeners][0];
                bar.delayedUpdate(10);
                const before = { text: item.text, tooltip: item.tooltip, shows: item.shows };
                bar.dispose();
                host.state.fileMode = true;
                host.emitUsage(DateUtils.getTodayDateString());
                host.role.emit();
                host.configure();
                queuedPush(snapshot(8));
                late.resolve(snapshot(4));
                await refreshes;
                c.mock.timers.tick(120000);
                await bar.initialize();
                await bar.updateDisplay();
                await bar.checkAndShowStatus();
                bar.delayedUpdate(0);
                await settle();
                assert.equal(host.state.reads, 2);
                assert.equal(host.state.created, 1);
                assert.deepEqual({ text: item.text, tooltip: item.tooltip, shows: item.shows }, before);
                for (const signal of [host.snapshots, host.usage, host.role, host.configuration]) {
                    assert.equal(signal.listeners.size, 0);
                    assert.equal(signal.disposals, 1);
                }
            }
        );

        await t.test('a statistics read failure retains the current-day cached statistics', async c => {
            const { bar, item } = await host.start(c);
            const before = tooltip(item).value;
            const error = new Error('Snapshot read failed');
            host.state.read = async () => {
                throw error;
            };
            await bar.updateDisplay();
            assert.equal(item.text, '$(layers) 150 $0.02');
            assert.equal(tooltip(item).value, before);
            assert.deepEqual(host.state.errors, [error]);
            assert.equal(host.state.reads, 2);
        });

        for (const initiallyUnknown of [true, false]) {
            await t.test(
                `unknown snapshot stays Loading instead of fake zero (initial=${initiallyUnknown})`,
                async c => {
                    const { bar, item } = await host.start(c, async () => (initiallyUnknown ? undefined : snapshot()));
                    host.state.read = async () => undefined;
                    await bar.updateDisplay();
                    assert.equal(item.text, '$(layers)');
                    assert.match(tooltip(item).value, /正在加载 Token 统计\.\.\./);
                    assert.doesNotMatch(tooltip(item).value, /暂无使用记录|No usage records|\b0\b/);
                }
            );
        }

        await t.test('a genuine empty snapshot is distinct from an unknown snapshot', async c => {
            const { item } = await host.start(c, async () => snapshot(0));
            assert.match(tooltip(item).value, /暂无使用记录/);
            assert.equal(item.text, '$(layers)');
            assert.deepEqual(tooltip(item).isTrusted, { enabledCommands: allowedCommands });
        });

        await t.test('pending initialization exposes action links before the first snapshot resolves', async c => {
            const pending = deferred<UsageStatusSnapshot>();
            const { item } = await host.start(c, () => pending.promise);
            try {
                const md = tooltip(item);
                assert.match(md.value, /正在加载 Token 统计/);
                for (const command of allowedCommands.slice(0, 3)) {
                    assert.ok(md.value.includes(`](command:${command})`));
                }
                assert.deepEqual(md.isTrusted, { enabledCommands: allowedCommands });
                assert.doesNotMatch(md.value, /暂无使用记录|Test Provider/);
                assert.equal(host.state.reads, 1);
            } finally {
                pending.resolve(snapshot());
                await settle();
            }
            assert.equal(item.text, '$(layers) 150 $0.02');
            assert.match(tooltip(item).value, /Test Provider/);
        });

        for (const language of ['zh-cn', 'en']) {
            for (const availability of ['missing', 'failed']) {
                await t.test(`${language} unavailable statistics preserve menu commands (${availability})`, async c => {
                    const { bar, item } = await host.start(c, async () => undefined);
                    host.state.language = language;
                    host.state.read = async () => {
                        if (availability === 'failed') {
                            throw new Error('Statistics unavailable');
                        }
                        return undefined;
                    };
                    await bar.updateDisplay();
                    const md = tooltip(item);
                    assert.ok(
                        md.value.includes(language === 'zh-cn' ? '正在加载 Token 统计...' : 'Loading token usage...')
                    );
                    for (const command of allowedCommands.slice(0, 3)) {
                        assert.ok(md.value.includes(`](command:${command})`));
                    }
                    const labels =
                        language === 'zh-cn' ?
                            ['点击查看详情', 'API Key 管理', '设置辅助偏好']
                        :   ['Click to view details', 'Manage API Keys', 'Set auxiliary preferences'];
                    for (const label of labels) {
                        assert.ok(md.value.includes(`[${label}]`));
                    }
                    assert.deepEqual(md.isTrusted, { enabledCommands: allowedCommands });
                    assert.doesNotMatch(md.value, /暂无使用记录|No usage records|\| Provider \||\| 提供商 \|/);
                    assert.equal(item.command, 'gcmp.tokenUsage.showDetails');
                    assert.equal(item.text, '$(layers)');
                    assert.equal(host.state.reads, 2);
                    host.snapshots.emit(snapshot(4));
                    assert.match(tooltip(item).value, /Test Provider/);
                    assert.equal(item.text, '$(layers) 300 $0.04');
                });
            }
        }
    }
);
