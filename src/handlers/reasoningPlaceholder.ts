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
 * 缺失 reasoning 内容时回填的占位文本。
 * DeepSeek 的思考模式会拒绝缺失或空串的 reasoning（reasoning_content / reasoning_text），
 * 任意非空文本均可满足校验，取单个空格以节省 token 并保持请求前缀稳定。
 */
export const REASONING_PLACEHOLDER_TEXT = ' ';

/**
 * 是否在缺失 reasoning 内容时注入空白占位符。
 * 仅 DeepSeek 与小米 MiMo 的兼容接口在字段缺失（或为空）时会直接报错，需要注入空白占位；
 * 其余模型对缺失的 reasoning 字段可正常容忍，无需占位。
 */
export function shouldInjectReasoningPlaceholder(context: ReasoningPlaceholderContext): boolean {
    const providerKey = `${context.modelConfig?.provider || context.providerKey || ''}`.toLowerCase();
    const modelId = `${context.modelConfig?.model || context.modelConfig?.id || ''}`.toLowerCase();
    const baseUrl = `${context.modelConfig?.baseUrl || ''}`.toLowerCase();

    return (
        isDeepSeekFamily(context) ||
        providerKey === 'xiaomimimo' ||
        providerKey === 'xiaomimimo-token' ||
        modelId.startsWith('mimo-') ||
        modelId.includes('mimo-v') ||
        baseUrl.includes('xiaomimimo.com')
    );
}

/**
 * DeepSeek 全系（官方直连或兼容中转）在思考模式下都要求回传非空 reasoning 明文，
 * 缺失时以 400 拒绝整轮请求，因此按 provider / baseUrl / 模型名前缀识别。
 */
export function isDeepSeekFamily(context: ReasoningPlaceholderContext): boolean {
    const providerKey = `${context.modelConfig?.provider || context.providerKey || ''}`.toLowerCase();
    const modelId = `${context.modelConfig?.model || context.modelConfig?.id || ''}`.toLowerCase();
    const baseUrl = `${context.modelConfig?.baseUrl || ''}`.toLowerCase();

    return (
        providerKey === 'deepseek' ||
        baseUrl.includes('api.deepseek.com') ||
        modelId.startsWith('deepseek-') ||
        modelId.includes('deepseek-v4')
    );
}
