/*---------------------------------------------------------------------------------------------
 *  视觉消息处理器
 *  在 executeModelRequest 中调用，将图片 DataPart 写入缓存并替换为工具调用指令。
 *  仅对 capabilities.imageInput === false 的模型生效。
 *
 *  借鉴 Copilot Chat Skills 的「渐进式加载」思想：
 *  - 完整工具指引（VISION_TOOL_GUIDE）每个会话只注入一次（通过 MARKER 检测去重）
 *  - 每张图片只注入精简引用 <attachment filePath="..." />
 *  - 避免对话历史累积时每张图片都重复注入 ~250 字符的提示词
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { ModelConfig } from '../../types/sharedTypes';
import { VisionCache } from './cache';
import { Logger } from '../../utils';

/**
 * 视觉工具指引的唯一标记，用于检测是否已注入过完整指引。
 * 设计为 XML 注释形式，对模型透明、不会污染对话语义。
 */
const VISION_GUIDE_MARKER = '<!-- GCMP-Vision-Guide -->';

/**
 * 完整视觉工具指引：仅当本次会话首次出现图片时注入一次。
 * 包含工具集名称、7 个子工具的选型映射、以及禁用内置文件工具的约束。
 */
const VISION_TOOL_GUIDE = [
    VISION_GUIDE_MARKER,
    'When you see <attachment filePath="..."> tags in this conversation, the user has attached images.',
    'The filePath is a short cache path (sessionId/hash.ext). Pass it verbatim as the filePath argument to the appropriate vision tool (use the # reference name):',
    '- UI screenshot / mockup → #gcmpUiToArtifact',
    '- error screenshot / stack trace → #gcmpDiagnoseErrorScreenshot',
    '- code or text screenshot → #gcmpExtractTextFromScreenshot',
    '- architecture / technical diagram → #gcmpUnderstandTechnicalDiagram',
    '- chart / data visualization → #gcmpAnalyzeDataVisualization',
    '- two images to compare → #gcmpUiDiffCheck',
    '- general image → #gcmpAnalyzeImage',
    '',
    'Do NOT use any VS Code built-in tools (such as readFile, read_file, file search, or image viewer tools) to inspect image files directly.'
].join('\n');

/**
 * 单张图片的精简引用：替代原本 ~250 字符的 hintText，仅保留短路径与类型信息。
 * 使用短路径（sessionId/hash.ext）而非绝对路径，可省去冗长的 vision-cache 根前缀，
 * 工具侧通过 VisionCache.resolveShortPath() 还原。
 * 模型通过会话级 VISION_TOOL_GUIDE 知道如何处理 <attachment> 标签。
 */
function buildImageRef(shortPath: string, mimeType: string): string {
    return `<attachment filePath="${shortPath}" mimeType="${mimeType}" />`;
}

/**
 * 扫描消息数组，判断是否已经注入过视觉工具指引。
 * 通过查找 VISION_GUIDE_MARKER 实现，避免对话历史累积时重复注入。
 */
function isVisionGuideInjected(messages: readonly vscode.LanguageModelChatMessage[]): boolean {
    for (const msg of messages) {
        for (const part of msg.content) {
            if (
                part instanceof vscode.LanguageModelTextPart &&
                typeof part.value === 'string' &&
                part.value.includes(VISION_GUIDE_MARKER)
            ) {
                return true;
            }
        }
    }
    return false;
}

/**
 * 处理消息数组中的所有图片 DataPart：
 * 1. 缓存图片到 vision-cache/{sessionId}/
 * 2. 将 DataPart 替换为精简引用 <attachment filePath="..." />
 * 3. 若本次会话尚未注入视觉工具指引，将其 prepend 到首个含图片的 User 消息前
 *    （避免独立 unshift 一条消息破坏 System→User→Assistant 的顺序）
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
    const guideAlreadyInjected = isVisionGuideInjected(messages);
    let guideInjectedThisRound = false;

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

        // 首个含图片的消息：若本会话尚未注入指引，prepend 到该消息最前面
        if (!guideAlreadyInjected && !guideInjectedThisRound) {
            newParts.push(new vscode.LanguageModelTextPart(VISION_TOOL_GUIDE));
            guideInjectedThisRound = true;
        }

        for (const part of parts) {
            if (part instanceof vscode.LanguageModelDataPart && part.mimeType.startsWith('image/')) {
                try {
                    const uint8 = (await part.data) as Uint8Array;
                    const base64 = Buffer.from(uint8.buffer, uint8.byteOffset, uint8.byteLength).toString('base64');
                    const saved = visionCache.saveImage(sessionId, base64, part.mimeType);
                    cachedFiles.push(saved.path);

                    newParts.push(new vscode.LanguageModelTextPart(buildImageRef(saved.shortPath, part.mimeType)));
                    Logger.trace(`[VisionProcessor] Cached image: ${saved.path}`);
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

    if (guideInjectedThisRound) {
        Logger.trace('[VisionProcessor] Injected vision tool guide (session first occurrence)');
    }

    return cachedFiles;
}
