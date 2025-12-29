/*---------------------------------------------------------------------------------------------
 *  日志写入管理器
 *  带写入锁机制,保证每行日志的完整性
 *  使用队列 + 异步锁实现互斥写入
 *--------------------------------------------------------------------------------------------*/

import * as fs from 'fs/promises';
import { StatusLogger } from '../../utils/statusLogger';
import { LogPathManager } from './logPathManager';
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
            // 确保日期文件夹存在（使用 PathManager 统一的方法）
            await this.pathManager.ensureDirectoryExists(logPath.dateFolder);

            // 将日志对象转换为JSONL格式(一行一个JSON)
            // 每次调用都追加新行,同一requestId可能有多条记录(预估→完成/失败)
            const line = JSON.stringify(log) + '\n';

            // 追加到文件(使用 appendFile 自动处理并发)
            await fs.appendFile(logPath.fullPath, line, 'utf-8');

            StatusLogger.debug(
                `[LogWriteManager] 写入流水日志: ${logPath.fullPath} (${log.requestId}, status=${log.status})`
            );
        } catch (err) {
            StatusLogger.error(`[LogWriteManager] 写入日志失败: ${logPath.fullPath}`, err);
            throw err;
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
        try {
            StatusLogger.debug('[LogWriteManager] 开始销毁写入管理器...');

            // 标记为已销毁，阻止新的写入请求
            this.isDisposed = true;

            // 等待队列清空
            const queueStatus = this.getQueueStatus();
            if (queueStatus.queueLength > 0) {
                StatusLogger.warn(
                    `[LogWriteManager] 销毁时发现 ${queueStatus.queueLength} 个待处理的写入任务，正在等待完成...`
                );
            }

            // 刷新队列中的所有任务
            await this.flush();

            StatusLogger.debug('[LogWriteManager] 写入管理器已销毁');
        } catch (error) {
            StatusLogger.error('[LogWriteManager] 销毁写入管理器时出错:', error);
            throw error;
        }
    }
}
