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
import { LeaderFilePublisher, readLeaderFile } from './leaderFile';
import { LeaderElectionService } from '../status/leaderElectionService';
import { StatusLogger } from '../utils/runtime/statusLogger';

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
 * 3. 在 IPC 不可用时将基础通知类事件降级到 globalState 轮询
 *
 * 说明：
 * - 高频实时事件（如 liveMetrics）只走 IPC，不保证补投递。
 * - 基础通知类事件（状态栏/配置/API Key/统计/同步完成）也属于非关键事件，允许短暂丢失；
 *   但在可低成本优化的情况下，仍尽量在 IPC 断线窗口回退到 fallback 通道。
 */
export class InterInstanceBus {
    private static context: vscode.ExtensionContext | undefined;
    private static instanceId: string | undefined;
    private static options: InterInstanceBusOptions = {};
    private static initialized = false;

    private static server: IpcServer | undefined;
    private static client: IpcClient | undefined;
    private static leaderFilePublisher: LeaderFilePublisher | undefined;
    private static fallbackTransport: FallbackTransport | undefined;
    /** IPC 完全失败时启用文件 fallback；保留此标记用于调试 fallback 触发场景 */
    private static fallbackActive = false;

    private static handlers = new Map<string, Set<InterInstanceEventHandler<InterInstanceEvent>>>();
    private static leaderChangeDisposable: vscode.Disposable | undefined;
    private static reconnectTimer: NodeJS.Timeout | undefined;
    private static reconnectAttempts = 0;
    private static readonly MAX_RECONNECT_DELAY_MS = 60_000;
    /** 角色切换串行化：避免 becomeLeader/becomeFollower 并发交错导致 server+client 双活 */
    private static roleSwitchChain: Promise<void> = Promise.resolve();
    /** 生命周期代次：dispose/重新 initialize 后作废旧的异步角色切换与重连任务 */
    private static lifecycleGeneration = 0;

    /**
     * 初始化总线
     */
    static initialize(context: vscode.ExtensionContext, options: InterInstanceBusOptions = {}): void {
        if (this.initialized) {
            return;
        }

        this.lifecycleGeneration++;
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

        // 监听 Leader 变化（角色切换经串行链执行，避免并发交错）
        this.leaderChangeDisposable = LeaderElectionService.onLeaderChanged(isLeader => {
            StatusLogger.info(`[InterInstanceBus] Leader changed: isLeader=${isLeader}`);
            this.enqueueRoleSwitch(isLeader);
        });

        // 根据当前角色初始化 IPC 端点
        this.initialized = true;
        this.enqueueRoleSwitch(LeaderElectionService.isLeader());

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
        // 先使所有已排队/执行中的角色切换与重连任务失效，再等待切换链排空。
        this.initialized = false;
        this.lifecycleGeneration++;

        if (this.reconnectTimer) {
            clearTimeout(this.reconnectTimer);
            this.reconnectTimer = undefined;
        }
        this.reconnectAttempts = 0;

        this.leaderChangeDisposable?.dispose();
        this.leaderChangeDisposable = undefined;

        await this.roleSwitchChain.catch(error =>
            StatusLogger.warn('[InterInstanceBus] Failed to drain role switch chain during dispose', error)
        );

        await this.client?.disconnect();
        this.client = undefined;

        await this.stopLeaderFilePublisher();
        await this.server?.stop();
        this.server = undefined;

        await this.fallbackTransport?.stop();
        this.fallbackTransport = undefined;

        this.handlers.clear();
        this.context = undefined;
        this.roleSwitchChain = Promise.resolve();

        StatusLogger.info('[InterInstanceBus] Inter-instance bus disposed');
    }

    /**
     * 发布事件到所有实例
     * @param event 事件
     * @param options.alsoFallback 为 true 时即使 IPC 可用也同时写入 fallback 文件通道，
     * 用于请求-回执类事件（如 statsRefreshCompleted），保证降级 Follower 能收到回执
     */
    static publish(
        event: Omit<InterInstanceEvent, 'timestamp' | 'senderInstanceId'>,
        options?: { alsoFallback?: boolean }
    ): void {
        if (!this.initialized || !this.context) {
            return;
        }

        const fullEvent = {
            ...event,
            timestamp: Date.now(),
            senderInstanceId: this.instanceId ?? 'unknown'
        } as InterInstanceEvent;

        // 基础通知类事件采用 best-effort 语义：
        // 1. 优先走 IPC；
        // 2. IPC 当前不可用时再走 fallback；
        // 3. 即便瞬时丢失也不影响核心正确性。
        // 注意这里必须检查 client 的真实连接状态，而不是仅判断对象是否存在，
        // 否则 follower 在断线重连窗口内会把事件静默写入 no-op send，错过 fallback 优化机会。
        const ipcAvailable = !!this.server || this.client?.isConnected() === true;
        if (this.server) {
            this.server.broadcast(fullEvent);
        } else if (this.client?.isConnected()) {
            this.client.send(fullEvent);
        }

        // IPC 不可用时启用文件系统降级通道。
        // 注意：即使当前是 Leader 也可能暂时 server 未就绪，因此只要 ipcAvailable 为 false 就启用 fallback。
        // alsoFallback（请求-回执类事件）时始终双写：Leader 广播走 IPC 到不了已降级的 Follower，
        // 双写保证降级 Follower 也能从文件通道收到回执；IPC 直连的 Follower 会收到两次，
        // 但回执处理按 requestId 幂等（首次匹配后即删除等待项），重复派发为 no-op。
        if (!ipcAvailable || options?.alsoFallback) {
            if (!ipcAvailable) {
                this.fallbackActive = true;
            }
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

        // 设计意图：高频实时状态只走 IPC，IPC 不可用时直接降级为“当前 session 内可见”。
        if (this.server) {
            this.server.broadcast(fullEvent);
        } else if (this.client?.isConnected()) {
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
        return this.client?.isConnected() === true;
    }

    /**
     * 获取当前已连接的 Follower instanceId 列表。
     * 仅当本实例为 Leader 时返回有效数据，否则返回空数组。
     */
    static getConnectedFollowerIds(): string[] {
        return this.server?.getConnectedFollowerIds() ?? [];
    }

    /**
     * 角色切换串行化入口。
     * onLeaderChanged 可能在短时间内连续触发（选举结算期），若异步 become* 并发执行，
     * 可能出现 server 启动挂起期间 client 已建立、最终 server+client 双活的状态。
     * 所有切换经 Promise 链依次执行，且每次执行前以最新角色为准。
     */
    private static enqueueRoleSwitch(isLeader: boolean): void {
        const generation = this.lifecycleGeneration;
        this.roleSwitchChain = this.roleSwitchChain
            .then(async () => {
                if (!this.initialized || generation !== this.lifecycleGeneration) {
                    return;
                }
                // 以落地时的最新角色为准，跳过过期切换请求
                const currentIsLeader = LeaderElectionService.isLeader();
                if (currentIsLeader !== isLeader) {
                    StatusLogger.debug(
                        `[InterInstanceBus] Role switch stale (requested=${isLeader}, current=${currentIsLeader}), skipped`
                    );
                    return;
                }
                if (isLeader) {
                    await this.becomeLeader();
                } else {
                    await this.becomeFollower();
                }
            })
            .catch(error => StatusLogger.error('[InterInstanceBus] Failed to switch role', error));
    }

    private static async becomeLeader(): Promise<void> {
        if (!this.options.enabled || !this.context) {
            return;
        }

        await this.stopLeaderFilePublisher();

        // 先断开之前的 client（如果之前是 follower）
        await this.client?.disconnect();
        this.client = undefined;

        // 启动 IPC 服务器
        const ipcPath = resolveIpcPath(LeaderElectionService.getInstanceId());
        const server = new IpcServer({
            onMessage: event => this.dispatchEvent(event)
        });

        try {
            await server.start(ipcPath);
            // await 期间角色可能已变更（如又变回 follower），落地前校验
            if (!this.initialized || !this.context || !LeaderElectionService.isLeader()) {
                await server.stop();
                StatusLogger.debug('[InterInstanceBus] No longer leader after server start, stopped');
                return;
            }
            this.server = server;
            // Agents 窗体通过发现文件连接普通窗口 Leader；周期刷新可修正交接时迟到的旧写入。
            const publisher = new LeaderFilePublisher(LeaderElectionService.getInstanceId(), ipcPath);
            this.leaderFilePublisher = publisher;
            await publisher.start();
            if (!this.initialized || !this.context || !LeaderElectionService.isLeader()) {
                await this.stopLeaderFilePublisher();
                await server.stop();
                this.server = undefined;
                StatusLogger.debug('[InterInstanceBus] No longer leader after discovery publish, stopped');
                return;
            }
            StatusLogger.info(`[InterInstanceBus] IPC server started at ${ipcPath}`);
        } catch (error) {
            StatusLogger.error('[InterInstanceBus] Failed to start IPC server', error);
            await this.stopLeaderFilePublisher();
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

        await this.stopLeaderFilePublisher();

        // 先停止 server（如果之前是 leader）
        await this.server?.stop();
        this.server = undefined;

        if (!this.initialized || !this.context) {
            return;
        }

        // 连接 Leader
        await this.connectToLeader();
    }

    private static async stopLeaderFilePublisher(): Promise<void> {
        const publisher = this.leaderFilePublisher;
        this.leaderFilePublisher = undefined;
        await publisher?.stop();
    }

    private static async connectToLeader(): Promise<void> {
        if (!this.initialized || !this.context) {
            return;
        }

        const generation = this.lifecycleGeneration;
        let ipcPath: string;
        if (LeaderElectionService.isAgentsWindow()) {
            // Agents 窗体不参与选举：从 Leader 发现文件读取普通窗口 Leader 的 IPC 地址。
            // 文件缺失或连接失败均由 scheduleReconnect 退避重试，新 Leader 写文件后自愈。
            const leaderInfo = readLeaderFile();
            if (!leaderInfo) {
                StatusLogger.debug('[InterInstanceBus] No leader file available, will retry');
                this.scheduleReconnect();
                return;
            }
            if (leaderInfo.instanceId === this.instanceId) {
                return;
            }
            ipcPath = leaderInfo.ipcPath;
        } else {
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

            ipcPath = resolveIpcPath(leaderId);
        }

        // 先断开可能残留的旧连接，避免断线事件与重连竞态导致旧 socket 被遗弃后继续派发事件
        await this.client?.disconnect();
        this.client = undefined;

        this.client = new IpcClient({
            onMessage: event => {
                this.dispatchEvent(event);
            },
            onDisconnect: () => {
                // 基础事件为非关键通知；断线后无需补历史，仅尽快重连。
                // 但 publish() 会基于真实连接状态选择 fallback，从而减少重连窗口内的静默丢失。
                this.scheduleReconnect();
            }
        });

        try {
            await this.client.connect(ipcPath);
            if (!this.initialized || generation !== this.lifecycleGeneration) {
                await this.client.disconnect();
                this.client = undefined;
                return;
            }
            this.reconnectAttempts = 0;
            StatusLogger.info(`[InterInstanceBus] Connected to leader at ${ipcPath}`);
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
        if (!this.initialized || !this.context || this.reconnectTimer || LeaderElectionService.isLeader()) {
            return;
        }
        const generation = this.lifecycleGeneration;
        // 指数退避：2s, 4s, 8s... 封顶 60s
        const baseDelay = 2000;
        const delay = Math.min(baseDelay * 2 ** this.reconnectAttempts, this.MAX_RECONNECT_DELAY_MS);
        this.reconnectAttempts += 1;

        this.reconnectTimer = setTimeout(() => {
            this.reconnectTimer = undefined;
            if (
                this.initialized &&
                this.context &&
                generation === this.lifecycleGeneration &&
                !LeaderElectionService.isLeader()
            ) {
                // 重连纳入角色切换串行链，避免与链上 become* 并发交错导致 client 引用被覆盖
                this.enqueueRoleSwitch(false);
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
