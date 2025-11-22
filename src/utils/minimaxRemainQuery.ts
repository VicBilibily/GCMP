/*---------------------------------------------------------------------------------------------
 *  MiniMax Coding Plan 套餐余量查询工具
 *  提供 Coding Plan 专用密钥的余量查询功能
 *--------------------------------------------------------------------------------------------*/

import { Logger } from './logger';
import { StatusLogger } from './statusLogger';
import { ApiKeyManager } from './apiKeyManager';
import { VersionManager } from './versionManager';

export interface ModelRemainItem {
    /** 模型ID */
    model: string;
    /** 统计时间周期 */
    range: string /* 10:00-15:00(UTC+8) */;
    /** 重置剩余时间(ms) */
    remainMs: number /* 14492990 */;
    /** 已使用(百分比) */
    percentage: number /* 12 */;
    /** 可用量状态 */
    usageStatus: string /** 528/600 */;
}

export interface RemainQueryResult {
    /** 请求成功状态 */
    success: boolean;
    /** 已处理可用格式数据 */
    formatted?: ModelRemainItem[];
    error?: string;
    /** 原始响应数据 */
    raw?: CodingPlanRemainResponse;
}

export interface ModelRemainInfo {
    /** 周期开始时间 */
    start_time: number /* 1763776800000 */;
    /** 周期结束时间 */
    end_time: number /* 1763794800000 */;
    /** 重置剩余时间(ms) */
    remains_time: number /* 14492990 */;
    /** 当前周期内可使用的总数 */
    current_interval_total_count: number;
    /** 当前周期内可使用的数量 */
    current_interval_usage_count: number;
    /** 模型ID */
    model_name: string;
}

interface CodingPlanRemainResponse {
    model_remains: ModelRemainInfo[];
    base_resp: {
        status_code: number;
        status_msg: string;
    };
}

/**
 * MiniMax Coding Plan 套餐余量查询工具
 * 用于查询 Coding Plan 专用密钥的余量信息
 */
export class MiniMaxRemainQuery {
    private static readonly REMAIN_QUERY_URL = 'https://www.minimaxi.com/v1/api/openplatform/coding_plan/remains';
    private static readonly CODING_PLAN_KEY = 'minimax-coding';

    /**
     * 查询 Coding Plan 套餐余量查询
     * 使用 Coding Plan 专用密钥进行身份验证
     */
    static async queryRemain(): Promise<RemainQueryResult> {
        try {
            // 检查 Coding Plan 密钥是否存在
            const hasCodingKey = await ApiKeyManager.hasValidApiKey(this.CODING_PLAN_KEY);
            if (!hasCodingKey) {
                return {
                    success: false,
                    error: 'Coding Plan 专用密钥未配置，请先设置 Coding Plan API 密钥'
                };
            }

            // 获取 Coding Plan 密钥
            const apiKey = await ApiKeyManager.getApiKey(this.CODING_PLAN_KEY);
            if (!apiKey) {
                return {
                    success: false,
                    error: '无法获取 Coding Plan 专用密钥'
                };
            }

            Logger.debug('触发查询 MiniMax Coding Plan 余量');
            StatusLogger.debug('[MiniMax余量查询] 开始查询 MiniMax Coding Plan 余量...');

            // 构建请求
            const requestOptions: RequestInit = {
                method: 'GET',
                headers: {
                    Authorization: `Bearer ${apiKey}`,
                    'Content-Type': 'application/json',
                    'User-Agent': VersionManager.getUserAgent('MiniMax')
                }
            };

            // 发送请求
            const response = await fetch(this.REMAIN_QUERY_URL, requestOptions);
            const responseText = await response.text();

            StatusLogger.debug(`[MiniMax余量查询] 余量查询响应状态: ${response.status} ${response.statusText}`);

            // 解析响应
            let parsedResponse: CodingPlanRemainResponse;
            try {
                parsedResponse = JSON.parse(responseText);
            } catch (parseError) {
                Logger.error(`解析响应 JSON 失败: ${parseError}`);
                return {
                    success: false,
                    error: `响应格式错误: ${responseText.substring(0, 200)}`
                };
            }

            // 检查响应状态
            if (!response.ok) {
                let errorMessage = `HTTP ${response.status}`;
                if (parsedResponse.base_resp?.status_msg) {
                    errorMessage = parsedResponse.base_resp.status_msg;
                }
                Logger.error(`余量查询失败: ${errorMessage}`);
                return {
                    success: false,
                    error: `查询失败: ${errorMessage}`,
                    raw: parsedResponse
                };
            }

            // 检查业务响应状态
            if (parsedResponse.base_resp && parsedResponse.base_resp.status_code !== 0) {
                const errorMessage = parsedResponse.base_resp.status_msg || '未知业务错误';
                Logger.error(`余量查询业务失败: ${errorMessage}`);
                return {
                    success: false,
                    error: `业务查询失败: ${errorMessage}`,
                    raw: parsedResponse
                };
            }

            // 解析成功响应
            StatusLogger.debug('[MiniMax余量查询] 余量查询成功', responseText);

            // 计算格式化信息
            const formatted = this.calculateFormattedInfo(parsedResponse.model_remains);

            return {
                success: true,
                formatted,
                raw: parsedResponse
            };
        } catch (error) {
            const errorMessage = error instanceof Error ? error.message : '未知错误';
            Logger.error(`余量查询异常: ${errorMessage}`);
            return {
                success: false,
                error: `查询异常: ${errorMessage}`
            };
        }
    }

    /**
     * 计算格式化信息（结构化数据）
     */
    private static calculateFormattedInfo(modelRemains: ModelRemainInfo[] | undefined): ModelRemainItem[] | undefined {
        if (!modelRemains || modelRemains.length === 0) {
            return undefined;
        }

        return modelRemains.map(modelRemain => {
            const {
                start_time,
                end_time,
                remains_time,
                current_interval_usage_count,
                current_interval_total_count,
                model_name
            } = modelRemain;

            // 1. 统计时间周期
            let range = '';
            if (start_time && end_time) {
                const startTime = new Date(start_time);
                const endTime = new Date(end_time);
                const startFormatted = startTime.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' });
                const endFormatted = endTime.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' });
                range = `${startFormatted}-${endFormatted} (UTC+8)`;
            }

            // 2. 使用信息
            let usageStatus = '';
            let percentage = 0;
            if (current_interval_total_count && current_interval_usage_count !== undefined) {
                // current_interval_usage_count 是剩余可用数量，current_interval_total_count 是总可用数量
                const usedQuantity = current_interval_total_count - current_interval_usage_count; // 计算已使用数量
                percentage = parseFloat(((usedQuantity / current_interval_total_count) * 100).toFixed(1));
                usageStatus = `${current_interval_usage_count}/${current_interval_total_count}`;
            }

            return {
                model: model_name,
                range,
                remainMs: remains_time,
                percentage,
                usageStatus
            };
        });
    }
}
