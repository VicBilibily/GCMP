import assert from 'node:assert/strict';

import * as vscode from 'vscode';

import { apiMessageToAnthropicMessage } from '../../src/handlers/anthropicConverter';
import { encodeStatefulMarker } from '../../src/handlers/statefulMarker';
import { CustomDataPartMimeTypes } from '../../src/handlers/types';

suite('anthropicConverter', () => {
    test('连续同角色消息合并后调用与结果分别去重，后续轮次保留', () => {
        const assistant = (n: number) => ({
            role: vscode.LanguageModelChatMessageRole.Assistant,
            content: [new vscode.LanguageModelToolCallPart('same', 'read_file', { n })]
        });
        const user = (text: string) => ({
            role: vscode.LanguageModelChatMessageRole.User,
            content: [new vscode.LanguageModelToolResultPart('same', [new vscode.LanguageModelTextPart(text)])]
        });
        const result = apiMessageToAnthropicMessage(
            { id: 'test' } as never,
            [assistant(1), assistant(2), user('first'), user('second'), assistant(3), user('third')] as never
        );
        assert.deepEqual(result.messages, [
            { role: 'assistant', content: [{ type: 'tool_use', id: 'same', name: 'read_file', input: { n: 1 } }] },
            {
                role: 'user',
                content: [{ type: 'tool_result', tool_use_id: 'same', content: [{ type: 'text', text: 'first' }] }]
            },
            { role: 'assistant', content: [{ type: 'tool_use', id: 'same', name: 'read_file', input: { n: 3 } }] },
            {
                role: 'user',
                content: [{ type: 'tool_result', tool_use_id: 'same', content: [{ type: 'text', text: 'third' }] }]
            }
        ]);
    });
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
