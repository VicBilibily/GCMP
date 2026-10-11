import assert from 'node:assert/strict';
import test from 'node:test';
import { INTER_INSTANCE_EVENT_TYPES, isAuthorityEventType, parseEventsFromBuffer } from '../eventProtocol';
import { isLeaderLivenessPayload, LEADER_LIVENESS_PROTOCOL_VERSION } from './protocol';

for (const type of ['leaderLivenessRequested', 'leaderLivenessConfirmed'] as const) {
    test(`${type} is registered with the correct authority requirement`, () => {
        assert.equal(LEADER_LIVENESS_PROTOCOL_VERSION, 1);
        assert.ok(INTER_INSTANCE_EVENT_TYPES.includes(type));
        assert.equal(isAuthorityEventType(type), type === 'leaderLivenessConfirmed');
        const value = {
            type,
            payload: { requestId: 'nonce', targetInstanceId: 'leader', authorityTerm: 'leader:1' },
            timestamp: 0,
            senderInstanceId: 'sender'
        };
        assert.equal(parseEventsFromBuffer(JSON.stringify(value) + '\n').events.length, 1);
    });
    for (const payload of [
        null,
        [],
        {},
        { requestId: 1, targetInstanceId: 'leader', authorityTerm: 'leader:1' },
        { requestId: '', targetInstanceId: 'leader', authorityTerm: 'leader:1' },
        { requestId: 'x'.repeat(129), targetInstanceId: 'leader', authorityTerm: 'leader:1' },
        { requestId: 'nonce', targetInstanceId: 1, authorityTerm: 'leader:1' },
        { requestId: 'nonce', targetInstanceId: 'x'.repeat(129), authorityTerm: 'leader:1' },
        { requestId: 'nonce', targetInstanceId: 'leader', authorityTerm: null },
        { requestId: 'nonce', targetInstanceId: 'leader', authorityTerm: 'x'.repeat(161) }
    ]) {
        test(`${type} rejects malformed or oversized payload ${JSON.stringify(payload)}`, () => {
            assert.equal(isLeaderLivenessPayload(payload), false);
            assert.deepEqual(
                parseEventsFromBuffer(JSON.stringify({ type, payload, timestamp: 0, senderInstanceId: 'a' }) + '\n')
                    .events,
                []
            );
        });
    }
}
