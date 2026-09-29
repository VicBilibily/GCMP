import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import test from 'node:test';
import type { LiveStreamMetricEvent } from './liveMetrics';
import { UsageParser } from '../usages/fileLogger/usageParser';

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

test('Gemini thought signature 元数据不计入实际输出时间', async () => {
    const { StreamReporter } = await getStreamReporterModule();
    const events: Array<{ type: string; firstOutputTime?: number; lastOutputTime?: number }> = [];
    const reporter = new StreamReporter({
        modelName: 'gemini-test',
        modelId: 'gemini-test',
        provider: 'test-provider',
        sdkMode: 'gemini',
        progress: {
            report() {}
        } as never,
        sessionId: 'session-1',
        requestId: 'request-1',
        requestStartTime: 1000,
        onLiveMetrics: event => events.push(event)
    });

    reporter.markStreamStarted(1200);
    reporter.setThoughtSignature('signature-only');
    reporter.flushAll(null);

    const finalUpdate = events.filter(event => event.type === 'streamingUpdate').at(-1);
    assert.equal(finalUpdate?.firstOutputTime, undefined);
    assert.equal(finalUpdate?.lastOutputTime, undefined);
});

for (const thinking of ['none', 'text', 'encrypted', 'redacted'] as const) {
    test(`正文时间独立记录，平均速度沿用全部输出和流耗时：${thinking}`, async () => {
        const { StreamReporter } = await getStreamReporterModule();
        const events: LiveStreamMetricEvent[] = [];
        const originalNow = Date.now;
        let now = 1200;
        Date.now = () => now;
        try {
            const reporter = new StreamReporter({
                modelName: 'test',
                modelId: 'test',
                provider: 'test',
                sdkMode: 'gemini',
                requestId: 'timing-test',
                requestStartTime: 1000,
                progress: { report() {} },
                onLiveMetrics: event => events.push(event)
            });
            const reportThinking = () => {
                if (thinking === 'text') {
                    reporter.bufferThinking('reasoning');
                }
                if (thinking === 'encrypted') {
                    reporter.reportEncryptedThinking('cipher');
                }
                if (thinking === 'redacted') {
                    reporter.reportRedactedThinking('cipher');
                }
            };
            reportThinking();
            now = 11200;
            reporter.reportText('first');
            now = 12200;
            reporter.reportText('last');
            now = 14000;
            reportThinking();
            reporter.finishMetrics();
            const update = events.filter(event => event.type === 'streamingUpdate').at(-1);
            assert.ok(update);
            assert.equal(update.firstOutputTime, thinking === 'none' ? 11200 : 1200);
            assert.equal(update.lastOutputTime, thinking === 'none' ? 12200 : 14000);
            assert.equal(update.firstContentOutputTime, 11200);
            assert.equal(update.lastContentOutputTime, 12200);
            const parsed = UsageParser.parseFromLog({
                ...update,
                streamEndTime: now,
                timestamp: 1000,
                isoTime: new Date(1000).toISOString(),
                requestMetricStartTime: 1000,
                providerKey: 'test',
                modelId: 'test',
                estimatedInput: 1,
                status: 'completed',
                rawUsage: { promptTokenCount: 1, candidatesTokenCount: 11, thoughtsTokenCount: 100 }
            });
            const duration = thinking === 'none' ? 1000 : 12800;
            assert.equal(parsed.timePerOutputToken, duration / 111);
            assert.equal(parsed.outputSpeed, (111 / duration) * 1000);
            assert.equal(parsed.firstTokenLatency, thinking === 'none' ? 10200 : 200);
        } finally {
            Date.now = originalNow;
        }
    });
}

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
