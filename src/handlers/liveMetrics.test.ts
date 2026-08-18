import assert from 'node:assert/strict';
import test from 'node:test';

import {
    clearRemoteLiveMetrics,
    emitLiveMetrics,
    getCrossInstanceLiveMetricsSnapshot,
    getActiveMetricsSnapshot,
    onLiveMetrics,
    receiveRemoteLiveMetrics,
    syncRemoteLiveMetricsSnapshot,
    type LiveStreamMetricEvent
} from './liveMetrics';

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
    assert.ok(
        snapshot.some(e => e.requestId === 'req-end'),
        'should exist before streamEnd'
    );

    emitLiveMetrics(makeEvent({ requestId: 'req-end', type: 'streamEnd' }));

    snapshot = getActiveMetricsSnapshot();
    assert.ok(!snapshot.some(e => e.requestId === 'req-end'), 'should be removed after streamEnd');
});

test('snapshot is updated to latest event for the same requestId', () => {
    cleanupAllSnapshots();
    emitLiveMetrics(
        makeEvent({
            requestId: 'req-update',
            type: 'requestStarted',
            requestStartTime: 1000
        })
    );
    emitLiveMetrics(
        makeEvent({
            requestId: 'req-update',
            type: 'firstChunk',
            streamStartTime: 1200,
            firstChunkLatencyMs: 200
        })
    );
    emitLiveMetrics(
        makeEvent({
            requestId: 'req-update',
            type: 'streamingUpdate',
            estimatedOutputTokens: 50,
            tokensPerSecond: 25.5
        })
    );

    const snapshot = getActiveMetricsSnapshot();
    const found = snapshot.find(e => e.requestId === 'req-update');
    assert.ok(found, 'should exist');
    assert.equal(found.type, 'streamingUpdate', 'should be the latest event type');
    assert.equal(found.estimatedOutputTokens, 50);
    assert.equal(found.tokensPerSecond, 25.5);

    cleanupAllSnapshots();
});

test('rateLimitWaiting is kept in snapshot until request starts', () => {
    cleanupAllSnapshots();

    emitLiveMetrics(
        makeEvent({
            requestId: 'req-wait',
            type: 'rateLimitWaiting',
            waitScope: 'local',
            queuePosition: 2
        })
    );

    let snapshot = getActiveMetricsSnapshot();
    let found = snapshot.find(e => e.requestId === 'req-wait');
    assert.ok(found);
    assert.equal(found.type, 'rateLimitWaiting');
    assert.equal(found.waitScope, 'local');
    assert.equal(found.queuePosition, 2);

    emitLiveMetrics(
        makeEvent({
            requestId: 'req-wait',
            type: 'requestStarted'
        })
    );

    snapshot = getActiveMetricsSnapshot();
    found = snapshot.find(e => e.requestId === 'req-wait');
    assert.ok(found);
    assert.equal(found.type, 'requestStarted');

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
    assert.ok(
        afterCleanup.some(e => e.requestId === 'req-b'),
        'req-b should still exist'
    );

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
        emitLiveMetrics(
            makeEvent({
                requestId: 'req-lifecycle',
                type: 'requestStarted',
                requestStartTime: 1000
            })
        );
        let snapshot = getActiveMetricsSnapshot();
        assert.equal(snapshot.find(e => e.requestId === 'req-lifecycle')!.type, 'requestStarted');

        // firstChunk 阶段
        emitLiveMetrics(
            makeEvent({
                requestId: 'req-lifecycle',
                type: 'firstChunk',
                streamStartTime: 1200,
                firstChunkLatencyMs: 200
            })
        );
        snapshot = getActiveMetricsSnapshot();
        const fc = snapshot.find(e => e.requestId === 'req-lifecycle')!;
        assert.equal(fc.type, 'firstChunk');
        assert.equal(fc.firstChunkLatencyMs, 200);

        // streamingUpdate 阶段
        emitLiveMetrics(
            makeEvent({
                requestId: 'req-lifecycle',
                type: 'streamingUpdate',
                estimatedOutputTokens: 42,
                lastOutputTokenDelta: 10,
                tokensPerSecond: 21.0
            })
        );
        snapshot = getActiveMetricsSnapshot();
        const su = snapshot.find(e => e.requestId === 'req-lifecycle')!;
        assert.equal(su.type, 'streamingUpdate');
        assert.equal(su.estimatedOutputTokens, 42);
        assert.equal(su.lastOutputTokenDelta, 10);
        assert.equal(su.tokensPerSecond, 21.0);

        // streamEnd 阶段
        emitLiveMetrics(
            makeEvent({
                requestId: 'req-lifecycle',
                type: 'streamEnd'
            })
        );
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

test('receiveRemoteLiveMetrics updates snapshot and notifies listeners', () => {
    cleanupAllSnapshots();
    const received: LiveStreamMetricEvent[] = [];
    const disposable = onLiveMetrics(event => received.push(event));

    try {
        receiveRemoteLiveMetrics(
            makeEvent({
                requestId: 'req-remote',
                type: 'rateLimitWaiting',
                waitScope: 'ipc',
                queuePosition: 1
            })
        );

        const snapshot = getActiveMetricsSnapshot();
        const found = snapshot.find(event => event.requestId === 'req-remote');
        assert.ok(found);
        assert.equal(found.type, 'rateLimitWaiting');
        assert.equal(received.length, 1);
        assert.equal(received[0]?.requestId, 'req-remote');
    } finally {
        disposable.dispose();
        cleanupAllSnapshots();
    }
});

test('clearRemoteLiveMetrics removes only the matching remote source and emits streamEnd', () => {
    cleanupAllSnapshots();
    const received: LiveStreamMetricEvent[] = [];
    const disposable = onLiveMetrics(event => received.push(event));

    try {
        receiveRemoteLiveMetrics(
            makeEvent({
                requestId: 'req-remote-a',
                type: 'streamingUpdate'
            }),
            'inst-a'
        );
        receiveRemoteLiveMetrics(
            makeEvent({
                requestId: 'req-remote-b',
                type: 'streamingUpdate'
            }),
            'inst-b'
        );
        emitLiveMetrics(makeEvent({ requestId: 'req-local-active', type: 'streamingUpdate' }));

        clearRemoteLiveMetrics('inst-a');

        const snapshot = getActiveMetricsSnapshot();
        assert.ok(!snapshot.some(event => event.requestId === 'req-remote-a'));
        assert.ok(snapshot.some(event => event.requestId === 'req-remote-b'));
        assert.ok(snapshot.some(event => event.requestId === 'req-local-active'));
        assert.ok(received.some(event => event.requestId === 'req-remote-a' && event.type === 'streamEnd'));
    } finally {
        disposable.dispose();
        cleanupAllSnapshots();
    }
});

test('clearRemoteLiveMetrics without source removes all remote snapshots and keeps local ones', () => {
    cleanupAllSnapshots();

    try {
        receiveRemoteLiveMetrics(makeEvent({ requestId: 'req-remote-a', type: 'streamingUpdate' }), 'inst-a');
        receiveRemoteLiveMetrics(makeEvent({ requestId: 'req-remote-b', type: 'rateLimitWaiting' }), 'inst-b');
        emitLiveMetrics(makeEvent({ requestId: 'req-local-active', type: 'streamingUpdate' }));

        clearRemoteLiveMetrics();

        const snapshot = getActiveMetricsSnapshot();
        assert.ok(!snapshot.some(event => event.requestId === 'req-remote-a'));
        assert.ok(!snapshot.some(event => event.requestId === 'req-remote-b'));
        assert.ok(snapshot.some(event => event.requestId === 'req-local-active'));
    } finally {
        cleanupAllSnapshots();
    }
});

test('cross-instance snapshot preserves remote source ids for later cleanup', () => {
    cleanupAllSnapshots();

    try {
        receiveRemoteLiveMetrics(makeEvent({ requestId: 'req-follower', type: 'rateLimitWaiting' }), 'follower-a');
        emitLiveMetrics(makeEvent({ requestId: 'req-leader', type: 'rateLimitWaiting' }));

        const snapshot = getCrossInstanceLiveMetricsSnapshot();
        cleanupAllSnapshots();

        syncRemoteLiveMetricsSnapshot(snapshot, 'leader-a');

        let hydrated = getActiveMetricsSnapshot();
        assert.ok(hydrated.some(event => event.requestId === 'req-follower'));
        assert.ok(hydrated.some(event => event.requestId === 'req-leader'));

        clearRemoteLiveMetrics('follower-a');
        hydrated = getActiveMetricsSnapshot();
        assert.ok(!hydrated.some(event => event.requestId === 'req-follower'));
        assert.ok(hydrated.some(event => event.requestId === 'req-leader'));

        clearRemoteLiveMetrics('leader-a');
        hydrated = getActiveMetricsSnapshot();
        assert.ok(!hydrated.some(event => event.requestId === 'req-leader'));
    } finally {
        cleanupAllSnapshots();
    }
});

test('cross-instance snapshot excludes remote entries from disconnected sources', () => {
    cleanupAllSnapshots();

    try {
        receiveRemoteLiveMetrics(makeEvent({ requestId: 'req-keep', type: 'rateLimitWaiting' }), 'follower-a');
        receiveRemoteLiveMetrics(makeEvent({ requestId: 'req-drop', type: 'rateLimitWaiting' }), 'stale-follower');
        emitLiveMetrics(makeEvent({ requestId: 'req-local', type: 'rateLimitWaiting' }));

        const snapshot = getCrossInstanceLiveMetricsSnapshot(new Set(['follower-a']));

        assert.ok(snapshot.some(entry => entry.event.requestId === 'req-keep'));
        assert.ok(!snapshot.some(entry => entry.event.requestId === 'req-drop'));
        assert.ok(snapshot.some(entry => entry.event.requestId === 'req-local'));
    } finally {
        cleanupAllSnapshots();
    }
});

test('syncRemoteLiveMetricsSnapshot replaces stale remote snapshot and keeps local metrics', () => {
    cleanupAllSnapshots();

    try {
        receiveRemoteLiveMetrics(makeEvent({ requestId: 'req-stale', type: 'rateLimitWaiting' }), 'old-leader');
        emitLiveMetrics(makeEvent({ requestId: 'req-local', type: 'streamingUpdate' }));

        syncRemoteLiveMetricsSnapshot(
            [
                {
                    event: makeEvent({ requestId: 'req-fresh', type: 'rateLimitWaiting' }),
                    sourceInstanceId: 'new-follower'
                }
            ],
            'leader-b'
        );

        const snapshot = getActiveMetricsSnapshot();
        // 不完整快照不得误杀未覆盖 source 的远端流
        assert.ok(snapshot.some(event => event.requestId === 'req-stale'));
        assert.ok(snapshot.some(event => event.requestId === 'req-fresh'));
        assert.ok(snapshot.some(event => event.requestId === 'req-local'));
    } finally {
        cleanupAllSnapshots();
    }
});

test('syncRemoteLiveMetricsSnapshot only emits streamEnd for removed remote entries', () => {
    cleanupAllSnapshots();
    const received: LiveStreamMetricEvent[] = [];
    const disposable = onLiveMetrics(event => received.push(event));

    try {
        receiveRemoteLiveMetrics(makeEvent({ requestId: 'req-keep', type: 'rateLimitWaiting' }), 'leader-a');
        receiveRemoteLiveMetrics(makeEvent({ requestId: 'req-drop', type: 'rateLimitWaiting' }), 'leader-a');
        received.length = 0;

        syncRemoteLiveMetricsSnapshot(
            [{ event: makeEvent({ requestId: 'req-keep', type: 'rateLimitWaiting', queuePosition: 2 }) }],
            'leader-a'
        );

        assert.equal(received.filter(event => event.requestId === 'req-keep' && event.type === 'streamEnd').length, 0);
        assert.equal(received.filter(event => event.requestId === 'req-drop' && event.type === 'streamEnd').length, 1);
        assert.ok(received.some(event => event.requestId === 'req-keep' && event.type === 'rateLimitWaiting'));
    } finally {
        disposable.dispose();
        cleanupAllSnapshots();
    }
});

test('syncRemoteLiveMetricsSnapshot empty snapshot only ends covered source remotes', () => {
    cleanupAllSnapshots();
    const received: LiveStreamMetricEvent[] = [];
    const disposable = onLiveMetrics(event => received.push(event));

    try {
        receiveRemoteLiveMetrics(makeEvent({ requestId: 'req-sender', type: 'rateLimitWaiting' }), 'leader-a');
        receiveRemoteLiveMetrics(makeEvent({ requestId: 'req-other', type: 'streamingUpdate' }), 'follower-b');
        emitLiveMetrics(makeEvent({ requestId: 'req-local', type: 'streamingUpdate' }));
        received.length = 0;

        syncRemoteLiveMetricsSnapshot([], 'leader-a');

        const snapshot = getActiveMetricsSnapshot();
        assert.ok(!snapshot.some(event => event.requestId === 'req-sender'));
        assert.ok(snapshot.some(event => event.requestId === 'req-other'));
        assert.ok(snapshot.some(event => event.requestId === 'req-local'));
        assert.equal(
            received.filter(event => event.requestId === 'req-sender' && event.type === 'streamEnd').length,
            1
        );
        assert.equal(received.filter(event => event.requestId === 'req-other' && event.type === 'streamEnd').length, 0);
    } finally {
        disposable.dispose();
        cleanupAllSnapshots();
    }
});

test('retry (new requestStarted for same requestId) resets snapshot', () => {
    cleanupAllSnapshots();
    emitLiveMetrics(
        makeEvent({
            requestId: 'req-retry',
            type: 'requestStarted',
            requestStartTime: 1000
        })
    );
    emitLiveMetrics(
        makeEvent({
            requestId: 'req-retry',
            type: 'streamingUpdate',
            requestStartTime: 1000,
            estimatedOutputTokens: 100
        })
    );

    // 重试：新的 requestStarted 带不同 requestStartTime
    emitLiveMetrics(
        makeEvent({
            requestId: 'req-retry',
            type: 'requestStarted',
            requestStartTime: 3000
        })
    );

    const snapshot = getActiveMetricsSnapshot();
    const found = snapshot.find(e => e.requestId === 'req-retry')!;
    assert.equal(found.type, 'requestStarted', 'should be reset to requestStarted');
    assert.equal(found.requestStartTime, 3000, 'should have new attempt start time');
    assert.equal(found.estimatedOutputTokens, undefined, 'old streamingUpdate fields should be gone');

    cleanupAllSnapshots();
});

test('remote update for same requestId does not overwrite local ownership', () => {
    cleanupAllSnapshots();
    const received: LiveStreamMetricEvent[] = [];
    const disposable = onLiveMetrics(event => received.push(event));

    try {
        emitLiveMetrics(
            makeEvent({
                requestId: 'req-owned',
                type: 'streamingUpdate',
                estimatedOutputTokens: 40
            })
        );
        received.length = 0;

        receiveRemoteLiveMetrics(
            makeEvent({
                requestId: 'req-owned',
                type: 'streamingUpdate',
                estimatedOutputTokens: 999
            }),
            'inst-remote'
        );

        const snapshot = getActiveMetricsSnapshot();
        const found = snapshot.find(event => event.requestId === 'req-owned');
        assert.ok(found);
        assert.equal(found.estimatedOutputTokens, 40);
        assert.equal(received.length, 0);
    } finally {
        disposable.dispose();
        cleanupAllSnapshots();
    }
});

test('remote streamEnd for same requestId does not delete local ownership', () => {
    cleanupAllSnapshots();
    const received: LiveStreamMetricEvent[] = [];
    const disposable = onLiveMetrics(event => received.push(event));

    try {
        emitLiveMetrics(makeEvent({ requestId: 'req-owned', type: 'streamingUpdate' }));
        received.length = 0;

        receiveRemoteLiveMetrics(makeEvent({ requestId: 'req-owned', type: 'streamEnd' }), 'inst-remote');

        const snapshot = getActiveMetricsSnapshot();
        assert.ok(snapshot.some(event => event.requestId === 'req-owned' && event.type === 'streamingUpdate'));
        assert.equal(received.filter(event => event.requestId === 'req-owned' && event.type === 'streamEnd').length, 0);
    } finally {
        disposable.dispose();
        cleanupAllSnapshots();
    }
});

test('syncRemoteLiveMetricsSnapshot does not overwrite or delete local ownership', () => {
    cleanupAllSnapshots();
    const received: LiveStreamMetricEvent[] = [];
    const disposable = onLiveMetrics(event => received.push(event));

    try {
        emitLiveMetrics(
            makeEvent({
                requestId: 'req-owned',
                type: 'streamingUpdate',
                estimatedOutputTokens: 12
            })
        );
        received.length = 0;

        syncRemoteLiveMetricsSnapshot(
            [
                {
                    event: makeEvent({
                        requestId: 'req-owned',
                        type: 'rateLimitWaiting',
                        estimatedOutputTokens: 888
                    }),
                    sourceInstanceId: 'inst-remote'
                }
            ],
            'inst-remote'
        );

        const snapshot = getActiveMetricsSnapshot();
        const found = snapshot.find(event => event.requestId === 'req-owned');
        assert.ok(found);
        assert.equal(found.type, 'streamingUpdate');
        assert.equal(found.estimatedOutputTokens, 12);
        assert.equal(received.filter(event => event.requestId === 'req-owned').length, 0);
    } finally {
        disposable.dispose();
        cleanupAllSnapshots();
    }
});
