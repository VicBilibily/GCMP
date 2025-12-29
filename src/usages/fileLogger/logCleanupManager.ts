/*---------------------------------------------------------------------------------------------
 *  日志清理管理器
 *  负责日志文件的删除和清理操作
 *--------------------------------------------------------------------------------------------*/

import * as fs from 'fs/promises';
import * as fsSync from 'fs';
import { StatusLogger } from '../../utils/statusLogger';
import { LogPathManager } from './logPathManager';
import { LogIndexManager } from './logIndexManager';
import { DateUtils } from './dateUtils';

/**
 * 日志清理管理器
 * 负责日志文件的删除和过期清理
 */
export class LogCleanupManager {
    private readonly pathManager: LogPathManager;
    private readonly indexManager: LogIndexManager;
    constructor(pathManager: LogPathManager, indexManager: LogIndexManager) {
        this.pathManager = pathManager;
        this.indexManager = indexManager;
    }

    /**
     * 获取所有日期列表
     */
    async getAllDates(): Promise<string[]> {
        const baseDir = this.pathManager.getBaseDir();
        if (!fsSync.existsSync(baseDir)) {
            return [];
        }

        try {
            const entries = await fs.readdir(baseDir, { withFileTypes: true });
            const dates = entries
                .filter(entry => entry.isDirectory())
                .map(entry => entry.name)
                .filter(name => /^\d{4}-\d{2}-\d{2}$/.test(name))
                .sort()
                .reverse(); // 倒序(最新的在前)
            return dates;
        } catch (err) {
            StatusLogger.error('[LogCleanupManager] 获取日期列表失败', err);
            return [];
        }
    }

    /**
     * 删除指定日期的所有日志文件
     */
    async deleteDateLogs(dateStr: string): Promise<number> {
        const dateFolder = this.pathManager.getDateFolderPath(dateStr);
        if (!fsSync.existsSync(dateFolder)) {
            return 0;
        }

        try {
            const files = await fs.readdir(dateFolder);
            const count = files.length;
            // 删除整个文件夹
            await fs.rm(dateFolder, { recursive: true, force: true });

            // 从索引中删除该日期
            await this.indexManager.removeDate(dateStr);

            StatusLogger.info(`[LogCleanupManager] 已删除过期记录: ${dateStr} (${count} 个文件)`);
            return count;
        } catch (err) {
            StatusLogger.error(`[LogCleanupManager] 删除过期记录失败: ${dateStr}`, err);
            throw err;
        }
    }

    /**
     * 清理过期日志(保留最近N天)
     */
    async cleanupExpiredLogs(retentionDays: number): Promise<number> {
        if (retentionDays === 0) {
            return 0; // 永久保留
        }

        const allDates = await this.getAllDates();
        const cutoffDate = new Date();
        cutoffDate.setDate(cutoffDate.getDate() - retentionDays);
        const cutoffDateStr = DateUtils.formatDate(cutoffDate);

        let deletedCount = 0;
        for (const dateStr of allDates) {
            if (dateStr < cutoffDateStr) {
                const count = await this.deleteDateLogs(dateStr);
                deletedCount += count;
            }
        }
        return deletedCount;
    }
}
