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
