/*---------------------------------------------------------------------------------------------
 *  IPC 服务端
 *  Leader 实例启动本地 IPC 服务器，接收 Follower 连接并广播事件
 *--------------------------------------------------------------------------------------------*/

import * as net from 'node:net';
import * as fs from 'node:fs/promises';
import { InterInstanceEvent, parseEventsFromBuffer, serializeEvent } from './eventProtocol';
import { isNamedPipePath } from './pathResolver';
import { StatusLogger } from '../utils/statusLogger';

export interface IpcServerOptions {
    /** 收到 Follower 消息时的回调 */
    onMessage?: (event: InterInstanceEvent) => void;
}

/**
 * Leader IPC 服务端
 */
export class IpcServer {
    private server: net.Server | undefined;
    private sockets = new Set<net.Socket>();
    private currentPath: string | undefined;
    private options: IpcServerOptions;
    private socketInstanceIds = new Map<net.Socket, string>();

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

                socket.on('data', data => {
                    buffer += data.toString('utf8');
                    const { events, remaining } = parseEventsFromBuffer(buffer);
                    buffer = remaining;
                    if (events.length > 0) {
                        // 记录发送者 instanceId，避免把事件原路广播回去
                        const firstEvent = events[0];
                        if (firstEvent?.senderInstanceId) {
                            this.socketInstanceIds.set(socket, firstEvent.senderInstanceId);
                        }
                        // Leader 本地派发，并把来自 Follower 的消息中继给其他 Follower
                        for (const event of events) {
                            this.options.onMessage?.(event);
                        }
                        this.broadcastFromSocket(events, socket);
                    }
                });

                socket.on('close', () => {
                    this.sockets.delete(socket);
                    this.socketInstanceIds.delete(socket);
                });

                socket.on('error', error => {
                    StatusLogger.warn('[IpcServer] Socket error', error);
                    this.sockets.delete(socket);
                    this.socketInstanceIds.delete(socket);
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

        const payload = serializeEvent(event);
        for (const socket of this.sockets) {
            if (socket === excludeSocket) {
                continue;
            }
            try {
                socket.write(payload);
            } catch (error) {
                StatusLogger.warn('[IpcServer] Failed to write to socket', error);
                this.sockets.delete(socket);
                this.socketInstanceIds.delete(socket);
            }
        }
    }

    /**
     * 将一组事件中继给除来源 socket 外的所有 Follower，并本地派发
     */
    private broadcastFromSocket(events: InterInstanceEvent[], sourceSocket: net.Socket): void {
        if (this.sockets.size <= 1) {
            return;
        }
        for (const event of events) {
            this.broadcast(event, sourceSocket);
        }
    }

    /**
     * 获取当前连接数
     */
    getConnectionCount(): number {
        return this.sockets.size;
    }

    /**
     * 停止 IPC 服务器，清理所有连接和 IPC 路径
     */
    async stop(): Promise<void> {
        // 关闭所有 socket
        for (const socket of this.sockets) {
            try {
                socket.end();
            } catch {
                // ignore
            }
        }
        this.sockets.clear();
        this.socketInstanceIds.clear();

        if (this.server) {
            const server = this.server;
            this.server = undefined;
            await new Promise<void>(resolve => {
                server.close(error => {
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
