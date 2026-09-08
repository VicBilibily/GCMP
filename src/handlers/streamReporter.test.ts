import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import test from 'node:test';

const require = createRequire(import.meta.url);
const NodeModule = require('node:module') as {
    prototype: {
        require: (id: string) => unknown;
    };
};

let streamReporterModulePromise:
    | Promise<{
          StreamReporter: typeof import('./streamReporter').StreamReporter;
      }>
    | undefined;

async function getStreamReporterModule() {
    if (streamReporterModulePromise) {
        return streamReporterModulePromise;
    }

    const originalRequire = NodeModule.prototype.require;
    NodeModule.prototype.require = function (id: string): unknown {
        if (id === 'vscode') {
            return {
                LanguageModelTextPart: class {
                    constructor(public value: string) {}
                },
                LanguageModelThinkingPart: class {
                    constructor(
                        public value: string,
                        public id?: string,
                        public metadata?: Record<string, unknown>
                    ) {}
                },
                LanguageModelDataPart: class {
                    constructor(
                        public data: Uint8Array,
                        public mimeType: string
                    ) {}
                },
                LanguageModelToolCallPart: class {
                    constructor(
                        public callId: string,
                        public name: string,
                        public input: unknown
                    ) {}
                }
            };
        }
        return originalRequire.call(this, id);
    };

    streamReporterModulePromise = import('./streamReporter').finally(() => {
        NodeModule.prototype.require = originalRequire;
    });

    return streamReporterModulePromise;
}

test('reportEncryptedThinking：多段摘要直接拼接', async () => {
    const { StreamReporter } = await getStreamReporterModule();
    const parts: unknown[] = [];
    const reporter = new StreamReporter({
        modelName: 'test-model',
        modelId: 'test-model',
        provider: 'test-provider',
        sdkMode: 'openai-responses',
        progress: {
            report(part: unknown) {
                parts.push(part);
            }
        } as never,
        sessionId: 'session-1',
        requestId: 'request-1',
        requestStartTime: Date.now()
    });

    reporter.reportEncryptedThinking('cipher-text', 'rsn_1', ['摘要A', '摘要B']);

    assert.equal(parts.length, 1);
    const thinkingPart = parts[0] as { value: string; metadata?: Record<string, unknown> };
    assert.equal(thinkingPart.value, '摘要A摘要B');
    assert.deepEqual(thinkingPart.metadata, {
        redactedData: 'cipher-text',
        reasoningId: 'rsn_1',
        provider: 'test-provider',
        modelId: 'test-model'
    });
});

test('reportEncryptedThinking：仅思考内容也应被视为有内容', async () => {
    const { StreamReporter } = await getStreamReporterModule();
    const reporter = new StreamReporter({
        modelName: 'test-model',
        modelId: 'test-model',
        provider: 'test-provider',
        sdkMode: 'openai-responses',
        progress: {
            report() {}
        } as never,
        sessionId: 'session-1',
        requestId: 'request-1',
        requestStartTime: Date.now()
    });

    reporter.reportEncryptedThinking('cipher-text', 'rsn_1', ['摘要']);

    assert.equal(reporter.hasContent, true);
    assert.equal(reporter.flushAll(null), true);
});

test('flushToolCalls：choice 完成不清理其他 choice 的同 index 分片', async () => {
    const { StreamReporter } = await getStreamReporterModule();
    const calls: unknown[] = [];
    const reporter = new StreamReporter({
        modelName: 'test',
        modelId: 'test',
        provider: 'test',
        sdkMode: 'openai',
        progress: {
            report(part: unknown) {
                if ('callId' in (part as object)) {
                    calls.push(part);
                }
            }
        }
    });
    reporter.accumulateToolCall(0, 'a', 'read_file', '{}', 0);
    reporter.accumulateToolCall(0, 'b', 'read_file', '{', 1);
    reporter.flushToolCalls(0);
    assert.equal(calls.length, 1);
    reporter.accumulateToolCall(0, undefined, undefined, '}', 1);
    reporter.flushToolCalls(1);
    reporter.flushAll(null);
    assert.deepEqual(
        calls.map(part => (part as { callId: string }).callId),
        ['a', 'b']
    );
});

test('discardToolCalls：失败收尾不提交已完整的工具缓存', async () => {
    const { StreamReporter } = await getStreamReporterModule();
    const calls: unknown[] = [];
    const reporter = new StreamReporter({
        modelName: 'test',
        modelId: 'test',
        provider: 'test',
        sdkMode: 'openai',
        progress: {
            report(part: unknown) {
                if ('callId' in (part as object)) {
                    calls.push(part);
                }
            }
        }
    });
    reporter.reportText('text');
    reporter.accumulateToolCall(0, 'a', 'read_file', '{}');
    reporter.discardToolCalls();
    reporter.flushAll(null);
    assert.deepEqual(calls, []);
});

test('reportToolCall：同一响应内重复工具调用 id 自动改名', async () => {
    const { StreamReporter } = await getStreamReporterModule();
    const parts: unknown[] = [];
    const reporter = new StreamReporter({
        modelName: 'test-model',
        modelId: 'test-model',
        provider: 'test-provider',
        sdkMode: 'anthropic',
        progress: {
            report(part: unknown) {
                parts.push(part);
            }
        } as never,
        sessionId: 'session-1'
    });

    reporter.reportToolCall('call_1', 'read_file', { path: 'a.ts' }, { countArgs: false });
    reporter.reportToolCall('call_1', 'read_file', { path: 'a.ts' }, { countArgs: false });

    assert.deepEqual(
        parts.map(part => (part as { callId: string }).callId),
        ['call_1', 'call_1__gcmpDup2']
    );
});

test('accumulateToolCall：不同 index 携带相同 id 完成时自动改名', async () => {
    const { StreamReporter } = await getStreamReporterModule();
    const parts: unknown[] = [];
    const reporter = new StreamReporter({
        modelName: 'test-model',
        modelId: 'test-model',
        provider: 'test-provider',
        sdkMode: 'openai',
        progress: {
            report(part: unknown) {
                parts.push(part);
            }
        } as never,
        sessionId: 'session-1'
    });

    reporter.accumulateToolCall(0, 'call_1', 'read_file', '{"path":"a.ts"}');
    reporter.accumulateToolCall(1, 'call_1', 'read_file', '{"path":"b.ts"}');

    assert.equal(parts.length, 0);
    reporter.flushAll(null);
    parts.splice(2);

    assert.deepEqual(
        parts.map(part => (part as { callId: string }).callId),
        ['call_1', 'call_1__gcmpDup2']
    );
    assert.deepEqual(
        parts.map(part => (part as { input: unknown }).input),
        [{ path: 'a.ts' }, { path: 'b.ts' }]
    );
});

test('accumulateToolCall：完整 JSON 等待 flush，同 index 完成后重放不再执行', async () => {
    const { StreamReporter } = await getStreamReporterModule();
    const calls: unknown[] = [];
    const reporter = new StreamReporter({
        modelName: 'test',
        modelId: 'test',
        provider: 'test',
        sdkMode: 'openai',
        progress: {
            report(part: unknown) {
                if ('callId' in (part as object)) {
                    calls.push(part);
                }
            }
        }
    });
    reporter.accumulateToolCall(0, 'same', 'read_file', '{}');
    reporter.accumulateToolCall(0, 'same', 'read_file', '{}');
    assert.equal(calls.length, 0);
    reporter.flushAll(null);
    reporter.accumulateToolCall(0, 'same', 'read_file', '{}');
    reporter.flushAll(null);
    assert.equal(calls.length, 1);
    assert.equal(reporter.hasContent, true);
});
