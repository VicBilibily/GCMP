import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';
import { freezeUsageStatusStats, type UsageStatusSnapshot } from '../../../usages/status/snapshot';
import type { UsageStatusPresentation } from '../presentation';
import { createStatusBarHost, deferred, settle, snapshot, tooltip } from './fixture';

function frozenSnapshot(requests = 2): UsageStatusSnapshot {
    const value = snapshot(requests);
    freezeUsageStatusStats(value.stats);
    return Object.freeze(value);
}

test(
    'token usage status bar reuses unchanged snapshot presentation',
    { concurrency: false },
    async (t: TestContext) => {
        const host = await createStatusBarHost(t);
        const start = async (context: TestContext) => {
            let fixed: UsageStatusSnapshot | undefined;
            const { bar, item } = await host.start(context, async () => (fixed ??= frozenSnapshot()));
            assert.ok(fixed);
            assert.ok(Object.isFrozen(fixed));
            assert.ok(Object.isFrozen(fixed.stats));
            assert.equal(host.state.reads, 1);
            const { presentation } = bar as unknown as { presentation: Pick<UsageStatusPresentation, 'render'> };
            const render = context.mock.method(presentation, 'render');
            return { bar, item, fixed, render, shows: item.shows, initialTooltip: tooltip(item) };
        };

        await t.test('ordinary queries keep their read count without rendering the same snapshot again', async c => {
            const { bar, item, render, shows, initialTooltip } = await start(c);
            for (let index = 1; index <= 3; index++) {
                await bar.updateDisplay();
                assert.equal(host.state.reads, index + 1);
            }
            assert.equal(render.mock.callCount(), 0);
            assert.equal(item.shows - shows, 0);
            assert.strictEqual(tooltip(item), initialTooltip);
            assert.equal(item.text, '$(layers) 150 $0.02');
        });

        await t.test('periodic queries keep their read count without rendering the same snapshot again', async c => {
            const { item, render, shows, initialTooltip } = await start(c);
            for (let index = 1; index <= 3; index++) {
                c.mock.timers.tick(30000);
                await settle();
                assert.equal(host.state.reads, index + 1);
            }
            assert.equal(render.mock.callCount(), 0);
            assert.equal(item.shows - shows, 0);
            assert.strictEqual(tooltip(item), initialTooltip);
            assert.equal(item.text, '$(layers) 150 $0.02');
        });

        await t.test('repeated pushes of the same snapshot neither query nor render', async c => {
            const { item, fixed, render, shows, initialTooltip } = await start(c);
            for (let index = 0; index < 3; index++) {
                host.snapshots.emit(fixed);
            }
            await settle();
            assert.equal(host.state.reads, 1);
            assert.equal(render.mock.callCount(), 0);
            assert.equal(item.shows - shows, 0);
            assert.strictEqual(tooltip(item), initialTooltip);
            assert.equal(item.text, '$(layers) 150 $0.02');
        });

        await t.test('new snapshot envelopes sharing the same stats also reuse the presentation', async c => {
            const { bar, item, fixed, render, shows, initialTooltip } = await start(c);
            const queried = Object.freeze({ ...fixed, revision: fixed.revision + 1 });
            const pushed = Object.freeze({ ...fixed, revision: fixed.revision + 2 });
            assert.notStrictEqual(queried, fixed);
            assert.notStrictEqual(pushed, queried);
            assert.strictEqual(queried.stats, fixed.stats);
            assert.strictEqual(pushed.stats, fixed.stats);
            host.state.read = async () => queried;
            await bar.updateDisplay();
            host.snapshots.emit(pushed);
            await settle();
            assert.equal(host.state.reads, 2);
            assert.equal(render.mock.callCount(), 0);
            assert.equal(item.shows - shows, 0);
            assert.strictEqual(tooltip(item), initialTooltip);
        });

        await t.test('equal-valued new stats objects render for both queries and pushes', async c => {
            const { bar, item, fixed, render, shows, initialTooltip } = await start(c);
            const queried = frozenSnapshot();
            const pushed = frozenSnapshot();
            assert.deepEqual(queried, fixed);
            assert.deepEqual(pushed, fixed);
            assert.notStrictEqual(queried.stats, fixed.stats);
            assert.notStrictEqual(pushed.stats, queried.stats);
            host.state.read = async () => queried;
            await bar.updateDisplay();
            const queryTooltip = tooltip(item);
            assert.equal(host.state.reads, 2);
            assert.equal(render.mock.callCount(), 1);
            assert.equal(item.shows - shows, 1);
            assert.strictEqual(render.mock.calls[0].arguments[0], queried.stats);
            assert.notStrictEqual(queryTooltip, initialTooltip);
            assert.equal(queryTooltip.value, initialTooltip.value);
            host.snapshots.emit(pushed);
            await settle();
            assert.equal(host.state.reads, 2);
            assert.equal(render.mock.callCount(), 2);
            assert.equal(item.shows - shows, 2);
            assert.strictEqual(render.mock.calls[1].arguments[0], pushed.stats);
            assert.notStrictEqual(tooltip(item), queryTooltip);
            assert.equal(tooltip(item).value, initialTooltip.value);
            assert.equal(item.text, '$(layers) 150 $0.02');
        });

        await t.test('both role transitions explicitly render the same cached stats without querying', async c => {
            const { item, fixed, render, shows, initialTooltip } = await start(c);
            assert.match(initialTooltip.value, /从实例/);
            host.state.leader = true;
            host.role.emit();
            const leaderTooltip = tooltip(item);
            assert.equal(render.mock.callCount(), 1);
            assert.equal(item.shows - shows, 1);
            assert.strictEqual(render.mock.calls[0].arguments[0], fixed.stats);
            assert.notStrictEqual(leaderTooltip, initialTooltip);
            assert.equal(item.text, '$(layers-dot) 150 $0.02');
            assert.match(leaderTooltip.value, /主实例/);
            host.state.leader = false;
            host.role.emit();
            await settle();
            assert.equal(host.state.reads, 1);
            assert.equal(render.mock.callCount(), 2);
            assert.equal(item.shows - shows, 2);
            assert.strictEqual(render.mock.calls[1].arguments[0], fixed.stats);
            assert.notStrictEqual(tooltip(item), leaderTooltip);
            assert.equal(tooltip(item).value, initialTooltip.value);
            assert.equal(item.text, '$(layers) 150 $0.02');
        });

        await t.test('HAR enable and disable explicitly render cached stats but unrelated settings do not', async c => {
            const { item, fixed, render, shows, initialTooltip } = await start(c);
            host.state.har = true;
            host.configure('gcmp.unrelated');
            assert.equal(render.mock.callCount(), 0);
            assert.equal(item.shows - shows, 0);
            assert.strictEqual(tooltip(item), initialTooltip);
            host.configure();
            const harTooltip = tooltip(item);
            assert.equal(render.mock.callCount(), 1);
            assert.equal(item.shows - shows, 1);
            assert.strictEqual(render.mock.calls[0].arguments[0], fixed.stats);
            assert.notStrictEqual(harTooltip, initialTooltip);
            assert.ok(harTooltip.value.includes(`PID ${process.pid}`));
            assert.match(harTooltip.value, /\[打开 HAR 文件\]\(command:gcmp\.har\.revealCurrent\)/);
            host.state.har = false;
            host.configure();
            await settle();
            assert.equal(host.state.reads, 1);
            assert.equal(render.mock.callCount(), 2);
            assert.equal(item.shows - shows, 2);
            assert.strictEqual(render.mock.calls[1].arguments[0], fixed.stats);
            assert.notStrictEqual(tooltip(item), harTooltip);
            assert.equal(tooltip(item).value, initialTooltip.value);
            assert.doesNotMatch(tooltip(item).value, /PID|command:gcmp\.har\.revealCurrent/);
        });

        await t.test('duplicate same-object pushes still invalidate an older in-flight query', async c => {
            const { bar, item, fixed, render, shows, initialTooltip } = await start(c);
            const late = deferred<UsageStatusSnapshot>();
            host.state.read = () => late.promise;
            const pending = bar.updateDisplay();
            host.snapshots.emit(fixed);
            host.snapshots.emit(fixed);
            late.resolve(frozenSnapshot(8));
            await pending;
            await settle();
            assert.equal(host.state.reads, 2);
            assert.equal(item.text, '$(layers) 150 $0.02');
            assert.equal(tooltip(item).value, initialTooltip.value);
            assert.equal(render.mock.callCount(), 0);
            assert.equal(item.shows - shows, 0);
            assert.strictEqual(tooltip(item), initialTooltip);
        });

        await t.test('each duplicate push renews cooldown while preserving later eligible queries', async c => {
            const { item, fixed, render, shows, initialTooltip } = await start(c);
            c.mock.timers.tick(19000);
            host.snapshots.emit(fixed);
            c.mock.timers.tick(10000);
            host.snapshots.emit(fixed);
            c.mock.timers.tick(1000);
            await settle();
            assert.equal(host.state.reads, 1);
            c.mock.timers.tick(30000);
            await settle();
            assert.equal(host.state.reads, 2);
            assert.equal(render.mock.callCount(), 0);
            assert.equal(item.shows - shows, 0);
            assert.strictEqual(tooltip(item), initialTooltip);
        });

        await t.test('unchanged ordinary queries renew cooldown while preserving later eligible queries', async c => {
            const { bar, item, render, shows, initialTooltip } = await start(c);
            c.mock.timers.tick(29000);
            await bar.updateDisplay();
            assert.equal(host.state.reads, 2);
            c.mock.timers.tick(1000);
            await settle();
            assert.equal(host.state.reads, 2);
            c.mock.timers.tick(30000);
            await settle();
            assert.equal(host.state.reads, 3);
            assert.equal(render.mock.callCount(), 0);
            assert.equal(item.shows - shows, 0);
            assert.strictEqual(tooltip(item), initialTooltip);
        });
    }
);
