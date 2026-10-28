import type { Dispatcher } from 'undici';
import * as framing from 'ws';
import { createHash, randomBytes } from 'node:crypto';
import type { Duplex, Writable } from 'node:stream';
import type { ResponsesProcessorEvent } from '../openaiResponsesStreamProcessor';
import type { ResponsesClock, ResponsesConnection } from './responsesConnectionPool';
import { responsesClock } from './responsesConnectionPool';
import { markAsNonCancellationError } from '../../../utils/text/cancellationError';
import type { ProxyDispatcherLease } from '../../../utils/net/proxyAgent';

export class ResponsesTransportFailure extends Error {
    constructor(
        message: string,
        readonly phase: 'handshake' | 'send' | 'receive' | 'consume',
        readonly modelDispatch: 'not-sent' | 'possibly-sent',
        readonly acceptance: 'unknown' | 'rejected' | 'accepted' = 'unknown',
        readonly status?: number,
        readonly code?: string,
        cause?: unknown,
        readonly retryIfNoOutput = false
    ) {
        super(message, { cause });
        this.name = 'ResponsesTransportFailure';
        if (phase === 'handshake') {
            markAsNonCancellationError(this);
        }
    }

    get safeToRetry(): boolean {
        return this.modelDispatch === 'not-sent' || this.retryWithFullContext;
    }

    get retryWithFullContext(): boolean {
        return (
            this.phase === 'receive' &&
            this.acceptance === 'rejected' &&
            this.status === 400 &&
            this.code === 'previous_response_not_found'
        );
    }
}

export interface ResponsesSocket {
    readonly opened: Promise<void>;
    readonly closed: Promise<void>;
    readonly reusable: boolean;
    send(frame: string): void;
    onMessage(listener: (data: unknown) => void): () => void;
    onDisconnect(listener: (error?: Error) => void): () => void;
    close(): Promise<void>;
}

export interface ResponsesWebSocketOptions {
    url: string;
    headers: Record<string, string>;
    dispatcher: Dispatcher;
    abortPending?: () => Promise<void>;
    clock?: ResponsesClock;
    handshakeMs?: number;
    gracefulMs?: number;
    closeMs?: number;
}

interface FrameSender {
    send(
        data: string,
        options: { binary: boolean; compress: boolean; fin: boolean; mask: boolean },
        callback: (error?: Error) => void
    ): void;
    pong(data: Buffer, mask: boolean, callback: (error?: Error) => void): void;
    close(code: number | undefined, data: Buffer, mask: boolean, callback: (error?: Error) => void): void;
}

const { Receiver, Sender } = framing as unknown as {
    Receiver: new (options: {
        isServer: boolean;
        maxPayload: number;
        maxFragments: number;
        maxBufferedChunks: number;
    }) => Writable;
    Sender: new (socket: Duplex) => FrameSender;
};

export class UndiciResponsesSocket implements ResponsesSocket {
    readonly opened: Promise<void>;
    readonly closed: Promise<void>;
    private resolveOpen!: () => void;
    private rejectOpen!: (error: Error) => void;
    private resolveClosed!: () => void;
    private readonly clock: ResponsesClock;
    private receiver?: Writable;
    private sender?: FrameSender;
    private sentClose = false;
    private receivedClose = false;
    private socket?: Duplex;
    private abortUpgrade?: (error?: Error) => void;
    private closing = false;
    private physicalClosed = false;
    private status?: number;
    private cleanup?: Promise<void>;
    private readonly messages = new Set<(data: unknown) => void>();
    private readonly disconnects = new Set<(error?: Error) => void>();
    private receiveError?: Error;
    private cancelHandshake?: () => void;
    private pendingAbort?: Promise<void>;

    constructor(private readonly options: ResponsesWebSocketOptions) {
        this.clock = options.clock ?? responsesClock;
        this.opened = new Promise<void>((resolve, reject) => {
            this.resolveOpen = resolve;
            this.rejectOpen = reject;
        });
        this.closed = new Promise<void>(resolve => {
            this.resolveClosed = resolve;
        });
        void this.opened.catch(() => undefined);
        this.cancelHandshake = this.clock.schedule(() => {
            this.rejectOpen(this.handshakeFailure(new Error('Responses handshake deadline exceeded')));
            void this.close().catch(() => undefined);
        }, options.handshakeMs ?? 15_000);
        const url = new URL(options.url);
        if (!['ws:', 'wss:'].includes(url.protocol) || url.username || url.password || url.hash) {
            this.onHandshakeError(new Error('Invalid Responses WebSocket URL'));
            return;
        }
        url.protocol = url.protocol === 'wss:' ? 'https:' : 'http:';
        const key = randomBytes(16).toString('base64');
        const headers = Object.fromEntries(
            Object.entries(options.headers).filter(([name]) => !/^(connection|upgrade|sec-websocket-)/i.test(name))
        );
        try {
            options.dispatcher.dispatch(
                {
                    origin: url.origin,
                    path: `${url.pathname}${url.search}`,
                    method: 'GET',
                    upgrade: 'websocket',
                    headers: { ...headers, 'sec-websocket-key': key, 'sec-websocket-version': '13' }
                },
                {
                    onConnect: abort => {
                        this.abortUpgrade = abort;
                        if (this.closing) {
                            abort(new Error('Responses handshake cancelled'));
                        }
                    },
                    onUpgrade: (status, responseHeaders, socket) => {
                        this.acceptUpgrade(status, responseHeaders, socket, key);
                    },
                    onHeaders: status => {
                        this.status = status;
                        this.rejectOpen(this.handshakeFailure(new Error('Responses Upgrade rejected')));
                        void this.close().catch(() => undefined);
                        return false;
                    },
                    onData: () => false,
                    onError: error => this.onHandshakeError(error),
                    onComplete: () => {
                        if (!this.socket && !this.pendingAbort) {
                            this.confirmClosed();
                        }
                    }
                }
            );
        } catch (error) {
            this.onHandshakeError(error);
        }
    }

    get reusable(): boolean {
        return !this.closing && !this.physicalClosed && !!this.sender;
    }
    send(frame: string): void {
        if (!this.reusable || !this.sender) {
            throw new Error('Responses WebSocket is not open');
        }
        this.sender.send(frame, { binary: false, compress: false, fin: true, mask: true }, this.onWrite);
    }
    onMessage(listener: (data: unknown) => void): () => void {
        this.messages.add(listener);
        return () => {
            this.messages.delete(listener);
        };
    }
    onDisconnect(listener: (error?: Error) => void): () => void {
        this.disconnects.add(listener);
        return () => {
            this.disconnects.delete(listener);
        };
    }

    close(): Promise<void> {
        if (this.cleanup) {
            return this.cleanup;
        }
        this.closing = true;
        this.cancelHandshake?.();
        this.rejectOpen(this.handshakeFailure(new Error('Responses connection closed')));
        this.cleanup = new Promise<void>((resolve, reject) => {
            const force = () => {
                if (this.socket) {
                    this.socket.destroy();
                } else if (this.options.abortPending) {
                    if (!this.pendingAbort) {
                        this.pendingAbort = Promise.resolve().then(() => this.options.abortPending!());
                        void this.pendingAbort.then(
                            () => this.confirmClosed(),
                            () => undefined
                        );
                    }
                } else {
                    this.abortUpgrade?.(new Error('Responses handshake cancelled'));
                }
            };
            const cancelForce = this.clock.schedule(force, this.options.gracefulMs ?? 4_000);
            const cancelDeadline = this.clock.schedule(() => {
                cancelForce();
                reject(new Error('Responses physical connection release deadline exceeded'));
            }, this.options.closeMs ?? 5_000);
            void this.closed.then(() => {
                cancelForce();
                cancelDeadline();
                resolve();
            });
            try {
                if (!this.sender) {
                    force();
                } else {
                    this.sendClose(1000, Buffer.alloc(0));
                }
            } catch {
                force();
            }
        });
        return this.cleanup;
    }

    private acceptUpgrade(status: number, headers: Buffer[] | string[] | null, socket: Duplex, key: string): void {
        this.socket = socket;
        socket.once('close', () => this.confirmClosed());
        socket.on('error', () => socket.destroy());
        socket.on('end', () => socket.end());
        if (this.closing) {
            socket.destroy();
            return;
        }
        const values = new Map<string, string>();
        for (let index = 0; headers && index < headers.length; index += 2) {
            const name = headers[index].toString().toLowerCase();
            const value = headers[index + 1]?.toString() ?? '';
            values.set(name, values.has(name) ? `${values.get(name)},${value}` : value);
        }
        const expected = createHash('sha1').update(`${key}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`).digest('base64');
        if (
            status !== 101 ||
            values.get('upgrade')?.toLowerCase() !== 'websocket' ||
            !values
                .get('connection')
                ?.toLowerCase()
                .split(/\s*,\s*/)
                .includes('upgrade') ||
            values.get('sec-websocket-accept') !== expected ||
            values.has('sec-websocket-extensions') ||
            values.has('sec-websocket-protocol')
        ) {
            this.rejectOpen(this.handshakeFailure(new Error('Invalid Responses Upgrade response')));
            socket.destroy();
            return;
        }
        const receiver = new Receiver({
            isServer: false,
            maxPayload: 16 * 1024 * 1024,
            maxFragments: 4096,
            maxBufferedChunks: 4096
        });
        this.receiver = receiver;
        this.sender = new Sender(socket);
        receiver.on('message', (data: Buffer, binary: boolean) => {
            if (!this.closing) {
                const message = binary ? data : data.toString('utf8');
                for (const listener of this.messages) {
                    listener(message);
                }
            }
        });
        receiver.on('ping', (data: Buffer) => {
            if (!this.closing) {
                this.sender?.pong(data, true, this.onWrite);
            }
        });
        receiver.on('conclude', (code: number, reason: Buffer) => {
            this.receivedClose = true;
            this.closing = true;
            this.sendClose(code === 1005 ? undefined : code, reason);
            void this.close().catch(() => undefined);
        });
        receiver.on('error', (error: Error) => {
            this.receiveError = error;
            socket.destroy();
        });
        this.cancelHandshake?.();
        this.resolveOpen();
        socket.pipe(receiver);
    }

    private readonly onWrite = (error?: Error) => {
        if (error) {
            this.socket?.destroy();
        }
    };

    private sendClose(code: number | undefined, reason: Buffer): void {
        if (this.sentClose) {
            if (this.receivedClose) {
                this.socket?.end();
            }
            return;
        }
        this.sentClose = true;
        this.sender?.close(code, reason, true, error => {
            this.onWrite(error);
            if (this.receivedClose) {
                this.socket?.end();
            }
        });
    }

    private onHandshakeError(error: unknown): void {
        this.rejectOpen(this.handshakeFailure(error));
        if (!this.socket && !this.pendingAbort) {
            this.confirmClosed();
        }
    }

    private handshakeFailure(cause: unknown): ResponsesTransportFailure {
        return new ResponsesTransportFailure(
            'Responses WebSocket handshake failed',
            'handshake',
            'not-sent',
            this.status ? 'rejected' : 'unknown',
            this.status,
            undefined,
            cause
        );
    }

    private confirmClosed(): void {
        if (this.physicalClosed) {
            return;
        }
        this.physicalClosed = true;
        this.closing = true;
        this.cancelHandshake?.();
        this.rejectOpen(this.handshakeFailure(new Error('Responses connection disconnected')));
        for (const listener of this.disconnects) {
            listener(this.receiveError);
        }
        this.messages.clear();
        this.disconnects.clear();
        if (this.receiver) {
            this.socket?.unpipe(this.receiver);
            this.receiver.destroy();
            this.receiver.removeAllListeners();
            this.receiver = undefined;
        }
        this.sender = undefined;
        this.socket = undefined;
        this.abortUpgrade = undefined;
        this.resolveClosed();
    }
}

function object(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

const deltaTypes = new Set([
    'response.output_text.delta',
    'response.refusal.delta',
    'response.reasoning_text.delta',
    'response.reasoning_summary_text.delta',
    'response.function_call_arguments.delta'
]);
const terminalTypes = new Set(['response.completed', 'response.incomplete', 'response.failed', 'response.cancelled']);
const webSearchTypes = new Set([
    'response.web_search_call.in_progress',
    'response.web_search_call.searching',
    'response.web_search_call.completed'
]);
const auxiliaryTypes = new Set([
    'codex.rate_limits',
    'codex.response.metadata',
    'response.metadata',
    'responsesapi.websocket_timing',
    'keepalive'
]);
const passiveTypes = new Set([
    'response.in_progress',
    'response.content_part.added',
    'response.content_part.done',
    'response.reasoning_summary_part.added',
    'response.reasoning_summary_part.done'
]);
const knownTypes = new Set([
    ...deltaTypes,
    ...terminalTypes,
    ...webSearchTypes,
    ...passiveTypes,
    'error',
    'response.created',
    'response.output_text.done',
    'response.reasoning_text.done',
    'response.reasoning_summary_text.done',
    'response.refusal.done',
    'response.function_call_arguments.done',
    'response.output_item.added',
    'response.output_item.done',
    'response.output_text.annotation.added'
]);

function validItem(value: unknown): boolean {
    if (!object(value) || typeof value.type !== 'string') {
        return false;
    }
    for (const field of ['id', 'call_id', 'name', 'arguments', 'encrypted_content']) {
        if (value[field] !== undefined && value[field] !== null && typeof value[field] !== 'string') {
            return false;
        }
    }
    if (
        value.content !== undefined &&
        (!Array.isArray(value.content) ||
            !value.content.every(
                part =>
                    object(part) &&
                    typeof part.type === 'string' &&
                    (part.text === undefined || typeof part.text === 'string')
            ))
    ) {
        return false;
    }
    return true;
}

function validEvent(value: unknown): value is ResponsesProcessorEvent {
    if (!object(value) || typeof value.type !== 'string') {
        return false;
    }
    for (const field of ['item_id', 'call_id', 'name', 'response_id']) {
        if (value[field] !== undefined && typeof value[field] !== 'string') {
            return false;
        }
    }
    for (const field of ['output_index', 'content_index', 'summary_index', 'sequence_number']) {
        if (value[field] !== undefined && (!Number.isInteger(value[field]) || Number(value[field]) < 0)) {
            return false;
        }
    }
    if (deltaTypes.has(value.type)) {
        return typeof value.delta === 'string';
    }
    if (webSearchTypes.has(value.type)) {
        return typeof value.item_id === 'string' && typeof value.output_index === 'number';
    }
    if (
        value.type === 'response.output_text.done' ||
        value.type === 'response.reasoning_text.done' ||
        value.type === 'response.reasoning_summary_text.done'
    ) {
        return typeof value.text === 'string';
    }
    if (value.type === 'response.refusal.done') {
        return typeof value.refusal === 'string';
    }
    if (value.type === 'response.function_call_arguments.done') {
        return typeof value.arguments === 'string';
    }
    if (value.type === 'response.output_item.added' || value.type === 'response.output_item.done') {
        return validItem(value.item);
    }
    if (value.type === 'response.output_text.annotation.added') {
        return object(value.annotation);
    }
    if (value.type === 'response.created' || terminalTypes.has(value.type)) {
        if (!object(value.response) || typeof value.response.id !== 'string') {
            return false;
        }
        if (
            value.type === 'response.completed' &&
            (!Array.isArray(value.response.output) || !value.response.output.every(validItem))
        ) {
            return false;
        }
        if (value.response.usage !== undefined && value.response.usage !== null) {
            if (!object(value.response.usage)) {
                return false;
            }
            for (const field of ['input_tokens', 'output_tokens', 'total_tokens']) {
                if (
                    typeof value.response.usage[field] !== 'number' ||
                    Number(value.response.usage[field]) < 0 ||
                    !Number.isFinite(value.response.usage[field])
                ) {
                    return false;
                }
            }
        }
        return true;
    }
    return passiveTypes.has(value.type);
}

let processQueueBytes = 0;

class EventQueue implements AsyncIterable<ResponsesProcessorEvent> {
    private items: Array<{ event: ResponsesProcessorEvent; bytes: number }> = [];
    private waiter?: {
        resolve: (result: IteratorResult<ResponsesProcessorEvent>) => void;
        reject: (error: Error) => void;
    };
    private ended = false;
    private error?: Error;
    private retainedBytes = 0;
    bytes = 0;

    constructor(
        private readonly maximum: number,
        private readonly abandoned: () => void
    ) {}

    push(event: ResponsesProcessorEvent, bytes: number): void {
        if (this.ended || this.error) {
            throw new Error('Responses event after terminal');
        }
        if (this.waiter) {
            const waiter = this.waiter;
            this.waiter = undefined;
            waiter.resolve({ value: event, done: false });
            return;
        }
        if (this.bytes + this.retainedBytes + bytes > this.maximum || processQueueBytes + bytes > 128 * 1024 * 1024) {
            throw new Error('Responses event queue budget exceeded');
        }
        this.items.push({ event, bytes });
        this.bytes += bytes;
        processQueueBytes += bytes;
    }
    retain(bytes: number): void {
        if (this.bytes + this.retainedBytes + bytes > this.maximum || processQueueBytes + bytes > 128 * 1024 * 1024) {
            throw new Error('Responses output retention budget exceeded');
        }
        this.retainedBytes += bytes;
        processQueueBytes += bytes;
    }
    releaseRetained(): void {
        processQueueBytes -= this.retainedBytes;
        this.retainedBytes = 0;
    }
    end(): void {
        this.ended = true;
        this.waiter?.resolve({ value: undefined, done: true });
        this.waiter = undefined;
    }
    fail(error: Error): void {
        if (this.error) {
            return;
        }
        this.clear();
        this.releaseRetained();
        this.error = error;
        this.waiter?.reject(error);
        this.waiter = undefined;
    }
    clear(): void {
        processQueueBytes -= this.bytes;
        this.bytes = 0;
        this.items = [];
    }
    [Symbol.asyncIterator](): AsyncIterator<ResponsesProcessorEvent> {
        return {
            next: () => {
                if (this.error) {
                    return Promise.reject(this.error);
                }
                const item = this.items.shift();
                if (item) {
                    this.bytes -= item.bytes;
                    processQueueBytes -= item.bytes;
                    return Promise.resolve({ value: item.event, done: false });
                }
                if (this.ended) {
                    return Promise.resolve({ value: undefined, done: true });
                }
                if (this.waiter) {
                    return Promise.reject(new Error('Concurrent Responses event consumers'));
                }
                return new Promise((resolve, reject) => {
                    this.waiter = { resolve, reject };
                });
            },
            return: async () => {
                if (!this.ended && !this.error) {
                    this.abandoned();
                }
                this.clear();
                return { value: undefined, done: true };
            }
        };
    }
}

export interface ResponsesTerminalReceipt {
    readonly type: 'response.completed' | 'response.incomplete' | 'response.failed' | 'response.cancelled';
    readonly responseId: string;
    readonly output: readonly unknown[];
    readonly outputComplete?: boolean;
    readonly outputIncompleteReason?:
        | 'unindexed-output'
        | 'duplicate-output-index'
        | 'duplicate-item-id'
        | 'terminal-item-conflict'
        | 'output-index-gap'
        | 'missing-output-item';
}

export interface ResponsesRequestHandle {
    readonly events: AsyncIterable<ResponsesProcessorEvent>;
    readonly receipt: ResponsesTerminalReceipt | undefined;
    readonly acceptance: 'unknown' | 'accepted';
    finish(success: boolean): void;
}

interface ActiveRequest {
    queue: EventQueue;
    dispatched: boolean;
    accepted: boolean;
    previousResponseId?: string;
    responseId?: string;
    receipt?: ResponsesTerminalReceipt;
    outputItems: Map<number, unknown>;
    lastOutputIndex: number;
    outputIncompleteReason?: ResponsesTerminalReceipt['outputIncompleteReason'];
    cancelDeadline?: () => void;
    eventDeadline: number;
}

export class ResponsesWebSocketTransport implements ResponsesConnection {
    readonly opened: Promise<void>;
    readonly closed: Promise<void>;
    private active?: ActiveRequest;
    private invalid = false;
    private cleanup?: Promise<void>;
    private closingAt?: number;
    private readonly unsubscribeMessage: () => void;
    private readonly unsubscribeClose: () => void;

    constructor(
        private readonly socket: ResponsesSocket,
        private readonly clock: ResponsesClock = responsesClock,
        private readonly limits = {
            messageBytes: 16 * 1024 * 1024,
            queueBytes: 32 * 1024 * 1024,
            firstMs: 120_000,
            idleMs: 180_000
        },
        private readonly network?: Pick<ProxyDispatcherLease, 'release' | 'abortPending'>,
        private readonly onUnknownEvent?: (eventType: string) => void
    ) {
        this.opened = socket.opened;
        this.closed = network ? socket.closed.then(() => this.releaseDispatcher()) : socket.closed;
        void this.closed.catch(() => undefined);
        this.unsubscribeMessage = socket.onMessage(data => this.receive(data));
        this.unsubscribeClose = socket.onDisconnect(error => {
            this.invalid = true;
            const active = this.active;
            active?.cancelDeadline?.();
            if (active && !active.receipt) {
                active.outputItems.clear();
                active.queue.fail(this.failure('Responses disconnected without terminal', 'receive', error, true));
            }
            this.unsubscribeMessage();
            this.unsubscribeClose();
        });
    }

    get reusable(): boolean {
        return !this.invalid && this.socket.reusable;
    }

    begin(
        body: Readonly<Record<string, unknown>>,
        onDispatch: () => void,
        previousResponseId?: string
    ): ResponsesRequestHandle {
        if (this.active || !this.reusable) {
            throw this.failure('Responses connection unavailable', 'send');
        }
        for (const field of ['type', 'conversation', 'previous_response_id', 'useWebSocket']) {
            if (body[field] !== undefined) {
                throw this.failure(`Conflicting Responses WebSocket field: ${field}`, 'send');
            }
        }
        const parameters = { ...body };
        delete parameters.stream;
        const frame = JSON.stringify({
            ...parameters,
            ...(previousResponseId ? { previous_response_id: previousResponseId } : {}),
            type: 'response.create'
        });
        const queue = new EventQueue(this.limits.queueBytes, () =>
            this.interrupt(this.failure('Responses consumer stopped before terminal', 'consume'))
        );
        const active: ActiveRequest = {
            queue,
            dispatched: false,
            accepted: false,
            previousResponseId,
            outputItems: new Map(),
            lastOutputIndex: -1,
            eventDeadline: this.clock.now() + this.limits.firstMs
        };
        this.active = active;
        active.cancelDeadline = this.clock.schedule(
            () => this.interrupt(this.failure('Responses first event deadline exceeded', 'receive', undefined, true)),
            this.limits.firstMs
        );
        try {
            onDispatch();
            active.dispatched = true;
            this.socket.send(frame);
        } catch (error) {
            const failure = this.failure('Responses WebSocket send failed', 'send', error);
            this.interrupt(failure);
            throw failure;
        }
        return {
            events: queue,
            get receipt() {
                return active.receipt;
            },
            get acceptance() {
                return active.accepted ? 'accepted' : 'unknown';
            },
            finish: success => {
                if (this.active !== active) {
                    return;
                }
                active.cancelDeadline?.();
                if (!success || !active.receipt) {
                    this.interrupt(this.failure('Responses consumer did not complete', 'consume'));
                }
                queue.clear();
                queue.releaseRetained();
                active.outputItems.clear();
                this.active = undefined;
            }
        };
    }

    interrupt(error: Error): void {
        this.invalid = true;
        this.active?.cancelDeadline?.();
        this.active?.outputItems.clear();
        this.active?.queue.fail(error);
        void this.close().catch(() => undefined);
    }

    close(): Promise<void> {
        this.invalid = true;
        if (!this.cleanup) {
            this.closingAt ??= this.clock.now();
            this.cleanup = Promise.all([this.socket.close(), this.closed]).then(() => undefined);
        }
        return this.cleanup;
    }

    private releaseDispatcher(): Promise<void> {
        return new Promise<void>((resolve, reject) => {
            let settled = false;
            let cancelDeadline = () => {};
            const fail = (error: unknown) => {
                if (settled) {
                    return;
                }
                settled = true;
                cancelDeadline();
                void Promise.resolve()
                    .then(() => this.network?.abortPending?.())
                    .catch(() => undefined);
                reject(error);
            };
            const remaining = Math.max(0, (this.closingAt ?? this.clock.now()) + 5_000 - this.clock.now());
            cancelDeadline = this.clock.schedule(
                () => fail(new Error('Responses dispatcher release deadline exceeded')),
                remaining
            );
            void Promise.resolve()
                .then(() => this.network?.release())
                .then(() => {
                    if (!settled) {
                        settled = true;
                        cancelDeadline();
                        resolve();
                    }
                }, fail);
        });
    }

    diagnostics(): { queueBytes: number; handles: number; processQueueBytes: number } {
        return { queueBytes: this.active?.queue.bytes ?? 0, handles: this.active ? 1 : 0, processQueueBytes };
    }

    private failure(
        message: string,
        phase: ResponsesTransportFailure['phase'],
        cause?: unknown,
        retryIfNoOutput = false
    ): ResponsesTransportFailure {
        return new ResponsesTransportFailure(
            message,
            phase,
            this.active?.dispatched ? 'possibly-sent' : 'not-sent',
            this.active?.accepted ? 'accepted' : 'unknown',
            undefined,
            undefined,
            cause,
            retryIfNoOutput
        );
    }

    private receive(data: unknown): void {
        try {
            if (typeof data !== 'string') {
                throw new Error('Unsupported binary Responses message');
            }
            const bytes = Buffer.byteLength(data);
            if (bytes > this.limits.messageBytes) {
                throw new Error('Responses message budget exceeded');
            }
            let value: unknown;
            try {
                value = JSON.parse(data);
            } catch {
                throw new Error('Invalid Responses JSON');
            }
            if (object(value) && typeof value.type === 'string' && auxiliaryTypes.has(value.type)) {
                return;
            }
            if (
                object(value) &&
                typeof value.type === 'string' &&
                value.type.length > 0 &&
                !knownTypes.has(value.type)
            ) {
                const eventType = /^[a-zA-Z][a-zA-Z0-9_.:-]{0,79}$/.test(value.type) ? value.type : 'unknown';
                this.onUnknownEvent?.(eventType);
                return;
            }
            const active = this.active;
            if (!active || active.receipt) {
                this.invalid = true;
                void this.close().catch(() => undefined);
                return;
            }
            if (this.clock.now() >= active.eventDeadline) {
                throw this.failure('Responses event deadline exceeded', 'receive', undefined, true);
            }
            if (object(value) && value.type === 'error') {
                const detail = object(value.error) ? value.error : value;
                const rejectedPrevious =
                    !!active.previousResponseId &&
                    !active.accepted &&
                    value.status === 400 &&
                    detail.code === 'previous_response_not_found';
                throw new ResponsesTransportFailure(
                    typeof detail.message === 'string' ? detail.message : 'Responses upstream error',
                    'receive',
                    'possibly-sent',
                    active.accepted ? 'accepted'
                    : rejectedPrevious ? 'rejected'
                    : 'unknown',
                    typeof value.status === 'number' ? value.status : undefined,
                    typeof detail.code === 'string' ? detail.code : undefined
                );
            }
            if (!validEvent(value)) {
                const eventType =
                    object(value) && typeof value.type === 'string' && /^response\.[a-z_.]{1,80}$/.test(value.type) ?
                        value.type
                    :   'unknown';
                throw new Error(`Unsupported or malformed Responses event: ${eventType}`);
            }
            const responseId =
                'response' in value ? value.response.id
                : object(value) && typeof value.response_id === 'string' ? value.response_id
                : undefined;
            if (responseId) {
                if (active.responseId && active.responseId !== responseId) {
                    throw new Error('Responses identity mismatch');
                }
                active.responseId = responseId;
            }
            active.accepted = true;
            active.cancelDeadline?.();
            if ('output_index' in value && typeof value.output_index === 'number') {
                active.lastOutputIndex = Math.max(active.lastOutputIndex, value.output_index);
            } else if (
                value.type !== 'response.created' &&
                value.type !== 'response.in_progress' &&
                !terminalTypes.has(value.type)
            ) {
                active.outputIncompleteReason ??= 'unindexed-output';
            }
            if (value.type === 'response.output_item.done') {
                if (typeof value.output_index !== 'number' || active.outputItems.has(value.output_index)) {
                    active.outputIncompleteReason ??=
                        typeof value.output_index !== 'number' ? 'unindexed-output' : 'duplicate-output-index';
                } else {
                    active.queue.retain(bytes);
                    active.outputItems.set(value.output_index, value.item);
                }
            }
            active.queue.push(value, bytes);
            if (terminalTypes.has(value.type) && 'response' in value) {
                const output = new Map(active.outputItems);
                const indices = new Map<string, number>();
                for (const [index, item] of output) {
                    if (object(item) && typeof item.id === 'string') {
                        if (indices.has(item.id)) {
                            active.outputIncompleteReason ??= 'duplicate-item-id';
                        }
                        indices.set(item.id, index);
                    }
                }
                const terminalOutput =
                    'output' in value.response && Array.isArray(value.response.output) ? value.response.output : [];
                for (const [position, item] of terminalOutput.entries()) {
                    const index = typeof item.id === 'string' ? (indices.get(item.id) ?? position) : position;
                    const completed = output.get(index);
                    if (object(completed) && (completed.id !== item.id || completed.type !== item.type)) {
                        active.outputIncompleteReason ??= 'terminal-item-conflict';
                    }
                    output.set(index, item);
                }
                const ordered = [...output].sort(([left], [right]) => left - right);
                const outputIncompleteReason =
                    active.outputIncompleteReason ??
                    (ordered.some(([index], position) => index !== position) ? 'output-index-gap'
                    : ordered.length <= active.lastOutputIndex ? 'missing-output-item'
                    : undefined);
                active.receipt = {
                    type: value.type as ResponsesTerminalReceipt['type'],
                    responseId: value.response.id,
                    output: ordered.map(([, item]) => item),
                    outputComplete: outputIncompleteReason === undefined,
                    outputIncompleteReason
                };
                active.queue.end();
            } else {
                active.eventDeadline = this.clock.now() + this.limits.idleMs;
                active.cancelDeadline = this.clock.schedule(
                    () =>
                        this.interrupt(
                            this.failure('Responses event idle deadline exceeded', 'receive', undefined, true)
                        ),
                    this.limits.idleMs
                );
            }
        } catch (error) {
            this.interrupt(
                error instanceof ResponsesTransportFailure ? error : (
                    this.failure(
                        `Responses protocol failure: ${error instanceof Error ? error.message : 'Unknown protocol error'}`,
                        'receive',
                        error
                    )
                )
            );
        }
    }
}
