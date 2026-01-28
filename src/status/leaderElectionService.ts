import * as vscode from 'vscode';
import * as crypto from 'node:crypto';
import { StatusLogger } from '../utils/statusLogger';
import { UserActivityService } from './userActivityService';

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
    private static readonly LEADER_KEY = 'gcmp.leader.info';
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
            StatusLogger.trace('[LeaderElectionService] 主实例周期性任务：记录存活日志');
        });

        this.instanceId = crypto.randomUUID();
        this.context = context;
        StatusLogger.info(`[LeaderElectionService] 初始化主实例竞选服务，当前实例ID: ${this.instanceId}`);

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
            StatusLogger.warn('[LeaderElectionService] 竞选服务未初始化，无法启动');
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
     */
    public static stop(): void {
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

        // 如果是 Leader，尝试主动释放
        this.resignLeader();
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

    private static async checkLeader(): Promise<void> {
        if (!this.context) {
            return;
        }

        const now = Date.now();
        const leaderInfo = this.context.globalState.get<LeaderInfo>(this.LEADER_KEY);
        StatusLogger.trace(
            `[LeaderElectionService] 心跳检查：leaderInfo=${leaderInfo ? `instanceId=${leaderInfo.instanceId}, lastHeartbeat=${leaderInfo.lastHeartbeat}` : 'null'}`
        );

        if (!leaderInfo) {
            // 没有 Leader，尝试成为 Leader
            StatusLogger.trace('[LeaderElectionService] 未发现 Leader，尝试竞选...');
            await this.becomeLeader();
            return;
        }

        if (leaderInfo.instanceId === this.instanceId) {
            // 我是 Leader，更新心跳
            StatusLogger.trace('[LeaderElectionService] 确认自己是 Leader，更新心跳');
            await this.updateHeartbeat();
            if (!this._isLeader) {
                this._isLeader = true;
                StatusLogger.info('[LeaderElectionService] 当前实例已成为主实例');
            }
        } else {
            // 别人是 Leader
            StatusLogger.trace(`[LeaderElectionService] 检测到其他 Leader: ${leaderInfo.instanceId}`);
            // 如果我之前是 Leader，但现在 globalState 中的 Leader 不是我，说明被其他实例覆盖了
            if (this._isLeader) {
                this._isLeader = false;
                StatusLogger.warn(
                    `[LeaderElectionService] 检测到主实例被其他实例 ${leaderInfo.instanceId} 覆盖，当前实例退位`
                );
            }

            // 检查该 Leader 是否超时
            const heartbeatAge = now - leaderInfo.lastHeartbeat;
            StatusLogger.trace(
                `[LeaderElectionService] Leader 心跳年龄: ${heartbeatAge}ms (超时阈值: ${this.LEADER_TIMEOUT}ms)`
            );
            if (heartbeatAge > this.LEADER_TIMEOUT) {
                StatusLogger.info(`[LeaderElectionService] 主实例 ${leaderInfo.instanceId} 心跳超时，尝试接管...`);
                await this.becomeLeader();
            }
        }
    }

    private static async becomeLeader(): Promise<void> {
        if (!this.context) {
            return;
        }

        StatusLogger.trace('[LeaderElectionService] 开始竞选流程...');
        // 读取当前 Leader 信息
        const existingLeader = this.context.globalState.get<LeaderInfo>(this.LEADER_KEY);

        // 如果已有 Leader 且未超时，不应该尝试竞选
        if (existingLeader) {
            const now = Date.now();
            const heartbeatAge = now - existingLeader.lastHeartbeat;
            if (heartbeatAge <= this.LEADER_TIMEOUT) {
                StatusLogger.trace(
                    `[LeaderElectionService] 已有活跃的主实例 ${existingLeader.instanceId} (心跳年龄: ${heartbeatAge}ms)，放弃竞选`
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

        StatusLogger.trace(`[LeaderElectionService] 写入竞选信息: instanceId=${this.instanceId}, electedAt=${now}`);
        // 尝试写入
        await this.context.globalState.update(this.LEADER_KEY, info);

        // 等待一小段时间，让其他竞争者也完成写入
        StatusLogger.trace('[LeaderElectionService] 等待其他竞争者写入...');
        await new Promise(resolve => setTimeout(resolve, 100));

        // 再次读取确认是谁最终成为 Leader
        const currentInfo = this.context.globalState.get<LeaderInfo>(this.LEADER_KEY);

        if (!currentInfo) {
            StatusLogger.warn('[LeaderElectionService] 竞选失败：无法读取 Leader 信息');
            return;
        }

        StatusLogger.trace(
            `[LeaderElectionService] 竞选结果: 当前 Leader=${currentInfo.instanceId}, electedAt=${currentInfo.electedAt}`
        );
        // 比较策略：先比较 electedAt 时间戳，再比较 instanceId 字符串
        const isWinner =
            currentInfo.instanceId === this.instanceId ||
            (currentInfo.electedAt === info.electedAt && currentInfo.instanceId < this.instanceId);

        if (isWinner && currentInfo.instanceId === this.instanceId) {
            if (!this._isLeader) {
                this._isLeader = true;
                StatusLogger.info('[LeaderElectionService] 竞选成功，当前实例成为主实例');
            }
        } else {
            StatusLogger.debug(
                `[LeaderElectionService] 竞选失败，实例 ${currentInfo.instanceId} 成为主实例 (electedAt: ${currentInfo.electedAt})`
            );
            // 如果之前误以为自己是 Leader，现在退位
            if (this._isLeader) {
                this._isLeader = false;
                StatusLogger.info(`[LeaderElectionService] 竞选失败，实例 ${currentInfo.instanceId} 成为主实例`);
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
        StatusLogger.trace(`[LeaderElectionService] 更新心跳: lastHeartbeat=${newHeartbeat}`);
        await this.context.globalState.update(this.LEADER_KEY, info);
    }

    private static async resignLeader(): Promise<void> {
        if (this._isLeader && this.context) {
            const currentInfo = this.context.globalState.get<LeaderInfo>(this.LEADER_KEY);
            // 无条件清除 Leader 信息，确保释放时完全退出主实例
            if (currentInfo && currentInfo.instanceId === this.instanceId) {
                await this.context.globalState.update(this.LEADER_KEY, undefined);
                StatusLogger.info('[LeaderElectionService] 实例释放：主实例身份已清除');
            }
            this._isLeader = false;
            StatusLogger.debug('[LeaderElectionService] 实例释放：已退出主实例身份');
        }
    }

    private static async executePeriodicTasks(): Promise<void> {
        // 检查用户是否在30分钟内有活跃（使用 UserActivityService）
        if (!UserActivityService.isUserActive()) {
            const inactiveMinutes = Math.floor(UserActivityService.getInactiveTime() / 60000);
            StatusLogger.debug(`[LeaderElectionService] 用户已不活跃 ${inactiveMinutes} 分钟，暂停周期性任务执行`);
            return;
        }

        StatusLogger.trace(`[LeaderElectionService] 开始执行 ${this.periodicTasks.length} 个周期性任务...`);
        for (const task of this.periodicTasks) {
            try {
                await task();
            } catch (error) {
                StatusLogger.error('[LeaderElectionService] 执行周期性任务时出错:', error);
            }
        }
        StatusLogger.trace('[LeaderElectionService] 周期性任务执行完成');
    }
}
