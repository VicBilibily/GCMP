import assert from 'node:assert/strict';
import test from 'node:test';

import {
    INTER_INSTANCE_EVENT_TYPES,
    USAGES_QUERY_PROTOCOL_VERSION,
    isAuthorityEventType,
    isUsagesQueryCapabilityCompatible,
    parseEventsFromBuffer,
    parseIncrementalEvents
} from './eventProtocol';

test('parseEventsFromBuffer returns trailing partial line as remaining', () => {
    const firstChunk =
        '{"type":"configChanged","payload":{"changedKeys":[]},"timestamp":1,"senderInstanceId":"a"}\n{"type":"statusUpdated"';

    const { events, remaining } = parseEventsFromBuffer(firstChunk);

    assert.equal(events.length, 1);
    assert.equal(events[0]?.type, 'configChanged');
    assert.equal(remaining, '{"type":"statusUpdated"');
});

test('parseIncrementalEvents reconstructs a split NDJSON event across chunks', () => {
    const first = parseIncrementalEvents('', '{"type":"statusUpdated"');
    const second = parseIncrementalEvents(
        first.remaining,
        ',"payload":{"providerKey":"kimi","data":{},"source":"api"},"timestamp":2,"senderInstanceId":"b"}\n'
    );

    assert.equal(first.events.length, 0);
    assert.equal(second.events.length, 1);
    assert.equal(second.events[0]?.type, 'statusUpdated');
    assert.equal(second.remaining, '');
});

test('remote metadata update event is registered and parses', () => {
    assert.ok(INTER_INSTANCE_EVENT_TYPES.includes('remoteMetadataUpdated'));
    const { events, remaining } = parseEventsFromBuffer(
        '{"type":"remoteMetadataUpdated","payload":{"target":"models","contentHash":"abc123"},"timestamp":1,"senderInstanceId":"leader"}\n'
    );

    assert.equal(events.length, 1);
    assert.equal(events[0]?.type, 'remoteMetadataUpdated');
    assert.equal(remaining, '');
});

test('parseEventsFromBuffer rejects events with an invalid envelope', () => {
    const { events, remaining } = parseEventsFromBuffer(
        [
            '{"type":"configChanged","payload":{"changedKeys":[]},"timestamp":1}',
            '{"type":"configChanged","payload":null,"timestamp":1,"senderInstanceId":"a"}',
            '{"type":"configChanged","payload":{"changedKeys":[]},"timestamp":"1","senderInstanceId":"a"}',
            '{"type":"unknown","payload":{},"timestamp":1,"senderInstanceId":"a"}'
        ].join('\n') + '\n'
    );

    assert.deepEqual(events, []);
    assert.equal(remaining, '');
});

test('authority event types exclude follower requests', () => {
    assert.equal(isAuthorityEventType('leaderResigning'), true);
    assert.equal(isAuthorityEventType('rateLimitAcquireGranted'), true);
    assert.equal(isAuthorityEventType('cliAuthRefreshCompleted'), true);
    assert.equal(isAuthorityEventType('rateLimitAcquireRequested'), false);
    assert.equal(isAuthorityEventType('statsRefreshRequested'), false);
});

test('API key failover toggle event is registered and parses', () => {
    assert.ok(INTER_INSTANCE_EVENT_TYPES.includes('apiKeyFailoverToggled'));
    const { events, remaining } = parseEventsFromBuffer(
        '{"type":"apiKeyFailoverToggled","payload":{"slot":"zhipu","enabled":true},"timestamp":1,"senderInstanceId":"instance-a"}\n'
    );

    assert.equal(events.length, 1);
    assert.equal(events[0]?.type, 'apiKeyFailoverToggled');
    assert.deepEqual(events[0]?.payload, { slot: 'zhipu', enabled: true });
    assert.equal(remaining, '');
});

test('API key failover request and resolution events are registered and parse', () => {
    assert.ok(INTER_INSTANCE_EVENT_TYPES.includes('apiKeyFailoverRequested'));
    assert.ok(INTER_INSTANCE_EVENT_TYPES.includes('apiKeyFailoverReset'));
    assert.ok(INTER_INSTANCE_EVENT_TYPES.includes('apiKeyFailoverResolved'));
    const { events, remaining } = parseEventsFromBuffer(
        [
            '{"type":"apiKeyFailoverRequested","payload":{"requestId":"request-1","failureRequestId":"failure-1","requestedBy":"follower-a","authorityTerm":"leader-a:1","slot":"zhipu","activeId":"config-a","identity":"config-a:fingerprint:open.bigmodel.cn","site":"open.bigmodel.cn","consecutiveFailureCount":3,"attemptedIdentities":["config-a:fingerprint:open.bigmodel.cn"],"initialConfigId":"config-a","returnedToInitial":false},"timestamp":1,"senderInstanceId":"follower-a"}',
            '{"type":"apiKeyFailoverReset","payload":{"requestId":"reset-1","failureRequestId":"failure-1","requestedBy":"follower-a","authorityTerm":"leader-a:1","slot":"zhipu"},"timestamp":2,"senderInstanceId":"follower-a"}',
            '{"type":"apiKeyFailoverResolved","payload":{"requestId":"request-1","authorityTerm":"leader-a:1","handled":true,"shouldRetry":true,"switched":true},"timestamp":3,"senderInstanceId":"leader-a"}'
        ].join('\n') + '\n'
    );

    assert.equal(events.length, 3);
    assert.equal(events[0]?.type, 'apiKeyFailoverRequested');
    assert.equal(events[1]?.type, 'apiKeyFailoverReset');
    assert.equal(events[2]?.type, 'apiKeyFailoverResolved');
    assert.equal(remaining, '');
});

test('rate limit event types are registered in the event type set', () => {
    for (const type of [
        'liveMetricsSnapshotRequested',
        'liveMetricsSnapshotSync',
        'remoteInstanceHello',
        'remoteInstanceCapabilities',
        'remoteInstanceDisconnected',
        'usagesQueryRequested',
        'usagesQueryCompleted',
        'rateLimitAcquireRequested',
        'rateLimitAcquireGranted',
        'rateLimitQueueUpdated',
        'rateLimitAcquireCancelled',
        'rateLimitReleased',
        'rateLimitLeaseRenewed'
    ]) {
        assert.ok(INTER_INSTANCE_EVENT_TYPES.includes(type as (typeof INTER_INSTANCE_EVENT_TYPES)[number]));
    }
});

test('parseEventsFromBuffer accepts rate limit events', () => {
    const lines = [
        '{"type":"liveMetricsSnapshotRequested","payload":{},"timestamp":0,"senderInstanceId":"follower-a"}',
        '{"type":"liveMetricsSnapshotSync","payload":{"targetInstanceId":"follower-a","authorityTerm":"leader-a:1","entries":[{"event":{"type":"rateLimitWaiting","requestId":"req-1","requestStartTime":1000,"providerName":"GCMP","modelName":"test-model","queuePosition":2},"sourceInstanceId":"leader-a"}]},"timestamp":0,"senderInstanceId":"leader-a"}',
        '{"type":"remoteInstanceHello","payload":{},"timestamp":0,"senderInstanceId":"follower-a"}',
        '{"type":"remoteInstanceCapabilities","payload":{"targetInstanceId":"follower-a","extensionVersion":"1.0.0","usagesQueryProtocolVersion":1},"timestamp":0,"senderInstanceId":"leader-a"}',
        '{"type":"remoteInstanceDisconnected","payload":{"instanceId":"follower-a"},"timestamp":0,"senderInstanceId":"leader"}',
        '{"type":"usagesQueryRequested","payload":{"requestId":"usage-1","requestedBy":"follower-a","authorityTerm":"leader-a:1","query":{"kind":"recentRecords","limit":3}},"timestamp":0,"senderInstanceId":"follower-a"}',
        '{"type":"usagesQueryCompleted","payload":{"requestId":"usage-1","targetInstanceId":"follower-a","authorityTerm":"leader-a:1","result":{"kind":"recentRecords","value":[]}},"timestamp":0,"senderInstanceId":"leader-a"}',
        '{"type":"rateLimitAcquireRequested","payload":{"authorityTerm":"leader-a:1","requestId":"r1","bucketKey":"k","costs":{"requests":1,"tokens":10},"dims":{"rpm":60}},"timestamp":1,"senderInstanceId":"a"}',
        '{"type":"rateLimitAcquireGranted","payload":{"authorityTerm":"leader-a:1","requestId":"r1","waitMs":0,"grantId":"g1"},"timestamp":2,"senderInstanceId":"b"}',
        '{"type":"rateLimitQueueUpdated","payload":{"authorityTerm":"leader-a:1","requestId":"r1","queuePosition":2},"timestamp":3,"senderInstanceId":"b"}',
        '{"type":"rateLimitAcquireCancelled","payload":{"authorityTerm":"leader-a:1","requestId":"r1","bucketKey":"k"},"timestamp":4,"senderInstanceId":"a"}',
        '{"type":"rateLimitReleased","payload":{"authorityTerm":"leader-a:1","grantId":"g1","refund":{"tokens":10}},"timestamp":5,"senderInstanceId":"a"}',
        '{"type":"rateLimitLeaseRenewed","payload":{"authorityTerm":"leader-a:1","grantId":"g1"},"timestamp":6,"senderInstanceId":"a"}'
    ].join('\n');

    const { events, remaining } = parseEventsFromBuffer(lines + '\n');

    assert.equal(events.length, 13);
    assert.equal(events[0]?.type, 'liveMetricsSnapshotRequested');
    assert.equal(events[1]?.type, 'liveMetricsSnapshotSync');
    assert.equal(events[2]?.type, 'remoteInstanceHello');
    assert.equal(events[3]?.type, 'remoteInstanceCapabilities');
    assert.equal(events[4]?.type, 'remoteInstanceDisconnected');
    assert.equal(events[5]?.type, 'usagesQueryRequested');
    assert.equal(events[6]?.type, 'usagesQueryCompleted');
    assert.equal(events[7]?.type, 'rateLimitAcquireRequested');
    assert.equal(events[8]?.type, 'rateLimitAcquireGranted');
    assert.equal(events[9]?.type, 'rateLimitQueueUpdated');
    assert.equal(events[10]?.type, 'rateLimitAcquireCancelled');
    assert.equal(events[11]?.type, 'rateLimitReleased');
    assert.equal(events[12]?.type, 'rateLimitLeaseRenewed');
    assert.equal(remaining, '');
});

test('usage query capability requires matching extension and protocol versions', () => {
    const capability = {
        targetInstanceId: 'follower-a',
        extensionVersion: '1.0.0',
        usagesQueryProtocolVersion: USAGES_QUERY_PROTOCOL_VERSION
    };

    assert.equal(isUsagesQueryCapabilityCompatible('1.0.0', capability), true);
    assert.equal(isUsagesQueryCapabilityCompatible('1.0.1', capability), false);
    assert.equal(
        isUsagesQueryCapabilityCompatible('1.0.0', {
            ...capability,
            usagesQueryProtocolVersion: USAGES_QUERY_PROTOCOL_VERSION + 1
        }),
        false
    );
    assert.equal(isUsagesQueryCapabilityCompatible('1.0.0', undefined), false);
    assert.equal(
        isUsagesQueryCapabilityCompatible('1.0.0', {
            ...capability,
            usagesQueryProtocolVersion: USAGES_QUERY_PROTOCOL_VERSION - 1
        }),
        false
    );
});
