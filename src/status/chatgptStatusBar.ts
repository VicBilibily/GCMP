/*---------------------------------------------------------------------------------------------
 *  ChatGPT 用量查询状态栏项
 *  显示 ChatGPT (Codex) 账户的使用量和限额信息
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { BaseStatusBarItem, StatusBarItemConfig } from './baseStatusBarItem';
import { configProviders } from '../providers/config';
import { StatusLogger } from '../utils/statusLogger';
import { Logger } from '../utils/logger';
import { CliAuthFactory } from '../cli/auth/cliAuthFactory';
import { CodexCliAuth } from '../cli/auth/codexCliAuth';

/**
 * 速率限制窗口结构
 */
interface RateLimitWindow {
    /** 已使用百分比 */
    used_percent: number;
    /** 限制窗口秒数 */
    limit_window_seconds: number;
    /** 剩余重置秒数 */
    reset_after_seconds: number;
    /** 重置时间戳 */
    reset_at: number;
}

/**
 * 速率限制信息结构
 */
interface RateLimitInfo {
    /** 是否允许 */
    allowed: boolean;
    /** 是否达到限制 */
    limit_reached: boolean;
    /** 主时间窗口 */
    primary_window: RateLimitWindow;
    /** 备用时间窗口 */
    secondary_window?: RateLimitWindow;
}

/**
 * ChatGPT 用量信息数据结构（API响应格式）
 */
export interface ChatGPTUsageResponse {
    /** 用户 ID */
    user_id: string;
    /** 账户 ID */
    account_id: string;
    /** 邮箱 */
    email: string;
    /** 计划类型：free, plus, pro 等 */
    plan_type: string;
    /** 速率限制信息 */
    rate_limit: RateLimitInfo;
    /** 代码审查速率限制 */
    code_review_rate_limit?: RateLimitInfo;
    /** 额外速率限制 */
    additional_rate_limits: unknown | null;
    /** 积分/余额信息 */
    credits: unknown | null;
    /** 促销信息 */
    promo: unknown | null;
}

/**
 * ChatGPT 状态数据
 */
export interface ChatGPTStatusData {
    /** 用户 ID */
    userId: string;
    /** 账户 ID */
    accountId: string;
    /** 邮箱 */
    email: string;
    /** 计划类型 */
    planType: string;
    /** 速率限制信息 */
    rateLimit: RateLimitInfo;
    /** 代码审查已使用百分比 */
    codeReviewUsedPercent: number;
    /** 最后更新时间 */
    lastUpdated: string;
}

/**
 * 根据 limit_window_seconds 判断窗口类型
 * 只处理 300分钟(5小时) 和 1周 两种情况
 */
function getWindowType(limitWindowSeconds: number): { type: string; label: string } {
    // 300分钟 = 5小时 = 18000 秒
    const FIVE_HOURS = 5 * 60 * 60;
    // 1周 = 7 * 24 * 60 * 60 = 604800 秒
    const WEEK = 7 * 24 * 60 * 60;

    if (limitWindowSeconds === FIVE_HOURS) {
        return { type: 'hourly', label: '300 分钟' };
    } else if (limitWindowSeconds === WEEK) {
        return { type: 'weekly', label: '每周额度' };
    } else {
        // 默认按每周处理
        return { type: 'weekly', label: '每周额度' };
    }
}

/**
 * ChatGPT 用量查询状态栏项
 * 显示 ChatGPT 账户的用量信息，包括：
 * - 已使用百分比（状态栏显示）
 * - 计划类型（tooltip显示）
 * - 剩余时间（tooltip显示）
 * - 每5分钟自动刷新一次
 */
export class ChatGPTStatusBar extends BaseStatusBarItem<ChatGPTStatusData> {
    constructor() {
        const config: StatusBarItemConfig = {
            id: 'gcmp.statusBar.chatgpt',
            name: 'GCMP: ChatGPT Usage',
            alignment: vscode.StatusBarAlignment.Right,
            priority: 15,
            refreshCommand: 'gcmp.chatgpt.refreshUsage',
            apiKeyProvider: 'codex',
            cacheKeyPrefix: 'chatgpt',
            logPrefix: 'ChatGPT状态栏',
            icon: '$(gcmp-openai)'
        };
        super(config);
    }

    /**
     * 获取显示文本
     * 格式: "$(icon) 85% (92%)" - 括号内是5小时额度，外面是每周额度
     * 只显示 300分钟 和 每周 两种窗口
     */
    protected getDisplayText(data: ChatGPTStatusData): string {
        const primaryWindow = data.rateLimit.primary_window;
        const secondaryWindow = data.rateLimit.secondary_window;

        // 获取窗口类型
        const primaryType = getWindowType(primaryWindow.limit_window_seconds);
        const secondaryType = secondaryWindow ? getWindowType(secondaryWindow.limit_window_seconds) : null;

        // 确定哪个是每周，哪个是每小时
        let weeklyRemaining = 0;
        let hourlyRemaining = 0;

        if (primaryType.type === 'weekly') {
            weeklyRemaining = Math.max(0, 100 - primaryWindow.used_percent);
            if (secondaryType && secondaryType.type === 'hourly' && secondaryWindow) {
                hourlyRemaining = Math.max(0, 100 - secondaryWindow.used_percent);
            }
        } else if (primaryType.type === 'hourly') {
            hourlyRemaining = Math.max(0, 100 - primaryWindow.used_percent);
            if (secondaryType && secondaryType.type === 'weekly' && secondaryWindow) {
                weeklyRemaining = Math.max(0, 100 - secondaryWindow.used_percent);
            }
        }

        // 括号内是5小时额度，外面是每周额度
        if (hourlyRemaining > 0) {
            return `${this.config.icon} ${weeklyRemaining.toFixed(0)}% (${hourlyRemaining.toFixed(0)}%)`;
        }

        return `${this.config.icon} ${weeklyRemaining.toFixed(0)}%`;
    }

    /**
     * 生成 Tooltip 内容
     */
    protected generateTooltip(data: ChatGPTStatusData): vscode.MarkdownString {
        const md = new vscode.MarkdownString();
        md.supportHtml = true;

        const primaryWindow = data.rateLimit.primary_window;
        const secondaryWindow = data.rateLimit.secondary_window;

        const primaryType = getWindowType(primaryWindow.limit_window_seconds);
        const secondaryType = secondaryWindow ? getWindowType(secondaryWindow.limit_window_seconds) : null;

        // 计划类型映射
        const planTypeMap: Record<string, string> = {
            free: 'Free',
            plus: 'Plus',
            pro: 'Pro',
            team: 'Team',
            enterprise: 'Enterprise'
        };
        const planTypeDisplay = planTypeMap[data.planType] || data.planType;

        md.appendMarkdown(`#### ChatGPT ${planTypeDisplay}\n\n`);
        md.appendMarkdown('| 限频类型 | 剩余量 | 重置时间 |\n');
        md.appendMarkdown('| :----: | ----: | :------: |\n');

        // 主窗口
        const primaryRemaining = Math.max(0, 100 - primaryWindow.used_percent);
        const primaryResetDate = new Date(primaryWindow.reset_at * 1000);
        const primaryResetTimeStr = primaryResetDate.toLocaleString('zh-CN', {
            month: 'numeric',
            day: 'numeric',
            hour: '2-digit',
            minute: '2-digit'
        });
        md.appendMarkdown(
            `| **${primaryType.label}** | **${primaryRemaining.toFixed(0)}%** | ${primaryResetTimeStr} |\n`
        );

        // 备用窗口（如果是有效类型）
        if (secondaryWindow && secondaryType) {
            const secondaryRemaining = Math.max(0, 100 - secondaryWindow.used_percent);
            const secondaryResetDate = new Date(secondaryWindow.reset_at * 1000);
            const secondaryResetTimeStr = secondaryResetDate.toLocaleString('zh-CN', {
                month: 'numeric',
                day: 'numeric',
                hour: '2-digit',
                minute: '2-digit'
            });
            md.appendMarkdown(
                `| **${secondaryType.label}** | **${secondaryRemaining.toFixed(0)}%** | ${secondaryResetTimeStr} |\n`
            );
        }

        md.appendMarkdown('\n');
        md.appendMarkdown('---\n');
        md.appendMarkdown(`**最后更新** ${data.lastUpdated}\n`);
        md.appendMarkdown('\n');
        md.appendMarkdown('---\n');
        md.appendMarkdown('点击状态栏可手动刷新\n');

        return md;
    }

    /**
     * 执行 API 查询
     * 实现 ChatGPT 用量查询逻辑
     */
    protected async performApiQuery(): Promise<{ success: boolean; data?: ChatGPTStatusData; error?: string }> {
        const USAGE_QUERY_URL = 'https://chatgpt.com/backend-api/wham/usage';

        try {
            // 获取 Codex 认证实例
            const codexAuth = CliAuthFactory.getInstance('codex') as CodexCliAuth | null;
            if (!codexAuth) {
                return {
                    success: false,
                    error: 'Codex CLI 认证未配置，请先完成 Codex CLI 登录'
                };
            }

            // 确保认证有效（自动刷新令牌）
            const credentials = await codexAuth.ensureAuthenticated();
            if (!credentials || !credentials.access_token) {
                return {
                    success: false,
                    error: 'Codex CLI 认证无效，请重新登录'
                };
            }

            // 获取 account_id
            const accountId = await codexAuth.getAccountId();
            if (!accountId) {
                return {
                    success: false,
                    error: '无法获取 ChatGPT 账户 ID'
                };
            }

            Logger.debug('触发查询 ChatGPT 用量');
            StatusLogger.debug(`[${this.config.logPrefix}] 开始查询 ChatGPT 用量...`);

            // 构建请求
            const requestOptions: RequestInit = {
                method: 'GET',
                headers: {
                    Authorization: `Bearer ${credentials.access_token}`,
                    'user-agent': configProviders.codex.customHeader?.['user-agent'] as string,
                    'chatgpt-account-id': accountId
                }
            };

            // 发送请求
            const response = await fetch(USAGE_QUERY_URL, requestOptions);
            const responseText = await response.text();

            StatusLogger.debug(
                `[${this.config.logPrefix}] 用量查询响应状态: ${response.status} ${response.statusText}`
            );

            // 解析响应
            let parsedResponse: ChatGPTUsageResponse;
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
                Logger.error(`用量查询失败: ${errorMessage}`);
                return {
                    success: false,
                    error: `查询失败: ${errorMessage}`
                };
            }

            // 检查必要的字段
            if (!parsedResponse.rate_limit || !parsedResponse.rate_limit.primary_window) {
                Logger.error('未获取到有效的用量数据');
                return {
                    success: false,
                    error: '未获取到有效的用量数据'
                };
            }

            const rateLimit = parsedResponse.rate_limit;

            // 格式化最后更新时间
            const lastUpdated = new Date().toLocaleString('zh-CN');

            // 解析代码审查用量
            let codeReviewUsedPercent = 0;
            if (parsedResponse.code_review_rate_limit?.primary_window) {
                codeReviewUsedPercent = parsedResponse.code_review_rate_limit.primary_window.used_percent;
            }

            // 解析成功响应
            StatusLogger.debug(`[${this.config.logPrefix}] 用量查询成功`);

            return {
                success: true,
                data: {
                    userId: parsedResponse.user_id,
                    accountId: parsedResponse.account_id,
                    email: parsedResponse.email,
                    planType: parsedResponse.plan_type,
                    rateLimit: rateLimit,
                    codeReviewUsedPercent,
                    lastUpdated
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
     * 当每周使用率超过 80% 时高亮显示
     */
    protected shouldHighlightWarning(data: ChatGPTStatusData): boolean {
        const primaryWindow = data.rateLimit.primary_window;
        const secondaryWindow = data.rateLimit.secondary_window;

        // 检查每周额度的使用率
        const primaryType = getWindowType(primaryWindow.limit_window_seconds);
        if (primaryType.type === 'weekly') {
            return primaryWindow.used_percent >= this.HIGH_USAGE_THRESHOLD;
        }

        // 如果主窗口不是每周，检查备用窗口
        if (secondaryWindow) {
            const secondaryType = getWindowType(secondaryWindow.limit_window_seconds);
            if (secondaryType.type === 'weekly') {
                return secondaryWindow.used_percent >= this.HIGH_USAGE_THRESHOLD;
            }
        }

        return false;
    }

    /**
     * 检查是否需要刷新缓存
     * 每5分钟固定刷新一次
     */
    protected shouldRefresh(): boolean {
        if (!this.lastStatusData) {
            return true;
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
     * 检查是否应该显示状态栏
     * 通过检查 Codex CLI 认证是否存在
     */
    protected async shouldShowStatusBar(): Promise<boolean> {
        try {
            const codexAuth = CliAuthFactory.getInstance('codex') as CodexCliAuth | null;
            if (!codexAuth) {
                return false;
            }
            const credentials = await codexAuth.loadCredentials();
            return credentials !== null && credentials.access_token !== undefined;
        } catch {
            return false;
        }
    }

    /**
     * 访问器：获取最后的状态数据（用于测试和调试）
     */
    getLastStatusData(): { data: ChatGPTStatusData; timestamp: number } | null {
        return this.lastStatusData;
    }
}
