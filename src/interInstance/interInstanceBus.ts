/*---------------------------------------------------------------------------------------------
 *  跨实例消息总线
 *  基于 Leader/Follower 角色分发事件，本地 IPC 为主，globalState 轮询为降级
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { InterInstanceEvent, InterInstanceEventHandler } from './eventProtocol';
import { IpcServer } from './ipcServer';
import { IpcClient } from './ipcClient';
import { FallbackTransport } from './fallbackTransport';
import { resolveIpcPath } from './pathResolver';
import { LeaderElectionService } from '../status/leaderElectionService';
import { StatusLogger } from '../utils/statusLogger';

/**
 * 跨实例总线配置选项
 */
export interface InterInstanceBusOptions {
    /** 是否启用 IPC（默认 true） */
    enabled?: boolean;
}

/**
 * 跨实例消息总线
 * 负责：
 * 1. 监听 Leader 角色变化，启动/停止 IPC Server 或 Client
 * 2. 提供发布/订阅接口
 * 3. 在 IPC 不可用时降级到 globalState 轮询
 */
export class InterInstanceBus {
    private static context: vscode.ExtensionContext | undefined;
    private static instanceId: string | undefined;
    private static options: InterInstanceBusOptions = {};
    private static initialized = false;

    private static server: IpcServer | undefined;
    private static client: IpcClient | undefined;
    private static fallbackTransport: FallbackTransport | undefined;
    /** IPC 完全失败时启用文件 fallback；保留此标记用于调试 fallback 触发场景 */
    private static fallbackActive = false;

    private static handlers = new Map<string, Set<InterInstanceEventHandler<InterInstanceEvent>>>();
    private static leaderChangeDisposable: vscode.Disposable | undefined;
    private static reconnectTimer: NodeJS.Timeout | undefined;
    private static reconnectAttempts = 0;
    private static readonly MAX_RECONNECT_DELAY_MS = 60_000;

    /**
     * 初始化总线
     */
    static initialize(context: vscode.ExtensionContext, options: InterInstanceBusOptions = {}): void {
        if (this.initialized) {
            return;
        }

        this.context = context;

        // 远程开发环境（Remote/SSH/WSL/Container）下禁用 IPC，仅使用文件系统降级通道
        const isLocalHost = typeof vscode.env.remoteName === 'undefined';
        const ipcEnabled = options.enabled !== false && isLocalHost;

        this.options = {
            enabled: ipcEnabled
        };

        // 必须先拿到 instanceId 再启动 fallback transport，否则自己的事件文件会命名为 unknown
        this.instanceId = LeaderElectionService.getInstanceId();

        // 文件系统降级通道无条件启动，确保 Remote/IPC 不可用场景下事件仍能落盘
        this.startFallbackTransport();

        // 监听 Leader 变化
        this.leaderChangeDisposable = LeaderElectionService.onLeaderChanged(async isLeader => {
            StatusLogger.info(`[InterInstanceBus] Leader changed: isLeader=${isLeader}`);
            if (isLeader) {
                await this.becomeLeader();
            } else {
                await this.becomeFollower();
            }
        });

        // 根据当前角色初始化 IPC 端点
        if (LeaderElectionService.isLeader()) {
            this.becomeLeader().catch(error =>
                StatusLogger.error('[InterInstanceBus] Failed to become leader on init', error)
            );
        } else {
            this.becomeFollower().catch(error =>
                StatusLogger.error('[InterInstanceBus] Failed to become follower on init', error)
            );
        }

        this.initialized = true;
        if (!this.options.enabled) {
            StatusLogger.info('[InterInstanceBus] Inter-instance bus initialized (IPC disabled, using file fallback)');
        } else {
            StatusLogger.info('[InterInstanceBus] Inter-instance bus initialized');
        }
    }

    /**
     * 释放总线资源
     */
    static async dispose(): Promise<void> {
        if (this.reconnectTimer) {
            clearTimeout(this.reconnectTimer);
            this.reconnectTimer = undefined;
        }
        this.reconnectAttempts = 0;

        this.leaderChangeDisposable?.dispose();
        this.leaderChangeDisposable = undefined;

        await this.client?.disconnect();
        this.client = undefined;

        await this.server?.stop();
        this.server = undefined;

        this.fallbackTransport?.stop();
        this.fallbackTransport = undefined;

        this.handlers.clear();
        this.context = undefined;
        this.initialized = false;

        StatusLogger.info('[InterInstanceBus] Inter-instance bus disposed');
    }

    /**
     * 发布事件到所有实例
     */
    static publish(event: Omit<InterInstanceEvent, 'timestamp' | 'senderInstanceId'>): void {
        if (!this.initialized || !this.context) {
            return;
        }

        const fullEvent = {
            ...event,
            timestamp: Date.now(),
            senderInstanceId: this.instanceId ?? 'unknown'
        } as InterInstanceEvent;

        // Leader 通过 IPC 广播；Follower 通过 IPC client 发送给 Leader，再由 Leader 中继
        const ipcAvailable = !!this.server || !!this.client;
        if (this.server) {
            this.server.broadcast(fullEvent);
        } else if (this.client) {
            this.client.send(fullEvent);
        }

        // IPC 不可用时才启用文件系统降级通道。
        // 注意：即使当前是 Leader 也可能暂时 server 未就绪，因此只要 ipcAvailable 为 false 就启用 fallback。
        if (!ipcAvailable) {
            this.fallbackActive = true;
            this.startFallbackTransport();
            this.fallbackTransport
                ?.publish(fullEvent)
                .catch(error => StatusLogger.warn('[InterInstanceBus] Failed to publish fallback event', error));
        }
    }

    /**
     * 仅通过 IPC 发布事件，不启用文件系统降级通道。
     * 用于高频实时事件（如 liveMetrics），避免 fallback 文件 I/O 开销。
     * IPC 未连接时直接丢弃。
     */
    static publishIpcOnly(event: Omit<InterInstanceEvent, 'timestamp' | 'senderInstanceId'>): void {
        if (!this.initialized || !this.context) {
            return;
        }

        const fullEvent = {
            ...event,
            timestamp: Date.now(),
            senderInstanceId: this.instanceId ?? 'unknown'
        } as InterInstanceEvent;

        if (this.server) {
            this.server.broadcast(fullEvent);
        } else if (this.client) {
            this.client.send(fullEvent);
        }
    }

    /**
     * 订阅指定类型的事件
     * @param type 事件类型，传入 '*' 订阅所有事件
     * @param handler 回调函数
     * @returns 用于取消订阅的 Disposable
     */
    static subscribe<T extends InterInstanceEvent>(
        type: T['type'] | '*',
        handler: InterInstanceEventHandler<T>
    ): vscode.Disposable {
        const key = type;
        if (!this.handlers.has(key)) {
            this.handlers.set(key, new Set());
        }
        const set = this.handlers.get(key)!;
        const wrappedHandler = handler as InterInstanceEventHandler<InterInstanceEvent>;
        set.add(wrappedHandler);

        return new vscode.Disposable(() => {
            set.delete(wrappedHandler);
        });
    }

    /**
     * 当前是否通过 IPC 连接
     */
    static isConnected(): boolean {
        if (LeaderElectionService.isLeader()) {
            return !!this.server;
        }
        return !!this.client;
    }

    /**
     * 获取当前已连接的 Follower instanceId 列表。
     * 仅当本实例为 Leader 时返回有效数据，否则返回空数组。
     */
    static getConnectedFollowerIds(): string[] {
        return this.server?.getConnectedFollowerIds() ?? [];
    }

    private static async becomeLeader(): Promise<void> {
        if (!this.options.enabled || !this.context) {
            return;
        }

        // 先断开之前的 client（如果之前是 follower）
        await this.client?.disconnect();
        this.client = undefined;

        // 启动 IPC 服务器
        const ipcPath = resolveIpcPath(LeaderElectionService.getInstanceId());
        this.server = new IpcServer({
            onMessage: event => this.dispatchEvent(event)
        });

        try {
            await this.server.start(ipcPath);
            StatusLogger.info(`[InterInstanceBus] IPC server started at ${ipcPath}`);
        } catch (error) {
            StatusLogger.error('[InterInstanceBus] Failed to start IPC server', error);
            this.server = undefined;
            // Leader IPC 启动失败，启用文件 fallback
            this.fallbackActive = true;
            this.startFallbackTransport();
        }
    }

    private static async becomeFollower(): Promise<void> {
        if (!this.options.enabled || !this.context) {
            return;
        }

        // 先停止 server（如果之前是 leader）
        await this.server?.stop();
        this.server = undefined;

        // 连接 Leader
        await this.connectToLeader();
    }

    private static async connectToLeader(): Promise<void> {
        const leaderId = LeaderElectionService.getLeaderId();
        if (!leaderId) {
            StatusLogger.debug('[InterInstanceBus] No leader available, will retry');
            this.scheduleReconnect();
            return;
        }

        // 避免自己连接自己
        if (leaderId === this.instanceId) {
            return;
        }

        const ipcPath = resolveIpcPath(leaderId);

        this.client = new IpcClient({
            onMessage: event => {
                this.dispatchEvent(event);
            },
            onDisconnect: () => {
                this.scheduleReconnect();
            }
        });

        try {
            await this.client.connect(ipcPath);
            this.reconnectAttempts = 0;
            StatusLogger.info(`[InterInstanceBus] Connected to leader ${leaderId}`);
        } catch (error) {
            StatusLogger.warn('[InterInstanceBus] Failed to connect to leader IPC', error);
            this.client = undefined;
            // IPC 连接失败，启用文件 fallback
            this.fallbackActive = true;
            this.startFallbackTransport();
            this.scheduleReconnect();
        }
    }

    private static scheduleReconnect(): void {
        if (this.reconnectTimer || LeaderElectionService.isLeader()) {
            return;
        }
        // 指数退避：2s, 4s, 8s... 封顶 60s
        const baseDelay = 2000;
        const delay = Math.min(baseDelay * 2 ** this.reconnectAttempts, this.MAX_RECONNECT_DELAY_MS);
        this.reconnectAttempts += 1;

        this.reconnectTimer = setTimeout(async () => {
            this.reconnectTimer = undefined;
            if (!LeaderElectionService.isLeader()) {
                await this.connectToLeader();
            }
        }, delay);
    }

    private static startFallbackTransport(): void {
        if (this.fallbackTransport) {
            return;
        }
        this.fallbackTransport = new FallbackTransport({
            instanceId: this.instanceId ?? 'unknown',
            onEvent: event => this.dispatchEvent(event)
        });
        if (this.context) {
            this.fallbackTransport.start(this.context);
            if (this.fallbackActive) {
                StatusLogger.warn('[InterInstanceBus] Fallback file transport activated');
            }
        }
    }

    private static dispatchEvent(event: InterInstanceEvent): void {
        // 跳过自己发送的事件
        if (event.senderInstanceId === this.instanceId) {
            return;
        }

        // 触发具体类型订阅
        const typeHandlers = this.handlers.get(event.type);
        if (typeHandlers) {
            for (const handler of typeHandlers) {
                try {
                    handler(event);
                } catch (error) {
                    StatusLogger.warn('[InterInstanceBus] Event handler error', error);
                }
            }
        }

        // 触发通配符订阅
        const allHandlers = this.handlers.get('*');
        if (allHandlers) {
            for (const handler of allHandlers) {
                try {
                    handler(event);
                } catch (error) {
                    StatusLogger.warn('[InterInstanceBus] Event handler error', error);
                }
            }
        }
    }
}
