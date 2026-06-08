/*---------------------------------------------------------------------------------------------
 *  语言模型信息构建工具
 *  用于将 ModelConfig 转换为 VS Code 语言模型元数据
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { JSONSchema7 } from 'json-schema';
import { ModelChatResponseOptions, ModelConfig } from '../types/sharedTypes';
import { Logger } from './logger';
import { t } from './l10n';

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
    model: Pick<ModelConfig, 'contextSize' | 'maxInputTokens'>
): ContextSizeOption[] | undefined {
    const configuredSizes = model.contextSize || [];

    if (configuredSizes.length === 0) {
        return undefined;
    }

    const uniqueSizes: number[] = [];
    for (const size of configuredSizes) {
        if (!Number.isInteger(size) || size <= 0 || size > model.maxInputTokens || uniqueSizes.includes(size)) {
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

export function getEffectiveMaxInputTokens(
    model: Pick<vscode.LanguageModelChatInformation, 'maxInputTokens'>,
    modelConfig: Pick<ModelConfig, 'contextSize' | 'maxInputTokens'>,
    options?: Pick<vscode.ProvideLanguageModelChatResponseOptions, 'modelConfiguration'>,
    providerKey?: string
): number {
    return (
        resolveConfiguredContextSize(model, modelConfig, options, providerKey) ||
        model.maxInputTokens ||
        modelConfig.maxInputTokens
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
        category: { label: options.providerDisplayName, order: 3 },
        capabilities: model.capabilities,
        isUserSelectable: true,
        configurationSchema: Object.keys(properties).length > 0 ? { properties } : undefined
    };
}

function buildModelConfigurationProperties(model: ModelConfig): Record<string, PropertySchema> {
    const properties: Record<string, PropertySchema> = {};

    const thinkingOptions = model.thinking && model.thinking.length > 0 ? model.thinking : ['enabled', 'disabled'];
    if (thinkingOptions.length > 0) {
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
            default: thinkingOptions.includes('enabled') ? 'enabled' : thinkingOptions[0],
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
        if (model.reasoningEffort.includes('medium')) {
            schema.default = 'medium';
        }
        properties.reasoningEffort = schema;
    }

    const contextSizeOptions = getContextSizeOptions(model);
    if (contextSizeOptions) {
        properties.contextSize = {
            type: 'number',
            title: t('Context Window', '上下文窗口'),
            enum: contextSizeOptions.map(option => option.value),
            enumItemLabels: contextSizeOptions.map(option => formatTokenCount(option.value)),
            default: contextSizeOptions[0].value,
            group: 'tokens'
        };
    }

    if (model.serviceTier && model.serviceTier.length > 0) {
        properties.serviceTier = {
            type: 'string',
            title: t('Service Tier', '服务等级'),
            enum: model.serviceTier,
            enumItemLabels: model.serviceTier.map(
                value => ({ auto: 'Auto', default: 'Std.', flex: 'Flex', priority: 'Fast' })[value] || value
            ),
            enumDescriptions: model.serviceTier.map(
                value =>
                    ({
                        auto: t('Automatically select service tier.', '自动选择服务等级'),
                        default: t('Standard processing speed.', '标准处理速度'),
                        flex: t('Flexible processing with higher rate multiplier.', '灵活处理，倍率更高'),
                        priority: t('Priority processing with highest rate multiplier.', '优先处理，倍率最高')
                    })[value] || value
            ),
            default: model.serviceTier[0],
            group: 'navigation'
        };
    }

    return properties;
}

function resolveConfiguredContextSize(
    model: Pick<vscode.LanguageModelChatInformation, 'maxInputTokens'>,
    modelConfig: Pick<ModelConfig, 'contextSize' | 'maxInputTokens'>,
    options?: Pick<vscode.ProvideLanguageModelChatResponseOptions, 'modelConfiguration'>,
    providerKey?: string
): number | undefined {
    const settings = options?.modelConfiguration as ModelChatResponseOptions | undefined;
    const configuredContextSize = settings?.contextSize;

    if (typeof configuredContextSize !== 'number' || !Number.isFinite(configuredContextSize)) {
        return undefined;
    }

    const supportedContextSizes = getContextSizeOptions(modelConfig)?.map(option => option.value) || [];
    if (supportedContextSizes.includes(configuredContextSize)) {
        return Math.min(configuredContextSize, model.maxInputTokens || modelConfig.maxInputTokens);
    }

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
