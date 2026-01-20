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

/* ---------------------------------------------------------------------------------------------
 *  Token Counter 主类
 *  负责计算消息、系统消息和工具定义的 token 数量
 *------------------------------------------------------------------------------------------- */

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

        // 处理二进制/DataPart（尤其是图片）：避免 JSON.stringify 把 Uint8Array/Buffer 展开成巨大数组导致 token 被夸大
        if ('mimeType' in partObj && typeof partObj.mimeType === 'string' && 'data' in partObj) {
            const byteLength = getBinaryByteLength(partObj.data);
            return JSON.stringify({ mimeType: partObj.mimeType, byteLength });
        }

        // 处理其他类型的 part，转换为 JSON 字符串
        if ('name' in partObj || 'input' in partObj || 'callId' in partObj) {
            return JSON.stringify(partObj);
        }

        return null;
    }

    private estimateNonImageBinaryTokens(byteLength: number): number {
        if (!byteLength) {
            return 0;
        }
        // 对非图片二进制载荷做一个小且有上限的估算
        const base = 20;
        const per16Kb = Math.ceil(byteLength / 16384);
        return Math.min(200, base + per16Kb);
    }

    private estimateImageTokensFromBytes(bytes: Uint8Array, mimeType: string, detail: ImageDetail): number {
        try {
            return estimateImageTokensFromBytes(bytes, mimeType, detail);
        } catch {
            // 最佳降级方案：如果无法解析尺寸，避免计数爆炸
            return this.estimateNonImageBinaryTokens(bytes.byteLength);
        }
    }

    private estimateImagePartTotalTokens(bytes: Uint8Array, mimeType: string, detail: ImageDetail): number {
        // 1) 图片本体成本：对齐 vscode-copilot-chat（tiles*170+85）
        const imageCost = this.estimateImageTokensFromBytes(bytes, mimeType, detail);

        // 2) 包装成本：请求里仍然需要携带结构化的"图片 part"。
        // 这里刻意不包含 base64 载荷，只用最小 JSON 骨架估算包装开销。
        const wrapperSkeleton = `{"type":"image_url","image_url":{"url":"data:${mimeType};base64,"}}`;
        const wrapperTokens = this.getTextTokenLength(wrapperSkeleton);

        return imageCost + wrapperTokens;
    }

    /**
     * 计算单个文本或消息对象的 token 数
     */
    async countTokens(_model: LanguageModelChatInformation, text: string | LanguageModelChatMessage): Promise<number> {
        if (typeof text === 'string') {
            const stringTokens = this.tokenizer!.encode(text).length;
            // Logger.trace(`[Token计数] 字符串: ${stringTokens} tokens (长度: ${text.length})`);
            return stringTokens;
        }

        // 处理 LanguageModelChatMessage 对象
        try {
            const objectTokens = await this.countMessageObjectTokens(text as unknown as Record<string, unknown>);
            // Logger.trace(`[Token计数] 对象消息: ${objectTokens} tokens`);
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
        // DataPart / 二进制 part：不要展开 data 数组逐字节计数
        if (obj && typeof obj.mimeType === 'string' && 'data' in obj) {
            const bytes = getBinaryUint8Array(obj.data);
            if (bytes) {
                const mimeType = String(obj.mimeType);
                if (isImageMimeType(mimeType)) {
                    return this.estimateImagePartTotalTokens(bytes, mimeType, 'auto');
                }
                return this.getTextTokenLength(mimeType) + this.estimateNonImageBinaryTokens(bytes.byteLength);
            }
        }

        let numTokens = 0;
        // const indent = '  '.repeat(depth);

        // 每个对象/消息都需要一些额外的 token 用于分隔和格式化
        if (depth === 0) {
            // 消息分隔符和基础格式化开销（3个token比1个更准确）
            const overheadTokens = 3;
            numTokens += overheadTokens;
            // Logger.trace(`${indent}[开销] 消息分隔符: ${overheadTokens} tokens`);
        }

        for (const [, value] of Object.entries(obj)) {
            if (!value) {
                continue;
            }

            // 大块二进制（Uint8Array / Buffer JSON / number[]）：用估算代替递归遍历，避免 token 夸大与性能问题
            // 注意：DataPart（包括图片）已在方法开头统一处理，这里只处理其他二进制数据
            const binaryByteLength = getBinaryByteLength(value);
            if (binaryByteLength > 0) {
                numTokens += this.estimateNonImageBinaryTokens(binaryByteLength);
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

/* ---------------------------------------------------------------------------------------------
 *  二进制数据工具
 *  用于安全处理 Uint8Array/ArrayBuffer/Buffer 等二进制载荷
 *------------------------------------------------------------------------------------------- */

function isBufferJson(value: unknown): value is { type: 'Buffer'; data: number[] } {
    if (!value || typeof value !== 'object') {
        return false;
    }
    const obj = value as { type?: unknown; data?: unknown };
    return obj.type === 'Buffer' && Array.isArray(obj.data);
}

function getBinaryByteLength(value: unknown): number {
    if (!value) {
        return 0;
    }
    if (value instanceof Uint8Array) {
        return value.byteLength;
    }
    if (value instanceof ArrayBuffer) {
        return value.byteLength;
    }
    if (ArrayBuffer.isView(value)) {
        return value.byteLength;
    }
    if (isBufferJson(value)) {
        return value.data.length;
    }
    if (Array.isArray(value) && value.length > 0 && value.every(v => typeof v === 'number')) {
        return value.length;
    }
    return 0;
}

function getBinaryUint8Array(value: unknown): Uint8Array | undefined {
    if (!value) {
        return undefined;
    }
    if (value instanceof Uint8Array) {
        return value;
    }
    if (value instanceof ArrayBuffer) {
        return new Uint8Array(value);
    }
    if (ArrayBuffer.isView(value)) {
        return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
    }
    if (isBufferJson(value)) {
        return new Uint8Array(value.data);
    }
    if (Array.isArray(value) && value.length > 0 && value.every(v => typeof v === 'number')) {
        return new Uint8Array(value);
    }
    return undefined;
}

/* ---------------------------------------------------------------------------------------------
 *  图片 Token 估算器
 *  对齐 microsoft/vscode-copilot-chat 的实现（OpenAI Vision 图片成本估算）
 *------------------------------------------------------------------------------------------- */

type ImageDetail = 'low' | 'high' | 'auto' | undefined;

function isImageMimeType(mimeType: string): boolean {
    return mimeType.startsWith('image/');
}

function readUInt16LE(bytes: Uint8Array, offset: number): number {
    return bytes[offset] | (bytes[offset + 1] << 8);
}

function readUInt16BE(bytes: Uint8Array, offset: number): number {
    return (bytes[offset] << 8) | bytes[offset + 1];
}

function readUInt32LE(bytes: Uint8Array, offset: number): number {
    return (bytes[offset] | (bytes[offset + 1] << 8) | (bytes[offset + 2] << 16) | (bytes[offset + 3] << 24)) >>> 0;
}

function readUInt32BE(bytes: Uint8Array, offset: number): number {
    return ((bytes[offset] << 24) | (bytes[offset + 1] << 16) | (bytes[offset + 2] << 8) | bytes[offset + 3]) >>> 0;
}

function getImageDimensionsFromBytes(bytes: Uint8Array, mimeType: string): { width: number; height: number } {
    const mt = mimeType.toLowerCase();

    if (mt === 'image/png') {
        if (bytes.length < 24) {
            throw new Error('PNG too small');
        }
        const width = readUInt32BE(bytes, 16);
        const height = readUInt32BE(bytes, 20);
        return { width, height };
    }

    if (mt === 'image/gif') {
        if (bytes.length < 10) {
            throw new Error('GIF too small');
        }
        const width = readUInt16LE(bytes, 6);
        const height = readUInt16LE(bytes, 8);
        return { width, height };
    }

    if (mt === 'image/jpeg' || mt === 'image/jpg') {
        if (bytes.length < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8) {
            throw new Error('Invalid JPEG');
        }

        let offset = 2;
        while (offset + 4 < bytes.length) {
            if (bytes[offset] !== 0xff) {
                offset++;
                continue;
            }

            const marker = readUInt16BE(bytes, offset);
            if (marker === 0xffd8 || marker === 0xffd9) {
                offset += 2;
                continue;
            }

            if (offset + 4 >= bytes.length) {
                break;
            }

            const segmentLength = readUInt16BE(bytes, offset + 2);

            if (marker >= 0xffc0 && marker <= 0xffc2) {
                if (offset + 9 >= bytes.length) {
                    break;
                }
                const height = readUInt16BE(bytes, offset + 5);
                const width = readUInt16BE(bytes, offset + 7);
                return { width, height };
            }

            offset += 2 + segmentLength;
        }

        throw new Error('JPEG dimensions not found');
    }

    if (mt === 'image/webp') {
        if (bytes.length < 16) {
            throw new Error('WEBP too small');
        }
        const riff = String.fromCharCode(bytes[0], bytes[1], bytes[2], bytes[3]);
        const webp = String.fromCharCode(bytes[8], bytes[9], bytes[10], bytes[11]);
        if (riff !== 'RIFF' || webp !== 'WEBP') {
            throw new Error('Invalid WEBP');
        }

        let offset = 12;
        while (offset + 8 <= bytes.length) {
            const fourcc = String.fromCharCode(bytes[offset], bytes[offset + 1], bytes[offset + 2], bytes[offset + 3]);
            const size = readUInt32LE(bytes, offset + 4);
            const dataStart = offset + 8;
            if (dataStart + size > bytes.length) {
                break;
            }

            if (fourcc === 'VP8X') {
                if (size < 10) {
                    throw new Error('Invalid VP8X');
                }
                const width = 1 + (bytes[dataStart + 4] | (bytes[dataStart + 5] << 8) | (bytes[dataStart + 6] << 16));
                const height = 1 + (bytes[dataStart + 7] | (bytes[dataStart + 8] << 8) | (bytes[dataStart + 9] << 16));
                return { width, height };
            }

            if (fourcc === 'VP8 ') {
                if (size >= 10) {
                    const width = (readUInt16LE(bytes, dataStart + 6) & 0x3fff) >>> 0;
                    const height = (readUInt16LE(bytes, dataStart + 8) & 0x3fff) >>> 0;
                    if (width > 0 && height > 0) {
                        return { width, height };
                    }
                }
            }

            if (fourcc === 'VP8L') {
                if (size >= 5 && bytes[dataStart] === 0x2f) {
                    const b0 = bytes[dataStart + 1];
                    const b1 = bytes[dataStart + 2];
                    const b2 = bytes[dataStart + 3];
                    const b3 = bytes[dataStart + 4];
                    const bits = (b0 | (b1 << 8) | (b2 << 16) | (b3 << 24)) >>> 0;
                    const width = (bits & 0x3fff) + 1;
                    const height = ((bits >> 14) & 0x3fff) + 1;
                    return { width, height };
                }
            }

            offset = dataStart + size + (size % 2);
        }

        throw new Error('WEBP dimensions not found');
    }

    if (mt === 'image/bmp') {
        if (bytes.length < 26) {
            throw new Error('BMP too small');
        }
        const width = readUInt32LE(bytes, 18) | 0;
        const rawHeight = readUInt32LE(bytes, 22) | 0;
        const height = Math.abs(rawHeight);
        if (width <= 0 || height <= 0) {
            throw new Error('Invalid BMP');
        }
        return { width, height };
    }

    throw new Error(`Unsupported image format: ${mimeType}`);
}

// 对齐 microsoft/vscode-copilot-chat 的实现
// https://platform.openai.com/docs/guides/vision#calculating-costs
//
// 计算示例：
// 1. 低 detail 模式：固定 85 tokens
//    calculateOpenAIVisionImageTokenCost(1920, 1080, 'low') = 85
//
// 2. 小图片（512x512，无需缩放）：
//    - tiles = ceil(512/512) * ceil(512/512) = 1 * 1 = 1
//    - tokens = 1 * 170 + 85 = 255
//    calculateOpenAIVisionImageTokenCost(512, 512, 'auto') = 255
//
// 3. 中等图片（1024x768）：
//    - 最短边缩放到 768：scaleFactor = 768/768 = 1，无需缩放
//    - tiles = ceil(1024/512) * ceil(768/512) = 2 * 2 = 4
//    - tokens = 4 * 170 + 85 = 765
//    calculateOpenAIVisionImageTokenCost(1024, 768, 'auto') = 765
//
// 4. 大图片（3000x2000，需要先缩放到 2048x2048 内）：
//    - 第一步：scaleFactor = 2048/3000 ≈ 0.683
//      缩放后：2048 x 1365
//    - 第二步：scaleFactor = 768/1365 ≈ 0.563
//      缩放后：1153 x 768
//    - tiles = ceil(1153/512) * ceil(768/512) = 3 * 2 = 6
//    - tokens = 6 * 170 + 85 = 1105
//    calculateOpenAIVisionImageTokenCost(3000, 2000, 'auto') = 1105
//
// 5. 超大图片（4000x3000）：
//    - 第一步：scaleFactor = 2048/4000 = 0.512
//      缩放后：2048 x 1536
//    - 第二步：scaleFactor = 768/1536 = 0.5
//      缩放后：1024 x 768
//    - tiles = ceil(1024/512) * ceil(768/512) = 2 * 2 = 4
//    - tokens = 4 * 170 + 85 = 765
//    calculateOpenAIVisionImageTokenCost(4000, 3000, 'auto') = 765
//
function calculateOpenAIVisionImageTokenCost(width: number, height: number, detail: ImageDetail): number {
    if (detail === 'low') {
        return 85;
    }

    if (width > 2048 || height > 2048) {
        const scaleFactor = 2048 / Math.max(width, height);
        width = Math.round(width * scaleFactor);
        height = Math.round(height * scaleFactor);
    }

    const scaleFactor = 768 / Math.min(width, height);
    width = Math.round(width * scaleFactor);
    height = Math.round(height * scaleFactor);

    const tiles = Math.ceil(width / 512) * Math.ceil(height / 512);
    return tiles * 170 + 85;
}

function estimateImageTokensFromBytes(bytes: Uint8Array, mimeType: string, detail: ImageDetail): number {
    const { width, height } = getImageDimensionsFromBytes(bytes, mimeType);
    return calculateOpenAIVisionImageTokenCost(width, height, detail);
}
