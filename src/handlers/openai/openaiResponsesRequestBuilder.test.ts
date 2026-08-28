import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import test from 'node:test';

const require = createRequire(import.meta.url);
const NodeModule = require('node:module') as {
    prototype: {
        require: (id: string) => unknown;
    };
};

let builderModulePromise:
    | Promise<{
          applyResponsesSystemMessage: typeof import('./openaiResponsesRequestBuilder').applyResponsesSystemMessage;
          initializeResponsesRequestBody: typeof import('./openaiResponsesRequestBuilder').initializeResponsesRequestBody;
          OpenAIResponsesRequestBuilder: typeof import('./openaiResponsesRequestBuilder').OpenAIResponsesRequestBuilder;
      }>
    | undefined;

async function getBuilderModule() {
    if (builderModulePromise) {
        return builderModulePromise;
    }

    const originalRequire = NodeModule.prototype.require;
    NodeModule.prototype.require = function (id: string): unknown {
        if (id === 'vscode') {
            return {};
        }
        return originalRequire.call(this, id);
    };

    builderModulePromise = import('./openaiResponsesRequestBuilder').finally(() => {
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

test('子请求关闭思考时不注入 nativeTools，但保留显式声明 tools', async () => {
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
            webSearchTool: true,
            nativeTools: [{ type: 'web_extractor' }]
        } as never,
        messages: [],
        options: {
            tools: [{ name: 'declared_tool' }],
            modelOptions: { requestKind: 'search-subagent' }
        } as never,
        sessionId: 'session-123'
    });

    assert.deepEqual(requestBody.tools, [declaredTool]);
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
