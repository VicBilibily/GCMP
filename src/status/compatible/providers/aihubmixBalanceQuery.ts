/*---------------------------------------------------------------------------------------------
 *  AIHubMix 余额查询器
 *--------------------------------------------------------------------------------------------*/

import { IBalanceQuery, BalanceQueryResult } from '../balanceQuery';
import { StatusLogger } from '../../../utils/statusLogger';
import { ApiKeyManager } from '../../../utils/apiKeyManager';
import { Logger, KnownProviders } from '../../../utils';

/**
 * AIHubMix API 响应类型
 */
interface AiHubMixBalanceResponse {
    /** 对象类型 */
    object: string;
    /** 剩余额度，单位为美元 */
    total_usage: number;
}

/**
 * AIHubMix 错误响应类型
 */
interface AiHubMixErrorResponse {
    /** 错误响应 */
    error: {
        /** 错误消息 */
        message: string;
        /** 错误类型 */
        type: string;
    };
}

/**
 * AIHubMix 余额查询器
 */
export class AiHubMixBalanceQuery implements IBalanceQuery {
    /**
     * 查询 AIHubMix 余额
     * @param providerId 提供商标识符
     * @returns AIHubMix 余额查询结果
     */
    async queryBalance(providerId: string): Promise<BalanceQueryResult> {
        StatusLogger.debug(`[AiHubMixBalanceQuery] 查询提供商 ${providerId} 的余额`);

        try {
            // 获取 API 密钥
            const apiKey = await ApiKeyManager.getApiKey(providerId);
            if (!apiKey) {
                throw new Error(`未找到 ${providerId} 的 API 密钥`);
            }

            // 调用 AIHubMix 余额查询 API
            const response = await fetch('https://aihubmix.com/dashboard/billing/remain', {
                method: 'GET',
                headers: {
                    Authorization: `Bearer ${apiKey}`,
                    'Content-Type': 'application/json',
                    ...(KnownProviders['aihubmix']?.customHeader || {})
                }
            });

            if (!response.ok) {
                // 尝试解析错误响应
                let errorMessage = `API 请求失败: ${response.status} ${response.statusText}`;
                try {
                    const errorData = (await response.json()) as AiHubMixErrorResponse;
                    errorMessage = errorData?.error?.message || errorMessage;

                    // 检测欠费错误：quota exhausted
                    if (errorData.error?.message?.includes('quota exhausted')) {
                        StatusLogger.warn(`[AiHubMixBalanceQuery] 账户额度已用尽 (欠费): ${errorData.error.message}`);
                        return {
                            balance: Number.MIN_SAFE_INTEGER, // 使用特殊负值表示欠费
                            currency: 'USD'
                        };
                    }
                } catch {
                    // 如果无法解析错误响应，使用默认错误消息
                }
                throw new Error(errorMessage);
            }

            const data = (await response.json()) as AiHubMixBalanceResponse;

            // 解析响应数据
            // API 返回格式: {"object":"list","total_usage":0.06495}
            // total_usage 表示剩余额度，单位为美元
            // 特殊值: -0.000002 表示无限额度
            const remainingAmount = data.total_usage; // 检查是否为无限额度
            const isInfinite = remainingAmount === -0.000002;

            // 如果是无限额度，返回特殊标记
            if (isInfinite) {
                return {
                    balance: Number.MAX_SAFE_INTEGER,
                    currency: 'USD'
                };
            }

            // 对于其他负值，记录警告但仍处理为有限额度
            if (remainingAmount < 0 && !isInfinite) {
                StatusLogger.warn(`[AiHubMixBalanceQuery] 检测到异常负值余额: ${remainingAmount}，将其设置为 0`);
            }

            StatusLogger.debug('[AiHubMixBalanceQuery] 余额查询成功');

            // 正常情况：返回剩余额度
            return {
                balance: remainingAmount,
                currency: 'USD'
            };
        } catch (error) {
            Logger.error('[AiHubMixBalanceQuery] 查询余额失败', error);
            throw new Error(`AIHubMix 余额查询失败: ${error instanceof Error ? error.message : String(error)}`);
        }
    }
}
