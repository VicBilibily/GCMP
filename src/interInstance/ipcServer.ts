/*---------------------------------------------------------------------------------------------
 *  IPC 服务端
 *  Leader 实例启动本地 IPC 服务器，接收 Follower 连接并广播事件
 *--------------------------------------------------------------------------------------------*/

import * as net from 'node:net';
import * as fs from 'node:fs/promises';
import { StringDecoder } from 'node:string_decoder';
import { InterInstanceEvent, parseEventsFromBuffer, serializeEvent } from './eventProtocol';
import { isNamedPipePath } from './pathResolver';
import { StatusLogger } from '../utils/runtime/statusLogger';

export interface IpcServerOptions {
    /** 收到 Follower 消息时的回调 */
    onMessage?: (event: InterInstanceEvent) => void;
    /** Follower 连接断开时的回调；仍有同实例其它 socket 时不应回收 */
    onClientDisconnected?: (instanceId: string) => void;
}

export type IpcTargetSendResult = 'sent' | 'not-connected' | 'too-large';

/**
 * Leader IPC 服务端
 */
export class IpcServer {
    private server: net.Server | undefined;
    private sockets = new Set<net.Socket>();
    private currentPath: string | undefined;
    private options: IpcServerOptions;
    private socketInstanceIds = new Map<net.Socket, string>();
    private backpressuredSockets = new Map<net.Socket, { timer: ReturnType<typeof setTimeout>; onDrain: () => void }>();
    /** 单连接接收缓冲区上限，防止异常对端持续发送无换行数据导致内存无限增长 */
    private static readonly MAX_BUFFER_BYTES = 1024 * 1024; // 1MB
    private static readonly MAX_TARGET_EVENT_BYTES = 768 * 1024;
    private static readonly TARGET_DRAIN_TIMEOUT_MS = 2000;
    /** server.close 等待超时，避免挂起连接拖垮 stop */
    private static readonly CLOSE_TIMEOUT_MS = 2000;

    constructor(options: IpcServerOptions = {}) {
        this.options = options;
    }

    /**
     * 获取当前已连接 Follower 的 instanceId 列表
     * 用于 Leader 卸任时指定下一任 Leader，避免全量广播竞选
     */
    getConnectedFollowerIds(): string[] {
        const ids: string[] = [];
        for (const id of this.socketInstanceIds.values()) {
            if (id) {
                ids.push(id);
            }
        }
        return ids;
    }

    /**
     * 启动 IPC 服务器
     * @param pipePath 本地 IPC 路径
     */
    async start(pipePath: string): Promise<void> {
        if (this.server) {
            StatusLogger.warn('[IpcServer] Server already running, stopping before restart');
            await this.stop();
        }

        this.currentPath = pipePath;

        // Unix Domain Socket：启动前清理遗留文件
        if (!isNamedPipePath(pipePath)) {
            try {
                await fs.unlink(pipePath);
            } catch (error) {
                if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
                    StatusLogger.warn('[IpcServer] Failed to unlink stale socket', error);
                }
            }
        }

        return new Promise((resolve, reject) => {
            const server = net.createServer(socket => {
                this.sockets.add(socket);
                let buffer = '';
                // chunk 边界可能落在多字节 UTF-8 字符中间，必须用 StringDecoder 增量解码，
                // 直接 toString 会产生不可恢复的 U+FFFD 导致整行事件丢弃
                const decoder = new StringDecoder('utf8');
                const cleanupSocket = () => {
                    this.removeSocket(socket);
                };

                socket.on('data', data => {
                    buffer += decoder.write(data);
                    if (Buffer.byteLength(buffer, 'utf8') > IpcServer.MAX_BUFFER_BYTES) {
                        // 对端持续发送无法解析的数据，判定为异常连接，直接断开
                        StatusLogger.warn('[IpcServer] Socket buffer exceeded limit, destroying connection');
                        cleanupSocket();
                        socket.destroy();
                        return;
                    }
                    const { events, remaining } = parseEventsFromBuffer(buffer);
                    buffer = remaining;
                    if (events.length > 0) {
                        if (!this.acceptSocketEvents(socket, events)) {
                            cleanupSocket();
                            socket.destroy();
                            return;
                        }
                        // Leader 本地派发，并把来自 Follower 的消息中继给其他 Follower
                        for (const event of events) {
                            this.options.onMessage?.(event);
                        }
                        this.broadcastFromSocket(events, socket);
                    }
                });

                socket.on('close', () => {
                    cleanupSocket();
                });

                socket.on('error', error => {
                    StatusLogger.warn('[IpcServer] Socket error', error);
                    cleanupSocket();
                });
            });

            server.on('error', error => {
                StatusLogger.error('[IpcServer] Server error', error);
                reject(error);
            });

            server.listen(pipePath, () => {
                StatusLogger.info(`[IpcServer] Listening on ${pipePath}`);
                this.server = server;
                resolve();
            });
        });
    }

    /**
     * 向所有已连接的 Follower 广播事件
     * @param event 事件对象
     * @param excludeSocket 可选：需要排除的 socket（避免把 Follower 发来的消息原路返回）
     */
    broadcast(event: InterInstanceEvent, excludeSocket?: net.Socket): void {
        if (this.sockets.size === 0) {
            return;
        }
        this.backpressuredSockets ??= new Map();

        const payload = serializeEvent(event);
        for (const socket of this.sockets) {
            if (socket === excludeSocket || !this.socketInstanceIds.has(socket)) {
                continue;
            }
            if (this.backpressuredSockets.has(socket)) {
                this.disconnectSocket(socket);
                continue;
            }
            try {
                if (!socket.write(payload)) {
                    this.trackSocketBackpressure(socket);
                }
            } catch (error) {
                StatusLogger.warn('[IpcServer] Failed to write to socket', error);
                this.disconnectSocket(socket);
            }
        }
    }

    sendToInstance(instanceId: string, event: InterInstanceEvent): IpcTargetSendResult {
        this.backpressuredSockets ??= new Map();
        const payload = serializeEvent(event);
        if (Buffer.byteLength(payload, 'utf8') > IpcServer.MAX_TARGET_EVENT_BYTES) {
            return 'too-large';
        }

        let sent = false;
        for (const [socket, connectedInstanceId] of this.socketInstanceIds) {
            if (connectedInstanceId !== instanceId) {
                continue;
            }
            if (this.backpressuredSockets.has(socket)) {
                this.disconnectSocket(socket);
                continue;
            }
            try {
                if (!socket.write(payload)) {
                    this.trackSocketBackpressure(socket);
                }
                sent = true;
            } catch (error) {
                StatusLogger.warn('[IpcServer] Failed to write targeted event', error);
                this.disconnectSocket(socket);
            }
        }
        return sent ? 'sent' : 'not-connected';
    }

    /**
     * 将一组事件中继给除来源 socket 外的所有 Follower，并本地派发
     */
    private broadcastFromSocket(events: InterInstanceEvent[], sourceSocket: net.Socket): void {
        if (this.sockets.size <= 1) {
            return;
        }
        for (const event of events) {
            if (
                event.type === 'remoteInstanceCapabilities' ||
                event.type === 'usagesQueryRequested' ||
                event.type === 'usagesQueryCompleted'
            ) {
                continue;
            }
            this.broadcast(event, sourceSocket);
        }
    }

    private acceptSocketEvents(socket: net.Socket, events: InterInstanceEvent[]): boolean {
        const firstEvent = events[0];
        const senderInstanceId = firstEvent?.senderInstanceId;
        if (
            typeof senderInstanceId !== 'string' ||
            senderInstanceId.length === 0 ||
            senderInstanceId.length > 128 ||
            events.some(event => event.senderInstanceId !== senderInstanceId)
        ) {
            StatusLogger.warn('[IpcServer] Rejecting events with an invalid or mixed sender identity');
            return false;
        }

        const boundInstanceId = this.socketInstanceIds.get(socket);
        if (boundInstanceId) {
            if (boundInstanceId !== senderInstanceId) {
                StatusLogger.warn('[IpcServer] Rejecting socket sender identity change');
                return false;
            }
            return true;
        }

        if (firstEvent.type !== 'remoteInstanceHello' || this.hasConnectedInstance(senderInstanceId)) {
            StatusLogger.warn('[IpcServer] Rejecting socket without a unique instance handshake');
            return false;
        }

        this.socketInstanceIds.set(socket, senderInstanceId);
        return true;
    }

    /**
     * 获取当前连接数
     */
    getConnectionCount(): number {
        return this.sockets.size;
    }

    private hasConnectedInstance(instanceId: string): boolean {
        for (const id of this.socketInstanceIds.values()) {
            if (id === instanceId) {
                return true;
            }
        }
        return false;
    }

    private removeSocket(socket: net.Socket): void {
        this.backpressuredSockets ??= new Map();
        const instanceId = this.socketInstanceIds.get(socket);
        this.clearSocketBackpressure(socket);
        this.sockets.delete(socket);
        this.socketInstanceIds.delete(socket);
        if (instanceId && !this.hasConnectedInstance(instanceId)) {
            this.options.onClientDisconnected?.(instanceId);
        }
    }

    private trackSocketBackpressure(socket: net.Socket): void {
        this.backpressuredSockets ??= new Map();
        if (this.backpressuredSockets.has(socket)) {
            return;
        }
        const onDrain = () => this.clearSocketBackpressure(socket);
        const timer = setTimeout(() => {
            StatusLogger.warn('[IpcServer] Socket drain timed out, destroying connection');
            this.disconnectSocket(socket);
        }, IpcServer.TARGET_DRAIN_TIMEOUT_MS);
        this.backpressuredSockets.set(socket, { timer, onDrain });
        socket.once('drain', onDrain);
    }

    private clearSocketBackpressure(socket: net.Socket): void {
        this.backpressuredSockets ??= new Map();
        const state = this.backpressuredSockets.get(socket);
        if (!state) {
            return;
        }
        clearTimeout(state.timer);
        socket.off('drain', state.onDrain);
        this.backpressuredSockets.delete(socket);
    }

    private disconnectSocket(socket: net.Socket): void {
        this.removeSocket(socket);
        try {
            socket.destroy();
        } catch {
            // ignore
        }
    }

    /**
     * 停止 IPC 服务器，清理所有连接和 IPC 路径
     */
    async stop(): Promise<void> {
        // 强制销毁所有 socket：end() 需等对端响应，若对端进程挂起会导致 server.close 回调永不触发
        for (const socket of this.sockets) {
            this.clearSocketBackpressure(socket);
            try {
                socket.destroy();
            } catch {
                // ignore
            }
        }
        this.sockets.clear();
        this.socketInstanceIds.clear();
        this.backpressuredSockets.clear();

        if (this.server) {
            const server = this.server;
            this.server = undefined;
            await new Promise<void>(resolve => {
                // 超时兜底：即使存在未预料的挂起连接，也保证 stop 在有限时间内返回，避免拖垮 deactivate
                const timer = setTimeout(() => {
                    StatusLogger.warn('[IpcServer] Timed out waiting for server close, continuing');
                    resolve();
                }, IpcServer.CLOSE_TIMEOUT_MS);
                server.close(error => {
                    clearTimeout(timer);
                    if (error) {
                        StatusLogger.warn('[IpcServer] Error closing server', error);
                    }
                    resolve();
                });
            });
        }

        // Unix 下清理 sock 文件
        if (this.currentPath && !isNamedPipePath(this.currentPath)) {
            try {
                await fs.unlink(this.currentPath);
            } catch (error) {
                if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
                    StatusLogger.warn('[IpcServer] Failed to unlink socket on stop', error);
                }
            }
        }

        this.currentPath = undefined;
    }
}
