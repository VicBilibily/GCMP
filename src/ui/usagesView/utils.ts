/**
 * UsagesView 工具函数
 */

import type { BaseStats, HourlyStats } from '../../usages/fileLogger/types';
import type { ExtendedTokenRequestLog, SessionGroup, SessionSummary, WebViewMessage } from './types';

export const UNKNOWN_SESSION_ID = 'unknown';

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/**
 * 判断字符串是否为标准 UUID
 */
function isUuid(value: string): boolean {
    return UUID_PATTERN.test(value);
}

/**
 * 将时间戳格式化为时分秒文本
 */
function formatClockTime(timestamp?: number): string {
    if (!timestamp) {
        return '-';
    }

    try {
        return new Date(timestamp).toLocaleTimeString('zh-CN', {
            hour12: false,
            hour: '2-digit',
            minute: '2-digit',
            second: '2-digit'
        });
    } catch {
        return '-';
    }
}

/**
 * 获取单条记录用于汇总的 Token 数，优先实际值，缺失时退回预估值
 */
function getRecordTotalTokens(record: ExtendedTokenRequestLog): number {
    if (record.totalTokens > 0) {
        return record.totalTokens;
    }

    return Math.max(record.estimatedInput || 0, 0);
}

/**
 * 汇总一组会话记录，生成展示所需的统计信息
 */
export function summarizeSessionRecords(records: ExtendedTokenRequestLog[]): SessionSummary {
    const timestamps = records
        .map(record => record.timestamp)
        .filter((timestamp): timestamp is number => Number.isFinite(timestamp));
    const speedRecords = records.filter(record => (record.outputSpeed || 0) > 0);

    return {
        requestCount: records.length,
        totalTokens: records.reduce((sum, record) => sum + getRecordTotalTokens(record), 0),
        startTime: timestamps.length > 0 ? Math.min(...timestamps) : undefined,
        endTime: timestamps.length > 0 ? Math.max(...timestamps) : undefined,
        completedCount: records.filter(record => record.status === 'completed').length,
        failedCount: records.filter(record => record.status === 'failed').length,
        avgSpeed:
            speedRecords.length > 0 ?
                speedRecords.reduce((sum, record) => sum + (record.outputSpeed || 0), 0) / speedRecords.length
            :   undefined
    };
}

function isChineseLocale(): boolean {
    const lang = (document.documentElement.lang || navigator.language || '').toLowerCase();
    return lang === 'zh-cn' || lang === 'zh' || lang.startsWith('zh-');
}

/**
 * 根据当前语言返回文案，并按 {0}、{1} 占位符依次替换参数
 */
export function t(en: string, zh: string, ...args: Array<string | number>): string {
    let result = isChineseLocale() ? zh : en;

    args.forEach((arg, index) => {
        const value = typeof arg === 'number' ? String(arg) : arg;
        result = result.replace(`{${index}}`, value);
    });

    return result;
}

/**
 * 判断记录是否具备可用于识别对话会话的 OTel Trace 上下文
 */
function hasConversationTraceContext(record: Pick<ExtendedTokenRequestLog, 'otelTraceContext'>): boolean {
    return Boolean(record.otelTraceContext?.traceId && record.otelTraceContext?.spanId);
}

/**
 * 仅当记录包含 otelTraceContext 时，才将原始 sessionId 归一化为统一可分组的值
 */
export function normalizeSessionId(record: Pick<ExtendedTokenRequestLog, 'sessionId' | 'otelTraceContext'>): string {
    if (!hasConversationTraceContext(record)) {
        return UNKNOWN_SESSION_ID;
    }

    const value = record.sessionId?.trim();
    if (!value) {
        return UNKNOWN_SESSION_ID;
    }

    if (isUuid(value)) {
        return value.toLowerCase();
    }

    const sessionIndex = value.lastIndexOf('_session_');
    if (sessionIndex !== -1) {
        const extracted = value.slice(sessionIndex + '_session_'.length).trim();
        if (isUuid(extracted)) {
            return extracted.toLowerCase();
        }
    }

    return UNKNOWN_SESSION_ID;
}

/**
 * 生成会话短展示 ID，规则与 Git short hash 类似
 */
export function getSessionDisplayId(sessionId: string): string {
    if (!sessionId || sessionId === UNKNOWN_SESSION_ID) {
        return UNKNOWN_SESSION_ID;
    }

    return sessionId.slice(0, 7);
}

/**
 * 格式化会话的起止时间范围
 */
export function formatSessionTimeRange(startTime?: number, endTime?: number): string {
    if (!startTime && !endTime) {
        return '-';
    }

    const start = formatClockTime(startTime || endTime);
    const end = formatClockTime(endTime || startTime);
    return start === end ? start : `${start} - ${end}`;
}

/**
 * 按归一化后的 sessionId 对请求记录分组，并附带汇总结果
 */
export function groupRecordsBySession(records: ExtendedTokenRequestLog[]): SessionGroup[] {
    const groups = new Map<string, ExtendedTokenRequestLog[]>();

    records.forEach(record => {
        const sessionId = normalizeSessionId(record);
        const sessionRecords = groups.get(sessionId);
        if (sessionRecords) {
            sessionRecords.push(record);
            return;
        }

        groups.set(sessionId, [record]);
    });

    return Array.from(groups.entries())
        .map(([sessionId, sessionRecords]) => {
            const sortedRecords = [...sessionRecords].sort((a, b) => b.timestamp - a.timestamp);
            return {
                sessionId,
                displayId: getSessionDisplayId(sessionId),
                records: sortedRecords,
                summary: summarizeSessionRecords(sortedRecords)
            };
        })
        .sort((a, b) => (b.summary.endTime || 0) - (a.summary.endTime || 0));
}

/**
 * 获取提供商显示名称（处理特殊情况）
 * 例如：providerKey 为 "kimi" 时，显示名称应为 "Kimi"
 * @param providerKey - 提供商唯一标识
 * @param providerName - 原始提供商名称
 * @returns 显示名称
 */
export function getProviderDisplayName(providerKey: string, providerName: string): string {
    // 特殊处理：kimi 显示为 Kimi
    if (providerKey === 'kimi') {
        return 'Kimi';
    }
    return providerName;
}

/**
 * 请求来源的显示名称映射（[英文, 中文]）
 */
const REQUEST_KIND_DISPLAY_NAMES: Record<string, [string, string]> = {
    'main-agent': ['Agent Chat', 'Agent 对话'],
    'terminal-steering': ['Terminal Steering', '终端引导'],
    'todo-tracker': ['Todo Tracker', '待办跟踪'],
    'prompt-categorizer': ['Prompt Categorizer', 'Prompt 分类'],
    'settings-resolver': ['Settings Resolver', '设置解析'],
    'chat-title': ['Chat Title', '会话标题'],
    'inline-progress-message': ['Progress Message', '进度消息'],
    'git-branch-name': ['Branch Naming', '分支命名'],
    'git-commit-message': ['Commit Message', '提交消息'],
    'rename-suggestions': ['Rename Suggestions', '重命名建议'],
    background: ['Background Request', '后台请求'],
    unknown: ['Unknown', '未知']
};

/**
 * 获取请求来源的友好显示名称（自动按语言切换中英文）
 */
export function getRequestKindDisplayName(kind?: string): string {
    if (!kind) {
        return '-';
    }
    const names = REQUEST_KIND_DISPLAY_NAMES[kind];
    if (!names) {
        return kind;
    }
    return isChineseLocale() ? names[1] : names[0];
}

/**
 * 格式化 Token 数量显示
 */
export function formatTokens(tokens: number | undefined | null): string {
    const safeTokens = tokens ?? 0;
    if (safeTokens >= 1000000) {
        return (safeTokens / 1000000).toFixed(1) + 'M';
    } else if (safeTokens >= 1000) {
        return (safeTokens / 1000).toFixed(1) + 'K';
    }
    return safeTokens.toString();
}

/**
 * 计算总 Token 数
 */
export function calculateTotalTokens(stats: BaseStats): number {
    return stats.actualInput + stats.outputTokens;
}

/**
 * 计算平均输出速度
 * 优先使用 outputSpeeds（已聚合后的平均速度，写入缓存）
 */
export function calculateAverageSpeed(stats: BaseStats | HourlyStats): string {
    if (stats.outputSpeeds && stats.outputSpeeds > 0) {
        return `${stats.outputSpeeds.toFixed(1)} t/s`;
    }
    return '-';
}

/**
 * 计算平均首Token延迟
 */
export function calculateAverageFirstTokenLatency(stats: BaseStats): string {
    if (!stats.firstTokenLatency || stats.firstTokenLatency <= 0) {
        return '-';
    }
    const avgLatency = stats.firstTokenLatency;
    if (avgLatency >= 1000) {
        return `${(avgLatency / 1000).toFixed(1)} s`;
    }
    return `${Math.round(avgLatency)} ms`;
}

/**
 * 获取今日日期字符串
 */
export function getTodayDateString(): string {
    const now = new Date();
    return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
}

/**
 * 向 VSCode 发送消息
 */
export function postToVSCode(message: WebViewMessage): void {
    try {
        if ('vscode' in window) {
            const vscode = window.vscode as unknown as { postMessage(message: WebViewMessage): void };
            if (vscode && typeof vscode.postMessage === 'function') {
                vscode.postMessage(message);
            }
        }
    } catch (error) {
        console.error('Failed to post message to VS Code:', error);
    }
}
