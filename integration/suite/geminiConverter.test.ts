import assert from 'node:assert/strict';

import * as vscode from 'vscode';

import { convertMessagesToGemini, convertToolsToGemini } from '../../src/handlers/gemini/geminiConverter';
import { encodeStatefulMarker, type GeminiThoughtSignatureMarker } from '../../src/handlers/statefulMarker';
import { CustomDataPartMimeTypes } from '../../src/handlers/types';

function createGeminiMarker(signatures: GeminiThoughtSignatureMarker[]): vscode.LanguageModelDataPart {
    return new vscode.LanguageModelDataPart(
        encodeStatefulMarker('gemini-test', {
            sessionId: 'session-1',
            responseId: 'response-1',
            provider: 'test-provider',
            modelId: 'gemini-test',
            sdkMode: 'gemini',
            geminiRequestIdentity: 'request-identity',
            geminiThoughtSignatures: signatures
        }),
        CustomDataPartMimeTypes.StatefulMarker
    );
}

function createGeminiRawMarker(): vscode.LanguageModelDataPart {
    return new vscode.LanguageModelDataPart(
        encodeStatefulMarker('gemini-test', {
            sessionId: 'session-1',
            responseId: 'response-1',
            provider: 'test-provider',
            modelId: 'gemini-test',
            sdkMode: 'gemini',
            geminiRequestIdentity: 'request-identity',
            geminiContents: [
                {
                    role: 'model',
                    parts: [
                        { text: 'first', thoughtSignature: 'first-sig' },
                        { text: 'second', thoughtSignature: 'second-sig' }
                    ]
                }
            ]
        }),
        CustomDataPartMimeTypes.StatefulMarker
    );
}

function createGeminiRawToolMarker(
    calls: Array<{ localCallId: string; upstreamCallId?: string; name: string }>
): vscode.LanguageModelDataPart {
    return new vscode.LanguageModelDataPart(
        encodeStatefulMarker('gemini-test', {
            sessionId: 'session-1',
            responseId: 'response-1',
            provider: 'test-provider',
            modelId: 'gemini-test',
            sdkMode: 'gemini',
            geminiRequestIdentity: 'request-identity',
            geminiToolCalls: calls,
            geminiContents: [
                {
                    role: 'model',
                    parts: calls.map(call => ({
                        functionCall: {
                            ...(call.upstreamCallId ? { id: call.upstreamCallId } : {}),
                            name: call.name,
                            args: {}
                        }
                    }))
                }
            ]
        }),
        CustomDataPartMimeTypes.StatefulMarker
    );
}

suite('geminiConverter', () => {
    test('保留 function call 和 function response 的官方 id', () => {
        const result = convertMessagesToGemini([
            {
                role: vscode.LanguageModelChatMessageRole.Assistant,
                content: [new vscode.LanguageModelToolCallPart('call-1', 'read_file', { path: 'README.md' })]
            },
            {
                role: vscode.LanguageModelChatMessageRole.User,
                content: [new vscode.LanguageModelToolResultPart('call-1', [new vscode.LanguageModelTextPart('ok')])]
            }
        ] as never);

        assert.deepEqual(result.contents, [
            {
                role: 'model',
                parts: [
                    {
                        functionCall: {
                            id: 'call-1',
                            name: 'read_file',
                            args: { path: 'README.md' }
                        }
                    }
                ]
            },
            {
                role: 'user',
                parts: [
                    {
                        functionResponse: {
                            id: 'call-1',
                            name: 'read_file',
                            response: { result: 'ok' }
                        }
                    }
                ]
            }
        ]);
    });

    test('通过 parametersJsonSchema 发送工具 schema 并清理编辑器注解', () => {
        const tools = convertToolsToGemini([
            {
                name: 'read_file',
                description: 'Read a file',
                inputSchema: {
                    type: 'object',
                    title: 'Dropped',
                    properties: {
                        path: { type: 'string', markdownDescription: 'Dropped description' }
                    },
                    required: ['path']
                }
            }
        ] as never);

        assert.deepEqual(tools, [
            {
                functionDeclarations: [
                    {
                        name: 'read_file',
                        description: 'Read a file',
                        parametersJsonSchema: {
                            type: 'object',
                            properties: { path: { type: 'string' } },
                            required: ['path']
                        }
                    }
                ]
            }
        ]);
    });

    test('parametersJsonSchema 保留标准 JSON Schema 引用和联合类型', () => {
        const tools = convertToolsToGemini([
            {
                name: 'search',
                description: 'Search',
                inputSchema: {
                    type: 'object',
                    additionalProperties: false,
                    $defs: { identifier: { type: 'string' } },
                    properties: {
                        mode: { oneOf: [{ type: 'string', enum: ['a', 'b'] }, { type: 'number' }] },
                        ref: { $ref: '#/$defs/identifier' },
                        nested: {
                            type: 'object',
                            properties: { count: { type: 'integer', minimum: 0 } },
                            additionalProperties: false
                        }
                    }
                }
            }
        ] as never);

        assert.deepEqual(tools, [
            {
                functionDeclarations: [
                    {
                        name: 'search',
                        description: 'Search',
                        parametersJsonSchema: {
                            type: 'object',
                            additionalProperties: false,
                            $defs: { identifier: { type: 'string' } },
                            properties: {
                                mode: { oneOf: [{ type: 'string', enum: ['a', 'b'] }, { type: 'number' }] },
                                ref: { $ref: '#/$defs/identifier' },
                                nested: {
                                    type: 'object',
                                    properties: { count: { type: 'integer', minimum: 0 } },
                                    additionalProperties: false
                                }
                            }
                        }
                    }
                ]
            }
        ]);
    });

    test('parametersJsonSchema 保留 JSON Schema 数值约束', () => {
        const tools = convertToolsToGemini([
            {
                name: 'ask',
                description: 'Ask questions',
                inputSchema: {
                    type: 'object',
                    minProperties: 1,
                    maxProperties: 2,
                    properties: {
                        questions: {
                            type: 'array',
                            minItems: 1,
                            maxItems: 3,
                            items: {
                                type: 'object',
                                properties: {
                                    header: { type: 'string', minLength: 1, maxLength: 50 }
                                }
                            }
                        }
                    }
                }
            }
        ] as never);

        assert.deepEqual(tools[0].functionDeclarations?.[0].parametersJsonSchema, {
            type: 'object',
            minProperties: 1,
            maxProperties: 2,
            properties: {
                questions: {
                    type: 'array',
                    minItems: 1,
                    maxItems: 3,
                    items: {
                        type: 'object',
                        properties: {
                            header: { type: 'string', minLength: 1, maxLength: 50 }
                        }
                    }
                }
            }
        });
    });

    test('root 为 array 的工具 schema 以 items 作为 parametersJsonSchema', () => {
        const tools = convertToolsToGemini([
            {
                name: 'batch',
                description: 'Batch',
                inputSchema: {
                    type: 'array',
                    items: {
                        type: 'object',
                        properties: { id: { type: 'string' } },
                        required: ['id']
                    }
                }
            }
        ] as never);

        assert.deepEqual(tools, [
            {
                functionDeclarations: [
                    {
                        name: 'batch',
                        description: 'Batch',
                        parametersJsonSchema: {
                            type: 'object',
                            properties: { id: { type: 'string' } },
                            required: ['id']
                        }
                    }
                ]
            }
        ]);
    });

    test('tool result 的媒体数据经 functionResponse.parts 回传', () => {
        const imageData = new Uint8Array([1, 2, 3]);
        const result = convertMessagesToGemini(
            [
                {
                    role: vscode.LanguageModelChatMessageRole.Assistant,
                    content: [new vscode.LanguageModelToolCallPart('call-1', 'screenshot', {})]
                },
                {
                    role: vscode.LanguageModelChatMessageRole.User,
                    content: [
                        new vscode.LanguageModelToolResultPart('call-1', [
                            new vscode.LanguageModelTextPart('captured'),
                            new vscode.LanguageModelDataPart(imageData, 'image/png')
                        ])
                    ]
                }
            ] as never,
            { allowMedia: true }
        );

        assert.deepEqual(result.contents[1], {
            role: 'user',
            parts: [
                {
                    functionResponse: {
                        id: 'call-1',
                        name: 'screenshot',
                        response: { result: 'captured' },
                        parts: [
                            { inlineData: { mimeType: 'image/png', data: Buffer.from(imageData).toString('base64') } }
                        ]
                    }
                }
            ]
        });
    });

    test('任意媒体 DataPart 转为 inlineData，内部标记被排除', () => {
        const pdfData = new Uint8Array([37, 80, 68, 70]);
        const markerData = new Uint8Array([123, 125]);
        const result = convertMessagesToGemini(
            [
                {
                    role: vscode.LanguageModelChatMessageRole.User,
                    content: [
                        new vscode.LanguageModelDataPart(pdfData, 'application/pdf'),
                        new vscode.LanguageModelDataPart(markerData, 'stateful_marker'),
                        new vscode.LanguageModelTextPart('summarize')
                    ]
                }
            ] as never,
            { allowMedia: true }
        );

        assert.deepEqual(result.contents, [
            {
                role: 'user',
                parts: [
                    { inlineData: { mimeType: 'application/pdf', data: Buffer.from(pdfData).toString('base64') } },
                    { text: 'summarize' }
                ]
            }
        ]);
    });

    test('保留文本空白与换行', () => {
        const result = convertMessagesToGemini([
            {
                role: vscode.LanguageModelChatMessageRole.System,
                content: [new vscode.LanguageModelTextPart('\n  system  \n')]
            },
            {
                role: vscode.LanguageModelChatMessageRole.User,
                content: [new vscode.LanguageModelTextPart('  '), new vscode.LanguageModelTextPart('user\n')]
            },
            {
                role: vscode.LanguageModelChatMessageRole.Assistant,
                content: [new vscode.LanguageModelTextPart('\nassistant  ')]
            }
        ] as never);

        assert.equal(result.systemInstruction, '\n  system  \n');
        assert.deepEqual(result.contents, [
            { role: 'user', parts: [{ text: '  ' }, { text: 'user\n' }] },
            { role: 'model', parts: [{ text: '\nassistant  ' }] }
        ]);
    });

    test('连续同角色消息合并为单个 Gemini turn', () => {
        const result = convertMessagesToGemini([
            {
                role: vscode.LanguageModelChatMessageRole.User,
                content: [new vscode.LanguageModelTextPart('first')]
            },
            {
                role: vscode.LanguageModelChatMessageRole.User,
                content: [new vscode.LanguageModelTextPart('second')]
            },
            {
                role: vscode.LanguageModelChatMessageRole.Assistant,
                content: [new vscode.LanguageModelTextPart('answer')]
            }
        ] as never);

        assert.deepEqual(result.contents, [
            { role: 'user', parts: [{ text: 'first' }, { text: 'second' }] },
            { role: 'model', parts: [{ text: 'answer' }] }
        ]);
    });

    test('thought signature 只附加到后续第一个 function call', () => {
        const result = convertMessagesToGemini([
            {
                role: vscode.LanguageModelChatMessageRole.Assistant,
                content: [
                    new vscode.LanguageModelThinkingPart('', undefined, { signature: 'sig-1' }),
                    new vscode.LanguageModelToolCallPart('call-1', 'first', {}),
                    new vscode.LanguageModelToolCallPart('call-2', 'second', {})
                ]
            },
            {
                role: vscode.LanguageModelChatMessageRole.User,
                content: [
                    new vscode.LanguageModelToolResultPart('call-1', [new vscode.LanguageModelTextPart('one')]),
                    new vscode.LanguageModelToolResultPart('call-2', [new vscode.LanguageModelTextPart('two')])
                ]
            }
        ] as never);

        assert.deepEqual(result.contents[0], {
            role: 'model',
            parts: [
                { functionCall: { id: 'call-1', name: 'first', args: {} }, thoughtSignature: 'sig-1' },
                { functionCall: { id: 'call-2', name: 'second', args: {} } }
            ]
        });
    });

    test('ThinkingPart 被剥离后按 callId 从 StatefulMarker 恢复 thought signature', () => {
        const result = convertMessagesToGemini([
            {
                role: vscode.LanguageModelChatMessageRole.Assistant,
                content: [
                    new vscode.LanguageModelToolCallPart('call-1', 'read_file', {}),
                    createGeminiMarker([{ callId: 'call-1', name: 'read_file', signature: 'marker-sig' }])
                ]
            },
            {
                role: vscode.LanguageModelChatMessageRole.User,
                content: [new vscode.LanguageModelToolResultPart('call-1', [new vscode.LanguageModelTextPart('ok')])]
            }
        ] as never);

        assert.deepEqual(result.contents[0], {
            role: 'model',
            parts: [{ functionCall: { id: 'call-1', name: 'read_file', args: {} }, thoughtSignature: 'marker-sig' }]
        });
    });

    test('ThinkingPart 签名优先于 marker，函数名回退仅接受唯一匹配', () => {
        const result = convertMessagesToGemini([
            {
                role: vscode.LanguageModelChatMessageRole.Assistant,
                content: [
                    new vscode.LanguageModelThinkingPart('', undefined, { signature: 'visible-sig' }),
                    new vscode.LanguageModelToolCallPart('new-1', 'unique_tool', {}),
                    new vscode.LanguageModelToolCallPart('new-2', 'duplicate_tool', {}),
                    createGeminiMarker([
                        { callId: 'old-1', name: 'unique_tool', signature: 'marker-unique' },
                        { callId: 'old-2', name: 'duplicate_tool', signature: 'marker-duplicate-1' },
                        { callId: 'old-3', name: 'duplicate_tool', signature: 'marker-duplicate-2' }
                    ])
                ]
            },
            {
                role: vscode.LanguageModelChatMessageRole.User,
                content: [
                    new vscode.LanguageModelToolResultPart('new-1', [new vscode.LanguageModelTextPart('one')]),
                    new vscode.LanguageModelToolResultPart('new-2', [new vscode.LanguageModelTextPart('two')])
                ]
            }
        ] as never);

        assert.deepEqual(result.contents[0], {
            role: 'model',
            parts: [
                { functionCall: { id: 'new-1', name: 'unique_tool', args: {} }, thoughtSignature: 'visible-sig' },
                { functionCall: { id: 'new-2', name: 'duplicate_tool', args: {} } }
            ]
        });

        const markerFallback = convertMessagesToGemini([
            {
                role: vscode.LanguageModelChatMessageRole.Assistant,
                content: [
                    new vscode.LanguageModelToolCallPart('rewritten-id', 'unique_tool', {}),
                    createGeminiMarker([{ callId: 'old-id', name: 'unique_tool', signature: 'marker-unique' }])
                ]
            },
            {
                role: vscode.LanguageModelChatMessageRole.User,
                content: [
                    new vscode.LanguageModelToolResultPart('rewritten-id', [new vscode.LanguageModelTextPart('ok')])
                ]
            }
        ] as never);
        assert.equal(markerFallback.contents[0].parts[0].thoughtSignature, 'marker-unique');
    });

    test('思考、文本和独立 Part 的签名可从 StatefulMarker 恢复', () => {
        const result = convertMessagesToGemini([
            {
                role: vscode.LanguageModelChatMessageRole.Assistant,
                content: [
                    new vscode.LanguageModelThinkingPart('reasoning'),
                    new vscode.LanguageModelTextPart('answer'),
                    createGeminiMarker([
                        { partKind: 'thought', partIndex: 0, signature: 'thought-sig' },
                        { partKind: 'text', partIndex: 0, signature: 'text-sig' },
                        { partKind: 'standalone', partIndex: 0, signature: 'final-sig' }
                    ])
                ]
            }
        ] as never);

        assert.deepEqual(result.contents[0], {
            role: 'model',
            parts: [
                { thought: true, text: 'reasoning', thoughtSignature: 'thought-sig' },
                { text: 'answer', thoughtSignature: 'text-sig' },
                { thoughtSignature: 'final-sig' }
            ]
        });
    });

    test('切换 Gemini provider 或模型后不回放旧 thought signature', () => {
        const result = convertMessagesToGemini(
            [
                {
                    role: vscode.LanguageModelChatMessageRole.Assistant,
                    content: [
                        new vscode.LanguageModelThinkingPart('reasoning', undefined, { signature: 'visible-sig' }),
                        new vscode.LanguageModelTextPart('answer'),
                        createGeminiMarker([{ partKind: 'text', partIndex: 0, signature: 'marker-sig' }])
                    ]
                }
            ] as never,
            { provider: 'other-provider', modelId: 'other-model', requestIdentity: 'other-request' }
        );

        assert.deepEqual(result.contents, [{ role: 'model', parts: [{ text: 'answer' }] }]);
    });

    test('身份匹配时优先按原始 Content 恢复 Part 顺序与签名位置', () => {
        const result = convertMessagesToGemini(
            [
                {
                    role: vscode.LanguageModelChatMessageRole.Assistant,
                    content: [new vscode.LanguageModelTextPart('aggregated'), createGeminiRawMarker()]
                }
            ] as never,
            { provider: 'test-provider', modelId: 'gemini-test', requestIdentity: 'request-identity' }
        );

        assert.deepEqual(result.contents, [
            {
                role: 'model',
                parts: [
                    { text: 'first', thoughtSignature: 'first-sig' },
                    { text: 'second', thoughtSignature: 'second-sig' }
                ]
            }
        ]);
    });

    test('身份不匹配时移除旧工具轮次并保留后续用户文本', () => {
        const result = convertMessagesToGemini(
            [
                {
                    role: vscode.LanguageModelChatMessageRole.User,
                    content: [new vscode.LanguageModelTextPart('question')]
                },
                {
                    role: vscode.LanguageModelChatMessageRole.Assistant,
                    content: [
                        new vscode.LanguageModelTextPart('calling tool'),
                        new vscode.LanguageModelToolCallPart('call-1', 'read_file', {}),
                        createGeminiMarker([{ callId: 'call-1', name: 'read_file', signature: 'old-signature' }])
                    ]
                },
                {
                    role: vscode.LanguageModelChatMessageRole.User,
                    content: [
                        new vscode.LanguageModelToolResultPart('call-1', [new vscode.LanguageModelTextPart('result')])
                    ]
                },
                {
                    role: vscode.LanguageModelChatMessageRole.User,
                    content: [new vscode.LanguageModelTextPart('continue')]
                }
            ] as never,
            { provider: 'other-provider', modelId: 'other-model', requestIdentity: 'other-request' }
        );

        assert.deepEqual(result.contents, [{ role: 'user', parts: [{ text: 'question' }, { text: 'continue' }] }]);
    });

    test('历史净化后按净化后的索引读取独立工具结果', () => {
        const result = convertMessagesToGemini(
            [
                {
                    role: vscode.LanguageModelChatMessageRole.Assistant,
                    content: [new vscode.LanguageModelToolCallPart('old-call', 'old_tool', {})]
                },
                {
                    role: vscode.LanguageModelChatMessageRole.User,
                    content: [
                        new vscode.LanguageModelToolResultPart('old-call', [new vscode.LanguageModelTextPart('old')]),
                        new vscode.LanguageModelTextPart('carry')
                    ]
                },
                {
                    role: vscode.LanguageModelChatMessageRole.Assistant,
                    content: [
                        new vscode.LanguageModelToolCallPart('current-call', 'read_file', {}),
                        createGeminiRawToolMarker([{ localCallId: 'current-call', name: 'read_file' }])
                    ]
                },
                {
                    role: vscode.LanguageModelChatMessageRole.User,
                    content: [new vscode.LanguageModelTextPart('interlude')]
                },
                {
                    role: vscode.LanguageModelChatMessageRole.User,
                    content: [
                        new vscode.LanguageModelToolResultPart('current-call', [new vscode.LanguageModelTextPart('ok')])
                    ]
                }
            ] as never,
            { provider: 'test-provider', modelId: 'gemini-test', requestIdentity: 'request-identity' }
        );

        assert.deepEqual(result.contents, [
            { role: 'user', parts: [{ text: 'carry' }] },
            { role: 'model', parts: [{ functionCall: { name: 'read_file', args: {} } }] },
            {
                role: 'user',
                parts: [{ text: 'interlude' }, { functionResponse: { name: 'read_file', response: { result: 'ok' } } }]
            }
        ]);
    });

    test('原始无 ID functionCall 使用本地 ID 关联结果但不写入 wire ID', () => {
        const result = convertMessagesToGemini(
            [
                {
                    role: vscode.LanguageModelChatMessageRole.Assistant,
                    content: [
                        new vscode.LanguageModelToolCallPart('local-call', 'read_file', {}),
                        createGeminiRawToolMarker([{ localCallId: 'local-call', name: 'read_file' }])
                    ]
                },
                {
                    role: vscode.LanguageModelChatMessageRole.User,
                    content: [
                        new vscode.LanguageModelToolResultPart('local-call', [new vscode.LanguageModelTextPart('ok')])
                    ]
                }
            ] as never,
            { provider: 'test-provider', modelId: 'gemini-test', requestIdentity: 'request-identity' }
        );

        assert.deepEqual(result.contents, [
            { role: 'model', parts: [{ functionCall: { name: 'read_file', args: {} } }] },
            { role: 'user', parts: [{ functionResponse: { name: 'read_file', response: { result: 'ok' } } }] }
        ]);
    });

    test('原始 marker 路径按 functionCall 顺序重排并行工具结果', () => {
        const result = convertMessagesToGemini(
            [
                {
                    role: vscode.LanguageModelChatMessageRole.Assistant,
                    content: [
                        new vscode.LanguageModelToolCallPart('local-1', 'first', {}),
                        new vscode.LanguageModelToolCallPart('local-2', 'second', {}),
                        createGeminiRawToolMarker([
                            { localCallId: 'local-1', upstreamCallId: 'upstream-1', name: 'first' },
                            { localCallId: 'local-2', upstreamCallId: 'upstream-2', name: 'second' }
                        ])
                    ]
                },
                {
                    role: vscode.LanguageModelChatMessageRole.User,
                    content: [
                        new vscode.LanguageModelToolResultPart('local-2', [new vscode.LanguageModelTextPart('two')]),
                        new vscode.LanguageModelToolResultPart('local-1', [new vscode.LanguageModelTextPart('one')])
                    ]
                }
            ] as never,
            { provider: 'test-provider', modelId: 'gemini-test', requestIdentity: 'request-identity' }
        );

        assert.deepEqual(
            result.contents[1].parts.map(part => part.functionResponse?.id),
            ['upstream-1', 'upstream-2']
        );
    });

    for (const layout of ['embedded', 'split', 'duplicate'] as const) {
        test(`原始 marker 与内嵌工具结果：${layout}`, () => {
            const first = new vscode.LanguageModelToolResultPart('local-1', [new vscode.LanguageModelTextPart('one')]);
            const second = new vscode.LanguageModelToolResultPart('local-2', [new vscode.LanguageModelTextPart('two')]);
            const messages = [
                {
                    role: vscode.LanguageModelChatMessageRole.Assistant,
                    content: [
                        new vscode.LanguageModelToolCallPart('local-1', 'first', {}),
                        new vscode.LanguageModelToolCallPart('local-2', 'second', {}),
                        createGeminiRawToolMarker([
                            { localCallId: 'local-1', upstreamCallId: 'upstream-1', name: 'first' },
                            { localCallId: 'local-2', name: 'second' }
                        ]),
                        second,
                        ...(layout === 'embedded' ? [first] : [])
                    ]
                },
                ...(layout === 'embedded' ?
                    []
                :   [
                        {
                            role: vscode.LanguageModelChatMessageRole.User,
                            content: layout === 'duplicate' ? [first, second] : [first]
                        }
                    ])
            ];
            const convert = () =>
                convertMessagesToGemini(messages as never, {
                    provider: 'test-provider',
                    modelId: 'gemini-test',
                    requestIdentity: 'request-identity'
                });
            if (layout === 'duplicate') {
                assert.throws(convert, /duplicate|重复/);
            } else {
                assert.deepEqual(convert().contents[1], {
                    role: 'user',
                    parts: [
                        { functionResponse: { id: 'upstream-1', name: 'first', response: { result: 'one' } } },
                        { functionResponse: { name: 'second', response: { result: 'two' } } }
                    ]
                });
            }
        });
    }

    test('并行工具调用缺少结果时在本地拒绝', () => {
        assert.throws(
            () =>
                convertMessagesToGemini([
                    {
                        role: vscode.LanguageModelChatMessageRole.Assistant,
                        content: [
                            new vscode.LanguageModelToolCallPart('call-1', 'first', {}),
                            new vscode.LanguageModelToolCallPart('call-2', 'second', {})
                        ]
                    },
                    {
                        role: vscode.LanguageModelChatMessageRole.User,
                        content: [
                            new vscode.LanguageModelToolResultPart('call-1', [new vscode.LanguageModelTextPart('one')])
                        ]
                    }
                ] as never),
            /function responses|工具结果/
        );
    });

    test('重复工具结果时在本地拒绝', () => {
        assert.throws(
            () =>
                convertMessagesToGemini([
                    {
                        role: vscode.LanguageModelChatMessageRole.Assistant,
                        content: [new vscode.LanguageModelToolCallPart('call-1', 'first', {})]
                    },
                    {
                        role: vscode.LanguageModelChatMessageRole.User,
                        content: [
                            new vscode.LanguageModelToolResultPart('call-1', [new vscode.LanguageModelTextPart('one')]),
                            new vscode.LanguageModelToolResultPart('call-1', [new vscode.LanguageModelTextPart('two')])
                        ]
                    }
                ] as never),
            /duplicate|重复/
        );
    });

    test('工具结果 callId 不匹配时在本地拒绝', () => {
        assert.throws(
            () =>
                convertMessagesToGemini([
                    {
                        role: vscode.LanguageModelChatMessageRole.Assistant,
                        content: [new vscode.LanguageModelToolCallPart('call-1', 'first', {})]
                    },
                    {
                        role: vscode.LanguageModelChatMessageRole.User,
                        content: [
                            new vscode.LanguageModelToolResultPart('other-call', [
                                new vscode.LanguageModelTextPart('one')
                            ])
                        ]
                    }
                ] as never),
            /function responses|工具结果/
        );
    });

    test('媒体能力关闭时过滤顶层和工具结果 DataPart，但保留文本结果', () => {
        const media = new vscode.LanguageModelDataPart(new Uint8Array([1, 2, 3]), 'image/png');
        const result = convertMessagesToGemini([
            {
                role: vscode.LanguageModelChatMessageRole.Assistant,
                content: [new vscode.LanguageModelToolCallPart('call-1', 'screenshot', {})]
            },
            {
                role: vscode.LanguageModelChatMessageRole.User,
                content: [
                    new vscode.LanguageModelToolResultPart('call-1', [
                        new vscode.LanguageModelTextPart('captured'),
                        media
                    ]),
                    media,
                    new vscode.LanguageModelTextPart('continue')
                ]
            }
        ] as never);

        assert.deepEqual(result.contents[1], {
            role: 'user',
            parts: [
                {
                    functionResponse: {
                        id: 'call-1',
                        name: 'screenshot',
                        response: { result: 'captured' }
                    }
                },
                { text: 'continue' }
            ]
        });
    });

    test('tool result 数组和标量用 result 保留结构', () => {
        const result = convertMessagesToGemini([
            {
                role: vscode.LanguageModelChatMessageRole.Assistant,
                content: [
                    new vscode.LanguageModelToolCallPart('call-1', 'list', {}),
                    new vscode.LanguageModelToolCallPart('call-2', 'count', {})
                ]
            },
            {
                role: vscode.LanguageModelChatMessageRole.User,
                content: [
                    new vscode.LanguageModelToolResultPart('call-1', [new vscode.LanguageModelTextPart('["a","b"]')]),
                    new vscode.LanguageModelToolResultPart('call-2', [new vscode.LanguageModelTextPart('42')])
                ]
            }
        ] as never);

        assert.deepEqual(result.contents[1], {
            role: 'user',
            parts: [
                { functionResponse: { id: 'call-1', name: 'list', response: { result: ['a', 'b'] } } },
                { functionResponse: { id: 'call-2', name: 'count', response: { result: 42 } } }
            ]
        });
    });

    test('assistant 混合内容中的 tool result 会拆分到 user turn', () => {
        const result = convertMessagesToGemini([
            {
                role: vscode.LanguageModelChatMessageRole.Assistant,
                content: [new vscode.LanguageModelToolCallPart('call-1', 'read', {})]
            },
            {
                role: vscode.LanguageModelChatMessageRole.Assistant,
                content: [
                    new vscode.LanguageModelTextPart('done'),
                    new vscode.LanguageModelToolResultPart('call-1', [new vscode.LanguageModelTextPart('ok')])
                ]
            }
        ] as never);

        assert.deepEqual(result.contents, [
            {
                role: 'model',
                parts: [{ functionCall: { id: 'call-1', name: 'read', args: {} } }, { text: 'done' }]
            },
            {
                role: 'user',
                parts: [{ functionResponse: { id: 'call-1', name: 'read', response: { result: 'ok' } } }]
            }
        ]);
    });
});
