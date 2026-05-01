/*---------------------------------------------------------------------------------------------
 *  AI SDK Provider (统一入口)
 *  从 models.dev 动态获取所有提供商的模型
 *  使用 Vercel AI SDK 提供统一的模型访问接口
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import * as crypto from 'node:crypto';
import {
    LanguageModelChatInformation,
    LanguageModelChatMessage,
    ProvideLanguageModelChatResponseOptions,
    Progress
} from 'vscode';
import { streamText } from 'ai';
import { convertMessages } from './aiSdkAdapter/messageConverter';
import { convertTools } from './aiSdkAdapter/toolConverter';
import { convertStream } from './aiSdkAdapter/streamConverter';
import { ModelsDevService } from './aiSdkAdapter/modelsDevService';
import { SdkClientFactory, needsAihubmixCompatibleClient } from './aiSdkAdapter/sdkClientFactory';
import { buildProviderOptions } from './aiSdkAdapter/sdkProviderOptions';
import { attachOpenAICompatibleReasoningContent } from './aiSdkAdapter/messagePreprocessor';
import {
    toJsonLog, createRequestLogPrefix,
    summarizeVsCodeMessages, summarizeToolDefinitions,
    summarizeCoreMessages, mapSdkTypeToStatefulSdkMode
} from './aiSdkAdapter/logHelpers';
import { Logger } from '../utils/logger';
import { AiSdkWizard } from '../utils/aiSdkWizard';
import { ApiKeyManager } from '../utils/apiKeyManager';
import { encodeStatefulMarker } from '../handlers/statefulMarker';
import { CustomDataPartMimeTypes } from '../handlers/types';
import { TokenUsagesManager } from '../usages/usagesManager';
import type { ModelConfig } from '../types/sharedTypes';

/**
 * SDK 客户端路由标识（由白名单 Map 的 value 推导）
 */
export type SdkClientType = typeof SUPPORTED_NPM_PACKAGES extends ReadonlyMap<string, infer V> ? V : never;

/**
 * 提供商配置映射
 */
interface ProviderConfig {
    apiKey: string;
    baseUrl?: string;
    sdkType: SdkClientType;
}

/**
 * 已适配的 npm SDK 包白名单
 */
export const SUPPORTED_NPM_PACKAGES = new Map([
    ['@ai-sdk/anthropic', 'anthropic'],
    ['@ai-sdk/openai', 'openai'],
    ['@ai-sdk/openai-compatible', 'openai-compatible'],
    ['@ai-sdk/google', 'google'],
    ['@ai-sdk/xai', 'xai'],
    ['@ai-sdk/perplexity', 'perplexity'],
    ['@ai-sdk/deepinfra', 'deepinfra'],
    ['@openrouter/ai-sdk-provider', 'openrouter'],
    ['@aihubmix/ai-sdk-provider', 'aihubmix']
]);

// ---- configurationSchema 常量 ----

const REASONING_EFFORT_LABELS: Record<string, string> = {
    none: '关', minimal: '关', low: '低',
    medium: '中', high: '高', xhigh: '超', max: '超'
};
const REASONING_EFFORT_DESCRIPTIONS: Record<string, string> = {
    none: '关闭思考，直接回答', minimal: '关闭思考，直接回答',
    low: '轻量思考，快速响应', medium: '均衡模式，兼顾速度与深度',
    high: '深度分析，处理复杂问题', xhigh: '最大推理深度，速度较慢',
    max: '绝对最高能力，没有消耗限制'
};
const THINKING_LABELS: Record<string, string> = {
    disabled: '关', enabled: '思考', auto: 'Auto'
};
const THINKING_DESCRIPTIONS: Record<string, string> = {
    disabled: '关闭思考模式', enabled: '开启思考模式', auto: '模型自行判断'
};
const THINKING_LEVEL_LABELS: Record<string, string> = {
    minimal: '最小', low: '低', medium: '中', high: '高'
};
const THINKING_LEVEL_DESCRIPTIONS: Record<string, string> = {
    minimal: '最小思考，最快响应', low: '轻量思考，侧重快速响应',
    medium: '中等思考，兼顾速度与深度', high: '深度思考，处理复杂问题'
};

/** 根据模型的 thinkingMode 构建 configurationSchema */
function buildConfigurationSchema(model: ModelConfig): vscode.LanguageModelConfigurationSchema | undefined {
    if (model.thinkingMode === 'reasoningEffort') {
        const options = model.reasoningEffort;
        if (!options || options.length === 0) return undefined;
        return {
            properties: {
                reasoningEffort: {
                    type: 'string' as const, title: '思考长度',
                    enum: options,
                    enumItemLabels: options.map(l => REASONING_EFFORT_LABELS[l] || l),
                    enumDescriptions: options.map(l => REASONING_EFFORT_DESCRIPTIONS[l] || l),
                    default: options.includes('medium') ? 'medium' : options[0],
                    group: 'navigation'
                }
            }
        };
    }
    if (model.thinkingMode === 'thinking') {
        const options = model.thinking;
        if (!options || options.length === 0) return undefined;
        return {
            properties: {
                thinking: {
                    type: 'string' as const, title: '思考模式',
                    enum: options,
                    enumItemLabels: options.map(l => THINKING_LABELS[l] || l),
                    enumDescriptions: options.map(l => THINKING_DESCRIPTIONS[l] || l),
                    default: options.includes('auto') ? 'auto' : options[0],
                    group: 'navigation'
                }
            }
        };
    }
    if (model.thinkingMode === 'thinkingLevel') {
        const options = model.thinkingLevel;
        if (!options || options.length === 0) return undefined;
        return {
            properties: {
                thinkingLevel: {
                    type: 'string' as const, title: '思考深度',
                    enum: options,
                    enumItemLabels: options.map(l => THINKING_LEVEL_LABELS[l] || l),
                    enumDescriptions: options.map(l => THINKING_LEVEL_DESCRIPTIONS[l] || l),
                    default: options.includes('medium') ? 'medium' : options[0],
                    group: 'navigation'
                }
            }
        };
    }
    return undefined;
}

// ---- thinking/signature 提取 ----

function extractCompleteThinking(
    reasoning: string | undefined,
    reasoningDetails: Awaited<ReturnType<typeof Promise.resolve<Array<unknown>>>>
): string | undefined {
    const detailThinking = reasoningDetails
        .filter(
            (detail): detail is { type: 'text'; text: string; signature?: string } =>
                typeof detail === 'object' && detail !== null &&
                'type' in detail && detail.type === 'text' && 'text' in detail
        )
        .map(detail => detail.text)
        .join('');

    const normalizedThinking = detailThinking || reasoning;
    return normalizedThinking && normalizedThinking.length > 0 ? normalizedThinking : undefined;
}

function extractCompleteSignature(
    reasoningDetails: Awaited<ReturnType<typeof Promise.resolve<Array<unknown>>>>
): string | undefined {
    const completeSignature = reasoningDetails
        .filter(
            (detail): detail is { type: 'text'; text: string; signature?: string } =>
                typeof detail === 'object' && detail !== null &&
                'type' in detail && detail.type === 'text' &&
                'signature' in detail && typeof detail.signature === 'string'
        )
        .map(detail => detail.signature)
        .join('');

    return completeSignature.length > 0 ? completeSignature : undefined;
}

// ---- Provider 主类 ----

/**
 * AI SDK Provider 实现
 */
export class AiSdkProvider implements vscode.LanguageModelChatProvider {
    private providerConfigs: Map<string, ProviderConfig>;
    private models: ModelConfig[];
    private clientFactory = new SdkClientFactory();

    private _onDidChangeLanguageModelChatInformation = new vscode.EventEmitter<void>();
    readonly onDidChangeLanguageModelChatInformation = this._onDidChangeLanguageModelChatInformation.event;

    constructor(providerConfigs: Map<string, ProviderConfig>, models: ModelConfig[]) {
        this.providerConfigs = providerConfigs;
        this.models = models;
        Logger.info(`[AiSdkProvider] Initialized with ${models.length} models from ${providerConfigs.size} providers`);
    }

    /** 刷新模型列表 */
    async refreshModels(): Promise<void> {
        Logger.info('[AiSdkProvider] Refreshing model list...');
        const allProviders = await ModelsDevService.getAllProviders();
        this.models = [];
        this.providerConfigs.clear();

        for (const providerInfo of allProviders) {
            const storageKey = `ai-sdk:${providerInfo.id}`;
            const apiKey = await ApiKeyManager.getApiKey(storageKey);

            if (apiKey) {
                const npm = providerInfo.npm;
                const sdkType = npm ? SUPPORTED_NPM_PACKAGES.get(npm) : undefined;

                if (!sdkType) {
                    Logger.warn(`[AiSdkProvider] Skipping provider (not adapted): ${providerInfo.id}`, {
                        name: providerInfo.name, npm: npm ?? '(none)', reason: '当前插件未进行适配'
                    });
                    continue;
                }

                Logger.info(`[AiSdkProvider] Loading configured provider: ${providerInfo.id}`, {
                    name: providerInfo.name, npm, api: providerInfo.api, sdkType
                });

                try {
                    const providerModels = await ModelsDevService.getProviderModels(providerInfo.id);
                    this.models.push(...providerModels);
                    this.providerConfigs.set(providerInfo.id, {
                        apiKey, baseUrl: providerInfo.api, sdkType
                    });
                    Logger.info(`[AiSdkProvider] ${providerInfo.id}: Loaded ${providerModels.length} models`);
                } catch (error) {
                    Logger.error(`[AiSdkProvider] ${providerInfo.id}: Failed to load models`, error);
                }
            }
        }

        Logger.info(`[AiSdkProvider] Total ${this.models.length} models loaded from ${this.providerConfigs.size} providers`);
        this._onDidChangeLanguageModelChatInformation.fire();
    }

    /** 提供模型信息 */
    async provideLanguageModelChatInformation(
        options: vscode.PrepareLanguageModelChatModelOptions,
        _token: vscode.CancellationToken
    ): Promise<LanguageModelChatInformation[]> {
        if (!options.silent) {
            await vscode.commands.executeCommand('gcmp.aiSdk.configWizard');
            return [];
        }

        return this.models.map(model => {
            const configurationSchema = buildConfigurationSchema(model);
            return {
                id: model.id, name: model.name, detail: 'AI SDK',
                maxInputTokens: model.maxInputTokens, maxOutputTokens: model.maxOutputTokens,
                family: model.provider || 'unknown', version: '1.0.0',
                capabilities: {
                    toolCalling: model.capabilities.toolCalling,
                    imageInput: model.capabilities.imageInput
                },
                ...(configurationSchema ? { configurationSchema } : {})
            };
        });
    }

    /** 提供 Token 计数 */
    async provideTokenCount(
        _model: LanguageModelChatInformation,
        _text: string | LanguageModelChatMessage,
        _token: vscode.CancellationToken
    ): Promise<number> {
        return 0;
    }

    /** 提供聊天响应 */
    async provideLanguageModelChatResponse(
        model: LanguageModelChatInformation,
        messages: readonly LanguageModelChatMessage[],
        options: ProvideLanguageModelChatResponseOptions,
        progress: Progress<vscode.LanguageModelResponsePart>,
        token: vscode.CancellationToken
    ): Promise<void> {
        const startTime = Date.now();
        const modelInfo = this.models.find(m => m.id === model.id);
        if (!modelInfo) {
            throw new Error(`Model ${model.id} not found`);
        }

        const providerId = modelInfo.provider || modelInfo.id.split(':::')[0];
        const requestId = crypto.randomUUID().slice(0, 8);
        const logPrefix = createRequestLogPrefix(requestId);

        Logger.trace(`${logPrefix} Processing request for model: ${modelInfo.name} (provider: ${providerId})`);
        Logger.trace(`${logPrefix} VS Code request summary: ${toJsonLog(summarizeVsCodeMessages(messages))}`);

        try {
            // 1. 获取 SDK 客户端和配置
            const providerConfig = this.providerConfigs.get(providerId);
            if (!providerConfig) {
                throw new Error(`Provider ${providerId} not configured`);
            }

            const sdkClient = this.clientFactory.getClient(providerId, providerConfig);

            // 2. 转换消息格式
            let aiMessages = convertMessages(messages);
            Logger.trace(`${logPrefix} AI SDK prompt summary before adjustments: ${toJsonLog(summarizeCoreMessages(aiMessages))}`);

            if (providerConfig.sdkType === 'openai-compatible' || providerConfig.sdkType === 'aihubmix') {
                const reasoningAttachment = attachOpenAICompatibleReasoningContent(aiMessages);
                aiMessages = reasoningAttachment.messages;
                if (reasoningAttachment.attachedReasoningCount > 0) {
                    Logger.trace(`${logPrefix} Attached reasoning_content: ${toJsonLog({
                        assistantMessages: reasoningAttachment.attachedReasoningCount,
                        reasoningChars: reasoningAttachment.attachedReasoningChars
                    })}`);
                }
            }

            Logger.trace(`${logPrefix} AI SDK prompt summary after adjustments: ${toJsonLog(summarizeCoreMessages(aiMessages))}`);

            // 3. 转换工具定义
            Logger.trace(`${logPrefix} VS Code tool summary: ${toJsonLog(summarizeToolDefinitions(options.tools))}`);
            const aiTools = convertTools(options.tools);
            Logger.trace(`${logPrefix} AI SDK tool summary: ${toJsonLog({
                configuredTools: aiTools ? Object.keys(aiTools).length : 0,
                toolNames: aiTools ? Object.keys(aiTools).slice(0, 20) : []
            })}`);

            // 4. 从 modelConfiguration 获取用户配置
            // 注意：VS Code 的 configurationSchema default 仅作 UI 提示，
            // 不保证会通过 modelConfiguration 传递，需自行兜底默认值。
            const modelConfig = options.modelConfiguration || {};
            const configReasoningEffort = modelConfig.reasoningEffort as string | undefined
                ?? (modelInfo.reasoningEffort?.includes('medium') ? 'medium' : modelInfo.reasoningEffort?.[0]);
            const configThinking = modelConfig.thinking as string | undefined
                ?? (modelInfo.thinking?.includes('auto') ? 'auto' : modelInfo.thinking?.[0]);
            const configThinkingLevel = modelConfig.thinkingLevel as string | undefined
                ?? (modelInfo.thinkingLevel?.includes('medium') ? 'medium' : modelInfo.thinkingLevel?.[0]);
            const modelIdForApi = modelInfo.model ?? modelInfo.id.split(':::')[1] ?? modelInfo.id;

            // 5. 构建 providerOptions（考虑 aihubmix 内部路由映射）
            // aihubmix SDK 内部将 claude 路由到 AnthropicMessagesLanguageModel（读取 providerOptions.anthropic），
            // gemini 路由到 GoogleGenerativeAILanguageModel（读取 providerOptions.google），
            // 其他模型使用 OpenAIChatLanguageModel（不提取 reasoning_content，需切换到 openai-compatible 客户端）。
            // 因此 effectiveSdkType 必须映射到底层 SDK 实际使用的 provider name，而非顶层 aihubmix。
            const useAihubmixCompatible = providerConfig.sdkType === 'aihubmix'
                && needsAihubmixCompatibleClient(modelIdForApi);
            let effectiveSdkType: SdkClientType;
            if (useAihubmixCompatible) {
                effectiveSdkType = 'openai-compatible';
            } else if (providerConfig.sdkType === 'aihubmix') {
                effectiveSdkType = modelIdForApi.startsWith('claude-') ? 'anthropic'
                    : modelIdForApi.startsWith('gemini-') ? 'google'
                    : providerConfig.sdkType;
            } else {
                effectiveSdkType = providerConfig.sdkType;
            }

            // GPT-5.x 需要特殊处理 max_completion_tokens
            const needsCompletionTokens = /^gpt-5/i.test(modelIdForApi);
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            const baseOptions: Record<string, any> = {};
            if (needsCompletionTokens) {
                baseOptions.openai = { ...baseOptions.openai, max_completion_tokens: modelInfo.maxOutputTokens };
            }

            const thinkingOptions = buildProviderOptions(
                effectiveSdkType, modelInfo.thinkingMode,
                configReasoningEffort, configThinking, configThinkingLevel
            );

            // 合并 baseOptions + thinkingOptions
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            const providerOptions: Record<string, any> = {};
            for (const [key, value] of Object.entries(baseOptions)) {
                providerOptions[key] = { ...providerOptions[key], ...value };
            }
            for (const [key, value] of Object.entries(thinkingOptions)) {
                providerOptions[key] = { ...providerOptions[key], ...value };
            }

            // 6. 选择客户端并创建模型实例
            const isAihubmixGemini = providerConfig.sdkType === 'aihubmix' && modelIdForApi.startsWith('gemini-');
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            const clientFunc = useAihubmixCompatible
                ? this.clientFactory.getAihubmixCompatibleClient(providerId, providerConfig)
                : sdkClient;
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            const modelInstance = clientFunc(modelIdForApi) as any;

            // aihubmix gemini 模型的内嵌 @ai-sdk/google@1.2.19 不支持 thinkingLevel（Zod schema 缺失），
            // 通过注入自定义 fetch 在 HTTP 层面直接写入 generationConfig.thinkingConfig.thinkingLevel。
            if (isAihubmixGemini && configThinkingLevel && modelInfo.thinkingMode === 'thinkingLevel') {
                const originalFetch = modelInstance.config?.fetch ?? globalThis.fetch;
                const levelToInject = configThinkingLevel;
                modelInstance.config = {
                    ...modelInstance.config,
                    fetch: async (url: RequestInfo | URL, init?: RequestInit) => {
                        if (init?.body && typeof init.body === 'string') {
                            try {
                                const body = JSON.parse(init.body);
                                if (body.generationConfig) {
                                    body.generationConfig.thinkingConfig = {
                                        ...body.generationConfig.thinkingConfig,
                                        thinkingLevel: levelToInject
                                    };
                                    init = { ...init, body: JSON.stringify(body) };
                                }
                            } catch { /* JSON 解析失败则使用原始请求 */ }
                        }
                        return originalFetch(url, init);
                    }
                };
            }

            Logger.trace(`${logPrefix} Dispatching streamText: ${toJsonLog({
                providerId, sdkType: providerConfig.sdkType, effectiveSdkType,
                useAihubmixCompatible, isAihubmixGemini, thinkingMode: modelInfo.thinkingMode,
                modelIdForApi, promptMessages: aiMessages.length,
                configuredTools: aiTools ? Object.keys(aiTools).length : 0,
                maxTokens: needsCompletionTokens ? '(via providerOptions)' : modelInfo.maxOutputTokens,
                topP: modelConfig.topP,
                reasoningEffort: configReasoningEffort, thinking: configThinking,
                thinkingLevel: configThinkingLevel,
                providerOptions: Object.keys(providerOptions).length > 0 ? providerOptions : '(none)'
            })}`);

            const stream = await streamText({
                model: modelInstance,
                messages: aiMessages,
                tools: aiTools,
                ...(needsCompletionTokens ?
                    { providerOptions: { openai: { max_completion_tokens: modelInfo.maxOutputTokens } } }
                :   { maxTokens: modelInfo.maxOutputTokens }),
                ...(Object.keys(providerOptions).length > 0 ? { providerOptions } : {}),
                ...(modelConfig.topP !== undefined ? { topP: modelConfig.topP } : {}),
                ...(modelInfo.reasoning ? { sendReasoning: true } : {})
            });

            Logger.trace(`${logPrefix} Stream created in ${Date.now() - startTime}ms`);

            // 7. 流式报告响应
            let receivedChunks = 0;
            try {
                for await (const chunk of convertStream(stream, token, { requestId })) {
                    progress.report(chunk);
                    receivedChunks++;
                }
            } catch (streamError) {
                Logger.error(`${logPrefix} Stream processing error:`, streamError);
                throw streamError;
            }

            // 8. 记录 token usage
            try {
                const usage = await stream.usage;
                if (usage) {
                    Logger.info(`${logPrefix} Token usage: ${toJsonLog({
                        promptTokens: usage.promptTokens,
                        completionTokens: usage.completionTokens,
                        totalTokens: usage.totalTokens
                    })}`);
                    const usagesManager = TokenUsagesManager.instance;
                    const usageRequestId = await usagesManager.recordEstimatedTokens({
                        providerKey: `ai-sdk:${providerId}`, displayName: providerId,
                        modelId: modelIdForApi, modelName: modelInfo.name,
                        estimatedInputTokens: usage.promptTokens
                    });
                    await usagesManager.updateActualTokens({
                        requestId: usageRequestId,
                        rawUsage: {
                            prompt_tokens: usage.promptTokens,
                            completion_tokens: usage.completionTokens,
                            total_tokens: usage.totalTokens
                        },
                        status: 'completed',
                        streamStartTime: startTime,
                        streamEndTime: Date.now()
                    });
                }
            } catch (usageError) {
                Logger.warn(`${logPrefix} Failed to record usage:`, usageError);
            }

            // 9. 输出 stateful marker
            const reasoning = await stream.reasoning;
            const reasoningDetails = await stream.reasoningDetails;
            const toolCalls = await stream.toolCalls;
            const completeThinking = extractCompleteThinking(reasoning, reasoningDetails);
            const completeSignature = extractCompleteSignature(reasoningDetails);

            if (completeThinking || completeSignature) {
                const marker = encodeStatefulMarker(modelIdForApi, {
                    sessionId: crypto.randomUUID(),
                    responseId: crypto.randomUUID(),
                    ...(completeThinking ? { completeThinking } : {}),
                    ...(completeSignature ? { completeSignature } : {}),
                    hasToolCalls: toolCalls.length > 0,
                    provider: providerId,
                    modelId: modelIdForApi,
                    sdkMode: mapSdkTypeToStatefulSdkMode(providerConfig.sdkType)
                });
                progress.report(new vscode.LanguageModelDataPart(marker, CustomDataPartMimeTypes.StatefulMarker));
                Logger.trace(`${logPrefix} Reported stateful marker with thinking for model: ${modelIdForApi}`);
            }

            Logger.trace(`${logPrefix} Response summary: ${toJsonLog({
                receivedChunks,
                reasoningChars: reasoning?.length ?? 0,
                reasoningDetails: reasoningDetails.length,
                completeThinkingChars: completeThinking?.length ?? 0,
                hasCompleteSignature: Boolean(completeSignature),
                toolCalls: toolCalls.length,
                emittedStatefulMarker: Boolean(completeThinking || completeSignature),
                durationMs: Date.now() - startTime,
                ...(await stream.usage.then(u =>
                    u ? { promptTokens: u.promptTokens, completionTokens: u.completionTokens, totalTokens: u.totalTokens }
                    :   { usage: 'unavailable' }
                ))
            })}`);

            if (receivedChunks === 0) {
                Logger.warn(`${logPrefix} Stream completed without any content`);
                throw new Error('API 未返回任何内容，请检查模型配置和 API 端点');
            }

            Logger.trace(`${logPrefix} Stream completed with ${receivedChunks} chunks`);
        } catch (error) {
            Logger.error(`${logPrefix} Error in provideLanguageModelChatResponse:`, error);

            if (error instanceof Error) {
                const errorObj = error as unknown as Record<string, unknown>;
                if (errorObj.statusCode) {
                    Logger.error(`${logPrefix} HTTP Status: ${errorObj.statusCode}`);
                }
                const response = errorObj.response as Record<string, unknown> | undefined;
                if (response?.data) {
                    Logger.error(`${logPrefix} Response data: ${JSON.stringify(response.data)}`);
                }
                throw new Error(`请求失败: ${error.message}`);
            }

            throw error;
        }
    }

    getModels(): ModelConfig[] {
        return this.models;
    }
}

// ---- 注册入口 ----

/** 创建并注册 AI SDK Provider */
export async function createAndRegisterAiSdkProvider(_context: vscode.ExtensionContext): Promise<vscode.Disposable[]> {
    const disposables: vscode.Disposable[] = [];

    try {
        Logger.info('[AiSdkProvider] Initializing...');
        ModelsDevService.init(_context.globalStorageUri.fsPath);

        // 注册配置向导命令
        const configWizardCommand = vscode.commands.registerCommand('gcmp.aiSdk.configWizard', async () => {
            Logger.info('[AiSdkProvider] Config wizard command invoked');
            try {
                vscode.window.showInformationMessage('AI SDK 配置向导正在启动...');
                await AiSdkWizard.startWizard(provider);
            } catch (error) {
                Logger.error('[AiSdkProvider] Config wizard execution failed:', error);
                vscode.window.showErrorMessage(`配置向导执行失败: ${error}`);
            }
        });
        disposables.push(configWizardCommand);

        // 扫描 providers，加载已配置 API Key 的模型
        const models: ModelConfig[] = [];
        const providerConfigs = new Map<string, ProviderConfig>();

        const allProviders = await ModelsDevService.getAllProviders();
        for (const providerInfo of allProviders) {
            const storageKey = `ai-sdk:${providerInfo.id}`;
            const apiKey = await ApiKeyManager.getApiKey(storageKey);

            if (apiKey) {
                const npm = providerInfo.npm;
                const sdkType = npm ? SUPPORTED_NPM_PACKAGES.get(npm) : undefined;

                if (!sdkType) {
                    Logger.warn(`[AiSdkProvider] Skipping provider (not adapted): ${providerInfo.id}`, {
                        name: providerInfo.name, npm: npm ?? '(none)', reason: '当前插件未进行适配'
                    });
                    continue;
                }

                Logger.info(`[AiSdkProvider] Found configured provider: ${providerInfo.id}`, {
                    name: providerInfo.name, npm, api: providerInfo.api, sdkType
                });

                try {
                    const providerModels = await ModelsDevService.getProviderModels(providerInfo.id);
                    models.push(...providerModels);
                    providerConfigs.set(providerInfo.id, {
                        apiKey, baseUrl: providerInfo.api, sdkType
                    });
                    Logger.info(`[AiSdkProvider] ${providerInfo.id}: Loaded ${providerModels.length} models`);
                } catch (error) {
                    Logger.error(`[AiSdkProvider] ${providerInfo.id}: Failed to load models`, error);
                }
            }
        }

        Logger.info(`[AiSdkProvider] Initial load: ${models.length} models from ${providerConfigs.size} providers`);

        const provider = new AiSdkProvider(providerConfigs, models);
        const providerDisposable = vscode.lm.registerLanguageModelChatProvider('gcmp.aiSdk', provider);
        disposables.push(providerDisposable);

        if (models.length > 0) {
            Logger.info(`[AiSdkProvider] Provider registered successfully with ${models.length} models`);
        } else {
            Logger.info('[AiSdkProvider] Provider registered successfully (empty, waiting for configuration)');
        }

        return disposables;
    } catch (error) {
        Logger.error('[AiSdkProvider] Registration failed:', error);
        return disposables;
    }
}
