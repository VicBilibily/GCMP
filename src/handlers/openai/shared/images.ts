import type * as vscode from 'vscode';
import { Logger } from '../../../utils/runtime/logger';

/**
 * 检查是否为图片MIME类型
 */
export function isImageMimeType(mimeType: string): boolean {
    // 标准化MIME类型
    const normalizedMime = mimeType.toLowerCase().trim();
    // 支持的图像类型
    const supportedTypes = [
        'image/jpeg',
        'image/jpg',
        'image/png',
        'image/gif',
        'image/webp',
        'image/bmp',
        'image/svg+xml'
    ];
    const isImageCategory = normalizedMime.startsWith('image/');
    const isSupported = supportedTypes.includes(normalizedMime);
    // 调试日志
    if (isImageCategory && !isSupported) {
        Logger.warn(
            `🚫 Image type is not in the supported list: ${mimeType}, supported types: ${supportedTypes.join(', ')}`
        );
    } else if (!isImageCategory && normalizedMime !== 'cache_control') {
        // 对于cache_control（Claude缓存标识）不记录调试信息，对其他非图像类型记录trace级别日志
        // Logger.trace(`📄 非图像数据类型: ${mimeType}`);
    }
    return isImageCategory && isSupported;
}

/**
 * 创建图片的data URL
 */
export function createDataUrl(dataPart: vscode.LanguageModelDataPart): string {
    try {
        const base64Data = Buffer.from(dataPart.data).toString('base64');
        const dataUrl = `data:${dataPart.mimeType};base64,${base64Data}`;
        Logger.debug(
            `🔗 Created image DataURL: MIME=${dataPart.mimeType}, originalSize=${dataPart.data.length} bytes, base64Size=${base64Data.length} chars`
        );
        return dataUrl;
    } catch (error) {
        Logger.error(`❌ Failed to create image DataURL: ${error}`);
        throw error;
    }
}

export const openAIImages = { isImageMimeType, createDataUrl };
