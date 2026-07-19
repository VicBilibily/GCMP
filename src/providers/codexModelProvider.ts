/*---------------------------------------------------------------------------------------------
 *  Codex 模型提供商
 *  通过 Codex CLI OAuth 认证，从 ChatGPT 后端动态拉取可用模型列表
 *  支持缓存、配置变更监听、远端拉取失败时回退到本地预置模型
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { CancellationToken, LanguageModelChatInformation, PrepareLanguageModelChatModelOptions } from 'vscode';
import { CliModelProvider } from '../cli/cliModelProvider';
import { CliAuthFactory } from '../cli/auth/cliAuthFactory';
import { ModelConfig, ProviderConfig } from '../types/sharedTypes';
import { ApiKeyManager } from '../utils/config/apiKeyManager';
import { ConfigManager } from '../utils/config/configManager';
import { Logger } from '../utils/runtime/logger';
import { parseCodexModelsResponse } from '../utils/model/codexModels';

/** Codex 后端模型列表 API 地址 */
const CODEX_MODELS_URL = 'https://chatgpt.com/backend-api/codex/models';
/** 全局存储中缓存远端模型列表的键名 */
const CACHE_KEY = 'gcmp_codex_models_v1';
/** 缓存有效期（24 小时） */
const CACHE_EXPIRY_MS = 24 * 60 * 60 * 1000;

/** 缓存在 globalState 中的远端模型数据快照 */
interface CachedCodexModels {
    /** 写入缓存时的扩展版本，用于版本变更时失效 */
    extensionVersion: string;
    /** 写入缓存时的 API Key 哈希，用于密钥切换时失效 */
    apiKeyHash: string;
    /** 缓存时间戳 */
    timestamp: number;
    /** 缓存的模型配置列表 */
    models: ModelConfig[];
}

/**
 * Codex 模型提供商
 *
 * 继承 CliModelProvider，通过 Codex CLI OAuth 认证访问 ChatGPT 后端，
 * 动态拉取可用模型列表，并支持本地预置模型与远端模型的整合策略：
 * - 本地预置模型保持完整配置，远端仅控制显示/隐藏
 * - 远端独有的模型自动创建默认配置
 * - 远端拉取失败时回退到本地预置模型
 */
export class CodexModelProvider extends CliModelProvider {
    /** 扩展上下文，用于访问 globalState 缓存 */
    private readonly context: vscode.ExtensionContext;
    /** 本地预置的静态模型配置（codex.json），远端失败时回退到此配置 */
    private readonly staticProviderConfig: ProviderConfig;
    /** 监听 gcmp.providerOverrides 配置变更，变更时清除缓存 */
    private readonly codexConfigListener: vscode.Disposable;
    /** 并发拉取模型列表的去重 Promise，避免重复请求 */
    private refreshPromise?: Promise<ModelConfig[]>;
    /** 当前共享刷新请求的等待者数量，仅最后一个等待者取消时才中止 HTTP 请求 */
    private dynamicModelWaiterCount = 0;
    /** 当前飞行中 HTTP 请求的 AbortController，用于取消时终止网络请求 */
    private currentAbortController?: AbortController;

    /**
     * @param context 扩展上下文
     * @param providerConfig 从 codex.json 加载的预置配置
     */
    constructor(context: vscode.ExtensionContext, providerConfig: ProviderConfig) {
        super(context, 'codex', providerConfig);
        this.context = context;
        this.staticProviderConfig = providerConfig;
        // 监听 providerOverrides 配置变化，变化时清除 globalState 缓存
        // 迫使下次请求重新拉取远端模型列表，确保覆盖配置立即生效
        this.codexConfigListener = vscode.workspace.onDidChangeConfiguration(event => {
            if (event.affectsConfiguration('gcmp.providerOverrides')) {
                void this.context.globalState.update(CACHE_KEY, undefined);
            }
        });
        context.subscriptions.push(this.codexConfigListener);
    }

    /**
     * 静态工厂方法 — 创建并激活 Codex 模型提供商
     * 注册 LanguageModelChatProvider 与配置向导命令
     */
    static createAndActivate(
        context: vscode.ExtensionContext,
        _providerKey: string,
        providerConfig: ProviderConfig
    ): { provider: CodexModelProvider; disposables: vscode.Disposable[] } {
        const provider = new CodexModelProvider(context, providerConfig);
        const providerDisposable = vscode.lm.registerLanguageModelChatProvider('gcmp.codex', provider);
        const configWizardCommand = vscode.commands.registerCommand('gcmp.codex.configWizard', async () => {
            await CodexModelProvider.startConfigWizard('codex', providerConfig.displayName);
            await provider.invalidateModelCaches();
            provider._onDidChangeLanguageModelChatInformation.fire();
        });

        const disposables = [providerDisposable, configWizardCommand];
        disposables.forEach(disposable => context.subscriptions.push(disposable));
        return { provider, disposables };
    }

    /**
     * 提供语言模型聊天信息
     *
     * 流程说明：
     * 1. 先调用父类获取初始模型列表（含本地预置 + modelInfoCache 中的缓存）
     * 2. 若非配置查询（configuration !== true）、有可用模型、未被取消，则尝试远端动态拉取
     * 3. 远端成功 → 应用远端模型列表并更新缓存
     * 4. 远端失败 → 回退到本地预置模型
     * 5. 模型列表有变化时通过 _onDidChangeLanguageModelChatInformation 通知 VS Code
     */
    override async provideLanguageModelChatInformation(
        options: PrepareLanguageModelChatModelOptions & { silent: boolean },
        token: CancellationToken
    ): Promise<LanguageModelChatInformation[]> {
        const initialModels = await super.provideLanguageModelChatInformation(options, token);
        if (options.configuration || initialModels.length === 0 || token.isCancellationRequested) {
            return initialModels;
        }

        try {
            // 远端拉取成功：应用远端模型列表并缓存
            const models = await this.waitForDynamicModels(token);
            const previousModels = this.providerConfig.models;
            this.applyModels(models);
            const modelsChanged = this.haveModelsChanged(previousModels, this.providerConfig.models);
            const apiKeyHash = await this.getApiKeyHash();
            const infos = this.providerConfig.models.map(model => this.modelConfigToInfo(model));
            await this.modelInfoCache?.cacheModels(this.providerKey, infos, apiKeyHash);
            if (modelsChanged) {
                queueMicrotask(() => this._onDidChangeLanguageModelChatInformation.fire());
            }
            return infos;
        } catch (error) {
            // 远端拉取失败：回退到静态预置模型
            if (token.isCancellationRequested) {
                return initialModels;
            }
            const previousModels = this.providerConfig.models;
            this.applyModels(this.staticProviderConfig.models);
            const modelsChanged = this.haveModelsChanged(previousModels, this.providerConfig.models);
            Logger.warn(
                '[codex] Failed to refresh remote model list; using bundled models:',
                error instanceof Error ? error.message : String(error)
            );
            const infos = this.providerConfig.models.map(model => this.modelConfigToInfo(model));
            const apiKeyHash = await this.getApiKeyHash();
            await this.modelInfoCache?.cacheModels(this.providerKey, infos, apiKeyHash);
            if (modelsChanged) {
                queueMicrotask(() => this._onDidChangeLanguageModelChatInformation.fire());
            }
            return infos;
        }
    }

    /**
     * 等待远端模型列表加载完成，支持 VS Code 取消令牌
     * 将 refreshModels 的 Promise 与 CancellationToken 桥接，
     * 确保取消时能及时终止等待
     */
    private waitForDynamicModels(token: CancellationToken): Promise<ModelConfig[]> {
        if (token.isCancellationRequested) {
            return Promise.reject(new vscode.CancellationError());
        }

        const refresh = this.getDynamicModels();
        this.dynamicModelWaiterCount += 1;

        return new Promise<ModelConfig[]>((resolve, reject) => {
            let released = false;
            const releaseWaiter = (abortIfLast: boolean): void => {
                if (released) {
                    return;
                }
                released = true;
                this.dynamicModelWaiterCount = Math.max(0, this.dynamicModelWaiterCount - 1);
                if (abortIfLast && this.dynamicModelWaiterCount === 0 && this.refreshPromise === refresh) {
                    this.currentAbortController?.abort();
                }
            };

            const cancellation = token.onCancellationRequested(() => {
                cancellation.dispose();
                releaseWaiter(true);
                reject(new vscode.CancellationError());
            });
            refresh.then(
                models => {
                    cancellation.dispose();
                    releaseWaiter(false);
                    resolve(models);
                },
                error => {
                    cancellation.dispose();
                    releaseWaiter(false);
                    reject(error);
                }
            );
        });
    }

    /**
     * 获取或等待模型列表拉取结果
     * 通过 refreshPromise 保证同一时间只有一个拉取请求在进行
     */
    private getDynamicModels(): Promise<ModelConfig[]> {
        if (!this.refreshPromise) {
            this.refreshPromise = this.refreshModels().finally(() => {
                this.refreshPromise = undefined;
            });
        }
        return this.refreshPromise;
    }

    /**
     * 执行远端模型列表拉取请求
     *
     * 流程：
     * 1. 通过 CliAuthFactory 获取或刷新 OAuth 凭证
     * 2. 获取 API Key 哈希，检查 globalState 缓存（开发模式下跳过）
     * 3. 发送 HTTP GET 请求到 CODEX_MODELS_URL，携带 OAuth 令牌和 account ID
     * 4. 解析响应并写入缓存
     */
    private async refreshModels(): Promise<ModelConfig[]> {
        const credentials = await CliAuthFactory.ensureAuthenticated('codex');
        const accessToken = credentials?.access_token;
        if (!accessToken) {
            throw new Error('Codex access token is unavailable');
        }
        // 同步最新 OAuth 令牌到共享密钥存储：请求鉴权与缓存哈希均从 ApiKeyManager 读取，
        // 本次刷新出的新令牌需立即写入，避免后续请求携带已过期的旧令牌
        await ApiKeyManager.setApiKey('codex', accessToken);

        const apiKeyHash = await this.getApiKeyHash();
        const cached = this.getCachedModelConfigs(apiKeyHash);
        if (cached) {
            return cached;
        }

        const accountId = await CliAuthFactory.getCodexAccountId();
        if (!accountId) {
            throw new Error('ChatGPT account ID is unavailable; run Codex CLI login again');
        }

        const modelsUrl = new URL(CODEX_MODELS_URL);
        const clientVersion = this.providerConfig.customHeader?.version;
        if (clientVersion) {
            modelsUrl.searchParams.set('client_version', clientVersion);
        }
        const headers: Record<string, string> = {
            Accept: 'application/json',
            ...this.providerConfig.customHeader,
            Authorization: `Bearer ${accessToken}`,
            'chatgpt-account-id': accountId
        };

        this.currentAbortController = new AbortController();
        try {
            const response = await ConfigManager.fetchWithProxy(
                modelsUrl,
                { method: 'GET', headers, signal: this.currentAbortController.signal },
                { providerKey: 'codex' }
            );
            if (!response.ok) {
                throw new Error(`Codex models request failed with HTTP ${response.status}`);
            }

            const models = parseCodexModelsResponse(await response.json(), this.staticProviderConfig.models);
            if (models.length === 0) {
                throw new Error('Codex models response contains no selectable models');
            }

            await this.context.globalState.update(CACHE_KEY, {
                extensionVersion: this.extensionVersion,
                apiKeyHash,
                timestamp: Date.now(),
                models
            } satisfies CachedCodexModels);
            Logger.debug(`[codex] Remote model list updated (${models.length} models)`);
            return models;
        } finally {
            this.currentAbortController = undefined;
        }
    }

    /**
     * 从 globalState 中读取缓存（开发模式下跳过缓存）
     * 缓存失效条件：未命中、版本变更、API Key 变更、超过 24 小时、数据异常
     */
    private getCachedModelConfigs(apiKeyHash: string): ModelConfig[] | undefined {
        if (this.context.extensionMode === vscode.ExtensionMode.Development) {
            return undefined;
        }
        const cached = this.context.globalState.get<CachedCodexModels>(CACHE_KEY);
        if (
            !cached ||
            cached.extensionVersion !== this.extensionVersion ||
            cached.apiKeyHash !== apiKeyHash ||
            Date.now() - cached.timestamp > CACHE_EXPIRY_MS ||
            !Array.isArray(cached.models) ||
            cached.models.length === 0
        ) {
            return undefined;
        }
        return cached.models;
    }

    /**
     * 应用模型列表到 providerConfig，并执行 providerOverrides 覆盖
     */
    private applyModels(models: ModelConfig[]): void {
        this.cachedProviderConfig = ConfigManager.applyProviderOverrides(this.providerKey, {
            ...this.staticProviderConfig,
            models
        });
    }

    /**
     * 对比新旧模型列表是否有变化（长度不同或任意模型配置变更）
     * 用于决定是否触发 _onDidChangeLanguageModelChatInformation 事件
     */
    private haveModelsChanged(current: ModelConfig[], next: ModelConfig[]): boolean {
        if (current.length !== next.length) {
            return true;
        }
        return current.some((model, index) => JSON.stringify(model) !== JSON.stringify(next[index]));
    }

    /**
     * 清除所有缓存（modelInfoCache + globalState），
     * 回退到静态预置模型，通常在 API Key 变更后调用
     */
    private async invalidateModelCaches(): Promise<void> {
        await Promise.all([
            this.modelInfoCache?.invalidateCache(this.providerKey),
            this.context.globalState.update(CACHE_KEY, undefined)
        ]);
        this.applyModels(this.staticProviderConfig.models);
    }

    /** 当前扩展版本号（用于缓存版本校验） */
    private get extensionVersion(): string {
        return vscode.extensions.getExtension('vicanent.gcmp')?.packageJSON.version ?? '';
    }
}
