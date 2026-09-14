/*---------------------------------------------------------------------------------------------
 *  Codex App Server JSON-RPC 客户端
 *  握手（initialize/initialized）、stdout JSONL 单 reader、pending 响应路由、
 *  通知按 (threadId,turnId) 扇出、服务端反向请求分发、thread 级串行锁。
 *  协议陷阱（PoC 实测）：null-params 方法（如 account/rateLimits/read）必须省略 params 键
 *  （传 {} 被静默丢弃）；其余方法 params 键必须存在（缺失报 missing field `params`）。
 *--------------------------------------------------------------------------------------------*/

import { createInterface } from 'node:readline';
import { Logger } from '../../utils/runtime/logger';
import { getCodexTuiCliHeader } from '../../utils/metadata/metadataResolver';
import type {
    InitializeResponse,
    JsonRpcNotificationFrame,
    JsonRpcRequestFrame,
    JsonRpcServerRequestFrame
} from './protocolTypes';
import { CodexAppServerProcessManager } from './processManager';

/** 各方法的默认超时（毫秒） */
const DEFAULT_TIMEOUTS: Record<string, number> = {
    initialize: 15_000,
    'thread/start': 30_000,
    'thread/resume': 30_000,
    'turn/start': 30_000,
    'turn/interrupt': 10_000,
    'thread/inject_items': 60_000,
    'model/list': 15_000,
    'account/read': 15_000,
    // 上游 fetch 可能较慢（PoC 实测 >20s）
    'account/rateLimits/read': 90_000,
    'account/usage/read': 90_000
};
const FALLBACK_TIMEOUT_MS = 30_000;

/**
 * params 类型为 null 的方法：必须省略 params 键（传 {} 会被服务端静默丢弃）。
 * 其余方法（如 model/list、account/read）params 结构体可空但键必须存在，缺省时补 {}。
 */
const NULL_PARAMS_METHODS = new Set(['account/rateLimits/read', 'account/usage/read']);

/**
 * 协议基线版本（固定）：低于此版本的 codex CLI 拒绝使用 appServer 传输。
 * 0.153.4 为 PoC 实测基准（thread/inject_items、Dynamic Tools、持久 thread 均已验证）。
 */
export const MINIMUM_CLI_VERSION = '0.153.4';

type NotificationHandler = (msg: JsonRpcNotificationFrame) => void;
type ServerRequestHandler = (msg: JsonRpcServerRequestFrame) => void;

interface PendingEntry {
    method: string;
    resolve: (result: unknown) => void;
    reject: (error: Error) => void;
    timer: NodeJS.Timeout;
}

/** 版本比较（x.y.z，仅数字段） */
export function isVersionBelow(actual: string, baseline: string): boolean {
    const parse = (v: string) => v.split('.').map(s => parseInt(s.replace(/\D.*$/, ''), 10) || 0);
    const a = parse(actual);
    const b = parse(baseline);
    for (let i = 0; i < 3; i++) {
        if (a[i] !== b[i]) {
            return a[i] < b[i];
        }
    }
    return false;
}

export class CodexAppServerClient {
    private nextId = 1;
    private readonly pending = new Map<number | string, PendingEntry>();
    private readonly notificationHandlers: Array<{ threadId?: string; handler: NotificationHandler }> = [];
    private defaultServerRequestHandler?: ServerRequestHandler;
    /** 按 threadId 注册的服务端反向请求处理器（如 Dynamic Tools 的 item/tool/call） */
    private readonly serverRequestHandlers = new Map<string, ServerRequestHandler>();
    private writeMutex: Promise<void> = Promise.resolve();
    private readonly threadLocks = new Map<string, Promise<void>>();
    private handshakeDone = false;
    private handshakePromise?: Promise<InitializeResponse>;
    /** initialize 响应中的服务端 userAgent，含 CLI 版本（如 "codex-cli/0.153.4 ..."） */
    serverUserAgent?: string;

    constructor(private readonly processManager: CodexAppServerProcessManager) {
        this.processManager.onExit(() => this.handleProcessExit());
    }

    /** 确保进程在运行且握手完成 */
    async ensureReady(): Promise<void> {
        if (this.handshakeDone && this.processManager.isRunning) {
            return;
        }
        this.handshakePromise ??= this.doHandshake().finally(() => {
            this.handshakePromise = undefined;
        });
        const init = await this.handshakePromise;
        this.handshakeDone = true;
        this.serverUserAgent = init.userAgent;
        this.checkVersion(init.userAgent);
    }

    private async doHandshake(): Promise<InitializeResponse> {
        this.processManager.ensureRunning();
        this.attachReader();
        // 以 codex-tui 身份握手（与 direct 传输的 User-Agent 标识一致），不声明 gcmp
        const { version, originator } = getCodexTuiCliHeader();
        const init = (await this.request('initialize', {
            clientInfo: { name: originator, title: null, version },
            capabilities: { experimentalApi: true }
        })) as InitializeResponse;
        this.notify('initialized', {});
        Logger.info(`[CodexAppServer] handshake ok: ${init.userAgent}`);
        return init;
    }

    /** 版本门禁：userAgent 中提取 codex 版本，低于固定基线则拒绝（不静默回退） */
    private checkVersion(userAgent: string): void {
        const baseline = MINIMUM_CLI_VERSION;
        const match = /(?:^|\s|\/)(\d+\.\d+\.\d+)(?:\s|$)/.exec(userAgent);
        const actual = match?.[1];
        if (actual && isVersionBelow(actual, baseline)) {
            this.processManager.shutdown();
            throw new Error(
                `Codex CLI ${actual} is below the required baseline ${baseline} for appServer transport. ` +
                    'Upgrade codex-cli or switch transport back to "direct".'
            );
        }
    }

    private handleProcessExit(): void {
        this.handshakeDone = false;
        for (const [id, entry] of this.pending) {
            clearTimeout(entry.timer);
            entry.reject(new Error(`Codex app-server exited while waiting for ${entry.method} (request ${id})`));
        }
        this.pending.clear();
        this.threadLocks.clear();
    }

    /**
     * 发起 JSON-RPC 请求。
     * 协议陷阱（PoC 实测）：null-params 方法（NULL_PARAMS_METHODS）必须省略 params 键；
     * 其余方法 params 键必须存在，params 为 undefined 时补 {}。
     */
    request<T = unknown>(method: string, params?: unknown, timeoutMs?: number): Promise<T> {
        const id = this.nextId++;
        const timeout = timeoutMs ?? DEFAULT_TIMEOUTS[method] ?? FALLBACK_TIMEOUT_MS;
        return new Promise<T>((resolve, reject) => {
            const timer = setTimeout(() => {
                this.pending.delete(id);
                reject(new Error(`${method} timed out after ${timeout}ms`));
            }, timeout);
            this.pending.set(id, { method, resolve: resolve as (r: unknown) => void, reject, timer });
            const omitParams = params === null || (params === undefined && NULL_PARAMS_METHODS.has(method));
            const frame: JsonRpcRequestFrame = omitParams ? { id, method } : { id, method, params: params ?? {} };
            this.writeFrame(frame).catch(error => {
                this.pending.delete(id);
                clearTimeout(timer);
                reject(error instanceof Error ? error : new Error(String(error)));
            });
        });
    }

    notify(method: string, params: unknown): void {
        void this.writeFrame({ method, params } as unknown as JsonRpcRequestFrame);
    }

    /** 响应服务端反向请求（审批 / item/tool/call） */
    respond(id: number | string, result: unknown): void {
        void this.writeFrame({ id, result } as unknown as JsonRpcRequestFrame);
    }

    /** stdin 写入互斥，避免帧交错 */
    private writeFrame(frame: object): Promise<void> {
        const line = JSON.stringify(frame) + '\n';
        this.writeMutex = this.writeMutex.then(
            () =>
                new Promise<void>((resolve, reject) => {
                    const stdin = this.processManager.ensureRunning().proc.stdin;
                    if (!stdin) {
                        reject(new Error('Codex app-server stdin unavailable'));
                        return;
                    }
                    stdin.write(line, error => (error ? reject(error) : resolve()));
                })
        );
        return this.writeMutex;
    }

    /** 订阅通知；threadId 限定后仅接收该 thread 的通知（含按 turnId 归属的） */
    onNotification(handler: NotificationHandler, threadId?: string): { dispose(): void } {
        const entry = { threadId, handler };
        this.notificationHandlers.push(entry);
        return {
            dispose: () => {
                const idx = this.notificationHandlers.indexOf(entry);
                if (idx >= 0) {
                    this.notificationHandlers.splice(idx, 1);
                }
            }
        };
    }

    /** 服务端反向请求统一兜底入口（无 threadId 处理器时使用：审批拒绝 / tool/call 失败兜底） */
    onServerRequest(handler: ServerRequestHandler): void {
        this.defaultServerRequestHandler = handler;
    }

    /** 为指定 thread 注册服务端反向请求处理器（如 Dynamic Tools），返回注销句柄 */
    registerServerRequestHandler(threadId: string, handler: ServerRequestHandler): { dispose(): void } {
        this.serverRequestHandlers.set(threadId, handler);
        return {
            dispose: () => {
                if (this.serverRequestHandlers.get(threadId) === handler) {
                    this.serverRequestHandlers.delete(threadId);
                }
            }
        };
    }

    /** thread 级串行锁：同一 thread 的 start/inject/turn 序列串行执行 */
    async withThreadLock<T>(threadId: string, fn: () => Promise<T>): Promise<T> {
        const prev = this.threadLocks.get(threadId) ?? Promise.resolve();
        let release!: () => void;
        const current = new Promise<void>(resolve => {
            release = resolve;
        });
        this.threadLocks.set(
            threadId,
            prev.then(() => current)
        );
        await prev;
        try {
            return await fn();
        } finally {
            release();
            if (this.threadLocks.get(threadId) === current) {
                this.threadLocks.delete(threadId);
            }
        }
    }

    /** 绑定 stdout reader（握手前调用一次） */
    attachReader(): void {
        const stdout = this.processManager.ensureRunning().proc.stdout;
        if (!stdout) {
            throw new Error('Codex app-server stdout unavailable');
        }
        const rl = createInterface({ input: stdout, crlfDelay: Infinity });
        rl.on('line', line => this.dispatchLine(line));
    }

    private dispatchLine(line: string): void {
        if (!line.trim()) {
            return;
        }
        let msg: {
            id?: number | string;
            method?: string;
            params?: unknown;
            result?: unknown;
            error?: { code: number; message: string };
        };
        try {
            msg = JSON.parse(line);
        } catch {
            Logger.warn(`[CodexAppServer] non-JSON stdout line: ${line.slice(0, 200)}`);
            return;
        }
        if (msg.id !== undefined && msg.method !== undefined) {
            const params = msg.params as { threadId?: string } | undefined;
            const handler =
                (params?.threadId ? this.serverRequestHandlers.get(params.threadId) : undefined) ??
                this.defaultServerRequestHandler;
            handler?.(msg as JsonRpcServerRequestFrame);
            return;
        }
        if (msg.id !== undefined) {
            const entry = this.pending.get(msg.id);
            if (!entry) {
                return;
            }
            this.pending.delete(msg.id);
            clearTimeout(entry.timer);
            if (msg.error) {
                entry.reject(new Error(`${entry.method} failed: [${msg.error.code}] ${msg.error.message}`));
            } else {
                entry.resolve(msg.result);
            }
            return;
        }
        const notification = msg as JsonRpcNotificationFrame;
        const params = notification.params as { threadId?: string } | undefined;
        for (const entry of this.notificationHandlers) {
            if (entry.threadId && params?.threadId !== entry.threadId) {
                continue;
            }
            try {
                entry.handler(notification);
            } catch (error) {
                Logger.warn(`[CodexAppServer] notification handler error (${notification.method}): ${error}`);
            }
        }
    }
}
