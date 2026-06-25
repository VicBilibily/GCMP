/*---------------------------------------------------------------------------------------------
 *  OpenRouter 余额查询器
 *--------------------------------------------------------------------------------------------*/

import { IBalanceQuery, BalanceQueryResult } from '../balanceQuery';
import { StatusLogger } from '../../../utils/statusLogger';
import { ApiKeyManager } from '../../../utils/apiKeyManager';
import { Logger } from '../../../utils';
import { ConfigManager } from '../../../utils/configManager';

/**
 * OpenRouter API 响应类型
 */
interface OpenRouterBalanceResponse {
    /** 响应数据 */
    data: {
        /** 总购买积分 */
        total_credits: number;
        /** 总使用积分 */
        total_usage: number;
    };
}

/**
 * OpenRouter 余额查询器
 */
export class OpenrouterBalanceQuery implements IBalanceQuery {
    /**
     * 查询 OpenRouter 余额
     * @param providerId 提供商标识符
     * @returns 余额查询结果
     */
    async queryBalance(providerId: string): Promise<BalanceQueryResult> {
        StatusLogger.debug(`[OpenrouterBalanceQuery] Querying balance for provider ${providerId}`);

        try {
            // 获取API密钥
            const apiKey = await ApiKeyManager.getApiKey(providerId);

            if (!apiKey) {
                throw new Error(`No API key found for provider ${providerId}`);
            }

            // 调用OpenRouter余额查询API
            const allOverrides = ConfigManager.getProviderOverrides();
            // 合并顺序：compatible 全局默认 → provider 专属覆盖
            const mergedCustomHeader = {
                ...(allOverrides['compatible']?.customHeader || {}),
                ...(allOverrides[providerId]?.customHeader || {})
            };
            const response = await ConfigManager.fetchWithProxy(
                'https://openrouter.ai/api/v1/credits',
                {
                    method: 'GET',
                    headers: {
                        Authorization: `Bearer ${apiKey}`,
                        'Content-Type': 'application/json',
                        ...mergedCustomHeader
                    }
                },
                {
                    providerKey: providerId
                }
            );

            if (!response.ok) {
                throw new Error(`API request failed: ${response.status} ${response.statusText}`);
            }

            const result = (await response.json()) as OpenRouterBalanceResponse;

            // 解析余额数据
            const totalCredits = result.data.total_credits || 0; // 总购买积分
            const totalUsage = result.data.total_usage || 0; // 总使用积分
            const balance = totalCredits - totalUsage; // 可用余额

            StatusLogger.debug('[OpenrouterBalanceQuery] Balance query succeeded');

            return {
                balance,
                currency: 'USD' // OpenRouter使用美元
            };
        } catch (error) {
            Logger.error('[OpenrouterBalanceQuery] Failed to query balance', error);
            throw new Error(
                `OpenRouter balance query failed: ${error instanceof Error ? error.message : 'Unknown error'}`
            );
        }
    }
}
