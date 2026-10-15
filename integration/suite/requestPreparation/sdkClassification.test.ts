import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import * as vscode from 'vscode';
import { encodeStatefulMarker } from '../../../src/handlers/stateful/statefulMarker';
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

    static create(): SdkPreparationProvider {
        const provider = Object.create(SdkPreparationProvider.prototype) as SdkPreparationProvider;
        Object.assign(provider, {
            providerKey: 'sdk-classification-test',
            estimateRequestTokens: async () => ({ totalInputTokens: 10, maxInputTokens: 8192 }),
            prepareRequestSession: async (
                _sessionId: string,
                _messages: readonly vscode.LanguageModelChatMessage[],
                settings?: { skipHistoricalHydrate?: boolean }
            ) => {
                provider.historicalHydrateSkipped = settings?.skipHistoricalHydrate;
            }
        });
        return provider;
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
