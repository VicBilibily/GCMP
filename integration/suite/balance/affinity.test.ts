import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as vscode from 'vscode';
import {
    decodeStatefulMarker,
    encodeStatefulMarker,
    type StatefulMarkerContainer
} from '../../../src/handlers/stateful/statefulMarker';
import { StreamReporter } from '../../../src/handlers/streamReporter';
import { CustomDataPartMimeTypes, isStatefulMarkerMimeType } from '../../../src/handlers/types';
import {
    SDK_CUSTOM_SUBAGENT,
    SDK_HOST_IDENTITY
} from '../../../src/handlers/classification/testFixtures/sdkPurposeSamples';
import { InterInstanceBus } from '../../../src/interInstance';
import { registerInterInstanceHandlers } from '../../../src/interInstance/activation';
import type { ApiKeyBalanceAssignmentRequestedEvent } from '../../../src/interInstance/eventProtocol';
import { setBalanceHandoffDirectoryOverride } from '../../../src/interInstance/pathResolver';
import { GenericModelProvider } from '../../../src/providers/genericModelProvider';
import { LeaderElectionService } from '../../../src/status/leaderElectionService';
import type { ModelConfig } from '../../../src/types/sharedTypes';
import { StateHost } from '../../../src/ui/configSetManager/stateHost';
import { ApiKeyManager } from '../../../src/utils/config/apiKeyManager';
import { Logger } from '../../../src/utils/runtime/logger';
import { CompatibleModelManager } from '../../../src/utils/config/compatibleModelManager';
import { ConfigSetStore } from '../../../src/utils/config/configSetStore';
import { ApiKeyFailoverManager } from '../../../src/utils/config/failover/apiKeyFailoverManager';
import { BalanceAffinityCache } from '../../../src/utils/config/failover/balanceAffinityCache';

function createContext(): vscode.ExtensionContext {
    const state = new Map<string, unknown>();
    const secrets = new Map<string, string>();
    return {
        globalState: {
            get: <T>(key: string, fallback?: T): T => (state.has(key) ? state.get(key) : fallback) as T,
            keys: () => [...state.keys()],
            async update(key: string, value: unknown) {
                if (value === undefined) {
                    state.delete(key);
                } else {
                    state.set(key, structuredClone(value));
                }
            }
        },
        subscriptions: [],
        secrets: {
            get: async (key: string) => secrets.get(key),
            store: async (key: string, value: string) => {
                secrets.set(key, value);
            },
            delete: async (key: string) => {
                secrets.delete(key);
            },
            onDidChange: () => ({ dispose() {} })
        }
    } as unknown as vscode.ExtensionContext;
}

function identity(apiKey: string, site?: string): string {
    return createHash('sha256')
        .update(`${apiKey}\u0000${site ?? ''}`)
        .digest('hex');
}

function userMessage(text = 'Analyze the project', tag = 'userRequest'): vscode.LanguageModelChatMessage {
    return vscode.LanguageModelChatMessage.User(`<${tag}>${text}</${tag}>`);
}

function turnOptions(telemetryTurn: number, traceId = randomUUID()): vscode.ProvideLanguageModelChatResponseOptions {
    return {
        requestInitiator: 'github.copilot-chat',
        toolMode: vscode.LanguageModelChatToolMode.Auto,
        modelOptions: {
            _telemetryTurn: telemetryTurn,
            _otelTraceContext: { traceId, spanId: '0123456789abcdef' }
        }
    };
}

function readMarker(parts: readonly vscode.LanguageModelResponsePart[]): StatefulMarkerContainer {
    const part = parts.find(
        value =>
            value instanceof vscode.LanguageModelDataPart && value.mimeType === CustomDataPartMimeTypes.StatefulMarker
    );
    assert.ok(part instanceof vscode.LanguageModelDataPart);
    const decoded = decodeStatefulMarker(part.data);
    assert.ok(decoded);
    return decoded.marker;
}

class AffinityProvider extends GenericModelProvider {
    static async run(
        messages: vscode.LanguageModelChatMessage[],
        settings: {
            sdkMode?: ModelConfig['sdkMode'];
            copilotOptions?: vscode.ProvideLanguageModelChatResponseOptions;
            slot?: string;
            requestKind?: string;
            systemPrompt?: string;
            modelId?: string;
            onDispatch?: (apiKey: string) => void;
        } = {}
    ) {
        const slot = settings.slot ?? 'slot';
        const sdkMode = settings.sdkMode ?? 'openai';
        const config: ModelConfig = {
            id: settings.modelId ?? 'affinity-model',
            name: 'Affinity Model',
            tooltip: 'Affinity Model',
            provider: slot,
            sdkMode,
            baseUrl: 'https://affinity.test/v1',
            maxInputTokens: 1024,
            maxOutputTokens: 1024,
            capabilities: { imageInput: true, toolCalling: true }
        };
        const provider = Object.create(AffinityProvider.prototype) as AffinityProvider;
        const usedKeys: string[] = [];
        const receivedMessages: vscode.LanguageModelChatMessage[][] = [];
        const handleRequest = async (
            _model: vscode.LanguageModelChatInformation,
            modelConfig: ModelConfig,
            _messages: vscode.LanguageModelChatMessage[],
            options: vscode.ProvideLanguageModelChatResponseOptions,
            progress: vscode.Progress<vscode.LanguageModelResponsePart>,
            _requestId: string,
            sessionId: string
        ) => {
            const apiKey = await ApiKeyManager.getApiKeyForRequest(slot, modelConfig);
            assert.ok(apiKey);
            usedKeys.push(apiKey);
            receivedMessages.push(_messages);
            settings.onDispatch?.(apiKey);
            const reporter = new StreamReporter({
                modelName: config.name,
                modelId: _model.id,
                provider: slot,
                sdkMode:
                    sdkMode === 'gemini-sse' ? 'gemini'
                    : sdkMode === 'openai-sse' ? 'openai'
                    : sdkMode,
                sessionId,
                subSessionId: (options.modelOptions as { subSessionId?: string } | undefined)?.subSessionId,
                progress
            });
            reporter.setResponseId('affinity-response');
            reporter.reportToolCall('call-read', 'read_file', { path: 'src/index.ts' });
            reporter.flushAll('tool_calls', undefined, {
                prompt_tokens: 100,
                completion_tokens: 20,
                total_tokens: 120
            });
        };
        Object.assign(provider, {
            providerKey: slot,
            cachedProviderConfig: { displayName: 'Affinity Provider', models: [config] },
            openaiHandler: { handleRequest },
            openaiCustomHandler: { handleRequest },
            openaiResponsesHandler: { handleResponsesRequest: handleRequest },
            anthropicHandler: { handleRequest },
            geminiHandler: { handleRequest }
        });
        const model = { id: `gcmp.${slot}:::${config.id}`, name: config.name } as vscode.LanguageModelChatInformation;
        const taskPrompt =
            settings.requestKind === 'execution-subagent' ?
                'You are an AI coding research assistant that runs a series of terminal commands to perform a small execution-focused task'
            : settings.requestKind === 'summarization' ?
                'Your task is to create a comprehensive, detailed summary of the entire conversation'
            :   'You are a coding agent running in VS Code';
        messages = [
            new vscode.LanguageModelChatMessage(
                vscode.LanguageModelChatMessageRole.System,
                settings.systemPrompt ?? taskPrompt
            ),
            ...messages.filter(message => message.role !== vscode.LanguageModelChatMessageRole.System)
        ];
        const options = provider.createRequestOptions(
            messages,
            settings.copilotOptions ?? {
                requestInitiator: 'github.copilot-chat',
                toolMode: vscode.LanguageModelChatToolMode.Auto,
                modelOptions: {}
            }
        );
        const tracked = await provider.prepareTrackedRequestContext(model, config, messages, options);
        const parts: vscode.LanguageModelResponsePart[] = [];
        const cancellation = new vscode.CancellationTokenSource();
        try {
            await provider.executeModelRequest(
                model,
                config,
                messages,
                options,
                { report: part => parts.push(part) },
                '',
                tracked.sessionId,
                cancellation.token,
                slot,
                Date.now(),
                0,
                undefined,
                undefined,
                tracked.balanceKey
            );
        } finally {
            cancellation.dispose();
        }
        if (tracked.classification.requestOrigin === 'copilot-sdk') {
            assert.equal(
                parts.some(
                    part => part instanceof vscode.LanguageModelDataPart && isStatefulMarkerMimeType(part.mimeType)
                ),
                false
            );
        } else {
            readMarker(parts);
        }
        return {
            ...tracked,
            usedKeys,
            receivedMessages,
            parts,
            get marker() {
                return readMarker(parts);
            }
        };
    }

    protected override async estimateRequestTokens() {
        return { totalInputTokens: 0, maxInputTokens: 1024 };
    }

    protected override async prepareRequestSession(): Promise<void> {}

    protected override async acquireRateLimit(): Promise<undefined> {
        return undefined;
    }

    protected override getRequestRetryConfig() {
        return { enabled: true, maxAttempts: 10, initialDelayMs: 0, maxDelayMs: 0 };
    }
}

function continuation(messages: vscode.LanguageModelChatMessage[], parts: vscode.LanguageModelResponsePart[]) {
    return [
        ...messages,
        vscode.LanguageModelChatMessage.Assistant(
            parts.filter(
                part =>
                    part instanceof vscode.LanguageModelTextPart ||
                    part instanceof vscode.LanguageModelToolCallPart ||
                    part instanceof vscode.LanguageModelDataPart
            )
        ),
        vscode.LanguageModelChatMessage.User([
            new vscode.LanguageModelToolResultPart('call-read', [new vscode.LanguageModelTextPart('File contents')])
        ])
    ];
}

function continuationWithoutMarker(
    messages: vscode.LanguageModelChatMessage[],
    parts: vscode.LanguageModelResponsePart[]
) {
    return continuation(
        messages,
        parts.filter(
            part =>
                !(
                    part instanceof vscode.LanguageModelDataPart &&
                    part.mimeType === CustomDataPartMimeTypes.StatefulMarker
                )
        )
    );
}

suite('balance turn affinity', () => {
    const originalLeader = LeaderElectionService.isLeader;
    const originalInitialized = LeaderElectionService.isInitialized;
    const originalAgents = LeaderElectionService.isAgentsWindow;
    const originalInstanceId = LeaderElectionService.getInstanceId;
    const originalOwnedTerm = LeaderElectionService.getOwnedAuthorityTerm;
    const originalAuthorityTerm = InterInstanceBus.getAuthorityTerm;
    const originalHasTransport = InterInstanceBus.hasActiveTransport;
    const originalTransitioning = InterInstanceBus.isAuthorityTransitioning;
    const originalPublish = InterInstanceBus.publishIpcOnly;
    let context: vscode.ExtensionContext;
    let authorityTerm: string;
    const manager = ApiKeyFailoverManager as unknown as {
        balanceLeases: Map<string, unknown>;
        balanceAttemptSnapshots: Map<string, unknown>;
    };

    setup(async () => {
        ApiKeyFailoverManager.handleBalanceAuthorityLost();
        BalanceAffinityCache.instance.clear();
        setBalanceHandoffDirectoryOverride(mkdtempSync(join(tmpdir(), 'gcmp-balance-affinity-')));
        context = createContext();
        ApiKeyManager.initialize(context);
        ConfigSetStore.initialize(context);
        authorityTerm = 'affinity-leader:1';
        LeaderElectionService.isLeader = () => true;
        LeaderElectionService.isInitialized = () => true;
        LeaderElectionService.isAgentsWindow = () => false;
        LeaderElectionService.getInstanceId = () => 'affinity-leader';
        LeaderElectionService.getOwnedAuthorityTerm = () => authorityTerm;
        InterInstanceBus.getAuthorityTerm = () => authorityTerm;
        InterInstanceBus.hasActiveTransport = () => true;
        InterInstanceBus.isAuthorityTransitioning = () => false;
        InterInstanceBus.publishIpcOnly = () => true;
        for (const id of ['a', 'b', 'c']) {
            await ConfigSetStore.add('slot', { id, label: id }, `fake-key-${id}`);
        }
        await ConfigSetStore.setActive('slot', 'a');
        await ApiKeyManager.setApiKey('slot', 'fake-key-a');
        await ConfigSetStore.setSwitchMode('slot', 'balance');
    });

    teardown(() => {
        for (const disposable of context.subscriptions) {
            disposable.dispose();
        }
        ApiKeyFailoverManager.handleBalanceAuthorityLost();
        BalanceAffinityCache.instance.clear();
        setBalanceHandoffDirectoryOverride(undefined);
        LeaderElectionService.isLeader = originalLeader;
        LeaderElectionService.isInitialized = originalInitialized;
        LeaderElectionService.isAgentsWindow = originalAgents;
        LeaderElectionService.getInstanceId = originalInstanceId;
        LeaderElectionService.getOwnedAuthorityTerm = originalOwnedTerm;
        InterInstanceBus.getAuthorityTerm = originalAuthorityTerm;
        InterInstanceBus.hasActiveTransport = originalHasTransport;
        InterInstanceBus.isAuthorityTransitioning = originalTransitioning;
        InterInstanceBus.publishIpcOnly = originalPublish;
    });

    test('SDK conversation ID restores chain tracking without emitting markers or using a text hash', async () => {
        const systemPrompt = 'You are an AI assistant using Copilot SDK in VS Code.';
        const copilotOptions: vscode.ProvideLanguageModelChatResponseOptions = {
            requestInitiator: 'core',
            toolMode: vscode.LanguageModelChatToolMode.Auto,
            modelOptions: { requestKind: 'chat-title', subSessionId: 'stale-sub', _conversationId: randomUUID() }
        };
        const messages = [userMessage()];
        const first = await AffinityProvider.run(messages, { systemPrompt, copilotOptions });
        assert.equal(first.requestKind, 'unclassified');
        assert.equal(first.classification.agentRole, 'undetermined');
        assert.equal(first.subSessionId, undefined);
        assert.equal(first.balanceKey, `s:${first.sessionId}`);
        assert.deepEqual(first.requestContinuity, { version: 1, scope: 'chain', source: 'sdk-session' });
        await ApiKeyFailoverManager.captureAttempt('slot', first.balanceKey, 'busy-sdk-chain');
        const next = await AffinityProvider.run(
            [...continuation(messages, first.parts), userMessage('a new request')],
            {
                systemPrompt,
                copilotOptions
            }
        );
        assert.equal(next.sessionId, first.sessionId);
        assert.equal(next.balanceKey, first.balanceKey);
        assert.equal(next.usedKeys.length, 1);
        assert.deepEqual(next.requestContinuity, { version: 1, scope: 'chain', source: 'sdk-session' });
        assert.equal(copilotOptions.modelOptions?.requestKind, 'chat-title');
        assert.equal(copilotOptions.modelOptions?.subSessionId, 'stale-sub');
    });

    test('marker diagnostics respect the actual LogOutputChannel level', () => {
        const logger = Logger as unknown as { outputChannel: vscode.LogOutputChannel | undefined };
        const original = logger.outputChannel;
        try {
            logger.outputChannel = undefined;
            assert.equal(Logger.isDebugEnabled(), false);
            for (const [level, enabled] of [
                [vscode.LogLevel.Trace, true],
                [vscode.LogLevel.Debug, true],
                [vscode.LogLevel.Info, false],
                [vscode.LogLevel.Warning, false],
                [vscode.LogLevel.Error, false],
                [vscode.LogLevel.Off, false]
            ] as const) {
                logger.outputChannel = { logLevel: level } as vscode.LogOutputChannel;
                assert.equal(Logger.isDebugEnabled(), enabled);
            }
        } finally {
            logger.outputChannel = original;
        }
    });

    for (const mode of ['debug', 'disabled', 'logger-failure'] as const) {
        test(`SDK markerless diagnostics preserve two-round conversation identity and privacy: ${mode}`, async () => {
            const originalDebug = Logger.debug;
            const originalEnabled = Logger.isDebugEnabled;
            const lines: string[] = [];
            Logger.isDebugEnabled = () => mode !== 'disabled';
            Logger.debug = message => {
                if (message.startsWith('[MarkerContinuity]')) {
                    if (mode === 'logger-failure') {
                        throw new Error('diagnostic failure');
                    }
                    lines.push(message);
                }
            };
            try {
                const messages = [userMessage('private-user-sentinel')];
                const settings = {
                    systemPrompt: 'You are an AI assistant using Copilot SDK in VS Code.',
                    copilotOptions: {
                        requestInitiator: 'core',
                        toolMode: vscode.LanguageModelChatToolMode.Auto,
                        modelOptions: { _conversationId: randomUUID() }
                    }
                };
                const first = await AffinityProvider.run(messages, settings);
                const history = continuation(messages, first.parts);
                const before = JSON.stringify(history);
                const next = await AffinityProvider.run(history, settings);
                assert.equal(first.sessionRecoverySource, undefined);
                assert.equal(next.sessionRecoverySource, undefined);
                assert.equal(first.requestContinuity.source, 'sdk-session');
                assert.equal(next.requestContinuity.source, 'sdk-session');
                assert.equal(next.sessionId, first.sessionId);
                assert.equal(JSON.stringify(history), before);
                if (mode !== 'debug') {
                    assert.equal(lines.length, 0);
                    return;
                }
                const inputs = lines
                    .filter(line => line.startsWith('[MarkerContinuity] input '))
                    .map(
                        line =>
                            JSON.parse(line.slice('[MarkerContinuity] input '.length)) as {
                                recoverySource: string;
                                sessionHash: string;
                                markerCount: number;
                                markers: Array<{
                                    payloadHash: string;
                                    sessionMatches: boolean;
                                    outerModelMatches: boolean;
                                    restoreStatus: string;
                                }>;
                            }
                    );
                const outputs = lines.filter(line => line.startsWith('[MarkerContinuity] output '));
                assert.equal(lines.filter(line => line.startsWith('[MarkerContinuity] entry ')).length, 2);
                assert.equal(inputs.length, 2);
                assert.equal(outputs.length, 0);
                assert.equal(inputs[0].markerCount, 0);
                assert.equal(inputs[1].markerCount, 0);
                assert.equal(inputs[0].recoverySource, 'sdk-session');
                assert.equal(inputs[1].recoverySource, 'sdk-session');
                assert.equal(inputs[0].sessionHash, inputs[1].sessionHash);
                assert.doesNotMatch(
                    lines.join('\n'),
                    /private-user-sentinel|fake-key-|affinity-model|affinity-response|fake-path|Copilot SDK in VS Code/
                );
                assert.equal(
                    lines.some(line => line.includes(first.sessionId)),
                    false
                );
            } finally {
                Logger.debug = originalDebug;
                Logger.isDebugEnabled = originalEnabled;
            }
        });
    }

    test('fallback 未分类调用延续已建立的子链，但不继承子代理角色', async () => {
        const systemPrompt = 'Unrecognized assistant.';
        const first = await AffinityProvider.run([userMessage()], { requestKind: 'execution-subagent' });
        assert.ok(first.subSessionId);
        const next = await AffinityProvider.run(continuation([userMessage()], first.parts), { systemPrompt });
        assert.equal(next.subSessionId, first.subSessionId);
        assert.equal(next.balanceKey, first.balanceKey);
        assert.equal(next.classification.agentRole, 'undetermined');
        assert.equal(next.requestKind, 'unclassified');
        const later = await AffinityProvider.run(continuation([userMessage()], next.parts), { systemPrompt });
        assert.equal(later.subSessionId, first.subSessionId);
        assert.equal(later.classification.agentRole, 'undetermined');
    });

    for (const sdkMode of ['openai', 'openai-sse', 'openai-responses', 'anthropic', 'gemini-sse'] as const) {
        for (const historyMode of ['latest', 'complete'] as const) {
            test(`${sdkMode}: SDK markerless uncertain rounds cannot inherit a child with ${historyMode} history`, async () => {
                const settings = {
                    sdkMode,
                    systemPrompt: SDK_CUSTOM_SUBAGENT,
                    copilotOptions: {
                        requestInitiator: 'core',
                        toolMode: vscode.LanguageModelChatToolMode.Auto,
                        modelOptions: { _conversationId: randomUUID() }
                    }
                };
                const first = await AffinityProvider.run([userMessage()], settings);
                assert.equal(first.classification.agentRole, 'subagent');
                assert.ok(first.subSessionId);
                let previous = first;
                let history = [userMessage()];
                for (let round = 0; round < 2; round++) {
                    history = continuation(historyMode === 'complete' ? history : [userMessage()], previous.parts);
                    const before = JSON.stringify(history);
                    previous = await AffinityProvider.run(history, { ...settings, systemPrompt: SDK_HOST_IDENTITY });
                    assert.equal(previous.classification.agentRole, 'undetermined');
                    assert.equal(previous.requestKind, 'unclassified');
                    assert.equal(previous.classification.evidence.role.level, 'unknown');
                    assert.equal(previous.sessionId, first.sessionId);
                    assert.equal(previous.subSessionId, undefined);
                    assert.equal(previous.balanceKey, `s:${first.sessionId}`);
                    assert.deepEqual(previous.requestContinuity, { version: 1, scope: 'chain', source: 'sdk-session' });
                    assert.equal(JSON.stringify(history), before);
                }
                const resumed = await AffinityProvider.run(
                    continuation(historyMode === 'complete' ? history : [userMessage()], previous.parts),
                    settings
                );
                assert.equal(resumed.classification.agentRole, 'subagent');
                assert.equal(resumed.requestContinuity.source, 'sdk-session');
                assert.equal(resumed.sessionId, first.sessionId);
                assert.ok(resumed.subSessionId);
                assert.notEqual(resumed.subSessionId, first.subSessionId);
                assert.equal(resumed.balanceKey, `a:${resumed.subSessionId}`);
            });
        }

        test(`${sdkMode}: a sub-session ID without verified child continuity cannot acquire it`, async () => {
            const first = await AffinityProvider.run([userMessage()], { sdkMode, requestKind: 'execution-subagent' });
            for (const agentRole of ['main', 'undetermined'] as const) {
                const unverified = new vscode.LanguageModelDataPart(
                    encodeStatefulMarker(first.marker.modelId, {
                        ...first.marker,
                        continuity: { version: 1, scope: 'subagent', agentRole }
                    }),
                    CustomDataPartMimeTypes.StatefulMarker
                );
                const next = await AffinityProvider.run(continuation([userMessage()], [...first.parts, unverified]), {
                    sdkMode,
                    systemPrompt: SDK_HOST_IDENTITY
                });
                assert.equal(next.subSessionId, first.subSessionId);
                assert.equal(next.classification.agentRole, 'undetermined');
                const child = await AffinityProvider.run(continuation([userMessage()], next.parts), {
                    sdkMode,
                    systemPrompt: SDK_CUSTOM_SUBAGENT
                });
                assert.notEqual(child.subSessionId, first.subSessionId);
            }
        });
    }

    for (const change of ['model', 'protocol', 'provider'] as const) {
        test(`SDK legacy marker statistics survive a ${change} change without inheriting credentials`, async () => {
            const systemPrompt = 'You are an AI assistant using Copilot SDK in VS Code.';
            const first = await AffinityProvider.run([userMessage()]);
            await ApiKeyFailoverManager.captureAttempt('slot', first.balanceKey, 'busy-original-sdk');
            const original = { ...first.marker };
            original.encryptedReasoning = [{ encryptedContent: 'private-state', reasoningId: 'rs_old' }];
            if (change === 'provider') {
                original.provider = 'other-provider';
            }
            const part = new vscode.LanguageModelDataPart(
                encodeStatefulMarker('affinity-model', original),
                CustomDataPartMimeTypes.StatefulMarker
            );
            const next = await AffinityProvider.run(continuation([userMessage()], [part]), {
                systemPrompt,
                modelId: change === 'model' ? 'another-model' : undefined,
                sdkMode: change === 'protocol' ? 'anthropic' : 'openai'
            });
            assert.equal(next.sessionId, first.sessionId);
            assert.notEqual(next.usedKeys[0], first.usedKeys[0]);
            const replayed = next.receivedMessages[0]
                .flatMap(message => message.content)
                .find(
                    value =>
                        value instanceof vscode.LanguageModelDataPart &&
                        value.mimeType === CustomDataPartMimeTypes.StatefulMarker
                );
            assert.ok(replayed instanceof vscode.LanguageModelDataPart);
            const replayedMarker = decodeStatefulMarker(replayed.data)?.marker;
            assert.equal(replayedMarker?.encryptedReasoning, undefined);
            assert.equal(replayedMarker?.responseId, '');
            assert.equal(replayedMarker?.sessionId, first.sessionId);
            assert.deepEqual(replayedMarker?.usage, original.usage);
        });
    }

    for (const sdkMode of ['openai', 'openai-sse', 'openai-responses', 'anthropic', 'gemini-sse'] as const) {
        test(`${sdkMode}: fresh session binds its first key and keeps it after load changes`, async () => {
            const messages = [userMessage()];
            const first = await AffinityProvider.run(messages, { sdkMode });
            assert.equal(first.sessionRecoverySource, 'new-uuid');
            assert.deepEqual(first.marker.balanceAffinity, {
                slot: 'slot',
                balanceKey: first.balanceKey,
                credentialId: identity(first.usedKeys[0])
            });
            assert.equal(first.marker.sessionId, first.sessionId);
            assert.equal(first.marker.hasToolCalls, true);
            assert.deepEqual(first.marker.usage, { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120 });
            assert.equal(JSON.stringify(first.marker).includes(first.usedKeys[0]), false);
            assert.equal(manager.balanceLeases.size, 0);
            assert.equal(manager.balanceAttemptSnapshots.size, 0);

            const competing = await ApiKeyFailoverManager.captureAttempt('slot', first.balanceKey, 'competing-request');
            assert.equal(competing?.apiKey, first.usedKeys[0]);
            const history = continuation(messages, first.parts);
            const originalHistory = JSON.stringify(history);
            const next = await AffinityProvider.run(history, { sdkMode });
            assert.equal(next.sessionRecoverySource, 'stateful-marker');
            assert.equal(next.sessionId, first.sessionId);
            assert.equal(next.balanceKey, first.balanceKey);
            assert.deepEqual(next.usedKeys, first.usedKeys);
            assert.deepEqual(next.marker.balanceAffinity, first.marker.balanceAffinity);
            assert.equal(JSON.stringify(history), originalHistory);
            assert.equal(manager.balanceLeases.size, 1, 'only the competing request remains in flight');
            assert.equal(manager.balanceAttemptSnapshots.size, 1);
        });
    }

    for (const tag of ['userRequest', 'user_query']) {
        for (const text of ['A different user turn', 'Analyze the project']) {
            test(`${tag}: a new user turn rebalances rather than inheriting affinity: ${text}`, async () => {
                const messages = [userMessage('Analyze the project', tag)];
                const first = await AffinityProvider.run(messages);
                await ApiKeyFailoverManager.captureAttempt('slot', first.balanceKey, 'competing-request');
                const next = await AffinityProvider.run([
                    ...continuation(messages, first.parts),
                    userMessage(text, tag)
                ]);
                assert.equal(next.sessionId, first.sessionId);
                assert.notEqual(next.usedKeys[0], first.usedKeys[0]);
                assert.equal(next.marker.balanceAffinity?.credentialId, identity(next.usedKeys[0]));
            });
        }
    }

    for (const sdkMode of ['openai', 'openai-sse', 'openai-responses', 'anthropic', 'gemini-sse'] as const) {
        for (const retained of ['tool-history', 'summary-only'] as const) {
            test(`${sdkMode}: same turn restores its key after marker removal with ${retained}`, async () => {
                const messages = [userMessage()];
                const copilotOptions = turnOptions(1);
                const first = await AffinityProvider.run(messages, { sdkMode, copilotOptions });
                const busy = await ApiKeyFailoverManager.captureAttempt(
                    'slot',
                    first.balanceKey,
                    'compaction-competing',
                    identity(first.usedKeys[0])
                );
                assert.equal(busy?.apiKey, first.usedKeys[0]);
                const history =
                    retained === 'tool-history' ?
                        continuationWithoutMarker(messages, first.parts)
                    :   [
                            vscode.LanguageModelChatMessage.User(
                                '<conversation-summary>Continue the task.</conversation-summary>'
                            )
                        ];
                const before = JSON.stringify(history);
                const next = await AffinityProvider.run(history, { sdkMode, copilotOptions });
                assert.equal(next.sessionId, first.sessionId);
                assert.equal(next.balanceKey, first.balanceKey);
                assert.deepEqual(next.usedKeys, first.usedKeys);
                assert.deepEqual(next.marker.balanceAffinity, first.marker.balanceAffinity);
                assert.equal(JSON.stringify(history), before);
                assert.equal(manager.balanceLeases.size, 1);
            });
        }
    }

    for (const text of ['Analyze the project', 'A different user turn']) {
        test(`a new telemetry turn does not inherit the compacted turn affinity: ${text}`, async () => {
            const traceId = randomUUID();
            const first = await AffinityProvider.run([userMessage()], { copilotOptions: turnOptions(1, traceId) });
            await ApiKeyFailoverManager.captureAttempt(
                'slot',
                first.balanceKey,
                'busy-old-turn',
                identity(first.usedKeys[0])
            );
            const next = await AffinityProvider.run([userMessage(text)], { copilotOptions: turnOptions(2, traceId) });
            assert.equal(next.sessionId, first.sessionId);
            assert.notEqual(next.balanceKey, first.balanceKey);
            assert.notEqual(next.usedKeys[0], first.usedKeys[0]);
        });
    }

    for (const sdkMode of ['openai', 'openai-sse', 'openai-responses', 'anthropic', 'gemini-sse'] as const) {
        for (const source of ['marker', 'cache', 'summary'] as const) {
            test(`${sdkMode}: adjacent idle turns reuse a colliding key and retain current-turn affinity via ${source}`, async () => {
                const seed = new vscode.LanguageModelDataPart(
                    encodeStatefulMarker('affinity-model', {
                        provider: 'slot',
                        modelId: 'affinity-model',
                        sdkMode: 'openai',
                        sessionId: 'session',
                        responseId: 'seed'
                    }),
                    CustomDataPartMimeTypes.StatefulMarker
                );
                const messages = [vscode.LanguageModelChatMessage.Assistant([seed]), userMessage()];
                const traceId = randomUUID();
                const first = await AffinityProvider.run(messages, {
                    sdkMode,
                    copilotOptions: turnOptions(4, traceId)
                });
                const bucket = (key: string) =>
                    parseInt(createHash('sha256').update(key).digest('hex').slice(0, 8), 16) % 3;
                assert.equal(bucket(first.balanceKey), bucket('m:session:turn:5'));
                assert.equal(manager.balanceLeases.size, 0);
                if (source === 'marker') {
                    BalanceAffinityCache.instance.clear();
                }
                const history =
                    source === 'marker' ? continuation(messages, first.parts)
                    : source === 'cache' ? continuationWithoutMarker(messages, first.parts)
                    : [
                            vscode.LanguageModelChatMessage.User(
                                '<conversation-summary>Continue the task.</conversation-summary>'
                            )
                        ];
                history.push(userMessage());
                const nextOptions = turnOptions(5, traceId);
                let dispatched = 0;
                const next = await AffinityProvider.run(history, {
                    sdkMode,
                    copilotOptions: nextOptions,
                    onDispatch() {
                        if (dispatched++ === 0) {
                            throw new Error('temporary network failure');
                        }
                    }
                });
                assert.equal(next.sessionId, first.sessionId);
                assert.notEqual(next.balanceKey, first.balanceKey);
                assert.equal(next.usedKeys[0], first.usedKeys[0]);
                assert.deepEqual(next.usedKeys, [next.usedKeys[0], next.usedKeys[0]]);
                assert.equal(next.marker.balanceAffinity?.balanceKey, next.balanceKey);
                const resumed = await AffinityProvider.run(continuation(history, next.parts), {
                    sdkMode,
                    copilotOptions: nextOptions
                });
                assert.deepEqual(resumed.usedKeys, [next.usedKeys[0]]);
                assert.equal(resumed.marker.balanceAffinity?.credentialId, identity(next.usedKeys[0]));
                assert.equal(manager.balanceLeases.size, 0);
            });
        }
    }

    for (const scope of ['wrong-slot', 'wrong-session', 'child', 'older-turn', 'invalid'] as const) {
        test(`a new turn ignores unrelated or invalid marker affinity: ${scope}`, async () => {
            const marker: StatefulMarkerContainer = {
                extension: 'vicanent.gcmp',
                provider: 'slot',
                modelId: 'affinity-model',
                sdkMode: 'openai',
                sessionId: 'session',
                responseId: 'previous',
                balanceAffinity: {
                    slot: scope === 'wrong-slot' ? 'other' : 'slot',
                    balanceKey: scope === 'older-turn' ? 'm:session:turn:3' : 'm:session:turn:4',
                    credentialId: scope === 'invalid' ? 'invalid' : identity('fake-key-b')
                }
            };
            if (scope === 'wrong-session') {
                marker.sessionId = 'other';
            }
            if (scope === 'child') {
                marker.subSessionId = 'sub_' + 'a'.repeat(32);
            }
            const history = [
                marker,
                { ...marker, sessionId: 'session', subSessionId: undefined, balanceAffinity: undefined }
            ].map(value =>
                vscode.LanguageModelChatMessage.Assistant([
                    new vscode.LanguageModelDataPart(
                        encodeStatefulMarker('affinity-model', value),
                        CustomDataPartMimeTypes.StatefulMarker
                    )
                ])
            );
            history.push(userMessage());
            const next = await AffinityProvider.run(history, { copilotOptions: turnOptions(5) });
            assert.equal(next.balanceKey, 'm:session:turn:5');
            assert.deepEqual(next.usedKeys, ['fake-key-b']);
        });
    }

    test('a replacement credential remains bound after fault isolation and marker removal', async () => {
        const messages = [userMessage()];
        const copilotOptions = turnOptions(1);
        const first = await AffinityProvider.run(messages, { copilotOptions });
        const replaced = await AffinityProvider.run(continuation(messages, first.parts), {
            copilotOptions,
            onDispatch(apiKey) {
                if (apiKey === first.usedKeys[0]) {
                    throw new Error('401 unauthorized');
                }
            }
        });
        const replacement = replaced.usedKeys.at(-1)!;
        assert.notEqual(replacement, first.usedKeys[0]);
        await ConfigSetStore.cleanupBalanceExclusions('slot', Date.now() + 5 * 60_000 + 1);
        await ApiKeyFailoverManager.captureAttempt('slot', first.balanceKey, 'busy-replacement', identity(replacement));
        const next = await AffinityProvider.run(continuationWithoutMarker(messages, replaced.parts), {
            copilotOptions
        });
        assert.deepEqual(next.usedKeys, [replacement]);
    });

    test('a mode change clears the marker-free turn binding', async () => {
        const messages = [userMessage()];
        const copilotOptions = turnOptions(1);
        const first = await AffinityProvider.run(messages, { copilotOptions });
        await ConfigSetStore.setSwitchMode('slot', 'off');
        ApiKeyFailoverManager.handleBalanceModeChanged('slot');
        await ConfigSetStore.setSwitchMode('slot', 'balance');
        ApiKeyFailoverManager.handleBalanceModeChanged('slot');
        await ApiKeyFailoverManager.captureAttempt(
            'slot',
            first.balanceKey,
            'busy-after-mode-change',
            identity(first.usedKeys[0])
        );
        const next = await AffinityProvider.run(continuationWithoutMarker(messages, first.parts), { copilotOptions });
        assert.equal(next.sessionId, first.sessionId);
        assert.notEqual(next.usedKeys[0], first.usedKeys[0]);
    });

    test('marker-free turn binding survives a Leader authority change', async () => {
        const messages = [userMessage()];
        const copilotOptions = turnOptions(1);
        const first = await AffinityProvider.run(messages, { copilotOptions });
        ApiKeyFailoverManager.handleBalanceAuthorityLost();
        authorityTerm = 'affinity-leader:2';
        await ApiKeyFailoverManager.captureAttempt(
            'slot',
            first.balanceKey,
            'busy-after-handoff',
            identity(first.usedKeys[0])
        );
        const next = await AffinityProvider.run(continuationWithoutMarker(messages, first.parts), { copilotOptions });
        assert.deepEqual(next.usedKeys, first.usedKeys);
    });

    for (const affinity of ['absent', 'replacement'] as const) {
        test(`the latest marker takes precedence over the recovery cache: ${affinity}`, async () => {
            const messages = [userMessage()];
            const copilotOptions = turnOptions(1);
            const first = await AffinityProvider.run(messages, { copilotOptions });
            await ApiKeyFailoverManager.captureAttempt(
                'slot',
                first.balanceKey,
                'busy-original',
                identity(first.usedKeys[0])
            );
            const replacement = first.usedKeys[0] === 'fake-key-b' ? 'fake-key-c' : 'fake-key-b';
            const marker = { ...first.marker };
            if (affinity === 'absent') {
                delete marker.balanceAffinity;
            } else {
                marker.balanceAffinity = { ...first.marker.balanceAffinity!, credentialId: identity(replacement) };
                await ApiKeyFailoverManager.captureAttempt('slot', 'replacement', 'busy-marker', identity(replacement));
            }
            const part = new vscode.LanguageModelDataPart(
                encodeStatefulMarker('affinity-model', marker),
                CustomDataPartMimeTypes.StatefulMarker
            );
            const next = await AffinityProvider.run(continuation(messages, [part]), { copilotOptions });
            assert.notEqual(next.usedKeys[0], first.usedKeys[0]);
            if (affinity === 'replacement') {
                assert.deepEqual(next.usedKeys, [replacement]);
            }
        });
    }

    for (const requestKind of ['summarization', 'execution-subagent']) {
        test(`${requestKind} does not overwrite the main turn recovery binding`, async () => {
            const messages = [userMessage()];
            const copilotOptions = turnOptions(1);
            const first = await AffinityProvider.run(messages, { copilotOptions });
            await ApiKeyFailoverManager.captureAttempt(
                'slot',
                first.balanceKey,
                'busy-main',
                identity(first.usedKeys[0])
            );
            const helper = await AffinityProvider.run(continuation(messages, first.parts), {
                copilotOptions,
                requestKind
            });
            assert.notEqual(helper.usedKeys[0], first.usedKeys[0]);
            const next = await AffinityProvider.run(continuationWithoutMarker(messages, helper.parts), {
                copilotOptions
            });
            assert.equal(next.sessionId, first.sessionId);
            assert.deepEqual(next.usedKeys, first.usedKeys);
        });
    }

    test('a primary-key fallback is recoverable after the first marker is removed', async () => {
        const messages = [userMessage()];
        const copilotOptions = turnOptions(1);
        LeaderElectionService.isInitialized = () => false;
        LeaderElectionService.isLeader = () => false;
        const first = await AffinityProvider.run(messages, { copilotOptions });
        assert.deepEqual(first.usedKeys, ['fake-key-a']);
        LeaderElectionService.isInitialized = () => true;
        LeaderElectionService.isLeader = () => true;
        await ApiKeyFailoverManager.captureAttempt(
            'slot',
            first.balanceKey,
            'busy-primary-fallback',
            identity(first.usedKeys[0])
        );
        const next = await AffinityProvider.run(continuationWithoutMarker(messages, first.parts), { copilotOptions });
        assert.deepEqual(next.usedKeys, first.usedKeys);
    });

    for (const action of ['replace-key', 'remove', 'replace-site', 'isolate', 'zero-weight'] as const) {
        test(`recovered affinity still validates the current credential: ${action}`, async () => {
            const messages = [userMessage()];
            const copilotOptions = turnOptions(1);
            await ApiKeyFailoverManager.captureAttempt('slot', 'busy-primary', 'busy-primary', identity('fake-key-a'));
            const first = await AffinityProvider.run(messages, { copilotOptions });
            assert.notEqual(first.usedKeys[0], 'fake-key-a');
            const id = first.usedKeys[0].slice(-1);
            if (action === 'replace-key') {
                await ConfigSetStore.setApiKey('slot', id, 'new-fake-key');
            } else if (action === 'remove' || action === 'replace-site') {
                await ConfigSetStore.remove('slot', id);
                if (action === 'replace-site') {
                    await ConfigSetStore.add('slot', { id, label: id, site: 'other-site' }, first.usedKeys[0]);
                }
            } else if (action === 'zero-weight') {
                await ConfigSetStore.updateMeta('slot', id, { balanceWeight: 0 });
            } else {
                await ConfigSetStore.addBalanceExclusion(
                    'slot',
                    first.balanceKey,
                    identity(first.usedKeys[0]),
                    Date.now(),
                    authorityTerm
                );
            }
            const next = await AffinityProvider.run(continuationWithoutMarker(messages, first.parts), {
                copilotOptions
            });
            assert.equal(next.sessionId, first.sessionId);
            assert.notEqual(next.marker.balanceAffinity?.credentialId, first.marker.balanceAffinity?.credentialId);
        });
    }

    test('subagent continuation keeps its own affinity without inheriting the parent key', async () => {
        const messages = [userMessage()];
        const parent = await AffinityProvider.run(messages);
        await ApiKeyFailoverManager.captureAttempt('slot', parent.balanceKey, 'parent-competing');
        const childMessages = continuation(messages, parent.parts);
        const child = await AffinityProvider.run(childMessages, { requestKind: 'execution-subagent' });
        assert.ok(child.subSessionId);
        assert.notEqual(child.balanceKey, parent.balanceKey);
        assert.notEqual(child.usedKeys[0], parent.usedKeys[0]);
        await ApiKeyFailoverManager.captureAttempt('slot', child.balanceKey, 'child-competing');
        const next = await AffinityProvider.run(continuation(childMessages, child.parts), {
            requestKind: 'execution-subagent'
        });
        assert.equal(next.subSessionId, child.subSessionId);
        assert.deepEqual(next.usedKeys, child.usedKeys);
        assert.equal(next.marker.balanceAffinity?.balanceKey, child.balanceKey);
    });

    for (const change of ['legacy', 'wrong-slot', 'wrong-unit', 'invalid-credential', 'foreign-marker'] as const) {
        test(`does not accept unrelated or invalid marker affinity: ${change}`, async () => {
            const messages = [userMessage()];
            const first = await AffinityProvider.run(messages);
            await ApiKeyFailoverManager.captureAttempt('slot', first.balanceKey, 'competing-request');
            const marker: StatefulMarkerContainer = {
                ...first.marker,
                balanceAffinity: {
                    slot: 'slot',
                    balanceKey: first.balanceKey,
                    credentialId: identity(first.usedKeys[0])
                }
            };
            if (change === 'legacy') {
                delete marker.balanceAffinity;
            } else if (change === 'wrong-slot') {
                marker.balanceAffinity!.slot = 'other-slot';
            } else if (change === 'wrong-unit') {
                marker.balanceAffinity!.balanceKey = 'm:other-unit';
            } else if (change === 'invalid-credential') {
                marker.balanceAffinity!.credentialId = 'not-a-credential-fingerprint';
            }
            const encoded = encodeStatefulMarker('affinity-model', marker);
            const part = new vscode.LanguageModelDataPart(encoded, CustomDataPartMimeTypes.StatefulMarker);
            if (change === 'foreign-marker') {
                const payload = { ...marker, extension: 'other.extension' };
                part.data = new TextEncoder().encode(`affinity-model\\${JSON.stringify(payload)}`);
            }
            const next = await AffinityProvider.run(continuation(messages, [part]));
            assert.notEqual(next.usedKeys[0], first.usedKeys[0]);
            assert.equal(next.marker.balanceAffinity?.credentialId, identity(next.usedKeys[0]));
        });
    }

    test('a first request without a Leader records the primary credential for continuation', async () => {
        LeaderElectionService.isInitialized = () => false;
        LeaderElectionService.isLeader = () => false;
        const messages = [userMessage()];
        const first = await AffinityProvider.run(messages);
        assert.deepEqual(first.usedKeys, ['fake-key-a']);
        assert.equal(first.marker.balanceAffinity?.credentialId, identity('fake-key-a'));
        LeaderElectionService.isInitialized = () => true;
        LeaderElectionService.isLeader = () => true;
        const busy = await ApiKeyFailoverManager.captureAttempt(
            'slot',
            'busy-primary',
            'busy-primary',
            identity('fake-key-a')
        );
        assert.equal(busy?.apiKey, 'fake-key-a');
        const next = await AffinityProvider.run(continuation(messages, first.parts));
        assert.deepEqual(next.usedKeys, first.usedKeys);
    });

    test('fault isolation replaces affinity and later continuation uses the replacement', async () => {
        const messages = [userMessage()];
        const first = await AffinityProvider.run(messages);
        const next = await AffinityProvider.run(continuation(messages, first.parts), {
            onDispatch(apiKey) {
                if (apiKey === first.usedKeys[0]) {
                    throw new Error('401 unauthorized');
                }
            }
        });
        assert.deepEqual(next.usedKeys.slice(0, 3), Array<string>(3).fill(first.usedKeys[0]));
        assert.equal(next.usedKeys.length, 4);
        assert.notEqual(next.usedKeys[3], first.usedKeys[0]);
        assert.equal(next.marker.balanceAffinity?.credentialId, identity(next.usedKeys[3]));
        await ConfigSetStore.cleanupBalanceExclusions('slot', Date.now() + 5 * 60_000 + 1);
        await ApiKeyFailoverManager.captureAttempt(
            'slot',
            'busy-replacement',
            'busy-replacement',
            identity(next.usedKeys[3])
        );
        const final = await AffinityProvider.run(continuation(continuation(messages, first.parts), next.parts));
        assert.deepEqual(final.usedKeys, [next.usedKeys[3]]);
        assert.equal(manager.balanceLeases.size, 1);
    });

    test('retry retains its selected credential across authority changes before any marker is emitted', async () => {
        let dispatched = 0;
        const result = await AffinityProvider.run([userMessage()], {
            onDispatch() {
                if (dispatched++ === 0) {
                    authorityTerm = 'affinity-leader:2';
                    throw new Error('temporary network failure');
                }
            }
        });
        assert.equal(result.usedKeys.length, 2);
        assert.equal(result.usedKeys[1], result.usedKeys[0]);
        assert.equal(result.marker.balanceAffinity?.credentialId, identity(result.usedKeys[0]));
        assert.equal(manager.balanceLeases.size, 0);
    });

    test('UI state refresh preserves all-zero balance mode and cannot bypass the provider allocation guard', async () => {
        for (const item of ConfigSetStore.list('slot')) {
            await ConfigSetStore.updateMeta('slot', item.id, { balanceWeight: 0 });
        }
        const originalIds = CompatibleModelManager.getCustomProviderIds;
        CompatibleModelManager.getCustomProviderIds = () => ['slot'];
        try {
            const states = await new StateHost({
                post() {},
                async sendStates() {},
                async refreshCliProviders() {},
                async refreshCliUsage() {},
                isAlive: () => true
            }).buildStates();
            const state = states.find(entry => entry.provider === 'slot')?.slots.find(entry => entry.slot === 'slot');
            assert.ok(state);
            assert.equal(state.switchMode, 'balance');
            assert.deepEqual(
                state.rows.map(row => row.balanceWeight),
                [0, 0, 0]
            );
            assert.equal(ConfigSetStore.isAutoSwitchEnabled('slot'), true);
            let dispatched = 0;
            await assert.rejects(
                () => AffinityProvider.run([userMessage()], { onDispatch: () => dispatched++ }),
                /positive[- ]weight|正权重/i
            );
            assert.equal(dispatched, 0);
            assert.equal(ConfigSetStore.getSwitchMode('slot'), 'balance');
        } finally {
            CompatibleModelManager.getCustomProviderIds = originalIds;
        }
    });

    test('switching balance off stops publishing affinity', async () => {
        const messages = [userMessage()];
        const first = await AffinityProvider.run(messages);
        await ConfigSetStore.setSwitchMode('slot', 'off');
        ApiKeyFailoverManager.handleBalanceModeChanged('slot');
        const next = await AffinityProvider.run(continuation(messages, first.parts));
        assert.deepEqual(next.usedKeys, ['fake-key-a']);
        assert.equal(next.marker.balanceAffinity, undefined);
    });

    for (const action of [
        'unchanged',
        'alias',
        'rename',
        'replace-key',
        'remove',
        'replace-site',
        'isolate',
        'zero-weight'
    ] as const) {
        test(`Leader validates a preferred credential against the current pool: ${action}`, async () => {
            const first = await ApiKeyFailoverManager.captureAttempt('slot', 'm:turn', 'first-request');
            assert.ok(first?.balanceLeaseId);
            const id = first.activeId;
            ApiKeyFailoverManager.releaseBalanceLease(first.balanceLeaseId);
            if (action === 'alias') {
                await ConfigSetStore.add('slot', { id: 'alias', label: 'alias' }, first.apiKey);
                await ConfigSetStore.remove('slot', id);
            } else if (action === 'rename') {
                await ConfigSetStore.updateMeta('slot', id, { label: 'renamed' });
            } else if (action === 'replace-key') {
                await ConfigSetStore.setApiKey('slot', id, 'replacement-key');
            } else if (action === 'remove' || action === 'replace-site') {
                await ConfigSetStore.remove('slot', id);
                if (action === 'replace-site') {
                    await ConfigSetStore.add('slot', { id, label: id, site: 'new-site' }, first.apiKey);
                }
            } else if (action === 'isolate') {
                await ConfigSetStore.addBalanceExclusion('slot', 'm:turn', first.identity, Date.now(), authorityTerm);
            } else if (action === 'zero-weight') {
                await ConfigSetStore.updateMeta('slot', id, { balanceWeight: 0 });
            }
            const busy = await ApiKeyFailoverManager.captureAttempt(
                'slot',
                'busy-unit',
                'busy-request',
                first.identity
            );
            assert.ok(busy?.balanceLeaseId);
            const next = await ApiKeyFailoverManager.captureAttempt('slot', 'm:turn', 'next-request', first.identity);
            assert.ok(next?.balanceLeaseId);
            assert.notEqual(next.balanceLeaseId, busy.balanceLeaseId);
            if (['unchanged', 'alias', 'rename'].includes(action)) {
                assert.equal(next.identity, first.identity);
                assert.equal(busy.identity, first.identity);
            } else {
                assert.notEqual(next.identity, first.identity);
            }
            assert.equal(next.apiKey, await ConfigSetStore.getApiKey('slot', next.activeId));
        });
    }

    test('new Leader honors marker affinity while accounting for imported live leases', async () => {
        const messages = [userMessage()];
        const first = await AffinityProvider.run(messages);
        const busy = await ApiKeyFailoverManager.captureAttempt('slot', first.balanceKey, 'busy-request');
        assert.equal(busy?.apiKey, first.usedKeys[0]);
        const handoff = await ApiKeyFailoverManager.prepareBalanceLeaseHandoff();
        assert.equal(handoff?.leases.length, 1);
        authorityTerm = 'affinity-leader:2';
        await ApiKeyFailoverManager.becomeBalanceAuthority(authorityTerm);
        assert.equal(manager.balanceLeases.size, 1);
        const next = await AffinityProvider.run(continuation(messages, first.parts));
        assert.deepEqual(next.usedKeys, first.usedKeys);
        assert.equal(manager.balanceLeases.size, 1);
    });

    test('Follower sends only the preferred fingerprint with the cancellation token in the fifth argument', async () => {
        LeaderElectionService.isLeader = () => false;
        LeaderElectionService.getOwnedAuthorityTerm = () => undefined;
        LeaderElectionService.getInstanceId = () => 'affinity-follower';
        let received: ApiKeyBalanceAssignmentRequestedEvent['payload'] | undefined;
        InterInstanceBus.publishIpcOnly = event => {
            if (event.type === 'apiKeyBalanceAssignmentRequested') {
                received = event.payload as ApiKeyBalanceAssignmentRequestedEvent['payload'];
                const requestId = received.requestId;
                queueMicrotask(() =>
                    ApiKeyFailoverManager.resolveBalanceAssignment({
                        requestId,
                        targetInstanceId: 'affinity-follower',
                        authorityTerm,
                        handled: true,
                        configId: 'b',
                        credentialId: identity('fake-key-b'),
                        leaseId: 'follower-lease',
                        expiresAt: Date.now() + 30_000
                    })
                );
            }
            return true;
        };
        const cancellation = new vscode.CancellationTokenSource();
        try {
            const attempt = await ApiKeyFailoverManager.captureAttempt(
                'slot',
                'm:turn',
                'follower-request',
                identity('fake-key-b'),
                cancellation.token
            );
            assert.equal(attempt?.identity, identity('fake-key-b'));
        } finally {
            cancellation.dispose();
        }
        assert.equal(received?.preferredCredentialId, identity('fake-key-b'));
        assert.ok(received);
        assert.equal(Object.hasOwn(received, 'previousCredentialId'), false);
        assert.equal(JSON.stringify(received).includes('fake-key-b'), false);
        assert.equal(JSON.stringify(received).includes('fake-key-a'), false);
    });

    test('Leader honors a Follower preference without sharing the request lease', async () => {
        const first = await ApiKeyFailoverManager.captureAttempt('slot', 'm:turn', 'first-request');
        assert.ok(first?.balanceLeaseId);
        const assigned = await ApiKeyFailoverManager.handleBalanceAssignmentRequest(
            {
                requestId: 'follower-request',
                requestedBy: 'affinity-follower',
                authorityTerm,
                slot: 'slot',
                balanceKey: 'm:turn',
                preferredCredentialId: first.identity,
                previousCredentialId: first.identity
            },
            'affinity-follower'
        );
        assert.equal(assigned?.handled, true);
        assert.equal(assigned?.credentialId, first.identity);
        assert.notEqual(assigned?.leaseId, first.balanceLeaseId);
        assert.equal(manager.balanceLeases.size, 2);
    });

    test('IPC accepts optional credential fingerprints and rejects malformed preferences', () => {
        registerInterInstanceHandlers(context);
        const bus = InterInstanceBus as unknown as {
            handlers: Map<
                string,
                Set<(event: { type: string; senderInstanceId: string; timestamp: number; payload: unknown }) => void>
            >;
        };
        const originalHandle = ApiKeyFailoverManager.handleBalanceAssignmentRequest;
        const received: ApiKeyBalanceAssignmentRequestedEvent['payload'][] = [];
        ApiKeyFailoverManager.handleBalanceAssignmentRequest = async payload => {
            received.push(payload);
            return undefined;
        };
        try {
            for (const [field, value] of ['preferredCredentialId', 'previousCredentialId'].flatMap(field =>
                [undefined, identity('fake-key-b'), '', null, 1, [], {}, 'g'.repeat(64), 'a'.repeat(65)].map(
                    value => [field, value] as const
                )
            )) {
                const before = received.length;
                const event = {
                    type: 'apiKeyBalanceAssignmentRequested',
                    senderInstanceId: 'affinity-follower',
                    timestamp: Date.now(),
                    payload: {
                        requestId: 'ipc-validation',
                        requestedBy: 'affinity-follower',
                        authorityTerm,
                        slot: 'slot',
                        balanceKey: 'm:turn',
                        [field]: value
                    }
                };
                for (const handler of bus.handlers.get(event.type) ?? []) {
                    handler(event);
                }
                const expected = value === undefined || value === identity('fake-key-b');
                assert.equal(received.length - before, expected ? 1 : 0);
            }
        } finally {
            ApiKeyFailoverManager.handleBalanceAssignmentRequest = originalHandle;
        }
    });
});
