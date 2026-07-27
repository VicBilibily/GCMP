import assert from 'node:assert/strict';
import test from 'node:test';

import { preprocessOpenAIResponsesInputItems } from './openaiResponsesInputPreprocessor';

test('预处理：移除 message / function_call / function_call_output 的可选 id', () => {
    const items = [
        {
            type: 'message',
            id: 'msg_random',
            role: 'user',
            content: [{ type: 'input_text', text: 'hello' }]
        },
        {
            type: 'function_call',
            id: 'fc_random',
            call_id: 'call_1',
            name: 'read_file',
            arguments: '{}'
        },
        {
            type: 'function_call_output',
            id: 'fco_random',
            call_id: 'call_1',
            output: 'ok'
        }
    ];

    preprocessOpenAIResponsesInputItems(items);

    assert.equal('id' in items[0], false);
    assert.equal('id' in items[1], false);
    assert.equal('id' in items[2], false);
});

test('预处理：保留 reasoning 的原始 id', () => {
    const items = [
        {
            type: 'reasoning',
            id: 'rsn_server',
            summary: [],
            encrypted_content: 'cipher'
        }
    ];

    preprocessOpenAIResponsesInputItems(items);

    assert.equal(items[0].id, 'rsn_server');
});

test('预处理：Responses function_call.arguments 规范为稳定键序 JSON', () => {
    const items = [
        {
            type: 'function_call',
            call_id: 'call_1',
            name: 'edit_file',
            arguments: '{"b":1,"a":{"d":4,"c":3}}'
        }
    ];

    preprocessOpenAIResponsesInputItems(items);

    assert.equal(items[0].arguments, '{"a":{"c":3,"d":4},"b":1}');
});

test('预处理：Responses 非法 JSON arguments 保持原样', () => {
    const items = [
        {
            type: 'function_call',
            call_id: 'call_1',
            name: 'run_cmd',
            arguments: '{not-json}'
        }
    ];

    preprocessOpenAIResponsesInputItems(items);

    assert.equal(items[0].arguments, '{not-json}');
});

test('预处理：Responses function tools parameters 递归按键排序', () => {
    const tools = [
        {
            type: 'function',
            name: 'write_file',
            parameters: {
                required: ['b', 'a'],
                properties: {
                    z: { type: 'string', description: 'z' },
                    a: { type: 'object', properties: { y: { type: 'number' }, x: { type: 'number' } } }
                },
                type: 'object'
            }
        }
    ];

    preprocessOpenAIResponsesInputItems([], tools);

    assert.deepEqual(tools[0].parameters, {
        properties: {
            a: {
                properties: {
                    x: { type: 'number' },
                    y: { type: 'number' }
                },
                type: 'object'
            },
            z: { description: 'z', type: 'string' }
        },
        required: ['b', 'a'],
        type: 'object'
    });
});
