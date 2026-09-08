/*---------------------------------------------------------------------------------------------
 *  工具调用累积器
 *  累积流式工具调用分片，在结束时输出 CompletedToolCall
 *
 * 实现流程：
 * 1. accumulate(index, id, name, argsFragment) 接收单个工具调用的增量分片
 *    - 若 id/name/argsFragment 全为空则忽略，返回 { isNew: false }
 *    - 首次为某 index 创建 buffer 时返回 isNew = true，StreamReporter 据此执行
 *      endThinkingChain 清理逻辑
 *    - 将 id/name 更新到 buffer，argsFragment 经 mergeArguments 合并到 buffer.arguments
 *      （合并策略：优先保留追加形式，遇到快照形式则替换，避免服务端重发导致重复）
 * 2. 参数可解析不代表调用结束，等待 flushAll。
 * 3. flushAll() 在流结束时被调用，强制输出所有未完成的工具调用：
 *    - 能解析的完整 tool call 直接输出
 *    - 不完整的 tool call 记录警告日志
 *    - 最后清空 buffer
 */

import * as crypto from 'node:crypto';
import { Logger } from '../../utils/runtime/logger';

interface ToolCallBuffer {
    choiceIndex: number;
    id?: string;
    name?: string;
    arguments: string;
}

export interface CompletedToolCall {
    toolCallId: string;
    name: string;
    args: Record<string, unknown>;
}

/** accumulate 方法的返回结果 */
export interface AccumulateResult {
    /** 是否为该 index 首次创建工具调用 buffer */
    isNew: boolean;
}

export class ToolCallAccumulator {
    private readonly buffer = new Map<string, ToolCallBuffer>();
    private readonly completedIndices = new Set<string>();

    isCompleted(index: number, choiceIndex = 0): boolean {
        return this.completedIndices.has(`${choiceIndex}:${index}`);
    }

    accumulate(
        index: number,
        id: string | undefined,
        name: string | undefined,
        argsFragment: string | undefined,
        choiceIndex = 0
    ): AccumulateResult {
        // 跳过空值，不创建无效的工具调用缓存
        if (this.isCompleted(index, choiceIndex) || (!id && !name && !argsFragment)) {
            return { isNew: false };
        }

        // 获取或创建工具调用缓存
        let isNew = false;
        const key = `${choiceIndex}:${index}`;
        let tool = this.buffer.get(key);
        if (!tool) {
            tool = { arguments: '', choiceIndex };
            this.buffer.set(key, tool);
            isNew = true;
        }

        if (id) {
            tool.id = id;
        }
        if (name) {
            tool.name = name;
        }
        if (argsFragment) {
            tool.arguments = this.mergeArguments(tool.arguments, argsFragment);
        }

        return { isNew };
    }

    private mergeArguments(existing: string, newArgs: string): string {
        if (!existing) {
            return newArgs;
        }
        if (newArgs === existing) {
            return existing;
        }
        if (newArgs.length > existing.length && newArgs.startsWith(existing)) {
            return newArgs;
        }
        return existing + newArgs;
    }

    discard(choiceIndex?: number): void {
        for (const [key, tool] of this.buffer) {
            if (choiceIndex === undefined || tool.choiceIndex === choiceIndex) {
                this.completedIndices.add(key);
                this.buffer.delete(key);
            }
        }
    }

    flushAll(choiceIndex?: number): CompletedToolCall[] {
        const result: CompletedToolCall[] = [];
        for (const [index, tool] of this.buffer.entries()) {
            if (choiceIndex !== undefined && tool.choiceIndex !== choiceIndex) {
                continue;
            }
            this.completedIndices.add(index);
            this.buffer.delete(index);
            if (tool.name && tool.arguments) {
                try {
                    const args = JSON.parse(tool.arguments);
                    result.push({ toolCallId: tool.id || crypto.randomUUID(), name: tool.name, args });
                } catch (error) {
                    Logger.error(`[ToolCallAccumulator] Failed to parse tool call [${index}]:`, error);
                }
            } else {
                Logger.warn(
                    `[ToolCallAccumulator] Incomplete tool call [${index}]: name=${tool.name}, args_length=${tool.arguments.length}`
                );
            }
        }
        return result;
    }
}
