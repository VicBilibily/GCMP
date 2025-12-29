/*---------------------------------------------------------------------------------------------
 *  文件路径管理器
 *  负责管理日志文件的目录结构: logs/usages/YYYY-MM-DD/HH.jsonl
 *--------------------------------------------------------------------------------------------*/

import * as path from 'path';
import * as fsSync from 'fs';
import * as fs from 'fs/promises';
import { StatusLogger } from '../../utils/statusLogger';
import { DateUtils } from './dateUtils';
import type { LogFilePath } from './types';

/**
 * 文件路径管理器
 * 管理日志文件的目录结构
 */
export class LogPathManager {
    private readonly baseDir: string;

    /**
     * @param baseDir 日志根目录(使用 extensionContext.globalStorageUri.fsPath 确保不被清理)
     */
    constructor(baseDir: string) {
        this.baseDir = path.join(baseDir, 'usages');
    }

    /**
     * 获取指定时间戳的日志文件路径
     */
    getLogPath(timestamp: number): LogFilePath {
        const date = new Date(timestamp);
        return this.getLogPathFromDate(date);
    }

    /**
     * 获取指定日期对象的日志文件路径
     */
    getLogPathFromDate(date: Date): LogFilePath {
        const dateStr = DateUtils.formatDate(date);
        const hour = date.getHours();

        const dateFolder = path.join(this.baseDir, dateStr);
        const hourFileName = `${String(hour).padStart(2, '0')}.jsonl`;
        const fullPath = path.join(dateFolder, hourFileName);

        return {
            date: dateStr,
            hour,
            dateFolder,
            hourFileName,
            fullPath
        };
    }

    /**
     * 获取指定日期字符串的文件夹路径
     */
    getDateFolderPath(dateStr: string): string {
        return path.join(this.baseDir, dateStr);
    }

    /**
     * 获取指定日期和小时的文件路径
     */
    getHourFilePath(dateStr: string, hour: number): string {
        const dateFolder = this.getDateFolderPath(dateStr);
        const hourFileName = `${String(hour).padStart(2, '0')}.jsonl`;
        return path.join(dateFolder, hourFileName);
    }

    /**
     * 获取当前时刻的日志文件路径
     */
    getCurrentLogPath(): LogFilePath {
        return this.getLogPath(Date.now());
    }

    /**
     * 获取基础目录路径
     */
    getBaseDir(): string {
        return this.baseDir;
    }

    /**
     * 确保目录存在(递归创建)
     */
    async ensureDirectoryExists(dir: string): Promise<void> {
        try {
            // 同步检查避免竞态条件
            if (!fsSync.existsSync(dir)) {
                await fs.mkdir(dir, { recursive: true });
                StatusLogger.debug(`[LogPathManager] 创建目录: ${dir}`);
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
