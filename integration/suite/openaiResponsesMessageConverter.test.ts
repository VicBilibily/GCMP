import assert from 'node:assert/strict';

import * as vscode from 'vscode';

import { OpenAIResponsesMessageConverter } from '../../src/handlers/openai/openaiResponsesMessageConverter';

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
});
