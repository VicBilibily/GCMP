import assert from 'node:assert/strict';
import test from 'node:test';

import { OpenAIResponsesCallIdResolver } from './openaiResponsesCallIdResolver';

test('缺失 callId 时生成稳定的确定性 tool call id', () => {
    const resolverA = new OpenAIResponsesCallIdResolver();
    const resolverB = new OpenAIResponsesCallIdResolver();

    const idA = resolverA.resolveToolCallId({
        messageIndex: 3,
        partIndex: 1,
        name: 'edit_file',
        argumentsJson: '{"b":1,"a":2}'
    });
    const idB = resolverB.resolveToolCallId({
        messageIndex: 3,
        partIndex: 1,
        name: 'edit_file',
        argumentsJson: '{"a":2,"b":1}'
    });

    assert.equal(idA, idB);
});

test('相同工具名与参数但不同位置时生成不同 id', () => {
    const resolver = new OpenAIResponsesCallIdResolver();

    const first = resolver.resolveToolCallId({
        messageIndex: 3,
        partIndex: 1,
        name: 'edit_file',
        argumentsJson: '{"a":2,"b":1}'
    });
    const second = resolver.resolveToolCallId({
        messageIndex: 3,
        partIndex: 2,
        name: 'edit_file',
        argumentsJson: '{"a":2,"b":1}'
    });

    assert.notEqual(first, second);
});

test('缺失 callId 的 tool result 复用最近待匹配的 tool call id', () => {
    const resolver = new OpenAIResponsesCallIdResolver();

    const toolCallId = resolver.resolveToolCallId({
        messageIndex: 1,
        partIndex: 0,
        name: 'read_file',
        argumentsJson: '{"path":"a.ts"}'
    });
    const toolResultId = resolver.resolveToolResultCallId({});

    assert.equal(toolResultId, toolCallId);
});

test('已有 callId 的 tool result 原样保留，并移除待匹配项', () => {
    const resolver = new OpenAIResponsesCallIdResolver();

    resolver.resolveToolCallId({
        callId: 'call_server',
        messageIndex: 1,
        partIndex: 0,
        name: 'read_file',
        argumentsJson: '{"path":"a.ts"}'
    });

    const toolResultId = resolver.resolveToolResultCallId({ callId: 'call_server' });
    const nextPending = resolver.resolveToolResultCallId({});

    assert.equal(toolResultId, 'call_server');
    assert.equal(nextPending, undefined);
});

test('重复 callId 首次保持原样，后续改写为递增后缀', () => {
    const resolver = new OpenAIResponsesCallIdResolver();

    const ids = [1, 3, 5].map(messageIndex =>
        resolver.resolveToolCallId({
            callId: 'apply_patch:31',
            messageIndex,
            partIndex: 0,
            name: 'apply_patch',
            argumentsJson: '{}'
        })
    );

    assert.deepEqual(ids, ['apply_patch:31', 'apply_patch:31__gcmpDup2', 'apply_patch:31__gcmpDup3']);
});

test('同一条消息内重复 callId 也会被改写', () => {
    const resolver = new OpenAIResponsesCallIdResolver();

    const first = resolver.resolveToolCallId({
        callId: 'x:1',
        messageIndex: 1,
        partIndex: 0,
        name: 'apply_patch',
        argumentsJson: '{}'
    });
    const second = resolver.resolveToolCallId({
        callId: 'x:1',
        messageIndex: 1,
        partIndex: 1,
        name: 'apply_patch',
        argumentsJson: '{}'
    });

    assert.equal(first, 'x:1');
    assert.equal(second, 'x:1__gcmpDup2');
});

test('重复 callId 的 tool result 按序配对到改写后的 id', () => {
    const resolver = new OpenAIResponsesCallIdResolver();

    resolver.resolveToolCallId({
        callId: 'apply_patch:31',
        messageIndex: 1,
        partIndex: 0,
        name: 'apply_patch',
        argumentsJson: '{}'
    });
    const result1 = resolver.resolveToolResultCallId({ callId: 'apply_patch:31' });
    resolver.resolveToolCallId({
        callId: 'apply_patch:31',
        messageIndex: 3,
        partIndex: 0,
        name: 'apply_patch',
        argumentsJson: '{}'
    });
    const result2 = resolver.resolveToolResultCallId({ callId: 'apply_patch:31' });

    assert.equal(result1, 'apply_patch:31');
    assert.equal(result2, 'apply_patch:31__gcmpDup2');
});

test('重复 id 场景下缺失 callId 的 result 仍按 pending 队列配对', () => {
    const resolver = new OpenAIResponsesCallIdResolver();

    resolver.resolveToolCallId({
        callId: 'a:1',
        messageIndex: 1,
        partIndex: 0,
        name: 'apply_patch',
        argumentsJson: '{}'
    });
    resolver.resolveToolCallId({
        callId: 'a:1',
        messageIndex: 3,
        partIndex: 0,
        name: 'apply_patch',
        argumentsJson: '{}'
    });

    assert.equal(resolver.resolveToolResultCallId({}), 'a:1');
    assert.equal(resolver.resolveToolResultCallId({}), 'a:1__gcmpDup2');
});

test('匿名结果消费后显式结果匹配后续同 id 调用', () => {
    const resolver = new OpenAIResponsesCallIdResolver();
    const params = { callId: 'a', messageIndex: 1, partIndex: 0, name: 'apply_patch', argumentsJson: '{}' };
    assert.equal(resolver.resolveToolCallId(params), 'a');
    assert.equal(resolver.resolveToolResultCallId({}), 'a');
    assert.equal(resolver.resolveToolCallId(params), 'a__gcmpDup2');
    assert.equal(resolver.resolveToolResultCallId({ callId: 'a' }), 'a__gcmpDup2');
    assert.equal(resolver.resolveToolResultCallId({}), undefined);
});

test('孤儿 tool result 保持原样透传', () => {
    const resolver = new OpenAIResponsesCallIdResolver();

    assert.equal(resolver.resolveToolResultCallId({ callId: 'orphan:1' }), 'orphan:1');
});
