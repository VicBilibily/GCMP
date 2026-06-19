/*---------------------------------------------------------------------------------------------
 *  图片缓存服务
 *  将用户粘贴的图片（LanguageModelDataPart）存入工作区临时目录，
 *  供 gcmpVisionTool 视觉工具集读取并调用 Vision API 分析。
 *  存储路径：{context.storageUri}/vision-cache/{sessionId}/{fileSHA}.{ext}
 *
 *  为减少注入给模型的 token 消耗，attachment 中只写「短路径」(sessionId/hash.ext)，
 *  工具侧通过 resolveShortPath() 还原为绝对路径。
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { Logger } from '../../utils';

export class VisionCache {
    /**
     * 缓存根目录的静态引用，供工具侧（无 VisionCache 实例）解析短路径使用。
     * 通过 configure() 在扩展激活时设置一次。
     */
    private static rootFsPath: string | undefined;

    constructor(private storageUri: vscode.Uri) {}

    /**
     * 计算 base64 数据的简短哈希（SHA-256 前 16 位，用于去重）
     */
    static hashBase64(base64: string): string {
        return crypto.createHash('sha256').update(base64, 'utf8').digest('hex').slice(0, 16);
    }

    /**
     * 注册缓存根目录，使工具侧能通过 resolveShortPath 还原短路径。
     * 应在扩展 activate 时调用一次。
     */
    static configure(storageUri: vscode.Uri | undefined): void {
        VisionCache.rootFsPath = storageUri ? path.join(storageUri.fsPath, 'vision-cache') : undefined;
    }

    /**
     * 短路径格式正则：`{UUID}/{16位hex}.{ext}`
     * - UUID 形如 `xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx`（标准 v4 长度，兼容历史 anthropic 变体）
     * - hash 为 SHA-256 前 16 位 hex
     * 用正则精确匹配，避免把绝对路径、URL、裸文件名误判为短路径。
     */
    private static readonly SHORT_PATH_PATTERN = /^[0-9a-fA-F-]{30,}\/[0-9a-fA-F]+\.\w+$/;

    /**
     * 将短路径（sessionId/hash.ext）还原为绝对路径。
     *
     * 识别规则（保守）：
     * - 空 / 绝对路径 / `./` 或 `../` 前缀 / URL / 裸文件名 → 原样返回，交由调用方处理
     * - 仅匹配 `{sessionId}/{hash}.{ext}` 形态的短路径 → 拼接到 vision-cache 根
     *
     * 工具集是注册给 Copilot 的全局工具，所有模型（含 Copilot 原生、用户手动调用、
     * 其他扩展转发）都可能传入任意形式的路径，本方法保持最大兼容性。
     *
     * @param shortOrAbsolutePath 短路径或任意路径
     * @returns 绝对路径或原样返回的输入
     */
    static resolveShortPath(shortOrAbsolutePath: string): string {
        if (!shortOrAbsolutePath) {
            return shortOrAbsolutePath;
        }
        // 任何绝对路径（含 Windows 盘符、Unix 根）和显式相对路径前缀原样返回
        if (path.isAbsolute(shortOrAbsolutePath) || shortOrAbsolutePath.startsWith('.')) {
            return shortOrAbsolutePath;
        }
        // 仅匹配短路径形态，避免误判 URL、裸文件名等
        if (VisionCache.rootFsPath && VisionCache.SHORT_PATH_PATTERN.test(shortOrAbsolutePath)) {
            return path.join(VisionCache.rootFsPath, shortOrAbsolutePath);
        }
        // 根目录未配置 或 不匹配短路径格式 → 原样返回让 fs.existsSync 给出明确错误
        return shortOrAbsolutePath;
    }

    /**
     * 获取缓存文件绝对路径
     */
    getCachePath(sessionId: string, hash: string, ext: string): string {
        return path.join(this.storageUri.fsPath, 'vision-cache', sessionId, `${hash}.${ext}`);
    }

    /**
     * 获取缓存文件的短路径（去掉冗长的 vision-cache 根前缀）。
     * 短路径形式：sessionId/hash.ext，约 50 字符 vs 绝对路径 150+ 字符。
     */
    getShortPath(sessionId: string, hash: string, ext: string): string {
        return path.join(sessionId, `${hash}.${ext}`).replace(/\\/g, '/');
    }

    /**
     * 写入图片到缓存（去重：相同 hash 跳过写入）
     * @returns absolutePath 完整路径、shortPath 短路径、hash 文件哈希
     */
    saveImage(
        sessionId: string,
        base64: string,
        mimeType: string
    ): {
        path: string;
        shortPath: string;
        hash: string;
    } {
        const ext = mimeType.split('/')[1] || 'png';
        const hash = VisionCache.hashBase64(base64);
        const cachePath = this.getCachePath(sessionId, hash, ext);

        if (fs.existsSync(cachePath)) {
            Logger.trace(`[VisionCache] HIT: ${cachePath}`);
            return { path: cachePath, shortPath: this.getShortPath(sessionId, hash, ext), hash };
        }

        fs.mkdirSync(path.dirname(cachePath), { recursive: true });
        fs.writeFileSync(cachePath, Buffer.from(base64, 'base64'));
        Logger.trace(`[VisionCache] SAVED: ${cachePath}`);
        return { path: cachePath, shortPath: this.getShortPath(sessionId, hash, ext), hash };
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
