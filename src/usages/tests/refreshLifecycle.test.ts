import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';
import type * as vscode from 'vscode';
import { DateUtils } from '../fileLogger/dateUtils';
import { createUsageHost, type UsageEvent } from './hostFixture';

const nextTurn = () => new Promise<void>(resolve => setImmediate(resolve));

test('usage refresh completion and multi-day feedback regressions', async suite => {
    const host = await createUsageHost();
    try {
        const { registerUsageRefreshHandlers } = await import('../usageActivation');
        const { MultiDayView } = await import('../../ui/multiDayView');
        const today = DateUtils.getTodayDateString();
        async function fixture(context: TestContext) {
            host.reset();
            const leader = await host.fixture(context, 'leader');
            const follower = await host.fixture(context, 'follower');
            const stats = host.emptyStats();
            for (const instance of [leader, follower]) {
                context.mock.method(instance.internals.logStatsManager, 'getDateStats', async () => stats);
                context.mock.method(instance.internals.logStatsManager, 'regenerateOutdatedStats', async () => ({}));
                context.mock.method(instance.fileLogger, 'getIndex', async () => ({}));
                context.mock.method(instance.manager, 'getDateStats', async () => ({
                    ...stats,
                    date: today,
                    lastUpdated: 0
                }));
            }
            const forced = context.mock.method(follower.internals.logStatsManager, 'runWithForcedWrites');
            const register = () => host.run('leader', () => registerUsageRefreshHandlers(leader.extensionContext));
            return { leader, follower, stats, forced, register };
        }
        function requested(): Extract<UsageEvent, { type: 'statsRefreshRequested' }> {
            const event = host.events.find(item => item.event.type === 'statsRefreshRequested')?.event;
            assert.ok(event && event.type === 'statsRefreshRequested');
            return event;
        }
        function reply(senderInstanceId = 'leader', dates: string[] = [], requestId = requested().payload.requestId) {
            host.deliver({
                type: 'statsRefreshCompleted',
                senderInstanceId,
                timestamp: Date.now(),
                payload: { requestId, regeneratedDates: dates }
            });
        }
        function openView(context: TestContext, extensionContext: vscode.ExtensionContext) {
            interface Query {
                command: string;
                dateFrom: string;
                dateTo: string;
                requestId: number;
            }
            let receive!: (message: Query) => Promise<void>;
            let onDispose: (() => void) | undefined;
            const pending = new Set<Promise<void>>();
            const commands: string[] = [];
            const failures: unknown[] = [];
            let requestCount = 0;
            function query() {
                const work = host.run('follower', () =>
                    receive({
                        command: 'getMultiDayAnalysis',
                        dateFrom: today,
                        dateTo: today,
                        requestId: ++requestCount
                    })
                );
                pending.add(work);
                void work.then(
                    () => pending.delete(work),
                    error => {
                        pending.delete(work);
                        failures.push(error);
                    }
                );
                return work;
            }
            host.state.createPanel = () =>
                ({
                    webview: {
                        html: '',
                        onDidReceiveMessage(callback: typeof receive) {
                            receive = callback;
                            return { dispose() {} };
                        },
                        postMessage(message: { command: string }) {
                            commands.push(message.command);
                            if (message.command === 'refreshMultiDayAnalysis') {
                                void query();
                            }
                            return Promise.resolve(true);
                        }
                    },
                    onDidDispose(callback: () => void) {
                        onDispose = callback;
                        return { dispose() {} };
                    },
                    reveal() {},
                    dispose() {
                        onDispose?.();
                    }
                }) as unknown as vscode.WebviewPanel;
            const view = host.run('follower', () => new MultiDayView(extensionContext));
            context.mock.method(view as unknown as { getWebviewContent(): string }, 'getWebviewContent', () => '');
            host.run('follower', () => view.show());
            context.after(() => view.dispose());
            return {
                query,
                view,
                commands,
                get requestCount() {
                    return requestCount;
                },
                async settle() {
                    while (pending.size) {
                        await Promise.all([...pending]);
                    }
                    await nextTurn();
                    assert.deepEqual(failures, []);
                    assert.equal(commands.includes('multiDayError'), false);
                }
            };
        }

        for (const initiallyChanged of [false, true]) {
            await suite.test(
                `multi-day refresh stops after ${initiallyChanged ? 'one real change' : 'an empty rebuild'}`,
                async context => {
                    context.mock.timers.enable({ apis: ['setTimeout'] });
                    const { leader, follower, stats, register } = await fixture(context);
                    let regenerations = 0;
                    context.mock.method(leader.internals.logStatsManager, 'regenerateOutdatedStats', async () => {
                        regenerations++;
                        return initiallyChanged && regenerations === 1 ? { [today]: stats } : {};
                    });
                    register();
                    const page = openView(context, follower.extensionContext);
                    await page.query();
                    await page.settle();
                    for (let round = 0; round < 3; round++) {
                        context.mock.timers.tick(5000);
                        await page.settle();
                    }
                    const expected = initiallyChanged ? 2 : 1;
                    assert.equal(page.requestCount, expected);
                    assert.equal(regenerations, expected);
                    const replies = host.events.filter(item => item.event.type === 'statsRefreshCompleted');
                    assert.equal(replies.length, expected);
                    assert.equal(
                        replies.every(item => item.alsoFallback),
                        true
                    );
                    assert.equal(
                        host.events.filter(item => item.event.type === 'tokenUsageUpdated').length,
                        initiallyChanged ? 1 : 0
                    );
                    assert.equal(
                        host.warnings.some(message => message.includes('timed out')),
                        false
                    );
                    page.view.dispose();
                    context.mock.timers.tick(20_000);
                    await page.settle();
                    assert.equal(page.requestCount, expected);
                }
            );
        }

        for (const kind of ['all', 'today'] as const) {
            for (const fresh of [true, false]) {
                await suite.test(
                    `${kind}: empty completion is not timeout with heartbeat fresh=${fresh}`,
                    async context => {
                        const { follower, forced } = await fixture(context);
                        host.state.deliver = false;
                        host.state.heartbeatFresh = fresh;
                        const work = host.run('follower', () =>
                            kind === 'all' ?
                                follower.fileLogger.regenerateOutdatedStats()
                            :   follower.internals.doRefreshCurrentStats()
                        );
                        reply();
                        await work;
                        assert.equal(forced.mock.callCount(), 0);
                        assert.equal(follower.internals.pendingStatsRefreshRequests.size, 0);
                        assert.equal(
                            host.warnings.some(message => message.includes('timed out')),
                            false
                        );
                    }
                );
                await suite.test(`${kind}: actual timeout respects heartbeat fresh=${fresh}`, async context => {
                    context.mock.timers.enable({ apis: ['setTimeout'] });
                    const { follower, forced } = await fixture(context);
                    host.state.deliver = false;
                    host.state.heartbeatFresh = fresh;
                    const work = host.run('follower', () =>
                        kind === 'all' ?
                            follower.fileLogger.regenerateOutdatedStats()
                        :   follower.internals.doRefreshCurrentStats()
                    );
                    context.mock.timers.tick(9999);
                    assert.equal(follower.internals.pendingStatsRefreshRequests.size, 1);
                    assert.equal(forced.mock.callCount(), 0);
                    context.mock.timers.tick(1);
                    await work;
                    assert.equal(forced.mock.callCount(), fresh ? 0 : 1);
                    assert.equal(follower.internals.pendingStatsRefreshRequests.size, 0);
                    assert.equal(
                        host.warnings.some(message => message.includes('timed out')),
                        true
                    );
                });
            }
            await suite.test(`${kind}: disposal settles waiting work without forced writes`, async context => {
                const { follower, forced } = await fixture(context);
                host.state.deliver = false;
                host.state.heartbeatFresh = false;
                const work = host.run('follower', () =>
                    kind === 'all' ?
                        follower.fileLogger.regenerateOutdatedStats()
                    :   follower.internals.doRefreshCurrentStats()
                );
                await follower.fileLogger.dispose();
                await work;
                assert.equal(forced.mock.callCount(), 0);
                assert.equal(follower.internals.pendingStatsRefreshRequests.size, 0);
                assert.equal(
                    host.warnings.some(message => message.includes('timed out')),
                    false
                );
            });
        }

        await suite.test(
            'completion checks sender and request identity and ignores duplicate delivery',
            async context => {
                context.mock.timers.enable({ apis: ['setTimeout'] });
                const { follower, stats, forced } = await fixture(context);
                host.state.deliver = false;
                const reads = context.mock.method(
                    follower.internals.logStatsManager,
                    'getDateStats',
                    async () => stats
                );
                const work = host.run('follower', () => follower.fileLogger.regenerateOutdatedStats());
                reply('foreign', [today]);
                reply('leader', [today], 'other-request');
                assert.equal(follower.internals.pendingStatsRefreshRequests.size, 1);
                reply('leader', [today]);
                reply('leader', [today]);
                assert.deepEqual(await work, { [today]: stats });
                context.mock.timers.tick(10_000);
                assert.equal(reads.mock.callCount(), 1);
                assert.equal(forced.mock.callCount(), 0);
                assert.equal(
                    host.warnings.some(message => message.includes('timed out')),
                    false
                );
            }
        );

        await suite.test(
            'leader error still completes delegation without generating a refresh event',
            async context => {
                const { leader, follower, forced, register } = await fixture(context);
                context.mock.method(leader.internals.logStatsManager, 'regenerateOutdatedStats', async () => {
                    throw new Error('synthetic rebuild failure');
                });
                register();
                assert.deepEqual(await host.run('follower', () => follower.fileLogger.regenerateOutdatedStats()), {});
                await nextTurn();
                assert.equal(host.events.filter(item => item.event.type === 'statsRefreshCompleted').length, 1);
                assert.equal(host.events.filter(item => item.event.type === 'tokenUsageUpdated').length, 0);
                assert.equal(forced.mock.callCount(), 0);
                assert.equal(
                    host.warnings.some(message => message.includes('timed out')),
                    false
                );
            }
        );

        await suite.test('late real rebuild still refreshes the page after delegation timeout', async context => {
            context.mock.timers.enable({ apis: ['setTimeout'] });
            const { leader, follower, stats, forced, register } = await fixture(context);
            let release!: () => void;
            let entered!: () => void;
            const gate = new Promise<void>(resolve => {
                release = resolve;
            });
            const started = new Promise<void>(resolve => {
                entered = resolve;
            });
            let calls = 0;
            context.mock.method(leader.internals.logStatsManager, 'regenerateOutdatedStats', async () => {
                if (++calls === 1) {
                    entered();
                    await gate;
                    return { [today]: stats };
                }
                return {};
            });
            register();
            const page = openView(context, follower.extensionContext);
            const work = page.query();
            try {
                await started;
                context.mock.timers.tick(10_000);
                await work;
                assert.equal(page.requestCount, 1);
                const updated = new Promise<void>(resolve => {
                    follower.extensionContext.subscriptions.push(
                        host.run('follower', () => host.bus.subscribe('tokenUsageUpdated', () => resolve()))
                    );
                });
                release();
                await updated;
                context.mock.timers.tick(5000);
                await page.settle();
                assert.equal(page.requestCount, 2);
                assert.equal(page.commands.filter(command => command === 'updateMultiDayAnalysis').length, 2);
                context.mock.timers.tick(5000);
                await page.settle();
                assert.equal(page.requestCount, 2);
                assert.equal(forced.mock.callCount(), 0);
            } finally {
                release();
                await work;
                await page.settle();
            }
        });

        await suite.test('today refresh and periodic refresh keep publishing updates', async context => {
            const { follower, register } = await fixture(context);
            register();
            await host.run('follower', () => follower.internals.doRefreshCurrentStats());
            await nextTurn();
            assert.equal(host.events.filter(item => item.event.type === 'tokenUsageUpdated').length, 1);
            assert.equal(host.periodic.length, 1);
            await host.run('leader', () => host.periodic[0]());
            await nextTurn();
            assert.equal(host.events.filter(item => item.event.type === 'tokenUsageUpdated').length, 2);
        });
    } finally {
        host.restore();
    }
});
