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
