/**
 * UsagesView 工具函数
 */

import type { BaseStats, HourlyStats } from '../../usages/fileLogger/types';
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
        console.error('发送消息失败:', error);
    }
}
