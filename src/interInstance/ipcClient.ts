/*---------------------------------------------------------------------------------------------
 *  IPC 客户端
 *  Follower 实例连接 Leader 的 IPC 服务器，接收广播事件并可发送消息
 *--------------------------------------------------------------------------------------------*/

import * as net from 'node:net';
import { InterInstanceEvent, parseEventsFromBuffer, serializeEvent } from './eventProtocol';
import { StatusLogger } from '../utils/statusLogger';

export interface IpcClientOptions {
    /** 收到 Leader 广播消息时的回调 */
    onMessage: (event: InterInstanceEvent) => void;
    /** 连接断开时的回调 */
    onDisconnect?: () => void;
}

/**
 * Follower IPC 客户端
 */
export class IpcClient {
    private socket: net.Socket | undefined;
    private buffer = '';
    private currentPath: string | undefined;
    private options: IpcClientOptions;
    private disposed = false;
    /** 接收缓冲区上限，防止异常对端持续发送无换行数据导致内存无限增长 */
    private static readonly MAX_BUFFER_BYTES = 1024 * 1024; // 1MB

    constructor(options: IpcClientOptions) {
        this.options = options;
    }

    /**
     * 连接 Leader 的 IPC 服务器
     * @param pipePath 本地 IPC 路径
     */
    async connect(pipePath: string): Promise<void> {
        if (this.socket) {
            await this.disconnect();
        }

        this.currentPath = pipePath;
        this.disposed = false;

        return new Promise((resolve, reject) => {
            const socket = net.connect(pipePath, () => {
                StatusLogger.info(`[IpcClient] Connected to ${pipePath}`);
                this.socket = socket;
                resolve();
            });

            socket.on('data', data => {
                this.buffer += data.toString('utf8');
                if (Buffer.byteLength(this.buffer, 'utf8') > IpcClient.MAX_BUFFER_BYTES) {
                    // 对端持续发送无法解析的数据，判定为异常连接，断开并触发重连
                    StatusLogger.warn('[IpcClient] Buffer exceeded limit, destroying connection');
                    this.buffer = '';
                    socket.destroy();
                    return;
                }
                const { events, remaining } = parseEventsFromBuffer(this.buffer);
                this.buffer = remaining;
                for (const event of events) {
                    this.options.onMessage(event);
                }
            });

            socket.on('error', error => {
                StatusLogger.debug(`[IpcClient] Connection error on ${pipePath}`, error);
                if (!this.socket) {
                    reject(error);
                }
            });

            socket.on('close', () => {
                this.socket = undefined;
                this.buffer = '';
                if (!this.disposed) {
                    StatusLogger.debug('[IpcClient] Connection closed');
                    this.options.onDisconnect?.();
                }
            });
        });
    }

    /**
     * 当前是否仍持有可写 socket。
     * 用于上层决定是否继续走 IPC，避免在断线重连窗口内把事件静默写入 no-op send。
     */
    isConnected(): boolean {
        return !!this.socket;
    }

    /**
     * 向 Leader 发送事件
     */
    send(event: InterInstanceEvent): void {
        if (this.socket) {
            this.socket.write(serializeEvent(event));
        }
    }

    /**
     * 断开连接
     */
    async disconnect(): Promise<void> {
        this.disposed = true;
        if (this.socket) {
            const socket = this.socket;
            this.socket = undefined;
            await new Promise<void>(resolve => {
                socket.once('close', () => resolve());
                socket.end();
                // 如果对方无响应，destroy 会触发 close 事件
                socket.destroySoon();
            });
        }
        this.buffer = '';
    }
}
