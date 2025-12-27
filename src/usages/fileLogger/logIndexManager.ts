/*---------------------------------------------------------------------------------------------
 *  日志索引管理器
 *  负责 index.json 的读取、写入、更新和重建
 *  索引文件路径: <baseDir>/usages/index.json
 *  用于快速浏览日期列表，无需加载每个日期的完整统计
 *--------------------------------------------------------------------------------------------*/

import * as fs from 'fs/promises';
import * as fsSync from 'fs';
import * as path from 'path';
import { StatusLogger } from '../../utils/statusLogger';
import type { DateIndex, DateIndexEntry, TokenUsageStatsFromFile, TokenStats } from './types';

/**
 * 日志索引管理器
 * 管理 index.json 文件的读写操作
 */
export class LogIndexManager {
    private readonly baseDir: string;

    constructor(baseDir: string) {
        this.baseDir = path.join(baseDir, 'usages');
    }

    /**
     * 获取索引文件路径
     * 路径: <baseDir>/usages/index.json
     */
    getIndexPath(): string {
        return path.join(this.baseDir, 'index.json');
    }

    /**
     * 读取日期索引
     * 用于快速获取所有日期的摘要信息
     */
    private async readIndex(): Promise<DateIndex | null> {
        const indexPath = this.getIndexPath();
        if (!fsSync.existsSync(indexPath)) {
            return null;
        }

        try {
            const content = await fs.readFile(indexPath, 'utf-8');
            const index: DateIndex = JSON.parse(content);
            StatusLogger.debug(`[LogIndexManager] 已读取日期索引，共 ${Object.keys(index.dates).length} 个日期`);
            return index;
        } catch (err) {
            StatusLogger.warn('[LogIndexManager] 读取日期索引失败', err);
            return null;
        }
    }

    /**
     * 保存日期索引
     * 直接保存索引文件，不进行额外检查
     */
    private async saveIndex(index: DateIndex): Promise<void> {
        const indexPath = this.getIndexPath();

        try {
            // 确保基础目录存在
            await this.ensureDirectoryExists(this.baseDir);

            // 写入索引文件
            await fs.writeFile(indexPath, JSON.stringify(index, null, 2), 'utf-8');
            StatusLogger.debug(`[LogIndexManager] 已保存日期索引，共 ${Object.keys(index.dates).length} 个日期`);
        } catch (err) {
            StatusLogger.warn('[LogIndexManager] 保存日期索引失败', err);
            throw err;
        }
    }

    /**
     * 更新日期索引
     * 在保存统计数据后调用，更新索引文件
     */
    async updateIndex(dateStr: string, total: TokenStats): Promise<void> {
        try {
            // 读取现有索引
            let index: DateIndex = { dates: {} };

            const existing = await this.readIndex();
            if (existing) {
                index = existing;
            }

            // 更新索引条目
            index.dates[dateStr] = {
                total_input: total.actualInput,
                total_cache: total.cacheTokens,
                total_output: total.outputTokens,
                total_requests: total.requests
            };

            // 保存索引
            await this.saveIndex(index);
        } catch (err) {
            StatusLogger.warn(`[LogIndexManager] 更新日期索引失败: ${dateStr}`, err);
            // 不抛出错误，索引更新失败不影响主流程
        }
    }

    /**
     * 从索引中删除指定日期
     * 在删除统计数据后调用
     */
    async removeDate(dateStr: string): Promise<void> {
        const indexPath = this.getIndexPath();
        if (!fsSync.existsSync(indexPath)) {
            return;
        }

        try {
            const content = await fs.readFile(indexPath, 'utf-8');
            const index: DateIndex = JSON.parse(content);

            if (index.dates[dateStr]) {
                delete index.dates[dateStr];
                await this.saveIndex(index);
                StatusLogger.debug(`[LogIndexManager] 已从索引中删除日期: ${dateStr}`);
            }
        } catch (err) {
            StatusLogger.warn(`[LogIndexManager] 从索引中删除日期失败: ${dateStr}`, err);
            // 不抛出错误，索引更新失败不影响主流程
        }
    }

    /**
     * 获取所有日期的摘要信息
     * 自动同步索引与实际日期文件夹，添加缺失的日期，移除不存在的日期
     */
    async getIndex(): Promise<Record<string, DateIndexEntry>> {
        // 获取所有实际的日期文件夹
        const actualDates = await this.getAllStatsDates();
        const actualDateSet = new Set(actualDates);

        // 读取现有索引
        const index = await this.readIndex();
        const summaries: Record<string, DateIndexEntry> = {};
        let hasChanges = false;
        if (index) {
            // 验证索引中的日期是否仍然存在，移除不存在的日期
            for (const [dateStr, entry] of Object.entries(index.dates)) {
                const dateFolder = path.join(this.baseDir, dateStr);
                if (fsSync.existsSync(dateFolder)) {
                    summaries[dateStr] = entry;
                    actualDateSet.delete(dateStr); // 从待添加集合中移除已存在的
                } else {
                    hasChanges = true;
                    StatusLogger.debug(`[LogIndexManager] 索引中的日期文件夹不存在，已移除: ${dateStr}`);
                }
            }
        }

        // 将新出现的日期文件夹添加到索引中
        for (const dateStr of actualDates) {
            if (actualDateSet.has(dateStr)) {
                try {
                    const stats = await this.loadStats(dateStr);
                    if (stats) {
                        summaries[dateStr] = {
                            total_input: stats.total.actualInput,
                            total_cache: stats.total.cacheTokens,
                            total_output: stats.total.outputTokens,
                            total_requests: stats.total.requests
                        };
                        hasChanges = true;
                        StatusLogger.debug(`[LogIndexManager] 新日期文件夹已添加到索引: ${dateStr}`);
                    }
                } catch (err) {
                    StatusLogger.warn(`[LogIndexManager] 获取日期摘要失败: ${dateStr}`, err);
                }
            }
        }

        // 如果有变化（新增或删除），更新索引文件
        if (hasChanges) {
            await this.saveIndex({ dates: summaries });
        }
        return summaries;
    }

    /**
     * 获取所有已保存的日期列表
     */
    private async getAllStatsDates(): Promise<string[]> {
        if (!fsSync.existsSync(this.baseDir)) {
            return [];
        }

        try {
            // 读取所有日期目录
            const entries = await fs.readdir(this.baseDir, { withFileTypes: true });
            const dates: string[] = [];

            for (const entry of entries) {
                if (entry.isDirectory()) {
                    const dateStr = entry.name;
                    // 检查是否是有效的日期格式
                    if (/^\d{4}-\d{2}-\d{2}$/.test(dateStr)) {
                        // 检查该日期目录下是否有统计文件
                        const statsFile = path.join(this.baseDir, dateStr, 'stats.json');
                        if (fsSync.existsSync(statsFile)) {
                            dates.push(dateStr);
                        }
                    }
                }
            }

            return dates.sort().reverse(); // 倒序(最新的在前)
        } catch (err) {
            StatusLogger.error('[LogIndexManager] 获取统计日期列表失败', err);
            return [];
        }
    }

    /**
     * 加载日期统计
     */
    private async loadStats(dateStr: string): Promise<TokenUsageStatsFromFile | null> {
        const statsPath = path.join(this.baseDir, dateStr, 'stats.json');
        if (!fsSync.existsSync(statsPath)) {
            return null;
        }

        try {
            const content = await fs.readFile(statsPath, 'utf-8');
            return JSON.parse(content) as TokenUsageStatsFromFile;
        } catch (err) {
            StatusLogger.warn(`[LogIndexManager] 读取日期统计失败: ${dateStr}`, err);
            return null;
        }
    }

    /**
     * 确保目录存在(递归创建)
     */
    private async ensureDirectoryExists(dirPath: string): Promise<void> {
        try {
            // 同步检查避免竞态条件
            if (!fsSync.existsSync(dirPath)) {
                await fs.mkdir(dirPath, { recursive: true });
                StatusLogger.debug(`[LogIndexManager] 创建目录: ${dirPath}`);
            }
        } catch (err) {
            // 忽略已存在错误
            const error = err as NodeJS.ErrnoException;
            if (error.code !== 'EEXIST') {
                throw err;
            }
        }
    }
}
