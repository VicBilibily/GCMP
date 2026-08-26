/*---------------------------------------------------------------------------------------------
 *  Codex (ChatGPT) 余量查询共享模块
 *  状态栏与配置面板 CLI 详情区共用：查询、解析、百分比总览、窗口表格
 *--------------------------------------------------------------------------------------------*/

import { configProviders } from '../providers/config';
import { StatusLogger } from '../utils/runtime/statusLogger';
import { Logger } from '../utils/runtime/logger';
import { CliAuthFactory } from '../cli/auth/cliAuthFactory';
import { CodexCliAuth } from '../cli/auth/codexCliAuth';
import { t } from '../utils/runtime/l10n';
import type { QuotaTable } from './types';
import { ConfigManager } from '../utils/config/configManager';
import { formatCompactCountdown, formatQuotaDateForSlot } from './format';

/** ChatGPT 余量查询接口 */
const USAGE_QUERY_URL = 'https://chatgpt.com/backend-api/wham/usage';
const CODEX_USAGE_TIMEOUT_MS = 10000;

/** 速率限制窗口结构 */
export interface RateLimitWindow {
    /** 已使用百分比 */
    used_percent: number;
    /** 限制窗口秒数 */
    limit_window_seconds: number;
    /** 剩余重置秒数 */
    reset_after_seconds: number;
    /** 重置时间戳（秒） */
    reset_at: number;
}

/** 速率限制信息结构 */
export interface RateLimitInfo {
    /** 是否允许 */
    allowed: boolean;
    /** 是否达到限制 */
    limit_reached: boolean;
    /** 主时间窗口 */
    primary_window: RateLimitWindow;
    /** 备用时间窗口 */
    secondary_window?: RateLimitWindow;
}

/** ChatGPT 用量信息数据结构（API 响应格式） */
export interface ChatGPTUsageResponse {
    /** 用户 ID */
    user_id: string;
    /** 账户 ID */
    account_id: string;
    /** 邮箱 */
    email: string;
    /** 计划类型：free, plus, pro, team, self_serve_business_usage_based 等 */
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

/** ChatGPT 余量解析结果 */
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

/** 窗口类型（仅区分 5 小时 / 每周） */
export interface WindowType {
    type: 'hourly' | 'weekly';
    label: string;
}

/**
 * 根据 limit_window_seconds 判断窗口类型
 * 只处理 300 分钟(5 小时) 和 1 周 两种情况
 */
export function getWindowType(limitWindowSeconds: number): WindowType {
    const FIVE_HOURS = 5 * 60 * 60;
    const WEEK = 7 * 24 * 60 * 60;

    if (limitWindowSeconds === FIVE_HOURS) {
        return { type: 'hourly', label: t('5 Hours', '300 分钟') };
    } else if (limitWindowSeconds === WEEK) {
        return { type: 'weekly', label: t('Weekly quota', '每周额度') };
    }
    return { type: 'weekly', label: t('Weekly quota', '每周额度') };
}

export function hasValidRateLimitWindow(window: RateLimitWindow | undefined): window is RateLimitWindow {
    return !!window && [window.used_percent, window.limit_window_seconds, window.reset_at].every(Number.isFinite);
}

export function getRemainingPercent(window: RateLimitWindow | undefined): number {
    return hasValidRateLimitWindow(window) ? Math.max(0, 100 - window.used_percent) : 0;
}

export function getResetDate(window: RateLimitWindow | undefined): Date | undefined {
    if (!hasValidRateLimitWindow(window)) {
        return undefined;
    }
    const resetDate = new Date(window.reset_at * 1000);
    return Number.isFinite(resetDate.getTime()) ? resetDate : undefined;
}

/**
 * 查询 Codex (ChatGPT) 余量
 * 走 CliAuthFactory 静态入口，多窗口下由 Leader 单点刷新凭证
 */
export async function queryCodexUsage(): Promise<{ success: boolean; data?: ChatGPTStatusData; error?: string }> {
    try {
        const codexAuth = CliAuthFactory.getInstance('codex') as CodexCliAuth | null;
        if (!codexAuth) {
            return {
                success: false,
                error: t(
                    'Codex CLI authentication is not configured. Sign in to Codex CLI first.',
                    'Codex CLI 认证未配置，请先完成 Codex CLI 登录'
                )
            };
        }

        const credentials = await CliAuthFactory.ensureAuthenticated('codex');
        if (!credentials || !credentials.access_token) {
            return {
                success: false,
                error: t('Codex CLI authentication is invalid. Please sign in again.', 'Codex CLI 认证无效，请重新登录')
            };
        }

        const accountId = await codexAuth.getAccountId();
        if (!accountId) {
            return { success: false, error: t('Unable to get the ChatGPT account ID.', '无法获取 ChatGPT 账户 ID') };
        }

        StatusLogger.debug('[CodexUsageQuery] Starting ChatGPT usage query...');

        const abortController = new AbortController();
        const timeoutId = setTimeout(() => abortController.abort(), CODEX_USAGE_TIMEOUT_MS);

        const requestOptions: RequestInit = {
            method: 'GET',
            headers: {
                Authorization: `Bearer ${credentials.access_token}`,
                'user-agent': configProviders.codex.customHeader?.['user-agent'] as string,
                'chatgpt-account-id': accountId
            },
            signal: abortController.signal
        };

        let response: Response;
        let responseText: string;
        try {
            response = await ConfigManager.fetchWithProxy(USAGE_QUERY_URL, requestOptions, {
                providerKey: 'codex'
            });
            responseText = await response.text();
        } finally {
            clearTimeout(timeoutId);
        }

        let parsedResponse: ChatGPTUsageResponse;
        try {
            parsedResponse = JSON.parse(responseText);
        } catch (parseError) {
            Logger.error(`[CodexUsageQuery] Failed to parse response JSON: ${parseError}`);
            return {
                success: false,
                error: t('Invalid response format: {0}', '响应格式错误: {0}', responseText.substring(0, 200))
            };
        }

        if (!response.ok) {
            let errorMessage = `HTTP ${response.status}`;
            if (responseText) {
                try {
                    const errorData = JSON.parse(responseText);
                    if (errorData.error) {
                        errorMessage = errorData.error.message || errorData.error;
                    }
                } catch {
                    // 解析错误响应失败，使用默认信息
                }
            }
            Logger.error(`[CodexUsageQuery] Usage query failed: ${errorMessage}`);
            return { success: false, error: t('Query failed: {0}', '查询失败: {0}', errorMessage) };
        }

        const primaryWindow = parsedResponse.rate_limit?.primary_window;
        if (!hasValidRateLimitWindow(primaryWindow)) {
            Logger.error('[CodexUsageQuery] No valid usage data retrieved');
            return { success: false, error: t('No valid usage data was returned.', '未获取到有效的用量数据') };
        }

        const secondaryWindow =
            hasValidRateLimitWindow(parsedResponse.rate_limit.secondary_window) ?
                parsedResponse.rate_limit.secondary_window
            :   undefined;
        const rateLimit: RateLimitInfo = {
            ...parsedResponse.rate_limit,
            primary_window: primaryWindow,
            secondary_window: secondaryWindow
        };
        let codeReviewUsedPercent = 0;
        if (hasValidRateLimitWindow(parsedResponse.code_review_rate_limit?.primary_window)) {
            codeReviewUsedPercent = parsedResponse.code_review_rate_limit.primary_window.used_percent;
        }

        const lastUpdated = formatQuotaDateForSlot('codex', new Date());

        StatusLogger.debug('[CodexUsageQuery] Usage query succeeded');

        return {
            success: true,
            data: {
                userId: parsedResponse.user_id,
                accountId: parsedResponse.account_id,
                email: parsedResponse.email,
                planType: parsedResponse.plan_type,
                rateLimit,
                codeReviewUsedPercent,
                lastUpdated
            }
        };
    } catch (error) {
        if (error instanceof Error && error.name === 'AbortError') {
            Logger.warn('[CodexUsageQuery] Usage query timed out');
            return {
                success: false,
                error: t('Query timed out. Please retry.', '查询超时，请稍后重试。')
            };
        }
        const errorMessage = error instanceof Error ? error.message : t('Unknown error', '未知错误');
        Logger.error(`[CodexUsageQuery] Usage query exception: ${errorMessage}`);
        return { success: false, error: t('Query error: {0}', '查询异常: {0}', errorMessage) };
    }
}

/**
 * 构建百分比总览文本（不含图标前缀）
 * 格式：每周剩余 (5 小时剩余)，无 5 小时窗口时仅每周剩余
 */
export function buildCodexUsageSummary(data: ChatGPTStatusData): string {
    const primaryWindow = data.rateLimit.primary_window;
    const secondaryWindow =
        hasValidRateLimitWindow(data.rateLimit.secondary_window) ? data.rateLimit.secondary_window : undefined;
    const primaryType = getWindowType(hasValidRateLimitWindow(primaryWindow) ? primaryWindow.limit_window_seconds : 0);
    const secondaryType = secondaryWindow ? getWindowType(secondaryWindow.limit_window_seconds) : null;

    let weeklyRemaining = 0;
    let hourlyRemaining = 0;

    if (primaryType.type === 'weekly') {
        weeklyRemaining = getRemainingPercent(primaryWindow);
        if (secondaryType && secondaryType.type === 'hourly' && secondaryWindow) {
            hourlyRemaining = getRemainingPercent(secondaryWindow);
        }
    } else if (primaryType.type === 'hourly') {
        hourlyRemaining = getRemainingPercent(primaryWindow);
        if (secondaryType && secondaryType.type === 'weekly' && secondaryWindow) {
            weeklyRemaining = getRemainingPercent(secondaryWindow);
        }
    }

    if (hourlyRemaining > 0) {
        return `${weeklyRemaining.toFixed(0)}% (${hourlyRemaining.toFixed(0)}%)`;
    }
    return `${weeklyRemaining.toFixed(0)}%`;
}

/** 面板用窗口表格结构 */
export type CodexUsageTable = QuotaTable;

/**
 * 构建限频窗口表格（限频类型 / 剩余量 / 倒计时 / 重置时间）
 */
export function buildCodexUsageTable(data: ChatGPTStatusData): QuotaTable {
    const columns = [
        t('Window', '限频类型'),
        t('Remaining', '剩余量'),
        t('Countdown', '倒计时'),
        t('Reset Time', '重置时间')
    ];
    const rows: string[][] = [];

    const primaryWindow = data.rateLimit.primary_window;
    const secondaryWindow =
        hasValidRateLimitWindow(data.rateLimit.secondary_window) ? data.rateLimit.secondary_window : undefined;
    const primaryType = getWindowType(hasValidRateLimitWindow(primaryWindow) ? primaryWindow.limit_window_seconds : 0);
    const secondaryType = secondaryWindow ? getWindowType(secondaryWindow.limit_window_seconds) : null;
    const primaryResetDate = getResetDate(primaryWindow);

    rows.push([
        primaryType.label,
        `${getRemainingPercent(primaryWindow).toFixed(0)}%`,
        formatCompactCountdown(primaryResetDate?.toISOString()),
        primaryResetDate ? formatQuotaDateForSlot('codex', primaryResetDate) : '—'
    ]);

    if (secondaryWindow && secondaryType) {
        const secondaryResetDate = getResetDate(secondaryWindow);
        rows.push([
            secondaryType.label,
            `${getRemainingPercent(secondaryWindow).toFixed(0)}%`,
            formatCompactCountdown(secondaryResetDate?.toISOString()),
            secondaryResetDate ? formatQuotaDateForSlot('codex', secondaryResetDate) : '—'
        ]);
    }

    return { columns, rows };
}
