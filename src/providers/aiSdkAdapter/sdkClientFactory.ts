/*---------------------------------------------------------------------------------------------
 *  SDK 客户端工厂
 *  按提供商类型创建和缓存对应的 AI SDK 客户端实例
 *--------------------------------------------------------------------------------------------*/

import { createAihubmix } from '@aihubmix/ai-sdk-provider';
import { createAnthropic } from '@ai-sdk/anthropic';
import { createOpenAI } from '@ai-sdk/openai';
import { createOpenAICompatible } from '@ai-sdk/openai-compatible';
import { createGoogleGenerativeAI } from '@ai-sdk/google';
import { createXai } from '@ai-sdk/xai';
import { createPerplexity } from '@ai-sdk/perplexity';
import { createDeepInfra } from '@ai-sdk/deepinfra';
import { createOpenRouter } from '@openrouter/ai-sdk-provider';

/** aihubmix 自定义 header 中的 APP-Code */
const AIHUBMIX_APP_CODE = 'TFUV4759';

/** aihubmix reasoning 客户端的 providerOptionsName，必须与代码中 providerOptions key 匹配 */
const AIHUBMIX_REASONING_PROVIDER_NAME = 'openaiCompatible';

/** 提供商配置 */
export interface SdkProviderConfig {
    apiKey: string;
    baseUrl?: string;
    sdkType: string;
}

/**
 * 判断 aihubmix 模型是否需要使用 openai-compatible 客户端（而非 aihubmix SDK）
 *
 * aihubmix SDK 内嵌的 @ai-sdk/openai 不提取 reasoning_content，
 * 导致 DeepSeek 等模型的思考内容丢失。
 * 改用 @ai-sdk/openai-compatible 创建客户端可正确提取 reasoning_content。
 * 但 claude/gemini 模型使用各自的 SDK 协议，不能走 openai-compatible 路径。
 */
export function needsAihubmixCompatibleClient(modelIdForApi: string): boolean {
    return !modelIdForApi.startsWith('claude-')
        && !modelIdForApi.startsWith('gemini-')
        && !modelIdForApi.startsWith('imagen-');
}

/** 创建 aihubmix 自定义 fetch（注入 APP-Code header） */
function createAihubmixFetch(): typeof fetch {
    return async (url: RequestInfo | URL, init?: RequestInit) => {
        const headers = new Headers(init?.headers);
        headers.set('APP-Code', AIHUBMIX_APP_CODE);
        return globalThis.fetch(url, { ...init, headers });
    };
}

/**
 * SDK 客户端工厂
 *
 * 按提供商类型创建并缓存对应的 AI SDK 客户端，
 * 同一 providerId 复用同一客户端实例以节省资源。
 */
export class SdkClientFactory {
    private aihubmixClients = new Map<string, ReturnType<typeof createAihubmix>>();
    private aihubmixCompatibleClients = new Map<string, ReturnType<typeof createOpenAICompatible>>();
    private anthropicClients = new Map<string, ReturnType<typeof createAnthropic>>();
    private openaiClients = new Map<string, ReturnType<typeof createOpenAI>>();
    private openaiCompatibleClients = new Map<string, ReturnType<typeof createOpenAICompatible>>();
    private googleClients = new Map<string, ReturnType<typeof createGoogleGenerativeAI>>();
    private xaiClients = new Map<string, ReturnType<typeof createXai>>();
    private perplexityClients = new Map<string, ReturnType<typeof createPerplexity>>();
    private deepinfraClients = new Map<string, ReturnType<typeof createDeepInfra>>();
    private openrouterClients = new Map<string, ReturnType<typeof createOpenRouter>>();

    /**
     * 获取指定提供商的 SDK 客户端
     *
     * 严格按照 sdkType 白名单匹配，未适配的类型会抛出异常。
     */
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    getClient(providerId: string, config: SdkProviderConfig): (modelId: string) => any {
        const requireBaseUrl = (): string => {
            if (!config.baseUrl) {
                throw new Error(`Provider ${providerId} is missing baseUrl for SDK type ${config.sdkType}`);
            }
            return config.baseUrl;
        };

        switch (config.sdkType) {
            case 'aihubmix':
                if (!this.aihubmixClients.has(providerId)) {
                    this.aihubmixClients.set(
                        providerId,
                        createAihubmix({
                            apiKey: config.apiKey,
                            fetch: createAihubmixFetch()
                        })
                    );
                }
                return this.aihubmixClients.get(providerId)!;

            case 'anthropic':
                if (!this.anthropicClients.has(providerId)) {
                    this.anthropicClients.set(
                        providerId,
                        createAnthropic({
                            apiKey: config.apiKey,
                            baseURL: config.baseUrl
                        })
                    );
                }
                return this.anthropicClients.get(providerId)!;

            case 'openai':
                if (!this.openaiClients.has(providerId)) {
                    this.openaiClients.set(
                        providerId,
                        createOpenAI({
                            apiKey: config.apiKey,
                            baseURL: config.baseUrl
                        })
                    );
                }
                return this.openaiClients.get(providerId)!;

            case 'openai-compatible':
                if (!this.openaiCompatibleClients.has(providerId)) {
                    const baseUrl = requireBaseUrl();
                    this.openaiCompatibleClients.set(
                        providerId,
                        createOpenAICompatible({
                            name: providerId,
                            apiKey: config.apiKey,
                            baseURL: baseUrl
                        })
                    );
                }
                return this.openaiCompatibleClients.get(providerId)!;

            case 'google':
                if (!this.googleClients.has(providerId)) {
                    this.googleClients.set(
                        providerId,
                        createGoogleGenerativeAI({
                            apiKey: config.apiKey,
                            ...(config.baseUrl ? { baseURL: config.baseUrl } : {})
                        })
                    );
                }
                return this.googleClients.get(providerId)!;

            case 'xai':
                if (!this.xaiClients.has(providerId)) {
                    this.xaiClients.set(
                        providerId,
                        createXai({
                            apiKey: config.apiKey,
                            ...(config.baseUrl ? { baseURL: config.baseUrl } : {})
                        })
                    );
                }
                return this.xaiClients.get(providerId)!;

            case 'perplexity':
                if (!this.perplexityClients.has(providerId)) {
                    this.perplexityClients.set(
                        providerId,
                        createPerplexity({
                            apiKey: config.apiKey,
                            ...(config.baseUrl ? { baseURL: config.baseUrl } : {})
                        })
                    );
                }
                return this.perplexityClients.get(providerId)!;

            case 'deepinfra':
                if (!this.deepinfraClients.has(providerId)) {
                    this.deepinfraClients.set(
                        providerId,
                        createDeepInfra({
                            apiKey: config.apiKey,
                            ...(config.baseUrl ? { baseURL: config.baseUrl } : {})
                        })
                    );
                }
                return this.deepinfraClients.get(providerId)!;

            case 'openrouter':
                if (!this.openrouterClients.has(providerId)) {
                    this.openrouterClients.set(
                        providerId,
                        createOpenRouter({
                            apiKey: config.apiKey,
                            ...(config.baseUrl ? { baseURL: config.baseUrl } : {})
                        })
                    );
                }
                return this.openrouterClients.get(providerId)!;

            default:
                throw new Error(`Unhandled SDK type: ${config.sdkType}`);
        }
    }

    /**
     * 获取 aihubmix 非 claude/gemini 模型专用的 openai-compatible 客户端
     *
     * aihubmix SDK 内嵌的 @ai-sdk/openai 不提取 reasoning_content，
     * 对非 claude/gemini 模型切换为 @ai-sdk/openai-compatible 以正确提取 reasoning_content → reasoning chunk。
     */
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    getAihubmixCompatibleClient(providerId: string, config: SdkProviderConfig): (modelId: string) => any {
        if (!this.aihubmixCompatibleClients.has(providerId)) {
            this.aihubmixCompatibleClients.set(
                providerId,
                createOpenAICompatible({
                    name: AIHUBMIX_REASONING_PROVIDER_NAME,
                    apiKey: config.apiKey,
                    baseURL: 'https://aihubmix.com/v1',
                    headers: { 'APP-Code': AIHUBMIX_APP_CODE }
                })
            );
        }
        return this.aihubmixCompatibleClients.get(providerId)!;
    }
}
