/*---------------------------------------------------------------------------------------------
 *  重试管理器
 *  提供累加延迟重试机制，专门处理可重试的限流错误
 *--------------------------------------------------------------------------------------------*/

import { Logger } from './logger';
import { t } from './l10n';

/**
 * 重试配置接口
 */
export interface RetryConfig {
    enabled: boolean;
    maxAttempts: number;
    initialDelayMs: number;
    maxDelayMs: number;
}

/**
 * 错误类型定义
 */
export type RetryableError = Error & {
    status?: number;
    statusCode?: number;
    code?: string | number;
    message?: string;
};

/**
 * 默认重试配置
 */
const DEFAULT_RETRY_CONFIG: RetryConfig = {
    enabled: true,
    maxAttempts: 3,
    initialDelayMs: 1000,
    maxDelayMs: 30000
};

/**
 * 重试管理器类
 * 提供递增累加延迟重试机制
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

        // 首次请求
        Logger.trace(`[${providerName}] Starting initial request`);
        try {
            const result = await operation();
            return result;
        } catch (error) {
            lastError = error as RetryableError;
            // 如果首次请求就失败且不可重试，直接抛出
            if (!isRetryable(lastError)) {
                Logger.warn(`[${providerName}] Initial request failed: ${lastError.message}`);
                throw lastError;
            }
            Logger.warn(`[${providerName}] Initial request failed: ${lastError.message}`);

            // 如果重试已禁用，可重试错误也直接抛出，不进入重试流程
            if (!this.config.enabled) {
                Logger.warn(`[${providerName}] Initial request failed (retry disabled): ${lastError.message}`);
                throw lastError;
            }

            Logger.warn(`[${providerName}] Initial request failed, starting retry flow: ${lastError.message}`);
        }

        // 重试循环
        while (attempt < this.config.maxAttempts) {
            attempt++;

            // 计算延迟时间
            const actualDelayMs = this.calculateDelayMs(attempt);
            Logger.info(`[${providerName}] Retrying in ${actualDelayMs / 1000}s...`);

            // 等待延迟时间
            await this.delay(actualDelayMs);

            // 执行重试
            Logger.info(`[${providerName}] Retry attempt #${attempt}/${this.config.maxAttempts}`);
            try {
                const result = await operation();
                Logger.info(`[${providerName}] Retry succeeded after attempt ${attempt}`);
                return result;
            } catch (error) {
                lastError = error as RetryableError;

                // 如果不是可重试的错误，直接抛出
                if (!isRetryable(lastError)) {
                    Logger.warn(`[${providerName}] Retry attempt ${attempt} failed: ${lastError.message}`);
                    throw lastError;
                }

                Logger.warn(
                    `[${providerName}] Retry attempt ${attempt} failed, preparing the next retry: ${lastError.message}`
                );
            }
        }

        // 所有重试都失败，抛出最后一个错误
        if (lastError) {
            Logger.error(`[${providerName}] All retry attempts failed: ${lastError.message}`);
            throw lastError;
        } else {
            throw new Error(t('[{0}] Unknown error', '[{0}] 未知错误', providerName));
        }
    }

    /**
     * 判断是否是 429 错误
     * @param error 错误对象
     * @returns 是否是 429 错误
     */
    static isRateLimitError(error: RetryableError, deep = 0): boolean {
        // 检查 OpenAI 错误对象
        if ('status' in error && (error.status === 429 || error.status === 529)) {
            return true;
        }
        // 检查是否有 statusCode 属性
        if ('statusCode' in error && (error.statusCode === 429 || error.statusCode === 529)) {
            return true;
        }

        if (error.message && typeof error.message === 'string') {
            // 检查错误消息中是否包含 429/529 字样
            if (error.message.includes('429') || error.message.includes('529')) {
                return true;
            }
            // 一些提供商可能在错误消息中包含特定的速率限制提示
            if (
                error.message.toLowerCase().includes('rate limit') ||
                error.message.toLowerCase().includes('limit exceeded') ||
                error.message.includes('请求过于频繁')
            ) {
                return true;
            }
            // 某些提供商可能使用“temporarily overloaded”或“访问量过大”等提示来表示服务器过载，也可以视为需要重试的情况
            if (
                error.message.toLowerCase().includes('temporarily overloaded') ||
                error.message.includes('访问量过大')
            ) {
                return true;
            }
        }

        // 检查是否有嵌套的 error 对象
        if (deep <= 3 && 'error' in error && typeof error.error === 'object' && error.error !== null) {
            return this.isRateLimitError(error.error as RetryableError, deep + 1);
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

    /**
     * 计算第 N 次重试前的等待时间
     * 1 -> 1s, 2 -> 3s, 3 -> 6s, 4 -> 10s, 5 -> 15s
     */
    private calculateDelayMs(attempt: number): number {
        const triangularMultiplier = (attempt * (attempt + 1)) / 2;
        return Math.min(this.config.initialDelayMs * triangularMultiplier, this.config.maxDelayMs);
    }
}
