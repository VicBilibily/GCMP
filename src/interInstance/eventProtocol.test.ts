import assert from 'node:assert/strict';
import test from 'node:test';

import { INTER_INSTANCE_EVENT_TYPES, parseEventsFromBuffer, parseIncrementalEvents } from './eventProtocol';

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

test('rate limit event types are registered in the event type set', () => {
    for (const type of [
        'remoteInstanceDisconnected',
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
        '{"type":"remoteInstanceDisconnected","payload":{"instanceId":"follower-a"},"timestamp":0,"senderInstanceId":"leader"}',
        '{"type":"rateLimitAcquireRequested","payload":{"authorityTerm":"leader-a:1","requestId":"r1","bucketKey":"k","costs":{"requests":1,"tokens":10},"dims":{"rpm":60}},"timestamp":1,"senderInstanceId":"a"}',
        '{"type":"rateLimitAcquireGranted","payload":{"authorityTerm":"leader-a:1","requestId":"r1","waitMs":0,"grantId":"g1"},"timestamp":2,"senderInstanceId":"b"}',
        '{"type":"rateLimitQueueUpdated","payload":{"authorityTerm":"leader-a:1","requestId":"r1","queuePosition":2},"timestamp":3,"senderInstanceId":"b"}',
        '{"type":"rateLimitAcquireCancelled","payload":{"authorityTerm":"leader-a:1","requestId":"r1","bucketKey":"k"},"timestamp":4,"senderInstanceId":"a"}',
        '{"type":"rateLimitReleased","payload":{"authorityTerm":"leader-a:1","grantId":"g1","refund":{"tokens":10}},"timestamp":5,"senderInstanceId":"a"}',
        '{"type":"rateLimitLeaseRenewed","payload":{"authorityTerm":"leader-a:1","grantId":"g1"},"timestamp":6,"senderInstanceId":"a"}'
    ].join('\n');

    const { events, remaining } = parseEventsFromBuffer(lines + '\n');

    assert.equal(events.length, 7);
    assert.equal(events[0]?.type, 'remoteInstanceDisconnected');
    assert.equal(events[1]?.type, 'rateLimitAcquireRequested');
    assert.equal(events[2]?.type, 'rateLimitAcquireGranted');
    assert.equal(events[3]?.type, 'rateLimitQueueUpdated');
    assert.equal(events[4]?.type, 'rateLimitAcquireCancelled');
    assert.equal(events[5]?.type, 'rateLimitReleased');
    assert.equal(events[6]?.type, 'rateLimitLeaseRenewed');
    assert.equal(remaining, '');
});
