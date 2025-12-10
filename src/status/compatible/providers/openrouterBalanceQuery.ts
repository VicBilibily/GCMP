/*---------------------------------------------------------------------------------------------
 *  OpenRouter 余额查询器
 *--------------------------------------------------------------------------------------------*/

import { IBalanceQuery, BalanceQueryResult } from '../balanceQuery';
import { StatusLogger } from '../../../utils/statusLogger';
import { ApiKeyManager } from '../../../utils/apiKeyManager';
import { Logger } from '../../../utils';

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
        StatusLogger.debug(`[OpenrouterBalanceQuery] 查询提供商 ${providerId} 的余额`);

        try {
            // 获取API密钥
            const apiKey = await ApiKeyManager.getApiKey(providerId);

            if (!apiKey) {
                throw new Error(`未找到提供商 ${providerId} 的API密钥`);
            }

            // 调用OpenRouter余额查询API
            const response = await fetch('https://openrouter.ai/api/v1/credits', {
                method: 'GET',
                headers: {
                    Authorization: `Bearer ${apiKey}`,
                    'Content-Type': 'application/json'
                }
            });

            if (!response.ok) {
                throw new Error(`API请求失败: ${response.status} ${response.statusText}`);
            }

            const result = (await response.json()) as OpenRouterBalanceResponse;

            // 解析余额数据
            const totalCredits = result.data.total_credits || 0; // 总购买积分
            const totalUsage = result.data.total_usage || 0; // 总使用积分
            const balance = totalCredits - totalUsage; // 可用余额

            StatusLogger.debug('[OpenrouterBalanceQuery] 余额查询成功');

            return {
                balance,
                currency: 'USD' // OpenRouter使用美元
            };
        } catch (error) {
            Logger.error('[OpenrouterBalanceQuery] 查询余额失败', error);
            throw new Error(`OpenRouter 余额查询失败: ${error instanceof Error ? error.message : '未知错误'}`);
        }
    }
}
