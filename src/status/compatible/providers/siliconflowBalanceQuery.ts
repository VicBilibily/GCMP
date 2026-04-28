/*---------------------------------------------------------------------------------------------
 *  SiliconFlow 余额查询器
 *--------------------------------------------------------------------------------------------*/

import { IBalanceQuery, BalanceQueryResult } from '../balanceQuery';
import { StatusLogger } from '../../../utils/statusLogger';
import { ApiKeyManager } from '../../../utils/apiKeyManager';
import { Logger } from '../../../utils';

/**
 * SiliconFlow API 响应类型
 */
interface SiliconFlowBalanceResponse {
    /** 响应状态码 */
    code: number;
    /** 响应消息 */
    message: string;
    /** 响应状态 */
    status: boolean;
    /** 用户数据对象 */
    data: SiliconFlowUserData;
}

/**
 * SiliconFlow 用户数据对象
 */
interface SiliconFlowUserData {
    /** 用户ID */
    id: string;
    /** 用户名 */
    name: string;
    /** 用户头像 */
    image: string;
    /** 用户邮箱 */
    email: string;
    /** 是否为管理员 */
    isAdmin: boolean;
    /** 赠送余额 */
    balance: string;
    /** 账户状态 */
    status: string;
    /** 用户介绍 */
    introduction: string;
    /** 用户角色 */
    role: string;
    /** 充值余额 */
    chargeBalance: string;
    /** 总余额 */
    totalBalance: string;
}

/**
 * SiliconFlow 余额查询器
 */
export class SiliconflowBalanceQuery implements IBalanceQuery {
    /**
     * 查询 SiliconFlow 余额
     * @param providerId 提供商标识符
     * @returns 余额查询结果
     */
    async queryBalance(providerId: string): Promise<BalanceQueryResult> {
        StatusLogger.debug(`[SiliconflowBalanceQuery] 查询提供商 ${providerId} 的余额`);

        try {
            // 获取API密钥
            const apiKey = await ApiKeyManager.getApiKey(providerId);

            if (!apiKey) {
                throw new Error(`未找到提供商 ${providerId} 的API密钥`);
            }

            // 调用SiliconFlow余额查询API
            const response = await fetch('https://api.siliconflow.cn/v1/user/info', {
                method: 'GET',
                headers: {
                    Authorization: `Bearer ${apiKey}`,
                    'Content-Type': 'application/json'
                }
            });

            if (!response.ok) {
                throw new Error(`API请求失败: ${response.status} ${response.statusText}`);
            }

            const result = (await response.json()) as SiliconFlowBalanceResponse;

            // 检查API响应状态码
            if (result.code !== 20000 || !result.status) {
                throw new Error(`API返回错误: ${result.message || '未知错误'}`);
            }

            // 解析余额数据
            const data = result.data;
            const granted = parseFloat(data.balance) || 0; // 赠送余额
            const paid = parseFloat(data.chargeBalance) || 0; // 充值余额
            const balance = parseFloat(data.totalBalance) || paid + granted; // 总余额

            StatusLogger.debug('[SiliconflowBalanceQuery] 余额查询成功');

            return {
                paid,
                granted,
                balance,
                currency: 'CNY' // SiliconFlow使用人民币
            };
        } catch (error) {
            Logger.error('[SiliconflowBalanceQuery] 查询余额失败', error);
            throw new Error(`SiliconFlow 余额查询失败: ${error instanceof Error ? error.message : '未知错误'}`);
        }
    }
}
