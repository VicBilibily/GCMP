import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import test from 'node:test';
import type { ModelChatResponseOptions, ModelConfig } from '../../types/sharedTypes';

const require = createRequire(import.meta.url);
const NodeModule = require('node:module') as {
    prototype: {
        require: (id: string) => unknown;
    };
};

const vscodeMock = {
    LanguageModelChatMessageRole: { Assistant: 'assistant', System: 'system', User: 'user' },
    LanguageModelThinkingPart: class {
        constructor(public value: string | string[]) {}
    },
    LanguageModelTextPart: class {
        constructor(public value: string) {}
    }
};

let builderModulePromise:
    | Promise<{
          applyResponsesSystemMessage: typeof import('./openaiResponsesRequestBuilder').applyResponsesSystemMessage;
          initializeResponsesRequestBody: typeof import('./openaiResponsesRequestBuilder').initializeResponsesRequestBody;
          OpenAIResponsesRequestBuilder: typeof import('./openaiResponsesRequestBuilder').OpenAIResponsesRequestBuilder;
          OpenAIResponsesMessageConverter: typeof import('./openaiResponsesMessageConverter').OpenAIResponsesMessageConverter;
      }>
    | undefined;

async function getBuilderModule() {
    if (builderModulePromise) {
        return builderModulePromise;
    }

    const originalRequire = NodeModule.prototype.require;
    NodeModule.prototype.require = function (id: string): unknown {
        if (id === 'vscode') {
            return vscodeMock;
        }
        if (id.endsWith('/utils/runtime/logger')) {
            return { Logger: { trace() {}, debug() {}, info() {}, warn() {}, error() {} } };
        }
        return originalRequire.call(this, id);
    };

    builderModulePromise = import('./openaiResponsesRequestBuilder')
        .then(async builder => ({ ...builder, ...(await import('./openaiResponsesMessageConverter')) }))
        .finally(() => {
            NodeModule.prototype.require = originalRequire;
        });

    return builderModulePromise;
}

test('初始化 Responses request 时默认注入 prompt_cache_key', async () => {
    const { initializeResponsesRequestBody } = await getBuilderModule();
    const input = [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: 'hello' }] }];

    const requestBody = initializeResponsesRequestBody({
        requestModel: 'glm-5-2-260617',
        input: input as never,
        sessionId: 'session-123'
    });

    assert.equal(requestBody.prompt_cache_key, 'session-123');
    assert.equal(requestBody.model, 'glm-5-2-260617');
    assert.equal(requestBody.stream, true);
    assert.equal(requestBody.input, input);
});

for (const useWebSocket of [true, false, undefined]) {
    for (const parallelToolCalls of [undefined, true, false, null]) {
        test(`WS-LOOP-01: parallel_tool_calls=${parallelToolCalls} with useWebSocket=${useWebSocket}`, async () => {
            const { OpenAIResponsesRequestBuilder } = await getBuilderModule();
            const tool = {
                type: 'function',
                name: 'lookup',
                parameters: { type: 'object', properties: {} }
            };
            const builder = new OpenAIResponsesRequestBuilder('Test Provider', {
                convertMessagesToOpenAIResponses: () => ({ systemMessage: '', messages: [] }),
                convertToolsToResponses: () => [tool]
            } as never);
            const extraBody = Object.freeze(
                parallelToolCalls === undefined ? {} : { parallel_tool_calls: parallelToolCalls }
            );
            for (const hasTools of [false, true]) {
                const { requestBody } = builder.build({
                    model: { id: 'model-id', name: 'Model' } as never,
                    modelConfig: {
                        id: 'model-id',
                        sdkMode: 'openai-responses',
                        useWebSocket,
                        extraBody
                    } as never,
                    messages: [],
                    options: { tools: hasTools ? [{ name: 'lookup' }] : [] } as never,
                    sessionId: 'session-123'
                });
                assert.equal(requestBody.parallel_tool_calls, parallelToolCalls ?? undefined);
                assert.equal(Object.hasOwn(requestBody, 'parallel_tool_calls'), typeof parallelToolCalls === 'boolean');
                assert.equal(Object.hasOwn(requestBody, 'tools'), hasTools);
            }
            assert.deepEqual(
                extraBody,
                parallelToolCalls === undefined ? {} : { parallel_tool_calls: parallelToolCalls }
            );
        });
    }
}

test('GPT + extraBody.reasoning 时注入 encrypted reasoning include', async () => {
    const { initializeResponsesRequestBody } = await getBuilderModule();
    const requestBody = initializeResponsesRequestBody({
        requestModel: 'gpt-5.4',
        input: [] as never,
        sessionId: 'session-123',
        extraBody: { reasoning: { effort: 'medium' } }
    });

    assert.deepEqual(requestBody.include, ['reasoning.encrypted_content']);
});

test('extraBody 显式定义 include 时不再自动注入（null）', async () => {
    const { initializeResponsesRequestBody } = await getBuilderModule();
    const requestBody = initializeResponsesRequestBody({
        requestModel: 'gpt-5.4',
        input: [] as never,
        sessionId: 'session-123',
        extraBody: { reasoning: { effort: 'medium' }, include: null }
    });

    assert.equal('include' in requestBody, false);
});

test('extraBody 显式定义 include 时不再自动注入（空数组）', async () => {
    const { initializeResponsesRequestBody } = await getBuilderModule();
    const requestBody = initializeResponsesRequestBody({
        requestModel: 'gpt-5.4',
        input: [] as never,
        sessionId: 'session-123',
        extraBody: { reasoning: { effort: 'medium' }, include: [] }
    });

    assert.equal('include' in requestBody, false);
});

test('Responses extraBody 递归替换 sessionId 占位符', async () => {
    const { OpenAIResponsesRequestBuilder } = await getBuilderModule();
    const builder = new OpenAIResponsesRequestBuilder('Test Provider', {
        convertMessagesToOpenAIResponses: () => ({ systemMessage: '', messages: [] }),
        convertToolsToResponses: () => [],
        filterExtraBodyParams: (extraBody: Record<string, unknown>) => extraBody
    } as never);

    const { requestBody } = builder.build({
        model: { id: 'model-id', name: 'Model' } as never,
        modelConfig: {
            id: 'model-id',
            extraBody: { metadata: { session: '${SESSIONID}' }, tags: ['${session_id}'] }
        } as never,
        messages: [],
        options: {} as never,
        sessionId: 'session-123'
    });

    assert.deepEqual(requestBody.metadata, { session: 'session-123' });
    assert.deepEqual(requestBody.tags, ['session-123']);
});

test('useInstructions=true 时通过 instructions 传递 system message', async () => {
    const { applyResponsesSystemMessage } = await getBuilderModule();
    const requestBody: Record<string, unknown> = {};
    const input = [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: 'question' }] }];

    applyResponsesSystemMessage({
        requestBody,
        responsesMessages: input as never,
        systemMessage: 'system rules',
        useInstructions: true
    });

    assert.equal(requestBody.instructions, 'system rules');
    assert.equal(input.length, 1);
});

for (const requestModel of ['gpt-6.2-sol', 'gpt-6.2-astra', 'gpt-6.2-sol-2026-11-18', 'gpt-6.1-sol', 'o1']) {
    for (const useInstructions of [true, false, undefined]) {
        test(`${requestModel} useRoleDeveloper=true 优先于 useInstructions=${useInstructions}`, async () => {
            const { applyResponsesSystemMessage } = await getBuilderModule();
            const requestBody: Record<string, unknown> = { model: requestModel, instructions: 'stale' };
            const question = { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'question' }] };
            const input = [question];

            applyResponsesSystemMessage({
                requestBody,
                responsesMessages: input as never,
                systemMessage: 'system rules',
                useInstructions,
                useRoleDeveloper: true
            });

            assert.equal(Object.hasOwn(requestBody, 'instructions'), false);
            assert.equal(input.length, 2);
            assert.deepEqual(input[0], {
                type: 'message',
                role: 'developer',
                content: [{ type: 'input_text', text: 'system rules' }]
            });
            assert.equal(input[1], question);
        });
    }
}

for (const requestModel of ['gpt-6.2-sol', 'gpt-6.1-sol', 'gpt-6.20-sol', 'gpt-6.3-sol', 'glm-5.3']) {
    for (const useRoleDeveloper of [false, undefined]) {
        test(`${requestModel} useRoleDeveloper=${useRoleDeveloper} 保留顶层 instructions`, async () => {
            const { applyResponsesSystemMessage } = await getBuilderModule();
            const requestBody: Record<string, unknown> = { model: requestModel };
            const input: never[] = [];

            applyResponsesSystemMessage({
                requestBody,
                responsesMessages: input,
                systemMessage: 'system rules',
                useInstructions: true,
                useRoleDeveloper
            });

            assert.equal(requestBody.instructions, 'system rules');
            assert.deepEqual(input, []);
        });
    }
}

for (const useInstructions of [false, undefined]) {
    for (const useRoleDeveloper of [false, undefined]) {
        test(`6.2 useInstructions=${useInstructions}, useRoleDeveloper=${useRoleDeveloper} 保留 user 消息`, async () => {
            const { applyResponsesSystemMessage } = await getBuilderModule();
            const requestBody: Record<string, unknown> = { model: 'gpt-6.2-sol' };
            const input: unknown[] = [];

            applyResponsesSystemMessage({
                requestBody,
                responsesMessages: input as never,
                systemMessage: 'system rules',
                useInstructions,
                useRoleDeveloper
            });

            assert.equal(requestBody.instructions, undefined);
            assert.deepEqual(input, [
                { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'system rules' }] }
            ]);
        });
    }
}

test('6.2 空系统指令不新增消息，也不移除已有当次 instructions', async () => {
    const { applyResponsesSystemMessage } = await getBuilderModule();
    const requestBody: Record<string, unknown> = { model: 'gpt-6.2-sol', instructions: 'turn guidance' };
    const input: never[] = [];

    applyResponsesSystemMessage({
        requestBody,
        responsesMessages: input,
        systemMessage: '',
        useInstructions: true,
        useRoleDeveloper: true
    });

    assert.equal(requestBody.instructions, 'turn guidance');
    assert.deepEqual(input, []);
});

for (const requestModel of ['gpt-6.2-sol', 'gpt-6.1-sol']) {
    for (const instructions of [undefined, 'turn guidance', null]) {
        test(`${requestModel} 完整构造按显式开关前置 developer，保留当次 instructions=${instructions}`, async () => {
            const { OpenAIResponsesRequestBuilder } = await getBuilderModule();
            const question = { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'question' }] };
            const sourceMessages = Object.freeze([question]);
            const builder = new OpenAIResponsesRequestBuilder(
                'Codex',
                {
                    convertMessagesToOpenAIResponses: () => ({
                        systemMessage: 'stable rules',
                        messages: [...sourceMessages]
                    }),
                    convertToolsToResponses: () => []
                } as never,
                'codex'
            );
            const extraBody = Object.freeze(instructions === undefined ? {} : { instructions });
            const { requestBody } = builder.build({
                model: { id: 'display-alias', name: 'Model' } as never,
                modelConfig: {
                    id: 'display-alias',
                    model: requestModel,
                    sdkMode: 'openai-responses',
                    useInstructions: true,
                    useRoleDeveloper: true,
                    extraBody
                } as never,
                messages: [],
                options: {} as never,
                sessionId: 'session-123'
            });

            assert.equal(requestBody.model, requestModel);
            assert.equal(requestBody.instructions, typeof instructions === 'string' ? instructions : undefined);
            assert.equal(Object.hasOwn(requestBody, 'instructions'), typeof instructions === 'string');
            assert.equal(requestBody.prompt_cache_key, 'session-123');
            assert.deepEqual(requestBody.input, [
                { type: 'message', role: 'developer', content: [{ type: 'input_text', text: 'stable rules' }] },
                question
            ]);
            assert.deepEqual(sourceMessages, [question]);
            assert.deepEqual(extraBody, instructions === undefined ? {} : { instructions });
        });
    }
}

test('useInstructions=false 时将 system message 注入首条 user input', async () => {
    const { applyResponsesSystemMessage } = await getBuilderModule();
    const requestBody: Record<string, unknown> = { instructions: 'stale' };
    const input = [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: 'question' }] }];

    applyResponsesSystemMessage({
        requestBody,
        responsesMessages: input as never,
        systemMessage: 'system rules',
        useInstructions: false
    });

    assert.equal(requestBody.instructions, undefined);
    assert.equal(input.length, 2);
    assert.deepEqual(input[0], {
        type: 'message',
        role: 'user',
        content: [{ type: 'input_text', text: 'system rules' }]
    });
});

test('子代理保留思考时不注入 nativeTools，但保留显式声明 tools', async () => {
    const { OpenAIResponsesRequestBuilder } = await getBuilderModule();
    const declaredTool = {
        type: 'function',
        name: 'declared_tool',
        description: 'declared tool',
        parameters: {
            type: 'object',
            properties: {},
            required: []
        },
        strict: false
    };
    const builder = new OpenAIResponsesRequestBuilder('Test Provider', {
        convertMessagesToOpenAIResponses: () => ({ systemMessage: '', messages: [] }),
        convertToolsToResponses: () => [declaredTool],
        filterExtraBodyParams: (extraBody: Record<string, unknown>) => extraBody
    } as never);

    for (const requestKind of ['search-subagent', 'execution-subagent']) {
        const { requestBody } = builder.build({
            model: { id: 'gpt-5', name: 'GPT-5' } as never,
            modelConfig: {
                id: 'gpt-5',
                name: 'GPT-5',
                tooltip: 'GPT-5',
                maxInputTokens: 1000,
                maxOutputTokens: 1000,
                capabilities: { toolCalling: true, imageInput: false },
                sdkMode: 'openai-responses',
                reasoningEffort: ['high', 'none'],
                webSearchTool: true,
                nativeTools: [{ type: 'web_extractor' }]
            } as never,
            messages: [],
            options: {
                tools: [{ name: 'declared_tool' }],
                modelConfiguration: { reasoningEffort: 'high' },
                modelOptions: { requestKind }
            } as never,
            sessionId: 'session-123'
        });

        assert.deepEqual(requestBody.tools, [declaredTool]);
        assert.deepEqual(requestBody.reasoning, { effort: 'high' });
    }
});

test('模型不支持关闭思考时子请求省略 thinking/reasoning', async () => {
    const { OpenAIResponsesRequestBuilder } = await getBuilderModule();
    const builder = new OpenAIResponsesRequestBuilder('Test Provider', {
        convertMessagesToOpenAIResponses: () => ({ systemMessage: '', messages: [] }),
        convertToolsToResponses: () => [],
        filterExtraBodyParams: (extraBody: Record<string, unknown>) => extraBody
    } as never);

    const { requestBody } = builder.build({
        model: { id: 'glm-5.3', name: 'GLM-5.3' } as never,
        modelConfig: {
            id: 'glm-5.3',
            name: 'GLM-5.3',
            tooltip: 'GLM-5.3',
            maxInputTokens: 1000,
            maxOutputTokens: 1000,
            capabilities: { toolCalling: true, imageInput: false },
            sdkMode: 'openai-responses',
            reasoningEffort: ['high', 'max', 'low']
        } as never,
        messages: [],
        options: {
            modelConfiguration: { reasoningEffort: 'max' },
            modelOptions: { requestKind: 'summarization' }
        } as never,
        sessionId: 'session-123'
    });

    assert.equal(requestBody.thinking, undefined);
    assert.equal(requestBody.reasoning, undefined);
});

test('支持关闭思考的模型子请求降级为 disabled 与最低 effort', async () => {
    const { OpenAIResponsesRequestBuilder } = await getBuilderModule();
    const builder = new OpenAIResponsesRequestBuilder('Test Provider', {
        convertMessagesToOpenAIResponses: () => ({ systemMessage: '', messages: [] }),
        convertToolsToResponses: () => [],
        filterExtraBodyParams: (extraBody: Record<string, unknown>) => extraBody
    } as never);

    const { requestBody } = builder.build({
        model: { id: 'glm-5.2', name: 'GLM-5.2' } as never,
        modelConfig: {
            id: 'glm-5.2',
            name: 'GLM-5.2',
            tooltip: 'GLM-5.2',
            maxInputTokens: 1000,
            maxOutputTokens: 1000,
            capabilities: { toolCalling: true, imageInput: false },
            sdkMode: 'openai-responses',
            reasoningEffort: ['high', 'max', 'none']
        } as never,
        messages: [],
        options: {
            modelConfiguration: { reasoningEffort: 'max' },
            modelOptions: { requestKind: 'summarization' }
        } as never,
        sessionId: 'session-123'
    });

    assert.deepEqual(requestBody.thinking, { type: 'disabled' });
    assert.deepEqual(requestBody.reasoning, { effort: 'none' });
});

test('effort-only 模式仅传递 reasoning，不带 thinking', async () => {
    const { OpenAIResponsesRequestBuilder } = await getBuilderModule();
    const builder = new OpenAIResponsesRequestBuilder('Test Provider', {
        convertMessagesToOpenAIResponses: () => ({ systemMessage: '', messages: [] }),
        convertToolsToResponses: () => [],
        filterExtraBodyParams: (extraBody: Record<string, unknown>) => extraBody
    } as never);

    const { requestBody } = builder.build({
        model: { id: 'muse-spark-1.2-contributor', name: 'Muse Spark' } as never,
        modelConfig: {
            id: 'muse-spark-1.2-contributor-go',
            name: 'Muse Spark 1.2 Contributor (Go)',
            tooltip: 'Muse Spark',
            maxInputTokens: 1000,
            maxOutputTokens: 1000,
            capabilities: { toolCalling: true, imageInput: false },
            sdkMode: 'openai-responses',
            thinkingFormat: 'effort-only',
            reasoningEffort: ['high', 'xhigh', 'medium', 'low', 'none']
        } as never,
        messages: [],
        options: { modelConfiguration: { reasoningEffort: 'xhigh' } } as never,
        sessionId: 'session-123'
    });

    assert.deepEqual(requestBody.reasoning, { effort: 'xhigh' });
    assert.equal(requestBody.thinking, undefined);
    assert.equal(requestBody.enable_thinking, undefined);
});

test('effort-only 模式 reasoningEffort=none 原样传递，不映射 thinking', async () => {
    const { OpenAIResponsesRequestBuilder } = await getBuilderModule();
    const builder = new OpenAIResponsesRequestBuilder('Test Provider', {
        convertMessagesToOpenAIResponses: () => ({ systemMessage: '', messages: [] }),
        convertToolsToResponses: () => [],
        filterExtraBodyParams: (extraBody: Record<string, unknown>) => extraBody
    } as never);

    const { requestBody } = builder.build({
        model: { id: 'muse-spark-1.2-contributor', name: 'Muse Spark' } as never,
        modelConfig: {
            id: 'muse-spark-1.2-contributor-go',
            name: 'Muse Spark 1.2 Contributor (Go)',
            tooltip: 'Muse Spark',
            maxInputTokens: 1000,
            maxOutputTokens: 1000,
            capabilities: { toolCalling: true, imageInput: false },
            sdkMode: 'openai-responses',
            thinkingFormat: 'effort-only',
            reasoningEffort: ['high', 'xhigh', 'medium', 'low', 'none']
        } as never,
        messages: [],
        options: { modelConfiguration: { reasoningEffort: 'none' } } as never,
        sessionId: 'session-123'
    });

    assert.deepEqual(requestBody.reasoning, { effort: 'none' });
    assert.equal(requestBody.thinking, undefined);
    assert.equal(requestBody.enable_thinking, undefined);
});

test('effort-only 模式子请求仍原样保留 reasoningEffort', async () => {
    const { OpenAIResponsesRequestBuilder } = await getBuilderModule();
    const builder = new OpenAIResponsesRequestBuilder('Test Provider', {
        convertMessagesToOpenAIResponses: () => ({ systemMessage: '', messages: [] }),
        convertToolsToResponses: () => [],
        filterExtraBodyParams: (extraBody: Record<string, unknown>) => extraBody
    } as never);

    const { requestBody } = builder.build({
        model: { id: 'muse-spark-1.2-contributor', name: 'Muse Spark' } as never,
        modelConfig: {
            id: 'muse-spark-1.2-contributor-go',
            name: 'Muse Spark 1.2 Contributor (Go)',
            tooltip: 'Muse Spark',
            maxInputTokens: 1000,
            maxOutputTokens: 1000,
            capabilities: { toolCalling: true, imageInput: false },
            sdkMode: 'openai-responses',
            thinkingFormat: 'effort-only',
            reasoningEffort: ['high', 'xhigh', 'medium', 'low', 'none']
        } as never,
        messages: [],
        options: {
            modelConfiguration: { reasoningEffort: 'xhigh' },
            modelOptions: { requestKind: 'summarization' }
        } as never,
        sessionId: 'session-123'
    });

    assert.deepEqual(requestBody.reasoning, { effort: 'xhigh' });
    assert.equal(requestBody.thinking, undefined);
});

test('effort-only 模式合并 extraBody.reasoning 的其他字段，仅覆盖 effort', async () => {
    const { OpenAIResponsesRequestBuilder } = await getBuilderModule();
    const builder = new OpenAIResponsesRequestBuilder('Test Provider', {
        convertMessagesToOpenAIResponses: () => ({ systemMessage: '', messages: [] }),
        convertToolsToResponses: () => [],
        filterExtraBodyParams: (extraBody: Record<string, unknown>) => extraBody
    } as never);

    const { requestBody } = builder.build({
        model: { id: 'muse-spark-1.2-contributor', name: 'Muse Spark' } as never,
        modelConfig: {
            id: 'muse-spark-1.2-contributor-go',
            name: 'Muse Spark 1.2 Contributor (Go)',
            tooltip: 'Muse Spark',
            maxInputTokens: 1000,
            maxOutputTokens: 1000,
            capabilities: { toolCalling: true, imageInput: false },
            sdkMode: 'openai-responses',
            thinkingFormat: 'effort-only',
            reasoningEffort: ['high', 'xhigh', 'medium', 'low', 'none'],
            extraBody: { reasoning: { effort: 'low', summary: 'auto' } }
        } as never,
        messages: [],
        options: { modelConfiguration: { reasoningEffort: 'xhigh' } } as never,
        sessionId: 'session-123'
    });

    assert.deepEqual(requestBody.reasoning, { effort: 'xhigh', summary: 'auto' });
});

test('effort-only 模式清除 extraBody 注入的 thinking 参数', async () => {
    const { OpenAIResponsesRequestBuilder } = await getBuilderModule();
    const builder = new OpenAIResponsesRequestBuilder('Test Provider', {
        convertMessagesToOpenAIResponses: () => ({ systemMessage: '', messages: [] }),
        convertToolsToResponses: () => [],
        filterExtraBodyParams: (extraBody: Record<string, unknown>) => extraBody
    } as never);

    const { requestBody } = builder.build({
        model: { id: 'muse-spark-1.2-contributor', name: 'Muse Spark' } as never,
        modelConfig: {
            id: 'muse-spark-1.2-contributor-go',
            name: 'Muse Spark 1.2 Contributor (Go)',
            tooltip: 'Muse Spark',
            maxInputTokens: 1000,
            maxOutputTokens: 1000,
            capabilities: { toolCalling: true, imageInput: false },
            sdkMode: 'openai-responses',
            thinkingFormat: 'effort-only',
            reasoningEffort: ['high', 'xhigh', 'medium', 'low', 'minimal'],
            extraBody: { thinking: { type: 'enabled' }, reasoning: { summary: 'auto' } }
        } as never,
        messages: [],
        options: { modelConfiguration: { reasoningEffort: 'high' } } as never,
        sessionId: 'session-123'
    });

    assert.deepEqual(requestBody.reasoning, { summary: 'auto', effort: 'high' });
    assert.equal(requestBody.thinking, undefined);
    assert.equal(requestBody.enable_thinking, undefined);
});

test('effort-only 模式清除 extraBody 注入的 reasoning_effort 参数', async () => {
    const { OpenAIResponsesRequestBuilder } = await getBuilderModule();
    const builder = new OpenAIResponsesRequestBuilder('Test Provider', {
        convertMessagesToOpenAIResponses: () => ({ systemMessage: '', messages: [] }),
        convertToolsToResponses: () => [],
        filterExtraBodyParams: (extraBody: Record<string, unknown>) => extraBody
    } as never);

    const { requestBody } = builder.build({
        model: { id: 'muse-spark-1.2-contributor', name: 'Muse Spark' } as never,
        modelConfig: {
            id: 'muse-spark-1.2-contributor-go',
            name: 'Muse Spark 1.2 Contributor (Go)',
            tooltip: 'Muse Spark',
            maxInputTokens: 1000,
            maxOutputTokens: 1000,
            capabilities: { toolCalling: true, imageInput: false },
            sdkMode: 'openai-responses',
            thinkingFormat: 'effort-only',
            reasoningEffort: ['high', 'xhigh', 'medium', 'low', 'minimal'],
            extraBody: { reasoning_effort: 'low' }
        } as never,
        messages: [],
        options: { modelConfiguration: { reasoningEffort: 'high' } } as never,
        sessionId: 'session-123'
    });

    assert.deepEqual(requestBody.reasoning, { effort: 'high' });
    assert.equal(requestBody.reasoning_effort, undefined);
    assert.equal(requestBody.thinking, undefined);
    assert.equal(requestBody.enable_thinking, undefined);
});

test('effort-only 模式子请求在仅含 minimal 时仍原样传递', async () => {
    const { OpenAIResponsesRequestBuilder } = await getBuilderModule();
    const builder = new OpenAIResponsesRequestBuilder('Test Provider', {
        convertMessagesToOpenAIResponses: () => ({ systemMessage: '', messages: [] }),
        convertToolsToResponses: () => [],
        filterExtraBodyParams: (extraBody: Record<string, unknown>) => extraBody
    } as never);

    const { requestBody } = builder.build({
        model: { id: 'muse-spark-1.2-contributor', name: 'Muse Spark' } as never,
        modelConfig: {
            id: 'muse-spark-1.2-contributor-go',
            name: 'Muse Spark 1.2 Contributor (Go)',
            tooltip: 'Muse Spark',
            maxInputTokens: 1000,
            maxOutputTokens: 1000,
            capabilities: { toolCalling: true, imageInput: false },
            sdkMode: 'openai-responses',
            thinkingFormat: 'effort-only',
            reasoningEffort: ['high', 'xhigh', 'medium', 'low', 'minimal']
        } as never,
        messages: [],
        options: {
            modelConfiguration: { reasoningEffort: 'xhigh' },
            modelOptions: { requestKind: 'summarization' }
        } as never,
        sessionId: 'session-123'
    });

    assert.deepEqual(requestBody.reasoning, { effort: 'xhigh' });
    assert.equal(requestBody.thinking, undefined);
});

test('effort-only 模式子请求在不支持关闭思考时仍原样传递', async () => {
    const { OpenAIResponsesRequestBuilder } = await getBuilderModule();
    const builder = new OpenAIResponsesRequestBuilder('Test Provider', {
        convertMessagesToOpenAIResponses: () => ({ systemMessage: '', messages: [] }),
        convertToolsToResponses: () => [],
        filterExtraBodyParams: (extraBody: Record<string, unknown>) => extraBody
    } as never);

    const { requestBody } = builder.build({
        model: { id: 'muse-spark-1.2-contributor', name: 'Muse Spark' } as never,
        modelConfig: {
            id: 'muse-spark-1.2-contributor-go',
            name: 'Muse Spark 1.2 Contributor (Go)',
            tooltip: 'Muse Spark',
            maxInputTokens: 1000,
            maxOutputTokens: 1000,
            capabilities: { toolCalling: true, imageInput: false },
            sdkMode: 'openai-responses',
            thinkingFormat: 'effort-only',
            reasoningEffort: ['high', 'xhigh', 'medium', 'low']
        } as never,
        messages: [],
        options: {
            modelConfiguration: { reasoningEffort: 'xhigh' },
            modelOptions: { requestKind: 'summarization' }
        } as never,
        sessionId: 'session-123'
    });

    assert.deepEqual(requestBody.reasoning, { effort: 'xhigh' });
    assert.equal(requestBody.thinking, undefined);
});

test('Responses Fast 服务等级发送 priority', async () => {
    const { OpenAIResponsesRequestBuilder } = await getBuilderModule();
    const builder = new OpenAIResponsesRequestBuilder('Test Provider', {
        convertMessagesToOpenAIResponses: () => ({ systemMessage: '', messages: [] }),
        convertToolsToResponses: () => [],
        filterExtraBodyParams: (extraBody: Record<string, unknown>) => extraBody
    } as never);

    const { requestBody } = builder.build({
        model: { id: 'gpt-5', name: 'GPT-5' } as never,
        modelConfig: {
            id: 'gpt-5',
            name: 'GPT-5',
            tooltip: 'GPT-5',
            maxInputTokens: 1000,
            maxOutputTokens: 1000,
            capabilities: { toolCalling: true, imageInput: false },
            sdkMode: 'openai-responses',
            serviceTier: ['default', 'priority']
        } as never,
        messages: [],
        options: { modelConfiguration: { serviceTier: 'priority' } } as never,
        sessionId: 'session-123'
    });

    assert.equal(requestBody.service_tier, 'priority');
});

test('Responses Standard 服务等级清除 extraBody 中的 service_tier', async () => {
    const { OpenAIResponsesRequestBuilder } = await getBuilderModule();
    const builder = new OpenAIResponsesRequestBuilder('Test Provider', {
        convertMessagesToOpenAIResponses: () => ({ systemMessage: '', messages: [] }),
        convertToolsToResponses: () => [],
        filterExtraBodyParams: (extraBody: Record<string, unknown>) => extraBody
    } as never);

    const { requestBody } = builder.build({
        model: { id: 'gpt-5', name: 'GPT-5' } as never,
        modelConfig: {
            id: 'gpt-5',
            name: 'GPT-5',
            tooltip: 'GPT-5',
            maxInputTokens: 1000,
            maxOutputTokens: 1000,
            capabilities: { toolCalling: true, imageInput: false },
            sdkMode: 'openai-responses',
            serviceTier: ['default', 'priority'],
            extraBody: { service_tier: 'priority' }
        } as never,
        messages: [],
        options: { modelConfiguration: { serviceTier: 'default' } } as never,
        sessionId: 'session-123'
    });

    assert.equal('service_tier' in requestBody, false);
});

test('Compatible Responses 原样发送 auto 服务等级', async () => {
    const { OpenAIResponsesRequestBuilder } = await getBuilderModule();
    const builder = new OpenAIResponsesRequestBuilder(
        'Compatible',
        {
            convertMessagesToOpenAIResponses: () => ({ systemMessage: '', messages: [] }),
            convertToolsToResponses: () => [],
            filterExtraBodyParams: (extraBody: Record<string, unknown>) => extraBody
        } as never,
        'compatible'
    );

    const { requestBody } = builder.build({
        model: { id: 'gpt-5', name: 'GPT-5' } as never,
        modelConfig: {
            id: 'gpt-5',
            name: 'GPT-5',
            tooltip: 'GPT-5',
            maxInputTokens: 1000,
            maxOutputTokens: 1000,
            capabilities: { toolCalling: true, imageInput: false },
            sdkMode: 'openai-responses',
            serviceTier: ['default', 'auto']
        } as never,
        messages: [],
        options: { modelConfiguration: { serviceTier: 'auto' } } as never,
        sessionId: 'session-123'
    });

    assert.equal(requestBody.service_tier, 'auto');
});

test('DeepSeek 思考模式请求向消息转换传递 reasoning 占位策略', async () => {
    const { OpenAIResponsesRequestBuilder } = await getBuilderModule();
    const captured: unknown[][] = [];
    const builder = new OpenAIResponsesRequestBuilder(
        'DeepSeek',
        {
            convertMessagesToOpenAIResponses: (...args: unknown[]) => {
                captured.push(args);
                return { systemMessage: '', messages: [] };
            },
            convertToolsToResponses: () => []
        } as never,
        'deepseek'
    );

    const build = (modelConfiguration: Record<string, unknown>) =>
        builder.build({
            model: { id: 'deepseek-flash', name: 'DeepSeek-Flash' } as never,
            modelConfig: {
                id: 'deepseek-flash',
                model: 'deepseek-flash',
                provider: 'deepseek',
                sdkMode: 'openai-responses'
            } as never,
            messages: [],
            options: { modelConfiguration } as never,
            sessionId: 'session-123'
        });

    build({ reasoningEffort: 'high' });
    build({ reasoningEffort: 'none' });
    build({ thinking: 'disabled' });

    assert.deepEqual(
        captured.map(
            args => (args[3] as { injectReasoningPlaceholder?: boolean } | undefined)?.injectReasoningPlaceholder
        ),
        [true, false, true]
    );
});

test('非严格回显模型不启用 reasoning 占位策略', async () => {
    const { OpenAIResponsesRequestBuilder } = await getBuilderModule();
    const captured: unknown[][] = [];
    const builder = new OpenAIResponsesRequestBuilder(
        'Test Provider',
        {
            convertMessagesToOpenAIResponses: (...args: unknown[]) => {
                captured.push(args);
                return { systemMessage: '', messages: [] };
            },
            convertToolsToResponses: () => []
        } as never,
        'openai'
    );

    builder.build({
        model: { id: 'gpt-5.4', name: 'GPT-5.4' } as never,
        modelConfig: { id: 'gpt-5.4', model: 'gpt-5.4', provider: 'openai', sdkMode: 'openai-responses' } as never,
        messages: [],
        options: { modelConfiguration: { reasoningEffort: 'high' } } as never,
        sessionId: 'session-123'
    });

    assert.equal(
        (captured[0][3] as { injectReasoningPlaceholder?: boolean } | undefined)?.injectReasoningPlaceholder,
        false
    );
});

const reasoningReplayCases: Array<{
    name: string;
    settings: ModelChatResponseOptions;
    providerKey?: string;
    modelConfig?: Partial<Pick<ModelConfig, 'id' | 'model' | 'provider' | 'baseUrl'>>;
    extraBody?: Record<string, unknown>;
    effortOnly?: boolean;
    requestKind?: string;
    effort?: string;
    thinking?: string;
    inject: boolean;
}> = [
    { name: '默认开启', settings: {}, inject: true },
    { name: 'high', settings: { reasoningEffort: 'high' }, effort: 'high', thinking: 'enabled', inject: true },
    { name: 'none', settings: { reasoningEffort: 'none' }, effort: 'none', thinking: 'disabled', inject: false },
    {
        name: 'minimal',
        settings: { reasoningEffort: 'minimal' },
        effort: 'minimal',
        thinking: 'disabled',
        inject: true
    },
    {
        name: 'effort-only minimal',
        settings: { reasoningEffort: 'minimal' },
        effortOnly: true,
        effort: 'minimal',
        inject: true
    },
    {
        name: 'high 覆盖 disabled',
        settings: { thinking: 'disabled', reasoningEffort: 'high' },
        effort: 'high',
        thinking: 'enabled',
        inject: true
    },
    {
        name: 'extraBody none',
        settings: {},
        extraBody: { reasoning: { effort: 'none' } },
        effort: 'none',
        inject: false
    },
    {
        name: 'extraBody disabled',
        settings: {},
        extraBody: { thinking: { type: 'disabled' } },
        thinking: 'disabled',
        inject: true
    },
    { name: 'extraBody enable_thinking=false', settings: {}, extraBody: { enable_thinking: false }, inject: true },
    {
        name: 'settings disabled 不关闭 Responses 思考',
        settings: { thinking: 'disabled' },
        thinking: 'disabled',
        inject: true
    },
    {
        name: 'high 覆盖 extraBody none',
        settings: { reasoningEffort: 'high' },
        extraBody: { reasoning: { effort: 'none' } },
        effort: 'high',
        thinking: 'enabled',
        inject: true
    },
    {
        name: 'none 覆盖 extraBody high',
        settings: { reasoningEffort: 'none' },
        extraBody: { reasoning: { effort: 'high' } },
        effort: 'none',
        thinking: 'disabled',
        inject: false
    },
    {
        name: '辅助请求降级',
        settings: { reasoningEffort: 'high' },
        requestKind: 'chat-title',
        effort: 'none',
        thinking: 'disabled',
        inject: false
    },
    {
        name: 'extraBody null 删除 reasoning',
        settings: { reasoningEffort: 'high' },
        extraBody: { reasoning: null },
        thinking: 'enabled',
        inject: true
    },
    {
        name: 'extraBody null 删除 none 后恢复默认思考',
        settings: { reasoningEffort: 'none' },
        extraBody: { reasoning: null },
        thinking: 'disabled',
        inject: true
    },
    {
        name: 'extraBody null 删除 thinking',
        settings: { reasoningEffort: 'none' },
        extraBody: { thinking: null },
        effort: 'none',
        inject: false
    },
    {
        name: 'effort-only 清除 extraBody disabled',
        settings: {},
        extraBody: { thinking: { type: 'disabled' } },
        effortOnly: true,
        inject: true
    },
    {
        name: 'extraBody minimal',
        settings: {},
        extraBody: { reasoning: { effort: 'minimal' } },
        effort: 'minimal',
        inject: true
    },
    {
        name: '仅 providerKey 识别 DeepSeek',
        settings: {},
        providerKey: 'DeepSeek',
        modelConfig: { id: 'custom-model', provider: undefined },
        extraBody: { thinking: { type: 'disabled' } },
        thinking: 'disabled',
        inject: true
    },
    {
        name: '模型 provider 覆盖兼容提供商',
        settings: {},
        providerKey: 'compatible',
        modelConfig: { id: 'custom-model', provider: 'DeepSeek' },
        extraBody: { enable_thinking: false },
        inject: true
    },
    {
        name: '仅官方 URL 识别 DeepSeek',
        settings: { thinking: 'disabled' },
        providerKey: 'compatible',
        modelConfig: { id: 'custom-model', baseUrl: 'https://API.DEEPSEEK.COM/v1' },
        thinking: 'disabled',
        inject: true
    },
    {
        name: '仅模型名前缀识别 DeepSeek',
        settings: {},
        providerKey: 'compatible',
        modelConfig: { id: 'DeepSeek-flash' },
        extraBody: { enable_thinking: false },
        inject: true
    },
    {
        name: '映射后的 DeepSeek 模型在删除 none 后恢复默认思考',
        settings: { reasoningEffort: 'none' },
        providerKey: 'compatible',
        modelConfig: { id: 'custom-model', model: 'vendor/DeepSeek-V4-Pro' },
        extraBody: { reasoning: null },
        thinking: 'disabled',
        inject: true
    },
    {
        name: 'MiMo 默认仍补占位',
        settings: {},
        providerKey: 'xiaomimimo',
        modelConfig: { id: 'mimo-v2.5-pro' },
        inject: true
    },
    {
        name: 'MiMo 保持 thinking disabled 语义',
        settings: {},
        providerKey: 'xiaomimimo',
        modelConfig: { id: 'mimo-v2.5-pro' },
        extraBody: { thinking: { type: 'disabled' } },
        thinking: 'disabled',
        inject: false
    },
    {
        name: 'MiMo 保持 enable_thinking=false 语义',
        settings: {},
        providerKey: 'xiaomimimo',
        modelConfig: { id: 'mimo-v2.5-pro' },
        extraBody: { enable_thinking: false },
        inject: false
    }
];

for (const scenario of reasoningReplayCases) {
    test(`Responses reasoning 回放与最终请求一致: ${scenario.name}`, async () => {
        const { OpenAIResponsesRequestBuilder, OpenAIResponsesMessageConverter } = await getBuilderModule();
        const providerKey = scenario.providerKey ?? 'deepseek';
        const modelId = scenario.modelConfig?.id ?? 'deepseek-flash';
        const converter = new OpenAIResponsesMessageConverter(
            { isImageMimeType: () => false, createDataUrl: () => '' } as never,
            'Test Provider'
        );
        const builder = new OpenAIResponsesRequestBuilder('Test Provider', converter, providerKey);
        const { requestBody } = builder.build({
            model: { id: modelId, name: 'Test Model' } as never,
            modelConfig: {
                id: modelId,
                provider: providerKey,
                sdkMode: 'openai-responses',
                thinking: ['enabled', 'disabled'],
                reasoningEffort: ['high', 'minimal', 'none'],
                thinkingFormat: scenario.effortOnly ? 'effort-only' : undefined,
                extraBody: scenario.extraBody,
                ...scenario.modelConfig
            } as never,
            messages: [
                { role: 'assistant', content: [{ callId: 'call-1', name: 'lookup', input: {} }] },
                { role: 'user', content: [{ callId: 'call-1', content: [new vscodeMock.LanguageModelTextPart('ok')] }] }
            ] as never,
            options: {
                modelConfiguration: scenario.settings,
                modelOptions: { requestKind: scenario.requestKind },
                tools: [{ name: 'lookup', inputSchema: { type: 'object', properties: {} } }]
            } as never,
            sessionId: 'session-123'
        });
        const input = requestBody.input as Array<{ type: string; call_id?: string }>;

        assert.deepEqual(requestBody.reasoning, scenario.effort ? { effort: scenario.effort } : undefined);
        assert.deepEqual(requestBody.thinking, scenario.thinking ? { type: scenario.thinking } : undefined);
        assert.equal(requestBody.enable_thinking, scenario.extraBody?.enable_thinking);
        assert.deepEqual(
            input.map(item => item.type),
            scenario.inject ?
                ['reasoning', 'function_call', 'function_call_output']
            :   ['function_call', 'function_call_output']
        );
        assert.deepEqual(
            input.filter(item => item.type === 'reasoning'),
            scenario.inject ?
                [{ type: 'reasoning', summary: [], content: [{ type: 'reasoning_text', text: ' ' }] }]
            :   []
        );
        assert.equal(input.at(-1)?.call_id, input.find(item => item.type === 'function_call')?.call_id);
    });
}
