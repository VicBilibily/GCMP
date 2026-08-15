import assert from 'node:assert/strict';
import test from 'node:test';

import { Gcra, intervalFromPerMinute, intervalFromPerSecond } from './gcra';

test('acquire 首次请求立即放行（空桶无突发）', () => {
    const g = new Gcra({ emissionIntervalMs: 1000 });
    assert.equal(g.acquire(1, 0), 0);
});

test('acquire 匀速 pacing：连续请求按间隔排队', () => {
    const g = new Gcra({ emissionIntervalMs: 1000 });
    assert.equal(g.acquire(1, 0), 0); // tat=1000
    assert.equal(g.acquire(1, 0), 1000); // tat=2000
    assert.equal(g.acquire(1, 0), 2000); // tat=3000
    assert.equal(g.acquire(1, 3000), 0); // 时间推进后立即可用
});

test('acquire 支持 cost 乘法（token 维）', () => {
    const g = new Gcra({ emissionIntervalMs: 10 });
    assert.equal(g.acquire(100, 0), 0); // tat=1000
    assert.equal(g.acquire(50, 0), 1000); // tat=1500
});

test('时间流逝后 tat 不追溯历史欠款', () => {
    const g = new Gcra({ emissionIntervalMs: 1000 });
    g.acquire(1, 0); // tat=1000
    // 10 秒后再来：tat 早已过去，start=now，不应补偿性多放
    assert.equal(g.acquire(1, 10_000), 0);
    assert.equal(g.acquire(1, 10_000), 1000);
});

test('refund 向后返还未来容量', () => {
    const g = new Gcra({ emissionIntervalMs: 1000 });
    g.acquire(1, 0); // tat=1000
    g.acquire(1, 0); // tat=2000
    g.refund(1, 0); // tat=1000
    assert.equal(g.peek(0).waitMs, 1000);
});

test('refund 不会把 tat 退到 now 之前', () => {
    const g = new Gcra({ emissionIntervalMs: 1000 });
    g.acquire(1, 0); // tat=1000
    g.refund(5, 500); // 退过量
    assert.equal(g.peek(500).waitMs, 0);
});

test('interval 换算', () => {
    assert.equal(intervalFromPerMinute(60), 1000);
    assert.equal(intervalFromPerSecond(2), 500);
});

test('cost<=0 与非法 interval 防御', () => {
    assert.throws(() => new Gcra({ emissionIntervalMs: 0 }));
    const g = new Gcra({ emissionIntervalMs: 1000 });
    assert.equal(g.acquire(0, 0), 0);
    g.refund(0, 0);
});
