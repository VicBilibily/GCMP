import { once } from 'node:events';
import { readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import type { RequestListener } from 'node:http';
import { createServer as createSecureServer } from 'node:https';
import { connect } from 'node:net';
import type { Socket } from 'node:net';
import { join } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import WebSocket, { WebSocketServer } from 'ws';
import type { ServerOptions } from 'ws';
import type {
    MockSnapshot,
    MockScenario,
    MockExpectations,
    MockNetwork,
    MockWait
} from '../responsesWebSocketMockProcess.js';
export type {
    MockSnapshot,
    MockScenario,
    MockExpectations,
    MockFunctionTool
} from '../responsesWebSocketMockProcess.js';

const user = (text: string) => ({
    type: 'message',
    role: 'user',
    status: 'completed',
    content: [{ type: 'input_text', text }]
});
const assistant = (text: string) => ({
    type: 'message',
    role: 'assistant',
    status: 'completed',
    content: [{ type: 'output_text', text }]
});
const call = (key: string) => ({
    type: 'function_call',
    call_id: `call-${key}`,
    name: 'lookup',
    arguments: JSON.stringify({ key }),
    status: 'completed'
});
const result = (key: string) => ({
    type: 'function_call_output',
    call_id: `call-${key}`,
    output: `result-${key}`,
    status: 'completed'
});
const reasoning = {
    type: 'reasoning',
    id: 'rs_mock',
    summary: [],
    encrypted_content: 'synthetic-reasoning-ciphertext'
};

const rawInputs = ['', 'not JSON', 'first\nsecond\r\nthird', '"quote" \\path\tend', '\u4e2d\u6587 \ud83d\ude80'];
const wrappedCall = (index: number) => ({
    type: 'function_call',
    call_id: `raw-${index}`,
    name: 'raw',
    arguments: JSON.stringify({ input: rawInputs[index] }),
    status: 'completed'
});
const wrappedResult = (index: number) => ({
    type: 'function_call_output',
    call_id: `raw-${index}`,
    output: `result-${index}`,
    status: 'completed'
});

function roundtripContext(index: number): readonly unknown[] | undefined {
    return [
        [user('first')],
        [user('first'), call('A'), result('A')],
        [user('first'), call('A'), result('A'), call('B'), result('B')],
        [user('first'), call('A'), result('A'), call('B'), result('B'), assistant('done'), user('follow up')],
        [user('adopted summary'), call('C'), result('C')],
        [user('adopted summary'), call('C'), result('C'), call('D'), result('D')]
    ][index - 1];
}

interface Waiter {
    matches(): boolean;
    resolve(): void;
    reject(error: Error): void;
    timer: ReturnType<typeof setTimeout>;
}

function record(value: unknown): value is Record<string, unknown> {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
}

export async function startResponsesMockServer(
    scenario: MockScenario = 'text',
    expected: MockExpectations = {},
    network: MockNetwork = {}
) {
    const tcpSockets = new Set<Socket>();
    const clients = new Set<WebSocket>();
    const waiters = new Set<Waiter>();
    const pendingResponses = new Set<() => void>();
    const proxySockets = new Set<Socket>();
    let proxy: ReturnType<typeof createServer> | ReturnType<typeof createSecureServer> | undefined;
    let tlsErrors = 0;
    let connects = 0;
    let tunnels = 0;
    let authFailures = 0;
    let proxyRejected = 0;
    const tlsMaterial = (name: NonNullable<MockNetwork['tls']>) => {
        const directory = process.env.GCMP_WS_TLS_DIR;
        if (!directory) {
            throw new Error('TLS requires the isolated PowerShell fixture entry');
        }
        return {
            cert: readFileSync(join(directory, `${name}.cert.pem`)),
            key: readFileSync(join(directory, `${name}.key.pem`))
        };
    };
    let accepted = 0;
    let received = 0;
    let httpRequests = 0;
    let httpAccepted = 0;
    let handshakes = 0;
    let sent = 0;
    let full = 0;
    let delta = 0;
    let contextChecks = 0;
    let contextErrors = 0;
    let pings = 0;
    let connectionCount = 0;
    const wireInputItems: number[] = [];
    let protocolErrors = 0;
    let forcedTerminations = 0;
    let stopping = false;
    let cleanup: Promise<void> | undefined;
    const listener: RequestListener = (request, response) => {
        httpRequests++;
        if (request.method !== 'POST' || new URL(request.url || '/', 'http://127.0.0.1').pathname !== '/responses') {
            response.setHeader('content-type', 'application/json');
            response.end(JSON.stringify({ service: 'gcmp-responses-mock', protocol: 1 }));
            return;
        }
        void (async () => {
            const chunks: Buffer[] = [];
            let bytes = 0;
            for await (const chunk of request) {
                const value: unknown = chunk;
                if (!Buffer.isBuffer(value)) {
                    throw new Error('Unexpected HTTP body chunk');
                }
                bytes += value.length;
                if (bytes > 1024 * 1024) {
                    throw new Error('HTTP body budget exceeded');
                }
                chunks.push(value);
            }
            const value: unknown = JSON.parse(Buffer.concat(chunks).toString());
            if (
                !record(value) ||
                value.model !== 'mock-model' ||
                !Array.isArray(value.input) ||
                value.stream !== true ||
                'type' in value ||
                'previous_response_id' in value ||
                'useWebSocket' in value
            ) {
                throw new Error('Invalid HTTP Responses request');
            }
            if (scenario === 'reject-previous') {
                if (!isDeepStrictEqual(value.input, [user('first'), assistant('mock response'), user('next')])) {
                    contextErrors++;
                    throw new Error('Full fallback context mismatch');
                }
                contextChecks++;
            }
            httpAccepted++;
            const responseId = `mock-http-${httpAccepted}`;
            const responseText = expected.httpResponseText ?? 'mock HTTP response';
            const events = [
                { type: 'response.created', response: { id: responseId } },
                {
                    type: 'response.output_text.delta',
                    item_id: 'mock-http-item',
                    output_index: 0,
                    content_index: 0,
                    delta: responseText
                },
                {
                    type: 'response.completed',
                    response: {
                        id: responseId,
                        output: [assistant(responseText)],
                        usage: { input_tokens: 2, output_tokens: 1, total_tokens: 3 }
                    }
                }
            ];
            response.writeHead(200, { 'content-type': 'text/event-stream' });
            response.end(events.map(event => `data: ${JSON.stringify(event)}\n\n`).join('') + 'data: [DONE]\n\n');
        })().catch(() => {
            if (!response.headersSent) {
                response.writeHead(400, { 'content-type': 'application/json' });
            }
            response.end(JSON.stringify({ error: { code: 'mock_http_request', message: 'invalid mock request' } }));
        });
    };
    const server = network.tls ? createSecureServer(tlsMaterial(network.tls), listener) : createServer(listener);
    const options: ServerOptions & { maxFragments: number; maxBufferedChunks: number } = {
        noServer: true,
        perMessageDeflate: false,
        maxPayload: 1024 * 1024,
        maxFragments: 64,
        maxBufferedChunks: 256
    };
    const sockets = new WebSocketServer(options);
    const snapshot = (): MockSnapshot => ({
        listening: server.listening,
        webSockets: clients.size,
        tcpSockets: tcpSockets.size,
        accepted,
        received,
        httpRequests,
        httpAccepted,
        handshakes,
        sent,
        full,
        delta,
        contextChecks,
        contextErrors,
        pings,
        wireInputItems: [...wireInputItems],
        pendingResponses: pendingResponses.size,
        protocolErrors,
        forcedTerminations,
        waiters: waiters.size,
        tlsErrors,
        proxyListening: proxy?.listening === true,
        proxySockets: proxySockets.size,
        connects,
        tunnels,
        authFailures,
        proxyRejected
    });
    const notify = () => {
        for (const waiter of waiters) {
            if (waiter.matches()) {
                clearTimeout(waiter.timer);
                waiters.delete(waiter);
                waiter.resolve();
            }
        }
    };
    server.on('connection', socket => {
        tcpSockets.add(socket);
        socket.on('error', () => undefined);
        socket.once('close', () => {
            tcpSockets.delete(socket);
            notify();
        });
    });
    server.on('tlsClientError', () => {
        tlsErrors++;
        notify();
    });
    server.on('upgrade', (request, socket, head) => {
        handshakes++;
        if (scenario === 'stall-upgrade') {
            socket.on('end', () => socket.end());
            socket.resume();
            notify();
            return;
        }
        if (scenario === 'reject-upgrade' || scenario === 'reject-upgrade-exhausted') {
            const status =
                scenario === 'reject-upgrade-exhausted' && handshakes === 1 ? '429 Too Many Requests' : '404 Not Found';
            socket.end(`HTTP/1.1 ${status}\r\nContent-Length: 0\r\nConnection: close\r\n\r\n`);
            return;
        }
        const url = new URL(request.url || '/', 'http://127.0.0.1');
        if (
            stopping ||
            !['/responses', '/alternate'].includes(url.pathname) ||
            !['Bearer synthetic-mock', 'Bearer synthetic-mock-B'].includes(request.headers.authorization ?? '')
        ) {
            socket.end('HTTP/1.1 403 Forbidden\r\nContent-Length: 0\r\nConnection: close\r\n\r\n');
            return;
        }
        sockets.handleUpgrade(request, socket, head, websocket => sockets.emit('connection', websocket));
    });
    sockets.on('connection', socket => {
        const connectionId = ++connectionCount;
        let requestIndex = 0;
        let previous: { id: string; context: readonly unknown[] } | undefined;
        let pending: (() => void) | undefined;
        const send = (event: unknown, complete?: () => void) => {
            if (socket.readyState !== WebSocket.OPEN) {
                return;
            }
            socket.send(JSON.stringify(event), error => {
                if (error) {
                    protocolErrors++;
                } else {
                    complete?.();
                }
            });
            sent++;
        };
        const reject = (code: string) => {
            send({ type: 'error', status: 400, error: { code, message: `mock request rejected: ${code}` } });
            notify();
        };
        clients.add(socket);
        socket.on('error', () => {
            protocolErrors++;
        });
        socket.once('close', () => {
            clients.delete(socket);
            if (pending) {
                pendingResponses.delete(pending);
                pending = undefined;
            }
            socket.removeAllListeners('message');
            notify();
        });
        socket.on('message', (data, binary) => {
            const fail = () => {
                protocolErrors++;
                socket.close(1008, 'invalid mock request');
            };
            if (binary) {
                fail();
                return;
            }
            try {
                const text =
                    Array.isArray(data) ? Buffer.concat(data).toString()
                    : data instanceof ArrayBuffer ? Buffer.from(data).toString()
                    : data.toString();
                const value: unknown = JSON.parse(text);
                if (
                    !record(value) ||
                    value.type !== 'response.create' ||
                    typeof value.model !== 'string' ||
                    !Array.isArray(value.input) ||
                    'stream' in value ||
                    'useWebSocket' in value ||
                    'turn' in value ||
                    '_telemetryTurn' in value
                ) {
                    fail();
                    return;
                }
                received++;
                requestIndex++;
                if (received > 64) {
                    reject('mock_request_budget');
                    return;
                }
                if (scenario === 'flat-error' || scenario === 'nested-error') {
                    const detail = { code: 'mock_limit', message: 'mock refusal' };
                    send(
                        scenario === 'flat-error' ?
                            { type: 'error', status: 429, ...detail }
                        :   { type: 'error', status: 429, error: detail }
                    );
                    notify();
                    return;
                }
                let context: unknown[];
                if (value.previous_response_id !== undefined) {
                    if (scenario === 'reject-previous' || scenario === 'reject-previous-after-created') {
                        if (scenario === 'reject-previous-after-created') {
                            send({ type: 'response.created', response: { id: 'already-accepted' } });
                        }
                        reject('previous_response_not_found');
                        return;
                    }
                    if (
                        typeof value.previous_response_id !== 'string' ||
                        !previous ||
                        previous.id !== value.previous_response_id
                    ) {
                        reject('previous_response_not_found');
                        return;
                    }
                    context = [...previous.context, ...value.input];
                } else {
                    context = [...value.input];
                }
                if (scenario === 'reject-previous' && received > 1 && !expected.contexts) {
                    if (!isDeepStrictEqual(context, [user('first'), assistant('mock response'), user('next')])) {
                        contextErrors++;
                        reject('mock_full_retry_context_mismatch');
                        return;
                    }
                    contextChecks++;
                }
                if (expected.contexts) {
                    const expectedContext = expected.contexts[accepted];
                    if (
                        !expectedContext ||
                        expectedContext.delta !== (value.previous_response_id !== undefined) ||
                        value.instructions !== expectedContext.instructions ||
                        value.model !== 'mock-model' ||
                        value.store !== false ||
                        value.parallel_tool_calls !== false ||
                        !isDeepStrictEqual(value.tools, expected.tools) ||
                        !isDeepStrictEqual(context, expectedContext.input)
                    ) {
                        contextErrors++;
                        reject('mock_prompt_context_mismatch');
                        return;
                    }
                    contextChecks++;
                }
                const roundtrip = scenario === 'roundtrip-full' || scenario === 'roundtrip-delta';
                const reasoningReplay = scenario === 'reasoning-replay' || scenario === 'reasoning-omitted';
                const reasoningCall = { ...call('A'), arguments: '{\n  "limit": 2, "key": "A"\n}' };
                const replayedReasoningCall = { ...call('A'), arguments: '{"key":"A","limit":2}' };
                const sparseParallel = scenario === 'parallel-done-empty' || scenario === 'parallel-done-reasoning';
                const parallelKeys = ['A', 'B', 'C', 'D', 'E'];
                const parallelOutput = [
                    ...(scenario === 'parallel-done-reasoning' ? [reasoning] : []),
                    assistant('before tools'),
                    ...parallelKeys.map(key => ({ ...call(key), arguments: JSON.stringify({ limit: 2, key }) }))
                ];
                if (sparseParallel) {
                    const expectedContext = [
                        user('first'),
                        ...(requestIndex > 1 ? [...parallelOutput, ...parallelKeys.map(result)] : []),
                        ...(requestIndex === 3 ? [assistant('mock response'), user('next')] : [])
                    ];
                    if (
                        requestIndex > 3 ||
                        requestIndex > 1 !== (value.previous_response_id !== undefined) ||
                        !isDeepStrictEqual(value.tools, expected.tools) ||
                        !isDeepStrictEqual(context, expectedContext)
                    ) {
                        contextErrors++;
                        reject('mock_completed_output_context_mismatch');
                        return;
                    }
                    contextChecks++;
                }
                const customWrapped = scenario === 'custom-wrapped-full' || scenario === 'custom-wrapped-delta';
                if (customWrapped) {
                    const expectedContext = [
                        user('first'),
                        ...rawInputs
                            .slice(0, requestIndex - 1)
                            .flatMap((_input, index) => [wrappedCall(index), wrappedResult(index)])
                    ];
                    if (
                        requestIndex > rawInputs.length + 1 ||
                        (scenario === 'custom-wrapped-delta' && requestIndex > 1) !==
                            (value.previous_response_id !== undefined) ||
                        value.instructions !== expected.instructions ||
                        !isDeepStrictEqual(value.tools, expected.tools) ||
                        !isDeepStrictEqual(context, expectedContext)
                    ) {
                        contextErrors++;
                        reject('mock_custom_wrapper_context_mismatch');
                        return;
                    }
                    contextChecks++;
                }
                if (reasoningReplay) {
                    const replayReasoning =
                        scenario !== 'reasoning-omitted' &&
                        Array.isArray(value.include) &&
                        value.include.includes('reasoning.encrypted_content');
                    const expectedContext =
                        requestIndex === 1 ?
                            [user('first')]
                        :   [
                                user('first'),
                                ...(replayReasoning ? [reasoning] : []),
                                assistant('before tool'),
                                value.previous_response_id !== undefined ? reasoningCall : replayedReasoningCall,
                                result('A'),
                                ...(requestIndex === 3 ? [assistant('mock response'), user('next')] : [])
                            ];
                    if (
                        (replayReasoning && requestIndex > 1) !== (value.previous_response_id !== undefined) ||
                        !isDeepStrictEqual(context, expectedContext)
                    ) {
                        contextErrors++;
                        reject('mock_reasoning_context_mismatch');
                        return;
                    }
                    contextChecks++;
                }
                if (scenario === 'parallel-tools') {
                    const expectedContext =
                        requestIndex === 1 ?
                            [user('first')]
                        :   [user('first'), call('A'), call('B'), result('A'), result('B')];
                    if (!isDeepStrictEqual(context, expectedContext)) {
                        contextErrors++;
                        reject('mock_context_mismatch');
                        return;
                    }
                    contextChecks++;
                }
                if (roundtrip) {
                    const requiresDelta = scenario === 'roundtrip-delta' && ![1, 5].includes(requestIndex);
                    const semanticMatch =
                        value.model === 'mock-model' &&
                        value.store === false &&
                        value.parallel_tool_calls === false &&
                        value.instructions === (expected.instructions ?? 'mock instructions') &&
                        isDeepStrictEqual(
                            value.tools,
                            expected.tools ?? [
                                {
                                    type: 'function',
                                    name: 'lookup',
                                    parameters: { type: 'object', properties: { key: { type: 'string' } } }
                                }
                            ]
                        );
                    if (
                        !semanticMatch ||
                        requiresDelta !== (value.previous_response_id !== undefined) ||
                        !isDeepStrictEqual(context, roundtripContext(requestIndex))
                    ) {
                        contextErrors++;
                        reject('mock_context_mismatch');
                        return;
                    }
                    contextChecks++;
                }
                accepted++;
                if (value.previous_response_id !== undefined) {
                    delta++;
                } else {
                    full++;
                }
                wireInputItems.push(value.input.length);
                const responseId = `mock-response-${connectionId}-${requestIndex}`;
                if (scenario === 'accepted-close' || (scenario === 'usage-sequence' && accepted === 3)) {
                    socket.close(1000);
                    notify();
                    return;
                }
                if (scenario === 'accepted-silent') {
                    notify();
                    return;
                }
                if (scenario === 'ping-only') {
                    socket.ping('mock-control');
                    pings++;
                    notify();
                    return;
                }
                if (scenario === 'malformed') {
                    socket.send('{');
                    sent++;
                    notify();
                    return;
                }
                if (scenario === 'binary') {
                    socket.send(Buffer.from('mock binary'));
                    sent++;
                    notify();
                    return;
                }
                if (scenario === 'unknown-terminal') {
                    send({ type: 'response.future_terminal' });
                    notify();
                    return;
                }
                const replyText =
                    scenario === 'fragmented' ? 'mock response \u4e2d\u6587'
                    : roundtrip ?
                        requestIndex === 3 ?
                            'done'
                        :   'after summary'
                    :   (expected.responseText ?? 'mock response');
                const output =
                    customWrapped && requestIndex <= rawInputs.length ? [wrappedCall(requestIndex - 1)]
                    : sparseParallel && requestIndex === 1 ? parallelOutput
                    : reasoningReplay && requestIndex === 1 ? [reasoning, assistant('before tool'), reasoningCall]
                    : scenario === 'parallel-tools' && requestIndex === 1 ? [call('A'), call('B')]
                    : roundtrip && [1, 2, 4, 5].includes(requestIndex) ?
                        [call(({ 1: 'A', 2: 'B', 4: 'C', 5: 'D' } as Record<number, string>)[requestIndex])]
                    :   [assistant(replyText)];
                previous = { id: responseId, context: [...context, ...output] };
                const usage =
                    scenario === 'usage-sequence' ?
                        { input_tokens: accepted * 11, output_tokens: accepted * 3, total_tokens: accepted * 14 }
                    :   { input_tokens: 2, output_tokens: 1, total_tokens: 3 };
                const terminal = {
                    type: 'response.completed',
                    response: {
                        id: responseId,
                        output: sparseParallel ? output.filter(item => item.type === 'reasoning') : output,
                        usage
                    }
                };
                if (scenario === 'failed' || scenario === 'cancelled' || scenario === 'incomplete') {
                    send({
                        type: `response.${scenario}`,
                        response: {
                            id: responseId,
                            output: [],
                            ...(scenario === 'cancelled' ? { usage } : {}),
                            error: { code: 'mock_terminal', message: 'mock terminal' },
                            incomplete_details: { reason: 'max_output_tokens' }
                        }
                    });
                    notify();
                    return;
                }
                const auxiliaryEvents =
                    scenario === 'auxiliary-events' ?
                        [
                            {
                                type: 'codex.rate_limits',
                                plan_type: 'pro',
                                rate_limits: { allowed: false, limit_reached: true }
                            },
                            {
                                type: 'codex.response.metadata',
                                headers: { 'x-models-etag': 'synthetic-etag' }
                            },
                            { type: 'response.metadata', response_id: 'not-a-generation-response' },
                            { type: 'responsesapi.websocket_timing' },
                            { type: 'keepalive' }
                        ]
                    :   [];
                for (const event of auxiliaryEvents) {
                    send(event);
                }
                send({ type: 'response.created', response: { id: responseId } });
                if (sparseParallel || reasoningReplay) {
                    send({ type: 'response.in_progress', response: { id: responseId, status: 'in_progress' } });
                }
                if (sparseParallel) {
                    for (const [index, item] of output.entries()) {
                        const itemId = 'id' in item ? item.id : `${responseId}-item-${index}`;
                        if ('arguments' in item) {
                            send({
                                type: 'response.output_item.added',
                                output_index: index,
                                item: { ...item, id: itemId, arguments: '', status: 'in_progress' }
                            });
                            send({
                                type: 'response.function_call_arguments.done',
                                output_index: index,
                                item_id: itemId,
                                name: item.name,
                                arguments: item.arguments
                            });
                        } else if ('content' in item) {
                            send({
                                type: 'response.output_text.delta',
                                output_index: index,
                                content_index: 0,
                                item_id: itemId,
                                delta: item.content.map(part => part.text).join('')
                            });
                        }
                        send({ type: 'response.output_item.done', output_index: index, item: { ...item, id: itemId } });
                    }
                    send(terminal);
                    notify();
                    return;
                }
                if (reasoningReplay && requestIndex === 1) {
                    send({ type: 'response.output_item.done', output_index: 0, item: reasoning });
                    send({
                        type: 'response.output_text.delta',
                        item_id: 'reasoning-preface',
                        content_index: 0,
                        output_index: 1,
                        delta: 'before tool'
                    });
                }
                if (scenario === 'identity') {
                    send({ ...terminal, response: { ...terminal.response, id: 'foreign-response' } });
                    notify();
                    return;
                }
                if (scenario === 'idle-after-created') {
                    notify();
                    return;
                }
                if (scenario === 'paused') {
                    const release = () => {
                        pendingResponses.delete(release);
                        pending = undefined;
                        send({
                            type: 'response.output_text.delta',
                            item_id: 'mock-item',
                            content_index: 0,
                            output_index: 0,
                            delta: replyText
                        });
                        send(terminal);
                        notify();
                    };
                    pending = release;
                    pendingResponses.add(release);
                    notify();
                    return;
                }
                const deltaEvent = {
                    type: 'response.output_text.delta',
                    item_id: 'mock-item',
                    content_index: 0,
                    output_index: 0,
                    delta: replyText
                };
                if (scenario === 'oversize' || scenario === 'queue-overflow') {
                    send({ ...deltaEvent, delta: 'x'.repeat(4096) });
                    notify();
                    return;
                }
                if (scenario === 'process-pressure') {
                    for (let index = 0; index < (accepted === 6 ? 2 : 3); index++) {
                        send({ ...deltaEvent, delta: 'x'.repeat(8 * 1024 * 1024 - 1024) });
                    }
                    notify();
                    return;
                }
                if (scenario === 'fragmented-overlimit') {
                    const bytes = Buffer.from(JSON.stringify({ ...deltaEvent, delta: 'x'.repeat(17 * 1024 * 1024) }));
                    for (let offset = 0; offset < bytes.length; offset += 1024 * 1024) {
                        const end = Math.min(offset + 1024 * 1024, bytes.length);
                        socket.send(bytes.subarray(offset, end), { binary: false, fin: end === bytes.length });
                    }
                    sent++;
                    notify();
                    return;
                }
                if (
                    (!roundtrip || [3, 6].includes(requestIndex)) &&
                    (!customWrapped || requestIndex > rawInputs.length) &&
                    !((scenario === 'parallel-tools' || reasoningReplay) && requestIndex === 1)
                ) {
                    if (scenario === 'fragmented') {
                        const bytes = Buffer.from(JSON.stringify(deltaEvent));
                        const split = bytes.indexOf(Buffer.from('\u4e2d')) + 1;
                        socket.send(bytes.subarray(0, split), { binary: false, fin: false });
                        socket.send(bytes.subarray(split), { binary: false, fin: true });
                        sent++;
                    } else {
                        send(deltaEvent);
                    }
                }
                if (scenario === 'partial-close') {
                    socket.close(1000);
                    notify();
                    return;
                }
                send(terminal, scenario === 'completed-close' ? () => socket.close(1000) : undefined);
                for (const event of auxiliaryEvents) {
                    send(event);
                }
                if (scenario === 'duplicate-terminal') {
                    send(terminal);
                }
                notify();
            } catch {
                fail();
            }
        });
        notify();
    });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const address = server.address();
    if (!address || typeof address === 'string') {
        throw new Error('Mock did not bind loopback');
    }
    let proxyUrl: string | undefined;
    if (network.proxy) {
        const rejectHttp: RequestListener = (_request, response) => {
            proxyRejected++;
            response.writeHead(405, { connection: 'close' });
            response.end();
        };
        proxy = network.secureProxy ? createSecureServer(tlsMaterial('valid'), rejectHttp) : createServer(rejectHttp);
        const track = (socket: Socket) => {
            proxySockets.add(socket);
            socket.on('error', () => undefined);
            socket.once('close', () => {
                proxySockets.delete(socket);
                notify();
            });
        };
        proxy.on('connection', track);
        proxy.on('tlsClientError', () => {
            tlsErrors++;
            notify();
        });
        proxy.on('connect', (request, client, head) => {
            connects++;
            if (
                network.proxy === 'auth' &&
                request.headers['proxy-authorization'] !==
                    `Basic ${Buffer.from('fixture:synthetic-proxy').toString('base64')}`
            ) {
                authFailures++;
                client.end(
                    'HTTP/1.1 407 Proxy Authentication Required\r\nContent-Length: 0\r\nConnection: close\r\n\r\n'
                );
                return;
            }
            if (request.url !== `127.0.0.1:${address.port}` || network.proxy === 'reject') {
                proxyRejected++;
                client.end('HTTP/1.1 403 Forbidden\r\nContent-Length: 0\r\nConnection: close\r\n\r\n');
                return;
            }
            if (network.proxy === 'stall') {
                client.on('end', () => client.end());
                client.resume();
                notify();
                return;
            }
            if (network.proxy === 'disconnect') {
                client.destroy();
                return;
            }
            const target = connect({ host: '127.0.0.1', port: address.port });
            track(target);
            target.once('connect', () => {
                tunnels++;
                client.write('HTTP/1.1 200 Connection Established\r\n\r\n');
                if (head.length) {
                    target.write(head);
                }
                client.pipe(target);
                target.pipe(client);
                notify();
            });
            client.once('close', () => target.destroy());
            target.once('close', () => client.destroy());
            target.once('error', () => client.destroy());
        });
        proxy.listen(0, '127.0.0.1');
        await once(proxy, 'listening');
        const proxyAddress = proxy.address();
        if (!proxyAddress || typeof proxyAddress === 'string') {
            throw new Error('Proxy did not bind loopback');
        }
        proxyUrl = `${network.secureProxy ? 'https' : 'http'}://127.0.0.1:${proxyAddress.port}`;
    }
    return {
        url: `${network.tls ? 'wss' : 'ws'}://127.0.0.1:${address.port}/responses`,
        origin: `${network.tls ? 'https' : 'http'}://127.0.0.1:${address.port}`,
        proxyUrl,
        snapshot,
        releasePending(): void {
            for (const release of [...pendingResponses]) {
                release();
            }
        },
        sendIdleEvent(): void {
            for (const socket of clients) {
                socket.send(JSON.stringify({ type: 'response.output_text.delta', delta: 'unexpected idle event' }));
                sent++;
            }
        },
        waitFor(expected: MockWait): Promise<void> {
            const matches = () =>
                Object.entries(expected).every(([key, value]) => snapshot()[key as keyof MockSnapshot] === value);
            if (matches()) {
                return Promise.resolve();
            }
            return new Promise((resolve, reject) => {
                const timer = setTimeout(() => {
                    waiters.delete(waiter);
                    reject(new Error('Mock observation deadline exceeded'));
                }, 3_000);
                const waiter: Waiter = { matches, resolve, reject, timer };
                waiters.add(waiter);
            });
        },
        stop(): Promise<void> {
            if (cleanup) {
                return cleanup;
            }
            stopping = true;
            for (const waiter of waiters) {
                clearTimeout(waiter.timer);
                waiter.reject(new Error('Mock stopped'));
            }
            waiters.clear();
            pendingResponses.clear();
            forcedTerminations += clients.size + proxySockets.size;
            for (const client of clients) {
                client.terminate();
            }
            for (const socket of tcpSockets) {
                socket.destroy();
            }
            for (const socket of proxySockets) {
                socket.destroy();
            }
            cleanup = Promise.all([
                ...(proxy ?
                    [new Promise<void>((resolve, reject) => proxy.close(error => (error ? reject(error) : resolve())))]
                :   []),
                new Promise<void>((resolve, reject) => sockets.close(error => (error ? reject(error) : resolve()))),
                new Promise<void>((resolve, reject) => server.close(error => (error ? reject(error) : resolve())))
            ]).then(() => undefined);
            return cleanup;
        }
    };
}
