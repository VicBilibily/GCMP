import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import test from 'node:test';
import { decodeStatefulMarkerPayload } from './statefulMarkerCodec';
import type { StatefulMarkerContainer } from './statefulMarker';

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
                    readonly kind = 'thinking';

                    constructor(
                        public value: string,
                        public id?: string,
                        public metadata?: Record<string, unknown>
                    ) {}
                },
                LanguageModelTextPart: class {
                    readonly kind = 'text';

                    constructor(public value: string) {}
                },
                LanguageModelDataPart: class {
                    readonly kind = 'data';

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

interface ReportedPart {
    kind: 'thinking' | 'text' | 'data';
    value?: string;
    id?: string;
    metadata?: Record<string, unknown>;
    data?: Uint8Array;
}

async function createReporter() {
    const { StreamReporter } = await getStreamReporterModule();
    const parts: ReportedPart[] = [];
    const reporter = new StreamReporter({
        modelName: 'test-model',
        modelId: 'test-model',
        provider: 'test-provider',
        sdkMode: 'openai-responses',
        progress: {
            report(part: ReportedPart) {
                parts.push(part);
            }
        } as never,
        sessionId: 'session-1',
        requestId: 'request-1',
        requestStartTime: Date.now()
    });
    return { reporter, parts };
}

function assertTaggedOutput(parts: ReportedPart[], message?: string): void {
    const visibleParts = parts.filter(part => part.kind !== 'data');
    const thinkingParts = visibleParts.filter(part => part.kind === 'thinking');
    const thinkingContent = thinkingParts
        .filter(part => part.value)
        .map(part => part.value)
        .join('');
    const textContent = visibleParts
        .filter(part => part.kind === 'text')
        .map(part => part.value)
        .join('');

    assert.equal(thinkingContent, '推理', message);
    assert.equal(textContent, '答案', message);
    assert.equal(thinkingParts.filter(part => part.value === '').length, 1, message);
    const endIndex = visibleParts.findIndex(part => part.kind === 'thinking' && part.value === '');
    assert.ok(
        visibleParts.slice(0, endIndex).every(part => part.kind === 'thinking' && part.value),
        message
    );
    assert.ok(
        visibleParts.slice(endIndex + 1).every(part => part.kind === 'text'),
        message
    );
    assert.ok(
        visibleParts.every(part => !part.value?.includes('<thinking>') && !part.value?.includes('</thinking>')),
        message
    );
}

test('reportEncryptedThinking：多段摘要直接拼接', async () => {
    const { reporter, parts } = await createReporter();

    reporter.reportEncryptedThinking('cipher-text', 'rsn_1', ['摘要A', '摘要B']);

    assert.equal(parts.length, 1);
    const thinkingPart = parts[0] as { value: string; metadata?: Record<string, unknown> };
    assert.equal(thinkingPart.value, '摘要A摘要B');
    assert.deepEqual(thinkingPart.metadata, {
        redactedData: 'cipher-text',
        reasoningId: 'rsn_1'
    });
});

test('reportText：将开头的 thinking 标签块转为思考过程', async () => {
    const { reporter, parts } = await createReporter();

    reporter.reportText('<thinking>推理</thinking>答案');

    assertTaggedOutput(parts);
    const visibleParts = parts.filter(part => part.kind !== 'data');
    assert.deepEqual(
        visibleParts.map(part => [part.kind, part.value]),
        [
            ['thinking', '推理'],
            ['thinking', ''],
            ['text', '答案']
        ]
    );
    assert.equal(visibleParts[0].id, visibleParts[1].id);

    reporter.flushAll(null);
    const markerPart = parts.find(part => part.kind === 'data');
    assert.ok(markerPart?.data);
    const marker = decodeStatefulMarkerPayload<StatefulMarkerContainer>(markerPart.data);
    assert.equal(marker?.marker.completeThinking, '推理');
});

test('reportText：thinking 标签可在任意字符边界分片', async () => {
    const content = '<thinking>推理</thinking>答案';

    for (let split = 1; split < content.length; split++) {
        const { reporter, parts } = await createReporter();
        reporter.reportText(content.slice(0, split));
        reporter.reportText(content.slice(split));
        assertTaggedOutput(parts, `split=${split}`);
        reporter.flushAll(null);
        const markerPart = parts.find(part => part.kind === 'data');
        assert.ok(markerPart?.data, `split=${split}`);
        const marker = decodeStatefulMarkerPayload<StatefulMarkerContainer>(markerPart.data);
        assert.equal(marker?.marker.completeThinking, '推理', `split=${split}`);
    }

    const { reporter, parts } = await createReporter();
    for (const character of content) {
        reporter.reportText(character);
    }
    assertTaggedOutput(parts, '逐字符分片');
});

test('reportText：忽略 thinking 标签前跨分片的空白和 BOM', async () => {
    const { reporter, parts } = await createReporter();

    reporter.reportText('\uFEFF\n  <thin');
    reporter.reportText('king>推理</thinking>答案');

    assertTaggedOutput(parts);
});

test('reportText：空 thinking 标签不产生空思考链', async () => {
    const { reporter, parts } = await createReporter();

    reporter.reportText('<thinking></thinking>答案');

    assert.deepEqual(
        parts.map(part => [part.kind, part.value]),
        [['text', '答案']]
    );
});

test('flushAll：未闭合的 thinking 标签保留已收到的思考内容', async () => {
    const { reporter, parts } = await createReporter();

    reporter.reportText('<thin');
    reporter.reportText('king>推理');
    const hasContent = reporter.flushAll(null);

    assert.equal(hasContent, true);
    const thinkingParts = parts.filter(part => part.kind === 'thinking');
    assert.equal(
        thinkingParts
            .filter(part => part.value)
            .map(part => part.value)
            .join(''),
        '推理'
    );
    assert.equal(thinkingParts.filter(part => part.value === '').length, 1);
});

test('reportText：结构化结束事件不会导致 closing tag 泄漏', async () => {
    const { reporter, parts } = await createReporter();

    reporter.reportText('<thinking>推理');
    reporter.endThinkingChain();
    reporter.reportText('</thinking>答案');

    assertTaggedOutput(parts);
});

test('flushAll：未闭合的 thinking 标签先输出签名再结束思考链', async () => {
    const { reporter, parts } = await createReporter();

    reporter.reportText('<thinking>推理');
    reporter.bufferSignature('signature');
    reporter.flushAll(null);

    const visibleParts = parts.filter(part => part.kind !== 'data');
    assert.deepEqual(
        visibleParts.map(part => [part.kind, part.value, part.metadata]),
        [
            ['thinking', '推理', undefined],
            ['thinking', '', { signature: 'signature' }],
            ['thinking', '', undefined]
        ]
    );
    assert.ok(visibleParts.every(part => part.id === visibleParts[0].id));
});

test('flushAll：不完整的开始标签按普通文本保留', async () => {
    const { reporter, parts } = await createReporter();

    reporter.reportText('<think');
    reporter.flushAll(null);

    assert.deepEqual(
        parts.filter(part => part.kind !== 'data').map(part => [part.kind, part.value]),
        [['text', '<think']]
    );
});

test('reportText：普通文本和非协议标签保持原样', async () => {
    const inputs = [
        '普通正文',
        '  普通正文',
        '前言<thinking>示例</thinking>答案',
        '<Thinking>示例</Thinking>答案',
        '<thinking type="hidden">示例</thinking>答案'
    ];

    for (const input of inputs) {
        const { reporter, parts } = await createReporter();
        reporter.reportText(input);
        assert.deepEqual(
            parts.map(part => [part.kind, part.value]),
            [['text', input]]
        );
    }
});
