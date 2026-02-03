/**
 * UsagesView 工具函数
 */

import { BaseStats } from '../../usages/fileLogger/types';
import { WebViewMessage } from './types';

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
 */
export function calculateAverageSpeed(stats: BaseStats): string {
    if (
        !stats.totalStreamDuration ||
        stats.totalStreamDuration <= 0 ||
        !stats.validStreamRequests ||
        stats.validStreamRequests <= 0 ||
        !stats.validStreamOutputTokens ||
        stats.validStreamOutputTokens <= 0
    ) {
        return '-';
    }
    // 计算平均速度: 有时间记录的输出tokens / 总耗时(秒)
    const avgSpeed = (stats.validStreamOutputTokens / stats.totalStreamDuration) * 1000;
    // 如果速度大于 1000，认为数据异常，返回 "-"
    if (avgSpeed > 1000) {
        return '-';
    }
    return `${avgSpeed.toFixed(1)} t/s`;
}

/**
 * 计算平均首Token延迟
 */
export function calculateAverageFirstTokenLatency(stats: BaseStats): string {
    if (
        !stats.totalFirstTokenLatency ||
        stats.totalFirstTokenLatency <= 0 ||
        !stats.validStreamRequests ||
        stats.validStreamRequests <= 0
    ) {
        return '-';
    }
    // 计算平均延迟: 总延迟 / 有效请求数
    const avgLatency = stats.totalFirstTokenLatency / stats.validStreamRequests;
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
        console.error('发送消息失败:', error);
    }
}
