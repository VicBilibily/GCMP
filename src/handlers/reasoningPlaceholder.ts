/*---------------------------------------------------------------------------------------------
 *  reasoning 空白占位符判定
 *
 *  纯逻辑模块（无 vscode 依赖），可在 node:test 环境独立运行。
 *--------------------------------------------------------------------------------------------*/

import type { ModelConfig } from '../types/sharedTypes';

export interface ReasoningPlaceholderContext {
    providerKey?: string;
    modelConfig?: Partial<Pick<ModelConfig, 'baseUrl' | 'id' | 'model' | 'provider'>>;
}

/**
 * 是否在缺失 reasoning 内容时注入空白占位符。
 * 仅 DeepSeek V4 与小米 MiMo 的兼容接口在字段缺失时会直接报错，需要注入空白占位；
 * 其余模型对缺失的 reasoning 字段可正常容忍，无需占位。
 */
export function shouldInjectReasoningPlaceholder(context: ReasoningPlaceholderContext): boolean {
    const providerKey = `${context.modelConfig?.provider || context.providerKey || ''}`.toLowerCase();
    const modelId = `${context.modelConfig?.model || context.modelConfig?.id || ''}`.toLowerCase();
    const baseUrl = `${context.modelConfig?.baseUrl || ''}`.toLowerCase();

    return (
        modelId.includes('deepseek-v4') ||
        providerKey === 'xiaomimimo' ||
        providerKey === 'xiaomimimo-token' ||
        modelId.startsWith('mimo-') ||
        modelId.includes('mimo-v') ||
        baseUrl.includes('xiaomimimo.com')
    );
}
