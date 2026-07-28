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

        const result = converter.convertMessagesToOpenAIResponses([
            {
                role: vscode.LanguageModelChatMessageRole.Assistant,
                content: [new LanguageModelThinkingPart(['思考', '内容'])]
            }
        ] as never);

        assert.deepEqual(result.messages, [
            {
                type: 'message',
                role: 'assistant',
                status: 'completed',
                content: [{ type: 'output_text', text: '思考内容' }]
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
});
