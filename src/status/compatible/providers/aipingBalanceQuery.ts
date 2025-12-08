/*---------------------------------------------------------------------------------------------
 *  AIPing 余额查询器
 *--------------------------------------------------------------------------------------------*/

import { IBalanceQuery, BalanceQueryResult } from '../balanceQuery';
import { StatusLogger } from '../../../utils/statusLogger';
import { ApiKeyManager } from '../../../utils/apiKeyManager';
import { Logger } from '../../../utils';

/**
 * AIPing API 响应类型
 */
interface AIPingBalanceResponse {
    /** 响应状态码 */
    code: number;
    /** 响应消息 */
    msg: string;
    /** 余额数据对象 */
    data: AIPingBalanceData;
}

/**
 * AIPing 余额数据对象
 */
interface AIPingBalanceData {
    /** 赠送余额，单位元 */
    gift_remain: number;
    /** 充值余额，单位元 */
    recharge_remain: number;
    /** 总余额，单位元 */
    total_remain: number;
}

/**
 * AIPing 余额查询器
 */
export class AiPingBalanceQuery implements IBalanceQuery {
    /**
     * 查询 AIPing 余额
     * @param providerId 提供商标识符
     * @returns 余额查询结果
     */
    async queryBalance(providerId: string): Promise<BalanceQueryResult> {
        StatusLogger.debug(`[AiPingBalanceQuery] 查询提供商 ${providerId} 的余额`);

        try {
            // 获取API密钥
            const apiKey = await ApiKeyManager.getApiKey(providerId);

            if (!apiKey) {
                throw new Error(`未找到提供商 ${providerId} 的API密钥`);
            }

            // 调用AIPing余额查询API
            const response = await fetch('https://aiping.cn/api/v1/user/remain/points', {
                method: 'GET',
                headers: {
                    Authorization: `Bearer ${apiKey}`,
                    'Content-Type': 'application/json'
                }
            });

            if (!response.ok) {
                throw new Error(`API请求失败: ${response.status} ${response.statusText}`);
            }

            const result = (await response.json()) as AIPingBalanceResponse;

            // 检查API响应状态码
            if (result.code !== 0) {
                throw new Error(`API返回错误: ${result.msg || '未知错误'}`);
            }

            // 解析余额数据
            const data = result.data;
            const paid = data.recharge_remain || 0; // 充值余额
            const granted = data.gift_remain || 0; // 赠送余额
            const balance = data.total_remain || paid + granted; // 总余额

            StatusLogger.debug('[AiPingBalanceQuery] 余额查询成功');

            return {
                paid,
                granted,
                balance,
                currency: 'CNY'
            };
        } catch (error) {
            Logger.error('[AiPingBalanceQuery] 查询余额失败', error);
            throw new Error(`AIPing 余额查询失败: ${error instanceof Error ? error.message : '未知错误'}`);
        }
    }
}
