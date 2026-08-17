import assert from 'node:assert/strict';

import * as vscode from 'vscode';

import { OpenAIResponsesMessageConverter } from '../../src/handlers/openai/openaiResponsesMessageConverter';
import { encodeStatefulMarker } from '../../src/handlers/statefulMarker';
import { CustomDataPartMimeTypes } from '../../src/handlers/types';

type LanguageModelThinkingPartCtor = new (
    value: string | string[],
    id?: string,
    metadata?: Record<string, unknown>
) => unknown;

const LanguageModelThinkingPart = (
    vscode as typeof vscode & { LanguageModelThinkingPart: LanguageModelThinkingPartCtor }
).LanguageModelThinkingPart;

function createConverter() {
    return new OpenAIResponsesMessageConverter(
        {
            isImageMimeType: () => false,
            createDataUrl: () => 'data:image/png;base64,'
        } as never,
        'Test Provider'
    );
}

suite('OpenAIResponsesMessageConverter', () => {
    test('保留带 redactedData 的加密 reasoning，即使可见文本为空', () => {
        const converter = createConverter();

        const result = converter.convertMessagesToOpenAIResponses([
            {
                role: vscode.LanguageModelChatMessageRole.Assistant,
                content: [
                    new LanguageModelThinkingPart('', undefined, {
                        redactedData: 'cipher',
                        reasoningId: 'rsn_123'
                    })
                ]
            }
        ] as never);

        assert.deepEqual(result.messages, [
            {
                type: 'reasoning',
                summary: [],
                encrypted_content: 'cipher',
                id: 'rsn_123'
            }
        ]);
    });

    test('extraBody 接管 include 为 null 时不再回传加密 reasoning', () => {
        const converter = createConverter();

        const result = converter.convertMessagesToOpenAIResponses(
            [
                {
                    role: vscode.LanguageModelChatMessageRole.Assistant,
                    content: [
                        new LanguageModelThinkingPart('', undefined, {
                            redactedData: 'cipher',
                            reasoningId: 'rsn_123'
                        }),
                        new vscode.LanguageModelTextPart('可见回答')
                    ]
                }
            ] as never,
            {
                id: 'gpt-5.6-sol',
                extraBody: { reasoning: { effort: 'medium' }, include: null }
            } as never
        );

        assert.deepEqual(result.messages, [
            {
                type: 'message',
                role: 'assistant',
                status: 'completed',
                content: [{ type: 'output_text', text: '可见回答' }]
            }
        ]);
    });

    test('extraBody 接管 include 且显式含 encrypted_content 时仍回传加密 reasoning', () => {
        const converter = createConverter();

        const result = converter.convertMessagesToOpenAIResponses(
            [
                {
                    role: vscode.LanguageModelChatMessageRole.Assistant,
                    content: [
                        new LanguageModelThinkingPart('', undefined, {
                            redactedData: 'cipher',
                            reasoningId: 'rsn_123'
                        })
                    ]
                }
            ] as never,
            {
                id: 'gpt-5.6-sol',
                extraBody: { include: ['reasoning.encrypted_content'] }
            } as never
        );

        assert.deepEqual(result.messages, [
            {
                type: 'reasoning',
                summary: [],
                encrypted_content: 'cipher',
                id: 'rsn_123'
            }
        ]);
    });

    test('include 接管为 null 时既不回传密文也不回传明文思考文本', () => {
        const converter = createConverter();

        const result = converter.convertMessagesToOpenAIResponses(
            [
                {
                    role: vscode.LanguageModelChatMessageRole.Assistant,
                    content: [
                        new LanguageModelThinkingPart('可见摘要', undefined, {
                            redactedData: 'cipher',
                            reasoningId: 'rsn_123'
                        })
                    ]
                }
            ] as never,
            {
                id: 'gpt-5.6-sol',
                extraBody: { reasoning: { effort: 'medium' }, include: null }
            } as never
        );

        // include 被显式接管（null）时密文丢弃，明文思考文本同样不回传，
        // 否则 GPT/Azure 端点会因输入端 reasoning 项 content 非空而 400
        assert.deepEqual(result.messages, []);
    });

    test('明文通道下 ThinkingPart 被剥离时从 StatefulMarker 恢复思维链文本', () => {
        const converter = createConverter();

        const markerData = encodeStatefulMarker('gpt-5.6-sol', {
            provider: 'compatible',
            modelId: 'gpt-5.6-sol',
            sdkMode: 'openai-responses',
            sessionId: 's-1',
            responseId: 'r-1',
            completeThinking: '完整思考摘要',
            encryptedReasoning: [{ encryptedContent: 'cipher-1', reasoningId: 'rsn_a' }]
        });
        const markerPart = new vscode.LanguageModelDataPart(markerData, CustomDataPartMimeTypes.StatefulMarker);

        const result = converter.convertMessagesToOpenAIResponses(
            [
                {
                    role: vscode.LanguageModelChatMessageRole.Assistant,
                    content: [markerPart]
                }
            ] as never,
            { id: 'deepseek-v4-flash' } as never
        );

        assert.deepEqual(result.messages, [
            {
                type: 'reasoning',
                summary: [],
                content: [{ type: 'reasoning_text', text: '完整思考摘要' }]
            }
        ]);
    });

    test('明文通道下 ThinkingPart 部分剥离时优先使用可见 ThinkingPart 文本', () => {
        const converter = createConverter();

        const markerData = encodeStatefulMarker('gpt-5.6-sol', {
            provider: 'compatible',
            modelId: 'gpt-5.6-sol',
            sdkMode: 'openai-responses',
            sessionId: 's-1',
            responseId: 'r-1',
            completeThinking: '第一段摘要\n第二段摘要'
        });
        const markerPart = new vscode.LanguageModelDataPart(markerData, CustomDataPartMimeTypes.StatefulMarker);

        const result = converter.convertMessagesToOpenAIResponses(
            [
                {
                    role: vscode.LanguageModelChatMessageRole.Assistant,
                    content: [new LanguageModelThinkingPart('第二段摘要'), markerPart]
                }
            ] as never,
            { id: 'deepseek-v4-flash' } as never
        );

        assert.deepEqual(result.messages, [
            {
                type: 'reasoning',
                summary: [],
                content: [{ type: 'reasoning_text', text: '第二段摘要' }]
            }
        ]);
    });

    test('明文通道下多个思考摘要段直接拼接（对齐 Copilot 默认行为）', () => {
        const converter = createConverter();

        const result = converter.convertMessagesToOpenAIResponses(
            [
                {
                    role: vscode.LanguageModelChatMessageRole.Assistant,
                    content: [
                        new LanguageModelThinkingPart('**Planning provider module analysis**', undefined, {
                            redactedData: 'cipher-1',
                            reasoningId: 'rsn_a'
                        }),
                        new LanguageModelThinkingPart('**Gathering precise line numbers with grep**', undefined, {
                            redactedData: 'cipher-2',
                            reasoningId: 'rsn_b'
                        })
                    ]
                }
            ] as never,
            { id: 'deepseek-v4-flash' } as never
        );

        assert.deepEqual(result.messages, [
            {
                type: 'reasoning',
                summary: [],
                content: [
                    {
                        type: 'reasoning_text',
                        text: '**Planning provider module analysis****Gathering precise line numbers with grep**'
                    }
                ]
            }
        ]);
    });

    test('忽略没有可见内容的普通 thinking part，避免生成空 assistant message', () => {
        const converter = createConverter();

        const result = converter.convertMessagesToOpenAIResponses([
            {
                role: vscode.LanguageModelChatMessageRole.Assistant,
                content: [new LanguageModelThinkingPart('')]
            }
        ] as never);

        assert.deepEqual(result.messages, []);
    });

    test('支持数组形式的 thinking 内容', () => {
        const converter = createConverter();

        const result = converter.convertMessagesToOpenAIResponses(
            [
                {
                    role: vscode.LanguageModelChatMessageRole.Assistant,
                    content: [new LanguageModelThinkingPart(['思考', '内容'])]
                }
            ] as never,
            { id: 'deepseek-v4-flash' } as never
        );

        assert.deepEqual(result.messages, [
            {
                type: 'reasoning',
                summary: [],
                content: [{ type: 'reasoning_text', text: '思考内容' }]
            }
        ]);
    });

    test('密文回放通道下可见思考文本（摘要）不回传为文本', () => {
        const converter = createConverter();

        const result = converter.convertMessagesToOpenAIResponses([
            {
                role: vscode.LanguageModelChatMessageRole.Assistant,
                content: [new LanguageModelThinkingPart('展示用摘要'), new vscode.LanguageModelTextPart('正式回答')]
            }
        ] as never);

        assert.deepEqual(result.messages, [
            {
                type: 'message',
                role: 'assistant',
                status: 'completed',
                content: [{ type: 'output_text', text: '正式回答' }]
            }
        ]);
    });

    test('GPT 端点未配置 extraBody.reasoning 时不以明文回传历史 thinking 摘要', () => {
        const converter = createConverter();

        // issue #352：GPT 历史 reasoning 不能以明文摘要回放。
        const result = converter.convertMessagesToOpenAIResponses(
            [
                {
                    role: vscode.LanguageModelChatMessageRole.Assistant,
                    content: [
                        new LanguageModelThinkingPart('历史思考摘要'),
                        new vscode.LanguageModelTextPart('正式回答')
                    ]
                }
            ] as never,
            { id: 'gpt-5.6' } as never
        );

        assert.deepEqual(result.messages, [
            {
                type: 'message',
                role: 'assistant',
                status: 'completed',
                content: [{ type: 'output_text', text: '正式回答' }]
            }
        ]);
    });

    test('ThinkingPart 被剥离时从 StatefulMarker 恢复加密 reasoning', () => {
        const converter = createConverter();

        // 构造只含 StatefulMarker、无 ThinkingPart 的 assistant 历史消息
        const markerData = encodeStatefulMarker('gpt-5.4', {
            provider: 'codex',
            modelId: 'gpt-5.4',
            sdkMode: 'openai-responses',
            sessionId: 's-1',
            responseId: 'r-1',
            encryptedReasoning: [
                { encryptedContent: 'cipher-1', reasoningId: 'rsn_a' },
                { encryptedContent: 'cipher-2' }
            ]
        });
        const markerPart = new vscode.LanguageModelDataPart(markerData, CustomDataPartMimeTypes.StatefulMarker);

        const result = converter.convertMessagesToOpenAIResponses([
            {
                role: vscode.LanguageModelChatMessageRole.Assistant,
                content: [markerPart]
            }
        ] as never);

        assert.deepEqual(result.messages, [
            { type: 'reasoning', summary: [], encrypted_content: 'cipher-1', id: 'rsn_a' },
            { type: 'reasoning', summary: [], encrypted_content: 'cipher-2' }
        ]);
    });

    test('ThinkingPart 与 StatefulMarker 并存时合并并去重恢复加密 reasoning', () => {
        const converter = createConverter();

        const markerData = encodeStatefulMarker('gpt-5.4', {
            provider: 'codex',
            modelId: 'gpt-5.4',
            sdkMode: 'openai-responses',
            sessionId: 's-1',
            responseId: 'r-1',
            encryptedReasoning: [
                { encryptedContent: 'cipher-1', reasoningId: 'rsn_a' },
                { encryptedContent: 'cipher-2', reasoningId: 'rsn_b' }
            ]
        });
        const markerPart = new vscode.LanguageModelDataPart(markerData, CustomDataPartMimeTypes.StatefulMarker);

        const result = converter.convertMessagesToOpenAIResponses([
            {
                role: vscode.LanguageModelChatMessageRole.Assistant,
                content: [
                    new LanguageModelThinkingPart('', undefined, {
                        redactedData: 'cipher-1',
                        reasoningId: 'rsn_a'
                    }),
                    markerPart
                ]
            }
        ] as never);

        assert.deepEqual(result.messages, [
            { type: 'reasoning', summary: [], encrypted_content: 'cipher-1', id: 'rsn_a' },
            { type: 'reasoning', summary: [], encrypted_content: 'cipher-2', id: 'rsn_b' }
        ]);
    });

    test('ThinkingPart 仅保留后续 item 时仍按 StatefulMarker 原顺序恢复加密 reasoning', () => {
        const converter = createConverter();

        const markerData = encodeStatefulMarker('gpt-5.4', {
            provider: 'codex',
            modelId: 'gpt-5.4',
            sdkMode: 'openai-responses',
            sessionId: 's-1',
            responseId: 'r-1',
            encryptedReasoning: [
                { encryptedContent: 'cipher-1', reasoningId: 'rsn_a' },
                { encryptedContent: 'cipher-2', reasoningId: 'rsn_b' }
            ]
        });
        const markerPart = new vscode.LanguageModelDataPart(markerData, CustomDataPartMimeTypes.StatefulMarker);

        const result = converter.convertMessagesToOpenAIResponses([
            {
                role: vscode.LanguageModelChatMessageRole.Assistant,
                content: [
                    new LanguageModelThinkingPart('', undefined, {
                        redactedData: 'cipher-2',
                        reasoningId: 'rsn_b'
                    }),
                    markerPart
                ]
            }
        ] as never);

        assert.deepEqual(result.messages, [
            { type: 'reasoning', summary: [], encrypted_content: 'cipher-1', id: 'rsn_a' },
            { type: 'reasoning', summary: [], encrypted_content: 'cipher-2', id: 'rsn_b' }
        ]);
    });

    test('非 openai-responses 模式的 marker 不恢复加密 reasoning', () => {
        const converter = createConverter();

        const markerData = encodeStatefulMarker('claude-sonnet-4-5', {
            provider: 'anthropic',
            modelId: 'claude-sonnet-4-5',
            sdkMode: 'anthropic',
            sessionId: 's-1',
            responseId: 'r-1',
            encryptedThinkingData: ['anthropic-cipher']
        });
        const markerPart = new vscode.LanguageModelDataPart(markerData, CustomDataPartMimeTypes.StatefulMarker);

        const result = converter.convertMessagesToOpenAIResponses([
            {
                role: vscode.LanguageModelChatMessageRole.Assistant,
                content: [markerPart]
            }
        ] as never);

        // anthropic 模式的 marker 不应被当作 openai-responses 加密 reasoning 恢复
        assert.deepEqual(result.messages, []);
    });

    test('外源 reasoning id 不回传，仅保留密文内容', () => {
        const converter = createConverter();

        const result = converter.convertMessagesToOpenAIResponses([
            {
                role: vscode.LanguageModelChatMessageRole.Assistant,
                content: [
                    new LanguageModelThinkingPart('', undefined, {
                        redactedData: 'cipher',
                        reasoningId: 'thinking_0'
                    })
                ]
            }
        ] as never);

        assert.deepEqual(result.messages, [
            {
                type: 'reasoning',
                summary: [],
                encrypted_content: 'cipher'
            }
        ]);
    });
});
