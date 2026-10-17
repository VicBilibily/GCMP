import OpenAI from 'openai';
import type { CustomHeaders, ModelConfig, ProviderConfig } from '../../../types/sharedTypes';
import { ApiKeyManager } from '../../../utils/config/apiKeyManager';
import { ConfigManager } from '../../../utils/config/configManager';
import {
    canonicalizeUserAgentHeader,
    getCustomHeaderDeletionMarkers,
    mergeCustomHeaders,
    preserveRequiredHeaders
} from '../../../utils/net/httpHeaders';
import { redactHeaders } from '../../../utils/net/proxyAgent';
import type { RequestDiagnostics } from '../../../utils/net/requestDiagnostics';
import { t } from '../../../utils/runtime/l10n';
import { Logger } from '../../../utils/runtime/logger';
import { VersionManager } from '../../../utils/runtime/versionManager';
import type { OpenAIProviderContext } from '../shared/providerContext';
import { OpenAIResponsePreprocessor } from './responsePreprocessor';

export class OpenAIClientFactory {
    constructor(private readonly providerInstance: OpenAIProviderContext) {}

    private get provider(): string {
        return this.providerInstance.provider;
    }

    private get providerConfig(): ProviderConfig | undefined {
        return this.providerInstance.providerConfig;
    }

    private get displayName(): string {
        return this.providerConfig?.displayName || this.provider;
    }

    private get baseURL(): string | undefined {
        return this.providerConfig?.baseUrl;
    }

    /** 返回 OpenAI 模型请求可删除的自定义 header 标记。 */
    getModelRequestHeaderDeletions(modelConfig?: ModelConfig): CustomHeaders {
        return getCustomHeaderDeletionMarkers(this.providerConfig?.customHeader, modelConfig?.customHeader);
    }

    /**
     * 创建新的 OpenAI 客户端
     */
    async createOpenAIClient(
        modelConfig?: ModelConfig,
        sessionId?: string,
        diagnostics?: RequestDiagnostics
    ): Promise<OpenAI> {
        // 优先级：model.provider -> this.provider
        const providerKey = modelConfig?.provider || this.provider;
        const currentApiKey = await ApiKeyManager.getApiKeyForRequest(providerKey, modelConfig);
        if (!currentApiKey) {
            throw new Error(t('Missing {0} API key', '缺少 {0} API 密钥', this.displayName));
        }
        // 优先使用模型特定的baseUrl，如果没有则使用提供商级别的baseUrl
        // 站点/接入点切换已上移至 provider 层的 resolveRequestBaseUrl 统一处理
        const baseURL = modelConfig?.baseUrl || this.baseURL;

        // 构建默认头部，包含自定义头部
        let defaultHeaders: CustomHeaders = {
            'User-Agent': VersionManager.getUserAgent('OpenAI')
        };
        if (sessionId) {
            defaultHeaders['X-Session-ID'] = sessionId;
        }

        // 合并提供商级别和模型级别的 customHeader
        // 模型级别的 customHeader 会覆盖提供商级别的同名头部
        const mergedCustomHeader = mergeCustomHeaders(this.providerConfig?.customHeader, modelConfig?.customHeader);

        // 处理合并后的 customHeader
        const processedCustomHeader = preserveRequiredHeaders(
            ApiKeyManager.processCustomHeader(mergedCustomHeader, currentApiKey, sessionId)
        );
        ApiKeyManager.validateRequestApiKeyHash(modelConfig, currentApiKey, processedCustomHeader);
        if (Object.keys(processedCustomHeader).length > 0) {
            defaultHeaders = mergeCustomHeaders(defaultHeaders, processedCustomHeader);
            Logger.debug(
                `${this.displayName} applying custom headers: ${JSON.stringify(redactHeaders(mergedCustomHeader))}`
            );
        }
        canonicalizeUserAgentHeader(defaultHeaders);

        const proxyUrl = ConfigManager.resolveProxyForModel(modelConfig, this.provider);
        let customFetch: typeof fetch | undefined = undefined; // 使用默认 fetch 实现
        customFetch = this.createCustomFetch(modelConfig, baseURL, proxyUrl, diagnostics);
        const client = new OpenAI({
            apiKey: currentApiKey,
            baseURL: baseURL,
            defaultHeaders: defaultHeaders,
            fetch: customFetch,
            maxRetries: 0
        });
        Logger.trace(`${this.displayName} OpenAI SDK client created with baseURL: ${baseURL}`);
        return client;
    }

    /**
     * 创建自定义 fetch 函数来处理非标准 SSE 格式
     * 修复部分模型输出 "data:" 后不带空格的问题
     * 若 modelConfig.endpoint 已设置，则将 SDK 内部构造的请求 URL 替换为自定义端点
     */
    createCustomFetch(
        modelConfig?: ModelConfig,
        resolvedBaseURL?: string,
        proxyUrl?: string,
        diagnostics?: RequestDiagnostics
    ): typeof fetch {
        const proxiedFetch = ConfigManager.createProxyAwareFetch({ proxyUrl });
        return async (url: string | URL | Request, init?: RequestInit): Promise<Response> => {
            let requestUrl: string | URL | Request = url;
            // 若配置了自定义 endpoint，则覆盖 SDK 内部构造的请求 URL
            if (modelConfig?.endpoint) {
                const customEndpoint = modelConfig.endpoint;
                if (customEndpoint.startsWith('http://') || customEndpoint.startsWith('https://')) {
                    // 完整 URL，直接使用
                    requestUrl = customEndpoint;
                } else {
                    // 相对路径，拼接到 baseURL
                    const base = (resolvedBaseURL || '').replace(/\/$/, '');
                    requestUrl = `${base}${customEndpoint.startsWith('/') ? customEndpoint : `/${customEndpoint}`}`;
                }
                Logger.debug(`Custom endpoint: ${String(url)} -> ${String(requestUrl)}`);
            }
            diagnostics?.dispatched(requestUrl, proxyUrl);
            try {
                const response = (await proxiedFetch(requestUrl, init)) as Response;
                diagnostics?.headers(response);
                return await this.preprocessSSEResponse(response, diagnostics);
            } catch (error) {
                diagnostics?.error(error);
                throw error;
            }
        };
    }

    /**
     * 预处理 SSE 响应，修复非标准格式
     * 修复部分模型输出 "data:" 后不带空格的问题
     */
    async preprocessSSEResponse(response: Response, diagnostics?: RequestDiagnostics): Promise<Response> {
        return new OpenAIResponsePreprocessor(() => this.displayName).preprocessSSEResponse(response, diagnostics);
    }
}
