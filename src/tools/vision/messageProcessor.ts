/*---------------------------------------------------------------------------------------------
 *  视觉消息处理器
 *  在 executeModelRequest 中调用，将图片 DataPart 写入缓存并替换为工具调用指令。
 *  仅对 capabilities.imageInput === false 的模型生效。
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { ModelConfig } from '../../types/sharedTypes';
import { VisionCache } from './cache';
import { Logger } from '../../utils';

/**
 * 处理消息数组中的所有图片 DataPart：
 * 1. 缓存图片到 vision-cache/{sessionId}/
 * 2. 将 DataPart 替换为文本指令（提示模型调用 gcmp_visionTool 工具）
 *
 * @param messages 原始消息数组（会被修改）
 * @param sessionId 会话 ID
 * @param visionCache VisionCache 实例
 * @param modelConfig 模型配置（检测 imageInput）
 * @returns 处理过程中缓存的图片文件路径列表
 */
export async function processVisionMessages(
    messages: vscode.LanguageModelChatMessage[],
    sessionId: string,
    visionCache: VisionCache,
    modelConfig: ModelConfig
): Promise<string[]> {
    if (modelConfig.capabilities?.imageInput) {
        return [];
    }

    const cachedFiles: string[] = [];

    for (let msgIdx = 0; msgIdx < messages.length; msgIdx++) {
        const msg = messages[msgIdx];
        const parts = msg.content;
        let hasDataPart = false;
        let hasToolPart = false;

        for (const part of parts) {
            if (part instanceof vscode.LanguageModelDataPart && part.mimeType.startsWith('image/')) {
                hasDataPart = true;
            }
            if (
                'toolCallId' in part ||
                'toolCallIds' in part ||
                part instanceof vscode.LanguageModelToolCallPart ||
                part instanceof vscode.LanguageModelToolResultPart
            ) {
                hasToolPart = true;
            }
        }

        if (!hasDataPart || hasToolPart) {
            continue;
        }

        const newParts: Array<vscode.LanguageModelTextPart> = [];

        for (const part of parts) {
            if (part instanceof vscode.LanguageModelDataPart && part.mimeType.startsWith('image/')) {
                try {
                    const uint8 = (await part.data) as Uint8Array;
                    const base64 = Buffer.from(uint8.buffer, uint8.byteOffset, uint8.byteLength).toString('base64');
                    const { path: cachePath } = visionCache.saveImage(sessionId, base64, part.mimeType);
                    cachedFiles.push(cachePath);

                    const instruction =
                        '[Image attached by user - binary image data, not readable as text]\n' +
                        'DO NOT try to read this file directly with read_file or any other tool - it will return garbage.\n' +
                        'The cached image file is located at:\n' +
                        '  ' +
                        cachePath +
                        '\n' +
                        'Pass this file path to an appropriate vision-capable tool to analyze its visual content.\n' +
                        "Be sure to include the user's specific question about the image when calling the vision tool.";

                    newParts.push(new vscode.LanguageModelTextPart(instruction));
                    Logger.trace(`[VisionProcessor] Cached image: ${cachePath}`);
                } catch (err) {
                    Logger.warn(
                        '[VisionProcessor] Failed to process image:',
                        err instanceof Error ? err.message : String(err)
                    );
                    newParts.push(
                        new vscode.LanguageModelTextPart(
                            '[Image attached - failed to cache, image content will be unavailable for vision analysis]'
                        )
                    );
                }
            } else if (part instanceof vscode.LanguageModelTextPart) {
                newParts.push(part);
            }
        }

        const combinedText = newParts.map(p => p.value).join('\n');
        if (msg.role === vscode.LanguageModelChatMessageRole.User) {
            messages[msgIdx] = vscode.LanguageModelChatMessage.User(
                combinedText,
                msg.name
            ) as unknown as vscode.LanguageModelChatMessage;
        } else if (msg.role === vscode.LanguageModelChatMessageRole.Assistant) {
            messages[msgIdx] = vscode.LanguageModelChatMessage.Assistant(
                combinedText,
                msg.name
            ) as unknown as vscode.LanguageModelChatMessage;
        } else {
            messages[msgIdx] = vscode.LanguageModelChatMessage.User(
                combinedText,
                msg.name
            ) as unknown as vscode.LanguageModelChatMessage;
        }
    }

    return cachedFiles;
}
