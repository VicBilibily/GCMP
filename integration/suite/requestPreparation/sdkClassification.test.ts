import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import * as vscode from 'vscode';
import {
    decodeStatefulMarker,
    encodeStatefulMarker,
    type StatefulMarkerContainer
} from '../../../src/handlers/stateful/statefulMarker';
import { resolveRequestBehavior } from '../../../src/handlers/classification/requestBehavior';
import { createResponseProcessor } from '../../../src/providers/request/responseProcessor';
import { SdkReplayCache } from '../../../src/handlers/stateful/statefulReplay';
import { SdkUsageCache } from '../../../src/utils/model/sdkUsageCache';
import { CustomDataPartMimeTypes } from '../../../src/handlers/types';
import {
    SDK_CLAUDE_MAIN,
    SDK_CODE_REVIEW_SUBAGENT,
    SDK_COMPACTION,
    SDK_CUSTOM_SUBAGENT,
    SDK_GEMINI_MAIN,
    SDK_GENERIC_MAIN_WITH_SKILLS,
    SDK_HOST_IDENTITY,
    SDK_MAIN,
    SDK_RESEARCH_SUBAGENT,
    SDK_SECURITY_REVIEW_SUBAGENT,
    SDK_SELECTED_CUSTOM_MAIN,
    SDK_SESSION_CONTEXT,
    SHARED_HANDOFF_SUMMARY
} from '../../../src/handlers/classification/testFixtures/sdkPurposeSamples';
import { GenericModelProvider } from '../../../src/providers/genericModelProvider';
import type { ModelConfig } from '../../../src/types/sharedTypes';
import { SessionRecoveryService } from '../../../src/usages/sessionRecoveryService';
import { TokenUsagesManager } from '../../../src/usages/usagesManager';
import { ApiKeyManager } from '../../../src/utils/config/apiKeyManager';
import { ConfigSetStore } from '../../../src/utils/config/configSetStore';
import { TokenCounter } from '../../../src/utils/model/tokenCounter';
import { createContext } from '../balance/retryFixture';

const modes = ['openai', 'openai-sse', 'openai-responses', 'anthropic', 'gemini-sse'] as const;
type Mode = (typeof modes)[number];

function options(): vscode.ProvideLanguageModelChatResponseOptions {
    return {
        requestInitiator: 'core',
        toolMode: vscode.LanguageModelChatToolMode.Auto,
        modelOptions: { requestKind: 'chat-title', subSessionId: 'stale', temperature: 0 }
    };
}

function messages(prompt = SDK_MAIN, latestUser = 'Synthetic assignment.'): vscode.LanguageModelChatMessage[] {
    return [
        new vscode.LanguageModelChatMessage(vscode.LanguageModelChatMessageRole.System, prompt),
        vscode.LanguageModelChatMessage.User(latestUser)
    ];
}

function marker(mode: Mode, sessionId: string, subSessionId?: string): vscode.LanguageModelChatMessage {
    return vscode.LanguageModelChatMessage.Assistant([
        new vscode.LanguageModelDataPart(
            encodeStatefulMarker('synthetic-model', {
                provider: 'sdk-classification-test',
                modelId: 'synthetic-model',
                sdkMode:
                    mode === 'openai-sse' ? 'openai'
                    : mode === 'gemini-sse' ? 'gemini'
                    : mode,
                sessionId,
                responseId: 'synthetic-response',
                ...(subSessionId ?
                    { subSessionId, continuity: { version: 1, scope: 'subagent', agentRole: 'subagent' } }
                :   {})
            }),
            CustomDataPartMimeTypes.StatefulMarker
        )
    ]);
}

class SdkPreparationProvider extends GenericModelProvider {
    historicalHydrateSkipped?: boolean;
    lastRequestMessages?: readonly vscode.LanguageModelChatMessage[];

    static create(realEstimates = false): SdkPreparationProvider {
        const provider = Object.create(SdkPreparationProvider.prototype) as SdkPreparationProvider;
        Object.assign(provider, {
            providerKey: 'sdk-classification-test',
            prepareRequestSession: async (
                _sessionId: string,
                _messages: readonly vscode.LanguageModelChatMessage[],
                settings?: { skipHistoricalHydrate?: boolean }
            ) => {
                provider.historicalHydrateSkipped = settings?.skipHistoricalHydrate;
            }
        });
        if (!realEstimates) {
            Object.assign(provider, {
                estimateRequestTokens: async () => ({ totalInputTokens: 10, maxInputTokens: 8192 })
            });
        }
        return provider;
    }

    async respond(
        tracked: Awaited<ReturnType<SdkPreparationProvider['prepare']>>,
        input: vscode.LanguageModelChatMessage[],
        promptTokens = 1000,
        thinking?: vscode.LanguageModelThinkingPart
    ) {
        const output: vscode.LanguageModelResponsePart[] = [];
        const handleRequest = async (
            _model: vscode.LanguageModelChatInformation,
            _config: ModelConfig,
            _messages: readonly vscode.LanguageModelChatMessage[],
            _options: vscode.ProvideLanguageModelChatResponseOptions,
            progress: vscode.Progress<vscode.LanguageModelResponsePart>
        ) => {
            this.lastRequestMessages = _messages;
            if (thinking) {
                progress.report(thinking as unknown as vscode.LanguageModelResponsePart);
            }
            progress.report(new vscode.LanguageModelTextPart('answer'));
            progress.report(
                new vscode.LanguageModelDataPart(
                    encodeStatefulMarker(tracked.config.id, {
                        provider: 'sdk-classification-test',
                        modelId: tracked.config.id,
                        sdkMode:
                            tracked.sdkMode === 'openai-sse' ? 'openai'
                            : tracked.sdkMode === 'gemini-sse' ? 'gemini'
                            : tracked.sdkMode,
                        sessionId: tracked.sessionId,
                        subSessionId: tracked.subSessionId,
                        responseId: 'local-only',
                        completeSignature: 'local-only',
                        usage: { prompt_tokens: promptTokens, completion_tokens: 20, total_tokens: promptTokens + 20 }
                    }),
                    CustomDataPartMimeTypes.StatefulMarker
                )
            );
        };
        Object.assign(this, {
            baseProviderConfig: { displayName: 'Synthetic Provider', models: [] },
            cachedProviderConfig: { displayName: 'Synthetic Provider', models: [] },
            getRequestRetryConfig: () => ({ enabled: false, maxAttempts: 1, initialDelayMs: 0, maxDelayMs: 0 }),
            acquireRateLimit: async () => undefined,
            resolveRequestBaseUrl: () => 'https://example.invalid',
            openaiHandler: { handleRequest },
            openaiCustomHandler: { handleRequest },
            openaiResponsesHandler: { handleResponsesRequest: handleRequest },
            anthropicHandler: { handleRequest },
            geminiHandler: { handleRequest }
        });
        const cancellation = new vscode.CancellationTokenSource();
        try {
            await this.executeModelRequest(
                { id: tracked.config.id, name: tracked.config.name } as vscode.LanguageModelChatInformation,
                { ...tracked.config, baseUrl: 'https://example.invalid' },
                input,
                tracked.options,
                { report: part => output.push(part) },
                '',
                tracked.sessionId,
                cancellation.token,
                'sdk-classification-test',
                Date.now(),
                tracked.totalInputTokens,
                undefined,
                undefined,
                tracked.balanceKey
            );
        } finally {
            cancellation.dispose();
        }
        return output;
    }

    async prepare(
        input: vscode.LanguageModelChatMessage[],
        original: vscode.ProvideLanguageModelChatResponseOptions,
        sdkMode: Mode
    ) {
        const config: ModelConfig = {
            id: 'synthetic-model',
            name: 'Synthetic Model',
            tooltip: 'Synthetic Model',
            provider: 'sdk-classification-test',
            sdkMode,
            maxInputTokens: 8192,
            maxOutputTokens: 1024,
            capabilities: { toolCalling: true, imageInput: true }
        };
        const scoped = this.createRequestOptions(input, original);
        const tracked = await this.prepareTrackedRequestContext(
            { id: config.id, name: config.name } as vscode.LanguageModelChatInformation,
            config,
            input,
            scoped
        );
        return { ...tracked, options: scoped, config };
    }

    record(tracked: Awaited<ReturnType<SdkPreparationProvider['prepare']>>) {
        return this.recordEstimatedRequestTokens({
            ...tracked,
            providerKey: 'sdk-classification-test',
            displayName: 'Synthetic Provider',
            model: { id: tracked.config.id, name: tracked.config.name } as vscode.LanguageModelChatInformation,
            modelConfig: tracked.config,
            subSessionId: tracked.subSessionId,
            estimatedInputTokens: tracked.totalInputTokens
        });
    }
}

async function responseFixture(mode: Mode, source: 'sdk' | 'copilot-chat' | 'fallback') {
    const input = messages(
        source === 'sdk' ? SDK_MAIN
        : source === 'copilot-chat' ? 'You are a coding agent running in VS Code'
        : 'Unrecognized assistant.'
    );
    const tracked = await SdkPreparationProvider.create().prepare(
        input,
        {
            ...options(),
            requestInitiator: source === 'copilot-chat' ? 'github.copilot-chat' : 'core'
        },
        mode
    );
    const behavior = resolveRequestBehavior(tracked.classification);
    assert.equal(behavior.kind, source);
    const sdkMode =
        mode === 'openai-sse' ? 'openai'
        : mode === 'gemini-sse' ? 'gemini'
        : mode;
    const identity = {
        provider: 'sdk-classification-test',
        modelId: tracked.config.id,
        sdkMode,
        sessionId: tracked.sessionId
    } as const;
    const cache = new SdkUsageCache();
    const replayCache = new SdkReplayCache();
    cache.begin(tracked.options, identity, input);
    const cancellation = new vscode.CancellationTokenSource();
    const processResponse = createResponseProcessor({
        behavior,
        classification: tracked.classification,
        providerKey: identity.provider,
        modelId: identity.modelId,
        sdkMode: mode,
        requestId: 'synthetic-response',
        sessionId: tracked.sessionId,
        subSessionId: tracked.subSessionId,
        continuity: tracked.requestContinuity,
        continuityAgentRole: tracked.classification.agentRole,
        options: tracked.options,
        token: cancellation.token,
        sdkUsageCache: cache,
        sdkReplayCache: replayCache
    });
    const part = (
        mimeType: string,
        overrides: Partial<StatefulMarkerContainer> = {},
        outerModelId = identity.modelId
    ) =>
        new vscode.LanguageModelDataPart(
            encodeStatefulMarker(outerModelId, {
                ...identity,
                subSessionId: tracked.subSessionId,
                responseId: 'synthetic-protocol-state',
                usage: { prompt_tokens: 1000, completion_tokens: 20, total_tokens: 1020 },
                ...overrides
            }),
            mimeType
        );
    return { tracked, input, identity, cache, replayCache, cancellation, processResponse, part };
}

suite('SDK purpose provider preparation', () => {
    const originalRecovery = SessionRecoveryService.instance;
    let provider: SdkPreparationProvider;

    setup(() => {
        provider = SdkPreparationProvider.create();
        Object.defineProperty(SessionRecoveryService, 'instance', { value: new SessionRecoveryService() });
    });

    teardown(() => {
        Object.defineProperty(SessionRecoveryService, 'instance', { value: originalRecovery });
    });

    for (const mode of modes) {
        test(`${mode}: SDK response policy drops both markers and guards local usage writes`, async () => {
            const fixture = await responseFixture(mode, 'sdk');
            const { processResponse, part, tracked, input, cache, cancellation } = fixture;
            try {
                for (const mimeType of [
                    CustomDataPartMimeTypes.StatefulMarker,
                    CustomDataPartMimeTypes.SdkContinuity
                ]) {
                    for (const invalid of [
                        new vscode.LanguageModelDataPart(new TextEncoder().encode('malformed'), mimeType),
                        part(mimeType, {}, 'other-model'),
                        part(mimeType, { sessionId: 'other-session' }),
                        part(mimeType, { subSessionId: `sub_${'b'.repeat(32)}` })
                    ]) {
                        assert.equal(processResponse(invalid, {}), undefined);
                        assert.equal(cache.get(tracked.options, input), undefined);
                    }
                }
                for (const value of [
                    new vscode.LanguageModelTextPart('answer'),
                    new vscode.LanguageModelToolCallPart('call', 'read_file', {}),
                    new vscode.LanguageModelDataPart(new Uint8Array([1]), 'application/octet-stream')
                ]) {
                    assert.equal(processResponse(value, {}), value);
                }
                for (const [index, mimeType] of [
                    CustomDataPartMimeTypes.StatefulMarker,
                    CustomDataPartMimeTypes.SdkContinuity
                ].entries()) {
                    const promptTokens = 1000 + index;
                    assert.equal(
                        processResponse(
                            part(mimeType, {
                                usage: {
                                    prompt_tokens: promptTokens,
                                    completion_tokens: 20,
                                    total_tokens: promptTokens + 20
                                }
                            }),
                            {}
                        ),
                        undefined
                    );
                    assert.equal(cache.get(tracked.options, input)?.usage.prompt_tokens, promptTokens);
                }
                cancellation.cancel();
                for (const mimeType of [
                    CustomDataPartMimeTypes.StatefulMarker,
                    CustomDataPartMimeTypes.SdkContinuity
                ]) {
                    assert.equal(processResponse(part(mimeType), {}), undefined);
                    assert.equal(cache.get(tracked.options, input)?.usage.prompt_tokens, 1001);
                }
            } finally {
                cache.dispose();
                fixture.replayCache.dispose();
                cancellation.dispose();
            }
        });

        for (const source of ['sdk', 'copilot-chat', 'fallback'] as const) {
            test(`${mode}: ${source} response policy uses the current attempt identity`, async () => {
                const fixture = await responseFixture(mode, source);
                const { processResponse, identity, part, tracked, cache, cancellation } = fixture;
                try {
                    const originalThinking = new vscode.LanguageModelThinkingPart('reasoning', 'thinking-id', {
                        custom: 'preserved'
                    });
                    for (const credentialId of ['first-credential', 'second-credential', undefined]) {
                        const balanceAffinity =
                            credentialId ?
                                {
                                    slot: identity.provider,
                                    balanceKey: tracked.balanceKey,
                                    credentialId
                                }
                            :   undefined;
                        const attempt = { statefulCredentialId: credentialId, balanceAffinity };
                        const thinking = processResponse(
                            originalThinking as unknown as vscode.LanguageModelResponsePart,
                            attempt
                        ) as unknown as vscode.LanguageModelThinkingPart;
                        assert.ok(thinking instanceof vscode.LanguageModelThinkingPart);
                        assert.deepEqual(thinking.metadata, {
                            custom: 'preserved',
                            provider: identity.provider,
                            modelId: identity.modelId,
                            sdkMode: identity.sdkMode,
                            statefulCredentialId: credentialId
                        });
                        assert.deepEqual(originalThinking.metadata, { custom: 'preserved' });
                        const signedMetadata = { signature: `signature-${credentialId ?? 'missing'}` };
                        processResponse(
                            new vscode.LanguageModelThinkingPart(
                                'reasoning',
                                undefined,
                                signedMetadata
                            ) as unknown as vscode.LanguageModelResponsePart,
                            attempt
                        );
                        const replayIdentity = { ...identity, subSessionId: tracked.subSessionId, credentialId };
                        assert.equal(
                            fixture.replayCache.matches(signedMetadata, replayIdentity),
                            source === 'sdk' && credentialId !== undefined
                        );
                        assert.equal(
                            fixture.replayCache.matches(signedMetadata, {
                                ...replayIdentity,
                                credentialId: 'foreign-credential'
                            }),
                            false
                        );
                        const output = processResponse(part(CustomDataPartMimeTypes.StatefulMarker), attempt);
                        if (source === 'sdk') {
                            assert.equal(output, undefined);
                            continue;
                        }
                        assert.ok(output instanceof vscode.LanguageModelDataPart);
                        const decoded = decodeStatefulMarker(output.data);
                        assert.equal(decoded?.marker.statefulCredentialId, credentialId);
                        assert.deepEqual(decoded?.marker.balanceAffinity, balanceAffinity);
                        assert.deepEqual(decoded?.marker.continuity, {
                            version: 1,
                            scope: tracked.requestContinuity.scope,
                            agentRole: tracked.classification.agentRole
                        });
                        assert.equal(decoded?.marker.responseId, 'synthetic-protocol-state');
                    }
                    if (source !== 'sdk') {
                        for (const untouched of [
                            part(CustomDataPartMimeTypes.SdkContinuity),
                            part(CustomDataPartMimeTypes.StatefulMarker, { sessionId: 'foreign-session' }),
                            new vscode.LanguageModelDataPart(
                                new TextEncoder().encode('malformed'),
                                CustomDataPartMimeTypes.StatefulMarker
                            )
                        ]) {
                            assert.equal(processResponse(untouched, {}), untouched);
                        }
                        assert.equal(cache.get(tracked.options, fixture.input), undefined);
                    }
                    cancellation.cancel();
                    processResponse(
                        new vscode.LanguageModelThinkingPart('late', undefined, {
                            signature: 'cancelled-signature'
                        }) as unknown as vscode.LanguageModelResponsePart,
                        { statefulCredentialId: 'late-credential' }
                    );
                    assert.equal(
                        fixture.replayCache.matches(
                            { signature: 'cancelled-signature' },
                            { ...identity, credentialId: 'late-credential' }
                        ),
                        false
                    );
                } finally {
                    cache.dispose();
                    fixture.replayCache.dispose();
                    cancellation.dispose();
                }
            });
        }

        test(`${mode}: SDK provider replay binds markerless state across actual credential changes`, async () => {
            const context = createContext();
            ApiKeyManager.initialize(context);
            ConfigSetStore.initialize(context);
            const originalGetApiKey = ApiKeyManager.getApiKey;
            let credential = 'credential-A';
            ApiKeyManager.getApiKey = async () => credential;
            try {
                const original = { ...options(), modelOptions: { _conversationId: randomUUID() } };
                const input = messages();
                const first = await provider.prepare(input, original, mode);
                const metadata =
                    mode === 'openai-responses' ? { redactedData: 'issued-opaque' } : { signature: 'issued-opaque' };
                const output = await provider.respond(
                    first,
                    input,
                    1000,
                    new vscode.LanguageModelThinkingPart('visible reasoning', 'rs_1', metadata)
                );
                const emitted = output.find(part => part instanceof vscode.LanguageModelThinkingPart);
                assert.ok(emitted instanceof vscode.LanguageModelThinkingPart);
                assert.ok(emitted.metadata?.statefulCredentialId);
                assert.equal(
                    output.some(part => part instanceof vscode.LanguageModelDataPart),
                    false
                );
                const returned = new vscode.LanguageModelThinkingPart(emitted.value, emitted.id, { ...metadata });
                const tool = new vscode.LanguageModelToolCallPart('call', 'read_file', {});
                const result = new vscode.LanguageModelToolResultPart('call', [
                    new vscode.LanguageModelTextPart('result')
                ]);
                const history = [
                    ...input,
                    vscode.LanguageModelChatMessage.Assistant([
                        returned as unknown as vscode.LanguageModelTextPart,
                        tool,
                        new vscode.LanguageModelTextPart('answer')
                    ]),
                    vscode.LanguageModelChatMessage.User([result])
                ];
                const before = JSON.stringify(history);
                for (const key of ['credential-A', 'credential-B', 'credential-A']) {
                    credential = key;
                    const next = await provider.prepare(history, original, mode);
                    assert.equal(next.sessionId, first.sessionId);
                    await provider.respond(next, history);
                    const received = provider.lastRequestMessages;
                    assert.ok(received);
                    const assistant = received.find(
                        message => message.role === vscode.LanguageModelChatMessageRole.Assistant
                    );
                    assert.ok(assistant);
                    assert.equal(
                        assistant.content.some(part => part instanceof vscode.LanguageModelThinkingPart),
                        key === 'credential-A'
                    );
                    assert.equal(
                        JSON.stringify(received.map(message => message.content)).includes('issued-opaque'),
                        key === 'credential-A'
                    );
                    assert.ok(
                        assistant.content.some(
                            part => part instanceof vscode.LanguageModelToolCallPart && part.callId === 'call'
                        )
                    );
                    assert.ok(
                        received
                            .at(-1)
                            ?.content.some(
                                part => part instanceof vscode.LanguageModelToolResultPart && part.callId === 'call'
                            )
                    );
                    if (key === 'credential-B') {
                        assert.ok(
                            assistant.content.some(
                                part =>
                                    part instanceof vscode.LanguageModelTextPart && part.value === 'visible reasoning'
                            )
                        );
                    }
                }
                assert.equal(JSON.stringify(history), before);
                const otherSession = await provider.prepare(
                    history,
                    { ...original, modelOptions: { _conversationId: randomUUID() } },
                    mode
                );
                await provider.respond(otherSession, history);
                assert.equal(
                    JSON.stringify(provider.lastRequestMessages?.map(message => message.content)).includes(
                        'issued-opaque'
                    ),
                    false
                );
                const fallbackHistory = [...messages('Unrecognized assistant.'), ...history.slice(input.length)];
                const fallback = await provider.prepare(fallbackHistory, options(), mode);
                assert.equal(resolveRequestBehavior(fallback.classification).kind, 'fallback');
                credential = 'credential-B';
                await provider.respond(fallback, fallbackHistory);
                assert.equal(
                    JSON.stringify(provider.lastRequestMessages?.map(message => message.content)).includes(
                        'issued-opaque'
                    ),
                    true
                );
            } finally {
                ApiKeyManager.getApiKey = originalGetApiKey;
            }
        });

        test(`${mode}: SDK local usage flows from intercepted output to the next real estimate`, async () => {
            const realProvider = SdkPreparationProvider.create(true);
            const context = createContext();
            ApiKeyManager.initialize(context);
            ConfigSetStore.initialize(context);
            const originalGetApiKey = ApiKeyManager.getApiKey;
            const originalGetCounter = TokenCounter.getInstance;
            const counter = Object.create(TokenCounter.prototype) as TokenCounter;
            Object.assign(counter, { countTokens: async () => 10 });
            ApiKeyManager.getApiKey = async () => 'synthetic-key';
            TokenCounter.getInstance = () => counter;
            try {
                const original = { ...options(), modelOptions: { _conversationId: randomUUID() } };
                const input = messages();
                const before = JSON.stringify(input);
                const first = await realProvider.prepare(input, original, mode);
                assert.equal(first.estimatedIncrement, undefined);
                const output = await realProvider.respond(first, input);
                assert.equal(output.length, 1);
                assert.ok(output[0] instanceof vscode.LanguageModelTextPart);
                const nextInput = [
                    ...input,
                    vscode.LanguageModelChatMessage.Assistant('answer'),
                    vscode.LanguageModelChatMessage.User('next')
                ];
                const nextBefore = JSON.stringify(nextInput);
                const next = await realProvider.prepare(nextInput, original, mode);
                assert.equal(next.sessionId, first.sessionId);
                assert.equal(next.totalInputTokens, 1020);
                assert.equal(next.estimatedIncrement, 20);
                assert.equal(next.options.modelOptions?.responseId, undefined);
                assert.equal(next.options.modelOptions?.statefulCredentialId, undefined);
                assert.equal(JSON.stringify(input), before);
                assert.equal(JSON.stringify(nextInput), nextBefore);
                const summaryInput = messages(SDK_MAIN, SDK_COMPACTION);
                const summary = await realProvider.prepare(summaryInput, original, mode);
                assert.equal(summary.estimatedIncrement, undefined);
                await realProvider.respond(summary, summaryInput, 5000);
                const childInput = messages(SDK_CUSTOM_SUBAGENT);
                const child = await realProvider.prepare(childInput, original, mode);
                assert.equal(child.estimatedIncrement, undefined);
                await realProvider.respond(child, childInput, 9000);
                const afterOtherRequests = await realProvider.prepare(nextInput, original, mode);
                assert.equal(afterOtherRequests.totalInputTokens, 1020);
                const compacted = await realProvider.prepare(messages(SDK_MAIN, 'compacted task'), original, mode);
                assert.equal(compacted.estimatedIncrement, undefined);
                const otherConversation = await realProvider.prepare(
                    nextInput,
                    { ...original, modelOptions: { _conversationId: randomUUID() } },
                    mode
                );
                assert.equal(otherConversation.estimatedIncrement, undefined);
            } finally {
                ApiKeyManager.getApiKey = originalGetApiKey;
                TokenCounter.getInstance = originalGetCounter;
            }
        });

        test(`${mode}: SDK conversation ID directly stabilizes main, summary and child tracking`, async () => {
            const conversationId = randomUUID();
            const baseOptions = options();
            const original = {
                ...baseOptions,
                modelOptions: { ...baseOptions.modelOptions, _conversationId: conversationId }
            };
            const before = structuredClone(original);
            const first = await provider.prepare(messages(), original, mode);
            Object.defineProperty(SessionRecoveryService, 'instance', { value: new SessionRecoveryService() });
            const freshProvider = SdkPreparationProvider.create();
            const summary = await freshProvider.prepare(messages(SDK_MAIN, SDK_COMPACTION), original, mode);
            const child = await freshProvider.prepare(messages(SDK_CUSTOM_SUBAGENT), original, mode);
            const sibling = await freshProvider.prepare(messages(SDK_CUSTOM_SUBAGENT), original, mode);
            const unclassified = await freshProvider.prepare(messages(SDK_HOST_IDENTITY), original, mode);
            for (const result of [first, summary, child, sibling, unclassified]) {
                assert.equal(result.classification.requestOrigin, 'copilot-sdk');
                assert.equal(result.sessionId, conversationId);
                assert.equal(result.sessionRecoverySource, undefined);
                assert.equal(result.requestContinuity.source, 'sdk-session');
                assert.equal(result.options.modelOptions?._conversationId, conversationId);
            }
            assert.equal(child.classification.agentRole, 'subagent');
            assert.notEqual(child.subSessionId, sibling.subSessionId);
            assert.equal(first.subSessionId, undefined);
            assert.deepEqual(original, before);
            const manager = TokenUsagesManager.instance;
            const recordEstimatedTokens = manager.recordEstimatedTokens;
            let recorded: Parameters<typeof recordEstimatedTokens>[0] | undefined;
            manager.recordEstimatedTokens = async params => {
                recorded = params;
                return 'synthetic-sdk-conversation-record';
            };
            try {
                assert.equal(await freshProvider.record(child), 'synthetic-sdk-conversation-record');
                assert.equal(recorded?.sessionId, conversationId);
                assert.equal(recorded?.sessionRecoverySource, undefined);
                assert.equal(recorded?.requestContinuity?.source, 'sdk-session');
            } finally {
                manager.recordEstimatedTokens = recordEstimatedTokens;
            }
        });

        test(`${mode}: SDK conversation ID overrides historical markers and separates conversations`, async () => {
            const conversationId = randomUUID();
            const otherConversationId = randomUUID();
            const input = [marker(mode, randomUUID()), ...messages(`${SDK_MAIN}\n${SDK_SESSION_CONTEXT}`)];
            const before = JSON.stringify(input);
            const [first, second] = await Promise.all(
                [conversationId, otherConversationId].map(id =>
                    provider.prepare(input, { ...options(), modelOptions: { _conversationId: id } }, mode)
                )
            );
            assert.equal(first.sessionId, conversationId);
            assert.equal(second.sessionId, otherConversationId);
            assert.equal(first.balanceKey, `s:${conversationId}`);
            assert.equal(second.balanceKey, `s:${otherConversationId}`);
            assert.equal(JSON.stringify(input), before);
        });

        test(`${mode}: invalid conversation IDs and non-SDK callers keep existing recovery`, async () => {
            const sessionId = randomUUID();
            for (const invalid of [undefined, null, '', ' \t ', 123, {}, []]) {
                const result = await provider.prepare(
                    [marker(mode, sessionId), ...messages()],
                    { ...options(), modelOptions: { _conversationId: invalid } },
                    mode
                );
                assert.equal(result.sessionId, sessionId);
                assert.equal(result.sessionRecoverySource, 'stateful-marker');
            }
            for (const requestInitiator of ['core', 'github.copilot-chat', 'other.extension']) {
                const result = await provider.prepare(
                    [marker(mode, sessionId), ...messages('Synthetic unknown system prompt.')],
                    { ...options(), requestInitiator, modelOptions: { _conversationId: randomUUID() } },
                    mode
                );
                assert.notEqual(result.classification.requestOrigin, 'copilot-sdk');
                assert.equal(result.sessionId, sessionId);
                assert.equal(result.sessionRecoverySource, 'stateful-marker');
            }
        });

        for (const [name, prompt] of [
            ['default', SDK_MAIN],
            ['claude', SDK_CLAUDE_MAIN],
            ['gemini', SDK_GEMINI_MAIN],
            ['generic with skills', SDK_GENERIC_MAIN_WITH_SKILLS],
            ['selected custom', SDK_SELECTED_CUSTOM_MAIN],
            ['alternative identity', SDK_MAIN.replace(SDK_HOST_IDENTITY, 'Synthetic alternative identity.')],
            ['legacy identity', SDK_MAIN.replace(SDK_HOST_IDENTITY, 'You are an expert AI programming assistant.')]
        ] as const) {
            test(`${mode}: SDK ${name} main purpose preserves marker chain without legacy turn affinity`, async () => {
                const original = options();
                const snapshot = structuredClone(original);
                const sessionId = randomUUID();
                const input = [marker(mode, sessionId), ...messages(prompt)];
                const before = JSON.stringify(input);
                const first = await provider.prepare(input, original, mode);
                const second = await provider.prepare(
                    [marker(mode, first.sessionId), ...messages(prompt, 'Synthetic next task.')],
                    original,
                    mode
                );
                for (const result of [first, second]) {
                    assert.equal(result.requestKind, 'main-agent');
                    assert.equal(result.classification.requestOrigin, 'copilot-sdk');
                    assert.equal(result.classification.agentRole, 'main');
                    assert.equal(result.requestClassification.evidence.purpose.ruleId, 'sdk.ad270aa.main-agent');
                    assert.equal(result.sessionId, sessionId);
                    assert.equal(result.subSessionId, undefined);
                    assert.equal(result.sessionRecoverySource, 'stateful-marker');
                    assert.equal(result.balanceKey, `s:${sessionId}`);
                    assert.deepEqual(result.requestContinuity, { version: 1, scope: 'chain', source: 'marker' });
                    assert.notEqual(result.options, original);
                    assert.notEqual(result.options.modelOptions, original.modelOptions);
                    assert.equal(result.options.modelOptions?.requestKind, 'main-agent');
                    assert.equal(result.options.modelOptions?.subSessionId, undefined);
                }
                assert.notEqual(first.options, second.options);
                assert.deepEqual(original, snapshot);
                assert.equal(JSON.stringify(input), before);
            });
        }

        for (const [name, prompt, kind] of [
            ['custom', SDK_CUSTOM_SUBAGENT, 'subagent'],
            ['code-review', SDK_CODE_REVIEW_SUBAGENT, 'subagent'],
            ['security-review', SDK_SECURITY_REVIEW_SUBAGENT, 'subagent'],
            ['research', SDK_RESEARCH_SUBAGENT, 'search-subagent']
        ] as const) {
            test(`${mode}: repeated SDK ${name} delegation separates children and restores only its own marker`, async () => {
                const parentId = randomUUID();
                const original = options();
                const input = [marker(mode, parentId), ...messages(prompt, 'Synthetic repeated assignment.')];
                const first = await provider.prepare(input, original, mode);
                const second = await provider.prepare(input, original, mode);
                for (const result of [first, second]) {
                    assert.equal(result.requestKind, kind);
                    assert.equal(result.classification.agentRole, 'subagent');
                    assert.equal(result.classification.requestOrigin, 'copilot-sdk');
                    assert.equal(result.sessionRecoverySource, 'new-uuid');
                    assert.notEqual(result.sessionId, parentId);
                    assert.match(result.subSessionId ?? '', /^sub_[0-9a-f]{32}$/);
                    assert.equal(result.balanceKey, `a:${result.subSessionId}`);
                    assert.equal(result.requestContinuity.scope, 'subagent');
                }
                assert.notEqual(first.sessionId, second.sessionId);
                assert.notEqual(first.subSessionId, second.subSessionId);
                const continued = await provider.prepare(
                    [marker(mode, first.sessionId, first.subSessionId), ...messages(prompt)],
                    original,
                    mode
                );
                assert.equal(continued.sessionId, first.sessionId);
                assert.equal(continued.subSessionId, first.subSessionId);
                assert.equal(continued.sessionRecoverySource, 'stateful-marker');
                assert.equal(continued.balanceKey, first.balanceKey);
                const main = await provider.prepare(
                    [marker(mode, first.sessionId, first.subSessionId), ...messages()],
                    original,
                    mode
                );
                assert.equal(main.classification.agentRole, 'main');
                assert.notEqual(main.sessionId, first.sessionId);
                assert.equal(main.subSessionId, undefined);
            });

            for (const layout of ['messages', 'parts'] as const) {
                test(`${mode}: SDK ${name} cannot cross a newer parent marker in ${layout}`, async () => {
                    const previousSessionId = randomUUID();
                    const previousSubSessionId = `sub_${randomUUID().replace(/-/g, '')}`;
                    const parentId = randomUUID();
                    const previous = marker(mode, previousSessionId, previousSubSessionId);
                    const parent = marker(mode, parentId);
                    const history =
                        layout === 'messages' ?
                            [previous, parent]
                        :   [
                                new vscode.LanguageModelChatMessage(vscode.LanguageModelChatMessageRole.Assistant, [
                                    ...previous.content,
                                    ...parent.content
                                ])
                            ];
                    const input = [...history, ...messages(prompt, 'Synthetic repeated assignment.')];
                    const before = JSON.stringify(input);
                    const original = options();
                    const optionsBefore = structuredClone(original);
                    const first = await provider.prepare(input, original, mode);
                    const second = await provider.prepare(input, original, mode);

                    for (const result of [first, second]) {
                        assert.equal(result.requestKind, kind);
                        assert.equal(result.classification.requestOrigin, 'copilot-sdk');
                        assert.equal(result.classification.agentRole, 'subagent');
                        assert.equal(result.sessionRecoverySource, 'new-uuid');
                        assert.notEqual(result.sessionId, previousSessionId);
                        assert.notEqual(result.sessionId, parentId);
                        assert.match(result.subSessionId ?? '', /^sub_[0-9a-f]{32}$/);
                        assert.notEqual(result.subSessionId, previousSubSessionId);
                        assert.equal(result.balanceKey, `a:${result.subSessionId}`);
                        assert.notEqual(result.balanceKey, `a:${previousSubSessionId}`);
                        assert.deepEqual(result.requestContinuity, {
                            version: 1,
                            scope: 'subagent',
                            source: 'new'
                        });
                    }
                    assert.notEqual(first.sessionId, second.sessionId);
                    assert.notEqual(first.subSessionId, second.subSessionId);

                    const continued = await provider.prepare(
                        [...history, marker(mode, first.sessionId, first.subSessionId), ...messages(prompt)],
                        original,
                        mode
                    );
                    assert.equal(continued.sessionId, first.sessionId);
                    assert.equal(continued.subSessionId, first.subSessionId);
                    assert.equal(continued.sessionRecoverySource, 'stateful-marker');
                    assert.equal(continued.balanceKey, first.balanceKey);
                    assert.equal(JSON.stringify(input), before);
                    assert.deepEqual(original, optionsBefore);
                });
            }
        }

        test(`${mode}: shared handoff summary preserves marker without acquiring legacy recovery`, async () => {
            const sessionId = randomUUID();
            const original = options();
            const result = await provider.prepare(
                [marker(mode, sessionId), ...messages(SHARED_HANDOFF_SUMMARY)],
                original,
                mode
            );
            assert.equal(result.requestKind, 'summarization');
            assert.equal(result.classification.requestOrigin, 'core');
            assert.equal(result.classification.agentRole, 'not-applicable');
            assert.equal(result.requestClassification.evidence.purpose.ruleId, 'shared.handoff-summary');
            assert.equal(result.sessionId, sessionId);
            assert.equal(result.sessionRecoverySource, 'stateful-marker');
            assert.equal(result.subSessionId, undefined);
            assert.equal(result.balanceKey, `s:${sessionId}`);
            assert.notEqual(result.options, original);
            assert.equal(original.modelOptions?.requestKind, 'chat-title');
        });

        test(`${mode}: SDK compaction candidate preserves reliable marker without acquiring main or auxiliary role`, async () => {
            const sessionId = randomUUID();
            const result = await provider.prepare(
                [marker(mode, sessionId), ...messages(SDK_MAIN, SDK_COMPACTION)],
                options(),
                mode
            );
            assert.equal(result.requestKind, 'summarization');
            assert.equal(result.classification.agentRole, 'undetermined');
            assert.equal(result.requestClassification.evidence.purpose.reasonCode, 'sdk-compaction-unconfirmed');
            assert.equal(result.sessionId, sessionId);
            assert.equal(result.subSessionId, undefined);
            assert.equal(result.balanceKey, `s:${sessionId}`);
            assert.equal(provider.historicalHydrateSkipped, false);
            const withoutMarker = await provider.prepare(messages(SDK_MAIN, SDK_COMPACTION), options(), mode);
            assert.equal(withoutMarker.sessionRecoverySource, 'new-uuid');
            assert.notEqual(withoutMarker.sessionId, sessionId);
        });

        test(`${mode}: SDK main, markerless compaction and next request share only their own session context`, async () => {
            const prompt = `${SDK_GENERIC_MAIN_WITH_SKILLS}\n${SDK_SESSION_CONTEXT}`;
            const otherPrompt = prompt.replace(
                '11111111-1111-4111-8111-111111111111',
                '22222222-2222-4222-8222-222222222222'
            );
            const original = options();
            const before = structuredClone(original);
            const [first, other] = await Promise.all([
                provider.prepare(messages(prompt), original, mode),
                provider.prepare(messages(otherPrompt), original, mode)
            ]);
            assert.equal(first.sessionRecoverySource, 'new-uuid');
            assert.notEqual(first.sessionId, other.sessionId);
            const compact = await provider.prepare(messages(prompt, SDK_COMPACTION), original, mode);
            const next = await provider.prepare(messages(prompt), original, mode);
            const otherCompact = await provider.prepare(messages(otherPrompt, SDK_COMPACTION), original, mode);
            assert.equal(compact.requestKind, 'summarization');
            assert.equal(compact.classification.agentRole, 'undetermined');
            for (const result of [compact, next]) {
                assert.equal(result.sessionId, first.sessionId);
                assert.equal(result.sessionRecoverySource, undefined);
                assert.deepEqual(result.requestContinuity, { version: 1, scope: 'chain', source: 'sdk-session' });
                assert.equal(result.balanceKey, `s:${first.sessionId}`);
                assert.equal(result.subSessionId, undefined);
                assert.equal(result.options.modelOptions?.responseId, undefined);
                assert.equal(result.options.modelOptions?.statefulCredentialId, undefined);
            }
            assert.equal(otherCompact.sessionId, other.sessionId);
            assert.equal(provider.historicalHydrateSkipped, false);
            assert.deepEqual(original, before);

            const manager = TokenUsagesManager.instance;
            const recordEstimatedTokens = manager.recordEstimatedTokens;
            let recorded: Parameters<typeof recordEstimatedTokens>[0] | undefined;
            manager.recordEstimatedTokens = async params => {
                recorded = params;
                return 'synthetic-sdk-compaction-record';
            };
            try {
                assert.equal(await provider.record(compact), 'synthetic-sdk-compaction-record');
                assert.ok(recorded);
                assert.equal(recorded.requestKind, 'summarization');
                assert.equal(recorded.sessionId, first.sessionId);
                assert.equal(recorded.sessionRecoverySource, undefined);
                assert.deepEqual(recorded.requestContinuity, compact.requestContinuity);
            } finally {
                manager.recordEstimatedTokens = recordEstimatedTokens;
            }
        });

        test(`${mode}: SDK marker wins, conflicts cannot rebind, and children cannot borrow parent context`, async () => {
            const prompt = `${SDK_MAIN}\n${SDK_SESSION_CONTEXT}`;
            const sessionId = randomUUID();
            await provider.prepare([marker(mode, sessionId), ...messages(prompt)], options(), mode);
            const compact = await provider.prepare(messages(prompt, SDK_COMPACTION), options(), mode);
            assert.equal(compact.sessionId, sessionId);
            const child = await provider.prepare(
                messages(`${SDK_CUSTOM_SUBAGENT}\n${SDK_SESSION_CONTEXT}`),
                options(),
                mode
            );
            assert.notEqual(child.sessionId, sessionId);
            assert.equal(child.sessionRecoverySource, 'new-uuid');
            const otherId = randomUUID();
            const [conflicting] = await Promise.all([
                provider.prepare([marker(mode, otherId), ...messages(prompt)], options(), mode),
                provider.prepare([marker(mode, sessionId), ...messages(prompt)], options(), mode)
            ]);
            assert.equal(conflicting.sessionId, otherId);
            assert.equal(conflicting.sessionRecoverySource, 'stateful-marker');
            const ambiguous = await provider.prepare(messages(prompt, SDK_COMPACTION), options(), mode);
            assert.equal(ambiguous.sessionRecoverySource, 'new-uuid');
            assert.notEqual(ambiguous.sessionId, sessionId);
            assert.notEqual(ambiguous.sessionId, otherId);
        });

        test(`${mode}: SDK child markers and foreign initiators cannot publish or consume a main context binding`, async () => {
            const prompt = `${SDK_MAIN}\n${SDK_SESSION_CONTEXT}`;
            const parentId = randomUUID();
            const childId = `sub_${randomUUID().replace(/-/g, '')}`;
            const child = await provider.prepare(
                [marker(mode, parentId, childId), ...messages(prompt, SDK_COMPACTION)],
                options(),
                mode
            );
            assert.equal(child.sessionId, parentId);
            assert.equal(child.subSessionId, childId);
            const main = await provider.prepare(messages(prompt), options(), mode);
            assert.notEqual(main.sessionId, parentId);
            const foreign = await provider.prepare(
                messages(prompt),
                { ...options(), requestInitiator: 'other.extension' },
                mode
            );
            assert.notEqual(foreign.sessionId, main.sessionId);
            assert.equal(foreign.sessionRecoverySource, 'new-uuid');
            const next = await provider.prepare(messages(prompt, SDK_COMPACTION), options(), mode);
            assert.equal(next.sessionId, main.sessionId);
        });
    }
});
