/*---------------------------------------------------------------------------------------------
 *  重试管理器
 *  提供指数级延迟重试机制，专门处理 429 错误
 *--------------------------------------------------------------------------------------------*/

import { Logger } from './logger';

/**
 * 重试配置接口
 */
export interface RetryConfig {
    maxAttempts: number;
    initialDelayMs: number;
    maxDelayMs: number;
    backoffMultiplier: number;
    jitterEnabled: boolean;
}

/**
 * 错误类型定义
 */
export type RetryableError = Error & {
    status?: number;
    statusCode?: number;
    message: string;
};

/**
 * 默认重试配置
 */
const DEFAULT_RETRY_CONFIG: RetryConfig = {
    maxAttempts: 3,
    initialDelayMs: 1000,
    maxDelayMs: 30000,
    backoffMultiplier: 2,
    jitterEnabled: true
};

/**
 * 重试管理器类
 * 提供指数级延迟重试机制
 */
export class RetryManager {
    private config: RetryConfig;

    constructor(config?: Partial<RetryConfig>) {
        this.config = { ...DEFAULT_RETRY_CONFIG, ...config };
    }

    /**
     * 执行带有重试机制的操作
     * @param operation 要执行的操作函数
     * @param isRetryable 判断是否可以重试的函数
     * @param providerName 提供商名称（用于日志）
     * @returns 操作结果
     */
    async executeWithRetry<T>(
        operation: () => Promise<T>,
        isRetryable: (error: RetryableError) => boolean,
        providerName: string
    ): Promise<T> {
        let lastError: RetryableError | undefined;
        let attempt = 0;
        let delayMs = this.config.initialDelayMs;

        // 首次请求
        Logger.trace(`[${providerName}] 开始首次请求`);
        try {
            const result = await operation();
            return result;
        } catch (error) {
            lastError = error as RetryableError;
            // 如果首次请求就失败且不可重试，直接抛出
            if (!isRetryable(lastError)) {
                Logger.warn(`[${providerName}] 首次请求失败: ${lastError.message}`);
                throw lastError;
            }
            Logger.warn(`[${providerName}] 首次请求失败，开始重试机制: ${lastError.message}`);
        }

        // 重试循环
        while (attempt < this.config.maxAttempts) {
            attempt++;

            // 计算延迟时间
            const jitter = this.config.jitterEnabled ? Math.random() * 0.1 : 0;
            const actualDelayMs = Math.min(delayMs * (1 + jitter), this.config.maxDelayMs);
            Logger.info(`[${providerName}] ${actualDelayMs / 1000}秒后重试...`);

            // 等待延迟时间
            await this.delay(actualDelayMs);

            // 执行重试
            Logger.info(`[${providerName}] 重试尝试 #${attempt}/${this.config.maxAttempts}`);
            try {
                const result = await operation();
                Logger.info(`[${providerName}] 重试成功！在第 ${attempt} 次重试后`);
                return result;
            } catch (error) {
                lastError = error as RetryableError;

                // 如果不是可重试的错误，直接抛出
                if (!isRetryable(lastError)) {
                    Logger.warn(`[${providerName}] 第 ${attempt} 次重试失败: ${lastError.message}`);
                    throw lastError;
                }

                Logger.warn(`[${providerName}] 第 ${attempt} 次重试失败，准备下一次重试: ${lastError.message}`);

                // 指数级增加延迟
                delayMs *= this.config.backoffMultiplier;
            }
        }

        // 所有重试都失败，抛出最后一个错误
        if (lastError) {
            Logger.error(`[${providerName}] 所有重试尝试都失败了: ${lastError.message}`);
            throw lastError;
        } else {
            throw new Error(`[${providerName}] 未知错误`);
        }
    }

    /**
     * 判断是否是 429 错误
     * @param error 错误对象
     * @returns 是否是 429 错误
     */
    static isRateLimitError(error: RetryableError): boolean {
        if (error instanceof Error) {
            // 检查错误消息中是否包含 429
            if (error.message.includes('429')) {
                return true;
            }
            // 检查 OpenAI 错误对象
            if ('status' in error && error.status === 429) {
                return true;
            }
            // 检查是否有 statusCode 属性
            if ('statusCode' in error && error.statusCode === 429) {
                return true;
            }
        }
        return false;
    }

    /**
     * 延迟指定毫秒数
     * @param ms 毫秒数
     * @returns Promise
     */
    private delay(ms: number): Promise<void> {
        return new Promise(resolve => setTimeout(resolve, ms));
    }
}
