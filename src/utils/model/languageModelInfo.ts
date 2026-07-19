/*---------------------------------------------------------------------------------------------
 *  语言模型信息构建工具
 *  用于将 ModelConfig 转换为 VS Code 语言模型元数据
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { JSONSchema7 } from 'json-schema';
import { ModelChatResponseOptions, ModelConfig } from '../../types/sharedTypes';
import { Logger } from '../runtime/logger';
import { t } from '../runtime/l10n';

/** editTools: true 时的默认工具集 */
const DEFAULT_EDIT_TOOLS: string[] = ['multi-find-replace', 'find-replace', 'code-rewrite'];

/**
 * 将 ModelConfig.capabilities.editTools 解析为 VS Code 期望的 string[] 或 undefined
 * - true → DEFAULT_EDIT_TOOLS
 * - string[] → 直接使用
 * - undefined → undefined
 *
 * VS Code 1.129.0 修复了 isProposedApiEnabled 的 bug（1.128.1 中只要声明了任意
 * enabledApiProposals 就返回 true），导致 stable 构建中 enabledApiProposals 被清空后，
 * editTools 触发 checkProposedApiEnabled('chatProvider') 抛错。
 * 因此 1.129.0+ 暂时不传递 editTools，待后续版本重新启用。
 */
function resolveEditTools(editTools?: boolean | string[]): string[] | undefined {
    // VS Code 1.129.0+ 在 stable 构建中严格检查 proposed API，editTools 会导致注册失败
    if (isVSCode129OrLater()) {
        return undefined;
    }
    if (editTools === true) {
        return DEFAULT_EDIT_TOOLS;
    }
    if (typeof editTools === 'boolean') {
        return undefined;
    }
    return editTools;
}

/**
 * 检测当前 VS Code 版本是否为 1.129.0 或更高（缓存结果）
 */
let cachedIsVSCode129OrLater: boolean | undefined;
export function isVSCode129OrLater(): boolean {
    if (cachedIsVSCode129OrLater !== undefined) {
        return cachedIsVSCode129OrLater;
    }
    const version = vscode.version;
    const match = version.match(/^(\d+)\.(\d+)\.(\d+)/);
    if (!match) {
        cachedIsVSCode129OrLater = false;
        return false;
    }
    const major = parseInt(match[1], 10);
    const minor = parseInt(match[2], 10);
    cachedIsVSCode129OrLater = major > 1 || (major === 1 && minor >= 129);
    return cachedIsVSCode129OrLater;
}

type PropertySchema = JSONSchema7 & NonNullable<vscode.LanguageModelConfigurationSchema['properties']>[string];

export interface ContextSizeOption {
    value: number;
    description: string;
}

interface CreateLanguageModelChatInformationOptions {
    providerKey: string;
    providerDisplayName: string;
    family: string;
}

export function getContextSizeOptions(
    model: Pick<ModelConfig, 'contextSize' | 'maxInputTokens' | 'maxOutputTokens'>
): ContextSizeOption[] | undefined {
    const configuredSizes = model.contextSize || [];

    if (configuredSizes.length === 0) {
        return undefined;
    }

    const outputTokens = model.maxOutputTokens || 0;
    const contextWindow = model.maxInputTokens + (model.maxOutputTokens || 0);
    const uniqueSizes: number[] = [];
    for (const size of configuredSizes) {
        // contextSize 需要大于 maxOutputTokens，保证 schema 编码后不会出现负数，
        // 同时至少为输入侧保留 1 个 token。
        if (!Number.isInteger(size) || size <= outputTokens || size > contextWindow || uniqueSizes.includes(size)) {
            continue;
        }
        uniqueSizes.push(size);
    }

    if (uniqueSizes.length === 0) {
        return undefined;
    }

    return uniqueSizes.map(value => ({
        value,
        description: `使用 ${formatTokenCount(value)} 上下文窗口`
    }));
}

/**
 * 获取当前请求实际可用的最大输入 token 上限。
 *
 * 兼容链路与逻辑结果：
 * 1. 若用户选择了 `contextSize`，运行时先将该配置解析为“真实总窗口”，
 *    再减去 `maxOutputTokens`，得到当前档位下允许的最大输入 token。
 *    结果：告警阈值与 token 统计上限会跟随用户当前档位变化。
 * 2. 若用户未选择 `contextSize`，则回退到 VS Code 注册时暴露的 `maxInputTokens`；
 *    若该值缺失，再回退到模型原始配置中的 `maxInputTokens`。
 *    结果：维持旧行为，不影响未使用 contextSize 的模型。
 *
 * 注意：该函数返回的是“输入上限”，不是“总上下文窗口”；
 * 状态栏展示总窗口时应使用 `getEffectiveContextWindow()`。
 */
export function getEffectiveMaxInputTokens(
    model: Pick<vscode.LanguageModelChatInformation, 'maxInputTokens'>,
    modelConfig: Pick<ModelConfig, 'contextSize' | 'maxInputTokens' | 'maxOutputTokens'>,
    options?: Pick<vscode.ProvideLanguageModelChatResponseOptions, 'modelConfiguration'>,
    providerKey?: string
): number {
    const contextWindow = resolveConfiguredContextSize(model, modelConfig, options, providerKey);
    if (contextWindow) {
        return contextWindow - (modelConfig.maxOutputTokens || 0);
    }

    return model.maxInputTokens || modelConfig.maxInputTokens;
}

/**
 * 获取有效总上下文窗口大小（input + output = context）
 * 当用户通过 contextSize 选择了特定档位时，返回该档位的总窗口值；
 * 否则返回注册的总窗口（maxInputTokens + maxOutputTokens）。
 *
 * 逻辑结果：
 * 1. 用户显式选择了 contextSize：状态栏和占用比例按该档位的真实总窗口展示。
 * 2. 用户未选择 contextSize：回退到模型注册的默认总窗口展示。
 */
export function getEffectiveContextWindow(
    model: Pick<vscode.LanguageModelChatInformation, 'maxInputTokens'>,
    modelConfig: Pick<ModelConfig, 'contextSize' | 'maxInputTokens' | 'maxOutputTokens'>,
    options?: Pick<vscode.ProvideLanguageModelChatResponseOptions, 'modelConfiguration'>,
    providerKey?: string
): number {
    const config = modelConfig as ModelConfig;
    return (
        resolveConfiguredContextSize(model, modelConfig, options, providerKey) ||
        config.maxInputTokens + config.maxOutputTokens
    );
}

export function createLanguageModelChatInformation(
    model: ModelConfig,
    options: CreateLanguageModelChatInformationOptions
): vscode.LanguageModelChatInformation {
    const modelId = `gcmp.${model.provider || options.providerKey}:::${model.id}`;

    const properties = buildModelConfigurationProperties(model);

    return {
        id: modelId,
        name: model.name,
        detail: options.providerDisplayName,
        tooltip: model.tooltip,
        family: options.family,
        maxInputTokens: model.maxInputTokens,
        maxOutputTokens: model.maxOutputTokens,
        version: model.id,
        capabilities: {
            ...model.capabilities,
            imageInput: true, // 始终为 true，让 VS Code 发送 DataPart
            editTools: resolveEditTools(model.capabilities.editTools)
        },
        isBYOK: true,
        isUserSelectable: true,
        configurationSchema: Object.keys(properties).length > 0 ? { properties } : undefined,
        ...(model.tokenPricing ?
            {
                inputCost: model.tokenPricing.inputPrice,
                outputCost: model.tokenPricing.outputPrice,
                cacheCost: model.tokenPricing.cacheReadPrice,
                cacheWriteCost: model.tokenPricing.cacheWritePrice
            }
        :   {})
    };
}

function buildModelConfigurationProperties(model: ModelConfig): Record<string, PropertySchema> {
    const properties: Record<string, PropertySchema> = {};

    // 仅在模型显式配置了 thinking 字段时才生成思考模式 schema
    // 未配置时不做 fallback，避免模型选择器出现不应有的选项
    const thinkingOptions = model.thinking && model.thinking.length > 0 ? model.thinking : undefined;
    if (thinkingOptions) {
        const schema: PropertySchema = {
            type: 'string',
            title: t('Thinking Mode', '思考模式'),
            enum: thinkingOptions,
            enumItemLabels: thinkingOptions.map(
                value =>
                    ({ disabled: 'Non-Thinking', enabled: 'Thinking', auto: 'Auto', adaptive: 'Adaptive' })[value] ||
                    value
            ),
            enumDescriptions: thinkingOptions.map(
                value =>
                    ({
                        disabled: t('Disable extended reasoning.', '关闭思考模式'),
                        enabled: t('Always enable extended reasoning.', '开启思考模式'),
                        auto: t('Let the model decide automatically.', '由模型自行判断'),
                        adaptive: t('Adapt reasoning depth to the current context.', '根据上下文自适应')
                    })[value] || value
            ),
            default: thinkingOptions[0],
            group: 'navigation'
        };
        if (thinkingOptions.includes('auto')) {
            schema.default = 'auto';
        } else if (thinkingOptions.includes('adaptive')) {
            schema.default = 'adaptive';
        }
        properties.thinking = schema;
    }

    if (model.reasoningEffort && model.reasoningEffort.length > 0) {
        delete properties.thinking;
        const schema: PropertySchema = {
            type: 'string',
            title: t('Reasoning Effort', '思考长度'),
            enum: model.reasoningEffort,
            enumItemLabels: model.reasoningEffort.map(
                level =>
                    ({
                        none: 'None',
                        minimal: 'Minimal',
                        low: 'Low',
                        medium: 'Medium',
                        high: 'High',
                        xhigh: 'XHigh',
                        max: 'Max'
                    })[level] || level
            ),
            enumDescriptions: model.reasoningEffort.map(
                level =>
                    ({
                        none: t('Disable reasoning and answer directly.', '关闭思考，直接回答。'),
                        minimal: t('Use the smallest possible reasoning budget.', '使用最小的思考开销。'),
                        low: t('Use light reasoning for faster responses.', '轻量思考，优先响应速度。'),
                        medium: t('Balance response speed and reasoning depth.', '平衡响应速度与思考深度。'),
                        high: t('Use deeper reasoning for more complex tasks.', '深度分析，适合复杂问题。'),
                        xhigh: t('Use very deep reasoning with slower responses.', '使用更深层推理，响应会更慢。'),
                        max: t('Use the highest available reasoning capability.', '使用最高可用推理能力。')
                    })[level] || level
            ),
            default: model.reasoningEffort[0],
            group: 'navigation'
        };
        if (model.reasoningDefault && model.reasoningEffort.includes(model.reasoningDefault)) {
            schema.default = model.reasoningDefault;
        } else if (model.reasoningEffort.includes('medium')) {
            schema.default = 'medium';
        }
        properties.reasoningEffort = schema;
    }

    const contextSizeOptions = getContextSizeOptions(model);
    if (contextSizeOptions) {
        // Schema 中存储 (totalWindow - maxOutput) 的值，使 VS Code 上下文指示器显示正确
        // VS Code 公式：显示总量 = schema值 + maxOutputTokens = totalWindow
        // 逻辑结果：
        // - schema 持久化值不再直接等于 totalWindow
        // - UI 选项标签仍显示真实总窗口（如 400K / 1M）
        // - 运行时需要在 resolveConfiguredContextSize() 中把 outputTokens 加回去
        const outputTokens = model.maxOutputTokens || 0;
        properties.contextSize = {
            type: 'number',
            title: t('Context Window', '上下文窗口'),
            enum: contextSizeOptions.map(option => option.value - outputTokens),
            enumItemLabels: contextSizeOptions.map(option => formatTokenCount(option.value)),
            default: contextSizeOptions[0].value - outputTokens,
            group: 'tokens'
        };
    }

    if (model.serviceTier && model.serviceTier.length > 0) {
        const isAnthropic = model.sdkMode === 'anthropic';
        properties.serviceTier = {
            type: 'string',
            title: t('Service Tier', '服务等级'),
            enum: model.serviceTier,
            enumItemLabels: model.serviceTier.map(value => {
                if (isAnthropic) {
                    return { auto: 'Auto', default: 'Std.', flex: 'Flex', priority: 'Pri.' }[value] || value;
                }
                return { auto: 'Auto', default: 'Std.', flex: 'Flex', priority: 'Fast' }[value] || value;
            }),
            enumDescriptions: model.serviceTier.map(value => {
                if (isAnthropic) {
                    return (
                        {
                            auto: t('Automatically select service tier.', '自动选择服务等级'),
                            default: t('Standard processing speed.', '标准处理速度'),
                            flex: t('Flexible processing.', '灵活处理'),
                            priority: t('Priority processing for faster responses.', '优先处理，响应更快')
                        }[value] || value
                    );
                }
                return (
                    {
                        auto: t('Automatically select service tier.', '自动选择服务等级'),
                        default: t('Standard processing speed.', '标准处理速度'),
                        flex: t('Flexible processing with higher rate multiplier.', '灵活处理，倍率更高'),
                        priority: t('Priority processing with highest rate multiplier.', '优先处理，倍率最高')
                    }[value] || value
                );
            }),
            default: model.serviceTier[0],
            group: 'navigation'
        };
    }

    return properties;
}

function resolveConfiguredContextSize(
    model: Pick<vscode.LanguageModelChatInformation, 'maxInputTokens'>,
    modelConfig: Pick<ModelConfig, 'contextSize' | 'maxInputTokens' | 'maxOutputTokens'>,
    options?: Pick<vscode.ProvideLanguageModelChatResponseOptions, 'modelConfiguration'>,
    providerKey?: string
): number | undefined {
    const settings = options?.modelConfiguration as ModelChatResponseOptions | undefined;
    const configuredContextSize = settings?.contextSize;

    if (typeof configuredContextSize !== 'number' || !Number.isFinite(configuredContextSize)) {
        return undefined;
    }

    // Schema 中存储的是 (totalWindow - maxOutput)，还原为总窗口
    const outputTokens = modelConfig.maxOutputTokens || 0;
    const totalWindow = configuredContextSize + outputTokens;

    const supportedContextSizes = getContextSizeOptions(modelConfig)?.map(option => option.value) || [];
    // 新版 schema：持久化值为 (totalWindow - maxOutputTokens)
    // 逻辑结果：命中后返回真实总窗口，供状态栏展示与输入上限换算复用。
    if (supportedContextSizes.includes(totalWindow)) {
        return totalWindow;
    }
    // 兼容旧版 schema：升级前 contextSize 直接存储 totalWindow
    // 逻辑结果：老用户升级后仍保留原上下文档位，不会因编码方式改变而被静默重置。
    if (supportedContextSizes.includes(configuredContextSize)) {
        return configuredContextSize;
    }

    // 新旧两条链路都未命中时，视为无效配置。
    // 逻辑结果：调用方会回退到模型默认窗口，并保留 warning 便于排查异常持久化值。
    if (providerKey) {
        Logger.warn(`[${providerKey}] Ignoring undeclared contextSize configuration: ${configuredContextSize}`);
    }
    return undefined;
}

function formatTokenCount(count: number): string {
    if (count > 900_000) {
        const value = Math.ceil(count / 1_000_000);
        return `${value}M`;
    }
    if (count >= 1000) {
        return `${Math.round(count / 1000)}K`;
    }
    return count.toString();
}
