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
import { isCancellationError, markAsNonCancellationError } from '../../../utils/text/cancellationError';

export interface ResolvedOpenAIConnectionParameters {
    readonly apiKey: string;
    readonly baseURL: string | undefined;
    readonly defaultHeaders: Readonly<CustomHeaders>;
    readonly proxyUrl: string | undefined;
}

export function resolveResponsesEndpoint(parameters: ResolvedOpenAIConnectionParameters, endpoint?: string): URL {
    const base = new URL(parameters.baseURL || 'https://api.openai.com/v1');
    if (endpoint && /^https?:\/\//i.test(endpoint)) {
        return new URL(endpoint);
    }
    const path = endpoint || '/responses';
    const queryIndex = path.indexOf('?');
    base.pathname = `${base.pathname.replace(/\/$/, '')}${(queryIndex >= 0 ? path.slice(0, queryIndex) : path).replace(/^([^/])/, '/$1')}`;
    if (queryIndex >= 0) {
        base.search = path.slice(queryIndex);
    }
    return base;
}

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
        diagnostics?: RequestDiagnostics,
        resolved?: ResolvedOpenAIConnectionParameters
    ): Promise<OpenAI> {
        const parameters = resolved ?? (await this.resolveConnectionParameters(modelConfig, sessionId));
        const client = new OpenAI({
            apiKey: parameters.apiKey,
            baseURL: parameters.baseURL,
            defaultHeaders: { ...parameters.defaultHeaders },
            fetch: this.createCustomFetch(modelConfig, parameters.baseURL, parameters.proxyUrl, diagnostics),
            maxRetries: 0
        });
        Logger.trace(`${this.displayName} OpenAI SDK client created with baseURL: ${parameters.baseURL}`);
        return client;
    }

    async resolveConnectionParameters(
        modelConfig?: ModelConfig,
        sessionId?: string
    ): Promise<ResolvedOpenAIConnectionParameters> {
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
        return Object.freeze({
            apiKey: currentApiKey,
            baseURL,
            defaultHeaders: Object.freeze(defaultHeaders),
            proxyUrl
        });
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
                if (error instanceof Error && !init?.signal?.aborted && isCancellationError(error)) {
                    markAsNonCancellationError(error);
                }
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
