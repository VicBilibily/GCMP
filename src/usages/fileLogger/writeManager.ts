/*---------------------------------------------------------------------------------------------
 *  日志写入管理器
 *  带写入锁机制,保证每行日志的完整性
 *  使用队列 + 异步锁实现互斥写入
 *--------------------------------------------------------------------------------------------*/

import * as fs from 'fs/promises';
import * as fsSync from 'fs';
import { Logger } from '../../utils/logger';
import { LogPathManager } from './pathManager';
import type { TokenRequestLog } from './types';

/**
 * 写入任务
 */
interface WriteTask {
    log: TokenRequestLog;
    resolve: () => void;
    reject: (err: Error) => void;
}

/**
 * 日志写入管理器
 * 使用队列保证写入顺序,使用锁保证写入互斥
 */
export class LogWriteManager {
    private readonly pathManager: LogPathManager;
    private writeQueue: WriteTask[] = [];
    private isProcessing = false;
    private isDisposed = false;

    constructor(pathManager: LogPathManager) {
        this.pathManager = pathManager;
    }

    /**
     * 追加日志条目(异步,使用队列)
     */
    async appendLog(log: TokenRequestLog): Promise<void> {
        if (this.isDisposed) {
            throw new Error('[LogWriteManager] 写入管理器已销毁');
        }

        return new Promise((resolve, reject) => {
            // 添加到队列
            this.writeQueue.push({ log, resolve, reject });

            // 触发处理
            this.processQueue();
        });
    }

    /**
     * 批量追加日志条目
     */
    async appendLogs(logs: TokenRequestLog[]): Promise<void> {
        if (this.isDisposed) {
            throw new Error('[LogWriteManager] 写入管理器已销毁');
        }

        // 批量添加到队列
        const promises = logs.map(
            log =>
                new Promise<void>((resolve, reject) => {
                    this.writeQueue.push({ log, resolve, reject });
                })
        );

        // 触发处理
        this.processQueue();

        // 等待所有任务完成
        await Promise.all(promises);
    }

    /**
     * 处理写入队列
     */
    private async processQueue(): Promise<void> {
        // 如果已经在处理,直接返回
        if (this.isProcessing) {
            return;
        }

        this.isProcessing = true;

        try {
            while (this.writeQueue.length > 0) {
                const task = this.writeQueue.shift();
                if (!task) {
                    break;
                }

                try {
                    await this.writeLogInternal(task.log);
                    task.resolve();
                } catch (err) {
                    task.reject(err as Error);
                }
            }
        } finally {
            this.isProcessing = false;
        }
    }

    /**
     * 内部写入方法(实际执行写入)
     * 每次请求都追加新行,形成流水记录
     */
    private async writeLogInternal(log: TokenRequestLog): Promise<void> {
        const logPath = this.pathManager.getLogPathFromDate(new Date(log.timestamp));

        try {
            // 确保日期文件夹存在
            await this.ensureDirectoryExists(logPath.dateFolder);

            // 将日志对象转换为JSONL格式(一行一个JSON)
            // 每次调用都追加新行,同一requestId可能有多条记录(预估→完成/失败)
            const line = JSON.stringify(log) + '\n';

            // 追加到文件(使用 appendFile 自动处理并发)
            await fs.appendFile(logPath.fullPath, line, 'utf-8');

            Logger.debug(
                `[LogWriteManager] 写入流水日志: ${logPath.fullPath} (${log.requestId}, status=${log.status})`
            );
        } catch (err) {
            Logger.error(`[LogWriteManager] 写入日志失败: ${logPath.fullPath}`, err);
            throw err;
        }
    }

    /**
     * 确保目录存在(递归创建)
     */
    private async ensureDirectoryExists(dir: string): Promise<void> {
        try {
            // 同步检查避免竞态条件
            if (!fsSync.existsSync(dir)) {
                await fs.mkdir(dir, { recursive: true });
                Logger.debug(`[LogWriteManager] 创建目录: ${dir}`);
            }
        } catch (err) {
            // 忽略已存在错误
            if ((err as NodeJS.ErrnoException).code !== 'EEXIST') {
                throw err;
            }
        }
    }

    /**
     * 刷新队列(等待所有待处理任务完成)
     */
    async flush(): Promise<void> {
        // 等待队列清空
        while (this.writeQueue.length > 0 || this.isProcessing) {
            await new Promise(resolve => setTimeout(resolve, 10));
        }
    }

    /**
     * 获取队列状态
     */
    getQueueStatus(): { queueLength: number; isProcessing: boolean } {
        return {
            queueLength: this.writeQueue.length,
            isProcessing: this.isProcessing
        };
    }

    /**
     * 销毁写入管理器
     */
    async dispose(): Promise<void> {
        this.isDisposed = true;

        // 等待队列清空
        await this.flush();

        Logger.info('[LogWriteManager] 写入管理器已销毁');
    }
}
