/*---------------------------------------------------------------------------------------------
 *  models.dev 数据服务
 *  从 models.dev API 动态获取提供商和模型信息
 *  支持本地文件缓存：网络请求成功后写入 globalStorage，失败时从本地缓存兜底
 *--------------------------------------------------------------------------------------------*/

import * as fs from 'fs';
import * as path from 'path';
import { Logger } from '../../utils/logger';
import type { ModelConfig } from '../../types/sharedTypes';

/**
 * models.dev API 响应格式
 * 注意：API 返回的是扁平结构，provider ID 直接是顶层键
 */
type ModelsDevAPI = Record<string, ModelsDevProvider>;

/**
 * models.dev Provider 配置
 */
interface ModelsDevProvider {
    id: string;
    name: string;
    npm?: string; // SDK 包名，如 '@ai-sdk/anthropic', '@ai-sdk/openai-compatible'
    api?: string; // API base URL
    env?: string[]; // 环境变量名（用于 API Key）
    doc?: string; // 文档链接
    models: Record<string, ModelsDevModel>;
}

/**
 * Provider 配置信息（用于 SDK 客户端初始化）
 */
export interface ProviderInfo {
    id: string;
    name: string;
    npm?: string;
    api?: string;
    env?: string[];
    doc?: string;
}

interface ModelsDevModel {
    id: string;
    name: string;
    family?: string;
    attachment?: boolean;
    reasoning?: boolean;
    tool_call?: boolean;
    structured_output?: boolean;
    temperature?: boolean;
    modalities?: {
        input: string[];
        output: string[];
    };
    limit?: {
        context: number;
        input?: number;
        output: number;
    };
    cost?: {
        input: number;
        output: number;
    };
    open_weights?: boolean;
    release_date?: string;
    last_updated?: string;
    knowledge?: string;
}

/**
 * models.dev 数据服务
 */

/**
 * 根据模型名称推断推理模式（thinking / reasoningEffort）
 *
 * 来源：项目内置 provider config JSON + 各模型官方文档
 *
 * 匹配规则（按模型 ID 关键字匹配）：
 * - gpt-5 / o1 / o3 / o4              → reasoningEffort  （OpenAI 推理模型）
 * - deepseek-v4                        → reasoningEffort  （DeepSeek V4）
 * - doubao-seed                        → reasoningEffort  （豆包 Seed）
 * - grok                               → reasoningEffort  （xAI Grok）
 * - claude-opus-4.5 / claude-opus-4.6  → reasoningEffort  （Anthropic effort 参数）
 *   claude-opus-4.7 / claude-sonnet-4.6
 *   claude-mythos
 * - claude（其他）                     → thinking         （Anthropic thinking 模式）
 * - gemini                             → thinking         （Google Gemini）
 * - qwen / qwq                         → thinking         （通义千问）
 * - glm / chatglm                      → thinking         （智谱 GLM）
 * - kimi / moonshot                    → thinking         （Kimi）
 * - mimo / minimax                     → thinking         （MiniMax）
 * - ernie                              → thinking         （百度 ERNIE）
 * - deepseek-r1 / deepseek-v3          → thinking         （DeepSeek R1/V3）
 *
 * 兜底：模型未匹配时根据 SDK 包名给出默认模式
 */
function inferThinkingModeByModel(modelId: string, npm?: string): 'thinking' | 'reasoningEffort' | undefined {
    const id = modelId.toLowerCase();

    // --- reasoningEffort 模式 ---
    if (/^(o[134]|gpt-5)/.test(id)) {
        return 'reasoningEffort';
    }
    if (id.includes('deepseek-v4')) {
        return 'reasoningEffort';
    }
    if (id.includes('doubao-seed')) {
        return 'reasoningEffort';
    }
    if (id.includes('grok')) {
        return 'reasoningEffort';
    }

    // Claude 新模型使用 effort 参数（reasoningEffort 模式）
    // Opus 4.5 / 4.6 / 4.7、Sonnet 4.6、Mythos → effort: low/medium/high/xhigh/max
    if (/claude-(opus-4\.[5-7]|sonnet-4\.6|mythos)/.test(id)) {
        return 'reasoningEffort';
    }
    // Claude 其他模型保持 thinking 模式
    if (id.includes('claude')) {
        return 'thinking';
    }

    // --- thinking 模式 ---
    if (id.includes('gemini-3')) {
        return 'thinkingLevel';
    }
    if (id.includes('gemini')) {
        return 'thinking';
    }
    if (id.includes('qwen') || id.includes('qwq')) {
        return 'thinking';
    }
    if (id.includes('glm') || id.includes('chatglm')) {
        return 'thinking';
    }
    if (id.includes('kimi') || id.includes('moonshot')) {
        return 'thinking';
    }
    if (id.includes('mimo') || id.includes('minimax')) {
        return 'thinking';
    }
    if (id.includes('ernie')) {
        return 'thinking';
    }
    if (id.includes('deepseek-r1') || id.includes('deepseek-v3')) {
        return 'thinking';
    }

    // --- 兜底：SDK 包名推断 ---
    if (npm === '@ai-sdk/anthropic' || npm === '@ai-sdk/google') {
        return 'thinking';
    }
    if (npm === '@ai-sdk/openai' || npm === '@ai-sdk/xai') {
        return 'reasoningEffort';
    }

    return undefined;
}

/**
 * 根据模型名称推断 reasoningEffort 可选值
 *
 * 来源：项目内置 provider config JSON 中各模型系列的实际参数值
 *
 * 匹配规则（按模型 ID 前缀/关键字匹配）：
 * - gpt-5.x / o1 / o3 / o4 系列 → ["none", "low", "medium", "high", "xhigh"]  （OpenAI 原生推理模型）
 * - deepseek-v4 系列            → ["high", "max", "none"]                       （DeepSeek V4）
 * - doubao-seed / doubao-seed-2  → ["minimal", "low", "medium", "high"]          （豆包系列）
 * - grok 系列                    → ["low", "high"]                               （xAI，d.ts 约束 chat 仅 low/high）
 * - claude-opus-4.7 / mythos     → ["low", "medium", "high", "xhigh", "max"]     （Anthropic effort 全量）
 * - claude-opus-4.6 / sonnet-4.6 → ["low", "medium", "high", "max"]              （Anthropic effort，无 xhigh）
 * - claude-opus-4.5              → ["low", "medium", "high"]                     （Anthropic effort 基础）
 */
function inferReasoningEffortByModel(modelId: string, npm?: string): ModelConfig['reasoningEffort'] {
    const id = modelId.toLowerCase();

    // xAI d.ts 约束：chat 模式仅支持 low/high
    if (npm === '@ai-sdk/xai') {
        return ['low', 'high'];
    }

    // Claude 新模型 effort 参数（官方文档 2025-05）
    if (/claude-(opus-4\.7|mythos)/.test(id)) {
        return ['low', 'medium', 'high', 'xhigh', 'max'];
    }
    if (/claude-(opus-4\.6|sonnet-4\.6)/.test(id)) {
        return ['low', 'medium', 'high', 'max'];
    }
    if (id.includes('claude-opus-4.5')) {
        return ['low', 'medium', 'high'];
    }

    // DeepSeek V4 系列
    if (id.includes('deepseek-v4')) {
        return ['high', 'max', 'none'];
    }

    // 豆包系列
    if (id.includes('doubao-seed')) {
        return ['minimal', 'low', 'medium', 'high'];
    }

    // OpenAI 推理模型：o1/o3/o4/gpt-5.x 系列（d.ts 约束支持 none~xhigh）
    if (/^(o[134]|gpt-5)/i.test(id) || id.includes('gpt-5')) {
        return ['none', 'low', 'medium', 'high', 'xhigh'];
    }

    // 兜底：根据 SDK 类型给通用值
    if (npm === '@ai-sdk/openai') {
        return ['none', 'low', 'medium', 'high', 'xhigh'];
    }

    return undefined;
}

/**
 * 根据模型名称推断 thinking 可选值
 *
 * 来源：项目内置 provider config JSON 中各模型系列的实际参数值
 *
 * 匹配规则：
 * - qwen 系列    → ["enabled", "disabled"]
 * - glm 系列     → ["enabled", "disabled"]
 * - kimi 系列    → ["enabled", "disabled"]
 * - mimo 系列    → ["enabled", "disabled"]
 * - claude 系列  → ["enabled", "disabled"]
 * - gemini 系列  → ["enabled", "disabled"]
 * - 其他         → 兜底 ["enabled", "disabled"]
 */
function inferThinkingByModel(_modelId: string): ModelConfig['thinking'] {
    return ['enabled', 'disabled'];
}

/** 推断 Gemini 3 的 thinkingLevel 可选值 */
function inferThinkingLevelByModel(): ModelConfig['thinkingLevel'] {
    return ['minimal', 'low', 'medium', 'high'];
}

export class ModelsDevService {
    private static readonly API_URL = 'https://models.dev/api.json';
    private static readonly CACHE_FILE_NAME = 'models-dev-api.json';
    private static cache: ModelsDevAPI | null = null;
    private static cacheExpiry: number = 0;
    private static readonly CACHE_TTL = 24 * 60 * 60 * 1000; // 24 小时
    private static storageDir: string | undefined;

    /**
     * 初始化服务，设置本地缓存目录
     * @param cacheDir 扩展 globalStorageUri.fsPath
     */
    static init(cacheDir: string): void {
        this.storageDir = cacheDir;
        Logger.info(`[ModelsDevService] Cache directory: ${cacheDir}`);
    }

    /** 获取本地缓存文件路径 */
    private static get cacheFilePath(): string | undefined {
        return this.storageDir ? path.join(this.storageDir, this.CACHE_FILE_NAME) : undefined;
    }

    /** 将数据写入本地文件缓存 */
    private static async writeLocalCache(data: ModelsDevAPI): Promise<void> {
        const filePath = this.cacheFilePath;
        if (!filePath) {
            return;
        }

        try {
            await fs.promises.mkdir(this.storageDir!, { recursive: true });
            await fs.promises.writeFile(filePath, JSON.stringify(data), 'utf-8');
            Logger.trace('[ModelsDevService] Local cache written');
        } catch (error) {
            Logger.warn('[ModelsDevService] Failed to write local cache:', error);
        }
    }

    /** 从本地文件缓存读取，失败返回 null */
    private static async readLocalCache(): Promise<ModelsDevAPI | null> {
        const filePath = this.cacheFilePath;
        if (!filePath) {
            return null;
        }

        try {
            const content = await fs.promises.readFile(filePath, 'utf-8');
            const data = JSON.parse(content);
            if (data && typeof data === 'object') {
                Logger.info('[ModelsDevService] Loaded data from local cache');
                return data as ModelsDevAPI;
            }
        } catch {
            // 文件不存在或解析失败，静默忽略
        }

        return null;
    }

    /**
     * 获取所有提供商和模型数据
     * 优先使用内存缓存 → 网络请求（成功后写入本地文件） → 本地文件兜底
     */
    static async fetchData(): Promise<ModelsDevAPI> {
        // 1. 内存缓存有效，直接返回
        if (this.cache && Date.now() < this.cacheExpiry) {
            Logger.trace('[ModelsDevService] Using memory cache');
            return this.cache;
        }

        Logger.info('[ModelsDevService] Fetching data from models.dev');

        try {
            const response = await fetch(this.API_URL);

            if (!response.ok) {
                throw new Error(`HTTP ${response.status}: ${response.statusText}`);
            }

            const data = await response.json();

            // 验证数据格式（API 返回扁平结构，provider ID 直接是顶层键）
            if (!data || typeof data !== 'object') {
                Logger.error('[ModelsDevService] Invalid API response format');
                Logger.error(`[ModelsDevService] Response type: ${typeof data}`);
                throw new Error('Invalid API response: not an object');
            }

            const typedData = data as ModelsDevAPI;

            // 更新内存缓存
            this.cache = typedData;
            this.cacheExpiry = Date.now() + this.CACHE_TTL;

            // 异步写入本地文件缓存（不阻塞）
            this.writeLocalCache(typedData);

            const providerCount = Object.keys(typedData).length;
            Logger.info(`[ModelsDevService] Fetched ${providerCount} providers`);

            return typedData;
        } catch (error) {
            Logger.error('[ModelsDevService] Failed to fetch data:', error);

            // 网络失败，尝试从本地文件缓存兜底
            const localData = await this.readLocalCache();
            if (localData) {
                this.cache = localData;
                // 兜底数据 TTL 缩短为 1 小时，以便尽快重试网络
                this.cacheExpiry = Date.now() + 60 * 60 * 1000;
                Logger.info('[ModelsDevService] Using local cache as fallback (TTL reduced to 1h)');
                return localData;
            }

            throw error;
        }
    }

    /**
     * 获取指定提供商的所有模型（返回 ModelConfig 格式）
     */
    static async getProviderModels(providerId: string): Promise<ModelConfig[]> {
        const data = await this.fetchData();

        Logger.trace(`[ModelsDevService] Available providers: ${Object.keys(data).join(', ')}`);

        const provider = data[providerId];

        if (!provider) {
            Logger.warn(`[ModelsDevService] Provider not found: ${providerId}`);
            Logger.warn(`[ModelsDevService] Available providers: ${Object.keys(data).slice(0, 20).join(', ')}...`);
            return [];
        }

        const models: ModelConfig[] = [];

        for (const [modelId, model] of Object.entries(provider.models)) {
            const inputModalities = model.modalities?.input || [];
            const maxInput = model.limit?.context || model.limit?.input || 8192;
            const maxOutput = model.limit?.output || 4096;

            const thinkingMode = model.reasoning ? inferThinkingModeByModel(modelId, provider.npm) : undefined;

            models.push({
                // ID 格式：{providerId}:::{modelId}（与 genericModelProvider 一致）
                id: `${provider.id}:::${modelId}`,
                // 名称格式：{modelName} ({providerName})
                name: `${model.name || modelId} (${provider.name})`,
                tooltip: '',
                maxInputTokens: maxInput,
                maxOutputTokens: maxOutput,
                capabilities: {
                    toolCalling: model.tool_call ?? false,
                    imageInput: inputModalities.includes('image')
                },
                reasoning: model.reasoning,
                thinkingMode,
                thinking: thinkingMode === 'thinking' ? inferThinkingByModel(modelId) : undefined,
                reasoningEffort:
                    thinkingMode === 'reasoningEffort' ? inferReasoningEffortByModel(modelId, provider.npm) : undefined,
                thinkingLevel: thinkingMode === 'thinkingLevel' ? inferThinkingLevelByModel() : undefined,
                // 原始模型 ID，用于 API 请求
                model: modelId,
                // 保留原始 provider ID，用于 API 调用
                provider: provider.id
            });
        }

        Logger.info(`[ModelsDevService] Found ${models.length} models for ${providerId}`);
        return models;
    }

    /**
     * 获取 Provider 配置信息
     */
    static async getProviderInfo(providerId: string): Promise<ProviderInfo | null> {
        const data = await this.fetchData();
        const provider = data[providerId];

        if (!provider) {
            Logger.warn(`[ModelsDevService] Provider not found: ${providerId}`);
            return null;
        }

        return {
            id: provider.id,
            name: provider.name,
            npm: provider.npm,
            api: provider.api,
            env: provider.env,
            doc: provider.doc
        };
    }

    /**
     * 获取所有提供商信息
     */
    static async getAllProviders(): Promise<ProviderInfo[]> {
        const data = await this.fetchData();
        return Object.values(data).map(provider => ({
            id: provider.id,
            name: provider.name,
            npm: provider.npm,
            api: provider.api,
            env: provider.env,
            doc: provider.doc
        }));
    }

    /**
     * 获取所有提供商和模型（返回 ModelConfig 格式）
     */
    static async getAllModels(): Promise<ModelConfig[]> {
        const data = await this.fetchData();
        const allModels: ModelConfig[] = [];

        for (const provider of Object.values(data)) {
            for (const [modelId, model] of Object.entries(provider.models)) {
                const inputModalities = model.modalities?.input || [];
                const maxInput = model.limit?.context || model.limit?.input || 8192;
                const maxOutput = model.limit?.output || 4096;

                const thinkingMode = model.reasoning ? inferThinkingModeByModel(modelId, provider.npm) : undefined;

                allModels.push({
                    // ID 格式：{providerId}:::{modelId}
                    id: `${provider.id}:::${modelId}`,
                    // 名称格式：{modelName} ({providerName})
                    name: `${model.name || modelId} (${provider.name})`,
                    tooltip: '',
                    maxInputTokens: maxInput,
                    maxOutputTokens: maxOutput,
                    capabilities: {
                        toolCalling: model.tool_call ?? false,
                        imageInput: inputModalities.includes('image')
                    },
                    reasoning: model.reasoning,
                    thinkingMode,
                    thinking: thinkingMode === 'thinking' ? inferThinkingByModel(modelId) : undefined,
                    reasoningEffort:
                        thinkingMode === 'reasoningEffort' ?
                            inferReasoningEffortByModel(modelId, provider.npm)
                        :   undefined,
                    thinkingLevel: thinkingMode === 'thinkingLevel' ? inferThinkingLevelByModel() : undefined,
                    // 保留原始 provider ID
                    provider: provider.id
                });
            }
        }

        Logger.info(
            `[ModelsDevService] Found ${allModels.length} total models from ${Object.keys(data).length} providers`
        );
        return allModels;
    }

    /**
     * 清除缓存
     */
    static clearCache(): void {
        this.cache = null;
        this.cacheExpiry = 0;
        Logger.info('[ModelsDevService] Cache cleared');
    }
}
