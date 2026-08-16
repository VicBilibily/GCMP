import assert from 'node:assert/strict';
import test from 'node:test';

import { RateLimitStore } from './rateLimitStore';

function store(defaultLeaseMs?: number): RateLimitStore {
    return new RateLimitStore('test', defaultLeaseMs);
}

test('无配置维度时立即授予', () => {
    const s = store();
    const r = s.acquire('r1', 'k', {}, { requests: 1, tokens: 10 }, 0);
    assert.equal(r.kind, 'granted');
    if (r.kind === 'granted') {
        assert.equal(r.waitMs, 0);
    }
});

test('rpm 维度：waitMs 按 60000/rpm 递增', () => {
    const s = store();
    const dims = { rpm: 60 }; // 1/s
    const r1 = s.acquire('r1', 'k', dims, { requests: 1, tokens: 0 }, 0);
    const r2 = s.acquire('r2', 'k', dims, { requests: 1, tokens: 0 }, 0);
    assert.equal(r1.kind, 'granted');
    assert.equal(r2.kind, 'granted');
    if (r1.kind === 'granted' && r2.kind === 'granted') {
        assert.equal(r1.waitMs, 0);
        assert.equal(r2.waitMs, 1000);
    }
});

test('多维度取最大 waitMs', () => {
    const s = store();
    // rpm 60 → 间隔 1000ms；tpm 6000 → token 间隔 10ms，100 tokens → 1000ms
    const dims = { rpm: 60, tpm: 6000 };
    s.acquire('r1', 'k', dims, { requests: 1, tokens: 100 }, 0);
    const r2 = s.acquire('r2', 'k', dims, { requests: 1, tokens: 100 }, 0);
    assert.equal(r2.kind, 'granted');
    if (r2.kind === 'granted') {
        assert.equal(r2.waitMs, 1000);
    }
});

test('并发满时排队，release 后 FIFO 授予', () => {
    const s = store();
    const dims = { parallel: 1 };
    const r1 = s.acquire('r1', 'k', dims, { requests: 1, tokens: 0 }, 0);
    assert.equal(r1.kind, 'granted');
    const r2 = s.acquire('r2', 'k', dims, { requests: 1, tokens: 0 }, 0);
    const r3 = s.acquire('r3', 'k', dims, { requests: 1, tokens: 0 }, 0);
    assert.equal(r2.kind, 'queued');
    assert.equal(r3.kind, 'queued');

    if (r1.kind !== 'granted') {
        assert.fail('r1 should be granted');
    }
    const granted = s.release(r1.grantId, undefined, 100);
    assert.equal(granted.length, 1);
    assert.equal(granted[0]?.requestId, 'r2'); // FIFO

    const granted2 = s.release(granted[0]!.grantId, undefined, 200);
    assert.equal(granted2.length, 1);
    assert.equal(granted2[0]?.requestId, 'r3');
});

test('release 幂等：二次调用无效果', () => {
    const s = store();
    const r1 = s.acquire('r1', 'k', { parallel: 1 }, { requests: 1, tokens: 0 }, 0);
    if (r1.kind !== 'granted') {
        assert.fail('r1 should be granted');
    }
    assert.equal(s.release(r1.grantId, undefined, 0).length, 0);
    assert.equal(s.release(r1.grantId, undefined, 0).length, 0);
    assert.equal(s.release('nonexistent', undefined, 0).length, 0);
});

test('release 后删除 grant 记录', () => {
    const s = store();
    const r1 = s.acquire('r1', 'k', { parallel: 1 }, { requests: 1, tokens: 0 }, 0);
    if (r1.kind !== 'granted') {
        assert.fail('r1 should be granted');
    }
    assert.equal((s as unknown as { grants: Map<string, unknown> }).grants.size, 1);
    s.release(r1.grantId, undefined, 0);
    assert.equal((s as unknown as { grants: Map<string, unknown> }).grants.size, 0);
});

test('release 后 inflight 槽位释放，重新 acquire 可 granted（本地轮询模式）', () => {
    const s = store();
    const dims = { parallel: 1 };
    const r1 = s.acquire('r1', 'k', dims, { requests: 1, tokens: 0 }, 0);
    if (r1.kind !== 'granted') {
        assert.fail('r1 should be granted');
    }
    // 第二个请求并发满 → queued
    const r2 = s.acquire('r2', 'k', dims, { requests: 1, tokens: 0 }, 0);
    assert.equal(r2.kind, 'queued');
    s.cancelPending('k', 'r2');
    // 第一个请求成功完成：release 无退款
    s.release(r1.grantId, undefined, 100);
    // 轮询重试 acquire 应 granted
    const r3 = s.acquire('r2', 'k', dims, { requests: 1, tokens: 0 }, 100);
    assert.equal(r3.kind, 'granted');
});

test('cancelPending 可使请求退出队列，后续 release 不再授予该请求', () => {
    const s = store();
    const dims = { parallel: 1 };
    const r1 = s.acquire('r1', 'k', dims, { requests: 1, tokens: 0 }, 0);
    if (r1.kind !== 'granted') {
        assert.fail('r1 should be granted');
    }

    const r2 = s.acquire('r2', 'k', dims, { requests: 1, tokens: 0 }, 0);
    const r3 = s.acquire('r3', 'k', dims, { requests: 1, tokens: 0 }, 0);
    assert.equal(r2.kind, 'queued');
    assert.equal(r3.kind, 'queued');
    assert.equal(s.stats('k', 0)?.pending, 2);

    assert.equal(s.cancelPending('k', 'r2'), true);
    assert.equal(s.cancelPending('k', 'r2'), false);
    assert.equal(s.stats('k', 0)?.pending, 1);

    const granted = s.release(r1.grantId, undefined, 100);
    assert.equal(granted.length, 1);
    assert.equal(granted[0]?.requestId, 'r3');
    assert.equal(s.stats('k', 100)?.pending, 0);
});

test('abortRequest 可清理 pending 或已授予未释放的 request', () => {
    const s = store();
    const dims = { parallel: 1 };
    const r1 = s.acquire('r1', 'k', dims, { requests: 1, tokens: 0 }, 0);
    if (r1.kind !== 'granted') {
        assert.fail('r1 should be granted');
    }
    s.acquire('r2', 'k', dims, { requests: 1, tokens: 0 }, 0);
    assert.equal(s.abortRequest('k', 'r2', 0).length, 0);
    assert.equal(s.stats('k', 0)?.pending, 0);

    const granted = s.abortRequest('k', 'r1', 100);
    assert.equal(granted.length, 0);
    assert.equal(s.stats('k', 100)?.inflight, 0);
});

test('abortRequest 对已授予但未开始的请求全额退款', () => {
    const s = store();
    const dims = { rpm: 60, tpm: 6000 };
    const costs = { requests: 1, tokens: 100 };
    const r1 = s.acquire('r1', 'k', dims, costs, 0);
    if (r1.kind !== 'granted') {
        assert.fail('r1 should be granted');
    }

    s.abortRequest('k', 'r1', 0);

    const r2 = s.acquire('r2', 'k', dims, costs, 0);
    if (r2.kind !== 'granted') {
        assert.fail('r2 should be granted');
    }
    assert.equal(r2.waitMs, 0);
});

test('取消非队尾 pacing grant 不会让后续请求重叠到同一放行时刻', () => {
    const s = store();
    const dims = { rpm: 60 };

    const r1 = s.acquire('r1', 'k', dims, { requests: 1, tokens: 0 }, 0);
    const r2 = s.acquire('r2', 'k', dims, { requests: 1, tokens: 0 }, 0);
    const r3 = s.acquire('r3', 'k', dims, { requests: 1, tokens: 0 }, 0);
    if (r1.kind !== 'granted' || r2.kind !== 'granted' || r3.kind !== 'granted') {
        assert.fail('requests should be granted');
    }

    assert.equal(r2.waitMs, 1000);
    assert.equal(r3.waitMs, 2000);

    s.abortRequest('k', 'r2', 0);

    const r4 = s.acquire('r4', 'k', dims, { requests: 1, tokens: 0 }, 0);
    if (r4.kind !== 'granted') {
        assert.fail('r4 should be granted');
    }
    assert.equal(r4.waitMs, 3000);
});

test('配置热更新后取消旧 grant 不会按新 interval 错误回拨', () => {
    const s = store();
    const costs = { requests: 1, tokens: 0 };

    const r1 = s.acquire('r1', 'k', { rpm: 60 }, costs, 0);
    const r2 = s.acquire('r2', 'k', { rpm: 60 }, costs, 0);
    const r3 = s.acquire('r3', 'k', { rpm: 1 }, costs, 0);
    if (r1.kind !== 'granted' || r2.kind !== 'granted' || r3.kind !== 'granted') {
        assert.fail('requests should be granted');
    }

    assert.equal(r3.waitMs, 2000);

    s.abortRequest('k', 'r2', 0);

    const r4 = s.acquire('r4', 'k', { rpm: 1 }, costs, 0);
    if (r4.kind !== 'granted') {
        assert.fail('r4 should be granted');
    }
    assert.equal(r4.waitMs, 62000);
});

test('tokens 退款恢复 tpm 容量', () => {
    const s = store();
    const dims = { tpm: 6000 }; // 10ms/token
    const r1 = s.acquire('r1', 'k', dims, { requests: 0, tokens: 100 }, 0);
    if (r1.kind !== 'granted') {
        assert.fail('r1 should be granted');
    }
    // 立即再来 100 tokens 要等 1000ms
    const r2 = s.acquire('r2', 'k', dims, { requests: 0, tokens: 100 }, 0);
    if (r2.kind !== 'granted') {
        assert.fail('r2 should be granted');
    }
    assert.equal(r2.waitMs, 1000);
    // r2 已经预约在 1000ms 放行，退款不能把后续请求压回到同一放行时刻
    s.release(r1.grantId, { tokens: 100 }, 0);
    const r3 = s.acquire('r3', 'k', dims, { requests: 0, tokens: 100 }, 0);
    if (r3.kind !== 'granted') {
        assert.fail('r3 should be granted');
    }
    assert.equal(r3.waitMs, 2000);
});

test('pending 可持续增长并保持 FIFO', () => {
    const s = store();
    const dims = { parallel: 1 };
    const r1 = s.acquire('r1', 'k', dims, { requests: 1, tokens: 0 }, 0);
    if (r1.kind !== 'granted') {
        assert.fail('r1 should be granted');
    }
    assert.equal(s.acquire('r2', 'k', dims, { requests: 1, tokens: 0 }, 0).kind, 'queued');
    assert.equal(s.acquire('r3', 'k', dims, { requests: 1, tokens: 0 }, 0).kind, 'queued');
    assert.equal(s.acquire('r4', 'k', dims, { requests: 1, tokens: 0 }, 0).kind, 'queued');
    assert.equal(s.stats('k', 0)?.pending, 3);
});

test('pending 顺位会在前方请求出队后前移', () => {
    const s = store();
    const dims = { parallel: 1 };
    const r1 = s.acquire('r1', 'k', dims, { requests: 1, tokens: 0 }, 0);
    if (r1.kind !== 'granted') {
        assert.fail('r1 should be granted');
    }

    s.acquire('r2', 'k', dims, { requests: 1, tokens: 0 }, 0);
    s.acquire('r3', 'k', dims, { requests: 1, tokens: 0 }, 0);
    s.acquire('r4', 'k', dims, { requests: 1, tokens: 0 }, 0);
    assert.deepEqual(s.getPendingPositions('k'), [
        { requestId: 'r2', queuePosition: 1 },
        { requestId: 'r3', queuePosition: 2 },
        { requestId: 'r4', queuePosition: 3 }
    ]);

    const granted = s.release(r1.grantId, undefined, 100);
    assert.equal(granted[0]?.requestId, 'r2');
    assert.deepEqual(s.getPendingPositions('k'), [
        { requestId: 'r3', queuePosition: 1 },
        { requestId: 'r4', queuePosition: 2 }
    ]);
});

test('pending 永不超时：sweep 不移除，等待槽位释放后 FIFO 依次放行', () => {
    const s = store();
    const dims = { parallel: 1 };
    const r1 = s.acquire('r1', 'k', dims, { requests: 1, tokens: 0 }, 0);
    if (r1.kind !== 'granted') {
        assert.fail('r1 should be granted');
    }
    s.acquire('r2', 'k', dims, { requests: 1, tokens: 0 }, 0); // queued
    s.acquire('r3', 'k', dims, { requests: 1, tokens: 0 }, 0); // queued
    // 长耗时请求 r1 未 release，sweep 任意久（lease 兜底期之外除外）都不应超时放行
    const swept = s.sweep(60_000);
    assert.equal(swept.length, 0);
    assert.equal(s.stats('k', 0)?.pending, 2);
    // r1 完成后，依次放行 r2、r3
    let granted = s.release(r1.grantId, undefined, 0);
    assert.equal(granted.length, 1);
    assert.equal(granted[0]?.requestId, 'r2');
    const r2GrantId = granted[0]!.grantId;
    granted = s.release(r2GrantId, undefined, 0);
    assert.equal(granted.length, 1);
    assert.equal(granted[0]?.requestId, 'r3');
    // 全部完成后 pending 清空
    s.sweep(1_000);
    assert.equal(s.stats('k', 1_000)?.pending, 0);
});

test('lease 过期回收槽位（Follower 崩溃兜底）', () => {
    const s = store(1000);
    const dims = { parallel: 1 };
    const r1 = s.acquire('r1', 'k', dims, { requests: 1, tokens: 0 }, 0);
    if (r1.kind !== 'granted') {
        assert.fail('r1 should be granted');
    }
    // 不 release，1 秒后租约过期
    const r2 = s.acquire('r2', 'k', dims, { requests: 1, tokens: 0 }, 2000);
    assert.equal(r2.kind, 'granted'); // 槽位已被回收
});

test('renew 会延长 lease，避免长请求被提前回收', () => {
    const s = store(1000);
    const dims = { parallel: 1 };
    const r1 = s.acquire('r1', 'k', dims, { requests: 1, tokens: 0 }, 0);
    if (r1.kind !== 'granted') {
        assert.fail('r1 should be granted');
    }

    assert.equal(s.renew(r1.grantId, 800), true);
    const r2 = s.acquire('r2', 'k', dims, { requests: 1, tokens: 0 }, 1500);
    assert.deepEqual(r2, { kind: 'queued', queuePosition: 1 });

    const swept = s.sweep(1900);
    assert.equal(swept.length, 1);
    assert.equal(swept[0]?.requestId, 'r2');
});

test('lease 从 pacing 等待结束后起算，等待期间取消仍可退款', () => {
    const s = store(1000);
    const dims = { tpm: 6000 };
    const costs = { requests: 0, tokens: 200 };
    s.acquire('r1', 'k', dims, costs, 0);
    const r2 = s.acquire('r2', 'k', dims, costs, 0);
    if (r2.kind !== 'granted') {
        assert.fail('r2 should be granted');
    }
    assert.equal(r2.waitMs, 2000);

    s.sweep(1500);
    s.release(r2.grantId, { tokens: costs.tokens }, 1500);

    const r3 = s.acquire('r3', 'k', dims, costs, 1500);
    if (r3.kind !== 'granted') {
        assert.fail('r3 should be granted');
    }
    assert.equal(r3.waitMs, 500);
});

test('lease 回收释放容量时新请求不得插队已有 pending', () => {
    const s = store(1000);
    const dims = { parallel: 1 };
    const costs = { requests: 1, tokens: 0 };
    const r1 = s.acquire('r1', 'k', dims, costs, 0);
    if (r1.kind !== 'granted') {
        assert.fail('r1 should be granted');
    }
    assert.equal(s.acquire('r2', 'k', dims, costs, 0).kind, 'queued');

    const r3 = s.acquire('r3', 'k', dims, costs, 2000);
    assert.deepEqual(r3, { kind: 'queued', queuePosition: 2 });

    const swept = s.sweep(2000);
    assert.equal(swept[0]?.requestId, 'r2');
    assert.deepEqual(s.getPendingPositions('k'), [{ requestId: 'r3', queuePosition: 1 }]);
});

test('parallel 扩容时新请求不得插队已有 pending', () => {
    const s = store();
    const costs = { requests: 1, tokens: 0 };
    const r1 = s.acquire('r1', 'k', { parallel: 1 }, costs, 0);
    if (r1.kind !== 'granted') {
        assert.fail('r1 should be granted');
    }
    assert.equal(s.acquire('r2', 'k', { parallel: 1 }, costs, 0).kind, 'queued');

    const r3 = s.acquire('r3', 'k', { parallel: 2 }, costs, 0);
    assert.deepEqual(r3, { kind: 'queued', queuePosition: 2 });

    const swept = s.sweep(0);
    assert.equal(swept[0]?.requestId, 'r2');
    assert.deepEqual(s.getPendingPositions('k'), [{ requestId: 'r3', queuePosition: 1 }]);
});

test('桶键相互隔离', () => {
    const s = store();
    const dims = { rpm: 60 };
    s.acquire('r1', 'a', dims, { requests: 1, tokens: 0 }, 0);
    const rb = s.acquire('r2', 'b', dims, { requests: 1, tokens: 0 }, 0);
    if (rb.kind !== 'granted') {
        assert.fail('rb should be granted');
    }
    assert.equal(rb.waitMs, 0); // b 桶不受 a 影响
});

test('stats 快照', () => {
    const s = store();
    const dims = { rpm: 60, parallel: 2 };
    s.acquire('r1', 'k', dims, { requests: 1, tokens: 0 }, 0);
    const st = s.stats('k', 0);
    assert.ok(st);
    assert.equal(st.inflight, 1);
    assert.equal(st.pending, 0);
    assert.equal(st.waitMs, 1000);
    assert.equal(s.stats('unknown', 0), undefined);
});

test('配置热更新：rpm 10→5 后 interval 立即生效（保留 tat）', () => {
    const s = store();
    // rpm=10 → interval 6s
    const r1 = s.acquire('r1', 'k', { rpm: 10 }, { requests: 1, tokens: 0 }, 0);
    if (r1.kind !== 'granted') {
        assert.fail('r1 should be granted');
    }
    assert.equal(r1.waitMs, 0);
    const r2 = s.acquire('r2', 'k', { rpm: 10 }, { requests: 1, tokens: 0 }, 0);
    if (r2.kind !== 'granted') {
        assert.fail('r2 should be granted');
    }
    assert.equal(r2.waitMs, 6000); // tat=12000

    // 热更新为 rpm=5 → interval 12s；tat 保留在 12000，后续按新间隔推进
    const r3 = s.acquire('r3', 'k', { rpm: 5 }, { requests: 1, tokens: 0 }, 12000);
    if (r3.kind !== 'granted') {
        assert.fail('r3 should be granted');
    }
    assert.equal(r3.waitMs, 0); // tat 到期，立即放行；tat=12000+12000=24000
    const r4 = s.acquire('r4', 'k', { rpm: 5 }, { requests: 1, tokens: 0 }, 12000);
    if (r4.kind !== 'granted') {
        assert.fail('r4 should be granted');
    }
    assert.equal(r4.waitMs, 12000); // 新 interval 生效
});

test('配置热更新：维度被移除后不再限流', () => {
    const s = store();
    s.acquire('r1', 'k', { rpm: 60 }, { requests: 1, tokens: 0 }, 0);
    const r2 = s.acquire('r2', 'k', { rpm: 60 }, { requests: 1, tokens: 0 }, 0);
    if (r2.kind !== 'granted') {
        assert.fail('r2 should be granted');
    }
    assert.equal(r2.waitMs, 1000);

    // 移除 rpm 维度
    const r3 = s.acquire('r3', 'k', {}, { requests: 1, tokens: 0 }, 0);
    if (r3.kind !== 'granted') {
        assert.fail('r3 should be granted');
    }
    assert.equal(r3.waitMs, 0);
});

test('reclaimInstance 回收断线实例的 grant 并放行 FIFO 队首', () => {
    const s = store();
    const dims = { parallel: 1 };
    const r1 = s.acquire('r1', 'k', dims, { requests: 1, tokens: 0 }, 0, { ownerInstanceId: 'follower-a' });
    if (r1.kind !== 'granted') {
        assert.fail('r1 should be granted');
    }
    const r2 = s.acquire('r2', 'k', dims, { requests: 1, tokens: 0 }, 0, { ownerInstanceId: 'follower-b' });
    assert.equal(r2.kind, 'queued');

    const { granted, affectedBucketKeys } = s.reclaimInstance('follower-a', 100);
    assert.deepEqual(affectedBucketKeys, ['k']);
    assert.equal(granted.length, 1);
    assert.equal(granted[0]?.requestId, 'r2'); // 幽灵 grant 回收后队首被放行
    assert.equal(s.stats('k', 100)?.inflight, 1);
});

test('reclaimInstance 移除断线实例的排队项', () => {
    const s = store();
    const dims = { parallel: 1 };
    s.acquire('r1', 'k', dims, { requests: 1, tokens: 0 }, 0);
    s.acquire('r2', 'k', dims, { requests: 1, tokens: 0 }, 0, { ownerInstanceId: 'follower-a' });
    s.acquire('r3', 'k', dims, { requests: 1, tokens: 0 }, 0);
    assert.equal(s.stats('k', 0)?.pending, 2);

    const { granted, affectedBucketKeys } = s.reclaimInstance('follower-a', 0);
    assert.equal(granted.length, 0);
    assert.deepEqual(affectedBucketKeys, ['k']);
    assert.deepEqual(
        s.getPendingPositions('k').map(p => p.requestId),
        ['r3']
    );
});

test('reclaimInstance 对无该实例状态时为空操作', () => {
    const s = store();
    s.acquire('r1', 'k', { parallel: 1 }, { requests: 1, tokens: 0 }, 0);
    const { granted, affectedBucketKeys } = s.reclaimInstance('ghost', 0);
    assert.equal(granted.length, 0);
    assert.equal(affectedBucketKeys.length, 0);
    assert.equal(s.stats('k', 0)?.inflight, 1);
});
