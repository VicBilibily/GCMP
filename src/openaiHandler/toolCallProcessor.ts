/*---------------------------------------------------------------------------------------------
 *  工具调用处理器
 *  负责累积和处理流式工具调用数据
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { Logger } from '../utils';
import { StreamToolCall } from './types';

/**
 * 工具调用处理器类
 * 专门处理流式工具调用的累积和完成
 */
export class ToolCallProcessor {
    private toolCallsBuffer = new Map<number, Partial<StreamToolCall>>();

    constructor(
        private readonly modelName: string
    ) { }

    /**
     * 处理工具调用块 - 仅做累积，不做立即处理
     */
    processToolCallChunk(toolCall: StreamToolCall): void {
        const index = toolCall.index;
        const bufferedCall = this.toolCallsBuffer.get(index) || {};

        // 累积流式数据
        if (toolCall.id) {
            bufferedCall.id = toolCall.id;
        }
        if (toolCall.type) {
            bufferedCall.type = toolCall.type;
        }
        if (toolCall.function) {
            if (!bufferedCall.function) {
                bufferedCall.function = {};
            }
            if (toolCall.function.name) {
                bufferedCall.function.name = toolCall.function.name;
            }
            if (toolCall.function.arguments) {
                bufferedCall.function.arguments = (bufferedCall.function.arguments || '') + toolCall.function.arguments;
            }
        }

        this.toolCallsBuffer.set(index, bufferedCall);
    }

    /**
     * 处理缓存中的工具调用 - 在流结束时调用
     */
    processBufferedToolCalls(
        progress: vscode.Progress<vscode.LanguageModelResponsePart>,
        token: vscode.CancellationToken
    ): boolean {
        let hasProcessed = false;
        const processedCalls: string[] = [];
        const failedCalls: string[] = [];

        for (const [toolIndex, bufferedTool] of this.toolCallsBuffer.entries()) {
            // 在处理每个工具调用前检查取消状态
            if (token.isCancellationRequested) {
                Logger.warn(`${this.modelName} 工具调用处理被取消，剩余 ${this.toolCallsBuffer.size - processedCalls.length} 个调用未处理`);
                break;
            }

            if (bufferedTool.function?.name && bufferedTool.function?.arguments) {
                try {
                    const args = JSON.parse(bufferedTool.function.arguments);
                    const toolCallId = bufferedTool.id || `tool_${Date.now()}_${toolIndex}`;

                    // 在报告进度前再次检查取消状态
                    if (token.isCancellationRequested) {
                        Logger.warn(`${this.modelName} 工具调用报告时被取消: ${bufferedTool.function.name}(${toolCallId})`);
                        break;
                    }

                    progress.report(
                        new vscode.LanguageModelToolCallPart(
                            toolCallId,
                            bufferedTool.function.name,
                            args
                        )
                    );

                    processedCalls.push(`${bufferedTool.function.name}(${toolCallId})`);
                    hasProcessed = true;
                } catch {
                    const toolName = bufferedTool.function?.name || 'unknown';
                    const callId = bufferedTool.id || `index_${toolIndex}`;
                    failedCalls.push(`${toolName}(${callId})`);

                    // 使用空对象作为后备
                    if (bufferedTool.id && bufferedTool.function?.name) {
                        // 在报告进度前检查取消状态
                        if (token.isCancellationRequested) {
                            Logger.warn(`${this.modelName} 工具调用后备报告时被取消: ${bufferedTool.function.name}(${bufferedTool.id})`);
                            break;
                        }

                        progress.report(new vscode.LanguageModelToolCallPart(
                            bufferedTool.id,
                            bufferedTool.function.name,
                            {}
                        ));
                        hasProcessed = true;
                    }
                }
            } else {
                const toolName = bufferedTool.function?.name || 'unknown';
                const argsLength = bufferedTool.function?.arguments?.length || 0;
                failedCalls.push(`${toolName}(incomplete, args_length=${argsLength})`);
            }
        }

        // 组合完毕后输出详细调试信息
        if (processedCalls.length > 0) {
            const successStats = this.getToolCallStats();
            Logger.info(`✅ ${this.modelName} 成功处理工具调用: ${processedCalls.join(', ')}`);
            Logger.trace(`📈 ${this.modelName} 工具调用统计: ${successStats}`);
        }
        if (failedCalls.length > 0) {
            Logger.warn(`❌ ${this.modelName} 工具调用处理失败: ${failedCalls.join(', ')}`);
        }

        // 如果被取消，记录未处理的调用
        if (token.isCancellationRequested && this.toolCallsBuffer.size > processedCalls.length) {
            const unprocessedCount = this.toolCallsBuffer.size - processedCalls.length;
            Logger.warn(`⚠️ ${this.modelName} 由于取消，${unprocessedCount} 个工具调用未处理`);
        }

        // 清理已处理的缓存
        this.toolCallsBuffer.clear();

        return hasProcessed;
    }

    /**
     * 检查是否有待处理的工具调用
     */
    hasPendingToolCalls(): boolean {
        return this.toolCallsBuffer.size > 0;
    }

    /**
     * 获取待处理工具调用的数量
     */
    getPendingCount(): number {
        return this.toolCallsBuffer.size;
    }

    /**
     * 清理所有缓存
     */
    clear(): void {
        this.toolCallsBuffer.clear();
    }

    /**
     * 获取工具调用统计信息
     */
    private getToolCallStats(): string {
        const bufferEntries = Array.from(this.toolCallsBuffer.entries());
        const totalArguments = bufferEntries.reduce((sum, [, tool]) => {
            return sum + (tool.function?.arguments?.length || 0);
        }, 0);

        const toolNames = bufferEntries.map(([, tool]) => tool.function?.name || 'unknown');
        const uniqueTools = new Set(toolNames).size;

        return `${bufferEntries.length}个调用, ${uniqueTools}种工具, ${totalArguments}字符参数`;
    }
}