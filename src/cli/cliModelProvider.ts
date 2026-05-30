/*---------------------------------------------------------------------------------------------
 *  CLI 认证专用 Provider
 *  继承 GenericModelProvider，支持 CLI 认证模式
 *  支持 qwen-code、gemini、codex 等 CLI 认证提供商
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import {
    LanguageModelChatMessage,
    LanguageModelChatInformation,
    ProvideLanguageModelChatResponseOptions,
    Progress,
    CancellationToken,
    PrepareLanguageModelChatModelOptions
} from 'vscode';
import { ProviderConfig, ModelConfig } from '../types/sharedTypes';
import { ApiKeyManager, Logger } from '../utils';
import { GenericModelProvider } from '../providers/genericModelProvider';
import { CliWizard } from './cliWizard';
import { CliAuthFactory } from './auth/cliAuthFactory';
import { StatusBarManager } from '../status';
import { t } from '../utils/l10n';
import type { CodexModelInfo } from './auth/codexCliAuth';

/** 动态模型列表缓存有效期：1 小时 */
const DYNAMIC_MODELS_CACHE_TTL_MS = 60 * 60 * 1000;

/**
 * CLI 认证专用模型提供商类
 * 继承 GenericModelProvider，支持 CLI 认证模式
 * 适用于所有使用 CLI 认证的提供商（qwen-code、gemini、codex 等）
 */
export class CliModelProvider extends GenericModelProvider {
    /** Codex 动态模型缓存（从 API 获取的可用模型列表） */
    private codexDynamicModels: CodexModelInfo[] | null = null;
    /** Codex 动态模型缓存时间戳 */
    private codexDynamicModelsTimestamp: number = 0;
    /** 正在进行的模型获取 Promise（防止并发重复请求） */
    private codexDynamicModelsFetchPromise: Promise<CodexModelInfo[] | null> | null = null;
    /** Codex 最终模型列表缓存（合并 + 过滤后的 ModelConfig[]，避免重复计算） */
    private codexModelsResultCache: ModelConfig[] | null = null;
    /** Codex 最终模型列表缓存时间戳 */
    private codexModelsResultCacheTimestamp: number = 0;
    /** 动态模型配置的快速查找映射（模型 ID → ModelConfig），用于提供 request 时查找 */
    private dynamicModelConfigMap: Map<string, ModelConfig> = new Map<string, ModelConfig>();

    constructor(context: vscode.ExtensionContext, providerKey: string, providerConfig: ProviderConfig) {
        super(context, providerKey, providerConfig);
    }

    /**
     * 使 Codex 动态模型缓存失效，强制下次请求时重新从 API 获取
     */
    invalidateCodexDynamicModelsCache(): void {
        this.codexDynamicModels = null;
        this.codexDynamicModelsTimestamp = 0;
        this.codexDynamicModelsFetchPromise = null;
        this.codexModelsResultCache = null;
        this.codexModelsResultCacheTimestamp = 0;
        this.dynamicModelConfigMap.clear();
        Logger.debug('[CliModelProvider] Codex dynamic models cache invalidated');
    }

    /**
     * 重写模型信息提供方法
     * 当没有 API 密钥时，启动配置向导而不是要求输入 API 密钥
     */
    async provideLanguageModelChatInformation(
        options: PrepareLanguageModelChatModelOptions & { silent: boolean },
        token: vscode.CancellationToken
    ): Promise<vscode.LanguageModelChatInformation[]> {
        if (options.configuration) {
            // 如果请求中包含 configuration，不返回模型列表
            return [];
        }

        // 检查是否有有效的 API 密钥
        let hasApiKey: boolean;
        if (options.silent) {
            hasApiKey = await Promise.race([
                ApiKeyManager.ensureApiKey(this.providerKey, this.providerConfig.displayName, false),
                new Promise<boolean>(resolve => setTimeout(() => resolve(false), 500)) // 500ms timeout
            ]);
        } else {
            // 非静默模式下，直接触发用户交互确保有密钥
            await vscode.commands.executeCommand(`gcmp.${this.providerKey}.configWizard`);
            hasApiKey = await ApiKeyManager.ensureApiKey(this.providerKey, this.providerConfig.displayName, false);
            options.silent = true; // 后续调用调整为静默模式
        }
        if (!hasApiKey) {
            // 如果是静默模式（如扩展启动时），不触发用户交互，直接返回空列表
            if (options.silent) {
                return [];
            }
            try {
                const credentials = await CliAuthFactory.ensureAuthenticated(this.providerKey);
                if (credentials) {
                    await ApiKeyManager.setApiKey(this.providerKey, credentials.access_token);
                    Logger.info(`[CliModelProvider] Loaded credentials from ${this.providerKey} CLI`);
                } else {
                    await vscode.commands.executeCommand(`gcmp.${this.providerKey}.configWizard`);
                    // 无法获取凭证，返回空列表
                    Logger.warn(`[CliModelProvider] Unable to load credentials from ${this.providerKey} CLI`);
                    return [];
                }
            } catch (error) {
                Logger.warn(`[CliModelProvider] Failed to load credentials from ${this.providerKey} CLI:`, error);
                return [];
            }
        }

        // 对 Codex 提供商：合并动态模型列表并过滤 proRequired
        if (this.providerKey === 'codex') {
            return this.provideCodexModels(options, token);
        }

        // 其他提供商：调用父类方法返回模型列表
        return super.provideLanguageModelChatInformation(options, token);
    }

    /**
     * 提供 Codex 模型列表
     * 1. 从 API 获取可用模型列表（带缓存）
     * 2. 与硬编码配置合并（API 决定哪些模型可用，硬编码提供详细属性）
     * 3. 过滤 proRequired 模型（非 Pro 账号不显示 Pro 专属模型）
     */
    private async provideCodexModels(
        _options: PrepareLanguageModelChatModelOptions & { silent: boolean },
        _token: vscode.CancellationToken
    ): Promise<vscode.LanguageModelChatInformation[]> {
        // 检查最终结果缓存是否有效（避免 VS Code 反复调用时重复计算合并+过滤）
        const now = Date.now();
        if (this.codexModelsResultCache !== null && (now - this.codexModelsResultCacheTimestamp) < DYNAMIC_MODELS_CACHE_TTL_MS) {
            Logger.trace(`[CliModelProvider] Using cached result (${this.codexModelsResultCache.length} models, age: ${((now - this.codexModelsResultCacheTimestamp) / 1000).toFixed(0)}s)`);
            return this.codexModelsResultCache.map(model => this.modelConfigToInfo(model));
        }

        // 1. 尝试从 API 获取可用模型列表
        const dynamicModels = await this.fetchCodexDynamicModels();

        // 2. 合并模型列表
        let effectiveModels: ModelConfig[];
        if (dynamicModels !== null) {
            // API 成功：以 API 返回的模型为准，用硬编码配置补充属性
            effectiveModels = this.mergeCodexModels(dynamicModels);
            Logger.debug(`[CliModelProvider] Using ${effectiveModels.length} merged models (API: ${dynamicModels.length}, hardcoded: ${this.providerConfig.models.length})`);
        } else {
            // API 失败：降级使用全部硬编码模型
            effectiveModels = this.providerConfig.models;
            Logger.debug(`[CliModelProvider] API fetch failed, falling back to ${effectiveModels.length} hardcoded models`);
        }

        // 3. 根据当前账号的 plan_type 与模型的 available_in_plans 进行比对过滤
        let filteredModels: ModelConfig[];
        if (dynamicModels !== null) {
            // 构建模型 ID → CodexModelInfo 映射
            const dynamicModelsMap = new Map<string, CodexModelInfo>();
            for (const dm of dynamicModels) {
                dynamicModelsMap.set(dm.id, dm);
            }

            // 获取当前账号的 plan_type
            const planType = await this.getCodexPlanType();
            if (planType) {
                filteredModels = effectiveModels.filter(model => {
                    const dm = dynamicModelsMap.get(model.id);
                    if (!dm || dm.availableInPlans.length === 0) {
                        // 无 API 数据的模型保留（不应发生，防御性处理）
                        return true;
                    }
                    // 当前账号的 plan_type 在模型的 available_in_plans 中则保留
                    const available = dm.availableInPlans.includes(planType);
                    Logger.trace(`[CliModelProvider] Model ${model.id}: plan=${planType}, available=${available} (plans: ${dm.availableInPlans.join(',')})`);
                    return available;
                });
                Logger.debug(`[CliModelProvider] Filtered to ${filteredModels.length} models for plan '${planType}'`);
            } else {
                // 无法获取 plan_type，降级不过滤
                filteredModels = effectiveModels;
                Logger.debug(`[CliModelProvider] Could not determine plan type, showing all ${effectiveModels.length} models`);
            }
        } else {
            // API 失败时使用硬编码的 proRequired 过滤
            const isPro = await this.isCodexProAccount();
            filteredModels = isPro
                ? effectiveModels
                : effectiveModels.filter(model => !model.proRequired);
        }

        // 4. 将模型配置转换为 VS Code 格式
        // 缓存最终结果，避免 VS Code 反复调用时重复计算
        this.codexModelsResultCache = filteredModels;
        this.codexModelsResultCacheTimestamp = Date.now();
        // 更新动态模型配置映射，供 findModelConfigById 查找
        this.dynamicModelConfigMap.clear();
        for (const model of filteredModels) {
            this.dynamicModelConfigMap.set(model.id, model);
        }
        return filteredModels.map(model => this.modelConfigToInfo(model));
    }

    /**
     * 从 Codex API 获取可用模型列表（带 5 分钟缓存）
     * @returns 模型信息列表；获取失败返回 null（调用方应降级使用硬编码模型）
     */
    private async fetchCodexDynamicModels(): Promise<CodexModelInfo[] | null> {
        // 检查缓存是否有效
        const now = Date.now();
        if (this.codexDynamicModels !== null && (now - this.codexDynamicModelsTimestamp) < DYNAMIC_MODELS_CACHE_TTL_MS) {
            Logger.trace(`[CliModelProvider] Using cached dynamic models (${this.codexDynamicModels.length} models, age: ${((now - this.codexDynamicModelsTimestamp) / 1000).toFixed(0)}s)`);
            return this.codexDynamicModels;
        }

        // 防止并发重复请求：如果已有正在进行的请求，复用同一个 Promise
        if (this.codexDynamicModelsFetchPromise) {
            Logger.trace('[CliModelProvider] Reusing in-flight fetch promise');
            return this.codexDynamicModelsFetchPromise;
        }

        this.codexDynamicModelsFetchPromise = this.doFetchCodexDynamicModels();
        try {
            return await this.codexDynamicModelsFetchPromise;
        } finally {
            this.codexDynamicModelsFetchPromise = null;
        }
    }

    /**
     * 实际执行从 Codex API 获取可用模型列表
     */
    private async doFetchCodexDynamicModels(): Promise<CodexModelInfo[] | null> {
        try {
            const { CodexCliAuth } = await import('./auth/codexCliAuth');
            const codexAuth = CliAuthFactory.getInstance('codex');
            if (!(codexAuth instanceof CodexCliAuth)) {
                return null;
            }

            const models = await codexAuth.fetchAvailableModels();
            if (models !== null && models.length > 0) {
                // 更新缓存
                this.codexDynamicModels = models;
                this.codexDynamicModelsTimestamp = Date.now();
                return models;
            }

            return null;
        } catch (error) {
            Logger.debug(`[CliModelProvider] Failed to fetch dynamic models: ${error instanceof Error ? error.message : String(error)}`);
            return null;
        }
    }

    /**
     * 合并 API 返回的动态模型与硬编码模型配置
     * - API 返回的模型决定哪些模型可见
     * - 硬编码配置提供详细属性（maxInputTokens, tooltip, sdkMode 等）
     * - API 中有但硬编码没有的模型，使用默认属性
     */
    private mergeCodexModels(dynamicModels: CodexModelInfo[]): ModelConfig[] {
        const hardcodedMap = new Map<string, ModelConfig>();
        for (const model of this.providerConfig.models) {
            hardcodedMap.set(model.id, model);
        }

        const result: ModelConfig[] = [];
        for (const dynamicModel of dynamicModels) {
            const modelId = dynamicModel.id;
            const hardcoded = hardcodedMap.get(modelId);
            if (hardcoded) {
                // 硬编码中有此模型，用 API 数据覆盖 context_window 和 reasoningEffort
                const merged: ModelConfig = { ...hardcoded };
                merged.maxInputTokens = dynamicModel.contextWindow || hardcoded.maxInputTokens;
                if (dynamicModel.reasoningEfforts.length > 0) {
                    merged.reasoningEffort = dynamicModel.reasoningEfforts;
                }
                result.push(merged);
                hardcodedMap.delete(modelId);
            } else {
                // 新模型：硬编码中没有，使用 API 数据填充属性
                Logger.debug(`[CliModelProvider] Discovered new Codex model from API: ${modelId}`);
                result.push({
                    id: modelId,
                    name: dynamicModel.displayName || `${modelId} (ChatGPT)`,
                    tooltip: `ChatGPT 提供的 ${dynamicModel.displayName || modelId} 模型，通过 Codex 端点访问`,
                    maxInputTokens: dynamicModel.contextWindow || 200000,
                    maxOutputTokens: 100000,
                    sdkMode: 'openai-responses',
                    useInstructions: true,
                    reasoningEffort: dynamicModel.reasoningEfforts.length > 0 ? dynamicModel.reasoningEfforts : ['low', 'medium', 'high'],
                    capabilities: { toolCalling: true, imageInput: true },
                    extraBody: {
                        store: false,
                        tool_choice: 'auto',
                        reasoning: { effort: 'medium', summary: 'auto' }
                    }
                });
            }
        }

        // 注意：API 中没有但硬编码中有的模型不再追加（API 决定可用性）
        return result;
    }

    /**
     * 获取 Codex 账号的 plan_type
     * 通过 wham/usage API 查询
     * @returns plan_type（如 'free', 'plus', 'pro'），查询失败返回 null
     */
    private async getCodexPlanType(): Promise<string | null> {
        try {
            const { CodexCliAuth } = await import('./auth/codexCliAuth');
            const codexAuth = CliAuthFactory.getInstance('codex');
            if (codexAuth instanceof CodexCliAuth) {
                const planType = await codexAuth.getPlanType();
                Logger.debug(`[CliModelProvider] Codex plan type: ${planType}`);
                return planType;
            }
        } catch (error) {
            Logger.debug(`[CliModelProvider] Failed to get Codex plan type: ${error instanceof Error ? error.message : String(error)}`);
        }
        return null;
    }

    /**
     * 检查 Codex 账号是否为 Pro 订阅
     * 通过 wham/usage API 查询 plan_type（与状态栏一致的判断方式）
     */
    private async isCodexProAccount(): Promise<boolean> {
        try {
            const { CodexCliAuth } = await import('./auth/codexCliAuth');
            const codexAuth = CliAuthFactory.getInstance('codex');
            if (codexAuth instanceof CodexCliAuth) {
                const planType = await codexAuth.getPlanType();
                Logger.debug(`[CliModelProvider] Codex plan type: ${planType}`);
                return planType === 'pro';
            }
        } catch (error) {
            Logger.debug(`[CliModelProvider] Failed to check Codex plan type: ${error instanceof Error ? error.message : String(error)}`);
        }

        return false;
    }

    /**
     * 静态工厂方法 - 创建并激活 CLI 认证提供商
     */
    static createAndActivate(
        context: vscode.ExtensionContext,
        providerKey: string,
        providerConfig: ProviderConfig
    ): { provider: CliModelProvider; disposables: vscode.Disposable[] } {
        Logger.trace(`${providerConfig.displayName} CLI-authenticated model provider activated`);
        // 创建提供商实例
        const provider = new CliModelProvider(context, providerKey, providerConfig);
        // 注册语言模型聊天提供商
        const providerDisposable = vscode.lm.registerLanguageModelChatProvider(`gcmp.${providerKey}`, provider);

        // 注册设置API密钥命令
        const setApiKeyCommand = vscode.commands.registerCommand(`gcmp.${providerKey}.setApiKey`, async () => {
            await ApiKeyManager.promptAndSetApiKey(
                providerKey,
                providerConfig.displayName,
                providerConfig.apiKeyTemplate
            );
            // API 密钥变更后清除缓存
            await provider.modelInfoCache?.invalidateCache(providerKey);
            // 触发模型信息变更事件
            provider._onDidChangeLanguageModelChatInformation.fire();
        });

        // 注册配置向导命令
        const configWizardCommand = vscode.commands.registerCommand(`gcmp.${providerKey}.configWizard`, async () => {
            await CliModelProvider.startConfigWizard(providerKey, providerConfig.displayName);
            // 配置变更后清除缓存
            await provider.modelInfoCache?.invalidateCache(providerKey);
            // 触发模型信息变更事件
            provider._onDidChangeLanguageModelChatInformation.fire();
        });

        // 注册刷新模型列表命令（仅 Codex 提供商需要动态刷新模型）
        const refreshModelsCommand = providerKey === 'codex'
            ? vscode.commands.registerCommand(`gcmp.${providerKey}.refreshModels`, async () => {
                // 清除动态模型缓存，强制重新获取
                provider.invalidateCodexDynamicModelsCache();
                // 清除模型信息缓存
                await provider.modelInfoCache?.invalidateCache(providerKey);
                // 触发模型信息变更事件
                provider._onDidChangeLanguageModelChatInformation.fire();
                vscode.window.showInformationMessage(
                    t('Codex model list refreshed', 'Codex 模型列表已刷新')
                );
            })
            : null;

        const disposables = [providerDisposable, setApiKeyCommand, configWizardCommand];
        if (refreshModelsCommand) {
            disposables.push(refreshModelsCommand);
        }
        disposables.forEach(disposable => context.subscriptions.push(disposable));
        return { provider, disposables };
    }

    /**
     * 根据提供商启动对应的配置向导
     * @param providerKey 提供商标识
     * @param displayName 显示名称
     */
    private static async startConfigWizard(providerKey: string, displayName: string): Promise<void> {
        // 获取支持的 CLI 类型列表
        const supportedCliTypes = CliAuthFactory.getSupportedCliTypes();
        const supportedCliIds = supportedCliTypes.map(cli => cli.id);
        // 检查是否是支持的 CLI 类型
        if (!supportedCliIds.includes(providerKey)) {
            Logger.warn(`[CliProvider] Unknown CLI-authenticated provider: ${providerKey}`);
            vscode.window.showWarningMessage(t('Unknown provider: {0}', '未知的提供商: {0}', providerKey));
            return;
        }
        // 使用统一的 CLI 向导
        await CliWizard.startWizard(providerKey, displayName);
    }

    /**
     * 覆盖 provideChatResponse 以在请求完成后更新状态栏
     */
    override async provideLanguageModelChatResponse(
        model: LanguageModelChatInformation,
        messages: Array<LanguageModelChatMessage>,
        options: ProvideLanguageModelChatResponseOptions,
        progress: Progress<vscode.LanguageModelResponsePart>,
        token: CancellationToken
    ): Promise<void> {
        try {
            // 调用父类的实现
            await super.provideLanguageModelChatResponse(model, messages, options, progress, token);
        } finally {
            // 请求完成后，延时更新状态栏使用量
            StatusBarManager.getStatusBar(this.providerKey)?.delayedUpdate(200);
        }
    }

    /**
     * 覆盖模型配置查找，优先从动态模型映射中查找
     * 动态添加的模型（如从 Codex API 获取的新模型）不在 providerConfig.models 中，
     * 需要通过此方法从 dynamicModelConfigMap 中查找
     */
    protected override findModelConfigById(model: LanguageModelChatInformation): ModelConfig | undefined {
        // 先尝试从父类查找硬编码配置
        const hardcoded = super.findModelConfigById(model);
        if (hardcoded) {
            return hardcoded;
        }
        // 从动态模型映射中查找
        // 解析模型 ID：格式为 gcmp.${provider}:::${modelId}
        const prefixSeparator = ':::';
        if (model.id.includes(prefixSeparator)) {
            const match = model.id.match(/^gcmp\.([^:]+?):::(.+)$/);
            if (match) {
                const rawModelId = match[2];
                const dynamicModel = this.dynamicModelConfigMap.get(rawModelId);
                if (dynamicModel) {
                    return dynamicModel;
                }
            }
        }
        // 直接用模型 ID 查找动态映射
        const dynamicModel = this.dynamicModelConfigMap.get(model.id);
        if (dynamicModel) {
            return dynamicModel;
        }
        return undefined;
    }
}
