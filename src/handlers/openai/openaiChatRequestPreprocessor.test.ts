import assert from 'node:assert/strict';
import test from 'node:test';

import { preprocessOpenAIChatRequest } from './openaiChatRequestPreprocessor';

test('预处理：tool_calls.arguments 规范为稳定键序 JSON', () => {
    const messages = [
        {
            role: 'assistant',
            tool_calls: [
                {
                    type: 'function',
                    function: {
                        name: 'edit_file',
                        arguments: '{"b":1,"a":{"d":4,"c":3},"arr":[{"y":2,"x":1}]}'
                    }
                }
            ]
        }
    ];

    preprocessOpenAIChatRequest(messages);

    assert.equal(messages[0].tool_calls[0].function.arguments, '{"a":{"c":3,"d":4},"arr":[{"x":1,"y":2}],"b":1}');
});

test('预处理：非法 JSON arguments 保持原样', () => {
    const messages = [
        {
            role: 'assistant',
            tool_calls: [
                {
                    type: 'function',
                    function: {
                        name: 'run_cmd',
                        arguments: '{not-json}'
                    }
                }
            ]
        }
    ];

    preprocessOpenAIChatRequest(messages);

    assert.equal(messages[0].tool_calls[0].function.arguments, '{not-json}');
});

test('预处理：tool schema parameters 递归按键排序且保留数组顺序', () => {
    const tools = [
        {
            type: 'function',
            function: {
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
        }
    ];

    preprocessOpenAIChatRequest([], tools);

    assert.deepEqual(tools[0].function.parameters, {
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
