import assert from 'node:assert/strict';
import test from 'node:test';

import {
    RateLimitClientCore,
    type RateLimitAcquireRequestMessage,
    type RateLimitGrantMessage,
    type RateLimitQueueUpdateMessage
} from './rateLimitClientCore';

function makeCore(overrides?: {
    onGrantEvent?: (handler: (msg: RateLimitGrantMessage) => void) => () => void;
    onQueueUpdateEvent?: (handler: (msg: RateLimitQueueUpdateMessage) => void) => () => void;
    sendCancel?: (msg: { requestId: string; bucketKey: string }) => void;
    isTransportHealthy?: () => boolean;
    timeout?: number;
}) {
    const sent: RateLimitAcquireRequestMessage[] = [];
    let grantHandler: ((msg: RateLimitGrantMessage) => void) | undefined;
    let queueUpdateHandler: ((msg: RateLimitQueueUpdateMessage) => void) | undefined;
    const core = new RateLimitClientCore({
        timeout: overrides?.timeout ?? 50,
        isTransportHealthy: overrides?.isTransportHealthy,
        send: msg => sent.push(msg),
        sendCancel: overrides?.sendCancel,
        onGrantEvent:
            overrides?.onGrantEvent ??
            (handler => {
                grantHandler = handler;
                return () => {
                    grantHandler = undefined;
                };
            }),
        onQueueUpdateEvent:
            overrides?.onQueueUpdateEvent ??
            (handler => {
                queueUpdateHandler = handler;
                return () => {
                    queueUpdateHandler = undefined;
                };
            }),
        now: () => Date.now()
    });
    return {
        core,
        sent,
        grant: (msg: RateLimitGrantMessage) => grantHandler?.(msg),
        queueUpdate: (msg: RateLimitQueueUpdateMessage) => queueUpdateHandler?.(msg)
    };
}

const DIMS = { rpm: 60 };
const COSTS = { requests: 1, tokens: 10 };

test('acquire 发起请求并在回执到达后授予', async () => {
    const { core, sent, grant } = makeCore();
    const promise = core.acquire('bucket', DIMS, COSTS);
    assert.equal(sent.length, 1);
    const requestId = sent[0]!.requestId;
    assert.equal(sent[0]!.bucketKey, 'bucket');
    assert.deepEqual(sent[0]!.costs, COSTS);

    grant({ requestId, waitMs: 120, grantId: 'g1' });
    const outcome = await promise;
    assert.deepEqual(outcome, { status: 'granted', grantId: 'g1', waitMs: 120 });
    core.dispose();
});

test('回执超时降级', async () => {
    const { core } = makeCore({ timeout: 30 });
    const outcome = await core.acquire('bucket', DIMS, { requests: 1, tokens: 0 });
    assert.deepEqual(outcome, { status: 'degraded', reason: 'timeout' });
    core.dispose();
});

test('单次 acquire 可覆盖默认回执超时', async () => {
    const { core } = makeCore({ timeout: 10_000 });
    const startedAt = Date.now();
    const outcome = await core.acquire('bucket', DIMS, { requests: 1, tokens: 0 }, undefined, { timeout: 30 });
    assert.deepEqual(outcome, { status: 'degraded', reason: 'timeout' });
    assert.ok(Date.now() - startedAt < 500);
    core.dispose();
});

test('重复回执幂等：首次匹配后忽略', async () => {
    const { core, sent, grant } = makeCore();
    const promise = core.acquire('bucket', DIMS, { requests: 1, tokens: 0 });
    const requestId = sent[0]!.requestId;
    grant({ requestId, waitMs: 0, grantId: 'g1' });
    grant({ requestId, waitMs: 999, grantId: 'g2' }); // 重复
    const outcome = await promise;
    assert.deepEqual(outcome, { status: 'granted', grantId: 'g1', waitMs: 0 });
    assert.equal(core.pendingCount, 0);
    core.dispose();
});

test('未知 requestId 的回执被忽略', async () => {
    const { core, grant } = makeCore();
    const promise = core.acquire('bucket', DIMS, { requests: 1, tokens: 0 });
    grant({ requestId: 'unknown', waitMs: 0, grantId: 'gx' });
    const outcome = await promise; // 会超时
    assert.equal(outcome.status, 'degraded');
    core.dispose();
});

test('缺少有效 grantId 的回执被忽略', async () => {
    const { core, sent, grant } = makeCore({ timeout: 30 });
    const promise = core.acquire('bucket', DIMS, { requests: 1, tokens: 0 });
    grant({ requestId: sent[0]!.requestId, waitMs: 0, grantId: '' });
    const outcome = await promise;
    assert.deepEqual(outcome, { status: 'degraded', reason: 'timeout' });
    core.dispose();
});

test('并发 acquire 各自独立匹配', async () => {
    const { core, sent, grant } = makeCore();
    const p1 = core.acquire('bucket', DIMS, { requests: 1, tokens: 0 });
    const p2 = core.acquire('bucket', DIMS, { requests: 1, tokens: 0 });
    assert.equal(core.pendingCount, 2);
    // 乱序回执
    grant({ requestId: sent[1]!.requestId, waitMs: 5, grantId: 'g-b' });
    grant({ requestId: sent[0]!.requestId, waitMs: 3, grantId: 'g-a' });
    const [o1, o2] = await Promise.all([p1, p2]);
    assert.deepEqual(o1, { status: 'granted', grantId: 'g-a', waitMs: 3 });
    assert.deepEqual(o2, { status: 'granted', grantId: 'g-b', waitMs: 5 });
    core.dispose();
});

test('dispose 结算所有等待为降级', async () => {
    const { core } = makeCore({ timeout: 10_000 });
    const promise = core.acquire('bucket', DIMS, { requests: 1, tokens: 0 });
    core.dispose();
    const outcome = await promise;
    assert.equal(outcome.status, 'degraded');
});

test('排队顺位更新会透传给当前 acquire', async () => {
    const { core, sent, grant, queueUpdate } = makeCore();
    const positions: number[] = [];
    const promise = core.acquire('bucket', DIMS, COSTS, undefined, {
        onQueueUpdate: msg => positions.push(msg.queuePosition)
    });
    const requestId = sent[0]!.requestId;

    queueUpdate({ requestId, queuePosition: 3 });
    queueUpdate({ requestId, queuePosition: 2 });
    grant({ requestId, waitMs: 0, grantId: 'g1' });

    const outcome = await promise;
    assert.deepEqual(positions, [3, 2]);
    assert.deepEqual(outcome, { status: 'granted', grantId: 'g1', waitMs: 0 });
    core.dispose();
});

test('收到排队顺位更新后不会因默认超时降级', async () => {
    const { core, sent, grant, queueUpdate } = makeCore({ timeout: 30 });
    const promise = core.acquire('bucket', DIMS, COSTS);
    const requestId = sent[0]!.requestId;

    queueUpdate({ requestId, queuePosition: 2 });
    await new Promise(resolve => setTimeout(resolve, 60));
    grant({ requestId, waitMs: 0, grantId: 'g1' });

    const outcome = await promise;
    assert.deepEqual(outcome, { status: 'granted', grantId: 'g1', waitMs: 0 });
    core.dispose();
});

test('收到排队顺位更新后若 IPC 断开会降级，避免永久挂起', async () => {
    let transportHealthy = true;
    const { core, sent, queueUpdate } = makeCore({
        timeout: 10_000,
        isTransportHealthy: () => transportHealthy
    });
    const promise = core.acquire('bucket', DIMS, COSTS);
    const requestId = sent[0]!.requestId;

    queueUpdate({ requestId, queuePosition: 1 });
    transportHealthy = false;

    const outcome = await promise;
    assert.deepEqual(outcome, { status: 'degraded', reason: 'timeout' });
    core.dispose();
});

test('settlePendingAsDegraded 会结算当前所有等待中的请求', async () => {
    const { core, sent, queueUpdate } = makeCore({ timeout: 10_000 });
    const promise = core.acquire('bucket', DIMS, COSTS);
    queueUpdate({ requestId: sent[0]!.requestId, queuePosition: 1 });

    core.settlePendingAsDegraded();

    const outcome = await promise;
    assert.deepEqual(outcome, { status: 'degraded', reason: 'timeout' });
    assert.equal(core.pendingCount, 0);
    core.dispose();
});

test('parallel=2 时第三个跨实例请求可在排队超时窗口后继续等待权威放行', async () => {
    const { core, sent, grant, queueUpdate } = makeCore({ timeout: 30 });
    const p1 = core.acquire('dashscope-token-personal', { rpm: 10, parallel: 2 }, COSTS);
    const p2 = core.acquire('dashscope-token-personal', { rpm: 10, parallel: 2 }, COSTS);
    const p3 = core.acquire('dashscope-token-personal', { rpm: 10, parallel: 2 }, COSTS);

    const r1 = sent[0]!.requestId;
    const r2 = sent[1]!.requestId;
    const r3 = sent[2]!.requestId;

    grant({ requestId: r1, waitMs: 0, grantId: 'g1' });
    grant({ requestId: r2, waitMs: 0, grantId: 'g2' });
    queueUpdate({ requestId: r3, queuePosition: 1 });

    await new Promise(resolve => setTimeout(resolve, 60));
    grant({ requestId: r3, waitMs: 0, grantId: 'g3' });

    assert.deepEqual(await p1, { status: 'granted', grantId: 'g1', waitMs: 0 });
    assert.deepEqual(await p2, { status: 'granted', grantId: 'g2', waitMs: 0 });
    assert.deepEqual(await p3, { status: 'granted', grantId: 'g3', waitMs: 0 });
    core.dispose();
});

test('取消时会通知远端清理 acquire', async () => {
    const cancelled: Array<{ requestId: string; bucketKey: string }> = [];
    const { core } = makeCore({ sendCancel: msg => cancelled.push(msg) });
    let cancelledFlag = false;
    const promise = core.acquire('bucket', DIMS, COSTS, { isCancelled: () => cancelledFlag }, { timeout: 10_000 });
    cancelledFlag = true;
    const outcome = await promise;
    assert.equal(outcome.status, 'cancelled');
    assert.equal(cancelled.length, 1);
    assert.equal(cancelled[0]?.bucketKey, 'bucket');
    core.dispose();
});
