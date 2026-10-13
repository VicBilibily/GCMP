import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';
import {
    freezeUsageStatusStats,
    type UsageStatusSnapshot,
    type UsageStatusStats,
    type UsageStatusTotals
} from '../../../usages/status/snapshot';
import type { TokenUsageStatusBar } from '../../tokenUsageStatusBar';
import type { UsageStatusPresentation } from '../presentation';
import { allowedCommands, createStatusBarHost, deferred, settle, snapshot, tooltip } from './fixture';

type PresentationProbe = Pick<UsageStatusPresentation, 'render'> & {
    tableCostMode(stats: UsageStatusStats): 'USD' | 'RMB' | 'MIXED';
    preferredCurrency(stats: UsageStatusTotals): 'USD' | 'RMB';
};

function spyPresentation(context: TestContext, bar: TokenUsageStatusBar) {
    const { presentation } = bar as unknown as { presentation: PresentationProbe };
    return {
        render: context.mock.method(presentation, 'render'),
        mode: context.mock.method(presentation, 'tableCostMode'),
        currency: context.mock.method(presentation, 'preferredCurrency')
    };
}

test('token usage presentation avoids unnecessary work', { concurrency: false }, async t => {
    const host = await createStatusBarHost(t);
    const assertReads = (reads: number): void => {
        assert.deepEqual([host.state.reads, host.state.dateReads, host.state.detailReads], [reads, 0, 0]);
    };

    await t.test('pending initialization shows Loading once and renders normally after resolution', async c => {
        const pending = deferred<UsageStatusSnapshot>();
        const { bar, item } = await host.start(c, () => pending.promise);
        const { render } = spyPresentation(c, bar);
        const loading = { text: item.text, tooltip: item.tooltip, shows: item.shows };
        const pendingRenders = render.mock.callCount();
        await bar.initialize();
        const repeatedShows = item.shows;
        const value = snapshot();
        pending.resolve(value);
        await settle();
        assertReads(1);
        assert.equal(host.state.created, 1);
        assert.equal(pendingRenders, 0);
        assert.equal(repeatedShows, loading.shows);
        assert.equal(loading.text, '$(layers)');
        assert.equal(loading.tooltip, '正在加载 Token 统计...');
        assert.equal(render.mock.callCount(), 1);
        assert.strictEqual(render.mock.calls[0].arguments[0], value.stats);
        assert.equal(item.text, '$(layers) 150 $0.02');
        assert.match(tooltip(item).value, /Test Provider/);
        assert.equal(loading.shows, 1);
        assert.equal(item.shows, 2);
    });

    for (const requests of [0, 2]) {
        await t.test(`same-day failures preserve the existing presentation (requests=${requests})`, async c => {
            const { bar, item } = await host.start(c, async () => snapshot(requests));
            const { render } = spyPresentation(c, bar);
            const before = { text: item.text, tooltip: tooltip(item), shows: item.shows };
            const error = new Error('Snapshot unavailable');
            host.state.read = async () => {
                throw error;
            };
            await bar.updateDisplay();
            await bar.updateDisplay();
            assertReads(3);
            assert.deepEqual(host.state.errors, [error, error]);
            assert.equal(item.text, before.text);
            assert.equal(tooltip(item).value, before.tooltip.value);
            assert.equal(render.mock.callCount(), 0);
            assert.equal(item.shows, before.shows);
            assert.strictEqual(tooltip(item), before.tooltip);
        });
    }

    for (const enabled of [true, false]) {
        await t.test(`role/HAR changes survive a failed query (enabled=${enabled})`, async c => {
            const { bar, item } = await host.start(c);
            if (!enabled) {
                host.state.leader = true;
                host.state.har = true;
                host.role.emit();
            }
            const { render } = spyPresentation(c, bar);
            const shows = item.shows;
            const gate = deferred<void>();
            const error = new Error('Late failure after presentation changes');
            host.state.read = async () => {
                await gate.promise;
                throw error;
            };
            const refresh = bar.updateDisplay();
            host.state.leader = enabled;
            host.role.emit();
            host.state.har = enabled;
            const roleTooltip = tooltip(item);
            host.configure('gcmp.unrelated');
            const unrelatedTooltip = tooltip(item);
            host.configure();
            const current = tooltip(item);
            gate.resolve();
            await refresh;
            assertReads(2);
            assert.deepEqual(host.state.errors, [error]);
            assert.strictEqual(unrelatedTooltip, roleTooltip);
            assert.notStrictEqual(current, roleTooltip);
            assert.match(current.value, enabled ? /主实例/ : /从实例/);
            assert.equal(current.value.includes(`PID ${process.pid}`), enabled);
            assert.equal(current.value.includes('](command:gcmp.har.revealCurrent)'), enabled);
            assert.equal(item.text, `${enabled ? '$(layers-dot)' : '$(layers)'} 150 $0.02`);
            assert.deepEqual(current.isTrusted, { enabledCommands: allowedCommands });
            assert.equal(render.mock.callCount(), 2);
            assert.equal(item.shows - shows, 2);
            assert.strictEqual(tooltip(item), current);
        });
    }

    for (const cache of ['unknown', 'cleared', 'previous-day']) {
        await t.test(`failure without a valid cache stays Loading (${cache})`, async c => {
            const { bar, item } = await host.start(c, async () => (cache === 'unknown' ? undefined : snapshot()));
            if (cache === 'cleared') {
                host.state.read = async () => undefined;
                await bar.updateDisplay();
            }
            if (cache === 'previous-day') {
                c.mock.timers.setTime(new Date(2026, 9, 14).getTime());
            }
            const { render } = spyPresentation(c, bar);
            const shows = item.shows;
            const gate = deferred<void>();
            const error = new Error('No current statistics');
            host.state.read = async () => {
                await gate.promise;
                throw error;
            };
            const refresh = bar.updateDisplay();
            const loading = { text: item.text, tooltip: item.tooltip, shows: item.shows };
            gate.resolve();
            await refresh;
            assertReads(cache === 'cleared' ? 3 : 2);
            assert.deepEqual(host.state.errors, [error]);
            assert.deepEqual(loading, { text: '$(layers)', tooltip: '正在加载 Token 统计...', shows: shows + 1 });
            assert.equal(item.text, loading.text);
            assert.equal(item.tooltip, loading.tooltip);
            assert.equal(render.mock.callCount(), 0);
            assert.equal(item.shows - shows, 2);
        });
    }

    for (const boundary of ['push', 'midnight', 'dispose']) {
        await t.test(`late errors cannot write back after ${boundary}`, async c => {
            const { bar, item } = await host.start(c);
            const { render } = spyPresentation(c, bar);
            const gate = deferred<void>();
            const error = new Error('Superseded query');
            host.state.read = async () => {
                await gate.promise;
                throw error;
            };
            const refresh = bar.updateDisplay();
            if (boundary === 'push') {
                host.snapshots.emit(snapshot(8));
            } else if (boundary === 'midnight') {
                c.mock.timers.setTime(new Date(2026, 9, 14).getTime());
            } else {
                bar.dispose();
            }
            const before = { text: item.text, tooltip: tooltip(item), shows: item.shows };
            gate.resolve();
            await refresh;
            assertReads(2);
            assert.deepEqual(host.state.errors, [error]);
            assert.equal(item.text, boundary === 'push' ? '$(layers) 600 $0.08' : '$(layers) 150 $0.02');
            assert.equal(item.text, before.text);
            assert.strictEqual(tooltip(item), before.tooltip);
            assert.equal(item.shows, before.shows);
            assert.equal(render.mock.callCount(), boundary === 'push' ? 1 : 0);
        });
    }

    const cases = [
        { language: 'zh-cn', providers: 0, requests: 0 },
        { language: 'zh-cn', providers: 0, requests: 6 },
        { language: 'zh-cn', providers: 1, requests: 6 },
        { language: 'en', providers: 1, requests: 6 },
        { language: 'zh-cn', providers: 2, requests: 6 },
        { language: 'en', providers: 2, requests: 6 }
    ];
    for (const { language, providers, requests } of cases) {
        await t.test(`${language} table cost mode budget (${providers} providers, ${requests} requests)`, async c => {
            const { bar, item } = await host.start(c);
            const { render, mode, currency } = spyPresentation(c, bar);
            const previousTooltip = tooltip(item);
            const shows = item.shows;
            host.state.language = language;
            const chinese = language === 'zh-cn';
            const value = snapshot(requests, {
                rmbExactRequests: requests,
                nativeCosts: { totalUsd: 0, totalRmb: requests * 0.07 }
            });
            const maliciousName = '[Injected](command:gcmp.evil)|<b>*x*`\\\nFake | Row';
            const escapedName = '\\[Injected\\]\\(command:gcmp.evil\\)\\|\\<b\\>\\*x\\*\\`\\\\ Fake \\| Row';
            if (providers === 0) {
                value.stats.providers = {};
            } else if (providers === 1) {
                value.stats.providers.test.providerName = maliciousName;
            } else {
                value.stats.total.rmbExactRequests = 4;
                value.stats.total.nativeCosts = { totalUsd: 0.02, totalRmb: 0.28 };
                value.stats.providers = {
                    usd: { ...snapshot().stats.total, providerName: 'USD Provider' },
                    rmb: {
                        ...snapshot(4).stats.total,
                        providerName: 'RMB Provider',
                        rmbExactRequests: 4,
                        nativeCosts: { totalUsd: 0, totalRmb: 0.28 }
                    }
                };
            }
            freezeUsageStatusStats(value.stats);
            host.snapshots.emit(value);
            const md = tooltip(item);
            const rows = md.value.split('\n').filter(line => line.startsWith('|'));
            assertReads(1);
            assert.equal(render.mock.callCount(), 1);
            assert.strictEqual(render.mock.calls[0].arguments[0], value.stats);
            assert.equal(item.shows - shows, 1);
            assert.notStrictEqual(md, previousTooltip);
            assert.deepEqual(md.isTrusted, { enabledCommands: allowedCommands });
            assert.equal(md.supportHtml, true);
            const commands = [...md.value.matchAll(/(?<!\\)\[[^\]\n]+\]\(command:([\w.]+)\)/g)].map(match => match[1]);
            assert.deepEqual(commands, allowedCommands.slice(0, 3));
            assert.doesNotMatch(md.value, /(?<!\\)\[Injected\]\(command:|<b>|\nFake/);
            assert.doesNotMatch(md.value, /requestId|modelId|TTFT|Request Time|请求时间/);
            if (requests === 0) {
                assert.equal(item.text, '$(layers)');
                assert.match(md.value, /暂无使用记录/);
                assert.equal(rows.length, 0);
            } else {
                assert.equal(
                    item.text,
                    chinese ? `$(layers) 450 ${providers === 2 ? '$0.02+¥0.28' : '¥0.42'}` : '$(layers) 450 $0.06'
                );
                assert.equal(
                    rows[0],
                    chinese ?
                        '| 提供商 | 输入(+缓存)+输出=消耗Tokens | 预估成本 | 请求数 | 平均延迟 | 平均速度 |'
                    :   '| Provider | Input(+Cache)+Output=Total | Cost | Requests | Latency | Speed |'
                );
                if (providers < 2) {
                    assert.equal(rows.length, 3);
                    assert.equal(
                        rows[2],
                        `| ${providers === 0 ? '合计' : escapedName} | 240(+60)+150=450 | ${chinese ? '¥0.42' : '$0.06'} | 6 | 250 ms | 12.5 t/s |`
                    );
                } else {
                    assert.equal(rows.length, 5);
                    assert.equal(
                        rows[2],
                        `| RMB Provider | 160(+40)+100=300 | ${chinese ? '¥0.28' : '$0.04'} | 4 | 250 ms | 12.5 t/s |`
                    );
                    assert.equal(rows[3], '| USD Provider | 80(+20)+50=150 | $0.02 | 2 | 250 ms | 12.5 t/s |');
                    assert.equal(
                        rows[4],
                        `| **${chinese ? '合计' : 'Total'}** | 240(+60)+150=**450** | ${chinese ? '' : '**$0.06**'} | **6** | **250 ms** | **12.5 t/s** |`
                    );
                }
            }
            assert.equal(mode.mock.callCount(), providers > 1 ? 1 : 0);
            if (providers > 1) {
                assert.strictEqual(mode.mock.calls[0].arguments[0], value.stats);
                assert.equal(mode.mock.calls[0].result, chinese ? 'MIXED' : 'USD');
                assert.equal(currency.mock.callCount(), chinese ? 4 : 2);
            }
        });
    }
});
