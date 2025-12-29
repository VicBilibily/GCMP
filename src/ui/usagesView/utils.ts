/**
 * UsagesView 工具函数
 */

import { BaseStats } from '../../usages/fileLogger/types';
import { WebViewMessage } from './types';

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
