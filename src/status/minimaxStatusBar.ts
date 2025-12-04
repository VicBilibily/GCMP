/*---------------------------------------------------------------------------------------------
 *  MiniMax Coding Plan 状态栏项
 *  继承 BaseStatusBarItem，显示 MiniMax Coding Plan 使用量信息
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { BaseStatusBarItem, StatusBarItemConfig } from './baseStatusBarItem';
import { StatusLogger } from '../utils/statusLogger';
import { Logger } from '../utils/logger';
import { ConfigManager, ApiKeyManager, VersionManager } from '../utils';

/**
 * 模型余量项数据结构
 */
export interface ModelRemainItem {
    /** 模型ID */
    model: string;
    /** 统计时间周期 */
    range: string;
    /** 重置剩余时间(ms) */
    remainMs: number;
    /** 已使用(百分比) */
    percentage: number;
    /** 可用量状态 */
    usageStatus: string;
    /** 可用次数 */
    usage: number;
    /** 配额次数 */
    total: number;
}

/**
 * MiniMax 状态数据
 */
interface MiniMaxStatusData {
    /** 模型使用量列表 */
    formatted: ModelRemainItem[];
    /** 最高使用率的模型 */
    maxUsageModel: ModelRemainItem;
}

/**
 * MiniMax Coding Plan 状态栏项
 * 显示 MiniMax Coding Plan 的使用量信息，包括：
 * - 可用/总量
 * - 已使用百分比
 * - 支持多模型展示
 */
export class MiniMaxStatusBar extends BaseStatusBarItem<MiniMaxStatusData> {
    constructor() {
        const config: StatusBarItemConfig = {
            id: 'gcmp.statusBar.minimax',
            name: 'GCMP: MiniMax Coding Plan',
            alignment: vscode.StatusBarAlignment.Right,
            priority: 100,
            refreshCommand: 'gcmp.refreshMiniMaxUsage',
            apiKeyProvider: 'minimax-coding',
            cacheKeyPrefix: 'minimax',
            logPrefix: 'MiniMax状态栏',
            icon: '$(gcmp-minimax)'
        };
        super(config);
    }

    /**
     * 获取显示文本
     */
    protected getDisplayText(data: MiniMaxStatusData): string {
        const { usage, percentage } = data.maxUsageModel;
        return `${this.config.icon} ${usage} (${percentage}%)`;
    }

    /**
     * 生成 Tooltip 内容
     */
    protected generateTooltip(data: MiniMaxStatusData): vscode.MarkdownString {
        const md = new vscode.MarkdownString();
        md.supportHtml = true;
        md.appendMarkdown('#### MiniMax Coding Plan 使用情况\n\n');
        md.appendMarkdown('| 模型 | 上限 | 剩余 | 使用率 |\n');
        md.appendMarkdown('| :--- | ----: | ----: | ---: |\n');
        for (const info of data.formatted) {
            md.appendMarkdown(`| ${info.model} | ${info.total} | ${info.usage} | ${info.percentage}% |\n`);
        }
        md.appendMarkdown('\n');
        if (data.maxUsageModel) {
            md.appendMarkdown('---\n');
            md.appendMarkdown(`**计量周期** ${data.maxUsageModel.range}\n`);
            md.appendMarkdown('\n');
        }
        md.appendMarkdown('---\n');
        md.appendMarkdown('点击状态栏可手动刷新\n');
        return md;
    }

    /**
     * 执行 API 查询
     * 直接实现 MiniMax Coding Plan 余量查询逻辑
     */
    protected async performApiQuery(): Promise<{ success: boolean; data?: MiniMaxStatusData; error?: string }> {
        const REMAIN_QUERY_URL = 'https://www.minimaxi.com/v1/api/openplatform/coding_plan/remains';
        const CODING_PLAN_KEY = 'minimax-coding';

        try {
            // 检查 Coding Plan 密钥是否存在
            const hasCodingKey = await ApiKeyManager.hasValidApiKey(CODING_PLAN_KEY);
            if (!hasCodingKey) {
                return {
                    success: false,
                    error: 'Coding Plan 专用密钥未配置，请先设置 Coding Plan API 密钥'
                };
            }

            // 获取 Coding Plan 密钥
            const apiKey = await ApiKeyManager.getApiKey(CODING_PLAN_KEY);
            if (!apiKey) {
                return {
                    success: false,
                    error: '无法获取 Coding Plan 专用密钥'
                };
            }

            Logger.debug('触发查询 MiniMax Coding Plan 余量');
            StatusLogger.debug(`[${this.config.logPrefix}] 开始查询 MiniMax Coding Plan 余量...`);

            // 构建请求
            const requestOptions: RequestInit = {
                method: 'GET',
                headers: {
                    Authorization: `Bearer ${apiKey}`,
                    'Content-Type': 'application/json',
                    'User-Agent': VersionManager.getUserAgent('MiniMax')
                }
            };

            let requestUrl = REMAIN_QUERY_URL;
            if (ConfigManager.getMinimaxEndpoint() === 'minimax.io') {
                requestUrl = requestUrl.replace('.minimaxi.com', '.minimax.io');
            }
            // 发送请求
            const response = await fetch(requestUrl, requestOptions);
            const responseText = await response.text();

            StatusLogger.debug(
                `[${this.config.logPrefix}] 余量查询响应状态: ${response.status} ${response.statusText}`
            );

            // 解析响应
            interface ModelRemainInfo {
                start_time: number;
                end_time: number;
                remains_time: number;
                current_interval_total_count: number;
                current_interval_usage_count: number;
                model_name: string;
            }

            interface CodingPlanRemainResponse {
                model_remains: ModelRemainInfo[];
                base_resp: {
                    status_code: number;
                    status_msg: string;
                };
            }

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
                    error: `查询失败: ${errorMessage}`
                };
            }

            // 检查业务响应状态
            if (parsedResponse.base_resp && parsedResponse.base_resp.status_code !== 0) {
                const errorMessage = parsedResponse.base_resp.status_msg || '未知业务错误';
                Logger.error(`余量查询业务失败: ${errorMessage}`);
                return {
                    success: false,
                    error: `业务查询失败: ${errorMessage}`
                };
            }

            // 解析成功响应
            StatusLogger.debug(`[${this.config.logPrefix}] 余量查询成功`);

            // 计算格式化信息
            const modelRemains = parsedResponse.model_remains;
            if (!modelRemains || modelRemains.length === 0) {
                return {
                    success: false,
                    error: '未获取到模型余量数据'
                };
            }

            const formatted: ModelRemainItem[] = modelRemains.map(modelRemain => {
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
                    const startFormatted = startTime.toLocaleTimeString('zh-CN', {
                        hour: '2-digit',
                        minute: '2-digit'
                    });
                    const endFormatted = endTime.toLocaleTimeString('zh-CN', {
                        hour: '2-digit',
                        minute: '2-digit'
                    });
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
                    usageStatus,
                    usage: current_interval_usage_count || 0,
                    total: current_interval_total_count || 0
                };
            });

            // 找出使用量最大的模型
            const maxUsageModel = formatted.reduce((max: ModelRemainItem, current: ModelRemainItem) =>
                current.percentage > max.percentage ? current : max
            );

            return {
                success: true,
                data: {
                    formatted,
                    maxUsageModel
                }
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
     * 检查是否需要高亮警告
     * 当使用率高于阈值时高亮显示
     */
    protected shouldHighlightWarning(data: MiniMaxStatusData): boolean {
        return data.maxUsageModel.percentage >= this.HIGH_USAGE_THRESHOLD;
    }

    /**
     * 检查是否需要刷新缓存
     * 根据 remainMs（重置剩余时间）判断是否需要刷新
     * 以及固定5分钟缓存过期时间
     */
    protected shouldRefresh(): boolean {
        if (!this.lastStatusData) {
            return false;
        }

        const dataAge = Date.now() - this.lastStatusData.timestamp;
        const CACHE_EXPIRY_THRESHOLD = 5 * 60 * 1000; // 5分钟的毫秒数

        // 1. 检查是否需要根据 remainMs 触发刷新
        if (this.lastStatusData.data.formatted && this.lastStatusData.data.formatted.length > 0) {
            const minRemainMs = Math.min(...this.lastStatusData.data.formatted.map(m => m.remainMs || 0));

            if (minRemainMs > 0 && dataAge > minRemainMs) {
                StatusLogger.debug(
                    `[${this.config.logPrefix}] 缓存时间(${(dataAge / 1000).toFixed(1)}秒)超过最短重置时间(${(minRemainMs / 1000).toFixed(1)}秒)，触发API刷新`
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
    getLastStatusData(): { data: MiniMaxStatusData; timestamp: number } | null {
        return this.lastStatusData;
    }
}
