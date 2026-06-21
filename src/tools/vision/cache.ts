/*---------------------------------------------------------------------------------------------
 *  图片缓存服务
 *  将用户粘贴的图片（LanguageModelDataPart）存入工作区临时目录，
 *  供 gcmpVisionTool 视觉工具集读取并调用 Vision API 分析。
 *  存储路径：{context.storageUri}/vision-cache/{sessionId}/{fileSHA}.{ext}
 *
 *  为保证工具侧拿到可直接读取的本地路径，attachment 中直接写入完整缓存绝对路径。
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { Logger } from '../../utils';

export class VisionCache {
    constructor(private storageUri: vscode.Uri) {}

    /**
     * 计算 base64 数据的简短哈希（SHA-256 前 16 位，用于去重）
     */
    static hashBase64(base64: string): string {
        return crypto.createHash('sha256').update(base64, 'utf8').digest('hex').slice(0, 16);
    }

    /**
     * 获取缓存文件绝对路径
     */
    getCachePath(sessionId: string, hash: string, ext: string): string {
        return path.join(this.storageUri.fsPath, 'vision-cache', sessionId, `${hash}.${ext}`);
    }

    /**
     * 写入图片到缓存（去重：相同 hash 跳过写入）
     * @returns absolutePath 完整路径、hash 文件哈希
     */
    saveImage(
        sessionId: string,
        base64: string,
        mimeType: string
    ): {
        path: string;
        hash: string;
    } {
        const ext = mimeType.split('/')[1] || 'png';
        const hash = VisionCache.hashBase64(base64);
        const cachePath = this.getCachePath(sessionId, hash, ext);

        if (fs.existsSync(cachePath)) {
            Logger.trace(`[VisionCache] HIT: ${cachePath}`);
            return { path: cachePath, hash };
        }

        fs.mkdirSync(path.dirname(cachePath), { recursive: true });
        fs.writeFileSync(cachePath, Buffer.from(base64, 'base64'));
        Logger.trace(`[VisionCache] SAVED: ${cachePath}`);
        return { path: cachePath, hash };
    }

    /**
     * 清理所有视觉缓存目录
     */
    clearAll(): void {
        const root = path.join(this.storageUri.fsPath, 'vision-cache');
        if (fs.existsSync(root)) {
            fs.rmSync(root, { recursive: true, force: true });
            Logger.trace('[VisionCache] ALL CLEARED');
        }
    }
}
