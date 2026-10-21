import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import test, { type TestContext } from 'node:test';
import type { WebviewPanel } from 'vscode';
import type { TokenUsagesManager } from '../../usages/usagesManager';
import type { HostMessage, WebViewMessage } from './types';

function gate() {
    let release!: () => void;
    const promise = new Promise<void>(resolve => {
        release = resolve;
    });
    return { promise, release };
}

test('multi-day statistics reconcile without depending on notifications', async suite => {
    const require = createRequire(import.meta.url);
    const modules = require('node:module') as { prototype: { require(id: string): unknown } };
    const original = modules.prototype.require;
    const listeners = new Set<() => void>();
    let activePanel: WebviewPanel;
    let manager: Partial<TokenUsagesManager>;
    modules.prototype.require = function (id: string): unknown {
        if (id === 'vscode') {
            return { window: { createWebviewPanel: () => activePanel }, ViewColumn: { One: 1 } };
        }
        if (id.endsWith('/usagesManager')) {
            return {
                TokenUsagesManager: {
                    get instance() {
                        return manager;
                    }
                }
            };
        }
        if (id.endsWith('/statusLogger')) {
            return { StatusLogger: { debug() {}, warn() {}, error() {} } };
        }
        if (id.endsWith('/l10n')) {
            return { t: (text: string) => text };
        }
        if (id.endsWith('/interInstance')) {
            return {
                InterInstanceBus: {
                    subscribe(_type: string, listener: () => void) {
                        listeners.add(listener);
                        return { dispose: () => listeners.delete(listener) };
                    }
                }
            };
        }
        return original.call(this, id);
    };
    suite.after(() => {
        modules.prototype.require = original;
    });
    const { MultiDayView } = await import('./index');
    const setup = (context: TestContext) => {
        context.mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
        const messages: HostMessage[] = [];
        const state = {
            delivery: 'ok' as 'ok' | 'false' | 'reject',
            failQuery: false,
            queries: 0,
            attempts: 0,
            waits: [] as Promise<void>[]
        };
        let onDispose = () => {};
        let onVisibility = () => {};
        const panel = {
            visible: true,
            webview: {
                html: '',
                postMessage(message: HostMessage) {
                    state.attempts++;
                    if (state.delivery === 'reject') {
                        return Promise.reject(new Error('delivery failed'));
                    }
                    if (state.delivery === 'false') {
                        return Promise.resolve(false);
                    }
                    messages.push(message);
                    return Promise.resolve(true);
                },
                onDidReceiveMessage: () => ({ dispose() {} })
            },
            onDidChangeViewState(listener: () => void) {
                onVisibility = listener;
                return { dispose() {} };
            },
            onDidDispose(listener: () => void) {
                onDispose = listener;
                return { dispose() {} };
            },
            reveal() {},
            dispose: () => onDispose()
        };
        activePanel = panel as unknown as WebviewPanel;
        manager = {
            getMultiDayStats: async () => {
                await state.waits[state.queries++];
                if (state.failQuery) {
                    throw new Error('query failed');
                }
                return { dayCount: 2 } as Awaited<ReturnType<TokenUsagesManager['getMultiDayStats']>>;
            }
        };
        const view = new MultiDayView({ subscriptions: [] } as never);
        Object.defineProperty(view, 'getWebviewContent', { value: () => '' });
        context.after(() => view.dispose());
        view.show();
        const actions = view as unknown as { handleMessage(message: WebViewMessage): Promise<void> };
        const query = (dateFrom = '2026-10-01', dateTo = '2026-10-02') =>
            actions.handleMessage({
                command: 'getMultiDayAnalysis',
                dateFrom,
                dateTo,
                requestId: state.queries + 1
            });
        const tick = async (milliseconds: number) => {
            context.mock.timers.tick(milliseconds);
            await Promise.resolve();
        };
        return { view, panel, messages, state, query, tick, visibility: () => onVisibility() };
    };

    await suite.test('a missed notification is repaired by a later visible cycle', async context => {
        const f = setup(context);
        await f.query();
        assert.equal(f.state.queries, 1);
        f.messages.length = 0;
        await f.tick(60000);
        assert.equal(f.messages.length, 0);
        await f.tick(5000);
        assert.deepEqual(f.messages, [{ command: 'refreshMultiDayAnalysis' }]);
        await f.query();
        assert.equal(f.state.queries, 2);
        assert.equal(f.messages.at(-1)?.command, 'updateMultiDayAnalysis');
    });

    await suite.test('notification, reveal and visibility triggers share one debounce', async context => {
        const f = setup(context);
        for (const listener of listeners) {
            listener();
            listener();
        }
        f.view.show();
        f.visibility();
        await f.tick(4999);
        assert.equal(f.messages.length, 0);
        await f.tick(1);
        assert.deepEqual(f.messages, [{ command: 'refreshMultiDayAnalysis' }]);
    });

    await suite.test('hidden cycles do no work and becoming visible requests a refresh', async context => {
        const f = setup(context);
        f.panel.visible = false;
        await f.tick(180000);
        assert.equal(f.state.attempts, 0);
        f.panel.visible = true;
        f.visibility();
        await f.tick(5000);
        assert.deepEqual(f.messages, [{ command: 'refreshMultiDayAnalysis' }]);
    });

    await suite.test('revealing an existing panel requests a refresh without a visibility event', async context => {
        const f = setup(context);
        f.view.show();
        await f.tick(5000);
        assert.deepEqual(f.messages, [{ command: 'refreshMultiDayAnalysis' }]);
    });

    for (const failure of ['false', 'reject'] as const) {
        await suite.test(`a ${failure} refresh delivery is retried next cycle`, async context => {
            const f = setup(context);
            f.state.delivery = failure;
            await f.tick(60000);
            await f.tick(5000);
            assert.equal(f.state.attempts, 1);
            assert.equal(f.messages.length, 0);
            f.state.delivery = 'ok';
            await f.tick(60000);
            await f.tick(5000);
            assert.deepEqual(f.messages, [{ command: 'refreshMultiDayAnalysis' }]);
        });
    }

    await suite.test('a failed query is repaired by the next refresh request', async context => {
        const f = setup(context);
        f.state.failQuery = true;
        await f.query();
        assert.equal(f.messages.at(-1)?.command, 'multiDayError');
        f.state.failQuery = false;
        await f.tick(60000);
        await f.tick(5000);
        assert.equal(f.messages.at(-1)?.command, 'refreshMultiDayAnalysis');
        await f.query();
        assert.equal(f.state.queries, 2);
        assert.equal(f.messages.at(-1)?.command, 'updateMultiDayAnalysis');
    });

    for (const order of ['timer-first', 'query-first'] as const) {
        await suite.test(`background refresh waits for analysis with ${order}`, async context => {
            const f = setup(context);
            const blocked = gate();
            f.state.waits.push(blocked.promise);
            if (order === 'timer-first') {
                f.view.show();
                await f.tick(4999);
            }
            const work = f.query();
            try {
                for (const listener of listeners) {
                    listener();
                    listener();
                }
                f.visibility();
                f.view.show();
                await f.tick(185000);
                assert.equal(f.state.queries, 1);
                assert.equal(f.messages.length, 0);
                blocked.release();
                await work;
                assert.equal(f.messages.at(-1)?.command, 'updateMultiDayAnalysis');
                await f.tick(4999);
                assert.equal(f.messages.length, 1);
                await f.tick(1);
                assert.equal(f.messages.filter(message => message.command === 'refreshMultiDayAnalysis').length, 1);
            } finally {
                blocked.release();
                await work;
            }
        });
    }

    for (const oldFails of [false, true]) {
        await suite.test(
            `a superseded query cannot release the current analysis; old failure=${oldFails}`,
            async context => {
                const f = setup(context);
                const old = gate();
                const current = gate();
                f.state.waits.push(old.promise, current.promise);
                const first = f.query();
                f.visibility();
                const second = f.query('2026-09-01', '2026-09-02');
                try {
                    assert.equal(f.state.queries, 2);
                    f.state.failQuery = oldFails;
                    old.release();
                    await first;
                    f.state.failQuery = false;
                    await f.tick(5000);
                    assert.equal(f.messages.length, 0);
                    current.release();
                    await second;
                    const response = f.messages.at(-1);
                    assert.ok(response?.command === 'updateMultiDayAnalysis');
                    assert.equal(response.requestId, 2);
                    await f.tick(5000);
                    assert.equal(f.messages.filter(message => message.command === 'refreshMultiDayAnalysis').length, 1);
                } finally {
                    old.release();
                    current.release();
                    await Promise.all([first, second]);
                }
            }
        );
    }

    for (const failure of ['query', 'false', 'reject'] as const) {
        await suite.test(`pending refresh is drained after ${failure} failure`, async context => {
            const f = setup(context);
            const blocked = gate();
            f.state.waits.push(blocked.promise);
            const work = f.query();
            try {
                f.visibility();
                f.state.failQuery = failure === 'query';
                f.state.delivery = failure === 'query' ? 'ok' : failure;
                blocked.release();
                await work;
                f.state.failQuery = false;
                f.state.delivery = 'ok';
                await f.tick(5000);
                assert.equal(f.messages.filter(message => message.command === 'refreshMultiDayAnalysis').length, 1);
                await f.query();
                assert.equal(f.messages.at(-1)?.command, 'updateMultiDayAnalysis');
            } finally {
                blocked.release();
                await work;
            }
        });
    }

    await suite.test('closing and reopening fences old query results and pending refreshes', async context => {
        const f = setup(context);
        const old = gate();
        const current = gate();
        f.state.waits.push(old.promise, current.promise);
        const first = f.query();
        f.visibility();
        f.view.dispose();
        f.view.show();
        const second = f.query();
        try {
            old.release();
            await first;
            await f.tick(5000);
            assert.equal(f.messages.length, 0);
            current.release();
            await second;
            const response = f.messages.at(-1);
            assert.ok(response?.command === 'updateMultiDayAnalysis');
            assert.equal(response.requestId, 2);
            await f.tick(5000);
            assert.equal(f.messages.length, 1);
        } finally {
            old.release();
            current.release();
            await Promise.all([first, second]);
        }
    });

    await suite.test(
        'closing clears pending and periodic refreshes and reopening restores them once',
        async context => {
            const f = setup(context);
            for (const listener of listeners) {
                listener();
            }
            f.view.dispose();
            assert.equal(listeners.size, 0);
            await f.tick(180000);
            assert.equal(f.state.attempts, 0);
            f.view.show();
            assert.equal(listeners.size, 1);
            await f.tick(60000);
            await f.tick(5000);
            assert.deepEqual(f.messages, [{ command: 'refreshMultiDayAnalysis' }]);
        }
    );
});
