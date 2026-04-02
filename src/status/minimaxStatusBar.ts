/*---------------------------------------------------------------------------------------------
 *  MiniMax Coding Plan 状态栏项
 *  继承 ProviderStatusBarItem，显示 MiniMax Coding Plan 使用量信息
 *  - 显示每 5 小时限额（interval）
 *  - 显示每周限额（weekly，仅新开通用户有值）
 *  参照智谱的扁平限频列表模式
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { ProviderStatusBarItem, StatusBarItemConfig } from './providerStatusBarItem';
import { StatusLogger } from '../utils/statusLogger';
import { Logger } from '../utils/logger';
import { ConfigManager, ApiKeyManager, VersionManager } from '../utils';

/**
 * 单条限频项（扁平列表，参照智谱模式）
 */
export interface MiniMaxLimitItem {
    /** 限频类型标签，如 "每 5 小时"、"每周限额" */
    label: string;
    /** 限频类型: 5h=每5小时, weekly=每周 */
    limitType: '5h' | 'weekly';
    /** 总配额 */
    total: number;
    /** 剩余次数 */
    remaining: number;
    /** 已使用(百分比) */
    percentage: number;
    /** 重置剩余时间(ms) */
    remainMs: number;
    /** 重置时间（绝对时间戳 ms） */
    resetTime: number;
}

/**
 * MiniMax 状态数据（扁平限频列表）
 */
interface MiniMaxStatusData {
    /** 限频项列表 */
    limits: MiniMaxLimitItem[];
}

/**
 * MiniMax Coding Plan 状态栏项
 * 显示 MiniMax Coding Plan 的使用量信息
 * - 有周限额：状态栏显示 "周限剩余% (5h剩余%)"
 * - 无周限额：状态栏只显示 "5h剩余%"
 */
export class MiniMaxStatusBar extends ProviderStatusBarItem<MiniMaxStatusData> {
    constructor() {
        const config: StatusBarItemConfig = {
            id: 'gcmp.statusBar.minimax',
            name: 'GCMP: MiniMax Coding Plan',
            alignment: vscode.StatusBarAlignment.Right,
            priority: 98,
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
     * 有周限额：icon 周限剩余% (5h剩余%)
     * 无周限额：icon 5h剩余%
     */
    protected getDisplayText(data: MiniMaxStatusData): string {
        const items5h = data.limits.filter(l => l.limitType === '5h');
        const itemsWeekly = data.limits.filter(l => l.limitType === 'weekly');
        const remain5h = 100 - this.maxPercentage(items5h);
        if (itemsWeekly.length > 0) {
            const remainWeekly = 100 - this.maxPercentage(itemsWeekly);
            return `${this.config.icon} ${remainWeekly}% (${remain5h}%)`;
        }
        return `${this.config.icon} ${remain5h}%`;
    }

    /**
     * 生成 Tooltip 内容
     * 参照智谱模式：限频类型 | 上限值 | 剩余量 | 使用率
     */
    protected generateTooltip(data: MiniMaxStatusData): vscode.MarkdownString {
        const md = new vscode.MarkdownString();
        md.supportHtml = true;
        md.appendMarkdown('#### MiniMax Coding Plan 使用情况\n\n');
        md.appendMarkdown('| 限频类型 | 上限值 | 剩余量 | 重置时间 |\n');
        md.appendMarkdown('| :--- | ----: | ----: | :---: |\n');

        for (const item of data.limits) {
            const resetTimeStr = item.resetTime ? this.formatDateTime(new Date(item.resetTime)) : '-';
            md.appendMarkdown(`| **${item.label}** | ${item.total} | ${item.remaining} | ${resetTimeStr} |\n`);
        }

        md.appendMarkdown('\n---\n');
        md.appendMarkdown('点击状态栏可手动刷新\n');
        return md;
    }

    /**
     * 执行 API 查询
     * 将 API 响应拆分为扁平限频列表
     */
    protected async performApiQuery(): Promise<{ success: boolean; data?: MiniMaxStatusData; error?: string }> {
        const REMAIN_QUERY_URL = 'https://www.minimaxi.com/v1/api/openplatform/coding_plan/remains';
        const CODING_PLAN_KEY = 'minimax-coding';

        try {
            const hasCodingKey = await ApiKeyManager.hasValidApiKey(CODING_PLAN_KEY);
            if (!hasCodingKey) {
                return { success: false, error: 'Coding Plan 专用密钥未配置，请先设置 Coding Plan API 密钥' };
            }

            const apiKey = await ApiKeyManager.getApiKey(CODING_PLAN_KEY);
            if (!apiKey) {
                return { success: false, error: '无法获取 Coding Plan 专用密钥' };
            }

            Logger.debug('触发查询 MiniMax Coding Plan 余量');
            StatusLogger.debug(`[${this.config.logPrefix}] 开始查询 MiniMax Coding Plan 余量...`);

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
                current_weekly_total_count: number;
                current_weekly_usage_count: number;
                weekly_start_time: number;
                weekly_end_time: number;
                weekly_remains_time: number;
            }

            interface CodingPlanRemainResponse {
                model_remains: ModelRemainInfo[];
                base_resp: { status_code: number; status_msg: string };
            }

            let parsedResponse: CodingPlanRemainResponse;
            try {
                parsedResponse = JSON.parse(responseText);
            } catch (parseError) {
                Logger.error(`解析响应 JSON 失败: ${parseError}`);
                return { success: false, error: `响应格式错误: ${responseText.substring(0, 200)}` };
            }

            if (!response.ok) {
                const errorMessage = parsedResponse.base_resp?.status_msg || `HTTP ${response.status}`;
                Logger.error(`余量查询失败: ${errorMessage}`);
                return { success: false, error: `查询失败: ${errorMessage}` };
            }

            if (parsedResponse.base_resp && parsedResponse.base_resp.status_code !== 0) {
                const errorMessage = parsedResponse.base_resp.status_msg || '未知业务错误';
                Logger.error(`余量查询业务失败: ${errorMessage}`);
                return { success: false, error: `业务查询失败: ${errorMessage}` };
            }

            StatusLogger.debug(`[${this.config.logPrefix}] 余量查询成功`);

            const modelRemains = parsedResponse.model_remains;
            if (!modelRemains || modelRemains.length === 0) {
                return { success: false, error: '未获取到模型余量数据' };
            }

            // 拆分为扁平限频列表
            const limits: MiniMaxLimitItem[] = [];
            const mSeriesModels = modelRemains.filter(m => m.model_name?.startsWith('MiniMax-M'));

            for (const m of mSeriesModels) {
                // 每 5 小时限额
                limits.push(
                    this.buildLimitItem(
                        '每 5 小时',
                        '5h',
                        m.current_interval_total_count,
                        m.current_interval_usage_count,
                        m.remains_time,
                        m.end_time
                    )
                );
                // 每周限额（仅 total > 0 时添加，老用户为 0 不显示）
                if ((m.current_weekly_total_count ?? 0) > 0) {
                    limits.push(
                        this.buildLimitItem(
                            '每周限额',
                            'weekly',
                            m.current_weekly_total_count,
                            m.current_weekly_usage_count,
                            m.weekly_remains_time,
                            m.weekly_end_time
                        )
                    );
                }
            }

            return { success: true, data: { limits } };
        } catch (error) {
            const errorMessage = error instanceof Error ? error.message : '未知错误';
            Logger.error(`余量查询异常: ${errorMessage}`);
            return { success: false, error: `查询异常: ${errorMessage}` };
        }
    }

    /**
     * 构建单条限频项
     */
    private buildLimitItem(
        label: string,
        limitType: '5h' | 'weekly',
        totalCount: number,
        usageCount: number,
        remainsTime: number,
        endTime: number
    ): MiniMaxLimitItem {
        const total = totalCount || 0;
        const remaining = usageCount ?? 0;
        const used = total - remaining;
        const percentage = total > 0 ? parseFloat(((used / total) * 100).toFixed(1)) : 0;

        return {
            label,
            limitType,
            total,
            remaining,
            percentage,
            remainMs: remainsTime,
            resetTime: endTime
        };
    }

    /**
     * 取列表中最大使用率
     */
    private maxPercentage(items: MiniMaxLimitItem[]): number {
        if (items.length === 0) {
            return 0;
        }
        return Math.max(...items.map(i => i.percentage));
    }

    /**
     * 格式化日期时间
     */
    private formatDateTime(date: Date): string {
        const month = String(date.getMonth() + 1).padStart(2, '0');
        const day = String(date.getDate()).padStart(2, '0');
        const hours = String(date.getHours()).padStart(2, '0');
        const minutes = String(date.getMinutes()).padStart(2, '0');
        return `${month}-${day} ${hours}:${minutes}`;
    }

    /**
     * 检查是否需要高亮警告
     */
    protected shouldHighlightWarning(data: MiniMaxStatusData): boolean {
        return this.maxPercentage(data.limits) >= this.HIGH_USAGE_THRESHOLD;
    }

    /**
     * 检查是否需要刷新缓存
     */
    protected shouldRefresh(): boolean {
        if (!this.lastStatusData) {
            return false;
        }

        const dataAge = Date.now() - this.lastStatusData.timestamp;
        const CACHE_EXPIRY_THRESHOLD = (5 * 60 - 10) * 1000;

        // 根据 remainMs 判断是否需要刷新
        const remainTimes = this.lastStatusData.data.limits.map(l => l.remainMs).filter(v => v > 0);
        const minRemainMs = remainTimes.length > 0 ? Math.min(...remainTimes) : 0;

        if (minRemainMs > 0 && dataAge > minRemainMs) {
            StatusLogger.debug(
                `[${this.config.logPrefix}] 缓存时间(${(dataAge / 1000).toFixed(1)}秒)超过最短重置时间(${(minRemainMs / 1000).toFixed(1)}秒)，触发API刷新`
            );
            return true;
        }

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
