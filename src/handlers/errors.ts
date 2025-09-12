/*---------------------------------------------------------------------------------------------
 *  OpenAI Handler 错误类型定义
 *  集中管理所有错误类型和错误处理逻辑
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { Logger } from '../utils';

/**
 * API响应错误类型
 */
export class OpenAIResponseError extends Error {
    constructor(
        message: string,
        public readonly statusCode?: number,
        public readonly errorCode?: string,
        public readonly retryable = false
    ) {
        super(message);
        this.name = 'OpenAIResponseError';
    }
}

/**
 * 错误处理器类 - 简化版本，专注于标准API错误
 */
export class ErrorHandler {
    constructor(
        private readonly provider: string,
        private readonly displayName: string
    ) { }

    /**
     * 简化的错误处理 - 基于官方SDK的标准错误处理
     */
    handleError(
        error: unknown,
        model: vscode.LanguageModelChatInformation,
        progress: vscode.Progress<vscode.LanguageModelTextPart | vscode.LanguageModelToolCallPart>
    ): void {
        let errorMessage = `[${model.name}] ${this.displayName} API调用失败`;

        if (error instanceof OpenAIResponseError) {
            errorMessage = `[${model.name}] API响应错误`;
            if (error.statusCode) {
                errorMessage += ` (${error.statusCode})`;
            }
            if (error.errorCode) {
                errorMessage += ` [${error.errorCode}]`;
            }
            errorMessage += `: ${error.message}`;

            Logger.error(errorMessage, {
                statusCode: error.statusCode,
                errorCode: error.errorCode,
                retryable: error.retryable
            });
        } else if (error instanceof Error) {
            // 分析OpenAI SDK错误
            const openaiError = error as Error & {
                status?: number;
                code?: string;
                type?: string;
            };

            if (openaiError.status) {
                // OpenAI SDK标准错误
                const status = openaiError.status;
                const code = openaiError.code || openaiError.type;

                errorMessage = `[${model.name}] ${this.displayName} API错误 (${status})`;
                if (code) {
                    errorMessage += ` [${code}]`;
                }
                errorMessage += `: ${error.message}`;

                Logger.error(errorMessage, {
                    modelId: model.id,
                    provider: this.provider,
                    statusCode: status,
                    errorCode: code
                });
            } else {
                // 通用错误
                errorMessage += `: ${error.message}`;
                Logger.error(errorMessage, {
                    modelId: model.id,
                    provider: this.provider,
                    errorName: error.name
                });
            }
        } else {
            errorMessage += `: ${String(error)}`;
            Logger.error(`${this.displayName} 未知错误类型`, {
                modelId: model.id,
                provider: this.provider,
                error: String(error)
            });
        }

        progress.report(new vscode.LanguageModelTextPart(errorMessage));
    }

    /**
     * 创建标准的OpenAI响应错误
     */
    static createOpenAIError(error: unknown): Error {
        if (error instanceof Error) {
            return error;
        }
        return new Error(String(error));
    }
}
