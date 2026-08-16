/*---------------------------------------------------------------------------------------------
 *  Provider 配额查询共享层 - 纯格式化工具
 *  日期/倒计时/货币格式化，无查询域依赖，status 状态栏与 quota 面板共用。
 *---------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { t } from '../utils/runtime/l10n';

// ============= 日期/倒计时格式化 =============

export function formatQuotaDate(date: Date): string {
    const month = String(date.getMonth() + 1).padStart(2, '0');
    const day = String(date.getDate()).padStart(2, '0');
    const hours = String(date.getHours()).padStart(2, '0');
    const minutes = String(date.getMinutes()).padStart(2, '0');
    return `${month}-${day} ${hours}:${minutes}`;
}

export function formatQuotaLastUpdated(date: Date): string {
    const year = String(date.getFullYear());
    const month = String(date.getMonth() + 1).padStart(2, '0');
    const day = String(date.getDate()).padStart(2, '0');
    const hours = String(date.getHours()).padStart(2, '0');
    const minutes = String(date.getMinutes()).padStart(2, '0');
    const seconds = String(date.getSeconds()).padStart(2, '0');
    return `${year}/${month}/${day} ${hours}:${minutes}:${seconds}`;
}

/** 斜杠短格式（MM/DD HH:mm），状态栏 tooltip 常用 */
export function formatDateTimeSlash(date: Date): string {
    const month = String(date.getMonth() + 1).padStart(2, '0');
    const day = String(date.getDate()).padStart(2, '0');
    const hours = String(date.getHours()).padStart(2, '0');
    const minutes = String(date.getMinutes()).padStart(2, '0');
    return `${month}/${day} ${hours}:${minutes}`;
}

/** 完整本地化时间（zh-CN / en-US），状态数据 lastUpdated 用 */
export function formatLocaleDateTime(date: Date): string {
    return date.toLocaleString(vscode.env.language.toLowerCase().startsWith('zh') ? 'zh-CN' : 'en-US');
}

export function formatQuotaDateForSlot(slot: string, date: Date): string {
    if (slot === 'kimi' || slot === 'grok' || slot === 'opencode') {
        return formatDateTimeSlash(date);
    }

    if (slot === 'moonshot' || slot === 'deepseek' || slot === 'codex') {
        return date.toLocaleString(vscode.env.language.toLowerCase().startsWith('zh') ? 'zh-CN' : 'en-US');
    }

    return formatQuotaDate(date);
}

/** 紧凑倒计时（"3d 05h" / "23m" / "45s"），空或已过期返回 "—" / "即将重置" */
export function formatCompactCountdown(resetsAt?: string): string {
    if (!resetsAt) {
        return '—';
    }
    const diffMs = new Date(resetsAt).getTime() - Date.now();
    if (diffMs <= 0) {
        return t('Resets soon', '即将重置');
    }

    const seconds = Math.floor(diffMs / 1000);
    const days = Math.floor(seconds / 86400);
    const hours = Math.floor((seconds % 86400) / 3600);
    const minutes = Math.floor((seconds % 3600) / 60);

    if (days > 0) {
        return `${days}d${hours > 0 ? ` ${String(hours).padStart(2, '0')}h` : ''}`;
    }
    if (hours > 0) {
        return `${hours}h${minutes > 0 ? ` ${String(minutes).padStart(2, '0')}m` : ''}`;
    }
    if (minutes > 0) {
        return `${minutes}m`;
    }
    return `${seconds}s`;
}

/** 本地化倒计时（"{0}天 {1}小时" 风格，面板表格用） */
export function formatQuotaCountdown(resetAt: string): string {
    const diffMs = new Date(resetAt).getTime() - Date.now();
    if (!Number.isFinite(diffMs) || diffMs <= 0) {
        return t('expired', '已到期');
    }

    const totalMinutes = Math.floor(diffMs / 60000);
    const days = Math.floor(totalMinutes / (60 * 24));
    const hours = Math.floor((totalMinutes % (60 * 24)) / 60);
    const minutes = totalMinutes % 60;

    if (days > 0) {
        return t('{0}d {1}h', '{0}天 {1}小时', days, hours);
    }
    if (hours > 0) {
        return t('{0}h {1}m', '{0}小时 {1}分', hours, minutes);
    }
    return t('{0}m', '{0}分', minutes);
}

// ============= 货币格式化 =============

export function formatCurrency(currency: string, amount: number): string {
    if (!Number.isFinite(amount)) {
        return '-';
    }
    const symbol = currency === 'USD' ? '$' : '¥';
    return `${symbol}${amount.toFixed(2)}`;
}

export function getCurrencySymbol(currency: string): string {
    switch (currency) {
        case 'USD':
            return '$';
        case 'CNY':
        case 'RMB':
            return '¥';
        default:
            return '';
    }
}

// ============= 通用余额格式化 =============

export function formatCompatibleBalanceValue(amount: number | undefined, currency: string): string {
    if (amount === undefined) {
        return '-';
    }
    if (amount === Number.MAX_SAFE_INTEGER) {
        return t('Unlimited', '无限制');
    }
    if (amount === Number.MIN_SAFE_INTEGER) {
        return t('Depleted', '耗尽');
    }
    const symbol = getCurrencySymbol(currency);
    if (symbol) {
        return `${symbol}${amount.toFixed(2)}`;
    }
    const formatted = Number.isInteger(amount) ? amount.toString() : amount.toFixed(2);
    return `${formatted} ${currency}`;
}
