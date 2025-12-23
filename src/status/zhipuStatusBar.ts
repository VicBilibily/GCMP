/*---------------------------------------------------------------------------------------------
 *  智谱AI用量状态栏项
 *  继承 ProviderStatusBarItem，显示智谱AI Coding Plan 用量信息
 *  - 仅显示 TOKENS_LIMIT: 5小时代币用量限制（在 nextResetTime 时自动重置）
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { ProviderStatusBarItem, StatusBarItemConfig } from './providerStatusBarItem';
import { StatusLogger } from '../utils/statusLogger';
import { Logger } from '../utils/logger';
import { ConfigManager, ApiKeyManager, VersionManager } from '../utils';

/**
 * 用量限制项数据结构
 */
export interface UsageLimitItem {
    /** 限制类型：
     *  - TOKENS_LIMIT: 代币用量（每5小时周期，在 nextResetTime 重置）
     *  - TIME_LIMIT: MCP 搜索使用次数
     */
    type: 'TIME_LIMIT' | 'TOKENS_LIMIT';
    /** 时间单位 (分钟、小时等) */
    unit: number;
    /** 时间周期数 */
    number: number;
    /** 总配额/限制数 */
    usage: number;
    /** 当前已使用 */
    currentValue: number;
    /** 剩余额度 */
    remaining: number;
    /** 使用百分比 */
    percentage: number;
    /** 下次重置时间戳 (ms，仅 TOKENS_LIMIT 有效) */
    nextResetTime?: number;
    /** 用量详情（按模型或功能划分） */
    usageDetails?: Array<{
        modelCode: string;
        usage: number;
    }>;
}

/**
 * 智谱 状态数据
 */
interface ZhipuStatusData {
    /** 用量限制列表 */
    limits: UsageLimitItem[];
    /** 最高使用率的限制 */
    maxUsageLimit: UsageLimitItem;
}

/**
 * 智谱AI Coding Plan 状态栏项
 * - 显示格式：剩余可用
 * - 单位：百万代币（M）
 * - 每5小时周期，在 nextResetTime 时自动重置
 */
export class ZhipuStatusBar extends ProviderStatusBarItem<ZhipuStatusData> {
    constructor() {
        const config: StatusBarItemConfig = {
            id: 'gcmp.statusBar.zhipu',
            name: 'GCMP: GLM Coding Plan',
            alignment: vscode.StatusBarAlignment.Right,
            priority: 99,
            refreshCommand: 'gcmp.refreshZhipuUsage',
            apiKeyProvider: 'zhipu',
            cacheKeyPrefix: 'zhipu',
            logPrefix: '智谱AI状态栏',
            icon: '$(gcmp-zhipu)'
        };
        super(config);
    }

    /**
     * 获取显示文本
     * 只显示 TOKENS_LIMIT（5小时剩余可用代币），以百万单位显示
     */
    protected getDisplayText(data: ZhipuStatusData): string {
        const { remaining } = data.maxUsageLimit;
        // 剩余代币显示为百万单位（M）
        const remainingMillions = (remaining / 1000000).toFixed(1);
        return `${this.config.icon} ${remainingMillions}M`;
    }

    /**
     * 生成 Tooltip 内容
     * 显示所有限制类型的详细信息总表
     */
    protected generateTooltip(data: ZhipuStatusData): vscode.MarkdownString {
        const md = new vscode.MarkdownString();
        md.supportHtml = true;
        md.appendMarkdown('#### 智谱AI GLM Coding Plan 用量信息\n\n');

        // 显示总表：所有限制类型
        md.appendMarkdown('| 类型 | 上限 | 使用 | 剩余 | \n');
        md.appendMarkdown('| :--- | ---: | ---: | ---: | \n');
        for (const limit of data.limits) {
            let typeLabel = '';
            let usage = '';
            let used = '';
            let remaining = '';

            if (limit.type === 'TOKENS_LIMIT') {
                // 每5小时使用限额
                typeLabel = '每 5 小时限额';
                usage = (limit.usage / 1000000).toFixed(1) + 'M';
                used = (limit.currentValue / 1000000).toFixed(1) + 'M';
                remaining = (limit.remaining / 1000000).toFixed(1) + 'M';
            } else {
                // MCP每月额度
                typeLabel = 'MCP每月额度';
                usage = String(limit.usage);
                used = String(limit.currentValue);
                remaining = String(limit.remaining);
            }

            md.appendMarkdown(`| ${typeLabel} | ${usage} | ${used} | ${remaining} |\n`);
        }
        md.appendMarkdown('\n');

        // 显示重置时间信息
        const tokensLimit = data.limits.find(l => l.type === 'TOKENS_LIMIT');
        if (tokensLimit?.nextResetTime) {
            const resetDate = new Date(tokensLimit.nextResetTime);
            const resetTime = resetDate.toLocaleString('zh-CN');
            md.appendMarkdown(`**重置时间** ${resetTime}\n\n`);
        }

        md.appendMarkdown('---\n');
        md.appendMarkdown('点击状态栏可手动刷新\n');
        return md;
    }

    /**
     * 执行 API 查询
     * 直接实现智谱AI用量查询逻辑
     */
    protected async performApiQuery(): Promise<{ success: boolean; data?: ZhipuStatusData; error?: string }> {
        const QUOTA_QUERY_URL = 'https://bigmodel.cn/api/monitor/usage/quota/limit';
        const PROVIDER_KEY = 'zhipu';

        try {
            // 检查 API Key 是否存在
            const hasApiKey = await ApiKeyManager.hasValidApiKey(PROVIDER_KEY);
            if (!hasApiKey) {
                return {
                    success: false,
                    error: '智谱AI API密钥未配置，请先设置 API 密钥'
                };
            }

            // 获取 API 密钥
            const apiKey = await ApiKeyManager.getApiKey(PROVIDER_KEY);
            if (!apiKey) {
                return {
                    success: false,
                    error: '无法获取智谱AI API密钥'
                };
            }

            Logger.debug('触发查询智谱AI用量');
            StatusLogger.debug(`[${this.config.logPrefix}] 开始查询智谱AI用量...`);

            // 获取当前的接入点
            const endpoint = ConfigManager.getZhipuEndpoint();
            let requestUrl = QUOTA_QUERY_URL;

            // 如果使用国际站，调整URL
            if (endpoint === 'api.z.ai') {
                requestUrl = 'https://api.z.ai/api/monitor/usage/quota/limit';
            }

            // 构建请求
            const requestOptions: RequestInit = {
                method: 'GET',
                headers: {
                    Authorization: apiKey,
                    'Content-Type': 'application/json',
                    'User-Agent': VersionManager.getUserAgent('Zhipu')
                }
            };

            // 发送请求
            const response = await fetch(requestUrl, requestOptions);
            const responseText = await response.text();

            StatusLogger.debug(
                `[${this.config.logPrefix}] 用量查询响应状态: ${response.status} ${response.statusText}`
            );

            // 解析响应
            interface QuotaLimitResponse {
                code: number;
                msg: string;
                data: {
                    limits: Array<{
                        type: 'TIME_LIMIT' | 'TOKENS_LIMIT';
                        unit: number;
                        number: number;
                        usage: number;
                        currentValue: number;
                        remaining: number;
                        percentage: number;
                        nextResetTime?: number;
                        usageDetails?: Array<{
                            modelCode: string;
                            usage: number;
                        }>;
                    }>;
                };
                success: boolean;
            }

            let parsedResponse: QuotaLimitResponse;
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
            if (!response.ok || !parsedResponse.success || parsedResponse.code !== 200) {
                let errorMessage = `HTTP ${response.status}`;
                if (parsedResponse.msg) {
                    errorMessage = parsedResponse.msg;
                }
                Logger.error(`用量查询失败: ${errorMessage}`);
                return {
                    success: false,
                    error: `查询失败: ${errorMessage}`
                };
            }

            // 解析成功响应
            StatusLogger.debug(`[${this.config.logPrefix}] 用量查询成功`);

            const limits = parsedResponse.data.limits;
            if (!limits || limits.length === 0) {
                return {
                    success: false,
                    error: '未获取到用量限制数据'
                };
            }

            // 获取 TOKENS_LIMIT（5小时代币用量）
            const maxUsageLimit = limits.find((limit: UsageLimitItem) => limit.type === 'TOKENS_LIMIT');
            if (!maxUsageLimit) {
                return {
                    success: false,
                    error: '未获取到TOKENS_LIMIT数据'
                };
            }

            return {
                success: true,
                data: {
                    limits,
                    maxUsageLimit
                }
            };
        } catch (error) {
            const errorMessage = error instanceof Error ? error.message : '未知错误';
            Logger.error(`用量查询异常: ${errorMessage}`);
            return {
                success: false,
                error: `查询异常: ${errorMessage}`
            };
        }
    }

    /**
     * 检查是否需要高亮警告
     * 当使用率高于阈值时高亮显示
     */
    protected shouldHighlightWarning(data: ZhipuStatusData): boolean {
        return data.maxUsageLimit.percentage >= this.HIGH_USAGE_THRESHOLD;
    }

    /**
     * 检查是否需要刷新缓存
     * TOKENS_LIMIT: 根据 nextResetTime（下次重置时间）判断
     * TIME_LIMIT: 使用固定5分钟缓存过期时间
     */
    protected shouldRefresh(): boolean {
        if (!this.lastStatusData) {
            return false;
        }

        const dataAge = Date.now() - this.lastStatusData.timestamp;
        const CACHE_EXPIRY_THRESHOLD = (5 * 60 - 10) * 1000; // 缓存过期阈值 5 分钟

        // 1. 检查 TOKENS_LIMIT 是否需要根据 nextResetTime 触发刷新
        const tokensLimit = this.lastStatusData.data.limits.find(l => l.type === 'TOKENS_LIMIT');
        if (tokensLimit?.nextResetTime) {
            const resetTime = tokensLimit.nextResetTime;
            const timeUntilReset = resetTime - Date.now();

            if (timeUntilReset > 0 && dataAge > timeUntilReset) {
                StatusLogger.debug(
                    `[${this.config.logPrefix}] 缓存时间(${(dataAge / 1000).toFixed(1)}秒)超过代币重置时间差(${(timeUntilReset / 1000).toFixed(1)}秒)，触发API刷新`
                );
                return true;
            }
        }

        // 2. 检查缓存是否超过5分钟固定过期时间
        if (dataAge > CACHE_EXPIRY_THRESHOLD) {
            StatusLogger.debug(
                `[${this.config.logPrefix}] 缓存时间(${(dataAge / 1000).toFixed(1)}秒)超过5分钟固定过期时间，触发API刷新`
            );
            return true;
        }

        return false;
    }

    /**
     * 访问器：获取最后的状态数据（用于测试和调试）
     */
    getLastStatusData(): { data: ZhipuStatusData; timestamp: number } | null {
        return this.lastStatusData;
    }
}
