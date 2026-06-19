/*---------------------------------------------------------------------------------------------
 *  思考链缓冲区
 *  累积 reasoning/thinking 增量，输出 LanguageModelThinkingPart
 *
 * 实现流程：
 * 1. append(content) 首次调用时生成 thinking id（格式 thinking_${timestamp}_${random}），
 *    将内容追加到 buffer 和 completeBuffer，并标记 hasReceivedDelta = true
 * 2. shouldFlush() 判断 buffer 长度是否达到 THINKING_BUFFER_LENGTH（20 字符）
 * 3. 达到阈值后由 StreamReporter 调用 flush()，构造 LanguageModelThinkingPart 输出，并清空 buffer
 *    （flush 可接收可选 signature，作为该 part 的 metadata）
 * 4. appendIfNotDelta(content) 用于 done 事件：若已接收过 delta 则忽略，避免重复输出
 * 5. endChain() 输出一个空文本的 LanguageModelThinkingPart，用于结束当前思维链，同时重置 currentId
 * 6. buildSignaturePart(signature) 构造"空文本 + signature"的 ThinkingPart，不消费 buffer 内容，
 *    用于 Anthropic 签名输出场景
 * 7. completeContent 保存完整思考内容，供 StatefulMarker 持久化使用
 */

import * as vscode from 'vscode';

/** 思考内容缓冲阈值（字符数） */
const THINKING_BUFFER_LENGTH = 20;

export class ThinkingBuffer {
    private currentId: string | null = null;
    private buffer = '';
    private completeBuffer = '';
    private hasReceivedDelta = false;

    append(content: string): string | null {
        if (!this.currentId) {
            this.currentId = `thinking_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
        }
        this.buffer += content;
        this.completeBuffer += content;
        this.hasReceivedDelta = true;
        return this.currentId;
    }

    appendIfNotDelta(content: string): string | null {
        if (this.hasReceivedDelta) {
            return this.currentId;
        }
        return this.append(content);
    }

    shouldFlush(): boolean {
        return this.buffer.length >= THINKING_BUFFER_LENGTH;
    }

    flush(signature?: string): vscode.LanguageModelThinkingPart | null {
        if (this.buffer.length === 0 || !this.currentId) {
            return null;
        }
        const metadata = signature ? { signature } : undefined;
        const part = new vscode.LanguageModelThinkingPart(this.buffer, this.currentId, metadata);
        this.buffer = '';
        return part;
    }

    endChain(): vscode.LanguageModelThinkingPart | null {
        if (!this.currentId) {
            return null;
        }
        const part = new vscode.LanguageModelThinkingPart('', this.currentId);
        this.currentId = null;
        this.buffer = '';
        return part;
    }

    /**
     * 构造只带 signature metadata 的空 ThinkingPart（不消费 buffer 内容）。
     * 用于 Anthropic 签名输出场景。
     */
    buildSignaturePart(signature: string): vscode.LanguageModelThinkingPart | null {
        if (!this.currentId) {
            return null;
        }
        return new vscode.LanguageModelThinkingPart('', this.currentId, { signature });
    }

    get completeContent(): string {
        return this.completeBuffer;
    }

    get hasContent(): boolean {
        return this.hasReceivedDelta;
    }

    get isActive(): boolean {
        return this.currentId !== null;
    }

    /**
     * 当前思维链 ID（只读访问，供 StreamReporter 构造特殊 part 使用）
     */
    get activeId(): string | null {
        return this.currentId;
    }
}
