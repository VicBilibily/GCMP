/*---------------------------------------------------------------------------------------------
 *  ModelScope 魔搭社区 API 客户端
 *  从 ModelScope API 动态获取模型列表
 *--------------------------------------------------------------------------------------------*/

import { ModelConfig } from '../types/sharedTypes';
import { Logger, VersionManager } from '../utils';

/**
 * ModelScope API 响应接口
 */
interface ModelScopeApiResponse {
    Code: number;
    Data: {
        Model: {
            Models: ModelScopeModel[];
        };
    };
}

/**
 * ModelScope 模型接口
 */
interface ModelScopeModel {
    Id: number;
    Name: string;
    ChineseName: string;
    Path: string;
    Organization: {
        Name: string;
        FullName: string;
    };
    Tasks: Array<{
        Name: string;
        ChineseName: string;
    }>;
    SupportInference: string;
    IsAccessible: number;
    IsOnline: number;
    Downloads: number;
    Stars: number;
    Libraries: string[];
    License: string;
    Description: string;
    ModelType?: string[];
    LastUpdatedTime: number;
    IsNewModel?: boolean;
}

/**
 * ModelScope API 客户端类
 */
export class ModelScopeApiClient {
    private static readonly API_URL = 'https://www.modelscope.cn/api/v1/dolphin/models';
    private static readonly REQUEST_TIMEOUT = 15000; // 15秒超时
    private static modelCache: ModelConfig[] | null = null;
    private static lastFetchTime = 0;
    private static readonly CACHE_DURATION = 10 * 60 * 1000; // 10分钟缓存

    /**
     * 从 ModelScope API 获取模型列表
     */
    static async fetchModels(): Promise<ModelConfig[]> {
        // 检查缓存是否有效
        const now = Date.now();
        if (this.modelCache && (now - this.lastFetchTime < this.CACHE_DURATION)) {
            Logger.trace('使用缓存的 ModelScope 模型列表');
            return this.modelCache;
        }

        try {
            Logger.info('正在从 ModelScope API 获取模型列表...');

            const controller = new AbortController();
            const timeoutId = setTimeout(() => controller.abort(), this.REQUEST_TIMEOUT);

            // 使用版本管理器获取 User-Agent
            const userAgent = VersionManager.getUserAgent('Extension');

            // 构建 PUT 请求体
            const requestBody = {
                'PageSize': 100,
                'PageNumber': 1,
                'SortBy': 'Default',
                'Target': '',
                'Criterion': [
                    {
                        'category': 'tasks',
                        'predicate': 'contains',
                        'values': ['text-generation'],
                        'sub_values': []
                    }
                ],
                'SingleCriterion': [
                    {
                        'category': 'inference_type',
                        'DateType': 'int',
                        'predicate': 'equal',
                        'IntValue': 1
                    }
                ]
            };

            const response = await fetch(this.API_URL, {
                method: 'PUT',
                headers: {
                    'Content-Type': 'application/json',
                    'User-Agent': userAgent,
                    'Accept': 'application/json'
                },
                body: JSON.stringify(requestBody),
                signal: controller.signal
            });

            clearTimeout(timeoutId);

            if (!response.ok) {
                throw new Error(`HTTP ${response.status}: ${response.statusText}`);
            }

            const data = await response.json() as ModelScopeApiResponse;

            if (data.Code !== 200 || !data.Data?.Model?.Models) {
                throw new Error(`API 响应错误: Code ${data.Code}`);
            }

            // 过滤可用的文本生成模型
            const availableModels = data.Data.Model.Models.filter(model =>
                model.IsAccessible === 1 &&
                model.IsOnline === 1 &&
                model.SupportInference === 'txt2txt' &&
                model.Tasks.some(task => task.Name === 'text-generation')
            );

            // 转换为 ModelConfig 格式
            const models = this.convertToModelConfigs(availableModels);

            // 更新缓存
            this.modelCache = models;
            this.lastFetchTime = now;

            Logger.info(`成功从 ModelScope API 获取到 ${availableModels.length} 个可用模型`);
            return models;

        } catch (error) {
            Logger.error('从 ModelScope API 获取模型列表失败:', error);

            // 如果有缓存，返回缓存的数据作为降级方案
            if (this.modelCache) {
                Logger.warn('API 请求失败，使用缓存的 ModelScope 模型列表');
                return this.modelCache;
            }

            // 如果没有缓存且 API 失败，返回空列表
            Logger.warn('API 请求失败且无缓存，返回空列表');
            return [];
        }
    }

    /**
     * 将 ModelScope API 模型转换为 ModelConfig 格式
     */
    private static convertToModelConfigs(modelScopeModels: ModelScopeModel[]): ModelConfig[] {
        return modelScopeModels
            .map(model => this.convertSingleModel(model))
            .filter(model => model !== null) as ModelConfig[];
    }

    /**
     * 转换单个模型
     */
    private static convertSingleModel(modelScopeModel: ModelScopeModel): ModelConfig | null {
        try {
            // 构建模型 ID，使用 组织名/模型名 格式
            const modelId = `${modelScopeModel.Organization.Name}/${modelScopeModel.Name}`;

            // 构建显示名称，使用真正的供应商名称
            const orgName = modelScopeModel.Organization.Name; // 如 "Qwen", "DeepSeek" 等
            const modelName = modelScopeModel.ChineseName || modelScopeModel.Name;
            const displayName = `${orgName}/${modelName}`;

            // 构建工具提示
            const tooltip = this.buildTooltip(modelScopeModel);

            // 估算 token 限制（基于模型名称和描述推断）
            const tokenLimits = this.estimateTokenLimits(modelScopeModel);

            // 判断是否支持工具调用（大部分现代模型都支持）
            const supportsToolCalling = this.supportsToolCalling(modelScopeModel);

            return {
                id: modelId,
                name: displayName,
                tooltip: tooltip,
                maxInputTokens: tokenLimits.input,
                maxOutputTokens: tokenLimits.output,
                version: modelId,
                capabilities: {
                    toolCalling: supportsToolCalling,
                    imageInput: false // ModelScope 主要是文本生成模型
                }
            };
        } catch (error) {
            Logger.warn(`转换 ModelScope 模型失败: ${modelScopeModel.Name}`, error);
            return null;
        }
    }

    /**
     * 构建模型工具提示
     */
    private static buildTooltip(model: ModelScopeModel): string {
        const parts = [];

        // 添加组织信息
        if (model.Organization.FullName) {
            parts.push(`${model.Organization.FullName}`);
        }

        // 添加模型类型
        if (model.ModelType && model.ModelType.length > 0) {
            parts.push(`类型: ${model.ModelType.join(', ')}`);
        }

        // 添加下载量和星级
        if (model.Downloads > 0) {
            parts.push(`下载量: ${model.Downloads.toLocaleString()}`);
        }

        if (model.Stars > 0) {
            parts.push(`星级: ${model.Stars}`);
        }

        // 添加许可证
        if (model.License) {
            parts.push(`许可证: ${model.License}`);
        }

        // 添加描述（如果有）
        if (model.Description) {
            parts.push(model.Description.substring(0, 100));
        }

        return parts.join(' | ');
    }

    /**
     * 估算 token 限制
     */
    private static estimateTokenLimits(model: ModelScopeModel): { input: number; output: number } {
        const modelName = model.Name.toLowerCase();
        const modelType = model.ModelType?.[0]?.toLowerCase() || '';

        // 基于模型名称和类型进行启发式估算
        if (modelName.includes('qwen3') || modelType.includes('qwen3')) {
            return { input: 256000, output: 64000 }; // Qwen3 系列通常支持长上下文
        } else if (modelName.includes('qwen2') || modelType.includes('qwen2')) {
            return { input: 128000, output: 32000 };
        } else if (modelName.includes('deepseek') || modelType.includes('deepseek')) {
            return { input: 128000, output: 32000 };
        } else if (modelName.includes('llama') || modelType.includes('llama')) {
            return { input: 128000, output: 32000 };
        } else if (modelName.includes('mistral') || modelType.includes('mistral')) {
            return { input: 128000, output: 32000 };
        } else {
            // 默认值
            return { input: 64000, output: 16000 };
        }
    }

    /**
     * 判断是否支持工具调用
     */
    private static supportsToolCalling(model: ModelScopeModel): boolean {
        const modelName = model.Name.toLowerCase();
        const modelType = model.ModelType?.[0]?.toLowerCase() || '';

        // 大部分现代大语言模型都支持工具调用
        // 这里可以根据模型名称或类型进行更精确的判断
        const supportsTools =
            modelName.includes('qwen') ||
            modelName.includes('deepseek') ||
            modelName.includes('llama') ||
            modelName.includes('mistral') ||
            modelName.includes('glm') ||
            modelType.includes('qwen') ||
            modelType.includes('deepseek') ||
            modelType.includes('llama') ||
            modelType.includes('mistral') ||
            modelType.includes('glm');

        return supportsTools;
    }



    /**
     * 清除缓存
     */
    static clearCache(): void {
        this.modelCache = null;
        this.lastFetchTime = 0;
        Logger.trace('ModelScope 模型缓存已清除');
    }
}