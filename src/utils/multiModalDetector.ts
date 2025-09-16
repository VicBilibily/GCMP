/*---------------------------------------------------------------------------------------------
 *  多模态数据检测器
 *  用于检测消息中是否包含图片、文件等多模态数据
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { Logger } from './logger';

/**
 * 多模态数据检测结果
 */
export interface MultiModalDetectionResult {
    /** 是否包含多模态数据 */
    hasMultiModal: boolean;
    /** 是否包含图片 */
    hasImages: boolean;
    /** 是否包含其他数据文件 */
    hasDataFiles: boolean;
    /** 图片数量 */
    imageCount: number;
    /** 数据文件数量 */
    dataFileCount: number;
    /** 检测到的MIME类型 */
    mimeTypes: string[];
}

/**
 * 多模态数据检测器类
 * 负责检测VS Code消息中是否包含多模态数据
 */
export class MultiModalDetector {
    /**
     * 检测消息数组中是否包含多模态数据
     * 只检测最后一个用户消息
     */
    static detectInMessages(messages: readonly vscode.LanguageModelChatMessage[]): MultiModalDetectionResult {
        Logger.debug(`开始检测 ${messages.length} 条消息中的多模态数据`);

        // 只检测最后一个用户消息
        const lastUserMessage = this.findLastUserMessage(messages);
        if (lastUserMessage) {
            const lastMessageResult = this.detectInSingleMessage(lastUserMessage);
            Logger.info(`最后一个用户消息检测结果: ${this.formatDetectionResult(lastMessageResult)}`);
            return lastMessageResult;
        }

        // 如果没有找到用户消息，返回空结果
        const emptyResult: MultiModalDetectionResult = {
            hasMultiModal: false,
            hasImages: false,
            hasDataFiles: false,
            imageCount: 0,
            dataFileCount: 0,
            mimeTypes: []
        };
        Logger.warn('未找到用户消息，返回空检测结果');
        return emptyResult;
    }

    /**
     * 检测单个消息中的多模态数据
     */
    static detectInSingleMessage(message: vscode.LanguageModelChatMessage): MultiModalDetectionResult {
        const result: MultiModalDetectionResult = {
            hasMultiModal: false,
            hasImages: false,
            hasDataFiles: false,
            imageCount: 0,
            dataFileCount: 0,
            mimeTypes: []
        };

        if (!message.content || typeof message.content === 'string') {
            return result;
        }

        if (!Array.isArray(message.content)) {
            return result;
        }

        // 检查消息内容中的各种部分
        for (const part of message.content) {
            if (part instanceof vscode.LanguageModelDataPart) {
                // 跳过 cache_control 类型
                if (part.mimeType === 'cache_control') {
                    continue;
                }

                result.mimeTypes.push(part.mimeType);

                if (this.isImageMimeType(part.mimeType)) {
                    result.hasImages = true;
                    result.imageCount++;
                    result.hasMultiModal = true;
                    Logger.trace(`检测到图片: ${part.mimeType}, 大小: ${part.data.length} bytes`);
                } else {
                    result.hasDataFiles = true;
                    result.dataFileCount++;
                    result.hasMultiModal = true;
                    Logger.trace(`检测到数据文件: ${part.mimeType}, 大小: ${part.data.length} bytes`);
                }
            }
        }

        return result;
    }

    /**
     * 查找最后一个用户消息
     */
    private static findLastUserMessage(messages: readonly vscode.LanguageModelChatMessage[]): vscode.LanguageModelChatMessage | null {
        for (let i = messages.length - 1; i >= 0; i--) {
            const message = messages[i];
            if (message.role === vscode.LanguageModelChatMessageRole.User) {
                return message;
            }
        }
        return null;
    }

    /**
     * 检查是否为图片MIME类型
     */
    private static isImageMimeType(mimeType: string): boolean {
        return (
            mimeType.startsWith('image/') &&
            ['image/jpeg', 'image/png', 'image/gif', 'image/webp', 'image/jpg'].includes(mimeType)
        );
    }

    /**
     * 格式化检测结果为可读字符串
     */
    private static formatDetectionResult(result: MultiModalDetectionResult): string {
        if (!result.hasMultiModal) {
            return '无多模态数据';
        }

        const parts: string[] = [];
        if (result.hasImages) {
            parts.push(`${result.imageCount}个图片`);
        }
        if (result.hasDataFiles) {
            parts.push(`${result.dataFileCount}个数据文件`);
        }

        const mimeInfo = result.mimeTypes.length > 0 ? ` (${result.mimeTypes.join(', ')})` : '';
        return `${parts.join(', ')}${mimeInfo}`;
    }

    /**
     * 简单检测是否包含图片（快速检测方法）
     */
    static hasImages(messages: readonly vscode.LanguageModelChatMessage[]): boolean {
        return this.detectInMessages(messages).hasImages;
    }

    /**
     * 简单检测是否包含任何多模态数据（快速检测方法）
     */
    static hasMultiModal(messages: readonly vscode.LanguageModelChatMessage[]): boolean {
        return this.detectInMessages(messages).hasMultiModal;
    }
}