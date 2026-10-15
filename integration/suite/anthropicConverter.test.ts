import assert from 'node:assert/strict';

import * as vscode from 'vscode';

import { apiMessageToAnthropicMessage } from '../../src/handlers/anthropic/anthropicConverter';
import { encodeStatefulMarker, type StatefulMarkerContainer } from '../../src/handlers/stateful/statefulMarker';
import { filterStatefulReplay } from '../../src/handlers/stateful/statefulReplay';
import { CustomDataPartMimeTypes } from '../../src/handlers/types';

suite('anthropicConverter', () => {
    for (const state of ['signed', 'redacted', 'empty'] as const) {
        for (const credentialMatches of [true, false]) {
            test(`最新 ${state} marker 决定思考恢复，凭据匹配=${credentialMatches}`, () => {
                const identity = {
                    provider: 'anthropic',
                    modelId: 'claude-test',
                    sdkMode: 'anthropic' as const,
                    sessionId: 'synthetic-session',
                    credentialId: 'a'.repeat(64)
                };
                const marker = (fields: Partial<StatefulMarkerContainer>) =>
                    new vscode.LanguageModelDataPart(
                        encodeStatefulMarker(identity.modelId, {
                            provider: identity.provider,
                            modelId: identity.modelId,
                            sdkMode: identity.sdkMode,
                            sessionId: identity.sessionId,
                            responseId: 'synthetic-response',
                            statefulCredentialId: identity.credentialId,
                            continuity: { version: 1, scope: 'chain', agentRole: 'main' },
                            ...fields
                        }),
                        CustomDataPartMimeTypes.StatefulMarker
                    );
                const latest = marker({
                    statefulCredentialId: credentialMatches ? identity.credentialId : 'b'.repeat(64),
                    ...(state === 'signed' ?
                        { completeThinking: 'latest thinking', completeSignature: 'latest-signature' }
                    : state === 'redacted' ? { encryptedThinkingData: ['latest-cipher-1', 'latest-cipher-2'] }
                    : {})
                });
                const input = [
                    vscode.LanguageModelChatMessage.Assistant([
                        marker({ completeThinking: 'old thinking', completeSignature: 'old-signature' }),
                        latest,
                        new vscode.LanguageModelToolCallPart('call-1', 'read_file', { path: 'synthetic.ts' }),
                        new vscode.LanguageModelTextPart('answer'),
                        new vscode.LanguageModelDataPart(
                            new TextEncoder().encode('invalid'),
                            CustomDataPartMimeTypes.StatefulMarker
                        )
                    ])
                ];
                const before = JSON.stringify(input);
                const filtered = filterStatefulReplay(input, identity);
                const result = apiMessageToAnthropicMessage(
                    {
                        id: identity.modelId,
                        name: 'Synthetic Claude',
                        tooltip: 'Synthetic Claude',
                        maxInputTokens: 8192,
                        maxOutputTokens: 1024,
                        provider: identity.provider,
                        capabilities: { toolCalling: true, imageInput: false }
                    },
                    filtered
                );
                const expectedThinking =
                    state === 'signed' ?
                        [
                            {
                                type: 'thinking',
                                thinking: 'latest thinking',
                                signature: credentialMatches ? 'latest-signature' : ''
                            }
                        ]
                    : state === 'redacted' && credentialMatches ?
                        [
                            { type: 'redacted_thinking', data: 'latest-cipher-1' },
                            { type: 'redacted_thinking', data: 'latest-cipher-2' }
                        ]
                    :   [];
                assert.deepEqual(result.messages, [
                    {
                        role: 'assistant',
                        content: [
                            ...expectedThinking,
                            { type: 'tool_use', id: 'call-1', name: 'read_file', input: { path: 'synthetic.ts' } },
                            { type: 'text', text: 'answer' }
                        ]
                    }
                ]);
                assert.equal(JSON.stringify(input), before);
            });
        }
    }

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
