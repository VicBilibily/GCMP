import * as vscode from 'vscode';
import { Logger } from '../utils/logger';

/**
 * 补全缓存项
 */
interface CompletionCacheItem {
    /** 补全结果 */
    completion: string;
    /** 缓存时间戳 */
    timestamp: number;
    /** 文档版本号 */
    documentVersion: number;
    /** 位置哈希 */
    positionHash: string;
    /** 当前行内容哈希 */
    lineContentHash: string;
    /** 行号 */
    lineNumber: number;
}



/**
 * 内联补全缓存管理器
 * 缓存最近100个位置的补全结果，当位置变更时自动失效
 */
export class CompletionCache {
    private cache = new Map<string, CompletionCacheItem>();
    private readonly maxCacheSize = 100;
    private readonly cacheTimeout = 5 * 60 * 1000; // 5分钟超时

    /**
     * 生成位置的哈希值
     * @param document 文档
     * @param position 位置
     * @returns 位置哈希
     */
    private generatePositionHash(document: vscode.TextDocument, position: vscode.Position): string {
        // 获取位置周围的上下文来生成更精确的哈希
        const contextRadius = 3; // 上下文半径
        const startLine = Math.max(0, position.line - contextRadius);
        const endLine = Math.min(document.lineCount - 1, position.line + contextRadius);

        let context = '';
        for (let i = startLine; i <= endLine; i++) {
            const line = document.lineAt(i).text;
            if (i === position.line) {
                // 在当前行位置插入标记
                context += line.substring(0, position.character) + '█' + line.substring(position.character) + '\n';
            } else {
                context += line + '\n';
            }
        }

        // 生成简单的哈希
        return this.simpleHash(context);
    }

    /**
     * 简单哈希函数
     * @param str 输入字符串
     * @returns 哈希值
     */
    private simpleHash(str: string): string {
        let hash = 0;
        for (let i = 0; i < str.length; i++) {
            const char = str.charCodeAt(i);
            hash = ((hash << 5) - hash) + char;
            hash = hash & hash; // 转换为32位整数
        }
        return Math.abs(hash).toString(36);
    }

    /**
     * 生成行内容哈希
     * @param document 文档
     * @param lineNumber 行号
     * @returns 行内容哈希
     */
    private generateLineContentHash(document: vscode.TextDocument, lineNumber: number): string {
        if (lineNumber < 0 || lineNumber >= document.lineCount) {
            return '';
        }
        const lineContent = document.lineAt(lineNumber).text;
        return this.simpleHash(lineContent);
    }

    /**
     * 生成缓存键
     * @param document 文档
     * @param position 位置
     * @returns 缓存键
     */
    private generateCacheKey(document: vscode.TextDocument, position: vscode.Position): string {
        const positionHash = this.generatePositionHash(document, position);
        return `${document.uri.toString()}:${positionHash}:${document.version}`;
    }

    /**
     * 查找相似的缓存项（用于同一行临时编辑的情况）
     * @param document 文档
     * @param position 位置
     * @returns 匹配的缓存项或 undefined
     */
    private findSimilarCacheItem(document: vscode.TextDocument, position: vscode.Position): CompletionCacheItem | undefined {
        const currentLineHash = this.generateLineContentHash(document, position.line);
        const currentUri = document.uri.toString();

        // 查找同一文档、同一行、相同行内容的缓存项
        for (const [key, item] of this.cache.entries()) {
            if (!key.startsWith(currentUri + ':')) {
                continue;
            }

            // 检查是否为同一行
            if (item.lineNumber !== position.line) {
                continue;
            }

            // 检查行内容是否相同
            if (item.lineContentHash !== currentLineHash) {
                continue;
            }

            // 检查文档版本（允许小版本差异，如临时编辑）
            const versionDiff = Math.abs(item.documentVersion - document.version);
            if (versionDiff > 5) { // 允许5个版本内的差异
                continue;
            }

            // 检查时间戳
            if (Date.now() - item.timestamp > this.cacheTimeout) {
                continue;
            }

            Logger.trace(`找到相似缓存项，版本差异: ${versionDiff}`);
            return item;
        }

        return undefined;
    }

    /**
     * 检查缓存是否有效
     * @param item 缓存项
     * @param document 文档
     * @param position 位置
     * @returns 是否有效
     */
    private isCacheValid(item: CompletionCacheItem, document: vscode.TextDocument, position: vscode.Position): boolean {
        // 检查时间戳
        if (Date.now() - item.timestamp > this.cacheTimeout) {
            Logger.trace('缓存已超时');
            return false;
        }

        // 检查文档版本（严格匹配）
        if (item.documentVersion !== document.version) {
            Logger.trace('文档版本已变更，缓存失效');
            return false;
        }

        // 检查位置哈希
        const currentPositionHash = this.generatePositionHash(document, position);
        if (item.positionHash !== currentPositionHash) {
            Logger.trace('位置上下文已变更，缓存失效');
            return false;
        }

        return true;
    }

    /**
     * 检查是否为智能匹配场景（同一行临时编辑）
     * @param document 文档
     * @param position 位置
     * @param item 缓存项
     * @returns 是否可以智能匹配
     */
    private canSmartMatch(document: vscode.TextDocument, position: vscode.Position, item: CompletionCacheItem): boolean {
        // 必须是同一行
        if (item.lineNumber !== position.line) {
            return false;
        }

        // 行内容必须相同
        const currentLineHash = this.generateLineContentHash(document, position.line);
        if (item.lineContentHash !== currentLineHash) {
            return false;
        }

        // 版本差异不能太大（防止误匹配）
        const versionDiff = Math.abs(item.documentVersion - document.version);
        if (versionDiff > 5) {
            return false;
        }

        // 时间戳不能过期
        if (Date.now() - item.timestamp > this.cacheTimeout) {
            return false;
        }

        return true;
    }

    /**
     * 清理过期缓存
     */
    private cleanupExpiredCache(): void {
        const now = Date.now();
        const expiredKeys: string[] = [];

        for (const [key, item] of this.cache.entries()) {
            if (now - item.timestamp > this.cacheTimeout) {
                expiredKeys.push(key);
            }
        }

        for (const key of expiredKeys) {
            this.cache.delete(key);
        }

        if (expiredKeys.length > 0) {
            Logger.trace(`清理了 ${expiredKeys.length} 个过期缓存项`);
        }
    }

    /**
     * 维护缓存大小
     * 当缓存超过最大大小时，删除最旧的项
     */
    private maintainCacheSize(): void {
        if (this.cache.size <= this.maxCacheSize) {
            return;
        }

        // 按时间戳排序，删除最旧的项
        const entries = Array.from(this.cache.entries())
            .sort((a, b) => a[1].timestamp - b[1].timestamp);

        const toDelete = entries.slice(0, this.cache.size - this.maxCacheSize);

        for (const [key] of toDelete) {
            this.cache.delete(key);
        }

        Logger.trace(`删除了 ${toDelete.length} 个最旧的缓存项`);
    }

    /**
     * 获取缓存的补全结果
     * @param document 文档
     * @param position 位置
     * @returns 缓存的补全结果，如果不存在或无效则返回 undefined
     */
    get(document: vscode.TextDocument, position: vscode.Position): string | undefined {
        // 首先尝试精确匹配
        const key = this.generateCacheKey(document, position);
        const exactItem = this.cache.get(key);

        if (exactItem) {
            // 检查缓存是否有效
            if (this.isCacheValid(exactItem, document, position)) {
                Logger.trace('精确缓存命中');
                return exactItem.completion;
            } else {
                this.cache.delete(key);
                Logger.trace('精确缓存已失效，删除');
            }
        }

        // 如果精确匹配失败，尝试智能匹配（同一行临时编辑）
        const similarItem = this.findSimilarCacheItem(document, position);
        if (similarItem && this.canSmartMatch(document, position, similarItem)) {
            Logger.trace('智能缓存命中（同一行临时编辑）');
            return similarItem.completion;
        }

        Logger.trace('缓存未命中');
        return undefined;
    }

    /**
     * 设置补全缓存
     * @param document 文档
     * @param position 位置
     * @param completion 补全结果
     */
    set(document: vscode.TextDocument, position: vscode.Position, completion: string): void {
        // 清理过期缓存
        this.cleanupExpiredCache();

        // 维护缓存大小
        this.maintainCacheSize();

        const key = this.generateCacheKey(document, position);
        const positionHash = this.generatePositionHash(document, position);
        const lineContentHash = this.generateLineContentHash(document, position.line);

        const item: CompletionCacheItem = {
            completion,
            timestamp: Date.now(),
            documentVersion: document.version,
            positionHash,
            lineContentHash,
            lineNumber: position.line
        };

        this.cache.set(key, item);
        Logger.trace(`缓存补全结果，当前缓存大小: ${this.cache.size}`);
    }

    /**
     * 清除指定文档的所有缓存
     * @param uri 文档URI
     */
    clearDocument(uri: vscode.Uri): void {
        const uriString = uri.toString();
        const keysToDelete: string[] = [];

        for (const key of this.cache.keys()) {
            if (key.startsWith(uriString + ':')) {
                keysToDelete.push(key);
            }
        }

        for (const key of keysToDelete) {
            this.cache.delete(key);
        }

        if (keysToDelete.length > 0) {
            Logger.trace(`清除文档 ${uriString} 的 ${keysToDelete.length} 个缓存项`);
        }
    }

    /**
     * 清除所有缓存
     */
    clear(): void {
        const size = this.cache.size;
        this.cache.clear();
        Logger.info(`清除了所有缓存，共 ${size} 项`);
    }

    /**
     * 获取缓存统计信息
     * @returns 缓存统计
     */
    getStats(): { size: number; maxSize: number; timeout: number } {
        return {
            size: this.cache.size,
            maxSize: this.maxCacheSize,
            timeout: this.cacheTimeout
        };
    }

    /**
     * 手动触发缓存清理
     */
    cleanup(): void {
        this.cleanupExpiredCache();
        this.maintainCacheSize();
        Logger.trace('手动缓存清理完成');
    }
}

// 导出单例实例
export const completionCache = new CompletionCache();
