/*---------------------------------------------------------------------------------------------
 *  Grok 订阅余量查询共享模块
 *  状态栏与配置面板 CLI 详情区共用：HTTP 查询 + 响应解析 + 表格构建。
 *  lastUpdated 由调用方格式化传入，避免在共享层依赖 vscode.env.language。
 *--------------------------------------------------------------------------------------------*/

import { ConfigManager } from '../utils/config/configManager';
import { Logger } from '../utils/runtime/logger';
import { StatusLogger } from '../utils/runtime/statusLogger';
import { CliAuthFactory } from '../cli/auth/cliAuthFactory';
import { t } from '../utils/runtime/l10n';
import type { QuotaTable } from './types';
import { parseGrokBillingUsage, resolveGrokBillingBaseUrl } from './parsers/grokUsageParser';
import type { GrokBillingParseResult, GrokUsageLimit } from './parsers/grokUsageParser';
import { formatCompactCountdown, formatQuotaDateForSlot } from './format';

// ============= 查询入口 =============

/** Grok 余量查询返回数据（面板与状态栏共用） */
export interface GrokStatusData {
    usage: GrokUsageLimit;
    lastUpdated: string;
}

interface GrokCredentials {
    access_token: string;
    user_id?: string;
}

type BillingRequestResult = { kind: 'parsed'; result: GrokBillingParseResult } | { kind: 'error'; error: string };

/**
 * 查询 Grok 订阅余量
 * 先走 credits 端点取周配额；不可用时回退到 billing 端点取月度配额。
 * @param lastUpdated 已格式化的本地时间字符串（由调用方生成，避免依赖 vscode.env.language）
 */
export async function queryGrokUsage(
    lastUpdated: string
): Promise<{ success: boolean; data?: GrokStatusData; error?: string }> {
    try {
        const credentials = (await CliAuthFactory.ensureAuthenticated('grok')) as GrokCredentials | null;
        if (!credentials?.access_token) {
            return {
                success: false,
                error: t(
                    'Grok CLI authentication is invalid. Sign in to Grok CLI first.',
                    'Grok CLI 认证无效，请先完成 Grok CLI 登录'
                )
            };
        }

        StatusLogger.debug('[GrokUsageQuery] Starting Grok usage query...');
        const creditsResult = await requestBillingUsage(credentials, '?format=credits', 'credits');
        if (creditsResult.kind === 'error') {
            return { success: false, error: creditsResult.error };
        }

        let parsedResult = creditsResult.result;
        const creditsSubscriptionTier = parsedResult.kind === 'unavailable' ? parsedResult.subscriptionTier : undefined;
        if (parsedResult.kind === 'unavailable') {
            const monthlyResult = await requestBillingUsage(credentials, '', 'billing');
            if (monthlyResult.kind === 'error') {
                return { success: false, error: monthlyResult.error };
            }
            parsedResult = monthlyResult.result;
        }

        if (parsedResult.kind === 'invalid') {
            return {
                success: false,
                error: t('Invalid Grok usage response: {0}', 'Grok 用量响应无效: {0}', parsedResult.error)
            };
        }
        if (parsedResult.kind === 'unavailable') {
            return {
                success: false,
                error: t('No Grok subscription quota was returned for this account.', '当前 Grok 账户未返回订阅额度')
            };
        }

        const usage =
            !parsedResult.usage.subscriptionTier && creditsSubscriptionTier ?
                { ...parsedResult.usage, subscriptionTier: creditsSubscriptionTier }
            :   parsedResult.usage;
        return {
            success: true,
            data: {
                usage,
                lastUpdated
            }
        };
    } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        Logger.error(`[GrokUsageQuery] Usage query exception: ${errorMessage}`);
        return {
            success: false,
            error: t('Query failed: {0}', '查询失败: {0}', errorMessage)
        };
    }
}

async function requestBillingUsage(
    credentials: GrokCredentials,
    query: string,
    source: 'credits' | 'billing'
): Promise<BillingRequestResult> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 10_000);
    const headers: Record<string, string> = {
        Authorization: `Bearer ${credentials.access_token}`,
        'X-XAI-Token-Auth': 'xai-grok-cli',
        Accept: 'application/json'
    };
    if (credentials.user_id) {
        headers['x-userid'] = credentials.user_id;
    }

    try {
        const baseUrl = resolveGrokBillingBaseUrl(process.env);
        const response = await ConfigManager.fetchWithProxy(
            `${baseUrl}/billing${query}`,
            {
                method: 'GET',
                headers,
                signal: controller.signal
            },
            {
                providerKey: 'grok'
            }
        );
        const responseText = await response.text();

        StatusLogger.debug(`[GrokUsageQuery] Usage query response status: ${response.status} ${response.statusText}`);

        if (!response.ok) {
            const authorizationMessage =
                response.status === 401 || response.status === 403 ?
                    t('Grok CLI authorization was rejected. Sign in again.', 'Grok CLI 授权被拒绝，请重新登录')
                :   t('Grok usage query failed with HTTP {0}.', 'Grok 用量查询失败，HTTP {0}', response.status);
            return { kind: 'error', error: authorizationMessage };
        }

        let payload: unknown;
        try {
            payload = JSON.parse(responseText);
        } catch {
            return {
                kind: 'error',
                error: t('Grok usage response is not valid JSON.', 'Grok 用量响应不是有效 JSON')
            };
        }

        return { kind: 'parsed', result: parseGrokBillingUsage(payload, source) };
    } finally {
        clearTimeout(timeout);
    }
}

/**
 * 构建百分比总览文本（不含图标前缀）
 * 格式：剩余百分比（如 "85%"）
 */
export function buildGrokUsageSummary(data: GrokStatusData): string {
    return `${data.usage.remainingPercent.toFixed(0)}%`;
}

/**
 * 构建限频窗口表格（限频类型 / 剩余量 / 倒计时 / 重置时间）
 */
export function buildGrokUsageTable(data: GrokStatusData): QuotaTable {
    const columns = [
        t('Window', '限频类型'),
        t('Remaining', '剩余量'),
        t('Countdown', '倒计时'),
        t('Reset Time', '重置时间')
    ];
    const windowLabel = data.usage.type === 'weekly' ? t('Weekly quota', '每周额度') : t('Monthly quota', '每月额度');
    const tier = data.usage.subscriptionTier ? ` (${data.usage.subscriptionTier})` : '';
    const rows: string[][] = [
        [
            `${windowLabel}${tier}`,
            `${data.usage.remainingPercent.toFixed(0)}%`,
            formatCompactCountdown(data.usage.resetAt),
            data.usage.resetAt ? formatQuotaDateForSlot('grok', new Date(data.usage.resetAt)) : '—'
        ]
    ];
    return { columns, rows };
}
