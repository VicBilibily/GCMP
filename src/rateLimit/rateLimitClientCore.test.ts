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
    sendCancel?: (msg: { authorityTerm: string; requestId: string; bucketKey: string }) => void;
    isTransportHealthy?: () => boolean;
    getAuthorityTerm?: () => string | undefined;
    timeout?: number;
}) {
    const sent: RateLimitAcquireRequestMessage[] = [];
    let grantHandler: ((msg: RateLimitGrantMessage) => void) | undefined;
    let queueUpdateHandler: ((msg: RateLimitQueueUpdateMessage) => void) | undefined;
    const core = new RateLimitClientCore({
        timeout: overrides?.timeout ?? 50,
        isTransportHealthy: overrides?.isTransportHealthy,
        getAuthorityTerm: overrides?.getAuthorityTerm ?? (() => 'leader-a:1'),
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

    assert.equal(sent[0]!.authorityTerm, 'leader-a:1');

    grant({ authorityTerm: 'leader-a:1', requestId, waitMs: 120, grantId: 'g1' });
    const outcome = await promise;
    assert.deepEqual(outcome, { status: 'granted', grantId: 'g1', waitMs: 120, authorityTerm: 'leader-a:1' });
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
    grant({ authorityTerm: 'leader-a:1', requestId, waitMs: 0, grantId: 'g1' });
    grant({ authorityTerm: 'leader-a:1', requestId, waitMs: 999, grantId: 'g2' }); // 重复
    const outcome = await promise;
    assert.deepEqual(outcome, { status: 'granted', grantId: 'g1', waitMs: 0, authorityTerm: 'leader-a:1' });
    assert.equal(core.pendingCount, 0);
    core.dispose();
});

test('未知 requestId 的回执被忽略', async () => {
    const { core, grant } = makeCore();
    const promise = core.acquire('bucket', DIMS, { requests: 1, tokens: 0 });
    grant({ authorityTerm: 'leader-a:1', requestId: 'unknown', waitMs: 0, grantId: 'gx' });
    const outcome = await promise; // 会超时
    assert.equal(outcome.status, 'degraded');
    core.dispose();
});

test('缺少有效 grantId 的回执立即降级', async () => {
    const { core, sent, grant } = makeCore({ timeout: 10_000 });
    const startedAt = Date.now();
    const promise = core.acquire('bucket', DIMS, { requests: 1, tokens: 0 });
    grant({ authorityTerm: 'leader-a:1', requestId: sent[0]!.requestId, waitMs: 0, grantId: '' });
    const outcome = await promise;
    assert.deepEqual(outcome, { status: 'degraded', reason: 'timeout' });
    assert.ok(Date.now() - startedAt < 500);
    core.dispose();
});

test('并发 acquire 各自独立匹配', async () => {
    const { core, sent, grant } = makeCore();
    const p1 = core.acquire('bucket', DIMS, { requests: 1, tokens: 0 });
    const p2 = core.acquire('bucket', DIMS, { requests: 1, tokens: 0 });
    assert.equal(core.pendingCount, 2);
    // 乱序回执
    grant({ authorityTerm: 'leader-a:1', requestId: sent[1]!.requestId, waitMs: 5, grantId: 'g-b' });
    grant({ authorityTerm: 'leader-a:1', requestId: sent[0]!.requestId, waitMs: 3, grantId: 'g-a' });
    const [o1, o2] = await Promise.all([p1, p2]);
    assert.deepEqual(o1, { status: 'granted', grantId: 'g-a', waitMs: 3, authorityTerm: 'leader-a:1' });
    assert.deepEqual(o2, { status: 'granted', grantId: 'g-b', waitMs: 5, authorityTerm: 'leader-a:1' });
    core.dispose();
});

test('dispose 结算所有等待为降级', async () => {
    const cancelled: Array<{ authorityTerm: string; requestId: string; bucketKey: string }> = [];
    const { core, sent } = makeCore({ timeout: 10_000, sendCancel: msg => cancelled.push(msg) });
    const promise = core.acquire('bucket', DIMS, { requests: 1, tokens: 0 });
    core.dispose();
    const outcome = await promise;
    assert.equal(outcome.status, 'degraded');
    assert.deepEqual(cancelled, [
        {
            authorityTerm: 'leader-a:1',
            requestId: sent[0]!.requestId,
            bucketKey: 'bucket'
        }
    ]);
});

test('排队顺位更新会透传给当前 acquire', async () => {
    const { core, sent, grant, queueUpdate } = makeCore();
    const positions: number[] = [];
    const promise = core.acquire('bucket', DIMS, COSTS, undefined, {
        onQueueUpdate: msg => positions.push(msg.queuePosition)
    });
    const requestId = sent[0]!.requestId;

    queueUpdate({ authorityTerm: 'leader-a:1', requestId, queuePosition: 3 });
    queueUpdate({ authorityTerm: 'leader-a:1', requestId, queuePosition: 2 });
    grant({ authorityTerm: 'leader-a:1', requestId, waitMs: 0, grantId: 'g1' });

    const outcome = await promise;
    assert.deepEqual(positions, [3, 2]);
    assert.deepEqual(outcome, { status: 'granted', grantId: 'g1', waitMs: 0, authorityTerm: 'leader-a:1' });
    core.dispose();
});

test('排队期间持续收到更优顺位时可继续等待直到权威授予', async () => {
    const { core, sent, grant, queueUpdate } = makeCore({ timeout: 30 });
    const promise = core.acquire('bucket', DIMS, COSTS);
    const requestId = sent[0]!.requestId;

    queueUpdate({ authorityTerm: 'leader-a:1', requestId, queuePosition: 4 });
    await new Promise(resolve => setTimeout(resolve, 20));
    queueUpdate({ authorityTerm: 'leader-a:1', requestId, queuePosition: 3 });
    await new Promise(resolve => setTimeout(resolve, 20));
    grant({ authorityTerm: 'leader-a:1', requestId, waitMs: 0, grantId: 'g1' });

    const outcome = await promise;
    assert.deepEqual(outcome, { status: 'granted', grantId: 'g1', waitMs: 0, authorityTerm: 'leader-a:1' });
    core.dispose();
});

test('收到首个排队顺位后会持续等待权威授予，不再按无进展超时降级', async () => {
    const { core, sent, queueUpdate, grant } = makeCore({ timeout: 30 });
    const promise = core.acquire('bucket', DIMS, COSTS);
    const requestId = sent[0]!.requestId;

    queueUpdate({ authorityTerm: 'leader-a:1', requestId, queuePosition: 4 });
    await new Promise(resolve => setTimeout(resolve, 45));
    grant({ authorityTerm: 'leader-a:1', requestId, waitMs: 0, grantId: 'g1' });

    const outcome = await promise;
    assert.deepEqual(outcome, { status: 'granted', grantId: 'g1', waitMs: 0, authorityTerm: 'leader-a:1' });
    core.dispose();
});

test('同值顺位事件不会重新启动超时降级', async () => {
    const { core, sent, queueUpdate, grant } = makeCore({ timeout: 30 });
    const promise = core.acquire('bucket', DIMS, COSTS);
    const requestId = sent[0]!.requestId;

    queueUpdate({ authorityTerm: 'leader-a:1', requestId, queuePosition: 2 });
    await new Promise(resolve => setTimeout(resolve, 20));
    queueUpdate({ authorityTerm: 'leader-a:1', requestId, queuePosition: 2 });
    await new Promise(resolve => setTimeout(resolve, 20));
    grant({ authorityTerm: 'leader-a:1', requestId, waitMs: 0, grantId: 'g1' });

    const outcome = await promise;
    assert.deepEqual(outcome, { status: 'granted', grantId: 'g1', waitMs: 0, authorityTerm: 'leader-a:1' });
    core.dispose();
});

test('更差的排队顺位不会重新启动超时降级', async () => {
    const { core, sent, queueUpdate, grant } = makeCore({ timeout: 30 });
    const promise = core.acquire('bucket', DIMS, COSTS);
    const requestId = sent[0]!.requestId;

    queueUpdate({ authorityTerm: 'leader-a:1', requestId, queuePosition: 2 });
    await new Promise(resolve => setTimeout(resolve, 20));
    queueUpdate({ authorityTerm: 'leader-a:1', requestId, queuePosition: 5 });
    await new Promise(resolve => setTimeout(resolve, 20));
    grant({ authorityTerm: 'leader-a:1', requestId, waitMs: 0, grantId: 'g1' });

    const outcome = await promise;
    assert.deepEqual(outcome, { status: 'granted', grantId: 'g1', waitMs: 0, authorityTerm: 'leader-a:1' });
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

    queueUpdate({ authorityTerm: 'leader-a:1', requestId, queuePosition: 1 });
    transportHealthy = false;

    const outcome = await promise;
    assert.deepEqual(outcome, { status: 'degraded', reason: 'authority-unavailable' });
    core.dispose();
});

test('settlePendingAsDegraded 会结算当前所有等待中的请求', async () => {
    const cancelled: Array<{ authorityTerm: string; requestId: string; bucketKey: string }> = [];
    const { core, sent, queueUpdate } = makeCore({ timeout: 10_000, sendCancel: msg => cancelled.push(msg) });
    const promise = core.acquire('bucket', DIMS, COSTS);
    queueUpdate({ authorityTerm: 'leader-a:1', requestId: sent[0]!.requestId, queuePosition: 1 });

    core.settlePendingAsDegraded();

    const outcome = await promise;
    assert.deepEqual(outcome, { status: 'degraded', reason: 'timeout' });
    assert.equal(core.pendingCount, 0);
    assert.deepEqual(cancelled, [
        {
            authorityTerm: 'leader-a:1',
            requestId: sent[0]!.requestId,
            bucketKey: 'bucket'
        }
    ]);
    core.dispose();
});

test('parallel=2 时第三个跨实例请求在持续前进的排队过程中可继续等待权威放行', async () => {
    const { core, sent, grant, queueUpdate } = makeCore({ timeout: 30 });
    const p1 = core.acquire('dashscope-token-personal', { rpm: 10, parallel: 2 }, COSTS);
    const p2 = core.acquire('dashscope-token-personal', { rpm: 10, parallel: 2 }, COSTS);
    const p3 = core.acquire('dashscope-token-personal', { rpm: 10, parallel: 2 }, COSTS);

    const r1 = sent[0]!.requestId;
    const r2 = sent[1]!.requestId;
    const r3 = sent[2]!.requestId;

    grant({ authorityTerm: 'leader-a:1', requestId: r1, waitMs: 0, grantId: 'g1' });
    grant({ authorityTerm: 'leader-a:1', requestId: r2, waitMs: 0, grantId: 'g2' });
    queueUpdate({ authorityTerm: 'leader-a:1', requestId: r3, queuePosition: 4 });

    await new Promise(resolve => setTimeout(resolve, 20));
    queueUpdate({ authorityTerm: 'leader-a:1', requestId: r3, queuePosition: 3 });
    await new Promise(resolve => setTimeout(resolve, 20));
    grant({ authorityTerm: 'leader-a:1', requestId: r3, waitMs: 0, grantId: 'g3' });

    assert.deepEqual(await p1, { status: 'granted', grantId: 'g1', waitMs: 0, authorityTerm: 'leader-a:1' });
    assert.deepEqual(await p2, { status: 'granted', grantId: 'g2', waitMs: 0, authorityTerm: 'leader-a:1' });
    assert.deepEqual(await p3, { status: 'granted', grantId: 'g3', waitMs: 0, authorityTerm: 'leader-a:1' });
    core.dispose();
});

test('取消时会通知远端清理 acquire', async () => {
    const cancelled: Array<{ authorityTerm: string; requestId: string; bucketKey: string }> = [];
    const { core } = makeCore({ sendCancel: msg => cancelled.push(msg) });
    let cancelledFlag = false;
    const promise = core.acquire('bucket', DIMS, COSTS, { isCancelled: () => cancelledFlag }, { timeout: 10_000 });
    cancelledFlag = true;
    const outcome = await promise;
    assert.equal(outcome.status, 'cancelled');
    assert.equal(cancelled.length, 1);
    assert.equal(cancelled[0]?.authorityTerm, 'leader-a:1');
    assert.equal(cancelled[0]?.bucketKey, 'bucket');
    core.dispose();
});

test('authority term changes while queued returns authority-changed and cancels old request', async () => {
    let authorityTerm = 'leader-a:1';
    const cancelled: Array<{ authorityTerm: string; requestId: string; bucketKey: string }> = [];
    const { core, sent, queueUpdate } = makeCore({
        timeout: 10_000,
        getAuthorityTerm: () => authorityTerm,
        sendCancel: msg => cancelled.push(msg)
    });

    const promise = core.acquire('bucket', DIMS, COSTS);
    const requestId = sent[0]!.requestId;
    queueUpdate({ authorityTerm: 'leader-a:1', requestId, queuePosition: 2 });
    authorityTerm = 'leader-b:2';

    const outcome = await promise;
    assert.deepEqual(outcome, { status: 'authority-changed' });
    assert.deepEqual(cancelled, [{ authorityTerm: 'leader-a:1', requestId, bucketKey: 'bucket' }]);
    core.dispose();
});

test('authority term becomes unavailable while queued ignores stale queue updates', async () => {
    let authorityTerm: string | undefined = 'leader-a:1';
    const cancelled: Array<{ authorityTerm: string; requestId: string; bucketKey: string }> = [];
    const positions: number[] = [];
    const { core, sent, queueUpdate } = makeCore({
        timeout: 10_000,
        getAuthorityTerm: () => authorityTerm,
        sendCancel: msg => cancelled.push(msg)
    });

    const promise = core.acquire('bucket', DIMS, COSTS, undefined, {
        onQueueUpdate: msg => positions.push(msg.queuePosition)
    });
    const requestId = sent[0]!.requestId;
    authorityTerm = undefined;
    queueUpdate({ authorityTerm: 'leader-a:1', requestId, queuePosition: 1 });

    const outcome = await promise;
    assert.deepEqual(positions, []);
    assert.deepEqual(outcome, { status: 'degraded', reason: 'authority-unavailable' });
    assert.deepEqual(cancelled, [{ authorityTerm: 'leader-a:1', requestId, bucketKey: 'bucket' }]);
    core.dispose();
});

test('authority term changes before acquire starts degrades as authority unavailable', async () => {
    const { core } = makeCore({ getAuthorityTerm: () => undefined });

    const outcome = await core.acquire('bucket', DIMS, COSTS);

    assert.deepEqual(outcome, { status: 'degraded', reason: 'authority-unavailable' });
    core.dispose();
});

test('stale grant from old authority term is ignored', async () => {
    let authorityTerm = 'leader-a:1';
    const { core, sent, grant } = makeCore({ timeout: 30, getAuthorityTerm: () => authorityTerm });
    const promise = core.acquire('bucket', DIMS, COSTS);
    const requestId = sent[0]!.requestId;

    authorityTerm = 'leader-b:2';
    grant({ authorityTerm: 'leader-a:1', requestId, waitMs: 0, grantId: 'g-old' });

    const outcome = await promise;
    assert.deepEqual(outcome, { status: 'authority-changed' });
    core.dispose();
});

test('stale grant from old authority term is ignored while authority is unavailable', async () => {
    let authorityTerm: string | undefined = 'leader-a:1';
    const cancelled: Array<{ authorityTerm: string; requestId: string; bucketKey: string }> = [];
    const { core, sent, grant } = makeCore({
        timeout: 10_000,
        getAuthorityTerm: () => authorityTerm,
        sendCancel: msg => cancelled.push(msg)
    });
    const promise = core.acquire('bucket', DIMS, COSTS);
    const requestId = sent[0]!.requestId;

    authorityTerm = undefined;
    grant({ authorityTerm: 'leader-a:1', requestId, waitMs: 0, grantId: 'g-old' });

    const outcome = await promise;
    assert.deepEqual(outcome, { status: 'degraded', reason: 'authority-unavailable' });
    assert.deepEqual(cancelled, [{ authorityTerm: 'leader-a:1', requestId, bucketKey: 'bucket' }]);
    core.dispose();
});
