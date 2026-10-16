import assert from 'node:assert/strict';
import test from 'node:test';
import type { LanguageModelChatMessage, ProvideLanguageModelChatResponseOptions } from 'vscode';
import type { StatefulMarkerContainer } from '../../handlers/stateful/statefulMarker';
import { SdkUsageCache } from './sdkUsageCache';

const marker: StatefulMarkerContainer = {
    extension: 'vicanent.gcmp',
    provider: 'provider',
    modelId: 'model',
    sdkMode: 'openai',
    sessionId: 'conversation',
    responseId: 'never-replay',
    completeSignature: 'never-replay',
    usage: { prompt_tokens: 1000, completion_tokens: 20, total_tokens: 1020 }
};
function makeMessage(role: LanguageModelChatMessage['role'], value: string): LanguageModelChatMessage {
    return { role, name: undefined, content: [{ value }] };
}
const messages = [makeMessage(3, 'system'), makeMessage(1, 'task')];
const next = [...messages, makeMessage(2, 'answer'), makeMessage(1, 'next')];
const options = (): ProvideLanguageModelChatResponseOptions => ({ toolMode: 1, requestInitiator: 'core' });

test('SDK local cache returns only detached usage and the input boundary', () => {
    const cache = new SdkUsageCache();
    const first = options();
    const original = structuredClone(marker);
    cache.begin(first, original, messages);
    cache.remember(first, original);
    original.usage!.prompt_tokens = 9;
    const second = options();
    cache.begin(second, marker, next);
    assert.deepEqual(cache.get(second, next), { usage: marker.usage, messageCount: 2 });
    const reference = cache.get(second, next)!;
    assert.equal('responseId' in reference, false);
    assert.equal('completeSignature' in reference, false);
    assert.equal(JSON.stringify(next).includes('stateful_marker'), false);
    Object.assign(reference.usage, { prompt_tokens: 9 });
    assert.equal(cache.get(second, next)?.usage.prompt_tokens, 1000);
});

test('SDK local cache isolates session, provider, model and protocol', () => {
    const cache = new SdkUsageCache();
    const first = options();
    cache.begin(first, marker, messages);
    cache.remember(first, marker);
    for (const other of [
        { ...marker, sessionId: 'other' },
        { ...marker, provider: 'other' },
        { ...marker, modelId: 'other' },
        { ...marker, sdkMode: 'anthropic' as const }
    ]) {
        const request = options();
        cache.begin(request, other, next);
        assert.equal(cache.get(request, next), undefined);
    }
});

test('SDK local cache rejects compaction, history edits and changed tools', () => {
    const cache = new SdkUsageCache();
    const first = options();
    cache.begin(first, marker, messages);
    cache.remember(first, marker);
    for (const changed of [
        next.slice(2),
        next.slice(0, 1),
        [makeMessage(3, 'changed system'), ...next.slice(1)],
        [next[0], makeMessage(1, 'changed task'), ...next.slice(2)]
    ]) {
        const request = options();
        cache.begin(request, marker, changed);
        assert.equal(cache.get(request, changed), undefined);
    }
    for (const request of [
        { ...options(), toolMode: 2 },
        { ...options(), tools: [{ name: 'tool', description: 'changed', inputSchema: { type: 'object' } }] }
    ]) {
        cache.begin(request, marker, next);
        assert.equal(cache.get(request, next), undefined);
    }
});

test('SDK local cache does not overwrite a newer reference with a late older response', () => {
    const cache = new SdkUsageCache();
    const older = options();
    const newer = options();
    cache.begin(older, marker, messages);
    cache.begin(newer, marker, messages);
    cache.remember(newer, { ...marker, usage: { prompt_tokens: 2000, completion_tokens: 20, total_tokens: 2020 } });
    cache.remember(older, marker);
    assert.equal(cache.get(newer, next)?.usage.prompt_tokens, 2000);
});

test('SDK local cache rejects foreign identity, subagent usage and invalid counts', () => {
    const cache = new SdkUsageCache();
    for (const invalid of [
        { ...marker, sessionId: 'other' },
        { ...marker, modelId: 'other' },
        { ...marker, provider: 'other' },
        { ...marker, sdkMode: 'anthropic' as const },
        { ...marker, subSessionId: 'sub_other' },
        { ...marker, continuity: { version: 1 as const, scope: 'subagent' as const, agentRole: 'subagent' as const } },
        { ...marker, usage: undefined },
        ...[0, -1, NaN, Infinity, 1.5].map(prompt_tokens => ({
            ...marker,
            usage: { prompt_tokens, completion_tokens: 20, total_tokens: 1020 }
        })),
        { ...marker, usage: { prompt_tokens: 1000, completion_tokens: NaN, total_tokens: 1020 } }
    ]) {
        const request = options();
        cache.begin(request, marker, messages);
        cache.remember(request, invalid);
        assert.equal(cache.get(request, next), undefined);
    }
});

test('SDK local cache expires references and evicts entries above the capacity bound', () => {
    let now = 0;
    const cache = new SdkUsageCache(() => now);
    const first = options();
    cache.begin(first, marker, messages);
    cache.remember(first, marker);
    for (let index = 0; index < 1000; index++) {
        const request = options();
        const other = { ...marker, sessionId: `other-${index}` };
        cache.begin(request, other, messages);
        cache.remember(request, other);
    }
    assert.equal(cache.get(first, next), undefined);
    const last = options();
    cache.begin(last, { ...marker, sessionId: 'other-999' }, next);
    assert.equal(cache.get(last, next)?.usage.prompt_tokens, 1000);
    now += 7 * 24 * 60 * 60 * 1000;
    assert.equal(cache.get(last, next), undefined);
});

test('SDK local cache disposal rejects late writes and new requests', () => {
    const cache = new SdkUsageCache();
    const request = options();
    cache.begin(request, marker, messages);
    cache.remember(request, marker);
    cache.dispose();
    cache.remember(request, marker);
    assert.equal(cache.get(request, next), undefined);
    cache.begin(request, marker, messages);
    cache.remember(request, marker);
    assert.equal(cache.get(request, next), undefined);
});

test('SDK local cache treats unhashable history as a miss', () => {
    const cache = new SdkUsageCache();
    const request = options();
    const broken = [
        {
            ...makeMessage(1, 'task'),
            toJSON() {
                throw new Error('unhashable');
            }
        }
    ];
    assert.doesNotThrow(() => cache.begin(request, marker, broken));
    cache.remember(request, marker);
    assert.equal(cache.get(request, broken), undefined);
});
