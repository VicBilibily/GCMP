import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import test from 'node:test';

const require = createRequire(import.meta.url);
const NodeModule = require('node:module') as {
    prototype: {
        require: (id: string) => unknown;
    };
};

let bufferModulePromise: Promise<{ ThinkingBuffer: typeof import('./thinkingBuffer').ThinkingBuffer }> | undefined;

async function getBufferModule() {
    if (bufferModulePromise) {
        return bufferModulePromise;
    }

    const originalRequire = NodeModule.prototype.require;
    NodeModule.prototype.require = function (id: string): unknown {
        if (id === 'vscode') {
            return {
                LanguageModelThinkingPart: class {
                    constructor(
                        public value: string | string[],
                        public id?: string,
                        public metadata?: Record<string, unknown>
                    ) {}
                }
            };
        }
        return originalRequire.call(this, id);
    };

    bufferModulePromise = import('./thinkingBuffer').finally(() => {
        NodeModule.prototype.require = originalRequire;
    });

    return bufferModulePromise;
}

test('appendComplete：空缓冲首次调用不加前导换行', async () => {
    const { ThinkingBuffer } = await getBufferModule();
    const buffer = new ThinkingBuffer();

    buffer.appendComplete('摘要A');

    assert.equal(buffer.completeContent, '摘要A');
});

test('appendComplete：多段摘要直接拼接（对齐 Copilot 默认行为）', async () => {
    const { ThinkingBuffer } = await getBufferModule();
    const buffer = new ThinkingBuffer();

    buffer.appendComplete('摘要A');
    buffer.appendComplete('摘要B');

    assert.equal(buffer.completeContent, '摘要A摘要B');
});

test('appendComplete：与流式链直接衔接', async () => {
    const { ThinkingBuffer } = await getBufferModule();
    const buffer = new ThinkingBuffer();

    buffer.append('流式思考');
    buffer.endChain();
    buffer.appendComplete('占位摘要');
    buffer.append('后续思考');

    assert.equal(buffer.completeContent, '流式思考占位摘要后续思考');
});

test('appendComplete：空内容不产生任何变化', async () => {
    const { ThinkingBuffer } = await getBufferModule();
    const buffer = new ThinkingBuffer();

    buffer.appendComplete('');
    buffer.append('内容');

    assert.equal(buffer.completeContent, '内容');
});
