/*---------------------------------------------------------------------------------------------
 *  Moonshot 余额查询状态栏项
 *  继承 ProviderStatusBarItem，显示 Moonshot 余额信息
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { ProviderStatusBarItem, StatusBarItemConfig } from './providerStatusBarItem';
import { StatusLogger } from '../utils/statusLogger';
import { Logger } from '../utils/logger';
import { ApiKeyManager } from '../utils/apiKeyManager';
import { VersionManager } from '../utils/versionManager';

/**
 * Moonshot 余额信息数据结构
 */
export interface MoonshotBalanceInfo {
    /** 可用余额，包括现金余额和代金券余额 */
    available_balance: number;
    /** 代金券余额，不会为负数 */
    voucher_balance: number;
    /** 现金余额，可能为负数，代表用户欠费 */
    cash_balance: number;
}

/**
 * Moonshot 余额数据结构（API响应格式）
 */
export interface MoonshotBalanceResponse {
    /** 响应代码 */
    code: number;
    /** 余额信息 */
    data: MoonshotBalanceInfo;
    /** 状态代码 */
    scode: string;
    /** 状态是否成功 */
    status: boolean;
}

/**
 * Moonshot 状态数据
 */
export interface MoonshotStatusData {
    /** 余额信息 */
    balanceInfo: MoonshotBalanceInfo;
    /** 最后更新时间 */
    lastUpdated: string;
}

/**
 * Moonshot 余额查询状态栏项
 * 显示 Moonshot 的余额信息，包括：
 * - 可用余额（状态栏显示）
 * - 现金余额（tooltip显示）
 * - 代金券余额（tooltip显示）
 * - 每5分钟自动刷新一次
 */
export class MoonshotStatusBar extends ProviderStatusBarItem<MoonshotStatusData> {
    constructor() {
        const config: StatusBarItemConfig = {
            id: 'gcmp.statusBar.moonshot',
            name: 'GCMP: Moonshot Balance',
            alignment: vscode.StatusBarAlignment.Right,
            priority: 89, // 优先级略低于 Kimi
            refreshCommand: 'gcmp.moonshot.refreshBalance',
            apiKeyProvider: 'moonshot',
            cacheKeyPrefix: 'moonshot',
            logPrefix: 'Moonshot状态栏',
            icon: '$(gcmp-moonshot)'
        };
        super(config);
    }

    /**
     * 获取显示文本（显示可用余额）
     */
    protected getDisplayText(data: MoonshotStatusData): string {
        const balance = data.balanceInfo.available_balance;
        const balanceText = balance.toFixed(2);
        return `${this.config.icon} ¥${balanceText}`;
    }

    /**
     * 生成 Tooltip 内容（显示所有余额信息）
     */
    protected generateTooltip(data: MoonshotStatusData): vscode.MarkdownString {
        const md = new vscode.MarkdownString();
        md.supportHtml = true;

        md.appendMarkdown('#### Moonshot 用户账户余额\n\n');

        md.appendMarkdown('| 货币 | 现金余额 | 代金券 | 可用余额 |\n');
        md.appendMarkdown('| :---: | ---: | ---: | ---: |\n');
        md.appendMarkdown(
            `| **CNY** | ${data.balanceInfo.cash_balance.toFixed(2)} | ${data.balanceInfo.voucher_balance.toFixed(2)} | **${data.balanceInfo.available_balance.toFixed(2)}** |\n`
        );

        md.appendMarkdown('\n---\n');
        md.appendMarkdown(`**最后更新** ${data.lastUpdated}\n`);
        md.appendMarkdown('\n');
        md.appendMarkdown('---\n');
        md.appendMarkdown('点击状态栏可手动刷新\n');
        return md;
    }

    /**
     * 执行 API 查询
     * 实现 Moonshot 余额查询逻辑
     */
    protected async performApiQuery(): Promise<{ success: boolean; data?: MoonshotStatusData; error?: string }> {
        const BALANCE_QUERY_URL = 'https://api.moonshot.cn/v1/users/me/balance';
        const MOONSHOT_KEY = 'moonshot';

        try {
            // 检查 Moonshot 密钥是否存在
            const hasApiKey = await ApiKeyManager.hasValidApiKey(MOONSHOT_KEY);
            if (!hasApiKey) {
                return {
                    success: false,
                    error: 'Moonshot API 密钥未配置，请先设置 Moonshot API 密钥'
                };
            }

            // 获取 Moonshot 密钥
            const apiKey = await ApiKeyManager.getApiKey(MOONSHOT_KEY);
            if (!apiKey) {
                return {
                    success: false,
                    error: '无法获取 Moonshot API 密钥'
                };
            }

            Logger.debug('触发查询 Moonshot 余额');
            StatusLogger.debug(`[${this.config.logPrefix}] 开始查询 Moonshot 余额...`);

            // 构建请求
            const requestOptions: RequestInit = {
                method: 'GET',
                headers: {
                    Authorization: `Bearer ${apiKey}`,
                    'Content-Type': 'application/json',
                    'User-Agent': VersionManager.getUserAgent('Moonshot')
                }
            };

            // 发送请求
            const response = await fetch(BALANCE_QUERY_URL, requestOptions);
            const responseText = await response.text();

            StatusLogger.debug(
                `[${this.config.logPrefix}] 余额查询响应状态: ${response.status} ${response.statusText}`
            );

            // 解析响应
            let parsedResponse: MoonshotBalanceResponse;
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
                if (responseText) {
                    try {
                        const errorData = JSON.parse(responseText);
                        if (errorData.error) {
                            errorMessage = errorData.error.message || errorData.error;
                        }
                    } catch {
                        // 如果解析错误响应失败，使用默认错误信息
                    }
                }
                Logger.error(`余额查询失败: ${errorMessage}`);
                return {
                    success: false,
                    error: `查询失败: ${errorMessage}`
                };
            }

            // 检查 API 响应状态
            if (!parsedResponse.status || parsedResponse.code !== 0) {
                const errorMessage = parsedResponse.scode || '未知错误';
                Logger.error(`API 返回错误: ${errorMessage}`);
                return {
                    success: false,
                    error: `API 错误: ${errorMessage}`
                };
            }

            // 检查是否包含有效的余额数据
            if (!parsedResponse.data) {
                Logger.error('未获取到余额数据');
                return {
                    success: false,
                    error: '未获取到余额数据'
                };
            }

            // 格式化最后更新时间
            const lastUpdated = new Date().toLocaleString('zh-CN');

            // 解析成功响应
            StatusLogger.debug(`[${this.config.logPrefix}] 余额查询成功`);

            return {
                success: true,
                data: {
                    balanceInfo: parsedResponse.data,
                    lastUpdated
                }
            };
        } catch (error) {
            const errorMessage = error instanceof Error ? error.message : '未知错误';
            Logger.error(`余额查询异常: ${errorMessage}`);
            return {
                success: false,
                error: `查询异常: ${errorMessage}`
            };
        }
    }

    /**
     * 检查是否需要高亮警告
     * 当可用余额低于阈值时高亮显示
     */
    protected shouldHighlightWarning(_data: MoonshotStatusData): boolean {
        return false; // Moonshot 不设置余额警告
    }

    /**
     * 检查是否需要刷新缓存
     * 每5分钟固定刷新一次
     */
    protected shouldRefresh(): boolean {
        if (!this.lastStatusData) {
            return false;
        }

        const dataAge = Date.now() - this.lastStatusData.timestamp;
        const REFRESH_INTERVAL = (5 * 60 - 10) * 1000; // 缓存过期阈值 5 分钟

        // 检查是否超过5分钟刷新间隔
        if (dataAge > REFRESH_INTERVAL) {
            StatusLogger.debug(
                `[${this.config.logPrefix}] 缓存时间(${(dataAge / 1000).toFixed(1)}秒)超过5分钟刷新间隔，触发API刷新`
            );
            return true;
        }

        return false;
    }

    /**
     * 访问器：获取最后的状态数据（用于测试和调试）
     */
    getLastStatusData(): { data: MoonshotStatusData; timestamp: number } | null {
        return this.lastStatusData;
    }
}
