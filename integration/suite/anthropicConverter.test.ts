import assert from 'node:assert/strict';

import * as vscode from 'vscode';

import { apiMessageToAnthropicMessage } from '../../src/handlers/anthropicConverter';
import { encodeStatefulMarker } from '../../src/handlers/statefulMarker';
import { CustomDataPartMimeTypes } from '../../src/handlers/types';

suite('anthropicConverter', () => {
    test('ThinkingPart 被剥离时从 StatefulMarker 恢复多个 redacted_thinking 块', () => {
        const markerData = encodeStatefulMarker('claude-sonnet-4-5', {
            provider: 'anthropic',
            modelId: 'claude-sonnet-4-5',
            sdkMode: 'anthropic',
            sessionId: 's-1',
            responseId: 'r-1',
            encryptedThinkingData: ['redacted-1', 'redacted-2']
        });
        const markerPart = new vscode.LanguageModelDataPart(markerData, CustomDataPartMimeTypes.StatefulMarker);

        const result = apiMessageToAnthropicMessage(
            {
                provider: 'anthropic',
                id: 'claude-sonnet-4-5',
                model: 'claude-sonnet-4-5',
                capabilities: { toolCalling: true }
            } as never,
            [
                {
                    role: vscode.LanguageModelChatMessageRole.Assistant,
                    content: [markerPart]
                }
            ] as never
        );

        assert.deepEqual(result.messages, [
            {
                role: 'assistant',
                content: [
                    { type: 'redacted_thinking', data: 'redacted-1' },
                    { type: 'redacted_thinking', data: 'redacted-2' }
                ]
            }
        ]);
    });

    test('非 anthropic 模式的 marker 不恢复 redacted_thinking 块', () => {
        const markerData = encodeStatefulMarker('gpt-5.4', {
            provider: 'codex',
            modelId: 'gpt-5.4',
            sdkMode: 'openai-responses',
            sessionId: 's-1',
            responseId: 'r-1',
            encryptedReasoning: [{ encryptedContent: 'cipher-1', reasoningId: 'rsn_a' }]
        });
        const markerPart = new vscode.LanguageModelDataPart(markerData, CustomDataPartMimeTypes.StatefulMarker);

        const result = apiMessageToAnthropicMessage(
            {
                provider: 'anthropic',
                id: 'claude-sonnet-4-5',
                model: 'claude-sonnet-4-5',
                capabilities: { toolCalling: true }
            } as never,
            [
                {
                    role: vscode.LanguageModelChatMessageRole.Assistant,
                    content: [markerPart]
                }
            ] as never
        );

        assert.equal(result.messages.length, 1);
        assert.deepEqual(result.messages[0], {
            role: 'assistant',
            content: []
        });
    });
});
