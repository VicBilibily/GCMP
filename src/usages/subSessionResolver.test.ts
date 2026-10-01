import assert from 'node:assert/strict';
import test from 'node:test';

import { encodeStatefulMarkerPayload } from '../handlers/statefulMarkerCodec';
import { resolveSubSessionId, type SubSessionMessageLike } from './subSessionResolver';

const ROLE_USER = 1;
const ROLE_ASSISTANT = 2;

function userMessage(text: string): SubSessionMessageLike {
    return { role: ROLE_USER, content: [{ value: text }] };
}

function assistantWithMarker(
    subSessionId: string | undefined,
    sessionId = 'parent-1',
    extension = 'vicanent.gcmp'
): SubSessionMessageLike {
    const data = encodeStatefulMarkerPayload('test-model', {
        extension,
        provider: 'test-provider',
        modelId: 'test-model',
        sdkMode: 'openai',
        sessionId,
        subSessionId,
        responseId: 'response-1'
    });
    return { role: ROLE_ASSISTANT, content: [{ mimeType: 'stateful_marker', data }] };
}

test('non-subagent request kinds resolve to undefined', () => {
    const messages = [userMessage('task')];
    assert.equal(resolveSubSessionId(messages, 'parent-1', 'main-agent', true), undefined);
    assert.equal(resolveSubSessionId(messages, 'parent-1', 'summarization', true), undefined);
    assert.equal(resolveSubSessionId(messages, 'parent-1', 'chat-title', true), undefined);
});

test('subagent without marker generates deterministic id in expected format', () => {
    const messages = [userMessage('Find all usages of captureAttempt')];
    const first = resolveSubSessionId(messages, 'parent-1', 'search-subagent', true);
    const second = resolveSubSessionId(messages, 'parent-1', 'search-subagent', true);
    assert.match(first ?? '', /^sub_[0-9a-f]{32}$/);
    assert.equal(first, second);
});

test('generated id varies with kind, task text and stable parent session', () => {
    const task = 'Inspect the failover manager';
    const search = resolveSubSessionId([userMessage(task)], 'parent-1', 'search-subagent', true);
    const execution = resolveSubSessionId([userMessage(task)], 'parent-1', 'execution-subagent', true);
    const otherTask = resolveSubSessionId([userMessage('Other task')], 'parent-1', 'search-subagent', true);
    const otherParent = resolveSubSessionId([userMessage(task)], 'parent-2', 'search-subagent', true);
    assert.notEqual(search, execution);
    assert.notEqual(search, otherTask);
    assert.notEqual(search, otherParent);
});

test('unstable parent session is not mixed into the deterministic anchor', () => {
    const messages = [userMessage('Same task')];
    const first = resolveSubSessionId(messages, 'random-uuid-a', 'search-subagent', false);
    const second = resolveSubSessionId(messages, 'random-uuid-b', 'search-subagent', false);
    assert.equal(first, second);
    assert.match(first ?? '', /^sub_[0-9a-f]{32}$/);
});

test('task text whitespace is normalized before hashing', () => {
    const compact = resolveSubSessionId([userMessage('a b')], 'parent-1', 'search-subagent', true);
    const spread = resolveSubSessionId([userMessage('a  \n\t b')], 'parent-1', 'search-subagent', true);
    assert.equal(compact, spread);
});

for (const parentSessionStable of [true, false]) {
    test(`long tasks preserve distinct suffixes with parent stability ${parentSessionStable}`, () => {
        const common = 'Shared context and existing contracts. '.repeat(200);
        assert.ok(common.length > 6000);
        const firstTask = [userMessage(`${common}Inspect queued request routing.`)];
        const secondTask = [userMessage(`${common}Inspect usage archive records.`)];
        const first = resolveSubSessionId(firstTask, 'parent-1', 'search-subagent', parentSessionStable);
        const second = resolveSubSessionId(secondTask, 'parent-1', 'search-subagent', parentSessionStable);

        assert.match(first ?? '', /^sub_[0-9a-f]{32}$/);
        assert.match(second ?? '', /^sub_[0-9a-f]{32}$/);
        assert.notEqual(first, second);
        assert.equal(resolveSubSessionId(firstTask, 'parent-1', 'search-subagent', parentSessionStable), first);
    });
}

test('subSessionId is read back from the most recent stateful marker', () => {
    const recorded = 'sub_' + 'a'.repeat(32);
    const messages = [userMessage('Changed task text'), assistantWithMarker(recorded)];
    assert.equal(resolveSubSessionId(messages, 'parent-1', 'execution-subagent', true), recorded);
});

test('malformed marker subSessionId falls back to generation', () => {
    const messages = [userMessage('Task'), assistantWithMarker('junk-value')];
    const resolved = resolveSubSessionId(messages, 'parent-1', 'search-subagent', true);
    assert.match(resolved ?? '', /^sub_[0-9a-f]{32}$/);
    assert.notEqual(resolved, 'junk-value');
});

test('marker from another parent session is ignored', () => {
    const recorded = 'sub_' + 'b'.repeat(32);
    const resolved = resolveSubSessionId(
        [userMessage('Task'), assistantWithMarker(recorded, 'parent-2')],
        'parent-1',
        'search-subagent',
        true
    );
    assert.match(resolved ?? '', /^sub_[0-9a-f]{32}$/);
    assert.notEqual(resolved, recorded);
});

test('marker from another extension is ignored', () => {
    const recorded = 'sub_' + 'c'.repeat(32);
    const resolved = resolveSubSessionId(
        [userMessage('Task'), assistantWithMarker(recorded, 'parent-1', 'other.extension')],
        'parent-1',
        'search-subagent',
        true
    );
    assert.match(resolved ?? '', /^sub_[0-9a-f]{32}$/);
    assert.notEqual(resolved, recorded);
});

test('latest matching marker without a valid subSessionId prevents stale marker reuse', () => {
    const stale = 'sub_' + 'd'.repeat(32);
    const resolved = resolveSubSessionId(
        [userMessage('Task'), assistantWithMarker(stale), assistantWithMarker(undefined)],
        'parent-1',
        'search-subagent',
        true
    );
    assert.match(resolved ?? '', /^sub_[0-9a-f]{32}$/);
    assert.notEqual(resolved, stale);
});

test('missing user message yields undefined', () => {
    const messages: SubSessionMessageLike[] = [{ role: ROLE_ASSISTANT, content: [{ value: 'no task' }] }];
    assert.equal(resolveSubSessionId(messages, 'parent-1', 'search-subagent', true), undefined);
});
