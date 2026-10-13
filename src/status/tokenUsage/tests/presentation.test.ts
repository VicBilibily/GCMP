import assert from 'node:assert/strict';
import test from 'node:test';
import { allowedCommands, createStatusBarHost, settle, snapshot, tooltip } from './fixture';

test('token usage status presentation preserves totals, costs and command safety', { concurrency: false }, async t => {
    const host = await createStatusBarHost(t);

    await t.test('status presentation uses supplied aggregate totals without recreating provider sums', async c => {
        const { item } = await host.start(c, async () => {
            const value = snapshot(3);
            value.stats.providers = {};
            return value;
        });
        assert.match(item.text, /225/);
        assert.match(tooltip(item).value, /合计/);
        assert.doesNotMatch(tooltip(item).value, /暂无使用记录/);
        assert.equal(host.state.dateReads, 0);
        assert.equal(host.state.detailReads, 0);
    });

    for (const language of ['zh-cn', 'en']) {
        await t.test(
            `${language} pushed snapshot renders the statistics table immediately without another query`,
            async c => {
                const { item } = await host.start(c);
                host.state.language = language;
                host.snapshots.emit(snapshot(4));
                assert.equal(host.state.reads, 1);
                assert.equal(item.text, '$(layers) 300 $0.04');
                const md = tooltip(item);
                const rows = md.value.split('\n').filter(line => line.startsWith('|'));
                assert.equal(rows.length, 3);
                assert.equal(
                    rows[0],
                    language === 'zh-cn' ?
                        '| 提供商 | 输入(+缓存)+输出=消耗Tokens | 预估成本 | 请求数 | 平均延迟 | 平均速度 |'
                    :   '| Provider | Input(+Cache)+Output=Total | Cost | Requests | Latency | Speed |'
                );
                assert.equal(rows[2], '| Test Provider | 160(+40)+100=300 | $0.04 | 4 | 250 ms | 12.5 t/s |');
                assert.ok(
                    md.value.includes(language === 'zh-cn' ? 'GCMP: 今日 Token 消耗统计' : "GCMP: Today's Token Usage")
                );
                assert.doesNotMatch(
                    md.value,
                    /请求时间|Request Time|\| 状态 \||\| Status \||TTFT|\| 明细 \||\| Details \||requestId|modelId/
                );
                for (const command of allowedCommands.slice(0, 3)) {
                    assert.ok(md.value.includes(`](command:${command})`));
                }
                const labels =
                    language === 'zh-cn' ?
                        ['点击查看详情', 'API Key 管理', '设置辅助工具模型']
                    :   ['Click to view details', 'Manage API Keys', 'Set auxiliary tool models'];
                for (const label of labels) {
                    assert.ok(md.value.includes(`[${label}]`));
                }
                assert.deepEqual(md.isTrusted, { enabledCommands: allowedCommands });
                await settle();
                assert.equal(host.state.reads, 1);
            }
        );
    }

    for (const language of ['zh-cn', 'en']) {
        await t.test(`${language} preserves mixed-currency provider costs and the appropriate total`, async c => {
            const { item } = await host.start(c);
            host.state.language = language;
            const mixed = snapshot(6, { nativeCosts: { totalUsd: 0.02, totalRmb: 0.28 } });
            mixed.stats.providers = {
                usd: { ...snapshot().stats.total, providerName: 'USD Provider' },
                rmb: {
                    ...snapshot(4).stats.total,
                    providerName: 'RMB Provider',
                    rmbExactRequests: 4,
                    nativeCosts: { totalUsd: 0, totalRmb: 0.28 }
                }
            };
            host.snapshots.emit(mixed);
            assert.equal(item.text, language === 'zh-cn' ? '$(layers) 450 $0.02+¥0.28' : '$(layers) 450 $0.06');
            const rows = tooltip(item)
                .value.split('\n')
                .filter(line => line.startsWith('|'));
            assert.match(rows[2], language === 'zh-cn' ? /RMB Provider.*\| ¥0\.28 \|/ : /RMB Provider.*\| \$0\.04 \|/);
            assert.match(rows[3], /USD Provider.*\| \$0\.02 \|/);
            assert.ok(rows[4].includes(language === 'zh-cn' ? '|  | **6** |' : '| **$0.06** | **6** |'));
            assert.match(rows[4], /=\*\*450\*\*.*\*\*250 ms\*\*.*\*\*12\.5 t\/s\*\*/);
            assert.equal(host.state.reads, 1);
        });
    }

    await t.test(
        'provider names cannot inject command links, HTML or extra rows and trust is only an allowlist',
        async c => {
            const { item } = await host.start(c);
            const malicious = snapshot();
            malicious.stats.providers.test.providerName = '[Injected](command:gcmp.evil)|<b>*x*`\\\nFake | Row';
            host.snapshots.emit(malicious);
            const md = tooltip(item);
            assert.ok(md.value.includes('\\[Injected\\]\\(command:gcmp.evil\\)\\|\\<b\\>\\*x\\*\\`\\\\ Fake \\| Row'));
            assert.doesNotMatch(md.value, /(?<!\\)\[Injected\]\(command:|<b>|\nFake/);
            const commands = [...md.value.matchAll(/(?<!\\)\[[^\]\n]+\]\(command:([\w.]+)\)/g)].map(match => match[1]);
            assert.deepEqual(commands, allowedCommands.slice(0, 3));
            assert.deepEqual(md.isTrusted, { enabledCommands: allowedCommands });
            assert.equal(md.supportHtml, true);
            assert.equal(host.state.reads, 1);
        }
    );
});
