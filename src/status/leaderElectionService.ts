import * as vscode from 'vscode';
import * as crypto from 'node:crypto';
import { StatusLogger } from '../utils/statusLogger';
import { UserActivityService } from './userActivityService';
import { InterInstanceBus, type LeaderResigningEvent } from '../interInstance';

interface LeaderInfo {
    instanceId: string;
    lastHeartbeat: number;
    electedAt: number; // 竞选成功的时间戳，用于解决竞态条件
}

/**
 * 主实例竞选服务（纯静态类）
 * 确保在多 VS Code 实例中只有一个主实例负责执行周期性任务
 */
export class LeaderElectionService {
    private static readonly LEADER_KEY = 'gcmp.leader.info.v2';
    private static readonly HEARTBEAT_INTERVAL = 5000; // 5秒心跳
    private static readonly LEADER_TIMEOUT = 15000; // 15秒超时
    private static readonly TASK_INTERVAL = 60 * 1000; // 默认任务执行间隔（1分钟）

    // 静态成员变量
    private static instanceId: string;
    private static context: vscode.ExtensionContext | undefined;
    private static heartbeatTimer: NodeJS.Timeout | undefined;
    private static taskTimer: NodeJS.Timeout | undefined;
    private static _isLeader = false;
    private static initialized = false;

    private static periodicTasks: Array<() => Promise<void>> = [];

    // Leader 状态变更事件
    private static leaderChangedEmitter = new vscode.EventEmitter<boolean>();
    static readonly onLeaderChanged = LeaderElectionService.leaderChangedEmitter.event;

    /**
     * 私有构造函数 - 防止实例化
     */
    private constructor() {
        throw new Error('LeaderElectionService is a static class and cannot be instantiated');
    }

    /**
     * 初始化竞选服务（必须在扩展激活时调用）
     */
    public static initialize(context: vscode.ExtensionContext): void {
        if (this.initialized) {
            return;
        }

        this.registerPeriodicTask(async () => {
            StatusLogger.trace('[LeaderElectionService] Leader periodic task: recording alive log');
        });

        this.instanceId = crypto.randomUUID();
        this.context = context;
        StatusLogger.info(
            `[LeaderElectionService] Initializing leader election service, current instance ID: ${this.instanceId}`
        );

        // 初始化用户活跃检测服务
        UserActivityService.initialize(context, this.instanceId);

        // 添加随机延迟 (0-1000ms)，避免多个实例同时启动时的竞态条件
        const startDelay = Math.random() * 1000;
        setTimeout(() => {
            this.start();
        }, startDelay);

        this.initialized = true;
    }

    /**
     * 启动竞选服务
     */
    private static start(): void {
        if (!this.context) {
            StatusLogger.warn('[LeaderElectionService] Election service not initialized, cannot start');
            return;
        }

        this.checkLeader();
        this.heartbeatTimer = setInterval(() => this.checkLeader(), this.HEARTBEAT_INTERVAL);

        // 启动周期性任务检查
        this.taskTimer = setInterval(() => {
            if (this._isLeader) {
                this.executePeriodicTasks();
            }
        }, this.TASK_INTERVAL);
    }

    /**
     * 停止竞选服务
     * 注意：必须 await 整个方法，确保 resignLeader 完成后再返回，
     * 避免 deactivate 提前结束后 Leader 信息残留。
     */
    public static async stop(): Promise<void> {
        if (this.heartbeatTimer) {
            clearInterval(this.heartbeatTimer);
            this.heartbeatTimer = undefined;
        }
        if (this.taskTimer) {
            clearInterval(this.taskTimer);
            this.taskTimer = undefined;
        }

        // 停止用户活跃检测服务
        UserActivityService.stop();

        // 如果是 Leader，先通过 IPC 通知其他实例即将卸任，让它们立即开始竞选。
        // 优先从已连接的 Follower 中指定下一任 Leader（最长连接者），减少广播竞选。
        if (this._isLeader) {
            try {
                const followers = InterInstanceBus.getConnectedFollowerIds();
                const nextLeaderId = followers.length > 0 ? followers[0] : undefined;
                InterInstanceBus.publishIpcOnly({
                    type: 'leaderResigning',
                    payload: { leaderId: this.instanceId, nextLeaderId }
                });
                StatusLogger.info(
                    `[LeaderElectionService] Broadcast leaderResigning before shutdown${
                        nextLeaderId ? `, nominated next leader: ${nextLeaderId}` : ''
                    }`
                );
            } catch (error) {
                StatusLogger.warn('[LeaderElectionService] Failed to broadcast leaderResigning', error);
            }
        }

        // 如果是 Leader，必须 await 释放流程，确保 globalState 清除完成
        try {
            await this.resignLeader();
        } catch (error) {
            StatusLogger.warn('[LeaderElectionService] Failed to release leader identity during stop', error);
        }
        this.initialized = false;
    }

    /**
     * 注册周期性任务（仅在主实例执行）
     * @param task 任务函数
     */
    public static registerPeriodicTask(task: () => Promise<void>): void {
        this.periodicTasks.push(task);
    }

    /**
     * 设置 Leader 状态并触发事件
     */
    private static setLeaderState(value: boolean): void {
        if (this._isLeader === value) {
            return;
        }
        this._isLeader = value;
        StatusLogger.info(`[LeaderElectionService] Leader state changed: isLeader=${value}`);
        this.leaderChangedEmitter.fire(value);
    }

    /**
     * 获取当前实例是否为主实例
     */
    public static isLeader(): boolean {
        return this._isLeader;
    }

    /**
     * 获取当前实例ID
     */
    public static getInstanceId(): string {
        return this.instanceId;
    }

    /**
     * 获取主实例的ID（如果存在）
     */
    public static getLeaderId(): string | undefined {
        if (!this.context) {
            return undefined;
        }
        const leaderInfo = this.context.globalState.get<LeaderInfo>(this.LEADER_KEY);
        return leaderInfo?.instanceId;
    }

    /**
     * 监听 Leader 卸任通知。
     * 在 LeaderElectionService.initialize 完成后调用，避免 InterInstanceBus 尚未初始化。
     */
    public static subscribeToLeaderResigning(): void {
        if (!this.context) {
            return;
        }
        this.context.subscriptions.push(
            InterInstanceBus.subscribe('leaderResigning', event => {
                const { leaderId: resigningLeaderId, nextLeaderId } = (event as LeaderResigningEvent).payload;
                if (resigningLeaderId === this.instanceId) {
                    return;
                }

                StatusLogger.info(
                    `[LeaderElectionService] Received leaderResigning from ${resigningLeaderId}${
                        nextLeaderId ? `, nominated next leader: ${nextLeaderId}` : ''
                    }`
                );

                // 如果当前实例被提名为下一任 Leader，立即尝试接管，不等待心跳超时。
                // 最多重试 3 次，全部失败后退回到常规竞选。
                if (nextLeaderId === this.instanceId) {
                    void this.takeoverAsNominated();
                    return;
                }

                // 已指定下一任 Leader 时，非提名实例等待几次确认新 Leader 是否已接管，
                // 若接管成功则无需竞争；若超时未接管再进入竞选。
                if (nextLeaderId) {
                    void this.waitForNominatedTakeover(nextLeaderId, resigningLeaderId);
                    return;
                }

                // 未指定下一任 Leader 时，退回到普通快速检查
                void this.checkLeader();
            })
        );
    }

    private static async checkLeader(): Promise<void> {
        if (!this.context) {
            return;
        }

        const now = Date.now();
        const leaderInfo = this.context.globalState.get<LeaderInfo>(this.LEADER_KEY);
        StatusLogger.trace(
            `[LeaderElectionService] Heartbeat check: leaderInfo=${leaderInfo ? `instanceId=${leaderInfo.instanceId}, lastHeartbeat=${leaderInfo.lastHeartbeat}` : 'null'}`
        );

        if (!leaderInfo) {
            // 没有 Leader，尝试成为 Leader
            StatusLogger.trace('[LeaderElectionService] No Leader found, attempting election...');
            await this.becomeLeader();
            return;
        }

        if (leaderInfo.instanceId === this.instanceId) {
            // 我是 Leader，更新心跳
            StatusLogger.trace('[LeaderElectionService] Confirmed as Leader, updating heartbeat');
            await this.updateHeartbeat();
            if (!this._isLeader) {
                this.setLeaderState(true);
                StatusLogger.info('[LeaderElectionService] Current instance has become the leader');
            }
        } else {
            // 别人是 Leader
            StatusLogger.trace(`[LeaderElectionService] Detected another leader: ${leaderInfo.instanceId}`);
            // 如果我之前是 Leader，但现在 globalState 中的 Leader 不是我，说明被其他实例覆盖了
            if (this._isLeader) {
                this.setLeaderState(false);
                StatusLogger.warn(
                    `[LeaderElectionService] Leader role was overridden by instance ${leaderInfo.instanceId}, stepping down`
                );
            }

            // 检查该 Leader 是否超时
            const heartbeatAge = now - leaderInfo.lastHeartbeat;
            StatusLogger.trace(
                `[LeaderElectionService] Leader heartbeat age: ${heartbeatAge}ms (timeout threshold: ${this.LEADER_TIMEOUT}ms)`
            );
            if (heartbeatAge > this.LEADER_TIMEOUT) {
                StatusLogger.info(
                    `[LeaderElectionService] Leader ${leaderInfo.instanceId} heartbeat timed out, attempting takeover...`
                );
                await this.becomeLeader();
            }
        }
    }

    /**
     * 被提名实例尝试接管 Leader 身份，最多重试 NOMINATED_TAKEOVER_ATTEMPTS 次。
     * 每次失败后等待 NOMINATED_TAKEOVER_DELAY_MS 再重试，全部失败后退回到常规竞选。
     */
    private static async takeoverAsNominated(): Promise<void> {
        const NOMINATED_TAKEOVER_ATTEMPTS = 3;
        const NOMINATED_TAKEOVER_DELAY_MS = 200;

        for (let attempt = 1; attempt <= NOMINATED_TAKEOVER_ATTEMPTS; attempt++) {
            if (this._isLeader) {
                return;
            }

            StatusLogger.info(
                `[LeaderElectionService] Attempting nominated takeover, attempt ${attempt}/${NOMINATED_TAKEOVER_ATTEMPTS}`
            );
            await this.becomeLeader(true);

            if (this._isLeader) {
                return;
            }

            if (attempt < NOMINATED_TAKEOVER_ATTEMPTS) {
                await new Promise(resolve => setTimeout(resolve, NOMINATED_TAKEOVER_DELAY_MS));
            }
        }

        StatusLogger.info(
            '[LeaderElectionService] Nominated takeover failed after all attempts, falling back to election'
        );
        await this.checkLeader();
    }

    /**
     * 收到 leaderResigning 后，等待并确认新 Leader 是否已接管。
     * 最多检查 NOMINATED_TAKEOVER_ATTEMPTS 次，若新 Leader 仍未写入 globalState，则进入竞选。
     */
    private static async waitForNominatedTakeover(
        nominatedNextLeaderId: string,
        resigningLeaderId: string
    ): Promise<void> {
        const NOMINATED_TAKEOVER_ATTEMPTS = 3;
        const NOMINATED_TAKEOVER_DELAY_MS = 200;

        for (let attempt = 1; attempt <= NOMINATED_TAKEOVER_ATTEMPTS; attempt++) {
            const currentInfo = this.context?.globalState.get<LeaderInfo>(this.LEADER_KEY);

            if (currentInfo && currentInfo.instanceId !== resigningLeaderId) {
                StatusLogger.info(
                    `[LeaderElectionService] Nominated takeover observed: new leader ${currentInfo.instanceId} at attempt ${attempt}`
                );
                return;
            }

            if (attempt < NOMINATED_TAKEOVER_ATTEMPTS) {
                StatusLogger.trace(
                    `[LeaderElectionService] Waiting for nominated takeover ${nominatedNextLeaderId}, attempt ${attempt}/${NOMINATED_TAKEOVER_ATTEMPTS}`
                );
                await new Promise(resolve => setTimeout(resolve, NOMINATED_TAKEOVER_DELAY_MS));
            }
        }

        StatusLogger.info(
            '[LeaderElectionService] Nominated takeover did not happen in time, falling back to election'
        );
        await this.checkLeader();
    }

    private static async becomeLeader(force: boolean = false): Promise<void> {
        if (!this.context) {
            return;
        }

        StatusLogger.trace('[LeaderElectionService] Starting election process...');
        // 读取当前 Leader 信息
        const existingLeader = this.context.globalState.get<LeaderInfo>(this.LEADER_KEY);

        // 如果已有 Leader 且未超时，不应该尝试竞选（除非被强制接管）
        if (existingLeader && !force) {
            const now = Date.now();
            const heartbeatAge = now - existingLeader.lastHeartbeat;
            if (heartbeatAge <= this.LEADER_TIMEOUT) {
                StatusLogger.trace(
                    `[LeaderElectionService] Active leader ${existingLeader.instanceId} already exists (heartbeat age: ${heartbeatAge}ms), aborting election`
                );
                return;
            }
        }

        const now = Date.now();
        const info: LeaderInfo = {
            instanceId: this.instanceId,
            lastHeartbeat: now,
            electedAt: now
        };

        StatusLogger.trace(
            `[LeaderElectionService] Writing election info: instanceId=${this.instanceId}, electedAt=${now}`
        );
        // 尝试写入
        await this.context.globalState.update(this.LEADER_KEY, info);

        // 等待一小段时间，让其他竞争者也完成写入
        StatusLogger.trace('[LeaderElectionService] Waiting for other contenders to write...');
        await new Promise(resolve => setTimeout(resolve, 100));

        // 再次读取确认是谁最终成为 Leader
        const currentInfo = this.context.globalState.get<LeaderInfo>(this.LEADER_KEY);

        if (!currentInfo) {
            StatusLogger.warn('[LeaderElectionService] Election failed: cannot read Leader info');
            return;
        }

        StatusLogger.trace(
            `[LeaderElectionService] Election result: currentLeader=${currentInfo.instanceId}, electedAt=${currentInfo.electedAt}`
        );
        // 比较策略：先比较 electedAt 时间戳，再比较 instanceId 字符串
        const isWinner =
            currentInfo.instanceId === this.instanceId ||
            (currentInfo.electedAt === info.electedAt && currentInfo.instanceId < this.instanceId);

        if (isWinner && currentInfo.instanceId === this.instanceId) {
            if (!this._isLeader) {
                this.setLeaderState(true);
                StatusLogger.info('[LeaderElectionService] Election succeeded, current instance is the leader');
            }
        } else {
            StatusLogger.debug(
                `[LeaderElectionService] Election lost, instance ${currentInfo.instanceId} became the leader (electedAt: ${currentInfo.electedAt})`
            );
            // 如果之前误以为自己是 Leader，现在退位
            if (this._isLeader) {
                this.setLeaderState(false);
                StatusLogger.info(
                    `[LeaderElectionService] Election lost, instance ${currentInfo.instanceId} became the leader`
                );
            }
        }
    }

    private static async updateHeartbeat(): Promise<void> {
        if (!this._isLeader || !this.context) {
            return;
        }

        // 读取当前 Leader 信息以保留 electedAt
        const currentInfo = this.context.globalState.get<LeaderInfo>(this.LEADER_KEY);
        const newHeartbeat = Date.now();

        const info: LeaderInfo = {
            instanceId: this.instanceId,
            lastHeartbeat: newHeartbeat,
            electedAt: currentInfo?.electedAt || newHeartbeat
        };
        StatusLogger.trace(`[LeaderElectionService] Updating heartbeat: lastHeartbeat=${newHeartbeat}`);
        await this.context.globalState.update(this.LEADER_KEY, info);
    }

    private static async resignLeader(): Promise<void> {
        if (this._isLeader && this.context) {
            // 广播 leaderResigning 后，被提名实例可能已经写入新的 Leader 信息。
            // 清除前重新读取并确认仍是自己的信息，避免误清被提名实例的接管结果。
            const currentInfo = this.context.globalState.get<LeaderInfo>(this.LEADER_KEY);
            if (currentInfo && currentInfo.instanceId === this.instanceId) {
                await this.context.globalState.update(this.LEADER_KEY, undefined);
                StatusLogger.info('[LeaderElectionService] Instance released: leader identity cleared');
            } else if (currentInfo) {
                StatusLogger.info(
                    `[LeaderElectionService] Skip clearing leader identity: already taken over by ${currentInfo.instanceId}`
                );
            }
            this.setLeaderState(false);
            StatusLogger.debug('[LeaderElectionService] Instance released: exited leader identity');
        }
    }

    private static async executePeriodicTasks(): Promise<void> {
        // 检查用户是否在30分钟内有活跃（使用 UserActivityService）
        if (!UserActivityService.isUserActive()) {
            const inactiveMinutes = Math.floor(UserActivityService.getInactiveTime() / 60000);
            StatusLogger.debug(
                `[LeaderElectionService] User has been inactive for ${inactiveMinutes} minutes, pausing periodic tasks`
            );
            return;
        }

        StatusLogger.trace(
            `[LeaderElectionService] Starting execution of ${this.periodicTasks.length} periodic tasks...`
        );
        for (const task of this.periodicTasks) {
            try {
                await task();
            } catch (error) {
                StatusLogger.error('[LeaderElectionService] Error executing periodic task:', error);
            }
        }
        StatusLogger.trace('[LeaderElectionService] Periodic task completed');
    }
}
