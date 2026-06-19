/*---------------------------------------------------------------------------------------------
 *  文本内容缓冲区
 *  累积文本增量，达到阈值后批量输出 LanguageModelTextPart
 *
 * 实现流程：
 * 1. append(content) 将文本追加到内部 buffer，并标记 hasReceivedDelta = true
 * 2. shouldFlush() 判断 buffer 长度是否达到 TEXT_BUFFER_LENGTH（20 字符）
 * 3. 达到阈值后由 StreamReporter 调用 flush()，构造 LanguageModelTextPart 输出，并清空 buffer
 * 4. 未达阈值的内容保留在 buffer 中，等待后续 append 或 StreamReporter.flushText 手动 flush
 */

import * as vscode from 'vscode';

/** 文本内容缓冲阈值（字符数） */
const TEXT_BUFFER_LENGTH = 20;

export class TextBuffer {
    private buffer = '';
    private hasReceivedDelta = false;

    append(content: string): void {
        this.buffer += content;
        this.hasReceivedDelta = true;
    }

    shouldFlush(): boolean {
        return this.buffer.length >= TEXT_BUFFER_LENGTH;
    }

    flush(): vscode.LanguageModelTextPart | null {
        if (this.buffer.length === 0) {
            return null;
        }
        const part = new vscode.LanguageModelTextPart(this.buffer);
        this.buffer = '';
        return part;
    }

    get hasContent(): boolean {
        return this.hasReceivedDelta;
    }
}
