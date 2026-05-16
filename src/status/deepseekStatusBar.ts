/*---------------------------------------------------------------------------------------------
 *  DeepSeek 余额查询状态栏项
 *  继承 ProviderStatusBarItem，显示 DeepSeek 余额信息
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { ProviderStatusBarItem, StatusBarItemConfig } from './providerStatusBarItem';
import { StatusLogger } from '../utils/statusLogger';
import { Logger } from '../utils/logger';
import { ApiKeyManager } from '../utils/apiKeyManager';
import { VersionManager } from '../utils/versionManager';
import { t } from '../utils/l10n';

/**
 * DeepSeek 余额信息数据结构
 */
export interface DeepSeekBalanceInfo {
    /** 货币代码 */
    currency: string;
    /** 总余额 */
    total_balance: string;
    /** 赠送余额 */
    granted_balance: string;
    /** 充值余额 */
    topped_up_balance: string;
}

/**
 * DeepSeek 余额数据结构（API响应格式）
 */
export interface DeepSeekBalanceResponse {
    /** 是否可用 */
    is_available: boolean;
    /** 余额信息数组 */
    balance_infos: DeepSeekBalanceInfo[];
}

/**
 * DeepSeek 状态数据
 */
export interface DeepSeekStatusData {
    /** 主要余额信息（用于状态栏显示） */
    primaryBalance: DeepSeekBalanceInfo;
    /** 所有余额信息（用于 tooltip 显示） */
    allBalances: DeepSeekBalanceInfo[];
    /** 最后更新时间 */
    lastUpdated: string;
}

/**
 * DeepSeek 余额查询状态栏项
 * 显示 DeepSeek 的余额信息，包括：
 * - 可用余额（状态栏显示）
 * - 已用金额（tooltip显示）
 * - 充值总额（tooltip显示）
 * - 每5分钟自动刷新一次
 */
export class DeepSeekStatusBar extends ProviderStatusBarItem<DeepSeekStatusData> {
    constructor() {
        const config: StatusBarItemConfig = {
            id: 'gcmp.statusBar.deepseek',
            name: 'GCMP: DeepSeek Balance',
            alignment: vscode.StatusBarAlignment.Right,
            priority: 80,
            refreshCommand: 'gcmp.deepseek.refreshBalance',
            apiKeyProvider: 'deepseek',
            cacheKeyPrefix: 'deepseek',
            logPrefix: 'DeepSeek Status Bar',
            icon: '$(gcmp-deepseek)'
        };
        super(config);
    }

    /**
     * 根据货币代码返回货币符号
     * 支持: CNY (¥) 和 USD ($)
     */
    private getCurrencySymbol(currency?: string): string {
        if (currency === 'USD') {
            return '$';
        }
        return '¥'; // 默认使用人民币符号
    }

    /**
     * 获取显示文本（显示主要余额）
     */
    protected getDisplayText(data: DeepSeekStatusData): string {
        const currencySymbol = this.getCurrencySymbol(data.primaryBalance.currency);
        const balance = parseFloat(data.primaryBalance.total_balance);
        const balanceText = balance.toFixed(2);
        return `${this.config.icon} ${currencySymbol}${balanceText}`;
    }

    /**
     * 生成 Tooltip 内容（显示所有余额信息）
     */
    protected generateTooltip(data: DeepSeekStatusData): vscode.MarkdownString {
        const md = new vscode.MarkdownString();
        md.supportHtml = true;

        md.appendMarkdown(`#### ${t('DeepSeek Account Balance', 'DeepSeek 用户余额详情')}\n\n`);

        md.appendMarkdown(
            `| ${t('Currency', '货币')} | ${t('Paid Balance', '充值余额')} | ${t('Granted', '赠金余额')} | ${t('Available', '可用余额')} |\n`
        );
        md.appendMarkdown('| :---: | ---: | ---: | ---: |\n');
        for (const balanceInfo of data.allBalances) {
            md.appendMarkdown(
                `| **${balanceInfo.currency}** | ${balanceInfo.topped_up_balance} | ${balanceInfo.granted_balance} | **${balanceInfo.total_balance}** |\n`
            );
        }

        md.appendMarkdown('---\n');
        md.appendMarkdown(`**${t('Last updated', '最后更新')}** ${data.lastUpdated}\n`);
        md.appendMarkdown('\n');
        md.appendMarkdown('---\n');
        md.appendMarkdown(`${t('Click the status bar to refresh manually', '点击状态栏可手动刷新')}\n`);
        return md;
    }

    /**
     * 执行 API 查询
     * 实现 DeepSeek 余额查询逻辑
     */
    protected async performApiQuery(): Promise<{ success: boolean; data?: DeepSeekStatusData; error?: string }> {
        const BALANCE_QUERY_URL = 'https://api.deepseek.com/v1/user/balance';
        const DEEPSEEK_KEY = 'deepseek';

        try {
            // 检查 DeepSeek 密钥是否存在
            const hasApiKey = await ApiKeyManager.hasValidApiKey(DEEPSEEK_KEY);
            if (!hasApiKey) {
                return {
                    success: false,
                    error: t(
                        'DeepSeek API key is not configured. Set the DeepSeek API key first.',
                        'DeepSeek API 密钥未配置，请先设置 DeepSeek API 密钥'
                    )
                };
            }

            // 获取 DeepSeek 密钥
            const apiKey = await ApiKeyManager.getApiKey(DEEPSEEK_KEY);
            if (!apiKey) {
                return {
                    success: false,
                    error: t('Unable to get the DeepSeek API key.', '无法获取 DeepSeek API 密钥')
                };
            }

            Logger.debug('Triggering DeepSeek balance query');
            StatusLogger.debug(`[${this.config.logPrefix}] Starting DeepSeek balance query...`);

            // 构建请求
            const requestOptions: RequestInit = {
                method: 'GET',
                headers: {
                    Authorization: `Bearer ${apiKey}`,
                    'Content-Type': 'application/json',
                    'User-Agent': VersionManager.getUserAgent('DeepSeek')
                }
            };

            // 发送请求
            const response = await fetch(BALANCE_QUERY_URL, requestOptions);
            const responseText = await response.text();

            StatusLogger.debug(
                `[${this.config.logPrefix}] Balance query response status: ${response.status} ${response.statusText}`
            );

            // 解析响应
            let parsedResponse: DeepSeekBalanceResponse;
            try {
                parsedResponse = JSON.parse(responseText);
            } catch (parseError) {
                Logger.error(`Failed to parse response JSON: ${parseError}`);
                return {
                    success: false,
                    error: t('Invalid response format: {0}', '响应格式错误: {0}', responseText.substring(0, 200))
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
                Logger.error(`Balance query failed: ${errorMessage}`);
                return {
                    success: false,
                    error: t('Query failed: {0}', '查询失败: {0}', errorMessage)
                };
            }

            // 检查是否包含有效的余额数据
            if (
                !parsedResponse.balance_infos ||
                !Array.isArray(parsedResponse.balance_infos) ||
                parsedResponse.balance_infos.length === 0
            ) {
                Logger.error('No balance data retrieved');
                return {
                    success: false,
                    error: t('No balance data was returned.', '未获取到余额数据')
                };
            }

            // 格式化最后更新时间
            const lastUpdated = new Date().toLocaleString(
                vscode.env.language.toLowerCase().startsWith('zh') ? 'zh-CN' : 'en-US'
            );

            // 选择主要余额（优先 CNY，其次 USD，最后第一个）
            let primaryBalance = parsedResponse.balance_infos.find(b => b.currency === 'CNY');
            if (!primaryBalance) {
                primaryBalance =
                    parsedResponse.balance_infos.find(b => b.currency === 'USD') || parsedResponse.balance_infos[0];
            }

            // 解析成功响应
            StatusLogger.debug(`[${this.config.logPrefix}] Balance query succeeded`);

            return {
                success: true,
                data: {
                    primaryBalance,
                    allBalances: parsedResponse.balance_infos,
                    lastUpdated
                }
            };
        } catch (error) {
            const errorMessage = error instanceof Error ? error.message : t('Unknown error', '未知错误');
            Logger.error(`Balance query exception: ${errorMessage}`);
            return {
                success: false,
                error: t('Query error: {0}', '查询异常: {0}', errorMessage)
            };
        }
    }

    /**
     * 检查是否需要高亮警告
     * 当主要余额低于阈值时高亮显示
     */
    protected shouldHighlightWarning(_data: DeepSeekStatusData): boolean {
        return false; // DeepSeek 不设置余额警告
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
    getLastStatusData(): { data: DeepSeekStatusData; timestamp: number } | null {
        return this.lastStatusData;
    }
}
