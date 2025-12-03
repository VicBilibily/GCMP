/*---------------------------------------------------------------------------------------------
 *  Copilot Providers Config - FIM 提供商配置
 *  集中管理所有 FIM 提供商配置
 *--------------------------------------------------------------------------------------------*/

import type { FimProviderConfig } from './types';

// ============================================================================
// 已注册的 FIM 提供商
// ============================================================================

/**
 * 已注册的 FIM 提供商配置
 */
export const FIM_PROVIDERS: Record<string, FimProviderConfig> = {
    deepseek: {
        id: 'deepseek',
        name: 'DeepSeek',
        providerKey: 'deepseek',
        baseUrl: 'https://api.deepseek.com/beta',
        defaultModel: 'deepseek-chat',
        supportsSuffix: true,
        maxTokens: 4096
    }
};

/**
 * 获取提供商配置
 * @param providerId 提供商 ID
 */
export function getProviderConfig(providerId: string): FimProviderConfig | undefined {
    return FIM_PROVIDERS[providerId];
}

/**
 * 获取所有提供商
 */
export function getAllProviders(): FimProviderConfig[] {
    return Object.values(FIM_PROVIDERS);
}

/**
 * 注册新的 FIM 提供商
 * @param config 提供商配置
 */
export function registerProvider(config: FimProviderConfig): void {
    FIM_PROVIDERS[config.id] = config;
}
