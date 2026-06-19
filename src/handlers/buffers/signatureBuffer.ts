/*---------------------------------------------------------------------------------------------
 *  Anthropic 签名缓冲区
 *  累积 thinking signature，用于 StatefulMarker 持久化和 metadata 输出
 *
 * 实现流程：
 * 1. append(content) 将 signature 分片同时追加到 buffer 和 completeBuffer
 * 2. 外部调用 hasPending 判断是否有未输出的 signature
 * 3. StreamReporter.flushSignature() 调用 take() 取出完整 signature 并清空 buffer，
 *    随后构造"空文本 + signature"的 LanguageModelThinkingPart 输出
 * 4. completeContent 保存完整签名，供 StatefulMarker 持久化使用
 *--------------------------------------------------------------------------------------------*/

export class SignatureBuffer {
    private buffer = '';
    private completeBuffer = '';

    append(content: string): void {
        this.buffer += content;
        this.completeBuffer += content;
    }

    take(): string {
        const value = this.buffer;
        this.buffer = '';
        return value;
    }

    get hasPending(): boolean {
        return this.buffer.length > 0;
    }

    get completeContent(): string {
        return this.completeBuffer;
    }
}
