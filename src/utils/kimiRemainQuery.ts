/*---------------------------------------------------------------------------------------------
 *  Kimi For Coding 套餐余量查询工具
 *--------------------------------------------------------------------------------------------*/

import { Logger } from './logger';
import { StatusLogger } from './statusLogger';
import { ApiKeyManager } from './apiKeyManager';
import { VersionManager } from './versionManager';

export interface KimiRemainQueryResult {
    /** 请求成功状态 */
    success: boolean;
    /** 已处理可用格式数据 */
    formatted?: KimiUsage;
    error?: string;
    /** 原始响应数据 */
    raw?: KimiBillingResponse;
}

export interface KimiUsage {
    /** 总体用量信息 */
    summary: KimiUsageSummary;
    /** 详细使用限制 */
    windows: KimiUsageWindow[];
}

export interface KimiUsageWindow {
    /** 持续时间 */
    duration: number;
    /** 时间单位 */
    timeUnit: string;
    /** 详细信息 */
    detail: {
        /** 限制次数 */
        limit: number;
        /** 使用次数 */
        used: number;
        /** 剩余次数 */
        remaining: number;
    };
}

export interface KimiUsageSummary {
    /** 总限制次数 */
    limit: number;
    /** 已使用次数 */
    used: number;
    /** 剩余次数 */
    remaining: number;
    /** 使用百分比 */
    usage_percentage: number;
    /** 重置时间 */
    resetTime: string;
}

interface KimiBillingRequest {
    credential: {
        key: string;
        scope: string;
    };
}

export interface KimiBillingResponse {
    /** 用户信息 */
    user?: {
        userId: string;
        region: string;
        membership: {
            level: string;
        };
    };
    /** 总体使用情况（Kimi For Coding） */
    usage?: {
        limit: number;
        used?: number;
        remaining?: number;
        resetTime: string;
    };
    /** 详细使用限制 */
    limits?: {
        window: {
            duration: number;
            timeUnit: string;
        };
        detail: {
            limit: number;
            used?: number;
            remaining?: number;
        };
    }[];
    /** 错误代码 */
    code?: string;
    /** 错误详情 */
    details?: {
        type: string;
        value: string;
        debug?: {
            reason: string;
            localizedMessage?: {
                locale: string;
                message: string;
            };
        };
    }[];
}

/**
 * Kimi For Coding 套餐余量查询工具
 */
export class KimiRemainQuery {
    private static readonly REMAIN_QUERY_URL = 'https://www.kimi.com/coding/kimi.billing.v1.BillingService/GetUsage';
    private static readonly KIMI_KEY = 'kimi';

    /**
     * 查询 Kimi For Coding 套餐余量查询
     */
    static async queryRemain(): Promise<KimiRemainQueryResult> {
        try {
            // 检查 Kimi For Coding 密钥是否存在
            const hasCodingKey = await ApiKeyManager.hasValidApiKey(this.KIMI_KEY);
            if (!hasCodingKey) {
                return {
                    success: false,
                    error: 'Kimi For Coding 专用密钥未配置，请先设置 Kimi For Coding API 密钥'
                };
            }

            // 获取 Kimi For Coding 密钥
            const apiKey = await ApiKeyManager.getApiKey(this.KIMI_KEY);
            if (!apiKey) {
                return {
                    success: false,
                    error: '无法获取 Kimi For Coding 专用密钥'
                };
            }

            Logger.debug('触发查询 Kimi For Coding 余量');
            StatusLogger.debug('[Kimi余量查询] 开始查询 Kimi For Coding 余量...');

            // 构建请求体
            const requestBody: KimiBillingRequest = {
                credential: {
                    key: apiKey,
                    scope: 'FEATURE_CODING'
                }
            };

            // 构建请求
            const requestOptions: RequestInit = {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'User-Agent': VersionManager.getUserAgent('Kimi')
                },
                body: JSON.stringify(requestBody)
            };

            // 发送请求
            const response = await fetch(this.REMAIN_QUERY_URL, requestOptions);
            const responseText = await response.text();

            StatusLogger.debug(`[Kimi余量查询] 余量查询响应状态: ${response.status} ${response.statusText}`);

            // 解析响应
            let parsedResponse: KimiBillingResponse;
            try {
                parsedResponse = JSON.parse(responseText);
            } catch (parseError) {
                Logger.error(`解析响应 JSON 失败: ${parseError}`);
                return {
                    success: false,
                    error: `响应格式错误: ${responseText}`
                };
            }

            // 检查响应状态
            if (!response.ok) {
                const errorMessage = `HTTP ${response.status}`;
                Logger.error(`余量查询失败: ${errorMessage}`);
                return {
                    success: false,
                    error: `查询失败: ${errorMessage}`,
                    raw: parsedResponse
                };
            }

            // 检查具体的认证错误
            if (parsedResponse.code === 'unauthenticated') {
                const errorMessage = 'API密钥无效或已过期，请检查您的Kimi API密钥';
                Logger.error(`认证失败: ${errorMessage}`);
                return {
                    success: false,
                    error: `认证失败: ${errorMessage}`,
                    raw: parsedResponse
                };
            }

            // 检查其他 API 错误
            if (parsedResponse.code !== undefined && parsedResponse.code !== 'unauthenticated') {
                const errorMessage = `API错误: ${parsedResponse.code}`;
                Logger.error(`余量查询API失败: ${errorMessage}`);
                return {
                    success: false,
                    error: `API查询失败: ${errorMessage}`,
                    raw: parsedResponse
                };
            }

            // 解析成功响应
            StatusLogger.debug('[Kimi余量查询] 余量查询成功', responseText);

            // 计算格式化信息
            const formatted = this.calculateFormattedInfo(parsedResponse);

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
    private static calculateFormattedInfo(response: KimiBillingResponse): KimiUsage | undefined {
        if (!response.usage) {
            return undefined;
        }

        const usage = response.usage;

        // 计算使用百分比（used 可能未定义，默认为 0）
        const used = typeof usage.used === 'string' ? parseInt(usage.used, 10) : (usage.used ?? 0);
        const limit = typeof usage.limit === 'string' ? parseInt(usage.limit, 10) : usage.limit;
        const remaining = typeof usage.remaining === 'string' ? parseInt(usage.remaining, 10) : (usage.remaining ?? 0);
        const percentage = limit > 0 ? parseFloat(((used / limit) * 100).toFixed(1)) : 0;

        // 总体用量信息
        const summary: KimiUsageSummary = {
            limit,
            used,
            remaining: remaining,
            usage_percentage: percentage,
            resetTime: usage.resetTime
        };

        // 详细使用限制
        const windows: KimiUsageWindow[] = [];
        if (response.limits && response.limits.length > 0) {
            for (const limit of response.limits) {
                const detail = limit.detail;
                const detailUsed = typeof detail.used === 'string' ? parseInt(detail.used, 10) : (detail.used ?? 0);
                const detailLimit = typeof detail.limit === 'string' ? parseInt(detail.limit, 10) : detail.limit;
                const detailRemaining =
                    typeof detail.remaining === 'string' ? parseInt(detail.remaining, 10) : (detail.remaining ?? 0);

                windows.push({
                    duration: limit.window.duration,
                    timeUnit: limit.window.timeUnit,
                    detail: {
                        limit: detailLimit,
                        used: detailUsed,
                        remaining: detailRemaining
                    }
                });
            }
        }

        return {
            summary,
            windows
        };
    }
}
