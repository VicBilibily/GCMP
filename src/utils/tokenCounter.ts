/*---------------------------------------------------------------------------------------------
 *  Token Counter
 *  处理所有 token 计数相关的逻辑
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import {
    LanguageModelChatInformation,
    LanguageModelChatMessage,
    LanguageModelChatMessageRole,
    LanguageModelChatTool,
    LanguageModelThinkingPart,
    ProvideLanguageModelChatResponseOptions
} from 'vscode';
import { createTokenizer, getRegexByEncoder, getSpecialTokensByEncoder, TikTokenizer } from '@microsoft/tiktokenizer';
import { Logger } from './logger';

/**
 * 全局共享的 tokenizer 实例和扩展路径
 */
let sharedTokenizerPromise: TikTokenizer | null = null;
let extensionPath: string | null = null;
let sharedTokenCounterInstance: TokenCounter | null = null;

/**
 * 简单的 LRU 缓存实现
 */
class LRUCache<T> {
    private cache = new Map<string, T>();
    constructor(private maxSize: number) {}

    get(key: string): T | undefined {
        const value = this.cache.get(key);
        if (value !== undefined) {
            // 将访问过的项移到最后（最近使用）
            this.cache.delete(key);
            this.cache.set(key, value);
        }
        return value;
    }

    put(key: string, value: T): void {
        if (this.cache.has(key)) {
            this.cache.delete(key);
        } else if (this.cache.size >= this.maxSize) {
            // 删除最老的项（第一个）
            const firstKey = this.cache.keys().next().value;
            if (firstKey) {
                this.cache.delete(firstKey);
            }
        }
        this.cache.set(key, value);
    }
}

/**
 * Token 计数器类
 * 负责计算消息、系统消息和工具定义的 token 数量
 * 同时管理全局共享的 tokenizer 实例
 */
export class TokenCounter {
    /**
     * 文本 token 数的缓存（LRU，容量 5000）
     */
    private tokenCache = new LRUCache<number>(5000);

    /**
     * 设置扩展路径
     * 必须在创建 TokenCounter 实例之前调用
     */
    static setExtensionPath(path: string): void {
        extensionPath = path;
        Logger.trace('✓ [TokenCounter] 扩展路径已设置');
    }

    /**
     * 获取全局共享的 TokenCounter 实例（单例）
     */
    static getInstance(): TokenCounter {
        if (!sharedTokenCounterInstance) {
            sharedTokenCounterInstance = new TokenCounter();
            Logger.trace('✓ [TokenCounter] 全局实例已创建');
        }
        return sharedTokenCounterInstance;
    }

    /**
     * 获取共享的 tokenizer 实例（懒加载，全局单例）
     */
    static getSharedTokenizer(): TikTokenizer {
        if (!sharedTokenizerPromise) {
            Logger.trace('🔧 [TokenCounter] 首次请求 tokenizer，正在初始化全局共享实例...');
            if (!extensionPath) {
                throw new Error('[TokenCounter] 扩展路径未初始化，请先调用 TokenCounter.setExtensionPath()');
            }
            const basePath = vscode.Uri.file(extensionPath!);
            const tokenizerPath = vscode.Uri.joinPath(basePath, 'dist', 'o200k_base.tiktoken').fsPath;
            sharedTokenizerPromise = createTokenizer(
                tokenizerPath,
                getSpecialTokensByEncoder('o200k_base'),
                getRegexByEncoder('o200k_base')
            );
            Logger.trace('✓ [TokenCounter] tokenizer 初始化完成');
        }
        return sharedTokenizerPromise;
    }

    constructor(private tokenizer?: TikTokenizer) {
        // 如果没有传入 tokenizer，则使用共享实例
        if (!this.tokenizer) {
            this.tokenizer = TokenCounter.getSharedTokenizer();
        }
    }

    /**
     * 计算文本的 token 数（带缓存）
     */
    private getTextTokenLength(text: string): number {
        if (!text) {
            return 0;
        }

        // 先查缓存
        const cacheValue = this.tokenCache.get(text);
        if (cacheValue !== undefined) {
            // Logger.trace(`[缓存命中] "${text.substring(0, 20)}..." -> ${cacheValue} tokens`);
            return cacheValue;
        }

        // 缓存未命中，计算 token 数
        const tokenCount = this.tokenizer!.encode(text).length;

        // 存入缓存
        this.tokenCache.put(text, tokenCount);
        // Logger.trace(`[缓存写入] "${text.substring(0, 20)}..." -> ${tokenCount} tokens`);

        return tokenCount;
    }

    /**
     * 从消息 part 中提取文本内容
     */
    private extractPartText(part: unknown): string | null {
        if (!part || typeof part !== 'object') {
            return null;
        }

        const partObj = part as Record<string, unknown>;

        // 处理 LanguageModelTextPart
        if ('value' in partObj && typeof partObj.value === 'string') {
            return partObj.value;
        }

        // 处理其他类型的 part，转换为 JSON 字符串
        if ('name' in partObj || 'input' in partObj || 'callId' in partObj) {
            return JSON.stringify(partObj);
        }

        return null;
    }

    /**
     * 计算单个文本或消息对象的 token 数
     */
    async countTokens(_model: LanguageModelChatInformation, text: string | LanguageModelChatMessage): Promise<number> {
        if (typeof text === 'string') {
            const stringTokens = this.tokenizer!.encode(text).length;
            Logger.trace(`[Token计数] 字符串: ${stringTokens} tokens (长度: ${text.length})`);
            return stringTokens;
        }

        // 处理 LanguageModelChatMessage 对象
        try {
            const objectTokens = await this.countMessageObjectTokens(text as unknown as Record<string, unknown>);
            Logger.trace(`[Token计数] 对象消息: ${objectTokens} tokens`);
            return objectTokens;
        } catch (error) {
            Logger.warn('[Token计数] 计算消息对象 token 失败，使用简化计算:', error);
            // 降级处理：将消息对象转为 JSON 字符串计算
            const fallbackTokens = this.tokenizer!.encode(JSON.stringify(text)).length;
            Logger.trace(`[Token计数] 降级计算: ${fallbackTokens} tokens`);
            return fallbackTokens;
        }
    }

    /**
     * 递归计算消息对象中的 token 数量
     * 支持文本、图片、工具调用、思考内容等复杂内容
     */
    async countMessageObjectTokens(obj: Record<string, unknown>, depth: number = 0): Promise<number> {
        let numTokens = 0;
        // const indent = '  '.repeat(depth);

        // 每个对象/消息都需要一些额外的 token 用于分隔和格式化
        if (depth === 0) {
            // 消息分隔符和基础格式化开销（3个token比1个更准确）
            const overheadTokens = 3;
            numTokens += overheadTokens;
            // Logger.trace(`${indent}[开销] 消息分隔符: ${overheadTokens} tokens`);
        }

        // eslint-disable-next-line @typescript-eslint/no-unused-vars
        for (const [key, value] of Object.entries(obj)) {
            if (!value) {
                continue;
            }

            if (typeof value === 'string') {
                // 字符串内容直接计算 token（使用缓存）
                const tokens = this.getTextTokenLength(value);
                numTokens += tokens;
                // Logger.trace(`${indent}[${key}] 字符串: ${tokens} tokens`);
            } else if (typeof value === 'number' || typeof value === 'boolean') {
                // 数字和布尔值也计算 token（使用缓存）
                const tokens = this.getTextTokenLength(String(value));
                numTokens += tokens;
                // Logger.trace(`${indent}[${key}] ${typeof value}: ${tokens} tokens`);
            } else if (Array.isArray(value)) {
                // 数组处理
                // Logger.trace(`${indent}[${key}] 数组 (${value.length} 项)`);
                for (const item of value) {
                    if (typeof item === 'string') {
                        const tokens = this.getTextTokenLength(item);
                        numTokens += tokens;
                        // Logger.trace(`${indent}  [value] 字符串: ${tokens} tokens`);
                    } else if (typeof item === 'number' || typeof item === 'boolean') {
                        const tokens = this.getTextTokenLength(String(item));
                        numTokens += tokens;
                        // Logger.trace(`${indent}  [${typeof item}] ${typeof item}: ${tokens} tokens`);
                    } else if (item && typeof item === 'object') {
                        // 嵌套对象数组
                        const itemTokens = await this.countMessageObjectTokens(
                            item as Record<string, unknown>,
                            depth + 2
                        );
                        numTokens += itemTokens;
                    }
                }
            } else if (typeof value === 'object') {
                // Logger.trace(`${indent}[${key}] 对象类型`);
                const nestedTokens = await this.countMessageObjectTokens(value as Record<string, unknown>, depth + 1);
                numTokens += nestedTokens;
            }
        }

        return numTokens;
    }

    /**
     * 计算多条消息的总 token 数
     * 包括常规消息、系统消息、工具定义和思考内容（基于配置）
     */
    async countMessagesTokens(
        model: LanguageModelChatInformation,
        messages: Array<LanguageModelChatMessage>,
        modelConfig?: { sdkMode?: string; includeThinking?: boolean },
        options?: ProvideLanguageModelChatResponseOptions
    ): Promise<number> {
        let totalTokens = 0;
        // Logger.trace(`[Token计数] 开始计算 ${messages.length} 条消息的 token...`);

        // 检查是否需要包含思考内容
        const includeThinking = modelConfig?.includeThinking === true;

        // 计算消息 token
        // eslint-disable-next-line @typescript-eslint/prefer-for-of
        for (let i = 0; i < messages.length; i++) {
            const message = messages[i];

            // 如果不包含思考内容，需要过滤掉 LanguageModelThinkingPart
            if (!includeThinking && message.content) {
                // 检查是否有思考内容需要过滤
                const hasThinking = message.content.some(part => part instanceof LanguageModelThinkingPart);

                if (hasThinking) {
                    // 只计算非思考内容部分
                    let messageTokens = 0;

                    // 基础消息开销
                    messageTokens += 3;

                    // 遍历每个 part，只统计非思考内容
                    for (const part of message.content) {
                        if (!(part instanceof LanguageModelThinkingPart)) {
                            // 提取文本内容并直接计算
                            const textContent = this.extractPartText(part);
                            if (textContent) {
                                messageTokens += await this.countTokens(model, textContent);
                            }
                        }
                    }

                    totalTokens += messageTokens;
                    // Logger.trace(`[Token计数] 消息 #${i + 1}: ${messageTokens} tokens (已过滤思考内容, 累计: ${totalTokens})`);
                    continue;
                }
            }

            // 包含思考内容或没有思考内容，正常计算整个消息
            const messageTokens = await this.countTokens(
                model,
                message as unknown as string | LanguageModelChatMessage
            );
            totalTokens += messageTokens;
            // Logger.trace(`[Token计数] 消息 #${i + 1}: ${messageTokens} tokens (累计: ${totalTokens})`);
        }

        const sdkMode = modelConfig?.sdkMode || 'openai';

        if (sdkMode === 'anthropic') {
            // 为 Anthropic SDK 模式添加系统消息和工具的 token 成本
            // 计算系统消息的 token 成本
            const systemMessageTokens = this.countSystemMessageTokens(messages);
            if (systemMessageTokens > 0) {
                totalTokens += systemMessageTokens;
                // Logger.trace(`[Token计数] 系统消息: ${systemMessageTokens} tokens (累计: ${totalTokens})`);
            }
        }

        // 工具成本（都使用 1.1 倍）
        const toolsTokens = this.countToolsTokens(options?.tools);
        if (toolsTokens > 0) {
            totalTokens += toolsTokens;
            // Logger.trace(
            //     `[Token计数] 工具定义 (${options?.tools?.length || 0} 个): ${toolsTokens} tokens (累计: ${totalTokens})`
            // );
        }

        // Logger.info(
        //     `[Token计数] 总计: ${messages.length} 条消息${sdkMode === 'anthropic' ? ' + 系统消息 + 工具定义' : ' (OpenAI SDK)'}, ${totalTokens} tokens`
        // );
        return totalTokens;
    }

    /**
     * 计算系统消息的 token 数
     * 从消息列表中提取所有系统消息并合并计算
     */
    private countSystemMessageTokens(messages: Array<LanguageModelChatMessage>): number {
        let systemText = '';

        for (const message of messages) {
            if (message.role === LanguageModelChatMessageRole.System) {
                if (typeof message.content === 'string') {
                    systemText += message.content;
                }
            }
        }

        if (!systemText) {
            return 0;
        }

        // 计算系统消息的 token 数 - 使用缓存机制
        const systemTokens = this.getTextTokenLength(systemText);

        // Anthropic 的系统消息处理会添加一些额外的格式化 token
        // 经实际测试，系统消息包装开销约为 25-30 tokens
        const systemOverhead = 28;
        const totalSystemTokens = systemTokens + systemOverhead;

        Logger.debug(
            `[Token计数] 系统消息详情: 内容 ${systemTokens} tokens + 包装开销 ${systemOverhead} tokens = ${totalSystemTokens} tokens`
        );
        return totalSystemTokens;
    }

    /**
     * 计算工具定义的 token 数
     * 遵循官方 VS Code Copilot 实现：
     * - 基础开销：16 tokens（工具数组开销）
     * - 每个工具：8 tokens + 对象内容 token 数
     * - 最后乘以 1.1 的安全系数（官方标准）
     */
    private countToolsTokens(tools?: readonly LanguageModelChatTool[]): number {
        const baseToolTokens = 16;
        let numTokens = 0;
        if (!tools || tools.length === 0) {
            return 0;
        }

        numTokens += baseToolTokens;

        const baseTokensPerTool = 8;
        for (const tool of tools) {
            numTokens += baseTokensPerTool;
            // 计算工具对象的 token 数（name、description、parameters）
            const toolObj = {
                name: tool.name,
                description: tool.description || '',
                input_schema: tool.inputSchema
            };
            // 简单的启发式方法：遍历对象并计算 token（使用缓存）
            for (const [, value] of Object.entries(toolObj)) {
                if (typeof value === 'string') {
                    numTokens += this.getTextTokenLength(value);
                } else if (value && typeof value === 'object') {
                    // 对于 JSON 对象，使用 JSON 字符串编码（使用缓存）
                    numTokens += this.getTextTokenLength(JSON.stringify(value));
                }
            }
        }

        // 使用官方标准的 1.1 安全系数
        return Math.floor(numTokens * 1.1);
    }
}
