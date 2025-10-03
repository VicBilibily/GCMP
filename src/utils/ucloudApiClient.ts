import { Logger } from './logger';
import { ModelConfig } from '../types/sharedTypes';
import { ApiKeyManager } from './apiKeyManager';
import { VersionManager } from './versionManager';

interface UCloudModelItem {
    id: string; // e.g. "deepseek-ai/DeepSeek-V3.2-Exp-Think" or "openai/gpt-4o"
    name?: string;
    description?: string;
    [key: string]: unknown;
}

export class UCloudApiClient {
    private static readonly API_URL = 'https://api.modelverse.cn/v1/models';
    private static readonly REQUEST_TIMEOUT = 10000;
    private static modelCache: ModelConfig[] | null = null;
    private static lastFetchTime = 0;
    private static readonly CACHE_DURATION = 5 * 60 * 1000;

    static async fetchModels(): Promise<ModelConfig[]> {
        const now = Date.now();
        if (this.modelCache && now - this.lastFetchTime < this.CACHE_DURATION) {
            Logger.trace('使用缓存的 UCloud 模型列表');
            return this.modelCache;
        }

        try {
            Logger.info('正在从 UCloud API 获取模型列表...');

            // Ensure API key exists
            const vendor = 'ucloud';
            await ApiKeyManager.ensureApiKey(vendor, 'UCloud');
            const apiKey = await ApiKeyManager.getApiKey(vendor);

            const controller = new AbortController();
            const timeoutId = setTimeout(() => controller.abort(), this.REQUEST_TIMEOUT);

            const userAgent = VersionManager.getUserAgent('Extension');

            const headers: Record<string, string> = {
                'Content-Type': 'application/json',
                'User-Agent': userAgent
            };
            if (apiKey) {
                headers['Authorization'] = `Bearer ${apiKey}`;
            }

            const response = await fetch(this.API_URL, {
                method: 'GET',
                headers,
                signal: controller.signal
            });

            clearTimeout(timeoutId);

            if (!response.ok) {
                throw new Error(`HTTP ${response.status}: ${response.statusText}`);
            }

            const data = (await response.json()) as { data?: UCloudModelItem[] } | any;

            const items: UCloudModelItem[] = Array.isArray(data?.data) ? data.data : [];

            const models = items
                .map(item => this.convertToModelConfig(item))
                .filter(Boolean) as ModelConfig[];

            this.modelCache = models;
            this.lastFetchTime = now;

            Logger.info(`成功从 UCloud API 获取到 ${models.length} 个模型`);
            return models;
        } catch (error) {
            Logger.error('从 UCloud API 获取模型失败:', error);
            if (this.modelCache) {
                Logger.warn('使用缓存的 UCloud 模型列表作为降级方案');
                return this.modelCache;
            }
            return [];
        }
    }

    private static convertToModelConfig(item: UCloudModelItem): ModelConfig | null {
        try {
            // Primary identifier often in `id`, sometimes includes owner prefix like "openai/gpt-4.1" or "deepseek-ai/DeepSeek-V3.2"
            const rawId = item.id || (item as any).model_id || '';
            const displayName = item.name || rawId;

            // Infer tokens and capabilities from id/displayName heuristics
            const lower = rawId.toLowerCase() + ' ' + (displayName || '').toLowerCase();

            // maxInputTokens heuristic
            let maxInputTokens = 128000; // default 128K
            if (/-256k|256k|256k-context|256000/.test(lower)) maxInputTokens = 256000;
            else if (/-128k|128k|128000/.test(lower)) maxInputTokens = 128000;
            else if (/-64k|64k|64000/.test(lower)) maxInputTokens = 64000;
            else if (/-32k|32k|32000/.test(lower)) maxInputTokens = 32000;
            else if (/-16k|16k|16000/.test(lower)) maxInputTokens = 16000;
            else if (typeof item.context_length === 'number') maxInputTokens = item.context_length;

            // image input heuristic: look for '-vl', 'vision', 'vision-pro', 'vl', 'image'
            const imageInput = /-vl|\bvl\b|vision|vision-pro|image|img|-vision/i.test(lower);

            const modelConfig: ModelConfig = {
                // Use prefixed id to avoid collisions with other providers
                id: `ucloud/${rawId}`,
                // original model name used for requests
                model: rawId,
                name: `${displayName} (UCloud)`,
                tooltip: item.description ? `${displayName} - ${String(item.description).substring(0, 120)}` : `${displayName} (UCloud)`,
                maxInputTokens,
                maxOutputTokens: 8192,
                capabilities: {
                    toolCalling: true,
                    imageInput: !!imageInput
                }
            } as ModelConfig;

            return modelConfig;
        } catch (error) {
            Logger.warn('转换 UCloud 模型失败:', error);
            return null;
        }
    }

    static clearCache(): void {
        this.modelCache = null;
        this.lastFetchTime = 0;
        Logger.trace('UCloud 模型缓存已清除');
    }
}
