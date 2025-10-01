/*---------------------------------------------------------------------------------------------
 *  心流AI API 客户端
 *  用于从 心流AI API 获取动态模型列表
 *--------------------------------------------------------------------------------------------*/

import { Logger } from './logger';
import { VersionManager } from './versionManager';
import { ModelConfig } from '../types/sharedTypes';

/**
 * 心流AI API 响应接口
 */
interface IFlowApiResponse {
    success: boolean;
    code: string;
    message: string;
    data: Record<string, IFlowModel[]>;
}

/**
 * 心流AI 模型接口
 */
interface IFlowModel {
    id: number;
    showName: string;
    modelName: string;
    modelType: string;
    modelStatus: string;
    description: string;
    modelTags: string;
    popularity: number;
    isVisible: number;
    [key: string]: unknown;
}

/**
 * 心流AI API 客户端类
 */
export class IFlowApiClient {
    private static readonly API_URL = 'https://iflow.cn/api/platform/models/list';
    private static readonly REQUEST_TIMEOUT = 10000; // 10秒超时
    private static modelCache: ModelConfig[] | null = null;
    private static lastFetchTime = 0;
    private static readonly CACHE_DURATION = 5 * 60 * 1000; // 5分钟缓存

    /**
     * 从 心流AI API 获取模型列表
     */
    static async fetchModels(): Promise<ModelConfig[]> {
        // 检查缓存是否有效
        const now = Date.now();
        if (this.modelCache && now - this.lastFetchTime < this.CACHE_DURATION) {
            Logger.trace('使用缓存的 心流AI 模型列表');
            return this.modelCache;
        }

        try {
            Logger.info('正在从 心流AI API 获取模型列表...');

            const controller = new AbortController();
            const timeoutId = setTimeout(() => controller.abort(), this.REQUEST_TIMEOUT);

            // 使用版本管理器获取 User-Agent
            const userAgent = VersionManager.getUserAgent('Extension');

            const response = await fetch(this.API_URL, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'User-Agent': userAgent
                },
                body: JSON.stringify({}), // 空对象
                signal: controller.signal
            });

            clearTimeout(timeoutId);

            if (!response.ok) {
                throw new Error(`HTTP ${response.status}: ${response.statusText}`);
            }

            const data = (await response.json()) as IFlowApiResponse;

            if (!data.success || data.code !== '200' || !data.data) {
                throw new Error(`API 响应错误: ${data.message || '未知错误'}`);
            }

            // 从所有分类中提取模型
            const allModels: IFlowModel[] = [];
            for (const category of Object.values(data.data)) {
                if (Array.isArray(category)) {
                    allModels.push(
                        ...category.filter(
                            model => model.isVisible === 1
                            // 移除 modelStatus 过滤，因为该数据不可靠
                        )
                    );
                }
            }

            // 转换为 ModelConfig 格式
            const models = this.convertToModelConfigs(allModels);

            // 更新缓存
            this.modelCache = models;
            this.lastFetchTime = now;

            Logger.info(`成功从 心流AI API 获取到 ${allModels.length} 个模型`);
            return models;
        } catch (error) {
            Logger.error('从 心流AI API 获取模型列表失败:', error);

            // 如果有缓存，返回缓存的数据作为降级方案
            if (this.modelCache) {
                Logger.warn('使用缓存的模型列表作为降级方案');
                return this.modelCache;
            }

            // 如果没有缓存，返回空数组或默认模型
            Logger.warn('没有可用的模型缓存，返回默认模型列表');
            return await this.getDefaultModels();
        }
    }

    /**
     * 将 心流AI API 模型转换为 ModelConfig 格式
     */
    private static convertToModelConfigs(iflowModels: IFlowModel[]): ModelConfig[] {
        return iflowModels
            .filter(
                model => model.id && model.showName && model.modelName && !model.modelName.includes('deepseek-r1') // 在转换阶段屏蔽 DeepSeek R1 模型
            )
            .map(model => this.convertSingleModel(model))
            .filter(model => model !== null) as ModelConfig[];
    }

    /**
     * 转换单个模型
     */
    private static convertSingleModel(iflowModel: IFlowModel): ModelConfig | null {
        try {
            // 解析描述中的中文部分
            let description = '';
            try {
                const descObj = JSON.parse(iflowModel.description);
                description = descObj.Chinese || descObj.English || '';
            } catch {
                description = iflowModel.description || '';
            }

            // 解析模型标签获取上下文长度
            const { maxInputTokens, maxOutputTokens } = this.parseModelTags(iflowModel.modelTags, iflowModel.modelName);

            const modelConfig: ModelConfig = {
                id: iflowModel.modelName,
                name: `${iflowModel.showName} (iFlow)`,
                tooltip: `心流AI ${iflowModel.showName}${description ? ` - ${description.substring(0, 100)}...` : ''}`,
                version: iflowModel.modelName,
                maxInputTokens,
                maxOutputTokens,
                capabilities: {
                    toolCalling: true,
                    // 如果模型名包含 "-vl"（视觉语言），启用图像输入能力（不区分大小写）
                    imageInput: typeof iflowModel.modelName === 'string' && /-vl/i.test(iflowModel.modelName)
                }
            };

            return modelConfig;
        } catch (error) {
            Logger.warn(`转换模型 ${iflowModel.modelName} 失败:`, error);
            return null;
        }
    }

    /**
     * 解析模型标签获取上下文信息
     */
    private static parseModelTags(
        modelTags: string,
        modelName: string
    ): { maxInputTokens: number; maxOutputTokens: number } {
        let maxInputTokens = 128000; // 默认值
        let maxOutputTokens = 8192; // 默认值

        try {
            const tags = JSON.parse(modelTags);
            if (Array.isArray(tags) && tags.length > 0) {
                const tag = tags[0];

                // 直接使用 modelSeqLength 作为 maxInputTokens
                if (tag.modelSeqLength) {
                    const seqLength = tag.modelSeqLength;
                    if (seqLength.includes('256K')) {
                        maxInputTokens = 256000;
                    } else if (seqLength.includes('128K')) {
                        maxInputTokens = 128000;
                    } else if (seqLength.includes('64K')) {
                        maxInputTokens = 64000;
                    } else if (seqLength.includes('32K')) {
                        maxInputTokens = 32000;
                    } else if (seqLength.includes('16K')) {
                        maxInputTokens = 16000;
                    }
                }

                // 直接使用 modelSize 作为 maxOutputTokens
                if (tag.modelSize) {
                    const modelSize = tag.modelSize;
                    if (modelSize.includes('64K')) {
                        maxOutputTokens = 64000;
                    } else if (modelSize.includes('32K')) {
                        maxOutputTokens = 32000;
                    } else if (modelSize.includes('16K')) {
                        maxOutputTokens = 16000;
                    } else if (modelSize.includes('8K')) {
                        maxOutputTokens = 8192;
                    }
                }
            }
        } catch {
            Logger.warn(`解析模型 ${modelName} 的标签失败，使用默认值`);
        }

        return { maxInputTokens, maxOutputTokens };
    }
    /**
     * 获取默认模型列表（作为降级方案）
     * 从扩展的 package.json 中读取 iflow 的静态模型配置
     */
    private static async getDefaultModels(): Promise<ModelConfig[]> {
        try {
            // 新模式：直接从 configProviders 读取
            const { configProviders } = await import('../providers/config/index.js');
            if (configProviders.iflow?.models) {
                Logger.trace('使用 configProviders 中的 心流AI 默认模型列表');
                return configProviders.iflow.models;
            }
        } catch (error) {
            Logger.warn('读取 configProviders 中的 心流AI 模型失败:', error);
        }
        // 无法读取配置时返回空数组
        Logger.trace('无法获取默认模型配置，返回空列表');
        return [];
    }

    /**
     * 清除缓存
     */
    static clearCache(): void {
        this.modelCache = null;
        this.lastFetchTime = 0;
        Logger.trace('心流AI 模型缓存已清除');
    }

    /**
     * 检查缓存是否有效
     */
    static isCacheValid(): boolean {
        const now = Date.now();
        return this.modelCache !== null && now - this.lastFetchTime < this.CACHE_DURATION;
    }
}
