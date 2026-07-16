import assert from 'node:assert/strict';
import test from 'node:test';

import { parseEventsFromBuffer, parseIncrementalEvents } from './eventProtocol';

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
