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

// 每个测试前清空快照（通过 streamEnd 清理所有已知 requestId）
// 由于 activeMetrics 是模块私有的，通过 emit streamEnd 清理
function cleanupSnapshot(requestIds: string[]): void {
    for (const id of requestIds) {
        emitLiveMetrics(makeEvent({ type: 'streamEnd', requestId: id }));
    }
}

test('emitLiveMetrics updates snapshot even when no listeners exist', () => {
    cleanupSnapshot(['req-no-listener']);
    const event = makeEvent({ requestId: 'req-no-listener', type: 'requestStarted' });

    // 无 listener 时 emit
    emitLiveMetrics(event);

    const snapshot = getActiveMetricsSnapshot();
    const found = snapshot.find(e => e.requestId === 'req-no-listener');
    assert.ok(found, 'snapshot should contain the event even without listeners');
    assert.equal(found.type, 'requestStarted');

    cleanupSnapshot(['req-no-listener']);
});

test('streamEnd removes requestId from snapshot', () => {
    cleanupSnapshot(['req-end']);
    emitLiveMetrics(makeEvent({ requestId: 'req-end', type: 'streamingUpdate' }));

    let snapshot = getActiveMetricsSnapshot();
    assert.ok(snapshot.some(e => e.requestId === 'req-end'), 'should exist before streamEnd');

    emitLiveMetrics(makeEvent({ requestId: 'req-end', type: 'streamEnd' }));

    snapshot = getActiveMetricsSnapshot();
    assert.ok(!snapshot.some(e => e.requestId === 'req-end'), 'should be removed after streamEnd');
});

test('snapshot is updated to latest event for the same requestId', () => {
    cleanupSnapshot(['req-update']);
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

    cleanupSnapshot(['req-update']);
});

test('multiple concurrent requests have independent snapshots', () => {
    cleanupSnapshot(['req-a', 'req-b']);
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

    cleanupSnapshot(['req-b']);
});

test('listeners still receive events alongside snapshot updates', () => {
    cleanupSnapshot(['req-listener']);
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

        // snapshot 也有最新状态
        const snapshot = getActiveMetricsSnapshot();
        const found = snapshot.find(e => e.requestId === 'req-listener');
        assert.ok(found);
        assert.equal(found.type, 'streamingUpdate');
    } finally {
        disposable.dispose();
        cleanupSnapshot(['req-listener']);
    }
});

test('getActiveMetricsSnapshot returns empty array when no active requests', () => {
    // 清理本测试文件中所有可能残留的 requestId
    cleanupSnapshot([
        'req-1',
        'req-no-listener',
        'req-end',
        'req-update',
        'req-a',
        'req-b',
        'req-listener'
    ]);

    assert.deepEqual(getActiveMetricsSnapshot(), []);
});
