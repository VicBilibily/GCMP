/*---------------------------------------------------------------------------------------------
 *  Prompt Cache 管理器
 *  管理 OpenAI Responses API 的 prompt_cache_key 缓存
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { Logger } from '../utils/logger';
import OpenAI from 'openai';

/**
 * 统一的缓存条目接口
 */
interface UnifiedCacheEntry {
    responseId: string;
    promptCacheKey?: string; // 只有 GPT/Codex 有 prompt_cache_key
    // output: readonly OpenAI.Responses.ResponseOutputItem[];
    summary: string; // 预计算的消息摘要
    timestamp: number;
}

/**
 * Prompt Cache 管理器
 * 统一管理所有模型的响应缓存（GPT/Codex 的 prompt_cache_key 和豆包的 response.id）
 * 通过比较最后几条消息来确认会话属于哪个缓存
 */
export class PromptCacheManager {
    private static instance: PromptCacheManager;
    // 统一的缓存：key 为 responseId 或 promptCacheKey
    private cache: Map<string, UnifiedCacheEntry> = new Map<string, UnifiedCacheEntry>();
    private maxCacheSize = 500; // 最大缓存条目数
    private cacheTimeout = 1000 * 60 * 60; // 1小时缓存过期时间

    private constructor() {}

    public static getInstance(): PromptCacheManager {
        if (!PromptCacheManager.instance) {
            PromptCacheManager.instance = new PromptCacheManager();
        }
        return PromptCacheManager.instance;
    }

    /**
     * 从单个 LanguageModelChatMessage 中提取摘要
     * @param message 单个消息
     * @returns 消息摘要字符串
     */
    private getMessageSummary(message: vscode.LanguageModelChatMessage): string {
        const summary: string[] = [];

        // 映射角色到字符串
        let role: string;
        switch (message.role) {
            case vscode.LanguageModelChatMessageRole.User:
                role = 'user';
                break;
            case vscode.LanguageModelChatMessageRole.Assistant:
                role = 'assistant';
                break;
            default:
                role = 'system';
                break;
        }

        Logger.trace(`[PromptCache] getMessageSummary: 处理 ${role} 消息，content 长度=${message.content.length}`);

        // 每条消息的每个部分生成独立的摘要行
        for (const part of message.content) {
            if (part instanceof vscode.LanguageModelToolCallPart) {
                summary.push(`${role}:tool_call:${part.callId}:${part.name}`);
                Logger.trace(`[PromptCache] getMessageSummary: 找到工具调用 ${part.callId}:${part.name}`);
            } else if (part instanceof vscode.LanguageModelToolResultPart) {
                const resultLength = part.content?.length || 0;
                summary.push(`${role}:tool_result:${part.callId}:${resultLength}`);
                Logger.trace(`[PromptCache] getMessageSummary: 找到工具结果 ${part.callId}, 长度=${resultLength}`);
            } else if (part instanceof vscode.LanguageModelTextPart) {
                // 提取实际文本内容（可能是字符串或数组）
                let textValue = '';
                if (Array.isArray(part.value)) {
                    // 如果是数组，拼接所有元素
                    textValue = part.value.map(v => (typeof v === 'string' ? v : JSON.stringify(v))).join('');
                } else if (part.value) {
                    textValue = part.value;
                }
                const truncatedText = textValue.length > 200 ? textValue.substring(0, 200) : textValue;
                summary.push(`${role}:text:${truncatedText}`);
                Logger.trace(`[PromptCache] getMessageSummary: 找到文本内容, 长度=${textValue.length}`);
            } else if (part instanceof vscode.LanguageModelThinkingPart) {
                // 提取实际思维链内容（可能是字符串或数组）
                let thinkingValue = '';
                if (Array.isArray(part.value)) {
                    // 如果是数组，拼接所有元素
                    thinkingValue = part.value.map(v => (typeof v === 'string' ? v : JSON.stringify(v))).join('');
                } else if (part.value) {
                    thinkingValue = part.value;
                }
                const truncatedThinking = thinkingValue.length > 200 ? thinkingValue.substring(0, 200) : thinkingValue;
                summary.push(`${role}:thinking:${truncatedThinking}`);
                Logger.trace(`[PromptCache] getMessageSummary: 找到思维链内容, 长度=${thinkingValue.length}`);
            }
            // 忽略 images 等其他非关键内容
        }

        Logger.trace(`[PromptCache] getMessageSummary: 生成摘要=${summary.join('\n')}`);

        // 如果没有任何关键消息，返回空字符串
        return summary.join('\n');
    }

    /**
     * 从 ResponseOutputItem 数组中提取摘要
     * @param output ResponseOutputItem 数组
     * @param lastN 只考虑最后N条消息
     * @returns 消息摘要字符串
     */
    private getResponseSummary(output: readonly OpenAI.Responses.ResponseOutputItem[], lastN: number = 3): string {
        const outputToSum = output.slice(-lastN);
        const summary: string[] = [];

        Logger.trace(`[PromptCache] getResponseSummary: 处理 ${outputToSum.length} 条输出项`);

        // 每条输出项生成独立的摘要行
        for (const item of outputToSum) {
            if (item.type === 'function_call' && item.id && item.name) {
                // 工具调用
                const callId = item.call_id || item.id;
                summary.push(`assistant:tool_call:${callId}:${item.name}`);
                Logger.trace(`[PromptCache] getResponseSummary: 找到工具调用 ${callId}:${item.name}`);
            } else if (item.type === 'message') {
                // 文本消息 - 提取实际内容
                const messageItem = item as OpenAI.Responses.ResponseOutputMessage;
                let textContent = '';
                // 尝试从 content 数组中提取文本
                if (Array.isArray(messageItem.content)) {
                    for (const contentItem of messageItem.content) {
                        if (contentItem.type === 'output_text') {
                            textContent += contentItem.text || '';
                        }
                    }
                } else if (typeof messageItem.content === 'string') {
                    textContent = messageItem.content;
                }

                const truncatedText = textContent.length > 200 ? textContent.substring(0, 200) : textContent;
                summary.push(`assistant:text:${truncatedText}`);
                Logger.trace(`[PromptCache] getResponseSummary: 找到文本消息, 长度=${textContent.length}`);
            } else if (item.type === 'reasoning') {
                // 推理/思维链 - 提取实际内容
                const reasoningItem = item as OpenAI.Responses.ResponseReasoningItem;
                let reasoningContent = '';
                if (Array.isArray(reasoningItem.content)) {
                    // 如果是数组，拼接所有元素
                    reasoningContent = reasoningItem.content
                        .map(v => (typeof v === 'string' ? v : JSON.stringify(v)))
                        .join('');
                } else if (reasoningItem.content) {
                    reasoningContent = reasoningItem.content;
                }

                const truncatedReasoning =
                    reasoningContent.length > 200 ? reasoningContent.substring(0, 200) : reasoningContent;
                summary.push(`assistant:thinking:${truncatedReasoning}`);
                Logger.trace(`[PromptCache] getResponseSummary: 找到推理内容, 长度=${reasoningContent.length}`);
            }
        }

        Logger.trace(`[PromptCache] getResponseSummary: 生成摘要=${summary.join('\n')}`);

        return summary.join('\n');
    }

    /**
     * 保存缓存条目（统一方法）
     * @param responseId 必需：所有模型的 response.id（唯一，不会重复）
     * @param output ResponseOutputItem 数组
     * @param promptCacheKey 可选：只有 GPT/Codex 有 prompt_cache_key
     */
    public saveCache(
        responseId: string,
        output: readonly OpenAI.Responses.ResponseOutputItem[],
        promptCacheKey?: string
    ): void {
        if (!responseId) {
            Logger.warn('[PromptCache] saveCache: 缺少 responseId，跳过保存');
            return;
        }

        const now = Date.now();
        const summary = this.getResponseSummary(output);

        // 直接创建新条目（responseId 不会重复）
        const entry: UnifiedCacheEntry = {
            responseId,
            promptCacheKey,
            // output,
            summary,
            timestamp: now
        };
        this.cache.set(responseId, entry);
        Logger.debug(`💾 [PromptCache] 保存新缓存 ${responseId}, promptCacheKey=${promptCacheKey}, summary=${summary}`);

        // 清理过期缓存
        this.cleanup();
    }

    /**
     * 计算两个字符串的相似度（基于 Levenshtein 距离）
     * @param str1 第一个字符串
     * @param str2 第二个字符串
     * @returns 相似度百分比（0-100）
     */
    private calculateSimilarity(str1: string, str2: string): number {
        const len1 = str1.length;
        const len2 = str2.length;

        // 如果其中一个字符串为空，相似度为0
        if (len1 === 0 || len2 === 0) {
            return 0;
        }

        // 动态规划计算 Levenshtein 距离
        const matrix: number[][] = [];
        for (let i = 0; i <= len1; i++) {
            matrix[i] = [i];
        }
        for (let j = 0; j <= len2; j++) {
            matrix[0][j] = j;
        }

        for (let i = 1; i <= len1; i++) {
            for (let j = 1; j <= len2; j++) {
                const cost = str1[i - 1] === str2[j - 1] ? 0 : 1;
                matrix[i][j] = Math.min(
                    matrix[i - 1][j] + 1, // 删除
                    matrix[i][j - 1] + 1, // 插入
                    matrix[i - 1][j - 1] + cost // 替换
                );
            }
        }

        const distance = matrix[len1][len2];
        const maxLen = Math.max(len1, len2);
        const similarity = ((maxLen - distance) / maxLen) * 100;

        return similarity;
    }

    /**
     * 检查两行摘要是否匹配
     * 对于 tool_call 和 tool_result，使用精确匹配
     * 对于 text 和 thinking，使用相似度匹配（>90%）
     * @param line1 第一行摘要
     * @param line2 第二行摘要
     * @returns 是否匹配
     */
    private isLineMatch(line1: string, line2: string): boolean {
        // 解析行格式：
        // - tool_call: role:tool_call:callId:name
        // - tool_result: role:tool_result:callId:length
        // - text: role:text:content
        // - thinking: role:thinking:content
        const parts1 = line1.split(':');
        const parts2 = line2.split(':');

        // 至少需要 role:type 两部分
        if (parts1.length < 2 || parts2.length < 2) {
            return false;
        }

        // 角色和类型必须完全匹配
        if (parts1[0] !== parts2[0] || parts1[1] !== parts2[1]) {
            return false;
        }

        const type = parts1[1];

        // tool_call 和 tool_result 使用精确匹配
        if (type === 'tool_call' || type === 'tool_result') {
            return line1 === line2;
        }

        // text 和 thinking 使用相似度匹配
        if (type === 'text' || type === 'thinking') {
            // 提取内容部分（从第三个冒号开始）
            const content1 = parts1.slice(2).join(':');
            const content2 = parts2.slice(2).join(':');

            // 如果两个内容都为空，认为匹配
            if (!content1 && !content2) {
                return true;
            }

            // 如果其中一个为空，不匹配
            if (!content1 || !content2) {
                return false;
            }

            const similarity = this.calculateSimilarity(content1, content2);
            return similarity > 90;
        }

        return false;
    }

    /**
     * 查找匹配的缓存（统一方法）
     * 通过比较最后几条消息来确认会话属于哪个缓存
     * @param messages 消息数组
     * @param lastN 只考虑最后N条消息
     * @returns 匹配的 { responseId, promptCacheKey?, lastMatchIndex }，如果没有匹配则返回 undefined
     */
    public findCache(
        messages: readonly vscode.LanguageModelChatMessage[],
        lastN: number = 3
    ): { responseId: string; promptCacheKey?: string; lastMatchIndex: number } | undefined {
        const now = Date.now();

        // 缓存已计算的消息摘要，避免重复计算
        const messageSummaryCache = new Map<number, string>();

        // 反序遍历所有缓存（最新的缓存优先）
        const cacheEntries = Array.from(this.cache.entries()).reverse();

        for (const [cacheKey, entry] of cacheEntries) {
            // 检查是否过期
            if (now - entry.timestamp > this.cacheTimeout) {
                this.cache.delete(cacheKey);
                continue;
            }

            // 使用保存的摘要进行比较
            const cachedSummary = entry.summary;
            if (!cachedSummary || cachedSummary.trim() === '') {
                continue;
            }

            const cachedLines = cachedSummary.split('\n').filter(line => line.trim() !== '');
            if (cachedLines.length === 0) {
                continue;
            }

            // 从后向前遍历当前消息，只检查 assistant 消息
            let assistantCount = 0;
            for (let i = messages.length - 1; i >= 0; i--) {
                const message = messages[i];
                if (message.role !== vscode.LanguageModelChatMessageRole.Assistant) {
                    continue;
                }

                assistantCount++;
                // 只检查最后 lastN 个 assistant 消息
                if (assistantCount > lastN) {
                    break;
                }

                // 从缓存中获取或计算当前 assistant 消息的摘要
                let currentSummary = messageSummaryCache.get(i);
                if (!currentSummary) {
                    currentSummary = this.getMessageSummary(message);
                    messageSummaryCache.set(i, currentSummary);
                }

                if (!currentSummary || currentSummary.trim() === '') {
                    continue;
                }

                const currentLines = currentSummary.split('\n').filter(line => line.trim() !== '');
                if (currentLines.length === 0) {
                    continue;
                }

                // 计算匹配的行数
                let matchCount = 0;
                for (const currentLine of currentLines) {
                    for (const cachedLine of cachedLines) {
                        if (this.isLineMatch(currentLine, cachedLine)) {
                            matchCount++;
                            break;
                        }
                    }
                }

                // 如果至少有一行匹配，返回当前 assistant 消息的位置
                if (matchCount > 0) {
                    entry.timestamp = now;
                    Logger.debug(
                        `✅ [PromptCache] 缓存命中 ${cacheKey}, responseId=${entry.responseId}, promptCacheKey=${entry.promptCacheKey}, lastMatchIndex=${i}, assistantCount=${assistantCount}, matchCount=${matchCount}`
                    );
                    return {
                        responseId: entry.responseId,
                        promptCacheKey: entry.promptCacheKey,
                        lastMatchIndex: i
                    };
                }
            }
        }

        Logger.trace('[PromptCache] 未找到匹配缓存');
        return undefined;
    }

    /**
     * 清理过期和过多的缓存条目
     */
    private cleanup(): void {
        const now = Date.now();
        const expiredKeys: string[] = [];

        // 找出过期的条目
        for (const [key, entry] of this.cache.entries()) {
            if (now - entry.timestamp > this.cacheTimeout) {
                expiredKeys.push(key);
            }
        }

        // 删除过期条目
        for (const key of expiredKeys) {
            this.cache.delete(key);
            Logger.trace(`[PromptCache] 删除过期缓存 ${key}`);
        }

        // 如果缓存仍然过大，删除最旧的条目
        if (this.cache.size > this.maxCacheSize) {
            const entries = Array.from(this.cache.entries());
            // 按时间戳排序，删除最旧的
            entries.sort((a, b) => a[1].timestamp - b[1].timestamp);
            const toDelete = entries.slice(0, this.cache.size - this.maxCacheSize);
            for (const [key] of toDelete) {
                this.cache.delete(key);
                Logger.trace(`[PromptCache] 删除旧缓存 ${key}`);
            }
        }
    }
}
