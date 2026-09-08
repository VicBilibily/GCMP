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

for (const completed of [false, true]) {
    for (const count of [1, 2]) {
        test(`consume：completed 重写 id 且缺参，已完成=${completed}，候选数=${count}`, async () => {
            const { OpenAIResponsesStreamProcessor } = await getProcessorModule();
            const calls: unknown[] = [];
            const { processor } = createProcessor(OpenAIResponsesStreamProcessor, {
                reportToolCall(_id: string, _name: string, input: unknown) {
                    calls.push(input);
                }
            });
            const items = Array.from({ length: count }, (_, index) => ({
                type: 'function_call',
                id: `old_${index}`,
                call_id: 'shared',
                name: 'read_file',
                arguments: JSON.stringify({ path: `${index}.ts` })
            }));
            await processor.consume(
                eventsFrom([
                    ...items.map(item => ({ type: 'response.output_item.added', item })),
                    ...(completed ? items.map(item => ({ type: 'response.output_item.done', item })) : []),
                    {
                        type: 'response.completed',
                        response: {
                            id: 'r',
                            output: items.map((item, index) => ({
                                type: item.type,
                                id: `new_${index}`,
                                call_id: item.call_id,
                                name: item.name
                            }))
                        }
                    }
                ]) as never
            );
            assert.deepEqual(
                calls,
                items.map(item => JSON.parse(item.arguments))
            );
        });
    }
}

test('consume：取消后到达 completed 不提交缓存', async () => {
    const { OpenAIResponsesStreamProcessor } = await getProcessorModule();
    const calls: unknown[] = [];
    const token = { isCancellationRequested: false };
    const { processor } = createProcessor(
        OpenAIResponsesStreamProcessor,
        {
            reportToolCall(...args: unknown[]) {
                calls.push(args);
            },
            reportToolArgDelta() {}
        },
        { token }
    );
    async function* stream() {
        yield {
            type: 'response.output_item.added',
            output_index: 0,
            item: { type: 'function_call', id: 'i', call_id: 'c', name: 'read_file', arguments: '{"path":"a.ts"}' }
        };
        token.isCancellationRequested = true;
        yield { type: 'response.completed', response: { id: 'r', output: [] } };
    }
    await assert.rejects(processor.consume(stream() as never), /abort/i);
    assert.deepEqual(calls, []);
});

for (const terminal of ['response.output_item.done', 'response.completed']) {
    test(`consume：${terminal} 省略参数保留缓存`, async () => {
        const { OpenAIResponsesStreamProcessor } = await getProcessorModule();
        const calls: unknown[] = [];
        const { processor } = createProcessor(OpenAIResponsesStreamProcessor, {
            reportToolCall(_id: string, _name: string, input: unknown) {
                calls.push(input);
            },
            reportToolArgDelta() {}
        });
        const item = { type: 'function_call', id: 'i', call_id: 'c', name: 'read_file' };
        await processor.consume(
            eventsFrom([
                { type: 'response.output_item.added', output_index: 0, item: { ...item, arguments: '' } },
                {
                    type: 'response.function_call_arguments.delta',
                    item_id: 'i',
                    output_index: 0,
                    delta: '{"path":"a.ts"}'
                },
                {
                    type: 'response.function_call_arguments.done',
                    item_id: 'i',
                    output_index: 0,
                    arguments: '{"path":"a.ts"}'
                },
                terminal === 'response.completed' ?
                    { type: terminal, response: { id: 'r', output: [item] } }
                :   { type: terminal, output_index: 0, item }
            ]) as never
        );
        assert.deepEqual(calls, [{ path: 'a.ts' }]);
    });
}

test('consume：index 和 item id 分阶段提供只上报一次', async () => {
    const { OpenAIResponsesStreamProcessor } = await getProcessorModule();
    const calls: unknown[] = [];
    const { processor } = createProcessor(OpenAIResponsesStreamProcessor, {
        reportToolCall(...args: unknown[]) {
            calls.push(args);
        }
    });
    const item = { type: 'function_call', call_id: 'c', name: 'read_file', arguments: '{"path":"a.ts"}' };
    await processor.consume(
        eventsFrom([
            { type: 'response.output_item.added', output_index: 0, item },
            { type: 'response.output_item.done', item: { ...item, id: 'i' } }
        ]) as never
    );
    assert.equal(calls.length, 1);
});

test('consume：终态内同 id 同参数的独立 item 不得归并', async () => {
    const { OpenAIResponsesStreamProcessor } = await getProcessorModule();
    const calls: unknown[] = [];
    const { processor } = createProcessor(OpenAIResponsesStreamProcessor, {
        reportToolCall(...args: unknown[]) {
            calls.push(args);
        }
    });
    await processor.consume(
        eventsFrom([
            {
                type: 'response.completed',
                response: {
                    output: ['a', 'b'].map(id => ({
                        type: 'function_call',
                        id,
                        call_id: 'shared',
                        name: 'read_file',
                        arguments: '{}'
                    }))
                }
            }
        ]) as never
    );
    assert.equal(calls.length, 2);
});

test('consume：终态重写只能一对一消费终态前记录', async () => {
    const { OpenAIResponsesStreamProcessor } = await getProcessorModule();
    const calls: unknown[] = [];
    const { processor } = createProcessor(OpenAIResponsesStreamProcessor, {
        reportToolCall(...args: unknown[]) {
            calls.push(args);
        }
    });
    const item = { type: 'function_call', call_id: 'shared', name: 'read_file', arguments: '{"a":1,"b":2}' };
    await processor.consume(
        eventsFrom([
            ...['a', 'b'].map(id => ({ type: 'response.output_item.done', item: { ...item, id } })),
            {
                type: 'response.completed',
                response: {
                    output: ['c', 'd', 'e'].map(id => ({
                        ...item,
                        id,
                        arguments: '{"b":2, "a":1}'
                    }))
                }
            }
        ]) as never
    );
    assert.equal(calls.length, 3);
});

test('consume：arguments.done 只缓存，output_item.done 才执行最终参数', async () => {
    const { OpenAIResponsesStreamProcessor } = await getProcessorModule();
    const calls: unknown[] = [];
    const { processor } = createProcessor(OpenAIResponsesStreamProcessor, {
        reportToolCall(_id: string, _name: string, input: unknown) {
            calls.push(input);
        }
    });
    async function* stream() {
        yield {
            type: 'response.function_call_arguments.done',
            item_id: 'a',
            call_id: 'c',
            name: 'read_file',
            arguments: '{}'
        };
        assert.equal(calls.length, 0);
        yield {
            type: 'response.output_item.done',
            item: { type: 'function_call', id: 'a', call_id: 'c', name: 'read_file', arguments: '{"a":1}' }
        };
    }
    await processor.consume(stream() as never);
    assert.deepEqual(calls, [{ a: 1 }]);
});

test('consume：缺少 item id 的不同 output index 与 completed-only 调用仍独立', async () => {
    const { OpenAIResponsesStreamProcessor } = await getProcessorModule();
    for (const streamed of [false, true]) {
        const calls: unknown[] = [];
        const { processor } = createProcessor(OpenAIResponsesStreamProcessor, {
            reportToolCall(...args: unknown[]) {
                calls.push(args);
            }
        });
        const item = { type: 'function_call', call_id: 'same', name: 'read_file', arguments: '{}' };
        await processor.consume(
            eventsFrom([
                ...(streamed ?
                    [0, 1].map(output_index => ({ type: 'response.output_item.done', output_index, item }))
                :   []),
                { type: 'response.completed', response: { output: [item, item] } }
            ]) as never
        );
        assert.equal(calls.length, 2);
    }
});

test('consume：只有 arguments.done 时流末回退，取消和失败不执行缓存', async () => {
    const { OpenAIResponsesStreamProcessor } = await getProcessorModule();
    for (const ending of ['eof', 'failed', 'cancelled']) {
        const calls: unknown[] = [];
        const token = { isCancellationRequested: false };
        const { processor } = createProcessor(
            OpenAIResponsesStreamProcessor,
            {
                reportToolCall(...args: unknown[]) {
                    calls.push(args);
                }
            },
            { token }
        );
        async function* stream() {
            yield { type: 'response.function_call_arguments.done', call_id: 'c', name: 'read_file', arguments: '{}' };
            if (ending === 'failed') {
                yield { type: 'response.failed', response: { error: { message: 'failed' } } };
            }
            if (ending === 'cancelled') {
                token.isCancellationRequested = true;
            }
        }
        if (ending === 'eof') {
            await processor.consume(stream() as never);
        } else {
            await assert.rejects(processor.consume(stream() as never));
        }
        assert.equal(calls.length, ending === 'eof' ? 1 : 0);
    }
});

test('consume：无终态事件时统一收口并刷新 marker', async () => {
    const { OpenAIResponsesStreamProcessor } = await getProcessorModule();
    const { processor, flushed } = createProcessor(OpenAIResponsesStreamProcessor);

    await processor.consume(
        eventsFrom([
            {
                type: 'response.output_text.delta',
                item_id: 'message-1',
                content_index: 0,
                delta: 'partial'
            }
        ]) as never
    );

    assert.deepEqual(flushed, [{ finishReason: null, responseId: undefined, usage: undefined }]);
    assert.equal(processor.isResponseFinalized(), true);
});

test('consume：终态保留已知身份后才按内容匹配重写项', async () => {
    const { OpenAIResponsesStreamProcessor } = await getProcessorModule();
    const calls: unknown[] = [];
    const { processor } = createProcessor(OpenAIResponsesStreamProcessor, {
        reportToolCall(...args: unknown[]) {
            calls.push(args);
        }
    });
    const item = { type: 'function_call', call_id: 'same', name: 'read_file', arguments: '{}' };
    await processor.consume(
        eventsFrom([
            { type: 'response.output_item.done', item: { ...item, id: 'known' } },
            {
                type: 'response.completed',
                response: {
                    output: [
                        { ...item, id: 'new' },
                        { ...item, id: 'known' }
                    ]
                }
            }
        ]) as never
    );
    assert.equal(calls.length, 2);
});

test('consume：added 完整参数不提前执行，delta 计数且流末可回退', async () => {
    const { OpenAIResponsesStreamProcessor } = await getProcessorModule();
    const calls: unknown[] = [];
    const deltas: string[] = [];
    const { processor } = createProcessor(OpenAIResponsesStreamProcessor, {
        reportToolCall(_id: string, _name: string, args: unknown, options: unknown) {
            calls.push({ args, options });
        },
        reportToolArgDelta(delta: string) {
            deltas.push(delta);
        }
    });
    async function* stream() {
        yield {
            type: 'response.output_item.added',
            output_index: 0,
            item: {
                type: 'function_call',
                id: 'a',
                call_id: 'c',
                name: 'read_file',
                arguments: '{}'
            }
        };
        assert.equal(calls.length, 0);
        yield { type: 'response.function_call_arguments.delta', item_id: 'a', output_index: 0, delta: '{}' };
    }
    await processor.consume(stream() as never);
    assert.deepEqual(deltas, ['{}']);
    assert.deepEqual(calls, [{ args: {}, options: { countArgs: false } }]);
});

test('consume：相同 call_id 的交错工具事件保持参数归属且各上报一次', async () => {
    const { OpenAIResponsesStreamProcessor } = await getProcessorModule();
    const calls: Array<{ id: string; name: string; input: unknown }> = [];
    const { processor } = createProcessor(OpenAIResponsesStreamProcessor, {
        reportToolCall(id: string, name: string, input: unknown) {
            calls.push({ id, name, input });
        },
        reportToolArgDelta() {}
    });
    const items = [
        { type: 'function_call', id: 'item1', call_id: 'shared', name: 'read_file', arguments: '{"path":"a.ts"}' },
        { type: 'function_call', id: 'item2', call_id: 'shared', name: 'apply_patch', arguments: '{"patch":"change"}' }
    ];
    await processor.consume(
        eventsFrom([
            ...items.map(item => ({ type: 'response.output_item.added', item: { ...item, arguments: '' } })),
            ...items.map(item => ({
                type: 'response.function_call_arguments.delta',
                item_id: item.id,
                call_id: item.call_id,
                delta: item.arguments
            })),
            ...items.map(item => ({
                type: 'response.function_call_arguments.done',
                item_id: item.id,
                call_id: item.call_id,
                name: item.name,
                arguments: item.arguments
            })),
            ...items.map(item => ({ type: 'response.output_item.done', item })),
            { type: 'response.completed', response: { id: 'resp1', output: items } }
        ]) as never
    );
    assert.deepEqual(calls, [
        { id: 'shared', name: 'read_file', input: { path: 'a.ts' } },
        { id: 'shared', name: 'apply_patch', input: { patch: 'change' } }
    ]);
});

test('consume：缺少 item_id 时仍会上报只有 call_id 的完整工具调用', async () => {
    const { OpenAIResponsesStreamProcessor } = await getProcessorModule();
    const calls: Array<{ id: string; name: string; input: unknown }> = [];
    const { processor } = createProcessor(OpenAIResponsesStreamProcessor, {
        reportToolCall(id: string, name: string, input: unknown) {
            calls.push({ id, name, input });
        }
    });

    await processor.consume(
        eventsFrom([
            {
                type: 'response.function_call_arguments.done',
                call_id: 'call_only',
                name: 'read_file',
                arguments: '{"path":"a.ts"}'
            },
            { type: 'response.completed', response: { id: 'resp_only', output: [] } }
        ]) as never
    );

    assert.deepEqual(calls, [{ id: 'call_only', name: 'read_file', input: { path: 'a.ts' } }]);
});

test('consume：response.completed 重写 item id 时不重复上报工具调用', async () => {
    const { OpenAIResponsesStreamProcessor } = await getProcessorModule();
    const calls: Array<{ id: string; name: string; input: unknown }> = [];
    const { processor } = createProcessor(OpenAIResponsesStreamProcessor, {
        reportToolCall(id: string, name: string, input: unknown) {
            calls.push({ id, name, input });
        },
        reportToolArgDelta() {}
    });

    const streamedItem = {
        type: 'function_call',
        id: 'item_streamed',
        call_id: 'call_1',
        name: 'read_file',
        arguments: '{"path":"a.ts"}'
    };
    await processor.consume(
        eventsFrom([
            { type: 'response.output_item.added', item: { ...streamedItem, arguments: '' } },
            {
                type: 'response.function_call_arguments.done',
                item_id: 'item_streamed',
                call_id: 'call_1',
                name: 'read_file',
                arguments: '{"path":"a.ts"}'
            },
            { type: 'response.output_item.done', item: streamedItem },
            // 网关在 completed 中重写 item id（call_id 不变）
            {
                type: 'response.completed',
                response: { id: 'resp1', output: [{ ...streamedItem, id: 'item_completed' }] }
            }
        ]) as never
    );

    assert.deepEqual(calls, [{ id: 'call_1', name: 'read_file', input: { path: 'a.ts' } }]);
});

test('consume：先收到无 item_id 的 arguments.done 再收到完整事件时不重复上报', async () => {
    const { OpenAIResponsesStreamProcessor } = await getProcessorModule();
    const calls: Array<{ id: string; name: string; input: unknown }> = [];
    const { processor } = createProcessor(OpenAIResponsesStreamProcessor, {
        reportToolCall(id: string, name: string, input: unknown) {
            calls.push({ id, name, input });
        },
        reportToolArgDelta() {}
    });

    const fullItem = {
        type: 'function_call',
        id: 'item1',
        call_id: 'call_1',
        name: 'read_file',
        arguments: '{"path":"a.ts"}'
    };
    await processor.consume(
        eventsFrom([
            {
                type: 'response.function_call_arguments.done',
                call_id: 'call_1',
                name: 'read_file',
                arguments: '{"path":"a.ts"}'
            },
            { type: 'response.output_item.added', item: fullItem },
            { type: 'response.output_item.done', item: fullItem },
            { type: 'response.completed', response: { id: 'resp1', output: [fullItem] } }
        ]) as never
    );

    assert.deepEqual(calls, [{ id: 'call_1', name: 'read_file', input: { path: 'a.ts' } }]);
});

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

test('consume：content_filter 不提交尚未上报的工具调用', async () => {
    const { OpenAIResponsesStreamProcessor } = await getProcessorModule();
    const calls: unknown[] = [];
    const { processor } = createProcessor(OpenAIResponsesStreamProcessor, {
        reportToolCall(...args: unknown[]) {
            calls.push(args);
        }
    });
    await assert.rejects(
        processor.consume(
            eventsFrom([
                {
                    type: 'response.incomplete',
                    response: {
                        id: 'resp-filtered',
                        incomplete_details: { reason: 'content_filter' },
                        output: [
                            {
                                type: 'function_call',
                                id: 'item-1',
                                call_id: 'call-1',
                                name: 'read_file',
                                arguments: '{}'
                            }
                        ]
                    }
                }
            ]) as never
        )
    );
    assert.deepEqual(calls, []);
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
