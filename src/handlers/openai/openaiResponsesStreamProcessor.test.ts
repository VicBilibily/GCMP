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
    const flushed: Array<{ finishReason?: unknown; responseId?: string; usage?: unknown }> = [];
    const streamReporter = {
        heartbeat() {},
        markStreamStarted() {},
        reportText(text: string) {
            reported.push(text);
        },
        flushAll(_finishReason: unknown, customStatefulData?: { responseId?: string }, finalUsage?: unknown) {
            flushed.push({
                finishReason: _finishReason,
                responseId: customStatefulData?.responseId,
                usage: finalUsage
            });
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
    return { processor, reported, flushed };
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

test('consume：response.failed 带 usage 时保留终态 usage', async () => {
    const { OpenAIResponsesStreamProcessor } = await getProcessorModule();
    const { processor } = createProcessor(OpenAIResponsesStreamProcessor);
    const usage = { total_tokens: 7 };

    const stream = eventsFrom([
        {
            type: 'response.failed',
            response: {
                id: 'resp_1',
                status: 'failed',
                error: null,
                usage
            }
        }
    ]);

    await assert.rejects(processor.consume(stream as never), (error: unknown) => {
        assert.ok(error instanceof Error);
        return true;
    });
    assert.deepEqual(processor.getFinalUsage(), usage);
    assert.ok(typeof processor.getStreamEndTime() === 'number');
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

test('consume：不同 output_index 的正文之间插入分段', async () => {
    const { OpenAIResponsesStreamProcessor } = await getProcessorModule();
    const { processor, reported } = createProcessor(OpenAIResponsesStreamProcessor);

    const stream = eventsFrom([
        { type: 'response.created', response: { id: 'resp_1', status: 'in_progress' } },
        {
            type: 'response.output_text.delta',
            item_id: 'msg_1',
            output_index: 0,
            content_index: 0,
            delta: 'commentary'
        },
        {
            type: 'response.output_text.delta',
            item_id: 'msg_2',
            output_index: 1,
            content_index: 0,
            delta: 'final'
        },
        {
            type: 'response.completed',
            response: { id: 'resp_1', status: 'completed', output: [] }
        }
    ]);

    await processor.consume(stream as never);
    assert.deepEqual(reported, ['commentary', '\n\n', 'final']);
});

test('consume：response.incomplete 因 max_output_tokens 视为截断完成并 flush marker', async () => {
    const { OpenAIResponsesStreamProcessor } = await getProcessorModule();
    const { processor, flushed } = createProcessor(OpenAIResponsesStreamProcessor);
    const usage = { total_tokens: 12 };

    const stream = eventsFrom([
        { type: 'response.created', response: { id: 'resp_1', status: 'in_progress' } },
        {
            type: 'response.output_text.delta',
            item_id: 'msg_1',
            output_index: 0,
            content_index: 0,
            delta: '截断前'
        },
        {
            type: 'response.incomplete',
            response: {
                id: 'resp_1',
                status: 'incomplete',
                incomplete_details: { reason: 'max_output_tokens' },
                output: [],
                usage
            }
        }
    ]);

    await processor.consume(stream as never);
    assert.deepEqual(flushed, [{ finishReason: 'length', responseId: 'resp_1', usage }]);
    assert.deepEqual(processor.getFinalUsage(), usage);
    assert.equal(processor.getFinishReason(), 'length');
});

test('consume：response.incomplete 因 content_filter 抛错但仍 flush marker', async () => {
    const { OpenAIResponsesStreamProcessor } = await getProcessorModule();
    const { processor, flushed } = createProcessor(OpenAIResponsesStreamProcessor);

    const stream = eventsFrom([
        {
            type: 'response.incomplete',
            response: {
                id: 'resp_2',
                status: 'incomplete',
                incomplete_details: { reason: 'content_filter' },
                output: [],
                usage: { total_tokens: 3 }
            }
        }
    ]);

    await assert.rejects(processor.consume(stream as never), (error: unknown) => {
        assert.ok(error instanceof Error);
        assert.ok(error.message.length > 0);
        return true;
    });
    assert.deepEqual(flushed, [{ finishReason: 'content_filter', responseId: 'resp_2', usage: { total_tokens: 3 } }]);
});

test('consume：response.completed 兜底补发 function_call 与 web_search_call', async () => {
    const { OpenAIResponsesStreamProcessor } = await getProcessorModule();
    const toolCalls: Array<{ callId: string; name: string; input: unknown; countArgs?: boolean }> = [];
    const toolResults: Array<{ callId: string; content: unknown }> = [];
    const { processor, flushed } = createProcessor(OpenAIResponsesStreamProcessor, {
        reportToolCall(callId: string, name: string, input: unknown, options?: { countArgs?: boolean }) {
            toolCalls.push({ callId, name, input, countArgs: options?.countArgs });
        },
        reportToolResult(callId: string, content: string) {
            toolResults.push({ callId, content: JSON.parse(content) });
        }
    });

    const stream = eventsFrom([
        {
            type: 'response.completed',
            response: {
                id: 'resp_3',
                status: 'completed',
                output: [
                    {
                        type: 'function_call',
                        id: 'fc_1',
                        call_id: 'call_server_1',
                        name: 'search_docs',
                        arguments: '{"query":"responses"}'
                    },
                    {
                        type: 'web_search_call',
                        id: 'ws_1',
                        action: { type: 'search', query: 'hello', queries: ['hello'] }
                    }
                ]
            }
        }
    ]);

    await processor.consume(stream as never);

    assert.deepEqual(toolCalls, [
        {
            callId: 'call_server_1',
            name: 'search_docs',
            input: { query: 'responses' },
            countArgs: true
        }
    ]);
    assert.deepEqual(toolResults, [
        {
            callId: 'ws_1',
            content: { type: 'web_search_call', action_type: 'search', query: 'hello', queries: ['hello'] }
        }
    ]);
    assert.deepEqual(flushed, [{ finishReason: null, responseId: 'resp_3', usage: undefined }]);
});
