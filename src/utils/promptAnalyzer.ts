/*---------------------------------------------------------------------------------------------
 *  提示词分析器
 *  仅做 token 预估计算（全量 / 增量），不分解细分类别。
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import {
    LanguageModelChatInformation,
    LanguageModelChatMessage,
    ProvideLanguageModelChatResponseOptions
} from 'vscode';
import { ModelConfig } from '../types/sharedTypes';
import { Logger } from './logger';
import { sanitizeToolSchemaForSdkMode } from './schemaSanitizer';
import { TokenCounter } from './tokenCounter';
import { decodeStatefulMarker } from '../handlers/statefulMarker';
import { CustomDataPartMimeTypes } from '../handlers/types';

/** analyzePromptParts 返回值 */
export interface PromptAnalysis {
    context: number;
    requestIncrement?: number;
}

/**
 * 提示词分析器
 * 用于计算当前请求的输入 token 总量，支持全量计算和基于上一轮 API usage 的增量预估。
 */
export class PromptAnalyzer {
    /**
     * 计算输入 token 总量
     */
    static async analyzePromptParts(
        providerKey: string,
        model: LanguageModelChatInformation,
        messages: Array<LanguageModelChatMessage>,
        modelConfig?: Pick<ModelConfig, 'sdkMode'>,
        options?: ProvideLanguageModelChatResponseOptions
    ): Promise<PromptAnalysis> {
        const result: PromptAnalysis = { context: 0 };

        try {
            const tokenCounter = TokenCounter.getInstance();
            Logger.debug(`[${providerKey}] analyzePromptParts started, message count: ${messages.length}`);

            // ===== 1. 计算系统提示词 =====
            let systemTokens = 0;
            for (const message of messages) {
                if (message.role === vscode.LanguageModelChatMessageRole.System) {
                    let text = '';
                    if (typeof message.content === 'string') {
                        text = message.content;
                    } else if (Array.isArray(message.content)) {
                        for (const part of message.content) {
                            text += this.extractPartText(part as unknown);
                        }
                    }
                    if (text) {
                        systemTokens += await tokenCounter.countTokens(model, text);
                    }
                }
            }
            // 官方标准：系统提示词包装开销 28 tokens
            if (systemTokens > 0) {
                systemTokens += 28;
            }

            // ===== 2. 计算可用工具描述 =====
            let toolsTokens = 0;
            if (options?.tools && Array.isArray(options.tools)) {
                toolsTokens = 16; // 基础开销
                for (const tool of options.tools) {
                    toolsTokens += 8; // 每个工具的基础开销
                    if ('name' in tool && typeof tool.name === 'string') {
                        toolsTokens += await tokenCounter.countTokens(model, tool.name);
                    }
                    if ('description' in tool && typeof tool.description === 'string') {
                        toolsTokens += await tokenCounter.countTokens(model, tool.description);
                    }
                    if ('inputSchema' in tool && tool.inputSchema) {
                        const schemaJson = JSON.stringify(
                            sanitizeToolSchemaForSdkMode(tool.inputSchema, modelConfig?.sdkMode)
                        );
                        toolsTokens += await tokenCounter.countTokens(model, schemaJson);
                    }
                }
                toolsTokens = Math.floor(toolsTokens * 1.1); // 官方安全系数
            }

            // ===== 3. 检测 stateful marker 中的 usage（增量基线） =====
            let usageBaseline: number | undefined;
            let usageMarkerIndex = -1;
            let deltaTokens = 0;

            for (let i = messages.length - 1; i >= 0; i--) {
                const message = messages[i];
                if (message.role === vscode.LanguageModelChatMessageRole.Assistant && Array.isArray(message.content)) {
                    for (const part of message.content) {
                        if (
                            typeof part === 'object' &&
                            part !== null &&
                            'mimeType' in part &&
                            (part as { mimeType: string }).mimeType === CustomDataPartMimeTypes.StatefulMarker &&
                            'data' in part
                        ) {
                            try {
                                const decoded = decodeStatefulMarker((part as { data: Uint8Array }).data);
                                const promptTokens = decoded?.marker?.usage?.prompt_tokens;
                                if (typeof promptTokens === 'number' && promptTokens > 0) {
                                    usageBaseline = promptTokens;
                                    usageMarkerIndex = i;
                                    break;
                                }
                            } catch {
                                // 解码失败，忽略
                            }
                        }
                    }
                    if (usageBaseline !== undefined) break;
                }
            }

            if (usageBaseline !== undefined) {
                Logger.debug(
                    `[${providerKey}] Incremental mode: baseline=${usageBaseline} (from usage at message ${usageMarkerIndex})`
                );
            }

            // ===== 5. 遍历消息计算 delta（增量）/ 全量消息 token =====
            let totalMessageTokens = 0;
            const loopStart = usageBaseline !== undefined ? usageMarkerIndex : 0;

            for (let i = loopStart; i < messages.length; i++) {
                const message = messages[i];

                // 跳过系统消息（已单独计算）
                if (message.role === vscode.LanguageModelChatMessageRole.System) {
                    continue;
                }

                // 计算消息 token
                const messageTokens = await tokenCounter.countTokens(
                    model,
                    message as unknown as string | vscode.LanguageModelChatMessage
                );

                // 增量模式：所有遍历的消息都属于 delta
                if (usageBaseline !== undefined) {
                    deltaTokens += messageTokens;
                } else {
                    totalMessageTokens += messageTokens;
                }
            }

            // ===== 6. 计算上下文总占用 =====
            if (usageBaseline !== undefined) {
                // 设计取舍：增量模式直接复用上一轮 API 返回的 prompt_tokens 作为 baseline，
                // 不额外重算并叠加当前轮 system/tools 的变化量。
                // 这样会带来少量估算失真，但可避免为了边缘差异引入更高实现复杂度与额外计量成本。
                result.context = usageBaseline + deltaTokens;
                result.requestIncrement = deltaTokens;
                Logger.debug(
                    `[${providerKey}] Incremental: baseline=${usageBaseline}, delta=${deltaTokens}, context=${result.context}`
                );
            } else {
                result.context = systemTokens + toolsTokens + totalMessageTokens;
                Logger.debug(
                    `[${providerKey}] Full estimate: system=${systemTokens}, tools=${toolsTokens}, messages=${totalMessageTokens}, context=${result.context}`
                );
            }

            return result;
        } catch (error) {
            Logger.warn(`[${providerKey}] Failed to analyze prompt parts:`, error);
            return result;
        }
    }

    /**
     * 提取消息部分的文本内容
     * @param part 消息部分（可能是字符串或对象）
     * @returns 提取的文本，如果无法提取则返回空字符串
     */
    private static extractPartText(part: unknown): string {
        if (typeof part === 'string') {
            return part;
        }
        if (!part || typeof part !== 'object') {
            return '';
        }

        const partObj = part as Record<string, unknown>;
        // 处理标准的 TextPart / ThinkingPart
        // - TextPart: value: string
        // - ThinkingPart: value: string | string[]
        if ('value' in partObj) {
            const v = partObj.value;
            if (typeof v === 'string') {
                return v;
            }
            if (Array.isArray(v) && v.every(x => typeof x === 'string')) {
                return v.join('');
            }
        }
        // 处理 markdown 内容
        if ('markdown' in partObj && typeof partObj.markdown === 'string') {
            return partObj.markdown;
        }
        // 处理 text 字段
        if ('text' in partObj && typeof partObj.text === 'string') {
            return partObj.text;
        }
        // 处理 data 字段（可能是 Buffer 或其他）
        if ('data' in partObj && partObj.data) {
            if (typeof partObj.data === 'string') {
                return partObj.data;
            }
            if (Buffer.isBuffer(partObj.data)) {
                try {
                    return partObj.data.toString('utf-8');
                } catch {
                    return '';
                }
            }
        }
        return '';
    }
}
