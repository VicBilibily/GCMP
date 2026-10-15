import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import test from 'node:test';
import type * as vscode from 'vscode';
import type { GenericModelProvider } from '../../providers/genericModelProvider';
import type { ModelChatResponseOptions, ModelConfig } from '../../types/sharedTypes';
import type { RequestKind } from './requestClassifier';
import type { AgentRole, EvidenceLevel, RequestClassificationMetadata } from './requestClassification';
import { setScopedRequestClassification } from './requestClassification';
import { SDK_COMPACTION, SDK_MAIN } from './testFixtures/sdkPurposeSamples';

const require = createRequire(import.meta.url);
const NodeModule = require('node:module') as {
    prototype: {
        require: (id: string) => unknown;
    };
};

class MockTextPart {
    constructor(public value: string) {}
}

interface RequestModules {
    classifier: typeof import('./requestClassifier');
    OpenAIHandler: typeof import('../openai/openaiHandler').OpenAIHandler;
    AnthropicHandler: typeof import('../anthropic/anthropicHandler').AnthropicHandler;
    OpenAIResponsesMessageConverter: typeof import('../openai/openaiResponsesMessageConverter').OpenAIResponsesMessageConverter;
    OpenAIResponsesRequestBuilder: typeof import('../openai/openaiResponsesRequestBuilder').OpenAIResponsesRequestBuilder;
}

let modulesPromise: Promise<RequestModules> | undefined;

async function getModules(): Promise<RequestModules> {
    if (modulesPromise) {
        return modulesPromise;
    }

    const originalRequire = NodeModule.prototype.require;
    NodeModule.prototype.require = function (id: string): unknown {
        if (id === 'vscode') {
            return {
                env: { machineId: 'test-machine', language: 'en' },
                LanguageModelChatMessageRole: { System: 0, User: 1, Assistant: 2 },
                LanguageModelTextPart: MockTextPart
            };
        }
        if (id.endsWith('/logger')) {
            return { Logger: { debug() {}, info() {}, warn() {}, error() {}, trace() {} } };
        }
        if (id.endsWith('/configManager')) {
            return { ConfigManager: {} };
        }
        if (id.endsWith('/apiKeyManager')) {
            return { ApiKeyManager: {} };
        }
        if (id.endsWith('/versionManager')) {
            return { VersionManager: {} };
        }
        if (id.endsWith('/usagesManager')) {
            return { TokenUsagesManager: {} };
        }
        if (id === '../streamReporter') {
            return {
                StreamReporter: class {
                    finishMetrics() {}
                }
            };
        }
        if (id === '../liveMetrics') {
            return { emitLiveMetrics() {} };
        }
        return originalRequire.call(this, id);
    };

    modulesPromise = Promise.all([
        import('./requestClassifier'),
        import('../openai/openaiHandler'),
        import('../anthropic/anthropicHandler'),
        import('../openai/openaiResponsesMessageConverter'),
        import('../openai/openaiResponsesRequestBuilder')
    ])
        .then(([classifier, openai, anthropic, converter, responses]) => ({
            classifier,
            OpenAIHandler: openai.OpenAIHandler,
            AnthropicHandler: anthropic.AnthropicHandler,
            OpenAIResponsesMessageConverter: converter.OpenAIResponsesMessageConverter,
            OpenAIResponsesRequestBuilder: responses.OpenAIResponsesRequestBuilder
        }))
        .finally(() => {
            NodeModule.prototype.require = originalRequire;
        });

    return modulesPromise;
}

type Protocol = 'openai' | 'openai-responses' | 'anthropic';

interface ThinkingRequest {
    model?: string;
    tools?: { type: string }[];
    thinking?: { type: string };
    enable_thinking?: boolean;
    reasoning_effort?: string;
    reasoning?: { effort?: string; summary?: string };
    output_config?: { effort?: string };
}

async function buildRequest(
    protocol: Protocol,
    requestKind: RequestKind,
    settings?: ModelChatResponseOptions,
    overrides?: Partial<ModelConfig>,
    classification?: RequestClassificationMetadata
): Promise<ThinkingRequest> {
    const { OpenAIHandler, AnthropicHandler, OpenAIResponsesMessageConverter, OpenAIResponsesRequestBuilder } =
        await getModules();
    const modelConfig: ModelConfig = {
        id: 'reasoning-model',
        name: 'Reasoning Model',
        tooltip: 'Reasoning Model',
        maxInputTokens: 1024,
        maxOutputTokens: 128,
        capabilities: { toolCalling: false, imageInput: false },
        sdkMode: protocol,
        thinking: ['enabled', 'disabled'],
        thinkingFormat: 'object',
        reasoningEffort: ['high', 'medium', 'none'],
        ...overrides
    };
    const model = {
        id: modelConfig.id,
        name: modelConfig.name,
        maxOutputTokens: modelConfig.maxOutputTokens
    } as vscode.LanguageModelChatInformation;
    const options: vscode.ProvideLanguageModelChatResponseOptions = {
        toolMode: 1,
        requestInitiator: 'test',
        modelConfiguration: settings,
        modelOptions: { requestKind }
    };
    const provider = { provider: 'test' } as GenericModelProvider;
    if (classification) {
        setScopedRequestClassification(options, { ...classification, requestKind });
    }

    if (protocol === 'openai') {
        return new OpenAIHandler(provider).buildChatCompletionParams(
            model,
            modelConfig,
            [],
            options
        ) as unknown as ThinkingRequest;
    }
    if (protocol === 'openai-responses') {
        const converter = new OpenAIResponsesMessageConverter(new OpenAIHandler(provider), 'Test');
        return new OpenAIResponsesRequestBuilder('Test', converter).build({
            model,
            modelConfig,
            messages: [],
            options,
            sessionId: 'test-session'
        }).requestBody as ThinkingRequest;
    }

    const handler = new AnthropicHandler(provider);
    const requestStopped = new Error('stop before transport');
    let requestBody: ThinkingRequest | undefined;
    Object.defineProperty(handler, 'createAnthropicClient', {
        value: async () => ({
            messages: {
                create(params: ThinkingRequest) {
                    requestBody = params;
                    throw requestStopped;
                }
            }
        })
    });
    await assert.rejects(
        handler.handleRequest(model, modelConfig, [], options, { report() {} }, '', 'test-session', {
            isCancellationRequested: false,
            onCancellationRequested: () => ({ dispose() {} })
        }),
        error => error === requestStopped
    );
    assert.ok(requestBody);
    return requestBody;
}

function getEffort(request: ThinkingRequest): string | undefined {
    return request.reasoning_effort ?? request.reasoning?.effort ?? request.output_config?.effort;
}

for (const protocol of ['openai', 'openai-responses', 'anthropic'] as const) {
    for (const level of ['signature', 'heuristic', 'unknown'] as const) {
        test(`${protocol} 实际请求体按 ${level} 证据决定辅助思考策略，分类不进入上游`, async () => {
            const classification: RequestClassificationMetadata = {
                version: 1,
                requestOrigin: 'copilot-chat',
                agentRole: 'not-applicable',
                evidence: {
                    origin: { level: 'signature' },
                    purpose: { level },
                    role: { level }
                }
            };
            const request = await buildRequest(
                protocol,
                'chat-title',
                protocol === 'anthropic' ?
                    { reasoningEffort: 'high' }
                :   { thinking: 'enabled', reasoningEffort: 'high' },
                undefined,
                classification
            );
            assert.equal(request.thinking?.type, level === 'signature' ? 'disabled' : 'enabled');
            if (level !== 'signature') {
                assert.equal(getEffort(request), 'high');
            }
            for (const field of [
                'requestOrigin',
                'requestClassification',
                'requestContinuity',
                'evidence',
                'requestKind'
            ]) {
                assert.equal(JSON.stringify(request).includes(`"${field}"`), false);
            }
        });
    }
}

const protocols: Array<{ protocol: Protocol; extraBody: NonNullable<ModelConfig['extraBody']> }> = [
    { protocol: 'openai', extraBody: { thinking: { type: 'enabled' }, reasoning_effort: 'medium' } },
    {
        protocol: 'openai-responses',
        extraBody: { thinking: { type: 'enabled' }, reasoning: { effort: 'medium', summary: 'auto' } }
    },
    { protocol: 'anthropic', extraBody: { thinking: { type: 'enabled' }, output_config: { effort: 'medium' } } }
];

for (const requestKind of ['search-subagent', 'execution-subagent', 'subagent', 'unclassified'] as const) {
    test(`${requestKind} 保留请求分类及传入的推荐思考强度`, async () => {
        const { classifier } = await getModules();
        const mode = requestKind === 'search-subagent' ? 'Explore' : 'Execution';
        const toolName = requestKind === 'search-subagent' ? 'fetch_webpage' : 'run_in_terminal';
        const systemPrompt =
            'You are an expert AI programming assistant, working with a user in the VS Code editor.\n' +
            `<modeInstructions>\nYou are currently running in "${mode}" mode.\n</modeInstructions>`;
        const messages: vscode.LanguageModelChatMessage[] = [
            { role: 1, name: 'gcmp-system', content: [new MockTextPart(systemPrompt)] }
        ];

        if (requestKind === 'search-subagent' || requestKind === 'execution-subagent') {
            assert.equal(
                classifier.classifyRequest(messages, [{ name: toolName }] as vscode.LanguageModelChatTool[]),
                requestKind
            );
        }
        assert.equal(classifier.isSubRequest(requestKind), requestKind !== 'unclassified');
        assert.equal(classifier.shouldDisableThinkingForRequest(requestKind), false);
        assert.equal(classifier.getRecommendedReasoningEffort(requestKind, 'high'), 'high');
        assert.equal(classifier.getRecommendedReasoningEffort(requestKind, undefined), undefined);
    });

    for (const { protocol, extraBody } of protocols) {
        test(`${protocol} ${requestKind} 使用传入思考强度`, async () => {
            const settings: ModelChatResponseOptions =
                protocol === 'openai' ? { thinking: 'enabled', reasoningEffort: 'high' } : { reasoningEffort: 'high' };
            const request = await buildRequest(protocol, requestKind, settings, { extraBody });

            assert.deepEqual(request.thinking, { type: 'enabled' });
            assert.equal(getEffort(request), 'high');
        });

        test(`${protocol} ${requestKind} 未传配置时保留默认思考参数`, async () => {
            const request = await buildRequest(protocol, requestKind, undefined, { extraBody });

            assert.deepEqual(request.thinking, { type: 'enabled' });
            assert.equal(getEffort(request), 'medium');
            if (protocol === 'openai-responses') {
                assert.equal(request.reasoning?.summary, 'auto');
            }
        });

        test(`${protocol} ${requestKind} 不支持关闭思考时仍保留传入强度`, async () => {
            const settings: ModelChatResponseOptions =
                protocol === 'openai' ? { thinking: 'enabled', reasoningEffort: 'high' } : { reasoningEffort: 'high' };
            const request = await buildRequest(protocol, requestKind, settings, {
                thinking: ['enabled'],
                reasoningEffort: ['high', 'medium']
            });

            assert.deepEqual(request.thinking, { type: 'enabled' });
            assert.equal(getEffort(request), 'high');
        });

        test(`${protocol} ${requestKind} 尊重显式 reasoningEffort=none`, async () => {
            const request = await buildRequest(protocol, requestKind, { reasoningEffort: 'none' }, { extraBody });

            assert.deepEqual(request.thinking, { type: 'disabled' });
            assert.equal(getEffort(request), protocol === 'openai-responses' ? 'none' : undefined);
        });

        test(`${protocol} ${requestKind} 尊重显式 thinking=disabled`, async () => {
            const request = await buildRequest(
                protocol,
                requestKind,
                { thinking: 'disabled' },
                {
                    reasoningEffort: undefined
                }
            );

            assert.deepEqual(request.thinking, { type: 'disabled' });
        });
    }

    test(`OpenAI ${requestKind} 未传强度时使用 reasoningDefault`, async () => {
        const request = await buildRequest(
            'openai',
            requestKind,
            { thinking: 'enabled' },
            { reasoningDefault: 'high' }
        );

        assert.deepEqual(request.thinking, { type: 'enabled' });
        assert.equal(request.reasoning_effort, 'high');
    });
}

for (const requestKind of ['main-agent', 'search-subagent', 'execution-subagent'] as const) {
    test(`Responses ${requestKind} 实际 GPT 模型使用别名时不传 thinking`, async () => {
        const request = await buildRequest(
            'openai-responses',
            requestKind,
            { reasoningEffort: 'high' },
            {
                id: 'review-codex',
                model: 'GPT-5.4',
                reasoningEffort: ['high', 'medium', 'low'],
                extraBody: { reasoning: { summary: 'auto' } }
            }
        );

        assert.equal(request.model, 'GPT-5.4');
        assert.equal(request.thinking, undefined);
        assert.equal(request.reasoning?.effort, 'high');
        assert.equal(request.reasoning?.summary, 'auto');
    });

    test(`Responses ${requestKind} 非 GPT 模型不因别名包含 gpt 而移除 thinking`, async () => {
        const request = await buildRequest(
            'openai-responses',
            requestKind,
            { reasoningEffort: 'high' },
            { id: 'gpt-alias', model: 'reasoning-model' }
        );

        assert.equal(request.model, 'reasoning-model');
        assert.deepEqual(request.thinking, { type: 'enabled' });
        assert.equal(request.reasoning?.effort, 'high');
    });

    for (const thinkingFormat of ['boolean', 'boolean-none', undefined] as const) {
        for (const reasoningFormat of ['flat', 'nested'] as const) {
            test(`OpenAI ${requestKind} ${thinkingFormat ?? '默认 boolean'}/${reasoningFormat} 显式 none 关闭思考`, async () => {
                const request = await buildRequest(
                    'openai',
                    requestKind,
                    { reasoningEffort: 'none' },
                    { thinkingFormat, reasoningFormat, extraBody: { enable_thinking: true } }
                );

                assert.equal(request.enable_thinking, false);
                assert.equal(request.thinking, undefined);
                assert.equal(request.reasoning_effort, undefined);
                assert.equal(request.reasoning, undefined);
            });

            test(`OpenAI ${requestKind} ${thinkingFormat ?? '默认 boolean'}/${reasoningFormat} 保留 high 强度`, async () => {
                const request = await buildRequest(
                    'openai',
                    requestKind,
                    { reasoningEffort: 'high' },
                    { thinkingFormat, reasoningFormat }
                );

                assert.equal(request.enable_thinking, thinkingFormat === 'boolean-none' ? undefined : true);
                assert.equal(request.thinking, undefined);
                if (reasoningFormat === 'nested') {
                    assert.deepEqual(request.reasoning, { effort: 'high' });
                    assert.equal(request.reasoning_effort, undefined);
                } else {
                    assert.equal(request.reasoning_effort, 'high');
                    assert.equal(request.reasoning, undefined);
                }
            });
        }
    }

    for (const reasoningFormat of ['flat', 'nested'] as const) {
        const reasoningOnlyConfig: Partial<ModelConfig> = {
            id: 'gpt-5.4',
            thinking: undefined,
            thinkingFormat: undefined,
            reasoningFormat
        };

        for (const reasoningEffort of ['none', 'high'] as const) {
            test(`OpenAI ${requestKind} ${reasoningFormat} 仅配置推理强度时原样传递 ${reasoningEffort}`, async () => {
                const request = await buildRequest('openai', requestKind, { reasoningEffort }, reasoningOnlyConfig);

                assert.equal(request.enable_thinking, undefined);
                assert.equal(request.thinking, undefined);
                if (reasoningFormat === 'nested') {
                    assert.deepEqual(request.reasoning, { effort: reasoningEffort });
                    assert.equal(request.reasoning_effort, undefined);
                } else {
                    assert.equal(request.reasoning_effort, reasoningEffort);
                    assert.equal(request.reasoning, undefined);
                }
            });
        }

        test(`OpenAI ${requestKind} ${reasoningFormat} 原生默认 none 不注入布尔开关`, async () => {
            const request = await buildRequest(
                'openai',
                requestKind,
                {},
                { ...reasoningOnlyConfig, reasoningDefault: 'none' }
            );

            assert.equal(request.enable_thinking, undefined);
            assert.equal(request.thinking, undefined);
            assert.equal(getEffort(request), 'none');
        });

        test(`OpenAI ${requestKind} ${reasoningFormat} 仅声明 boolean 格式时 none 仍关闭开关`, async () => {
            const request = await buildRequest(
                'openai',
                requestKind,
                { reasoningEffort: 'none' },
                { ...reasoningOnlyConfig, thinkingFormat: 'boolean' }
            );

            assert.equal(request.enable_thinking, false);
            assert.equal(request.thinking, undefined);
            assert.equal(getEffort(request), undefined);
        });

        for (const enableThinking of [true, false]) {
            test(`OpenAI ${requestKind} ${reasoningFormat} none 覆盖已有布尔开关 ${enableThinking}`, async () => {
                const request = await buildRequest(
                    'openai',
                    requestKind,
                    { reasoningEffort: 'none' },
                    { ...reasoningOnlyConfig, extraBody: { enable_thinking: enableThinking } }
                );

                assert.equal(request.enable_thinking, false);
                assert.equal(request.thinking, undefined);
                assert.equal(getEffort(request), undefined);
            });
        }
    }
}

test('其他辅助请求继续推荐关闭思考，主请求保持用户强度', async () => {
    const { classifier } = await getModules();

    for (const kind of ['summarization', 'chat-title', 'git-commit-message'] as const) {
        assert.equal(classifier.shouldDisableThinkingForRequest(kind), true);
        assert.equal(classifier.getRecommendedReasoningEffort(kind, 'high'), 'none');
    }
    for (const kind of ['main-agent', 'terminal-steering', 'background', 'unknown', undefined] as const) {
        assert.equal(classifier.shouldDisableThinkingForRequest(kind), false);
    }
    assert.equal(classifier.getRecommendedReasoningEffort('main-agent', 'high'), 'high');
});

for (const level of ['contract', 'signature', 'heuristic', 'unknown'] satisfies EvidenceLevel[]) {
    for (const agentRole of ['main', 'subagent', 'undetermined', 'not-applicable'] satisfies AgentRole[]) {
        test(`用途证据 ${level}/${agentRole} 仅强辅助任务可自动关闭思考`, async () => {
            const { classifier } = await getModules();
            const metadata: RequestClassificationMetadata = {
                version: 1,
                requestOrigin: 'copilot-chat',
                agentRole,
                evidence: {
                    origin: { level: 'contract' },
                    purpose: { level },
                    role: { level: 'signature' }
                }
            };
            const expected = (level === 'contract' || level === 'signature') && agentRole === 'not-applicable';
            for (const kind of ['summarization', 'chat-title', 'git-commit-message', 'todo-tracker'] as const) {
                assert.equal(classifier.shouldDisableThinkingForRequest(kind, metadata), expected);
                assert.equal(
                    classifier.getRecommendedReasoningEffort(kind, 'high', metadata),
                    expected ? 'none' : 'high'
                );
                assert.equal(
                    classifier.getRecommendedReasoningEffort(kind, undefined, metadata),
                    expected ? 'none' : undefined
                );
            }
        });
    }
}

test('高等级 metadata 不能使主请求、子代理和未分类请求自动关闭思考', async () => {
    const { classifier } = await getModules();
    const metadata: RequestClassificationMetadata = {
        version: 1,
        requestOrigin: 'gcmp',
        agentRole: 'not-applicable',
        evidence: {
            origin: { level: 'contract' },
            purpose: { level: 'contract' },
            role: { level: 'contract' }
        }
    };
    for (const kind of [
        'main-agent',
        'terminal-steering',
        'subagent',
        'search-subagent',
        'execution-subagent',
        'unclassified',
        'background',
        'unknown'
    ] as const) {
        assert.equal(classifier.shouldDisableThinkingForRequest(kind, metadata), false);
        assert.equal(classifier.getRecommendedReasoningEffort(kind, 'high', metadata), 'high');
    }
    assert.equal(classifier.shouldDisableThinkingForRequest(undefined, metadata), false);
});

for (const reasonCode of [
    'classification-conflict',
    'extraction-budget-exceeded',
    'extraction-failed',
    'classification-failed'
]) {
    test(`降级原因 ${reasonCode} 阻止遗留强用途证据关闭思考`, async () => {
        const { classifier } = await getModules();
        for (const level of ['signature', 'contract'] as const) {
            const metadata: RequestClassificationMetadata = {
                version: 1,
                requestOrigin: 'copilot-chat',
                agentRole: 'not-applicable',
                evidence: {
                    origin: { level: 'signature' },
                    purpose: { level, reasonCode },
                    role: { level }
                }
            };
            assert.equal(classifier.shouldDisableThinkingForRequest('chat-title', metadata), false);
            assert.equal(classifier.getRecommendedReasoningEffort('chat-title', 'high', metadata), 'high');
        }
    });
}

test('实际分类的弱单工具和 SDK 来源均保留思考，旧用途签名与 GCMP 契约允许关闭', async () => {
    const { classifier } = await getModules();
    const weak = classifier.classifyRequestContext([], {
        requestInitiator: 'github.copilot-chat',
        tools: [{ name: 'manage_todo_list', description: '', inputSchema: {} }]
    });
    const sdk = classifier.classifyRequestContext([
        {
            role: 1,
            name: 'gcmp-system',
            content: [new MockTextPart('You are an AI assistant using Copilot SDK in VS Code.')]
        }
    ]);
    for (const classification of [weak, sdk]) {
        assert.equal(classifier.shouldDisableThinkingForRequest(classification.requestKind, classification), false);
        assert.equal(
            classifier.getRecommendedReasoningEffort(classification.requestKind, 'high', classification),
            'high'
        );
    }
    const title = classifier.classifyRequestContext([
        { role: 1, name: 'gcmp-system', content: [new MockTextPart('You are an expert in crafting pithy titles')] }
    ]);
    assert.equal(title.evidence.purpose.level, 'signature');
    const commit = classifier.classifyRequestContext([], {
        requestInitiator: 'vicanent.gcmp',
        modelOptions: { requestKind: 'git-commit-message' }
    });
    assert.equal(commit.evidence.purpose.level, 'contract');
    for (const classification of [title, commit]) {
        assert.equal(classifier.shouldDisableThinkingForRequest(classification.requestKind, classification), true);
        assert.equal(
            classifier.getRecommendedReasoningEffort(classification.requestKind, 'high', classification),
            'none'
        );
    }
});

for (const { protocol } of protocols) {
    test(`${protocol} 摘要请求仍自动关闭思考`, async () => {
        const settings: ModelChatResponseOptions =
            protocol === 'openai' ? { thinking: 'enabled', reasoningEffort: 'high' } : { reasoningEffort: 'high' };
        const request = await buildRequest(protocol, 'summarization', settings);

        assert.deepEqual(request.thinking, { type: 'disabled' });
        assert.equal(getEffort(request), protocol === 'openai-responses' ? 'none' : undefined);
    });
}

for (const { protocol } of protocols) {
    for (const requestKind of ['main-agent', 'summarization', 'git-commit-message'] as const) {
        for (const settings of [{ thinking: 'enabled' }, { reasoningEffort: 'high' }] as const) {
            test(`${protocol} ${requestKind} extraBody.thinking=null 清除 ${JSON.stringify(settings)} 生成的字段`, async () => {
                const request = await buildRequest(protocol, requestKind, settings, { extraBody: { thinking: null } });

                assert.equal(Object.hasOwn(request, 'thinking'), false);
            });
        }
    }

    const effortField =
        protocol === 'openai' ? 'reasoning_effort'
        : protocol === 'openai-responses' ? 'reasoning'
        : 'output_config';
    test(`${protocol} extraBody.${effortField}=null 清除 UI 生成的推理字段`, async () => {
        const request = await buildRequest(
            protocol,
            'main-agent',
            { reasoningEffort: 'high' },
            { extraBody: { [effortField]: null } }
        );

        assert.equal(Object.hasOwn(request, effortField), false);
        assert.deepEqual(request.thinking, { type: 'enabled' });
    });

    test(`${protocol} 未传 UI 配置时 null 仍删除默认字段，但保留核心参数`, async () => {
        const request = await buildRequest(protocol, 'main-agent', undefined, {
            extraBody: {
                model: null,
                messages: null,
                input: null,
                stream: null,
                tools: null,
                max_tokens: null,
                metadata: null,
                prompt_cache_key: null
            }
        });

        assert.equal(request.model, 'reasoning-model');
        assert.equal(Object.hasOwn(request, protocol === 'openai-responses' ? 'input' : 'messages'), true);
        assert.equal(Object.hasOwn(request, 'stream'), true);
        for (const key of ['max_tokens', 'metadata', 'prompt_cache_key']) {
            assert.equal(Object.hasOwn(request, key), false, key);
        }
    });

    test(`${protocol} null 清理不改变 false、0、空字符串或嵌套值`, async () => {
        const extraBody = {
            parallel_tool_calls: false,
            temperature: 0,
            user: '',
            custom: { value: null },
            tags: [null, 'tag']
        };
        const snapshot = structuredClone(extraBody);
        const request = await buildRequest(protocol, 'main-agent', undefined, { extraBody });

        for (const [key, value] of Object.entries(extraBody)) {
            assert.deepEqual(Reflect.get(request, key), value);
        }
        assert.deepEqual(extraBody, snapshot);
    });
}

for (const thinkingFormat of ['boolean', 'boolean-none'] as const) {
    for (const requestKind of ['main-agent', 'summarization', 'git-commit-message'] as const) {
        test(`OpenAI ${requestKind} ${thinkingFormat} extraBody.enable_thinking=null 清除自动生成的开关`, async () => {
            const request = await buildRequest(
                'openai',
                requestKind,
                { thinking: 'enabled', reasoningEffort: 'high' },
                { thinkingFormat, extraBody: { enable_thinking: null } }
            );

            assert.equal(Object.hasOwn(request, 'enable_thinking'), false);
        });
    }
}

test('Responses extraBody.include=null 在最终请求中不存在且不恢复自动 include', async () => {
    const request = await buildRequest(
        'openai-responses',
        'main-agent',
        { reasoningEffort: 'high' },
        {
            id: 'gpt-5.4',
            extraBody: { include: null }
        }
    );

    assert.equal(Object.hasOwn(request, 'include'), false);
    assert.equal(request.reasoning?.effort, 'high');
});

for (const protocol of ['openai', 'openai-responses', 'anthropic'] as const) {
    test(`${protocol}: SDK 弱摘要标签不改变思考与原生工具`, async () => {
        const { classifier } = await getModules();
        const input = [
            { role: 0, content: [{ value: SDK_MAIN }] },
            { role: 1, content: [{ value: SDK_COMPACTION }] }
        ] as unknown as vscode.LanguageModelChatMessage[];
        const classification = classifier.classifyRequestContext(input, { requestInitiator: 'core' });
        const request = await buildRequest(
            protocol,
            'summarization',
            { reasoningEffort: 'high', thinking: 'enabled' },
            { nativeTools: [{ type: 'web_search' }] },
            classification
        );
        assert.equal(classifier.shouldDisableThinkingForRequest('summarization', classification), false);
        if (protocol === 'openai-responses') {
            assert.equal(
                request.tools?.some(tool => tool.type === 'web_search'),
                true
            );
            assert.equal(request.reasoning?.effort, 'high');
        } else if (protocol === 'openai') {
            assert.equal(request.reasoning_effort, 'high');
        } else {
            assert.equal(request.thinking?.type, 'enabled');
        }
    });
}

for (const requestKind of [
    'main-agent',
    'unclassified',
    'background',
    'subagent',
    'search-subagent',
    'execution-subagent'
] as const) {
    test(`Responses ${requestKind} 原生工具限制与思考策略分离`, async () => {
        const request = await buildRequest(
            'openai-responses',
            requestKind,
            { reasoningEffort: 'high' },
            { nativeTools: [{ type: 'web_search' }] }
        );
        const subagent =
            requestKind === 'subagent' || requestKind === 'search-subagent' || requestKind === 'execution-subagent';
        assert.equal(request.tools?.some(tool => tool.type === 'web_search') ?? false, !subagent);
        assert.equal(request.reasoning?.effort, 'high');
    });
}
