import assert from 'node:assert/strict';

import * as vscode from 'vscode';

import { apiMessageToAnthropicMessage } from '../../src/handlers/anthropic/anthropicConverter';
import { AnthropicHandler } from '../../src/handlers/anthropic/anthropicHandler';
import type { RequestClassification } from '../../src/handlers/classification/requestClassification';
import { StreamReporter } from '../../src/handlers/streamReporter';
import { encodeStatefulMarker, type StatefulMarkerContainer } from '../../src/handlers/stateful/statefulMarker';
import { filterStatefulReplay, SdkReplayCache } from '../../src/handlers/stateful/statefulReplay';
import { CustomDataPartMimeTypes } from '../../src/handlers/types';
import type { GenericModelProvider } from '../../src/providers/genericModelProvider';
import { createResponseProcessor } from '../../src/providers/request/responseProcessor';
import type { ModelConfig } from '../../src/types/sharedTypes';

suite('anthropicConverter', () => {
    for (const state of ['signed', 'signed-empty', 'redacted', 'empty'] as const) {
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
                    : state === 'signed-empty' ? { completeSignature: 'latest-signature' }
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
                    : state === 'signed-empty' && credentialMatches ?
                        [{ type: 'thinking', thinking: '', signature: 'latest-signature' }]
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

    for (const sdk of [false, true]) {
        for (const ending of ['tool', 'text', 'signature-only'] as const) {
            test(`signed empty SSE reaches the next Anthropic request: sdk=${sdk}, ending=${ending}`, async () => {
                const model: ModelConfig = {
                    id: 'claude-haiku-5-5-go',
                    model: 'claude-haiku-5-5',
                    provider: 'opencode',
                    name: 'Claude',
                    tooltip: 'Claude',
                    sdkMode: 'anthropic',
                    maxInputTokens: 8192,
                    maxOutputTokens: 1024,
                    capabilities: { toolCalling: true, imageInput: false }
                };
                const identity = {
                    provider: 'opencode',
                    modelId: `gcmp.opencode:::${model.id}`,
                    sdkMode: 'anthropic',
                    sessionId: 'signed-empty-session',
                    credentialId: 'credential-A'
                };
                const cache = new SdkReplayCache();
                const cancellation = new vscode.CancellationTokenSource();
                const output: vscode.LanguageModelResponsePart2[] = [];
                const process = createResponseProcessor({
                    behavior: {
                        kind: sdk ? 'sdk' : 'copilot-chat',
                        cacheUsage: sdk,
                        legacyTurnAffinity: !sdk,
                        auxiliaryResponse: undefined
                    },
                    classification: { requestOrigin: sdk ? 'copilot-sdk' : 'copilot-chat' } as RequestClassification,
                    providerKey: identity.provider,
                    modelId: identity.modelId,
                    sdkMode: 'anthropic',
                    requestId: 'signed-empty-request',
                    sessionId: identity.sessionId,
                    continuity: { version: 1, scope: 'chain', source: 'sdk-session' },
                    continuityAgentRole: 'main',
                    options: { requestInitiator: 'core', toolMode: vscode.LanguageModelChatToolMode.Auto },
                    token: cancellation.token,
                    sdkReplayCache: sdk ? cache : undefined
                });
                const reporter = new StreamReporter({
                    modelName: model.name,
                    modelId: identity.modelId,
                    provider: identity.provider,
                    sdkMode: 'anthropic',
                    sessionId: identity.sessionId,
                    progress: {
                        report(part) {
                            const processed = process(part as vscode.LanguageModelResponsePart, {
                                statefulCredentialId: identity.credentialId
                            });
                            if (processed) output.push(processed);
                        }
                    }
                });
                const handler = new AnthropicHandler({} as GenericModelProvider) as unknown as {
                    handleAnthropicStream(
                        stream: AsyncIterable<unknown>,
                        reporter: StreamReporter,
                        token: vscode.CancellationToken
                    ): Promise<unknown>;
                };
                async function* stream() {
                    yield {
                        type: 'message_start',
                        message: { id: 'signed-empty-response', usage: { input_tokens: 10, output_tokens: 0 } }
                    };
                    yield {
                        type: 'content_block_start',
                        index: 0,
                        content_block: { type: 'thinking', thinking: '', signature: '' }
                    };
                    for (const signature of ['opaque-', 'signature']) {
                        yield { type: 'content_block_delta', index: 0, delta: { type: 'signature_delta', signature } };
                    }
                    yield { type: 'content_block_stop', index: 0 };
                    if (ending === 'tool') {
                        yield {
                            type: 'content_block_start',
                            index: 1,
                            content_block: {
                                type: 'tool_use',
                                id: 'call-1',
                                name: 'read_file',
                                input: { path: 'example.ts' }
                            }
                        };
                        yield { type: 'content_block_stop', index: 1 };
                    } else if (ending === 'text') {
                        yield { type: 'content_block_start', index: 1, content_block: { type: 'text', text: '' } };
                        yield { type: 'content_block_delta', index: 1, delta: { type: 'text_delta', text: 'answer' } };
                        yield { type: 'content_block_stop', index: 1 };
                    }
                    yield {
                        type: 'message_delta',
                        delta: { stop_reason: ending === 'tool' ? 'tool_use' : 'end_turn' },
                        usage: { output_tokens: 10 }
                    };
                    yield { type: 'message_stop' };
                }
                try {
                    await handler.handleAnthropicStream(stream(), reporter, cancellation.token);
                    assert.equal(reporter.hasContent, true);
                    assert.equal(
                        output.some(part => part instanceof vscode.LanguageModelDataPart),
                        !sdk
                    );
                    const content = output.map(part =>
                        sdk && part instanceof vscode.LanguageModelThinkingPart ?
                            new vscode.LanguageModelThinkingPart(
                                part.value,
                                part.id,
                                part.metadata?.signature ? { signature: part.metadata.signature } : undefined
                            )
                        :   part
                    ) as vscode.LanguageModelChatMessage['content'];
                    const history: vscode.LanguageModelChatMessage[] = [
                        vscode.LanguageModelChatMessage.User('read the file'),
                        { role: vscode.LanguageModelChatMessageRole.Assistant, name: undefined, content }
                    ];
                    if (ending === 'tool') {
                        history.push(
                            vscode.LanguageModelChatMessage.User([
                                new vscode.LanguageModelToolResultPart('call-1', [
                                    new vscode.LanguageModelTextPart('result')
                                ])
                            ])
                        );
                    }
                    const before = JSON.stringify(history);
                    const convert = (expected = identity) =>
                        apiMessageToAnthropicMessage(
                            model,
                            filterStatefulReplay(history, expected, sdk ? cache : undefined),
                            identity.provider
                        ).messages.flatMap(message => (Array.isArray(message.content) ? message.content : []));
                    const blocks = convert();
                    assert.deepEqual(
                        blocks.filter(block => block.type === 'thinking'),
                        [{ type: 'thinking', thinking: '', signature: 'opaque-signature' }]
                    );
                    assert.equal(blocks.filter(block => block.type === 'tool_use').length, ending === 'tool' ? 1 : 0);
                    assert.equal(
                        blocks.filter(block => block.type === 'tool_result').length,
                        ending === 'tool' ? 1 : 0
                    );
                    for (const mismatch of [
                        { credentialId: 'credential-B' },
                        { sessionId: 'other-session' },
                        { modelId: 'other-model' },
                        { provider: 'other-provider' }
                    ]) {
                        assert.ok(
                            !convert({ ...identity, ...mismatch }).some(
                                block => block.type === 'thinking' && block.signature
                            )
                        );
                    }
                    assert.equal(JSON.stringify(history), before);
                } finally {
                    reporter.finishMetrics();
                    cancellation.dispose();
                    cache.dispose();
                }
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
