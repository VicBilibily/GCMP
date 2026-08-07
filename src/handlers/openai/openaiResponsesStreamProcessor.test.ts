import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import test from 'node:test';

const require = createRequire(import.meta.url);
const NodeModule = require('node:module') as {
    prototype: {
        require: (id: string) => unknown;
    };
};

let processorModulePromise:
    | Promise<{
          OpenAIResponsesStreamProcessor: typeof import('./openaiResponsesStreamProcessor').OpenAIResponsesStreamProcessor;
      }>
    | undefined;

async function getProcessorModule() {
    if (processorModulePromise) {
        return processorModulePromise;
    }

    const originalRequire = NodeModule.prototype.require;
    NodeModule.prototype.require = function (id: string): unknown {
        if (id === 'vscode') {
            return {};
        }
        return originalRequire.call(this, id);
    };

    processorModulePromise = import('./openaiResponsesStreamProcessor').finally(() => {
        NodeModule.prototype.require = originalRequire;
    });

    return processorModulePromise;
}

function createProcessor(
    OpenAIResponsesStreamProcessor: typeof import('./openaiResponsesStreamProcessor').OpenAIResponsesStreamProcessor,
    reporterOverrides: Record<string, unknown> = {},
    options: { token?: unknown; abortController?: AbortController } = {}
) {
    const reported: string[] = [];
    const streamReporter = {
        heartbeat() {},
        markStreamStarted() {},
        reportText(text: string) {
            reported.push(text);
        },
        flushAll() {
            return true;
        },
        ...reporterOverrides
    };
    const processor = new OpenAIResponsesStreamProcessor({
        modelName: 'test-model',
        displayName: 'Test',
        token: (options.token ?? { isCancellationRequested: false }) as never,
        abortController: options.abortController ?? new AbortController(),
        streamReporter: streamReporter as never,
        sessionId: 'session-1'
    });
    processor.attach();
    return { processor, reported };
}

async function* eventsFrom(events: unknown[]) {
    for (const event of events) {
        yield event;
    }
}

test('consume：response.failed 先于 response.created 时抛出服务端真实错误消息', async () => {
    const { OpenAIResponsesStreamProcessor } = await getProcessorModule();
    const { processor } = createProcessor(OpenAIResponsesStreamProcessor);

    const stream = eventsFrom([
        {
            type: 'response.failed',
            response: {
                id: 'resp_1',
                status: 'failed',
                error: {
                    code: 'upstream_error',
                    message: 'Service temporarily unavailable, please retry later.',
                    type: 'server_error'
                }
            }
        }
    ]);

    await assert.rejects(processor.consume(stream as never), (error: unknown) => {
        assert.ok(error instanceof Error);
        assert.equal(error.message, 'Service temporarily unavailable, please retry later.');
        return true;
    });
});

test('consume：response.failed 缺错误消息时使用通用失败提示', async () => {
    const { OpenAIResponsesStreamProcessor } = await getProcessorModule();
    const { processor } = createProcessor(OpenAIResponsesStreamProcessor);

    const stream = eventsFrom([
        {
            type: 'response.failed',
            response: { id: 'resp_1', status: 'failed', error: null }
        }
    ]);

    await assert.rejects(processor.consume(stream as never), (error: unknown) => {
        assert.ok(error instanceof Error);
        assert.ok(error.message.length > 0);
        return true;
    });
});

test('consume：正常事件流完整分发并结束', async () => {
    const { OpenAIResponsesStreamProcessor } = await getProcessorModule();
    const { processor, reported } = createProcessor(OpenAIResponsesStreamProcessor);

    const stream = eventsFrom([
        { type: 'response.created', response: { id: 'resp_1', status: 'in_progress' } },
        {
            type: 'response.output_text.delta',
            item_id: 'msg_1',
            output_index: 0,
            content_index: 0,
            delta: '你好'
        },
        {
            type: 'response.output_text.done',
            item_id: 'msg_1',
            output_index: 0,
            content_index: 0,
            text: '你好'
        },
        {
            type: 'response.completed',
            response: { id: 'resp_1', status: 'completed', output: [], usage: { total_tokens: 10 } }
        }
    ]);

    await processor.consume(stream as never);
    assert.deepEqual(reported, ['你好']);
});

test('consume：用户取消时抛出取消错误而非静默成功', async () => {
    const { OpenAIResponsesStreamProcessor } = await getProcessorModule();
    // SDK 原始流在 abort 时静默结束迭代：空流即模拟该行为，由 token 已取消补偿抛出
    const { processor } = createProcessor(
        OpenAIResponsesStreamProcessor,
        {},
        { token: { isCancellationRequested: true } }
    );

    await assert.rejects(processor.consume(eventsFrom([]) as never), (error: unknown) => {
        assert.ok(error instanceof Error);
        assert.equal(error.constructor.name, 'APIUserAbortError');
        return true;
    });
});

test('consume：response.failed 已记录错误时取消不覆盖原始错误', async () => {
    const { OpenAIResponsesStreamProcessor } = await getProcessorModule();
    const { processor } = createProcessor(
        OpenAIResponsesStreamProcessor,
        {},
        { token: { isCancellationRequested: true } }
    );

    const stream = eventsFrom([
        {
            type: 'response.failed',
            response: {
                id: 'resp_1',
                status: 'failed',
                error: { code: 'upstream_error', message: 'upstream failed', type: 'server_error' }
            }
        }
    ]);

    await assert.rejects(processor.consume(stream as never), (error: unknown) => {
        assert.ok(error instanceof Error);
        assert.equal(error.message, 'upstream failed');
        return true;
    });
});
