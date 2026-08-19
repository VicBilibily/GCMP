import type { ModelConfig } from '../types/sharedTypes';

/**
 * 模型是否支持关闭思考。thinking 声明了但不含 disabled（如火山 GLM-5.3 的 ["enabled"]），
 * 或 reasoningEffort 声明了但不含 none/minimal（如 Kimi-K3、step-3.7-flash），视为强制思考。
 */
export function canDisableThinking(modelConfig: Pick<ModelConfig, 'thinking' | 'reasoningEffort'>): boolean {
    if (modelConfig.thinking && modelConfig.thinking.length > 0 && !modelConfig.thinking.includes('disabled')) {
        return false;
    }
    const efforts = modelConfig.reasoningEffort;
    if (efforts && efforts.length > 0 && !efforts.includes('none') && !efforts.includes('minimal')) {
        return false;
    }
    return true;
}
