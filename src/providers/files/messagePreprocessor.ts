/*---------------------------------------------------------------------------------------------
 *  Files API 消息预处理器
 *  在 executeModelRequest 中调用，把 user 消息的图片 DataPart 上传后
 *  替换为携带 file_id 的 FilesApiFileRef part，供三个协议转换层引用。
 *  仅对 capabilities.imageInput === true 且 filesApi 启用的模型生效。
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { Logger } from '../../utils/runtime/logger';
import { CustomDataPartMimeTypes } from '../../handlers/types';
import type { ImageFileResolver } from './imageFileResolver';

/**
 * 把 user 消息中的图片 DataPart 上传为 Files API file_id 并替换为引用 part。
 * 上传失败保留原 part（走 base64 内联降级），不阻塞对话。
 */
export async function resolveFilesApiImages(
    messages: vscode.LanguageModelChatMessage[],
    resolver: ImageFileResolver,
    ttlSeconds: number,
    sessionId: string
): Promise<void> {
    for (let msgIdx = 0; msgIdx < messages.length; msgIdx++) {
        const msg = messages[msgIdx];
        // DeepSeek 图片仅支持 user 消息
        if (msg.role !== vscode.LanguageModelChatMessageRole.User) {
            continue;
        }
        const parts = msg.content;
        const hasImage = parts.some(p => p instanceof vscode.LanguageModelDataPart && p.mimeType.startsWith('image/'));
        if (!hasImage) {
            continue;
        }

        const newParts: unknown[] = [];
        for (const part of parts) {
            if (part instanceof vscode.LanguageModelDataPart && part.mimeType.startsWith('image/')) {
                try {
                    const bytes = (await part.data) as Uint8Array;
                    const fileId = await resolver.resolveFileId(bytes, part.mimeType, ttlSeconds, sessionId);
                    newParts.push(
                        new vscode.LanguageModelDataPart(
                            new TextEncoder().encode(fileId),
                            CustomDataPartMimeTypes.FilesApiFileRef
                        )
                    );
                } catch (err) {
                    Logger.warn(
                        '[FilesAPI] Failed to upload image, fallback to inline base64:',
                        err instanceof Error ? err.message : String(err)
                    );
                    newParts.push(part);
                }
            } else {
                newParts.push(part);
            }
        }

        messages[msgIdx] = vscode.LanguageModelChatMessage.User(
            newParts as Array<
                vscode.LanguageModelTextPart | vscode.LanguageModelToolResultPart | vscode.LanguageModelDataPart
            >,
            msg.name
        ) as unknown as vscode.LanguageModelChatMessage;
    }
}
