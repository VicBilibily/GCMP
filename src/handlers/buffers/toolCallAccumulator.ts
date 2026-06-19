/*---------------------------------------------------------------------------------------------
 *  工具调用累积器
 *  累积流式工具调用分片，检测完整 JSON 后输出 CompletedToolCall
 *
 * 实现流程：
 * 1. accumulate(index, id, name, argsFragment) 接收单个工具调用的增量分片
 *    - 若 id/name/argsFragment 全为空则忽略，返回 { isNew: false, completed: null }
 *    - 首次为某 index 创建 buffer 时返回 isNew = true，StreamReporter 据此执行
 *      flushThinking + flushText + endThinkingChain 清理逻辑
 *    - 将 id/name 更新到 buffer，argsFragment 经 mergeArguments 合并到 buffer.arguments
 *      （合并策略：优先保留追加形式，遇到快照形式则替换，避免服务端重发导致重复）
 * 2. 当 buffer 中同时存在 name 和 arguments 时尝试 JSON.parse：
 *    - 解析成功表示工具调用完成，生成 toolCallId（优先使用 buffer.id，缺失则随机 UUID），
 *      从 buffer 删除该 index，返回 completed
 *    - 解析失败表示参数未完整，返回 completed: null，继续等待下一分片
 * 3. flushAll() 在流结束时被调用，强制输出所有未完成的工具调用：
 *    - 能解析的完整 tool call 直接输出
 *    - 不完整的 tool call 记录警告日志
 *    - 最后清空 buffer
 */

import * as crypto from 'node:crypto';
import { Logger } from '../../utils';

interface ToolCallBuffer {
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
    /** 如果工具调用已完成，则返回完整工具调用；否则为 null */
    completed: CompletedToolCall | null;
}

export class ToolCallAccumulator {
    private readonly buffer = new Map<number, ToolCallBuffer>();

    accumulate(
        index: number,
        id: string | undefined,
        name: string | undefined,
        argsFragment: string | undefined
    ): AccumulateResult {
        // 跳过空值，不创建无效的工具调用缓存
        if (!id && !name && !argsFragment) {
            return { isNew: false, completed: null };
        }

        // 获取或创建工具调用缓存
        let isNew = false;
        let tool = this.buffer.get(index);
        if (!tool) {
            tool = { arguments: '' };
            this.buffer.set(index, tool);
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

        if (!tool.name || !tool.arguments) {
            return { isNew, completed: null };
        }

        try {
            const args = JSON.parse(tool.arguments);
            const toolCallId = tool.id || crypto.randomUUID();
            this.buffer.delete(index);
            return { isNew, completed: { toolCallId, name: tool.name, args } };
        } catch {
            return { isNew, completed: null };
        }
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

    flushAll(): CompletedToolCall[] {
        const result: CompletedToolCall[] = [];
        for (const [index, tool] of this.buffer.entries()) {
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
        this.buffer.clear();
        return result;
    }

    get hasPending(): boolean {
        return this.buffer.size > 0;
    }

    get pendingCount(): number {
        return this.buffer.size;
    }
}
