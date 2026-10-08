import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import * as vscode from 'vscode';
import { isSubRequest, type RequestKind } from '../../../src/handlers/requestClassifier';
import { encodeStatefulMarker } from '../../../src/handlers/statefulMarker';
import { CustomDataPartMimeTypes } from '../../../src/handlers/types';
import { GenericModelProvider } from '../../../src/providers/genericModelProvider';
import { DateUtils } from '../../../src/usages/fileLogger/dateUtils';
import type { TokenRequestLog } from '../../../src/usages/fileLogger/types';
import { SessionRecoveryService } from '../../../src/usages/sessionRecoveryService';
import { SessionTitleService } from '../../../src/usages/sessionTitleService';
import { TokenUsagesManager } from '../../../src/usages/usagesManager';
import type { ModelConfig } from '../../../src/types/sharedTypes';
import { TokenCounter } from '../../../src/utils/model/tokenCounter';

const SDK_MODES = ['openai', 'openai-sse', 'openai-responses', 'anthropic', 'gemini-sse'] as const;
type SdkMode = (typeof SDK_MODES)[number];
const AUXILIARY_KINDS = [
    'search-subagent',
    'execution-subagent',
    'summarization',
    'terminal-steering',
    'chat-title',
    'inline-progress-message'
] as const satisfies readonly RequestKind[];
const PROVIDER_KEY = 'request-preparation-test';
const USER_REQUEST = '检查辅助请求的会话标题恢复';
const HISTORICAL_TITLE = '历史会话标题';

function requestOptions(requestKind?: RequestKind): vscode.ProvideLanguageModelChatResponseOptions {
    return {
        toolMode: vscode.LanguageModelChatToolMode.Auto,
        requestInitiator: 'gcmp-request-preparation-test',
        modelOptions: requestKind ? { requestKind } : {}
    };
}

function requestMessages(
    sessionId?: string,
    sdkMode: SdkMode = 'openai',
    subSessionId?: string
): vscode.LanguageModelChatMessage[] {
    const messages = [vscode.LanguageModelChatMessage.User(`<userRequest>${USER_REQUEST}</userRequest>`)];
    if (sessionId) {
        messages.push(
            vscode.LanguageModelChatMessage.Assistant([
                new vscode.LanguageModelDataPart(
                    encodeStatefulMarker('preparation-model', {
                        provider: PROVIDER_KEY,
                        modelId: 'preparation-model',
                        sdkMode:
                            sdkMode === 'openai-sse' ? 'openai'
                            : sdkMode === 'gemini-sse' ? 'gemini'
                            : sdkMode,
                        sessionId,
                        subSessionId,
                        responseId: 'previous-response',
                        usage: { prompt_tokens: 128, completion_tokens: 10, total_tokens: 138 }
                    }),
                    CustomDataPartMimeTypes.StatefulMarker
                )
            ])
        );
    }
    return messages;
}

function historicalLog(sessionId: string): TokenRequestLog {
    const timestamp = Date.now();
    return {
        requestId: `${timestamp}_history`,
        timestamp,
        isoTime: new Date(timestamp).toISOString(),
        providerKey: PROVIDER_KEY,
        providerName: 'Preparation Test',
        modelId: 'preparation-model',
        modelName: 'Preparation Model',
        estimatedInput: 128,
        rawUsage: null,
        status: 'completed',
        sessionId,
        sessionTitle: HISTORICAL_TITLE
    };
}

class PreparationProvider extends GenericModelProvider {
    static create(): PreparationProvider {
        const provider = Object.create(PreparationProvider.prototype) as PreparationProvider;
        Object.assign(provider, { providerKey: PROVIDER_KEY });
        return provider;
    }

    prepare(
        messages: vscode.LanguageModelChatMessage[],
        options: vscode.ProvideLanguageModelChatResponseOptions,
        sdkMode: SdkMode
    ) {
        const modelConfig: ModelConfig = {
            id: 'preparation-model',
            name: 'Preparation Model',
            tooltip: 'Preparation Model',
            provider: PROVIDER_KEY,
            sdkMode,
            maxInputTokens: 8192,
            maxOutputTokens: 1024,
            capabilities: { toolCalling: true, imageInput: true }
        };
        const model = {
            id: modelConfig.id,
            name: modelConfig.name,
            maxInputTokens: modelConfig.maxInputTokens,
            maxOutputTokens: modelConfig.maxOutputTokens
        } as vscode.LanguageModelChatInformation;
        return this.prepareTrackedRequestContext(model, modelConfig, messages, options);
    }
}

suite('auxiliary request title preparation', () => {
    const originalTitles = SessionTitleService.instance;
    const originalRecovery = SessionRecoveryService.instance;
    const originalUsages = TokenUsagesManager.instance;
    const originalTokenCounter = TokenCounter.getInstance;
    let titles: SessionTitleService;
    let manager: typeof TokenUsagesManager.instance;
    let provider: PreparationProvider;
    let reads: string[];
    let logs: TokenRequestLog[];
    let beforeRead: (() => Promise<void>) | undefined;
    let releaseRead: (() => void) | undefined;
    let preparations: ReturnType<PreparationProvider['prepare']>[];

    setup(() => {
        titles = new SessionTitleService();
        provider = PreparationProvider.create();
        reads = [];
        logs = [];
        beforeRead = undefined;
        releaseRead = undefined;
        preparations = [];
        manager = Object.create(TokenUsagesManager.prototype) as typeof TokenUsagesManager.instance;
        Object.assign(manager, {
            historicalSessionTitleCache: new Map<string, { title: string | null; checkedAt: number }>(),
            fileLogger: {
                async getRequestDetails(date: string): Promise<TokenRequestLog[]> {
                    reads.push(date);
                    await beforeRead?.();
                    return logs;
                }
            }
        });
        Object.defineProperty(SessionTitleService, 'instance', { value: titles });
        Object.defineProperty(SessionRecoveryService, 'instance', { value: new SessionRecoveryService() });
        Object.defineProperty(TokenUsagesManager, 'instance', { value: manager });
        const counter = Object.create(TokenCounter.prototype) as TokenCounter;
        counter.countTokens = async () => 10;
        TokenCounter.getInstance = () => counter;
    });

    teardown(async () => {
        releaseRead?.();
        try {
            await Promise.allSettled(preparations);
        } finally {
            TokenCounter.getInstance = originalTokenCounter;
            Object.defineProperty(TokenUsagesManager, 'instance', { value: originalUsages });
            Object.defineProperty(SessionRecoveryService, 'instance', { value: originalRecovery });
            Object.defineProperty(SessionTitleService, 'instance', { value: originalTitles });
        }
    });

    function prepare(
        kind: RequestKind | undefined,
        sessionId?: string,
        sdkMode: SdkMode = 'openai',
        messages = requestMessages(sessionId, sdkMode),
        options = requestOptions(kind)
    ) {
        const preparation = provider.prepare(messages, options, sdkMode);
        preparations.push(preparation);
        return preparation;
    }

    for (const sdkMode of SDK_MODES) {
        for (const kind of AUXILIARY_KINDS) {
            test(`${sdkMode}: recovered ${kind} skips history without changing tracking`, async () => {
                const sessionId = randomUUID();
                logs = [historicalLog(sessionId)];
                const options = requestOptions(kind);
                const tracked = await prepare(kind, sessionId, sdkMode, requestMessages(sessionId, sdkMode), options);
                assert.equal(tracked.sessionId, sessionId);
                assert.equal(tracked.sessionRecoverySource, 'stateful-marker');
                assert.equal(tracked.requestKind, kind);
                assert.equal(tracked.sdkMode, sdkMode);
                assert.equal(tracked.totalInputTokens, 138);
                assert.equal(tracked.estimatedIncrement, 10);
                if (kind === 'search-subagent' || kind === 'execution-subagent') {
                    assert.match(tracked.subSessionId ?? '', /^sub_[0-9a-f]{32}$/);
                    assert.equal(options.modelOptions?.subSessionId, tracked.subSessionId);
                    assert.equal(tracked.balanceKey, `a:${tracked.subSessionId}`);
                } else {
                    assert.equal(tracked.subSessionId, undefined);
                    assert.equal(tracked.balanceKey, `s:${sessionId}`);
                }
                assert.deepEqual(reads, []);
                assert.equal(titles.getTitle(sessionId), undefined);
            });
        }

        for (const kind of ['main-agent', 'unknown', 'background'] as const) {
            test(`${sdkMode}: recovered ${kind} still restores historical titles`, async () => {
                const sessionId = randomUUID();
                logs = [historicalLog(sessionId)];
                const tracked = await prepare(kind, sessionId, sdkMode);
                assert.equal(tracked.sessionId, sessionId);
                assert.equal(tracked.sessionRecoverySource, 'stateful-marker');
                assert.equal(tracked.requestKind, kind);
                assert.equal(tracked.totalInputTokens, 138);
                assert.equal(tracked.estimatedIncrement, 10);
                assert.equal(reads.length, 1);
                assert.equal(titles.getTitle(sessionId), HISTORICAL_TITLE);
            });
        }

        test(`${sdkMode}: new UUID keeps skipping history and registering the session`, async () => {
            const tracked = await prepare('main-agent', undefined, sdkMode);
            assert.equal(tracked.sessionRecoverySource, 'new-uuid');
            assert.match(tracked.sessionId, /^[0-9a-f-]{36}$/);
            assert.deepEqual(reads, []);
            assert.equal(titles.getTitle(tracked.sessionId), undefined);
            assert.equal(titles.resolveGeneratedTitle(USER_REQUEST, '新会话标题'), true);
            assert.equal(titles.getTitle(tracked.sessionId), '新会话标题');
        });
    }

    for (const [kind, prompt] of [
        ['search-subagent', 'You are an AI coding research assistant that uses search tools to gather information'],
        [
            'execution-subagent',
            'You are an AI coding research assistant that runs a series of terminal commands to perform a small execution-focused task'
        ],
        ['summarization', 'Your task is to create a comprehensive, detailed summary of the entire conversation'],
        ['terminal-steering', '[Terminal test-session notification: command completed]']
    ] as const) {
        test(`real classification skips history for ${kind}`, async () => {
            const sessionId = randomUUID();
            logs = [historicalLog(sessionId)];
            const messages = requestMessages(sessionId);
            messages.unshift(vscode.LanguageModelChatMessage.User(prompt));
            if (kind === 'terminal-steering') {
                messages.push(vscode.LanguageModelChatMessage.User(prompt));
            }
            const tracked = await prepare(undefined, sessionId, 'openai', messages);
            assert.equal(tracked.requestKind, kind);
            assert.equal(tracked.sessionId, sessionId);
            assert.deepEqual(reads, []);
        });
    }

    test('terminal steering keeps its existing public classification semantics', () => {
        assert.equal(isSubRequest('terminal-steering'), false);
    });

    test('skipping auxiliary hydration preserves registration and later generated-title backfill', async () => {
        const sessionId = randomUUID();
        await prepare('search-subagent', sessionId);
        assert.deepEqual(reads, []);
        titles.rememberRequest(sessionId, 'pending-request');
        assert.deepEqual(titles.resolveGeneratedTitleDetails(USER_REQUEST, '晚到的正式标题'), {
            sessionId,
            requestId: 'pending-request',
            title: '晚到的正式标题'
        });
        assert.equal(titles.getTitle(sessionId), '晚到的正式标题');
    });

    test('skipping auxiliary hydration consumes a generated title that arrived before registration', async () => {
        const sessionId = randomUUID();
        assert.equal(titles.resolveGeneratedTitle(USER_REQUEST, '提前生成的标题'), false);
        await prepare('execution-subagent', sessionId);
        assert.deepEqual(reads, []);
        assert.equal(titles.getTitle(sessionId), '提前生成的标题');
    });

    test('existing generated titles are not downgraded by auxiliary registration', async () => {
        const sessionId = randomUUID();
        titles.rememberResolvedTitle(sessionId, '既有正式标题');
        await prepare('summarization', sessionId);
        assert.deepEqual(reads, []);
        assert.equal(titles.getTitle(sessionId), '既有正式标题');
    });

    test('skipped auxiliary hydration does not suppress a later historical title lookup', async () => {
        const sessionId = randomUUID();
        logs = [historicalLog(sessionId)];
        await prepare('chat-title', sessionId);
        assert.deepEqual(reads, []);
        assert.equal(await manager.hydrateSessionTitle(sessionId), HISTORICAL_TITLE);
        assert.equal(reads.length, 1);
    });

    test('main requests reuse resolved titles and preserve the missing-title cache', async () => {
        const knownSessionId = randomUUID();
        logs = [historicalLog(knownSessionId)];
        await prepare('main-agent', knownSessionId);
        await prepare('main-agent', knownSessionId);
        assert.equal(reads.length, 1);
        logs = [];
        reads.length = 0;
        const missingSessionId = randomUUID();
        await prepare('main-agent', missingSessionId);
        assert.deepEqual(
            reads,
            Array.from({ length: 8 }, (_, daysAgo) => DateUtils.getDateStringDaysAgo(daysAgo))
        );
        await prepare('main-agent', missingSessionId);
        assert.equal(reads.length, 8);
    });

    for (const kind of ['search-subagent', 'execution-subagent', 'summarization'] as const) {
        test(`${kind} recovered through a trace bridge skips history`, async () => {
            const sessionId = randomUUID();
            const traceId = randomUUID();
            SessionRecoveryService.instance.rememberSessionHint(sessionId, {
                providerKey: PROVIDER_KEY,
                traceId
            });
            logs = [historicalLog(sessionId)];
            const options: vscode.ProvideLanguageModelChatResponseOptions = {
                ...requestOptions(kind),
                modelOptions: { requestKind: kind, _otelTraceContext: { traceId, spanId: 'test-span' } }
            };
            const tracked = await prepare(kind, undefined, 'openai', requestMessages(), options);
            assert.equal(tracked.sessionId, sessionId);
            assert.equal(tracked.sessionRecoverySource, 'trace-bridge');
            assert.deepEqual(reads, []);
        });
    }

    test('subagent continuation retains its existing sub-session and balance key', async () => {
        const sessionId = randomUUID();
        const subSessionId = `sub_${'a'.repeat(32)}`;
        const tracked = await prepare(
            'search-subagent',
            sessionId,
            'openai',
            requestMessages(sessionId, 'openai', subSessionId)
        );
        assert.equal(tracked.subSessionId, subSessionId);
        assert.equal(tracked.balanceKey, `a:${subSessionId}`);
        assert.deepEqual(reads, []);
    });

    test('parallel auxiliary preparation finishes while main-session history is still blocked', async () => {
        const sessionId = randomUUID();
        logs = [historicalLog(sessionId)];
        let markReadStarted!: () => void;
        const readStarted = new Promise<void>(resolve => {
            markReadStarted = resolve;
        });
        const blockedRead = new Promise<void>(resolve => {
            releaseRead = resolve;
        });
        beforeRead = async () => {
            markReadStarted();
            await blockedRead;
        };
        let mainFinished = false;
        const main = prepare('main-agent', sessionId).then(() => {
            mainFinished = true;
        });
        await readStarted;
        let auxiliaryFinished = 0;
        const auxiliaries = AUXILIARY_KINDS.map(kind =>
            prepare(kind, sessionId).then(() => {
                auxiliaryFinished++;
            })
        );
        try {
            await new Promise<void>(resolve => setImmediate(resolve));
            assert.equal(mainFinished, false);
            assert.equal(auxiliaryFinished, AUXILIARY_KINDS.length);
            assert.equal(reads.length, 1);
        } finally {
            releaseRead?.();
            await Promise.allSettled([main, ...auxiliaries]);
        }
        assert.equal(mainFinished, true);
        assert.equal(titles.getTitle(sessionId), HISTORICAL_TITLE);
    });
});
