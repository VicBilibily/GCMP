/*---------------------------------------------------------------------------------------------
 *  视觉消息处理器
 *  在 executeModelRequest 中调用，将图片 DataPart 写入缓存并替换为工具调用指令。
 *  仅对 capabilities.imageInput === false 的模型生效。
 *  当 enforceToolUse 为 true 时，明确要求模型必须使用 gcmp_visionTool 分析图片，
 *  避免模型使用 read_file 等工具直接读取缓存文件导致视觉信息丢失。
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { ModelConfig } from '../../types/sharedTypes';
import { VisionCache } from './cache';
import { Logger, ConfigManager } from '../../utils';

/**
 * 生成图片附件的指令文本
 * 从 ConfigManager 读取 enforceToolUse / customInstruction 配置
 */
function buildAttachmentInstruction(cachePath: string, mimeType: string): string {
    const ext = mimeType.replace('image/', '');
    const { enforceToolUse, customInstruction } = ConfigManager.getConfig().vision;
    let instruction: string;
    if (customInstruction) {
        instruction = customInstruction;
    } else if (enforceToolUse) {
        instruction =
            "IMPORTANT: You must use the 'gcmp_visionTool' to analyze this image. Do NOT use read_file or any other file-reading tool — they treat image files as binary data and cannot extract visual content.";
    } else {
        instruction = 'Use a vision-capable tool to analyze the image content.';
    }
    return `<attachment><instruction>${instruction}</instruction><filePath>${cachePath}</filePath><mimeType>${ext}</mimeType></attachment>`;
}

/**
 * 处理消息数组中的所有图片 DataPart：
 * 1. 缓存图片到 vision-cache/{sessionId}/
 * 2. 将 DataPart 替换为 XML 附件文本指令
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

        const newParts: unknown[] = [];

        for (const part of parts) {
            if (part instanceof vscode.LanguageModelDataPart && part.mimeType.startsWith('image/')) {
                try {
                    const uint8 = (await part.data) as Uint8Array;
                    const base64 = Buffer.from(uint8.buffer, uint8.byteOffset, uint8.byteLength).toString('base64');
                    const { path: cachePath } = visionCache.saveImage(sessionId, base64, part.mimeType);
                    cachedFiles.push(cachePath);

                    newParts.push(
                        new vscode.LanguageModelTextPart(buildAttachmentInstruction(cachePath, part.mimeType))
                    );
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
            } else {
                newParts.push(part);
            }
        }

        if (msg.role === vscode.LanguageModelChatMessageRole.User) {
            messages[msgIdx] = vscode.LanguageModelChatMessage.User(
                newParts as Array<
                    vscode.LanguageModelTextPart | vscode.LanguageModelToolResultPart | vscode.LanguageModelDataPart
                >,
                msg.name
            ) as unknown as vscode.LanguageModelChatMessage;
        } else if (msg.role === vscode.LanguageModelChatMessageRole.Assistant) {
            messages[msgIdx] = vscode.LanguageModelChatMessage.Assistant(
                newParts as Array<
                    vscode.LanguageModelTextPart | vscode.LanguageModelToolCallPart | vscode.LanguageModelDataPart
                >,
                msg.name
            ) as unknown as vscode.LanguageModelChatMessage;
        } else {
            messages[msgIdx] = vscode.LanguageModelChatMessage.User(
                newParts as Array<
                    vscode.LanguageModelTextPart | vscode.LanguageModelToolResultPart | vscode.LanguageModelDataPart
                >,
                msg.name
            ) as unknown as vscode.LanguageModelChatMessage;
        }
    }

    return cachedFiles;
}
