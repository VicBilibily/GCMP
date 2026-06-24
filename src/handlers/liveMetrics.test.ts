import assert from 'node:assert/strict';
import test from 'node:test';

import { emitLiveMetrics, getActiveMetricsSnapshot, onLiveMetrics, type LiveStreamMetricEvent } from './liveMetrics';

function makeEvent(overrides: Partial<LiveStreamMetricEvent> = {}): LiveStreamMetricEvent {
    return {
        type: 'streamingUpdate',
        requestId: 'req-1',
        requestStartTime: 1000,
        providerName: 'TestProvider',
        modelName: 'test-model',
        ...overrides
    };
}

/** 动态清理所有活跃快照，避免固定 requestId 列表遗漏 */
function cleanupAllSnapshots(): void {
    for (const event of getActiveMetricsSnapshot()) {
        emitLiveMetrics(makeEvent({ type: 'streamEnd', requestId: event.requestId }));
    }
}

test('emitLiveMetrics updates snapshot even when no listeners exist', () => {
    cleanupAllSnapshots();
    const event = makeEvent({ requestId: 'req-no-listener', type: 'requestStarted' });

    emitLiveMetrics(event);

    const snapshot = getActiveMetricsSnapshot();
    const found = snapshot.find(e => e.requestId === 'req-no-listener');
    assert.ok(found, 'snapshot should contain the event even without listeners');
    assert.equal(found.type, 'requestStarted');

    cleanupAllSnapshots();
});

test('streamEnd removes requestId from snapshot', () => {
    cleanupAllSnapshots();
    emitLiveMetrics(makeEvent({ requestId: 'req-end', type: 'streamingUpdate' }));

    let snapshot = getActiveMetricsSnapshot();
    assert.ok(snapshot.some(e => e.requestId === 'req-end'), 'should exist before streamEnd');

    emitLiveMetrics(makeEvent({ requestId: 'req-end', type: 'streamEnd' }));

    snapshot = getActiveMetricsSnapshot();
    assert.ok(!snapshot.some(e => e.requestId === 'req-end'), 'should be removed after streamEnd');
});

test('snapshot is updated to latest event for the same requestId', () => {
    cleanupAllSnapshots();
    emitLiveMetrics(makeEvent({
        requestId: 'req-update',
        type: 'requestStarted',
        requestStartTime: 1000
    }));
    emitLiveMetrics(makeEvent({
        requestId: 'req-update',
        type: 'firstChunk',
        streamStartTime: 1200,
        firstChunkLatencyMs: 200
    }));
    emitLiveMetrics(makeEvent({
        requestId: 'req-update',
        type: 'streamingUpdate',
        estimatedOutputTokens: 50,
        tokensPerSecond: 25.5
    }));

    const snapshot = getActiveMetricsSnapshot();
    const found = snapshot.find(e => e.requestId === 'req-update');
    assert.ok(found, 'should exist');
    assert.equal(found.type, 'streamingUpdate', 'should be the latest event type');
    assert.equal(found.estimatedOutputTokens, 50);
    assert.equal(found.tokensPerSecond, 25.5);

    cleanupAllSnapshots();
});

test('multiple concurrent requests have independent snapshots', () => {
    cleanupAllSnapshots();
    emitLiveMetrics(makeEvent({ requestId: 'req-a', type: 'requestStarted' }));
    emitLiveMetrics(makeEvent({ requestId: 'req-b', type: 'streamingUpdate', estimatedOutputTokens: 100 }));

    const snapshot = getActiveMetricsSnapshot();
    const a = snapshot.find(e => e.requestId === 'req-a');
    const b = snapshot.find(e => e.requestId === 'req-b');

    assert.ok(a, 'req-a should exist');
    assert.ok(b, 'req-b should exist');
    assert.equal(a.type, 'requestStarted');
    assert.equal(b.type, 'streamingUpdate');
    assert.equal(b.estimatedOutputTokens, 100);

    // 清理 req-a 不影响 req-b
    emitLiveMetrics(makeEvent({ requestId: 'req-a', type: 'streamEnd' }));
    const afterCleanup = getActiveMetricsSnapshot();
    assert.ok(!afterCleanup.some(e => e.requestId === 'req-a'), 'req-a should be removed');
    assert.ok(afterCleanup.some(e => e.requestId === 'req-b'), 'req-b should still exist');

    cleanupAllSnapshots();
});

test('listeners still receive events alongside snapshot updates', () => {
    cleanupAllSnapshots();
    const received: LiveStreamMetricEvent[] = [];
    const disposable = onLiveMetrics(event => {
        if (event.requestId === 'req-listener') {
            received.push(event);
        }
    });

    try {
        emitLiveMetrics(makeEvent({ requestId: 'req-listener', type: 'requestStarted' }));
        emitLiveMetrics(makeEvent({ requestId: 'req-listener', type: 'streamingUpdate' }));

        assert.equal(received.length, 2, 'listener should receive both events');
        assert.equal(received[0].type, 'requestStarted');
        assert.equal(received[1].type, 'streamingUpdate');

        const snapshot = getActiveMetricsSnapshot();
        const found = snapshot.find(e => e.requestId === 'req-listener');
        assert.ok(found);
        assert.equal(found.type, 'streamingUpdate');
    } finally {
        disposable.dispose();
        cleanupAllSnapshots();
    }
});

test('getActiveMetricsSnapshot returns empty array when no active requests', () => {
    cleanupAllSnapshots();
    assert.deepEqual(getActiveMetricsSnapshot(), []);
});

test('dispose stops listener from receiving further events', () => {
    cleanupAllSnapshots();
    const received: LiveStreamMetricEvent[] = [];
    const disposable = onLiveMetrics(event => received.push(event));

    emitLiveMetrics(makeEvent({ requestId: 'req-dispose', type: 'requestStarted' }));
    assert.equal(received.length, 1, 'should receive before dispose');

    disposable.dispose();

    emitLiveMetrics(makeEvent({ requestId: 'req-dispose', type: 'streamingUpdate' }));
    assert.equal(received.length, 1, 'should not receive after dispose');

    // dispose 后 snapshot 仍会更新
    const snapshot = getActiveMetricsSnapshot();
    const found = snapshot.find(e => e.requestId === 'req-dispose');
    assert.ok(found);
    assert.equal(found.type, 'streamingUpdate');

    cleanupAllSnapshots();
});

test('multiple listeners all receive the same event', () => {
    cleanupAllSnapshots();
    const received1: LiveStreamMetricEvent[] = [];
    const received2: LiveStreamMetricEvent[] = [];
    const d1 = onLiveMetrics(event => received1.push(event));
    const d2 = onLiveMetrics(event => received2.push(event));

    try {
        emitLiveMetrics(makeEvent({ requestId: 'req-multi', type: 'requestStarted' }));

        assert.equal(received1.length, 1);
        assert.equal(received2.length, 1);
        assert.equal(received1[0].requestId, 'req-multi');
        assert.equal(received2[0].requestId, 'req-multi');
    } finally {
        d1.dispose();
        d2.dispose();
        cleanupAllSnapshots();
    }
});

test('listener exception does not break other listeners', () => {
    cleanupAllSnapshots();

    // 临时 stub console.warn，避免测试输出噪声
    const originalWarn = console.warn;
    let warned = false;
    console.warn = (...args: unknown[]) => {
        warned = String(args[0]).includes('[LiveMetrics] listener failed');
    };

    const received: LiveStreamMetricEvent[] = [];
    const d1 = onLiveMetrics(() => {
        throw new Error('boom');
    });
    const d2 = onLiveMetrics(event => received.push(event));

    try {
        emitLiveMetrics(makeEvent({ requestId: 'req-error', type: 'requestStarted' }));

        assert.equal(warned, true, 'listener failure should be logged');
        assert.equal(received.length, 1);
        assert.equal(received[0].requestId, 'req-error');

        const snapshot = getActiveMetricsSnapshot();
        assert.ok(snapshot.some(e => e.requestId === 'req-error'));
    } finally {
        console.warn = originalWarn;
        d1.dispose();
        d2.dispose();
        cleanupAllSnapshots();
    }
});

test('streamEnd for non-existent requestId is a no-op', () => {
    cleanupAllSnapshots();
    emitLiveMetrics(makeEvent({ requestId: 'req-exist', type: 'streamingUpdate' }));

    // 对另一个 requestId 发送 streamEnd
    emitLiveMetrics(makeEvent({ requestId: 'req-ghost', type: 'streamEnd' }));

    // req-exist 应不受影响
    const snapshot = getActiveMetricsSnapshot();
    assert.equal(snapshot.length, 1);
    assert.equal(snapshot[0].requestId, 'req-exist');

    cleanupAllSnapshots();
});

test('full lifecycle: requestStarted -> firstChunk -> streamingUpdate -> streamEnd', () => {
    cleanupAllSnapshots();
    const events: LiveStreamMetricEvent[] = [];
    const disposable = onLiveMetrics(event => events.push(event));

    try {
        // requestStarted 阶段
        emitLiveMetrics(makeEvent({
            requestId: 'req-lifecycle',
            type: 'requestStarted',
            requestStartTime: 1000
        }));
        let snapshot = getActiveMetricsSnapshot();
        assert.equal(snapshot.find(e => e.requestId === 'req-lifecycle')!.type, 'requestStarted');

        // firstChunk 阶段
        emitLiveMetrics(makeEvent({
            requestId: 'req-lifecycle',
            type: 'firstChunk',
            streamStartTime: 1200,
            firstChunkLatencyMs: 200
        }));
        snapshot = getActiveMetricsSnapshot();
        const fc = snapshot.find(e => e.requestId === 'req-lifecycle')!;
        assert.equal(fc.type, 'firstChunk');
        assert.equal(fc.firstChunkLatencyMs, 200);

        // streamingUpdate 阶段
        emitLiveMetrics(makeEvent({
            requestId: 'req-lifecycle',
            type: 'streamingUpdate',
            estimatedOutputTokens: 42,
            lastOutputTokenDelta: 10,
            tokensPerSecond: 21.0
        }));
        snapshot = getActiveMetricsSnapshot();
        const su = snapshot.find(e => e.requestId === 'req-lifecycle')!;
        assert.equal(su.type, 'streamingUpdate');
        assert.equal(su.estimatedOutputTokens, 42);
        assert.equal(su.lastOutputTokenDelta, 10);
        assert.equal(su.tokensPerSecond, 21.0);

        // streamEnd 阶段
        emitLiveMetrics(makeEvent({
            requestId: 'req-lifecycle',
            type: 'streamEnd'
        }));
        snapshot = getActiveMetricsSnapshot();
        assert.ok(!snapshot.some(e => e.requestId === 'req-lifecycle'), 'should be removed after streamEnd');

        // listener 应收到全部 4 个事件
        assert.equal(events.length, 4);
        assert.equal(events[0].type, 'requestStarted');
        assert.equal(events[1].type, 'firstChunk');
        assert.equal(events[2].type, 'streamingUpdate');
        assert.equal(events[3].type, 'streamEnd');
    } finally {
        disposable.dispose();
        cleanupAllSnapshots();
    }
});

test('snapshot preserves all event fields', () => {
    cleanupAllSnapshots();
    const fullEvent = makeEvent({
        requestId: 'req-fields',
        type: 'streamingUpdate',
        requestStartTime: 5000,
        providerName: 'Anthropic',
        modelName: 'claude-sonnet-4-20250514',
        streamStartTime: 5300,
        firstChunkLatencyMs: 300,
        estimatedOutputTokens: 150,
        lastOutputTokenDelta: 25,
        lastFlushSeq: 7,
        tokensPerSecond: 33.3
    });

    emitLiveMetrics(fullEvent);

    const snapshot = getActiveMetricsSnapshot();
    const found = snapshot.find(e => e.requestId === 'req-fields')!;

    assert.equal(found.type, 'streamingUpdate');
    assert.equal(found.requestId, 'req-fields');
    assert.equal(found.requestStartTime, 5000);
    assert.equal(found.providerName, 'Anthropic');
    assert.equal(found.modelName, 'claude-sonnet-4-20250514');
    assert.equal(found.streamStartTime, 5300);
    assert.equal(found.firstChunkLatencyMs, 300);
    assert.equal(found.estimatedOutputTokens, 150);
    assert.equal(found.lastOutputTokenDelta, 25);
    assert.equal(found.lastFlushSeq, 7);
    assert.equal(found.tokensPerSecond, 33.3);

    cleanupAllSnapshots();
});

test('retry (new requestStarted for same requestId) resets snapshot', () => {
    cleanupAllSnapshots();
    emitLiveMetrics(makeEvent({
        requestId: 'req-retry',
        type: 'requestStarted',
        requestStartTime: 1000
    }));
    emitLiveMetrics(makeEvent({
        requestId: 'req-retry',
        type: 'streamingUpdate',
        requestStartTime: 1000,
        estimatedOutputTokens: 100
    }));

    // 重试：新的 requestStarted 带不同 requestStartTime
    emitLiveMetrics(makeEvent({
        requestId: 'req-retry',
        type: 'requestStarted',
        requestStartTime: 3000
    }));

    const snapshot = getActiveMetricsSnapshot();
    const found = snapshot.find(e => e.requestId === 'req-retry')!;
    assert.equal(found.type, 'requestStarted', 'should be reset to requestStarted');
    assert.equal(found.requestStartTime, 3000, 'should have new attempt start time');
    assert.equal(found.estimatedOutputTokens, undefined, 'old streamingUpdate fields should be gone');

    cleanupAllSnapshots();
});
