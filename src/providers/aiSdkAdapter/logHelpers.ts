/*---------------------------------------------------------------------------------------------
 *  日志辅助函数
 *  为 AI SDK Provider 提供统一的日志格式化和消息摘要工具
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import type { LanguageModelChatMessage } from 'vscode';
import type { CoreMessage } from 'ai';
import type { SdkClientType } from '../aiSdkProvider';

const MAX_LOGGED_MESSAGE_SUMMARIES = 20;
const MAX_LOGGED_TOOL_NAMES = 20;

// ---- 通用工具 ----

/** 安全序列化任意值为 JSON 字符串，失败降级为 String() */
export function toJsonLog(value: unknown): string {
    try {
        return JSON.stringify(value);
    } catch {
        return String(value);
    }
}

export function createRequestLogPrefix(requestId: string): string {
    return `[AiSdkProvider][${requestId}]`;
}

export function normalizeThinkingValue(value: string | string[]): string {
    return Array.isArray(value) ? value.join('') : value;
}

/** 将任意配置对象转为 Record 以安全遍历 key */
export function toRecord(value: unknown): Record<string, unknown> {
    return value !== null && typeof value === 'object' ? (value as Record<string, unknown>) : {};
}

// ---- SDK 映射 ----

export function mapSdkTypeToStatefulSdkMode(sdkType: SdkClientType): 'openai' | 'anthropic' | 'gemini' | 'openai-responses' {
    switch (sdkType) {
        case 'anthropic':
            return 'anthropic';
        case 'google':
            return 'gemini';
        default:
            return 'openai';
    }
}

// ---- VS Code 消息摘要 ----

function getVsCodeRoleName(role: number): 'user' | 'assistant' | 'system' | 'unknown' {
    switch (role) {
        case 1:
            return 'user';
        case 2:
            return 'assistant';
        case 3:
            return 'system';
        default:
            return 'unknown';
    }
}

interface VsCodeContentSummary {
    textChars: number;
    thinkingChars: number;
    toolCallParts: number;
    toolResultParts: number;
    dataParts: number;
    statefulMarkerParts: number;
    otherParts: number;
    fileParts: number;
}

function summarizeVsCodeContent(content: unknown): VsCodeContentSummary {
    const summary: VsCodeContentSummary = {
        textChars: 0,
        thinkingChars: 0,
        toolCallParts: 0,
        toolResultParts: 0,
        dataParts: 0,
        statefulMarkerParts: 0,
        otherParts: 0,
        fileParts: 0
    };

    if (!Array.isArray(content)) {
        if (typeof content === 'string') {
            summary.textChars += content.length;
        }
        return summary;
    }

    for (const part of content) {
        switch (part.constructor?.name ?? part.type) {
            case 'LanguageModelTextPart':
            case 'text':
                summary.textChars += (part.text ?? '').length;
                break;
            case 'LanguageModelThinkingPart':
            case 'thinking':
                summary.thinkingChars += (part.text ?? '').length;
                break;
            case 'LanguageModelToolCallPart':
            case 'tool-call':
                summary.toolCallParts += 1;
                break;
            case 'LanguageModelToolResultPart':
            case 'tool-result':
                summary.toolResultParts += 1;
                break;
            case 'LanguageModelDataPart':
                summary.dataParts += 1;
                break;
            case 'file':
                summary.fileParts += 1;
                break;
        }
    }

    return summary;
}

export function summarizeVsCodeMessages(messages: readonly LanguageModelChatMessage[]): Record<string, unknown> {
    const roleCounts = { user: 0, assistant: 0, system: 0, unknown: 0 };
    const totals = {
        textChars: 0, thinkingChars: 0, toolCallParts: 0,
        toolResultParts: 0, dataParts: 0, statefulMarkerParts: 0, otherParts: 0
    };
    const messageSummaries: Array<Record<string, unknown>> = [];

    for (const [index, message] of messages.entries()) {
        const roleName = getVsCodeRoleName(message.role);
        roleCounts[roleName] += 1;

        const summary = summarizeVsCodeContent(message.content);
        totals.textChars += summary.textChars;
        totals.thinkingChars += summary.thinkingChars;
        totals.toolCallParts += summary.toolCallParts;
        totals.toolResultParts += summary.toolResultParts;
        totals.dataParts += summary.dataParts;
        totals.statefulMarkerParts += summary.statefulMarkerParts;
        totals.otherParts += summary.otherParts;

        if (index < MAX_LOGGED_MESSAGE_SUMMARIES) {
            messageSummaries.push({ index, role: roleName, ...summary });
        }
    }

    return {
        totalMessages: messages.length,
        roleCounts,
        totals,
        truncatedMessages: Math.max(0, messages.length - MAX_LOGGED_MESSAGE_SUMMARIES),
        messageSummaries
    };
}

export function summarizeToolDefinitions(tools: readonly vscode.LanguageModelChatTool[] | undefined): Record<string, unknown> {
    if (!tools || tools.length === 0) {
        return { totalTools: 0, names: [] };
    }

    return {
        totalTools: tools.length,
        names: tools.slice(0, MAX_LOGGED_TOOL_NAMES).map(tool => tool.name),
        truncatedTools: Math.max(0, tools.length - MAX_LOGGED_TOOL_NAMES)
    };
}

// ---- AI SDK 消息摘要 ----

export function summarizeCoreMessages(messages: CoreMessage[]): Record<string, unknown> {
    const roleCounts = { system: 0, user: 0, assistant: 0, tool: 0 };
    let textParts = 0;
    let reasoningParts = 0;
    let toolCallParts = 0;
    let toolResultParts = 0;

    for (const message of messages) {
        roleCounts[message.role] += 1;

        if (typeof message.content === 'string') {
            textParts += 1;
        } else if (Array.isArray(message.content)) {
            for (const part of message.content) {
                switch (part.type) {
                    case 'text':
                        textParts += 1;
                        break;
                    case 'reasoning':
                        reasoningParts += 1;
                        break;
                    case 'tool-call':
                        toolCallParts += 1;
                        break;
                    case 'tool-result':
                        toolResultParts += 1;
                        break;
                }
            }
        }
    }

    return {
        totalMessages: messages.length,
        roleCounts,
        textParts,
        reasoningParts,
        toolCallParts,
        toolResultParts
    };
}
