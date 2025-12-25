/*---------------------------------------------------------------------------------------------
 *  文件路径管理器
 *  负责管理日志文件的目录结构: logs/usages/YYYY-MM-DD/HH.jsonl
 *--------------------------------------------------------------------------------------------*/

import * as path from 'path';
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
        const dateStr = this.formatDate(date);
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
     * 获取今日的日期字符串
     */
    getTodayDateString(): string {
        return this.formatDate(new Date());
    }

    /**
     * 获取昨日的日期字符串
     */
    getYesterdayDateString(): string {
        const yesterday = new Date();
        yesterday.setDate(yesterday.getDate() - 1);
        return this.formatDate(yesterday);
    }

    /**
     * 获取基础目录路径
     */
    getBaseDir(): string {
        return this.baseDir;
    }

    /**
     * 从日期字符串解析出日期范围(开始和结束时间戳)
     */
    parseDateRange(dateStr: string): { start: number; end: number } {
        const start = new Date(dateStr).getTime();
        const end = start + 24 * 60 * 60 * 1000; // 24小时后
        return { start, end };
    }

    /**
     * 从小时字符串解析出小时范围(开始和结束时间戳)
     * @param dateStr 日期字符串 (YYYY-MM-DD)
     * @param hour 小时 (0-23)
     */
    parseHourRange(dateStr: string, hour: number): { start: number; end: number } {
        const date = new Date(dateStr);
        date.setHours(hour, 0, 0, 0);
        const start = date.getTime();
        const end = start + 60 * 60 * 1000; // 1小时后
        return { start, end };
    }

    /**
     * 格式化日期为 YYYY-MM-DD
     */
    private formatDate(date: Date): string {
        const year = date.getFullYear();
        const month = String(date.getMonth() + 1).padStart(2, '0');
        const day = String(date.getDate()).padStart(2, '0');
        return `${year}-${month}-${day}`;
    }
}
