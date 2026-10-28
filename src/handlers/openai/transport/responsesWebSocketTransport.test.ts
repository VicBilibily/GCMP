import assert from 'node:assert/strict';
import test from 'node:test';
import { ResponsesTransportFailure, ResponsesWebSocketTransport } from './responsesWebSocketTransport';
import type { ResponsesSocket } from './responsesWebSocketTransport';
import { isCancellationError } from '../../../utils/text/cancellationError';

test('WS-LOOP-16: structured handshake rejection is not a user cancellation', () => {
    const cause = Object.assign(new Error('proxy refused'), { code: 'UND_ERR_ABORTED' });
    const error = new ResponsesTransportFailure(
        'handshake failed',
        'handshake',
        'not-sent',
        'unknown',
        undefined,
        undefined,
        cause
    );
    assert.equal(error.cause, cause);
    assert.equal(error.safeToRetry, true);
    assert.equal(isCancellationError(error), false);
});

class Socket implements ResponsesSocket {
    opened = Promise.resolve();
    private resolveClosed!: () => void;
    closed = new Promise<void>(resolve => {
        this.resolveClosed = resolve;
    });
    reusable = true;
    sent: string[] = [];
    messages = new Set<(data: unknown) => void>();
    disconnects = new Set<() => void>();
    send(frame: string) {
        this.sent.push(frame);
    }
    onMessage(listener: (data: unknown) => void) {
        this.messages.add(listener);
        return () => {
            this.messages.delete(listener);
        };
    }
    onDisconnect(listener: () => void) {
        this.disconnects.add(listener);
        return () => {
            this.disconnects.delete(listener);
        };
    }
    emit(value: unknown) {
        for (const listener of this.messages) {
            listener(JSON.stringify(value));
        }
    }
    async close() {
        if (!this.reusable) {
            return;
        }
        this.reusable = false;
        for (const listener of this.disconnects) {
            listener();
        }
        this.resolveClosed();
    }
}

for (const variant of ['delta-rejected', 'full-rejected', 'already-accepted', 'wrong-status', 'other-code'] as const) {
    test(`WS-LOOP-10: previous response recovery eligibility ${variant}`, async () => {
        const socket = new Socket();
        const transport = new ResponsesWebSocketTransport(socket);
        const handle = transport.begin(
            { model: 'test', input: [] },
            () => {},
            variant === 'full-rejected' ? undefined : 'old-response'
        );
        if (variant === 'already-accepted') {
            socket.emit({ type: 'response.created', response: { id: 'accepted' } });
        }
        socket.emit({
            type: 'error',
            status: variant === 'wrong-status' ? 429 : 400,
            error: {
                code: variant === 'other-code' ? 'invalid_request' : 'previous_response_not_found',
                message: 'rejected'
            }
        });
        await assert.rejects(
            async () => {
                for await (const event of handle.events) {
                    assert.ok(event.type);
                }
            },
            (error: unknown) => {
                assert.ok(error instanceof ResponsesTransportFailure);
                assert.equal(error.modelDispatch, 'possibly-sent');
                assert.equal(error.retryWithFullContext, variant === 'delta-rejected');
                assert.equal(error.safeToRetry, variant === 'delta-rejected');
                assert.equal(error.retryIfNoOutput, false);
                assert.equal(
                    error.acceptance,
                    variant === 'delta-rejected' ? 'rejected'
                    : variant === 'already-accepted' ? 'accepted'
                    : 'unknown'
                );
                return true;
            }
        );
        handle.finish(false);
        await transport.close();
        assert.deepEqual(transport.diagnostics(), { queueBytes: 0, handles: 0, processQueueBytes: 0 });
    });
}

for (const variant of ['reject', 'throw', 'timeout'] as const) {
    test(`WS-LOOP-15: dispatcher ${variant} is bounded and cannot report successful close`, async () => {
        let time = 0;
        const tasks = new Set<{ at: number; run: () => void }>();
        let releases = 0;
        let aborts = 0;
        const failure = new Error('dispatcher failed');
        const socket = new Socket();
        const transport = new ResponsesWebSocketTransport(
            socket,
            {
                now: () => time,
                schedule: (run, delay) => {
                    const task = { run, at: time + delay };
                    tasks.add(task);
                    return () => {
                        tasks.delete(task);
                    };
                }
            },
            undefined,
            {
                release: () => {
                    releases++;
                    if (variant === 'throw') {
                        throw failure;
                    }
                    return variant === 'reject' ? Promise.reject(failure) : new Promise<void>(() => {});
                },
                abortPending: async () => {
                    aborts++;
                }
            }
        );
        const cleanup = transport.close();
        assert.equal(transport.close(), cleanup);
        const rejected = assert.rejects(cleanup, (error: unknown) =>
            variant === 'timeout' ? error instanceof Error && /release deadline/.test(error.message) : error === failure
        );
        await Promise.resolve();
        await Promise.resolve();
        if (variant === 'timeout') {
            time = 5_000;
            for (const task of [...tasks]) {
                if (task.at <= time && tasks.delete(task)) {
                    task.run();
                }
            }
        }
        await rejected;
        await assert.rejects(transport.closed);
        assert.equal(releases, 1);
        assert.equal(aborts, 1);
        assert.equal(tasks.size, 0);
        assert.equal(socket.reusable, false);
    });
}

test('WS-LOOP-02: flat full frames preserve parameters and reuse without previous ID', async () => {
    const socket = new Socket();
    const transport = new ResponsesWebSocketTransport(socket);
    let dispatched = 0;
    for (const responseId of ['r1', 'r2']) {
        const handle = transport.begin(
            { model: 'test', input: [{ role: 'user', content: 'hi' }], stream: true, store: false },
            () => dispatched++
        );
        socket.emit({ type: 'response.created', response: { id: responseId } });
        socket.emit({ type: 'response.completed', response: { id: responseId, output: [] } });
        const events = [];
        for await (const event of handle.events) {
            events.push(event.type);
        }
        assert.deepEqual(events, ['response.created', 'response.completed']);
        assert.equal(handle.receipt?.responseId, responseId);
        handle.finish(true);
    }
    assert.equal(dispatched, 2);
    for (const frame of socket.sent) {
        assert.deepEqual(JSON.parse(frame), {
            type: 'response.create',
            model: 'test',
            input: [{ role: 'user', content: 'hi' }],
            store: false
        });
    }
    assert.deepEqual(transport.diagnostics(), { queueBytes: 0, handles: 0, processQueueBytes: 0 });
    await transport.close();
    assert.equal(socket.messages.size + socket.disconnects.size, 0);
});

for (const stage of ['in_progress', 'searching', 'completed'] as const) {
    test(`WS-LOOP-03: web search ${stage} preserves the response stream and completed output`, async () => {
        const socket = new Socket();
        const transport = new ResponsesWebSocketTransport(socket);
        const handle = transport.begin({ model: 'test', input: [] }, () => {});
        const progress = {
            type: `response.web_search_call.${stage}`,
            item_id: 'ws_search',
            output_index: 0,
            sequence_number: 1
        };
        const item = {
            type: 'web_search_call',
            id: 'ws_search',
            status: 'completed',
            action: { type: 'search', query: 'synthetic query' }
        };
        try {
            socket.emit(progress);
            assert.equal(handle.acceptance, 'accepted');
            assert.equal(Boolean(handle.receipt), false);
            socket.emit({ type: 'response.output_item.done', output_index: 0, item });
            socket.emit({ type: 'response.completed', response: { id: 'response_search', output: [] } });
            const types: string[] = [];
            for await (const event of handle.events) {
                types.push(event.type);
            }
            assert.deepEqual(types, [progress.type, 'response.output_item.done', 'response.completed']);
            assert.deepEqual(handle.receipt?.output, [item]);
            assert.equal(handle.receipt?.outputComplete, true);
            handle.finish(true);
            assert.deepEqual(transport.diagnostics(), { queueBytes: 0, handles: 0, processQueueBytes: 0 });
        } finally {
            handle.finish(false);
            await transport.close();
        }
    });

    for (const variant of [
        'missing-item-id',
        'invalid-item-id',
        'missing-output-index',
        'invalid-output-index',
        'negative-output-index',
        'fractional-output-index',
        'invalid-sequence',
        'negative-sequence'
    ] as const) {
        test(`WS-LOOP-12: web search ${stage} rejects ${variant}`, async () => {
            const socket = new Socket();
            const transport = new ResponsesWebSocketTransport(socket);
            const handle = transport.begin({ model: 'test', input: [] }, () => {});
            try {
                socket.emit({
                    type: `response.web_search_call.${stage}`,
                    item_id:
                        variant === 'missing-item-id' ? undefined
                        : variant === 'invalid-item-id' ? 42
                        : 'ws_search',
                    output_index:
                        variant === 'missing-output-index' ? undefined
                        : variant === 'invalid-output-index' ? '0'
                        : variant === 'negative-output-index' ? -1
                        : variant === 'fractional-output-index' ? 0.5
                        : 0,
                    sequence_number:
                        variant === 'invalid-sequence' ? '1'
                        : variant === 'negative-sequence' ? -1
                        : 1
                });
                await assert.rejects(
                    async () => {
                        for await (const event of handle.events) {
                            assert.ok(event.type);
                        }
                    },
                    (error: unknown) => {
                        assert.ok(error instanceof ResponsesTransportFailure);
                        assert.match(error.message, /Unsupported or malformed Responses event/);
                        assert.equal(error.safeToRetry, false);
                        return true;
                    }
                );
            } finally {
                handle.finish(false);
                await transport.close();
            }
            assert.deepEqual(transport.diagnostics(), { queueBytes: 0, handles: 0, processQueueBytes: 0 });
        });
    }
}

for (const terminalOutput of ['empty', 'reasoning-only', 'complete'] as const) {
    test(`WS-LOOP-03: terminal ${terminalOutput} retains completed text and parallel calls in output order`, async () => {
        const socket = new Socket();
        const transport = new ResponsesWebSocketTransport(socket);
        const handle = transport.begin({ model: 'test', input: [] }, () => {});
        const reasoning = { type: 'reasoning', id: 'rs_done', summary: [], encrypted_content: 'synthetic-cipher' };
        const output = [
            reasoning,
            {
                type: 'message',
                id: 'msg_done',
                role: 'assistant',
                status: 'completed',
                content: [{ type: 'output_text', text: 'before tools', annotations: [] }]
            },
            ...[0, 1, 2, 3, 4].map(index => ({
                type: 'function_call',
                id: `fc_${index}`,
                call_id: `call_${index}`,
                name: 'read_file',
                arguments: JSON.stringify({ endLine: 200, filePath: `/synthetic/file-${index}.ts`, startLine: 1 }),
                status: 'completed'
            }))
        ];
        try {
            socket.emit({ type: 'response.created', response: { id: 'response_done' } });
            socket.emit({ type: 'response.in_progress', response: { id: 'response_done', status: 'in_progress' } });
            for (const index of [6, 0, 3, 1, 5, 2, 4]) {
                socket.emit({ type: 'response.output_item.done', output_index: index, item: output[index] });
            }
            socket.emit({ type: 'response.in_progress', response: { id: 'response_done', status: 'in_progress' } });
            socket.emit({
                type: 'response.completed',
                response: {
                    id: 'response_done',
                    output:
                        terminalOutput === 'empty' ? []
                        : terminalOutput === 'reasoning-only' ? [reasoning]
                        : output
                }
            });
            for await (const event of handle.events) {
                assert.ok(event.type);
            }
            assert.deepEqual(handle.receipt?.output, output);
            assert.equal(handle.receipt?.outputComplete, true);
            assert.equal(handle.receipt?.outputIncompleteReason, undefined);
            handle.finish(true);
            assert.deepEqual(transport.diagnostics(), { queueBytes: 0, handles: 0, processQueueBytes: 0 });
        } finally {
            handle.finish(false);
            await transport.close();
        }
    });
}

for (const variant of [
    'missing-done',
    'gap',
    'duplicate-index',
    'conflicting-terminal',
    'duplicate-id',
    'unindexed-done',
    'unindexed-delta'
] as const) {
    test(`WS-LOOP-03: incomplete output ${variant} cannot establish a complete receipt`, async () => {
        const socket = new Socket();
        const transport = new ResponsesWebSocketTransport(socket);
        const handle = transport.begin({ model: 'test', input: [] }, () => {});
        const item = {
            type: 'message',
            id: 'msg_complete',
            role: 'assistant',
            status: 'completed',
            content: [{ type: 'output_text', text: 'streamed text', annotations: [] }]
        };
        try {
            if (variant === 'missing-done' || variant === 'unindexed-delta') {
                socket.emit({
                    type: 'response.output_text.delta',
                    delta: 'streamed text',
                    ...(variant === 'missing-done' ? { output_index: 0 } : {})
                });
            } else {
                socket.emit({
                    type: 'response.output_item.done',
                    item,
                    ...(variant === 'unindexed-done' ? {} : { output_index: variant === 'gap' ? 1 : 0 })
                });
                if (variant === 'duplicate-index' || variant === 'duplicate-id') {
                    socket.emit({
                        type: 'response.output_item.done',
                        output_index: variant === 'duplicate-id' ? 1 : 0,
                        item
                    });
                }
            }
            socket.emit({ type: 'response.in_progress', response: { id: 'response_done', status: 'in_progress' } });
            socket.emit({
                type: 'response.completed',
                response: {
                    id: 'response_done',
                    output: variant === 'conflicting-terminal' ? [{ ...item, id: 'msg_foreign' }] : []
                }
            });
            for await (const event of handle.events) {
                assert.ok(event.type);
            }
            assert.equal(handle.receipt?.outputComplete, false);
            const reasons = {
                'missing-done': 'missing-output-item',
                gap: 'output-index-gap',
                'duplicate-index': 'duplicate-output-index',
                'conflicting-terminal': 'terminal-item-conflict',
                'duplicate-id': 'duplicate-item-id',
                'unindexed-done': 'unindexed-output',
                'unindexed-delta': 'unindexed-output'
            } as const;
            assert.equal(handle.receipt?.outputIncompleteReason, reasons[variant]);
            handle.finish(true);
            assert.deepEqual(transport.diagnostics(), { queueBytes: 0, handles: 0, processQueueBytes: 0 });
        } finally {
            handle.finish(false);
            await transport.close();
        }
    });
}

test('WS-LOOP-03: completed output retention remains bounded after events are consumed', async () => {
    const socket = new Socket();
    const event = (index: number) => ({
        type: 'response.output_item.done',
        output_index: index,
        item: {
            type: 'message',
            id: `msg_${index}`,
            role: 'assistant',
            status: 'completed',
            content: [{ type: 'output_text', text: 'x'.repeat(360) }]
        }
    });
    const bytes = Buffer.byteLength(JSON.stringify(event(0)));
    const transport = new ResponsesWebSocketTransport(socket, undefined, {
        messageBytes: 4096,
        queueBytes: bytes * 2,
        firstMs: 120_000,
        idleMs: 180_000
    });
    const handle = transport.begin({ model: 'test', input: [] }, () => {});
    const iterator = handle.events[Symbol.asyncIterator]();
    try {
        for (const index of [0, 1]) {
            const next = iterator.next();
            socket.emit(event(index));
            await next;
            assert.equal(transport.diagnostics().queueBytes, 0);
            assert.equal(transport.diagnostics().processQueueBytes, bytes * (index + 1));
        }
        const rejected = assert.rejects(iterator.next(), /output retention budget exceeded/);
        socket.emit(event(2));
        await rejected;
        handle.finish(false);
        assert.deepEqual(transport.diagnostics(), { queueBytes: 0, handles: 0, processQueueBytes: 0 });
    } finally {
        handle.finish(false);
        await transport.close();
    }
});

for (const ending of ['success', 'cancel', 'disconnect', 'abandon'] as const) {
    test(`WS-LOOP-15: retained completed output is released after ${ending}`, async () => {
        const socket = new Socket();
        const transport = new ResponsesWebSocketTransport(socket);
        const handle = transport.begin({ model: 'test', input: [] }, () => {});
        const iterator = handle.events[Symbol.asyncIterator]();
        try {
            socket.emit({
                type: 'response.output_item.done',
                output_index: 0,
                item: {
                    type: 'message',
                    id: 'msg_done',
                    role: 'assistant',
                    status: 'completed',
                    content: [{ type: 'output_text', text: 'done' }]
                }
            });
            await iterator.next();
            assert.ok(transport.diagnostics().processQueueBytes > 0);
            if (ending === 'success') {
                socket.emit({ type: 'response.completed', response: { id: 'response_done', output: [] } });
                await iterator.next();
                await iterator.return?.();
                assert.equal(handle.receipt?.outputComplete, true);
                assert.ok(transport.diagnostics().processQueueBytes > 0);
            } else if (ending === 'cancel') {
                transport.interrupt(new Error('synthetic cancellation'));
                await assert.rejects(iterator.next(), /synthetic cancellation/);
            } else if (ending === 'disconnect') {
                await socket.close();
                await assert.rejects(iterator.next(), /disconnected without terminal/);
            } else {
                await iterator.return?.();
            }
            handle.finish(ending === 'success');
            assert.deepEqual(transport.diagnostics(), { queueBytes: 0, handles: 0, processQueueBytes: 0 });
        } finally {
            handle.finish(false);
            await transport.close();
        }
    });
}

for (const type of [
    'response.web_search_call.unknown',
    'response.future_terminal',
    'vendor.search.running',
    'response.private\nsynthetic-secret-payload'
]) {
    test(`WS-LOOP-13: unknown event ${JSON.stringify(type)} is logged without affecting delivery or reuse`, async () => {
        const socket = new Socket();
        const logged: string[] = [];
        const transport = new ResponsesWebSocketTransport(socket, undefined, undefined, undefined, eventType => {
            logged.push(eventType);
        });
        const notification = {
            type,
            response_id: 'foreign-response',
            response: { id: 'foreign-response' },
            output_index: 999,
            sequence_number: -1,
            delta: 'synthetic-secret-payload'
        };
        try {
            socket.emit(notification);
            assert.equal(transport.reusable, true);
            for (const responseId of ['first', 'next']) {
                const handle = transport.begin({ model: 'test', input: [] }, () => {});
                try {
                    socket.emit(notification);
                    assert.equal(handle.acceptance, 'unknown');
                    assert.equal(Boolean(handle.receipt), false);
                    assert.equal(transport.diagnostics().queueBytes, 0);
                    socket.emit({ type: 'response.created', response: { id: responseId } });
                    const before = transport.diagnostics();
                    socket.emit(notification);
                    assert.deepEqual(transport.diagnostics(), before);
                    socket.emit({ type: 'response.output_text.delta', output_index: 0, delta: 'kept text' });
                    const item = {
                        type: 'message',
                        id: `msg_${responseId}`,
                        role: 'assistant',
                        status: 'completed',
                        content: [{ type: 'output_text', text: 'kept text' }]
                    };
                    socket.emit({ type: 'response.output_item.done', output_index: 0, item });
                    socket.emit({
                        type: 'response.completed',
                        response: {
                            id: responseId,
                            output: [],
                            usage: { input_tokens: 2, output_tokens: 1, total_tokens: 3 }
                        }
                    });
                    socket.emit(notification);
                    const events = [];
                    for await (const event of handle.events) {
                        events.push(event);
                    }
                    assert.deepEqual(
                        events.map(event => event.type),
                        [
                            'response.created',
                            'response.output_text.delta',
                            'response.output_item.done',
                            'response.completed'
                        ]
                    );
                    assert.deepEqual(events.at(-1), {
                        type: 'response.completed',
                        response: {
                            id: responseId,
                            output: [],
                            usage: { input_tokens: 2, output_tokens: 1, total_tokens: 3 }
                        }
                    });
                    assert.equal(handle.receipt?.responseId, responseId);
                    assert.deepEqual(handle.receipt?.output, [item]);
                    assert.equal(handle.receipt?.outputComplete, true);
                    handle.finish(true);
                    socket.emit(notification);
                    assert.equal(transport.reusable, true);
                    assert.deepEqual(transport.diagnostics(), { queueBytes: 0, handles: 0, processQueueBytes: 0 });
                } finally {
                    handle.finish(false);
                }
            }
            const label = type.includes('\n') ? 'unknown' : type;
            assert.deepEqual(logged, Array<string>(9).fill(label));
            assert.equal(logged.join('').includes('synthetic-secret-payload'), false);
        } finally {
            await transport.close();
        }
    });
}

for (const type of [
    'codex.rate_limits',
    'codex.response.metadata',
    'response.metadata',
    'responsesapi.websocket_timing',
    'keepalive',
    'response.future_terminal'
]) {
    test(`WS-LOOP-13: auxiliary ${type} preserves response delivery and connection reuse`, async () => {
        const socket = new Socket();
        const transport = new ResponsesWebSocketTransport(socket);
        const notification = {
            type,
            rate_limits: { allowed: false, limit_reached: true },
            response_id: 'not-a-generation-response',
            headers: { 'x-models-etag': 'synthetic-etag' }
        };
        try {
            for (const responseId of ['first', 'next']) {
                const handle = transport.begin({ model: 'test', input: [] }, () => {});
                socket.emit(notification);
                assert.equal(handle.acceptance, 'unknown');
                assert.equal(Boolean(handle.receipt), false);
                assert.equal(socket.reusable, true);
                assert.equal(transport.diagnostics().queueBytes, 0);
                socket.emit({ type: 'response.created', response: { id: responseId } });
                socket.emit(notification);
                socket.emit({
                    type: 'response.completed',
                    response: {
                        id: responseId,
                        output: [],
                        usage: { input_tokens: 2, output_tokens: 1, total_tokens: 3 }
                    }
                });
                socket.emit(notification);
                const events = [];
                for await (const event of handle.events) {
                    events.push(event.type);
                }
                assert.deepEqual(events, ['response.created', 'response.completed']);
                assert.equal(handle.receipt?.responseId, responseId);
                handle.finish(true);
                socket.emit(notification);
                assert.equal(socket.reusable, true);
                assert.equal(transport.reusable, true);
                assert.deepEqual(transport.diagnostics(), { queueBytes: 0, handles: 0, processQueueBytes: 0 });
            }
        } finally {
            await transport.close();
        }
    });

    for (const phase of ['first', 'idle'] as const) {
        test(`WS-LOOP-13: auxiliary ${type} cannot extend ${phase} deadline`, async () => {
            let time = 0;
            const tasks = new Set<{ at: number; run: () => void }>();
            const socket = new Socket();
            const transport = new ResponsesWebSocketTransport(
                socket,
                {
                    now: () => time,
                    schedule: (run, delay) => {
                        const task = { run, at: time + delay };
                        tasks.add(task);
                        return () => {
                            tasks.delete(task);
                        };
                    }
                },
                { messageBytes: 1024, queueBytes: 1024, firstMs: 10, idleMs: 20 }
            );
            const handle = transport.begin({ model: 'test', input: [] }, () => {});
            try {
                if (phase === 'idle') {
                    socket.emit({ type: 'response.created', response: { id: 'response' } });
                }
                const deadline = phase === 'first' ? 10 : 20;
                time = deadline - 1;
                socket.emit({ type });
                assert.equal(handle.acceptance, phase === 'first' ? 'unknown' : 'accepted');
                time = deadline;
                for (const task of [...tasks]) {
                    if (task.at <= time && tasks.delete(task)) {
                        task.run();
                    }
                }
                assert.equal(socket.reusable, false);
                await assert.rejects(
                    async () => {
                        for await (const event of handle.events) {
                            assert.ok(event.type);
                        }
                    },
                    (error: unknown) => {
                        assert.ok(error instanceof ResponsesTransportFailure);
                        assert.match(error.message, /deadline/);
                        assert.equal(error.acceptance, phase === 'first' ? 'unknown' : 'accepted');
                        assert.equal(error.safeToRetry, false);
                        assert.equal(error.retryIfNoOutput, true);
                        return true;
                    }
                );
            } finally {
                handle.finish(false);
                await transport.close();
            }
            assert.equal(tasks.size, 0);
            assert.deepEqual(transport.diagnostics(), { queueBytes: 0, handles: 0, processQueueBytes: 0 });
        });
    }
}

for (const completed of [false, true]) {
    test(`WS-LOOP-12: disconnect after terminal=${completed}`, async () => {
        const socket = new Socket();
        const transport = new ResponsesWebSocketTransport(socket);
        const handle = transport.begin({ model: 'test', input: [] }, () => undefined);
        socket.emit({ type: 'response.output_text.delta', delta: 'kept', item_id: 'i', content_index: 0 });
        if (completed) {
            socket.emit({ type: 'response.completed', response: { id: 'r', output: [] } });
        }
        await socket.close();
        const consume = async () => {
            const events = [];
            for await (const event of handle.events) {
                events.push(event.type);
            }
            return events;
        };
        if (completed) {
            assert.deepEqual(await consume(), ['response.output_text.delta', 'response.completed']);
        } else {
            await assert.rejects(
                consume(),
                (error: unknown) => error instanceof ResponsesTransportFailure && !error.safeToRetry
            );
        }
        handle.finish(completed);
        assert.equal(transport.diagnostics().processQueueBytes, 0);
    });
}

for (const variant of [
    'malformed',
    'binary',
    'oversize',
    'overflow',
    'identity',
    'invalid-known',
    'missing-type',
    'invalid-type'
]) {
    test(`WS-LOOP-13: rejects ${variant} without retry eligibility`, async () => {
        const socket = new Socket();
        const transport = new ResponsesWebSocketTransport(socket, undefined, {
            messageBytes: 512,
            queueBytes: 180,
            firstMs: 120_000,
            idleMs: 180_000
        });
        const handle = transport.begin({ model: 'test', input: [] }, () => undefined);
        if (variant === 'malformed') {
            for (const listener of socket.messages) {
                listener('{"private":"synthetic-secret-payload",');
            }
        }
        if (variant === 'binary') {
            for (const listener of socket.messages) {
                listener(new Uint8Array(1));
            }
        }
        if (variant === 'oversize') {
            socket.emit({ type: 'response.output_text.delta', delta: 'x'.repeat(600) });
        }
        if (variant === 'overflow') {
            socket.emit({ type: 'response.output_text.delta', delta: 'x'.repeat(80) });
            socket.emit({ type: 'response.output_text.delta', delta: 'x'.repeat(80) });
        }
        if (variant === 'identity') {
            socket.emit({ type: 'response.created', response: { id: 'a' } });
            socket.emit({ type: 'response.completed', response: { id: 'b', output: [] } });
        }
        if (variant === 'invalid-known') {
            socket.emit({ type: 'response.output_text.delta', delta: 42 });
        }
        if (variant === 'missing-type') {
            socket.emit({ delta: 'synthetic-secret-payload' });
        }
        if (variant === 'invalid-type') {
            socket.emit({ type: 42, delta: 'synthetic-secret-payload' });
        }
        await assert.rejects(
            async () => {
                for await (const event of handle.events) {
                    assert.ok(event.type);
                }
            },
            (error: unknown) => {
                assert.ok(error instanceof ResponsesTransportFailure);
                assert.equal(error.modelDispatch, 'possibly-sent');
                assert.equal(error.safeToRetry, false);
                assert.equal(error.retryIfNoOutput, false);
                const expectedReasons: Record<string, string> = {
                    malformed: 'Invalid Responses JSON',
                    binary: 'Unsupported binary Responses message',
                    oversize: 'Responses message budget exceeded',
                    overflow: 'Responses event queue budget exceeded',
                    identity: 'Responses identity mismatch',
                    'invalid-known': 'Unsupported or malformed Responses event',
                    'missing-type': 'Unsupported or malformed Responses event',
                    'invalid-type': 'Unsupported or malformed Responses event'
                };
                assert.ok(error.message.includes(expectedReasons[variant]), error.message);
                assert.ok(error.cause instanceof Error);
                assert.equal(error.cause.message.includes('synthetic-secret-payload'), false);
                return true;
            }
        );
        handle.finish(false);
        assert.equal(socket.reusable, false);
        assert.equal(transport.diagnostics().processQueueBytes, 0);
    });
}

test('WS-LOOP-09: sent request without first event can retry only when no output was reported', async () => {
    const socket = new Socket();
    const transport = new ResponsesWebSocketTransport(socket);
    const handle = transport.begin({ model: 'test', input: [] }, () => undefined);
    await socket.close();
    await assert.rejects(
        async () => {
            for await (const event of handle.events) {
                assert.ok(event.type);
            }
        },
        (error: unknown) => {
            assert.ok(error instanceof ResponsesTransportFailure);
            assert.equal(error.acceptance, 'unknown');
            assert.equal(error.safeToRetry, false);
            assert.equal(error.retryIfNoOutput, true);
            return true;
        }
    );
    assert.equal(socket.sent.length, 1);
    handle.finish(false);
});

test('WS-LOOP-11: consumer abandonment closes only its active request', async () => {
    const socket = new Socket();
    const transport = new ResponsesWebSocketTransport(socket);
    const handle = transport.begin({ model: 'test', input: [] }, () => undefined);
    socket.emit({ type: 'response.output_text.delta', delta: 'partial' });
    for await (const event of handle.events) {
        assert.equal(event.type, 'response.output_text.delta');
        break;
    }
    assert.equal(socket.reusable, false);
    handle.finish(false);
    assert.equal(transport.diagnostics().handles, 0);
});
