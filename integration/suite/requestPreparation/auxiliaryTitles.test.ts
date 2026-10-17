import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import * as vscode from 'vscode';
import { isSubRequest, type RequestKind } from '../../../src/handlers/classification/requestClassifier';
import { encodeStatefulMarker } from '../../../src/handlers/stateful/statefulMarker';
import { CustomDataPartMimeTypes } from '../../../src/handlers/types';
import { GenericModelProvider } from '../../../src/providers/genericModelProvider';
import { BaiduProvider } from '../../../src/providers/baiduProvider';
import { CompatibleProvider } from '../../../src/providers/compatibleProvider';
import { DashscopeProvider } from '../../../src/providers/dashscopeProvider';
import { MiniMaxProvider } from '../../../src/providers/minimaxProvider';
import { MoonshotProvider } from '../../../src/providers/moonshotProvider';
import { TencentProvider } from '../../../src/providers/tencentProvider';
import { VolcengineProvider } from '../../../src/providers/volcengineProvider';
import { XiaomimimoProvider } from '../../../src/providers/xiaomimimoProvider';
import { ZhipuProvider } from '../../../src/providers/zhipuProvider';
import { StatusBarManager } from '../../../src/status/statusBarManager';
import { DateUtils } from '../../../src/usages/fileLogger/dateUtils';
import type { TokenRequestLog } from '../../../src/usages/fileLogger/types';
import { SessionRecoveryService } from '../../../src/usages/sessionRecoveryService';
import { SessionTitleService } from '../../../src/usages/sessionTitleService';
import { TokenUsagesManager } from '../../../src/usages/usagesManager';
import type { ModelConfig } from '../../../src/types/sharedTypes';
import { PromptAnalyzer } from '../../../src/utils/model/promptAnalyzer';
import { TokenCounter } from '../../../src/utils/model/tokenCounter';
import { ApiKeyManager } from '../../../src/utils/config/apiKeyManager';

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
const TASK_PROMPTS: Partial<Record<RequestKind, string>> = {
    'main-agent': 'You are a coding agent running in VS Code',
    'search-subagent': 'You are an AI coding research assistant that uses search tools to gather information',
    'execution-subagent':
        'You are an AI coding research assistant that runs a series of terminal commands to perform a small execution-focused task',
    summarization: 'Your task is to create a comprehensive, detailed summary of the entire conversation',
    'terminal-steering': 'You are a coding agent running in VS Code',
    'chat-title': 'You are an expert in crafting pithy titles',
    'inline-progress-message': 'You are an expert in writing short, catchy, and encouraging progress messages'
};
const WORKSPACE_SPECIFICATION_PROMPT =
    'You are a VS Code assistant. Your job is to generate the project specification when given the user description and file tree structure of the project that a user wants to create.';
const WORKSPACE_MUTATION_FILE_PROMPT =
    `${WORKSPACE_SPECIFICATION_PROMPT}\nAdditional Rules\n` +
    "The user will describe the task they're trying to accomplish, and ask you to generate or edit a file in persuit of that task.";
const WORKSPACE_STAGE_PROMPTS = [
    [
        'intent',
        'You are a Visual Studio Code assistant focused on aiding users in crafting clear and specific specifications about project or file creation within Visual Studio Code. Your role involves:',
        'workspace-gen'
    ],
    [
        'tree',
        'You are a VS Code assistant. Your job is to suggest a filetree directory structure for a project that a user wants to create.',
        'workspace-gen'
    ],
    [
        'url',
        'You are a Visual Studio Code assistant. The user has identified a project URL for a new project they want to create.',
        'workspace-gen'
    ],
    [
        'file contents',
        'You are a VS Code assistant. Your job is to generate the contents of a file in a project when given the user description, specification and tree structure of the project that a user wants to create.',
        'workspace-gen'
    ],
    [
        'specification',
        `${WORKSPACE_SPECIFICATION_PROMPT}\nAdditional Rules\nThink step by step and respond with a text description that lists and summarizes each file inside this project.`,
        'workspace-gen'
    ],
    [
        'test setup plan',
        `${WORKSPACE_SPECIFICATION_PROMPT}\nAdditional Rules\n` +
            'You will be given a user query and a tree of files they wish to edit or create in order to accomplish a task. ' +
            "Think step by step and respond with a text description that lists and summarizes what needs to be done in each file to accomplish the user's task.",
        'test-gen'
    ],
    [
        'test setup new file',
        `${WORKSPACE_MUTATION_FILE_PROMPT}\nPrint the entire contents of the file you propose.`,
        'test-gen'
    ],
    ['test setup edit file', `${WORKSPACE_MUTATION_FILE_PROMPT}\nDo not include comments in json files.`, 'test-gen'],
    [
        'vscode query rewrite',
        'You are a Visual Studio Code assistant who helps the user create well-formed and unambiguous queries about their Visual Studio Code development environment.',
        'vscode-qa'
    ]
] as const;

function requestOptions(_requestKind?: RequestKind): vscode.ProvideLanguageModelChatResponseOptions {
    return {
        toolMode: vscode.LanguageModelChatToolMode.Auto,
        requestInitiator: 'github.copilot-chat',
        modelOptions: {}
    };
}

function requestMessages(
    sessionId?: string,
    sdkMode: SdkMode = 'openai',
    subSessionId?: string,
    requestKind: RequestKind = 'main-agent'
): vscode.LanguageModelChatMessage[] {
    const messages = [vscode.LanguageModelChatMessage.User(`<userRequest>${USER_REQUEST}</userRequest>`)];
    if (requestKind !== 'unknown') {
        messages.unshift(
            new vscode.LanguageModelChatMessage(
                vscode.LanguageModelChatMessageRole.System,
                TASK_PROMPTS[requestKind] ?? 'You are an AI assistant using Copilot SDK in VS Code.'
            )
        );
    }
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

    record(params: Parameters<PreparationProvider['recordEstimatedRequestTokens']>[0]) {
        return this.recordEstimatedRequestTokens(params);
    }

    async prepare(
        messages: vscode.LanguageModelChatMessage[],
        options: vscode.ProvideLanguageModelChatResponseOptions,
        sdkMode: SdkMode,
        contextSize?: number[]
    ) {
        const modelConfig: ModelConfig = {
            id: 'preparation-model',
            name: 'Preparation Model',
            tooltip: 'Preparation Model',
            provider: PROVIDER_KEY,
            sdkMode,
            maxInputTokens: 8192,
            maxOutputTokens: 1024,
            contextSize,
            capabilities: { toolCalling: true, imageInput: true }
        };
        const model = {
            id: modelConfig.id,
            name: modelConfig.name,
            maxInputTokens: modelConfig.maxInputTokens,
            maxOutputTokens: modelConfig.maxOutputTokens
        } as vscode.LanguageModelChatInformation;
        const requestOptions = this.createRequestOptions(messages, options);
        const tracked = await this.prepareTrackedRequestContext(model, modelConfig, messages, requestOptions);
        return { ...tracked, options: requestOptions };
    }
}

class EntryProviderProbe extends GenericModelProvider {
    static async run(prototype: object, sdkMode: 'openai' | 'anthropic') {
        const provider = Object.create(prototype) as EntryProviderProbe;
        const config: ModelConfig = {
            id: 'entry-model',
            name: 'Entry Model',
            tooltip: 'Entry Model',
            provider: 'entry-provider',
            sdkMode,
            maxInputTokens: 1024,
            maxOutputTokens: 1024,
            capabilities: { imageInput: true, toolCalling: true }
        };
        const records: Parameters<EntryProviderProbe['recordEstimatedRequestTokens']>[0][] = [];
        const executions: vscode.ProvideLanguageModelChatResponseOptions[] = [];
        Object.assign(provider, {
            providerKey: 'entry-provider',
            findModelConfigById: () => config,
            ensureApiKeyForModel: async () => 'test-key',
            estimateRequestTokens: async () => ({ totalInputTokens: 10, maxInputTokens: 1024 }),
            prepareRequestSession: async () => {},
            recordEstimatedRequestTokens: async (params: (typeof records)[number]) => {
                records.push(params);
                return 'entry-request';
            },
            executeModelRequest: async (...args: Parameters<EntryProviderProbe['executeModelRequest']>) => {
                executions.push(args[3]);
            }
        });
        Object.defineProperty(provider, 'providerConfig', {
            value: { displayName: 'Entry Provider', models: [config] }
        });
        const originalEnsure = ApiKeyManager.ensureApiKey;
        ApiKeyManager.ensureApiKey = async () => true;
        const cancellation = new vscode.CancellationTokenSource();
        const options: vscode.ProvideLanguageModelChatResponseOptions = {
            toolMode: vscode.LanguageModelChatToolMode.Auto,
            requestInitiator: 'core',
            modelOptions: { requestKind: 'chat-title', subSessionId: 'stale', temperature: 0 }
        };
        const sdkMessages = [
            new vscode.LanguageModelChatMessage(
                vscode.LanguageModelChatMessageRole.System,
                'You are an AI assistant using Copilot SDK in VS Code.'
            )
        ];
        const messagesBefore = JSON.stringify(sdkMessages);
        try {
            for (const messages of [
                sdkMessages,
                requestMessages(undefined, 'openai', undefined, 'execution-subagent')
            ]) {
                await provider.provideLanguageModelChatResponse(
                    { id: config.id, name: config.name } as vscode.LanguageModelChatInformation,
                    messages,
                    options,
                    { report() {} },
                    cancellation.token
                );
            }
        } finally {
            ApiKeyManager.ensureApiKey = originalEnsure;
            cancellation.dispose();
        }
        assert.equal(JSON.stringify(sdkMessages), messagesBefore);
        return { records, executions, options };
    }
}

suite('provider response request scopes', () => {
    for (const Provider of [
        GenericModelProvider,
        BaiduProvider,
        CompatibleProvider,
        DashscopeProvider,
        MiniMaxProvider,
        MoonshotProvider,
        TencentProvider,
        VolcengineProvider,
        XiaomimimoProvider,
        ZhipuProvider
    ]) {
        for (const sdkMode of ['openai', 'anthropic'] as const) {
            test(`${Provider.name}/${sdkMode}: one scope reaches tracking and execution`, async () => {
                const { records, executions, options } = await EntryProviderProbe.run(Provider.prototype, sdkMode);
                assert.equal(records.length, 2);
                assert.equal(executions.length, 2);
                assert.equal(records[0].requestKind, 'unclassified');
                assert.equal(records[0].requestClassification.requestOrigin, 'copilot-sdk');
                assert.equal(records[0].requestClassification.agentRole, 'undetermined');
                assert.deepEqual(records[0].requestContinuity, { version: 1, scope: 'chain', source: 'new' });
                assert.equal(records[1].requestKind, 'execution-subagent');
                assert.ok(records[1].subSessionId);
                assert.equal(records[1].requestContinuity.scope, 'subagent');
                for (let index = 0; index < records.length; index++) {
                    assert.equal(records[index].options, executions[index]);
                    assert.notEqual(records[index].options, options);
                    assert.notEqual(records[index].options.modelOptions, options.modelOptions);
                    assert.equal(executions[index].modelOptions?.requestKind, records[index].requestKind);
                    assert.equal(executions[index].modelOptions?.subSessionId, records[index].subSessionId);
                }
                assert.notEqual(executions[0], executions[1]);
                assert.deepEqual(options.modelOptions, {
                    requestKind: 'chat-title',
                    subSessionId: 'stale',
                    temperature: 0
                });
            });
        }
    }
});

suite('auxiliary request title preparation', () => {
    const originalTitles = SessionTitleService.instance;
    const originalRecovery = SessionRecoveryService.instance;
    const originalUsages = TokenUsagesManager.instance;
    const originalTokenCounter = TokenCounter.getInstance;
    const originalAnalyze = PromptAnalyzer.analyzePromptParts;
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
            PromptAnalyzer.analyzePromptParts = originalAnalyze;
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
        if (kind) {
            messages = messages.filter(message => message.role !== vscode.LanguageModelChatMessageRole.System);
            if (kind !== 'unknown') {
                messages.unshift(
                    new vscode.LanguageModelChatMessage(
                        vscode.LanguageModelChatMessageRole.System,
                        TASK_PROMPTS[kind] ?? 'You are an AI assistant using Copilot SDK in VS Code.'
                    )
                );
            }
            if (kind === 'terminal-steering') {
                messages.push(
                    vscode.LanguageModelChatMessage.User('[Terminal test-session notification: command completed]')
                );
            }
        }
        const preparation = provider.prepare(messages, options, sdkMode);
        preparations.push(preparation);
        return preparation;
    }

    for (const sdkMode of SDK_MODES) {
        for (const [stage, prompt, kind] of WORKSPACE_STAGE_PROMPTS) {
            test(`${sdkMode}: legacy workspace stages preserve ${stage} classification and usage`, async () => {
                const messages = [
                    new vscode.LanguageModelChatMessage(vscode.LanguageModelChatMessageRole.System, prompt),
                    vscode.LanguageModelChatMessage.User(`<userRequest>${USER_REQUEST}</userRequest>`)
                ];
                const options = {
                    ...requestOptions(),
                    modelOptions: { requestKind: 'main-agent', temperature: 0 }
                };
                const before = JSON.stringify({ messages, options });
                const tracked = await provider.prepare(messages, options, sdkMode);
                assert.equal(tracked.requestKind, kind);
                assert.equal(tracked.classification.requestOrigin, 'copilot-chat');
                assert.equal(tracked.classification.agentRole, 'not-applicable');
                assert.equal(tracked.requestClassification.evidence.purpose.level, 'signature');
                assert.equal(tracked.options.modelOptions?.requestKind, kind);
                assert.equal(tracked.subSessionId, undefined);

                let recorded: Parameters<typeof manager.recordEstimatedTokens>[0] | undefined;
                manager.recordEstimatedTokens = async params => {
                    recorded = params;
                    return 'workspace-stage-request';
                };
                const modelConfig: ModelConfig = {
                    id: 'preparation-model',
                    name: 'Preparation Model',
                    tooltip: 'Preparation Model',
                    maxInputTokens: 8192,
                    maxOutputTokens: 1024,
                    capabilities: { imageInput: true, toolCalling: true }
                };
                assert.equal(
                    await provider.record({
                        providerKey: PROVIDER_KEY,
                        displayName: 'Preparation Test',
                        model: { id: modelConfig.id, name: modelConfig.name } as vscode.LanguageModelChatInformation,
                        modelConfig,
                        estimatedInputTokens: tracked.totalInputTokens,
                        requestKind: tracked.requestKind,
                        requestClassification: tracked.requestClassification,
                        requestContinuity: tracked.requestContinuity,
                        sessionId: tracked.sessionId,
                        subSessionId: tracked.subSessionId,
                        sessionRecoverySource: tracked.sessionRecoverySource,
                        options: tracked.options
                    }),
                    'workspace-stage-request'
                );
                assert.ok(recorded);
                assert.equal(recorded.requestKind, kind);
                assert.deepEqual(recorded.requestClassification, tracked.requestClassification);
                assert.equal(JSON.stringify({ messages, options }), before);
            });
        }

        test(`${sdkMode}: legacy workspace stages do not trust ordinary user messages`, async () => {
            for (const [, prompt] of WORKSPACE_STAGE_PROMPTS) {
                const tracked = await provider.prepare(
                    [vscode.LanguageModelChatMessage.User(prompt)],
                    requestOptions(),
                    sdkMode
                );
                assert.equal(tracked.requestKind, 'unclassified');
                assert.equal(tracked.classification.agentRole, 'undetermined');
                assert.equal(tracked.requestClassification.evidence.purpose.level, 'unknown');
            }
        });

        for (const prompt of [
            'You are an expert in file editing. The user has provided a patch that failed to apply',
            'You are an expert at analyzing files and patterns'
        ]) {
            test(`${sdkMode}: large patch input preserves patch-healer: ${prompt.slice(0, 45)}`, async () => {
                const messages = [
                    new vscode.LanguageModelChatMessage(vscode.LanguageModelChatMessageRole.System, prompt),
                    vscode.LanguageModelChatMessage.User(`The goal of the patch is:\n${'界'.repeat(100_000)}`)
                ];
                const options = requestOptions();
                const before = JSON.stringify({ messages, options });
                const tracked = await provider.prepare(messages, options, sdkMode);
                assert.equal(tracked.requestKind, 'patch-healer');
                assert.equal(tracked.classification.requestOrigin, 'copilot-chat');
                assert.equal(tracked.classification.agentRole, 'not-applicable');
                assert.equal(tracked.requestClassification.evidence.purpose.level, 'signature');
                assert.equal(tracked.requestClassification.evidence.purpose.reasonCode, undefined);
                assert.equal(tracked.options.modelOptions?.requestKind, 'patch-healer');
                assert.equal(tracked.subSessionId, undefined);
                assert.equal(JSON.stringify({ messages, options }), before);
            });
        }
    }

    for (const requestKind of ['git-commit-message', 'vision-recognition'] as const) {
        test(`internal ${requestKind} is trusted only with the actual GCMP initiator`, async () => {
            const messages = [
                new vscode.LanguageModelChatMessage(
                    vscode.LanguageModelChatMessageRole.System,
                    'You are an AI assistant using Copilot SDK in VS Code.'
                )
            ];
            const trusted = await provider.prepare(
                messages,
                {
                    ...requestOptions(),
                    requestInitiator: 'vicanent.gcmp',
                    modelOptions: { requestKind }
                },
                'openai'
            );
            assert.equal(trusted.requestKind, requestKind);
            assert.equal(trusted.classification.requestOrigin, 'gcmp');
            assert.equal(trusted.classification.evidence.purpose.level, 'contract');
            for (const requestInitiator of ['core', 'github.copilot-chat', 'another.extension']) {
                const untrusted = await provider.prepare(
                    messages,
                    {
                        ...requestOptions(),
                        requestInitiator,
                        modelOptions: { requestKind }
                    },
                    'openai'
                );
                assert.equal(untrusted.requestKind, 'unclassified');
                assert.equal(untrusted.classification.requestOrigin, 'copilot-sdk');
            }
        });
    }

    test('reused caller options never retain a prior classification or sub-session', async () => {
        const options = {
            ...requestOptions(),
            modelOptions: { requestKind: 'chat-title', subSessionId: 'stale-child', temperature: 0 }
        };
        const before = JSON.stringify(options);
        const child = await prepare('execution-subagent', undefined, 'openai', requestMessages(), options);
        const main = await prepare('main-agent', undefined, 'openai', requestMessages(), options);
        assert.equal(child.requestKind, 'execution-subagent');
        assert.ok(child.subSessionId);
        assert.equal(child.options.modelOptions?.subSessionId, child.subSessionId);
        assert.equal(main.requestKind, 'main-agent');
        assert.equal(main.subSessionId, undefined);
        assert.equal(main.options.modelOptions?.subSessionId, undefined);
        assert.notEqual(child.options, main.options);
        assert.notEqual(child.options.modelOptions, main.options.modelOptions);
        assert.equal(JSON.stringify(options), before);
    });

    test('parallel calls sharing options retain independent classification and new chain identities', async () => {
        const options = requestOptions();
        const [sdk, summary] = await Promise.all([
            prepare('unclassified', undefined, 'openai', requestMessages(), options),
            prepare('summarization', undefined, 'openai', requestMessages(), options)
        ]);
        assert.equal(sdk.classification.requestOrigin, 'copilot-sdk');
        assert.equal(sdk.classification.agentRole, 'undetermined');
        assert.equal(sdk.requestKind, 'unclassified');
        assert.equal(summary.requestKind, 'summarization');
        assert.notEqual(sdk.sessionId, summary.sessionId);
        assert.deepEqual(sdk.requestContinuity, { version: 1, scope: 'chain', source: 'new' });
        assert.deepEqual(summary.requestContinuity, { version: 1, scope: 'chain', source: 'new' });
        assert.deepEqual(options.modelOptions, {});
    });

    test('the actual estimated-token record forwards classification and continuity together', async () => {
        const tracked = await prepare('unclassified');
        let recorded: Parameters<typeof manager.recordEstimatedTokens>[0] | undefined;
        manager.recordEstimatedTokens = async params => {
            recorded = params;
            return 'estimated-sdk-request';
        };
        const config: ModelConfig = {
            id: 'preparation-model',
            name: 'Preparation Model',
            tooltip: 'Preparation Model',
            maxInputTokens: 8192,
            maxOutputTokens: 1024,
            capabilities: { imageInput: true, toolCalling: true }
        };
        assert.equal(
            await provider.record({
                providerKey: PROVIDER_KEY,
                displayName: 'Preparation Test',
                model: { id: config.id, name: config.name } as vscode.LanguageModelChatInformation,
                modelConfig: config,
                estimatedInputTokens: tracked.totalInputTokens,
                requestKind: tracked.requestKind,
                requestClassification: tracked.requestClassification,
                requestContinuity: tracked.requestContinuity,
                sessionId: tracked.sessionId,
                subSessionId: tracked.subSessionId,
                sessionRecoverySource: tracked.sessionRecoverySource,
                options: tracked.options
            }),
            'estimated-sdk-request'
        );
        assert.ok(recorded);
        assert.deepEqual(recorded.requestClassification, tracked.requestClassification);
        assert.deepEqual(recorded.requestContinuity, tracked.requestContinuity);
        assert.equal(recorded.requestInitiator, 'github.copilot-chat');
        assert.equal(recorded.otelTraceContext, undefined);
        assert.equal(recorded.telemetryTurn, undefined);
    });

    test('SDK marker recovery does not promote a role or register a formal user input', async () => {
        const sessionId = randomUUID();
        const tracked = await prepare('unclassified', sessionId);
        assert.equal(tracked.sessionId, sessionId);
        assert.equal(tracked.classification.agentRole, 'undetermined');
        assert.equal(tracked.subSessionId, undefined);
        assert.equal(tracked.balanceKey, `s:${sessionId}`);
        assert.deepEqual(tracked.requestContinuity, { version: 1, scope: 'chain', source: 'marker' });
        assert.equal(titles.resolveGeneratedTitle(USER_REQUEST, 'must not register'), false);
    });

    test('SDK unknown purposes reject matching legacy trace and summary candidates', async () => {
        const traceId = randomUUID();
        const oldSession = randomUUID();
        const summary = 'verified legacy summary '.repeat(12);
        SessionRecoveryService.instance.rememberSessionHint(oldSession, {
            providerKey: PROVIDER_KEY,
            traceId,
            telemetryTurn: 2
        });
        SessionRecoveryService.instance.rememberSummarization(oldSession, summary, {
            providerKey: PROVIDER_KEY,
            traceId,
            telemetryTurn: 2
        });
        const options = {
            ...requestOptions(),
            requestInitiator: 'core',
            modelOptions: { _otelTraceContext: { traceId, spanId: 'span' }, _telemetryTurn: 2 }
        };
        const tracked = await prepare(
            'unclassified',
            undefined,
            'openai',
            [vscode.LanguageModelChatMessage.User(summary)],
            options
        );
        assert.notEqual(tracked.sessionId, oldSession);
        assert.equal(tracked.sessionRecoverySource, 'new-uuid');
        assert.equal(tracked.balanceKey, `s:${tracked.sessionId}`);
    });

    test('weak legacy purpose cannot register a formal user input', async () => {
        const tracked = await provider.prepare(
            [
                new vscode.LanguageModelChatMessage(
                    vscode.LanguageModelChatMessageRole.System,
                    '<skills>main</skills>'
                ),
                vscode.LanguageModelChatMessage.User(`<userRequest>${USER_REQUEST}</userRequest>`)
            ],
            requestOptions(),
            'openai'
        );
        assert.equal(tracked.classification.evidence.purpose.level, 'heuristic');
        assert.equal(titles.resolveGeneratedTitle(USER_REQUEST, 'not a confirmed title'), false);
        assert.equal(tracked.balanceKey, `s:${tracked.sessionId}`);
    });

    test('built-in status bars retain quota and token statistics without context usage', () => {
        const keys = [
            'minimax',
            'zhipu',
            'kimi',
            'deepseek',
            'moonshot',
            'codex',
            'grok',
            'opencode',
            'clinepass',
            'commandcode',
            'compatible',
            'tokenUsage'
        ];
        const originalBars = StatusBarManager['statusBars'];
        const originalInitialized = StatusBarManager['initialized'];
        const originalMembers = Object.fromEntries(keys.map(key => [key, Reflect.get(StatusBarManager, key)]));
        StatusBarManager['statusBars'] = new Map();
        try {
            StatusBarManager['registerBuiltInStatusBars']({ subscriptions: [] } as unknown as vscode.ExtensionContext);
            assert.equal(StatusBarManager.getStatusBar('contextUsage'), undefined);
            assert.deepEqual(StatusBarManager.getRegisteredKeys(), keys);
            for (const key of keys) {
                assert.equal(StatusBarManager.getStatusBar(key), Reflect.get(StatusBarManager, key));
            }
            assert.equal(StatusBarManager.getStatusBar('minimax-token'), StatusBarManager.minimax);
        } finally {
            StatusBarManager.disposeAll();
            StatusBarManager['statusBars'] = originalBars;
            StatusBarManager['initialized'] = originalInitialized;
            Object.assign(StatusBarManager, originalMembers);
        }
    });

    for (const sdkMode of SDK_MODES) {
        test(`${sdkMode}: token estimation retains the selected input budget and increment`, async () => {
            const options = { ...requestOptions('summarization'), modelConfiguration: { contextSize: 3072 } };
            const preparation = provider.prepare(
                requestMessages(randomUUID(), sdkMode, undefined, 'summarization'),
                options,
                sdkMode,
                [4096]
            );
            preparations.push(preparation);
            const tracked = await preparation;
            assert.equal(tracked.totalInputTokens, 138);
            assert.equal(tracked.maxInputTokens, 3072);
            assert.equal(tracked.estimatedIncrement, 10);
            assert.deepEqual(reads, []);
        });
    }

    test('token estimation failure preserves the input budget and does not block preparation', async () => {
        PromptAnalyzer.analyzePromptParts = async () => {
            throw new Error('token estimation unavailable');
        };
        const options = { ...requestOptions('summarization'), modelConfiguration: { contextSize: 3072 } };
        const preparation = provider.prepare(requestMessages(), options, 'openai', [4096]);
        preparations.push(preparation);
        const tracked = await preparation;
        assert.equal(tracked.totalInputTokens, 0);
        assert.equal(tracked.maxInputTokens, 3072);
        assert.equal(tracked.estimatedIncrement, undefined);
        assert.match(tracked.sessionId, /^[0-9a-f-]{36}$/);
    });

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
                assert.equal(tracked.totalInputTokens, kind === 'terminal-steering' ? 148 : 138);
                assert.equal(tracked.estimatedIncrement, kind === 'terminal-steering' ? 20 : 10);
                if (kind === 'search-subagent' || kind === 'execution-subagent') {
                    assert.match(tracked.subSessionId ?? '', /^sub_[0-9a-f]{32}$/);
                    assert.equal(options.modelOptions?.subSessionId, undefined);
                    assert.equal(tracked.balanceKey, `a:${tracked.subSessionId}`);
                } else {
                    assert.equal(tracked.subSessionId, undefined);
                    assert.equal(tracked.balanceKey, `s:${sessionId}`);
                }
                assert.deepEqual(reads, []);
                assert.equal(titles.getTitle(sessionId), undefined);
            });
        }

        for (const kind of ['main-agent', 'unclassified'] as const) {
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
            const messages = requestMessages(sessionId, 'openai', undefined, 'unknown');
            messages.unshift(new vscode.LanguageModelChatMessage(vscode.LanguageModelChatMessageRole.System, prompt));
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
                modelOptions: { _otelTraceContext: { traceId, spanId: 'test-span' } }
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
