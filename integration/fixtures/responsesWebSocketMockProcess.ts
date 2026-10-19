import { spawn } from 'node:child_process';

const scenarios = [
    'text',
    'auxiliary-events',
    'fragmented',
    'roundtrip-full',
    'roundtrip-delta',
    'parallel-tools',
    'parallel-done-empty',
    'parallel-done-reasoning',
    'reasoning-replay',
    'reasoning-omitted',
    'custom-wrapped-full',
    'custom-wrapped-delta',
    'usage-sequence',
    'reject-previous',
    'reject-previous-after-created',
    'completed-close',
    'partial-close',
    'duplicate-terminal',
    'paused',
    'accepted-silent',
    'accepted-close',
    'ping-only',
    'idle-after-created',
    'malformed',
    'binary',
    'oversize',
    'queue-overflow',
    'process-pressure',
    'fragmented-overlimit',
    'identity',
    'unknown-terminal',
    'flat-error',
    'nested-error',
    'cancelled',
    'failed',
    'incomplete',
    'reject-upgrade',
    'reject-upgrade-exhausted',
    'stall-upgrade'
] as const;

export type MockScenario = (typeof scenarios)[number];

export interface MockNetwork {
    tls?: 'valid' | 'hostname' | 'expired';
    proxy?: 'forward' | 'auth' | 'reject' | 'disconnect' | 'stall';
    secureProxy?: boolean;
}

export interface MockFunctionTool {
    type: 'function';
    name: string;
    description?: string;
    strict?: boolean;
    parameters: {
        type: 'object';
        properties: Record<string, { type: 'string' | 'number' }>;
        required?: string[];
        additionalProperties?: boolean;
    };
}

export interface MockExpectedContext {
    instructions?: string;
    delta: boolean;
    input: readonly {
        type: 'message';
        role: 'user' | 'assistant';
        status?: 'completed';
        content: readonly { type: 'input_text' | 'output_text'; text: string }[];
    }[];
}

export interface MockExpectations {
    instructions?: string;
    tools?: readonly MockFunctionTool[];
    contexts?: readonly MockExpectedContext[];
    httpResponseText?: string;
    responseText?: string;
}

export interface MockSnapshot {
    listening: boolean;
    webSockets: number;
    tcpSockets: number;
    accepted: number;
    received: number;
    httpRequests: number;
    httpAccepted: number;
    handshakes: number;
    sent: number;
    full: number;
    delta: number;
    contextChecks: number;
    contextErrors: number;
    pings: number;
    wireInputItems: readonly number[];
    pendingResponses: number;
    protocolErrors: number;
    forcedTerminations: number;
    waiters: number;
    tlsErrors: number;
    proxyListening: boolean;
    proxySockets: number;
    connects: number;
    tunnels: number;
    authFailures: number;
    proxyRejected: number;
}

export type MockWait = Partial<
    Pick<
        MockSnapshot,
        | 'webSockets'
        | 'tcpSockets'
        | 'proxySockets'
        | 'connects'
        | 'accepted'
        | 'received'
        | 'sent'
        | 'pendingResponses'
        | 'handshakes'
    >
>;
export type MockRequest =
    | { kind: 'start'; scenario: MockScenario; expected?: MockExpectations; network?: MockNetwork }
    | { kind: 'snapshot' | 'release' | 'idle' | 'stop' }
    | { kind: 'wait'; expected: MockWait };
export type MockCommand = MockRequest & { id: number };
export type MockReply =
    | { id: number; kind: 'ready'; url: string; origin: string; proxyUrl?: string }
    | { id: number; kind: 'snapshot' | 'stopped'; snapshot: MockSnapshot }
    | { id: number; kind: 'ack' }
    | { id: number; kind: 'error'; code: string };

function object(value: unknown): value is Record<string, unknown> {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function integer(value: unknown): value is number {
    return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

function functionTool(value: unknown): value is MockFunctionTool {
    if (!object(value) || value.type !== 'function' || typeof value.name !== 'string' || !object(value.parameters)) {
        return false;
    }
    const parameters = value.parameters;
    return (
        (value.description === undefined || typeof value.description === 'string') &&
        (value.strict === undefined || typeof value.strict === 'boolean') &&
        parameters.type === 'object' &&
        object(parameters.properties) &&
        Object.values(parameters.properties).every(
            property => object(property) && (property.type === 'string' || property.type === 'number')
        ) &&
        (parameters.required === undefined ||
            (Array.isArray(parameters.required) && parameters.required.every(key => typeof key === 'string'))) &&
        (parameters.additionalProperties === undefined || typeof parameters.additionalProperties === 'boolean')
    );
}

function expectedContext(value: unknown): value is MockExpectedContext {
    return (
        object(value) &&
        (value.instructions === undefined || typeof value.instructions === 'string') &&
        typeof value.delta === 'boolean' &&
        Array.isArray(value.input) &&
        value.input.every(
            item =>
                object(item) &&
                item.type === 'message' &&
                (item.role === 'user' || item.role === 'assistant') &&
                (item.status === undefined || item.status === 'completed') &&
                Array.isArray(item.content) &&
                item.content.every(
                    part =>
                        object(part) &&
                        (part.type === 'input_text' || part.type === 'output_text') &&
                        typeof part.text === 'string'
                )
        )
    );
}

function expectations(value: unknown): value is MockExpectations {
    return (
        object(value) &&
        (value.instructions === undefined || typeof value.instructions === 'string') &&
        (value.httpResponseText === undefined || typeof value.httpResponseText === 'string') &&
        (value.responseText === undefined || typeof value.responseText === 'string') &&
        (value.tools === undefined || (Array.isArray(value.tools) && value.tools.every(functionTool))) &&
        (value.contexts === undefined || (Array.isArray(value.contexts) && value.contexts.every(expectedContext)))
    );
}

function snapshot(value: unknown): value is MockSnapshot {
    return (
        object(value) &&
        typeof value.listening === 'boolean' &&
        typeof value.proxyListening === 'boolean' &&
        [
            'webSockets',
            'tcpSockets',
            'accepted',
            'received',
            'httpRequests',
            'httpAccepted',
            'handshakes',
            'sent',
            'full',
            'delta',
            'contextChecks',
            'contextErrors',
            'pings',
            'pendingResponses',
            'protocolErrors',
            'forcedTerminations',
            'waiters',
            'tlsErrors',
            'proxySockets',
            'connects',
            'tunnels',
            'authFailures',
            'proxyRejected'
        ].every(key => integer(value[key])) &&
        Array.isArray(value.wireInputItems) &&
        value.wireInputItems.every(integer)
    );
}

function network(value: unknown): value is MockNetwork {
    return (
        object(value) &&
        (value.tls === undefined || ['valid', 'hostname', 'expired'].includes(String(value.tls))) &&
        (value.proxy === undefined ||
            ['forward', 'auth', 'reject', 'disconnect', 'stall'].includes(String(value.proxy))) &&
        (value.secureProxy === undefined || typeof value.secureProxy === 'boolean') &&
        (!value.secureProxy || value.proxy !== undefined)
    );
}

export function isMockCommand(value: unknown): value is MockCommand {
    if (!object(value) || !integer(value.id) || value.id === 0) {
        return false;
    }
    if (value.kind === 'start') {
        return (
            scenarios.some(scenario => scenario === value.scenario) &&
            (value.expected === undefined || expectations(value.expected)) &&
            (value.network === undefined || network(value.network))
        );
    }
    if (value.kind === 'wait') {
        return (
            object(value.expected) &&
            Object.entries(value.expected).every(
                ([key, count]) =>
                    [
                        'webSockets',
                        'tcpSockets',
                        'proxySockets',
                        'connects',
                        'accepted',
                        'received',
                        'sent',
                        'pendingResponses',
                        'handshakes'
                    ].includes(key) && integer(count)
            )
        );
    }
    return ['snapshot', 'release', 'idle', 'stop'].includes(String(value.kind));
}

export function isMockReply(value: unknown): value is MockReply {
    if (!object(value) || !integer(value.id) || value.id === 0) {
        return false;
    }
    if (value.kind === 'ready') {
        if (typeof value.url !== 'string' || typeof value.origin !== 'string') {
            return false;
        }
        try {
            const url = new URL(value.url);
            const origin = new URL(value.origin);
            return (
                ((url.protocol === 'ws:' && origin.protocol === 'http:') ||
                    (url.protocol === 'wss:' && origin.protocol === 'https:')) &&
                url.hostname === '127.0.0.1' &&
                origin.hostname === '127.0.0.1' &&
                url.port === origin.port &&
                url.pathname === '/responses' &&
                !url.username &&
                !url.password &&
                !origin.username &&
                !origin.password &&
                (value.proxyUrl === undefined ||
                    (() => {
                        if (typeof value.proxyUrl !== 'string') {
                            return false;
                        }
                        const proxy = new URL(value.proxyUrl);
                        return (
                            ['http:', 'https:'].includes(proxy.protocol) &&
                            proxy.hostname === '127.0.0.1' &&
                            !!proxy.port &&
                            proxy.pathname === '/' &&
                            !proxy.username &&
                            !proxy.password
                        );
                    })())
            );
        } catch {
            return false;
        }
    }
    if (value.kind === 'snapshot' || value.kind === 'stopped') {
        return snapshot(value.snapshot);
    }
    return value.kind === 'ack' || (value.kind === 'error' && typeof value.code === 'string');
}

export async function startResponsesMockProcess(
    scenario: MockScenario,
    expected?: MockExpectations,
    network?: MockNetwork
) {
    const execPath = process.env.GCMP_WS_MOCK_NODE;
    const entry = process.env.GCMP_WS_MOCK_ENTRY;
    const cwd = process.env.GCMP_WS_REPO_ROOT;
    if (!execPath || !entry || !cwd) {
        throw new Error('Live WS E2E requires the PowerShell Host verification entry');
    }
    const child = spawn(execPath, ['--import=tsx', entry], {
        cwd,
        windowsHide: true,
        env: {
            ...process.env,
            ELECTRON_RUN_AS_NODE: undefined,
            NODE_OPTIONS: undefined,
            WS_NO_BUFFER_UTIL: '1',
            WS_NO_UTF_8_VALIDATE: '1'
        },
        stdio: ['ignore', 'ignore', 'pipe', 'ipc']
    });
    let sequence = 0;
    let exited = false;
    let forcedKills = 0;
    let stderr = '';
    let cleanup: Promise<MockSnapshot> | undefined;
    const pending = new Map<
        number,
        { resolve(reply: MockReply): void; reject(error: Error): void; timer: ReturnType<typeof setTimeout> }
    >();
    const fail = (error: Error) => {
        for (const request of pending.values()) {
            clearTimeout(request.timer);
            request.reject(error);
        }
        pending.clear();
    };
    child.stderr?.on('data', (chunk: Buffer) => {
        if (stderr.length < 8192) {
            stderr += chunk.toString().slice(0, 8192 - stderr.length);
        }
    });
    child.on('error', fail);
    child.on('message', (value: unknown) => {
        if (!isMockReply(value)) {
            fail(new Error('Invalid Mock process reply'));
            return;
        }
        const request = pending.get(value.id);
        if (!request) {
            return;
        }
        pending.delete(value.id);
        clearTimeout(request.timer);
        if (value.kind === 'error') {
            request.reject(new Error(`Mock process rejected command: ${value.code}`));
        } else {
            request.resolve(value);
        }
    });
    const closed = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(resolve => {
        child.once('close', (code, signal) => {
            exited = true;
            fail(new Error(`Mock process exited (${code ?? signal}): ${stderr}`));
            resolve({ code, signal });
        });
    });
    const request = (command: MockRequest): Promise<MockReply> => {
        if (exited || !child.connected) {
            return Promise.reject(new Error('Mock process is not connected'));
        }
        const id = ++sequence;
        return new Promise((resolve, reject) => {
            const timer = setTimeout(() => {
                pending.delete(id);
                reject(new Error('Mock IPC deadline exceeded'));
            }, 5_000);
            pending.set(id, { resolve, reject, timer });
            try {
                child.send({ ...command, id }, error => {
                    if (error && pending.delete(id)) {
                        clearTimeout(timer);
                        reject(error);
                    }
                });
            } catch (error) {
                pending.delete(id);
                clearTimeout(timer);
                reject(error);
            }
        });
    };
    const waitClosed = () =>
        new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve, reject) => {
            const timer = setTimeout(() => reject(new Error('Mock process exit deadline exceeded')), 5_000);
            void closed.then(value => {
                clearTimeout(timer);
                resolve(value);
            });
        });
    const stop = (): Promise<MockSnapshot> => {
        if (!cleanup) {
            cleanup = (async () => {
                const reply = await request({ kind: 'stop' });
                if (reply.kind !== 'stopped') {
                    throw new Error('Mock process did not confirm shutdown');
                }
                const exit = await waitClosed();
                if (exit.code !== 0 || exit.signal) {
                    throw new Error('Mock process shutdown failed');
                }
                return reply.snapshot;
            })();
        }
        return cleanup;
    };
    const dispose = async () => {
        try {
            await stop();
        } catch {
            if (!exited) {
                forcedKills++;
                child.kill();
            }
            await waitClosed();
        }
    };
    try {
        const ready = await request({ kind: 'start', scenario, expected, network });
        if (ready.kind !== 'ready') {
            throw new Error('Mock process did not become ready');
        }
        return {
            url: ready.url,
            origin: ready.origin,
            proxyUrl: ready.proxyUrl,
            async snapshot(): Promise<MockSnapshot> {
                const reply = await request({ kind: 'snapshot' });
                if (reply.kind !== 'snapshot') {
                    throw new Error('Invalid Mock snapshot reply');
                }
                return reply.snapshot;
            },
            async waitFor(expected: MockWait): Promise<void> {
                await request({ kind: 'wait', expected });
            },
            async releasePending(): Promise<void> {
                await request({ kind: 'release' });
            },
            async sendIdleEvent(): Promise<void> {
                await request({ kind: 'idle' });
            },
            diagnostics: () => ({ exited, pending: pending.size, forcedKills }),
            stop,
            dispose
        };
    } catch (error) {
        await dispose();
        throw error;
    }
}
