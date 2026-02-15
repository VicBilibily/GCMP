/*---------------------------------------------------------------------------------------------
 *  Anthropic 消息转换器
 *
 *  主要功能:
 *  - VS Code API消息格式转换为 Anthropic API格式
 *  - 支持文本、图像、工具调用和工具结果
 *  - 支持思考内容（thinking）转换，保持多轮对话思维链连续性
 *  - 支持缓存控制和流式响应处理
 *  - 完整的错误处理和类型安全
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import Anthropic from '@anthropic-ai/sdk';
import type {
    ContentBlockParam,
    ThinkingBlockParam,
    RedactedThinkingBlockParam,
    MessageParam,
    TextBlockParam,
    ImageBlockParam,
    ToolResultBlockParam
} from '@anthropic-ai/sdk/resources';
import { ModelConfig } from '../types/sharedTypes';
import { CacheType, CustomDataPartMimeTypes } from './types';

/**
 * 思考部分的元数据接口
 */
interface ThinkingPartMetadata {
    signature?: string;
    data?: string;
    _completeThinking?: string;
}

/**
 * 类型守卫 - 检查对象是否有 mimeType 和 data 属性
 */
function isDataPart(part: unknown): part is vscode.LanguageModelDataPart2 {
    return typeof part === 'object' && part !== null && 'mimeType' in part && 'data' in part;
}

/**
 * 获取思考部分的元数据
 */
function getThinkingMetadata(part: vscode.LanguageModelThinkingPart): ThinkingPartMetadata {
    return (part as unknown as { metadata?: ThinkingPartMetadata }).metadata ?? {};
}

/**
 * 检查内容块是否支持缓存控制
 * thinking 和 redacted_thinking 块不支持缓存控制
 */
function contentBlockSupportsCacheControl(
    block: ContentBlockParam
): block is Exclude<ContentBlockParam, ThinkingBlockParam | RedactedThinkingBlockParam> {
    return block.type !== 'thinking' && block.type !== 'redacted_thinking';
}

/**
 * 将 VS Code API 消息内容转换为 Anthropic 格式
 * 支持 thinking 内容块以保持多轮对话中思维链的连续性
 */
function apiContentToAnthropicContent(
    content: vscode.LanguageModelChatMessage['content'],
    modelConfig: ModelConfig
): ContentBlockParam[] {
    const thinkingBlocks: ContentBlockParam[] = [];
    const otherBlocks: ContentBlockParam[] = [];

    // 模型能力：不支持 imageInput 时，必须忽略所有 image/* 数据块。
    const allowImages = modelConfig.capabilities?.imageInput === true;

    for (const part of content) {
        // 思考内容（thinking）- 用于保持多轮对话思维链连续性
        if (part instanceof vscode.LanguageModelThinkingPart) {
            const metadata = getThinkingMetadata(part);

            // 如果是加密的思考内容（redacted_thinking）
            if (metadata.data) {
                thinkingBlocks.push({
                    type: 'redacted_thinking',
                    data: metadata.data
                } as RedactedThinkingBlockParam);
            } else {
                // mark: 2025/12/26 官方的数据传递有问题，_completeThinking的内容可能不完整
                // // 普通思考内容 - 优先使用 _completeThinking（完整思考内容）
                // const thinkingBlock: ThinkingBlockParam = {
                //     type: 'thinking',
                //     thinking: metadata._completeThinking,
                //     signature: metadata.signature || ''
                // };
                // thinkingBlocks.push(thinkingBlock);

                let thinking = metadata?._completeThinking || ''; // 先用_completeThinking
                if (typeof part.value === 'string' && part.value.trim() !== '') {
                    const partStr = part.value as string;
                    if (partStr.length > thinking.length) {
                        thinking = partStr;
                    }
                } else if (Array.isArray(part.value) && part.value.length > 0) {
                    const partStr = part.value.join('');
                    if (partStr.length > thinking.length) {
                        thinking = partStr;
                    }
                }

                const thinkingBlock: ThinkingBlockParam = {
                    type: 'thinking',
                    thinking: thinking || ' ', // Anthropic 不接受空字符串，使用空格
                    signature: metadata.signature || ''
                };
                thinkingBlocks.push(thinkingBlock);
            }
        }
        // 工具调用
        else if (part instanceof vscode.LanguageModelToolCallPart) {
            otherBlocks.push({
                type: 'tool_use',
                id: part.callId,
                input: part.input,
                name: part.name
            });
        }
        // 缓存控制标记
        else if (
            isDataPart(part) &&
            part.mimeType === CustomDataPartMimeTypes.CacheControl &&
            String(part.data) === CacheType
        ) {
            const previousBlock = otherBlocks.at(-1);
            if (previousBlock && contentBlockSupportsCacheControl(previousBlock)) {
                (previousBlock as ContentBlockParam & { cache_control?: { type: string } }).cache_control = {
                    type: CacheType
                };
            } else {
                // 空字符串无效，使用空格
                otherBlocks.push({
                    type: 'text',
                    text: ' ',
                    cache_control: { type: CacheType }
                } as ContentBlockParam);
            }
        }
        // 图像数据
        else if (isDataPart(part) && part.mimeType.startsWith('image/')) {
            // 跳过 StatefulMarker
            if (part.mimeType === CustomDataPartMimeTypes.StatefulMarker) {
                continue;
            }
            if (allowImages) {
                otherBlocks.push({
                    type: 'image',
                    source: {
                        type: 'base64',
                        data: Buffer.from(part.data as Uint8Array).toString('base64'),
                        media_type: part.mimeType as 'image/jpeg' | 'image/png' | 'image/gif' | 'image/webp'
                    }
                } as ImageBlockParam);
            } else {
                // 模型不支持图片时，添加占位符
                otherBlocks.push({ type: 'text', text: '[Image]' } as TextBlockParam);
            }
        }
        // 工具结果
        else if (
            part instanceof vscode.LanguageModelToolResultPart ||
            (part as unknown as { callId?: string }).callId !== undefined
        ) {
            // 支持 LanguageModelToolResultPart 和 LanguageModelToolResultPart2
            const toolPart = part as unknown as {
                callId: string;
                content: (vscode.LanguageModelTextPart | vscode.LanguageModelDataPart)[];
            };
            const convertedContents: (TextBlockParam | ImageBlockParam)[] = [];

            for (const p of toolPart.content) {
                if (p instanceof vscode.LanguageModelTextPart) {
                    convertedContents.push({ type: 'text', text: p.value });
                    continue;
                }

                if (
                    isDataPart(p) &&
                    p.mimeType === CustomDataPartMimeTypes.CacheControl &&
                    String(p.data) === CacheType
                ) {
                    const previousBlock = convertedContents.at(-1);
                    if (previousBlock) {
                        previousBlock.cache_control = { type: CacheType };
                    } else {
                        // 空字符串无效，使用空格
                        convertedContents.push({ type: 'text', text: ' ', cache_control: { type: CacheType } });
                    }
                    continue;
                }

                if (isDataPart(p) && p.mimeType.startsWith('image/')) {
                    if (!allowImages) {
                        // 模型不支持图片时，添加占位符
                        convertedContents.push({ type: 'text', text: '[Image]' });
                        continue;
                    }
                    convertedContents.push({
                        type: 'image',
                        source: {
                            type: 'base64',
                            media_type: p.mimeType as 'image/jpeg' | 'image/png' | 'image/gif' | 'image/webp',
                            data: Buffer.from(p.data as Uint8Array).toString('base64')
                        }
                    });
                    continue;
                }
            }

            const block: ToolResultBlockParam = {
                type: 'tool_result',
                tool_use_id: toolPart.callId,
                content: convertedContents
            };
            otherBlocks.push(block);
        }
        // 文本内容
        else if (part instanceof vscode.LanguageModelTextPart) {
            // Anthropic 在空字符串时会报错，跳过空文本部分
            if (part.value === '') {
                continue;
            }
            otherBlocks.push({
                type: 'text',
                text: part.value
            });
        }
    }

    // 重要：thinking 块必须在最前面（Anthropic API 要求）
    return [...thinkingBlocks, ...otherBlocks];
}

/**
 * 将 VS Code API 消息转换为 Anthropic 格式
 */
export function apiMessageToAnthropicMessage(
    model: ModelConfig,
    messages: readonly vscode.LanguageModelChatMessage[]
): {
    messages: MessageParam[];
    system: TextBlockParam;
} {
    const unmergedMessages: MessageParam[] = [];
    const systemMessage: TextBlockParam = {
        type: 'text',
        text: ''
    };

    for (const message of messages) {
        if (message.role === vscode.LanguageModelChatMessageRole.Assistant) {
            unmergedMessages.push({
                role: 'assistant',
                content: apiContentToAnthropicContent(message.content, model)
            });
        } else if (message.role === vscode.LanguageModelChatMessageRole.User) {
            unmergedMessages.push({
                role: 'user',
                content: apiContentToAnthropicContent(message.content, model)
            });
        } else if (message.role === vscode.LanguageModelChatMessageRole.System) {
            systemMessage.text += message.content
                .map(p => {
                    if (p instanceof vscode.LanguageModelTextPart) {
                        return p.value;
                    } else if (
                        'data' in p &&
                        'mimeType' in p &&
                        p.mimeType === CustomDataPartMimeTypes.CacheControl &&
                        (p.data as Uint8Array).toString() === CacheType
                    ) {
                        (systemMessage as TextBlockParam & { cache_control?: { type: string } }).cache_control = {
                            type: CacheType
                        };
                    }
                    return '';
                })
                .join('');
        }
    }

    // 合并连续的相同角色消息
    const mergedMessages: MessageParam[] = [];
    for (const message of unmergedMessages) {
        if (mergedMessages.length === 0 || mergedMessages[mergedMessages.length - 1].role !== message.role) {
            mergedMessages.push(message);
        } else {
            const prevMessage = mergedMessages[mergedMessages.length - 1];
            if (Array.isArray(prevMessage.content) && Array.isArray(message.content)) {
                (prevMessage.content as ContentBlockParam[]).push(...(message.content as ContentBlockParam[]));
            }
        }
    }

    // 统一清理 cache_control：
    // 从后往前遍历，每个块内只保留最后一个，同时全局只保留最后一个有效 block 的 cache_control
    let foundLastCache = false;
    for (let i = mergedMessages.length - 1; i >= 0; i--) {
        const msg = mergedMessages[i];
        if (!Array.isArray(msg.content)) {
            continue;
        }
        const blocks = msg.content as (ContentBlockParam & { cache_control?: { type: string } })[];
        // 先清理该块内多余的 cache_control，只保留最后一个
        let lastCacheIndex = -1;
        for (let k = blocks.length - 1; k >= 0; k--) {
            if (blocks[k].cache_control) {
                lastCacheIndex = k;
                break;
            }
        }
        for (let k = 0; k < lastCacheIndex; k++) {
            if ('cache_control' in blocks[k]) {
                delete blocks[k].cache_control;
            }
        }
        // 然后全局清理：从后往前，只保留最后一个有效 block 的 cache_control
        // 跳过第一个块（i === 0）环境信息不参与全局清理
        if (i > 0) {
            for (let j = blocks.length - 1; j >= 0; j--) {
                if (blocks[j].cache_control) {
                    if (!foundLastCache) {
                        foundLastCache = true;
                    } else {
                        delete blocks[j].cache_control;
                    }
                }
            }
        }
    }

    return { messages: mergedMessages, system: systemMessage };
}

/**
 * 转换工具定义为 Anthropic 格式
 */
export function convertToAnthropicTools(tools: readonly vscode.LanguageModelChatTool[]): Anthropic.Messages.Tool[] {
    return tools.map(tool => {
        const inputSchema = tool.inputSchema as Anthropic.Messages.Tool.InputSchema | undefined;

        if (!inputSchema) {
            return {
                name: tool.name,
                description: tool.description || '',
                input_schema: {
                    type: 'object' as const,
                    properties: {},
                    required: []
                }
            };
        }

        return {
            name: tool.name,
            description: tool.description || '',
            input_schema: {
                type: 'object' as const,
                properties: inputSchema.properties ?? {},
                required: inputSchema.required ?? [],
                ...(inputSchema.additionalProperties !== undefined && {
                    additionalProperties: inputSchema.additionalProperties
                })
            }
        };
    });
}
