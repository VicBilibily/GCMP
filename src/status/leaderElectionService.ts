import * as vscode from 'vscode';
import * as crypto from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { StatusLogger } from '../utils/runtime/statusLogger';
import { t } from '../utils/runtime/l10n';
import { UserActivityService } from './userActivityService';
import { InterInstanceBus, type LeaderResigningEvent } from '../interInstance';
import type { RateLimitStoreSnapshot } from '../rateLimit/rateLimitStore';
import type { ApiKeyBalanceLeaseHandoff } from '../interInstance/eventProtocol';
import { LeaderElectionDiagnostics, type ElectionUpdateObservation } from './election/leaderElectionDiagnostics';

interface LeaderInfo {
    instanceId: string;
    lastHeartbeat: number;
    electedAt: number; // 竞选成功的时间戳，用于解决竞态条件
}

interface LeaderResignationAuthority {
    authorityTerm: string | undefined;
    storageTerm: string | undefined;
    ipcAuthority: ReturnType<typeof InterInstanceBus.getConfirmedLeaderAuthority>;
}

interface LeaderCandidateAuthority {
    instanceId: string;
    electedAt: number;
    generation: number;
    decision: number;
    writePending: boolean;
    ipcAuthority: ReturnType<typeof InterInstanceBus.getConfirmedLeaderAuthority>;
    retryAuthority?: LeaderResignationAuthority;
}

export interface LeaderIdentity {
    instanceId: string;
    electedAt: number;
    authorityTerm: string;
}

type ResignationResult = 'resigned' | 'not-leader' | 'no-follower';

/**
 * 主实例竞选服务（纯静态类）
 * 确保在多 VS Code 实例中只有一个主实例负责执行周期性任务
 */
export class LeaderElectionService {
    private static readonly LEADER_KEY = 'gcmp.leader.info.v2';
    private static readonly HEARTBEAT_INTERVAL = 5000; // 5秒心跳
    private static readonly LEADER_TIMEOUT = 15000; // 15秒超时
    private static readonly SNAPSHOT_HANDOFF_TIMEOUT_MS = 30_000;
    private static readonly TASK_INTERVAL = 60 * 1000; // 默认任务执行间隔（1分钟）

    // 静态成员变量
    private static instanceId: string;
    private static context: vscode.ExtensionContext | undefined;
    private static startTimer: NodeJS.Timeout | undefined;
    private static heartbeatTimer: NodeJS.Timeout | undefined;
    private static taskTimer: NodeJS.Timeout | undefined;
    private static _isLeader = false;
    /** 本实例当选时的 electedAt。心跳写入必须用它而非从共享记录回读，
     * 否则双 Leader 期间会继承对方的 electedAt，污染 authorityTerm 判定 */
    private static ownElectedAt = 0;
    private static lastCandidateElectedAt = 0;
    private static initialized = false;
    private static stopping = false;
    private static lifecycleGeneration = 0;
    private static decisionGeneration = 0;
    private static candidateAuthority: LeaderCandidateAuthority | undefined;
    private static ownedCandidateAuthority: LeaderCandidateAuthority | undefined;
    private static readonly diagnostics = new LeaderElectionDiagnostics();
    private static electionPausedUntil = 0;
    private static resignationPromise: Promise<ResignationResult> | undefined;
    /**
     * 当前是否运行在 Agents 窗体中。
     * Agents 窗体与普通编辑器窗口的 globalState 互相隔离，基于 globalState 的选举
     * 在其间不可见，会导致双方各自宣布自己是 Leader。因此 Agents 窗体不参与选举，
     * 仅作为 IPC 客户端连接普通窗口选出的 Leader（见 InterInstanceBus）。
     */
    private static agentsWindow = false;

    private static periodicTasks: Array<() => Promise<void>> = [];

    // Leader 状态变更事件
    private static leaderChangedEmitter = new vscode.EventEmitter<boolean>();
    static readonly onLeaderChanged = LeaderElectionService.leaderChangedEmitter.event;
    private static handoffStateEmitter = new vscode.EventEmitter<boolean>();
    static readonly onHandoffStateChanged = LeaderElectionService.handoffStateEmitter.event;
    private static leaderIdentityChangedEmitter = new vscode.EventEmitter<LeaderIdentity | undefined>();
    static readonly onLeaderIdentityChanged = LeaderElectionService.leaderIdentityChangedEmitter.event;
    private static lastLeaderIdentityKey: string | undefined;
    private static rateLimitSnapshotProvider:
        | ((strict?: boolean) => RateLimitStoreSnapshot | undefined | Promise<RateLimitStoreSnapshot | undefined>)
        | undefined;
    private static rateLimitSnapshotValidator: ((snapshot: RateLimitStoreSnapshot | undefined) => boolean) | undefined;
    private static balanceLeaseSnapshotProvider:
        | ((strict?: boolean) => ApiKeyBalanceLeaseHandoff | undefined | Promise<ApiKeyBalanceLeaseHandoff | undefined>)
        | undefined;
    private static balanceLeaseSnapshotValidator:
        | ((snapshot: ApiKeyBalanceLeaseHandoff | undefined) => boolean)
        | undefined;

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
        if (this.initialized || this.stopping) {
            return;
        }

        this.lifecycleGeneration++;
        this.diagnostics.reset();
        this.candidateAuthority = undefined;
        this.ownedCandidateAuthority = undefined;
        this.periodicTasks = [];
        this.electionPausedUntil = 0;

        this.registerPeriodicTask(async () => {
            StatusLogger.trace('[LeaderElectionService] Leader periodic task: recording alive log');
        });

        this.instanceId = crypto.randomUUID();
        this.ownElectedAt = 0;
        this.lastCandidateElectedAt = 0;
        this.context = context;
        // Agents 窗体检测（复刻 VS Code 内部判定，不依赖提案 API）：
        // Agents 窗口打开的是主进程约定的合成工作区文件
        // <appSettingsHome>/agent-sessions.code-workspace（见 windowsMainService.ensureAgentsWindow），
        // 普通窗口不会打开该文件。仅比对文件名，容忍不同 profile 下父目录差异。
        const workspaceFileName = vscode.workspace.workspaceFile?.fsPath.split(/[\\/]/).pop();
        this.agentsWindow = workspaceFileName === 'agent-sessions.code-workspace';
        StatusLogger.info(
            `[LeaderElectionService] Initializing leader election service, current instance ID: ${this.instanceId}`
        );

        // 初始化用户活跃检测服务
        UserActivityService.initialize(context, this.instanceId);

        if (this.agentsWindow) {
            // Agents 窗体不参与选举：不启动竞选定时器，_isLeader 恒为 false，
            // InterInstanceBus 会通过 Leader 发现文件以纯客户端身份连接主窗口的 IPC Server。
            StatusLogger.info('[LeaderElectionService] Running in Agents window, leader election disabled');
            this.initialized = true;
            return;
        }

        // 添加随机延迟 (0-1000ms)，避免多个实例同时启动时的竞态条件
        const startDelay = Math.random() * 1000;
        this.startTimer = setTimeout(() => {
            this.startTimer = undefined;
            if (!this.initialized) {
                return;
            }
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
        let nextHeartbeatAt = performance.now() + this.HEARTBEAT_INTERVAL;
        this.heartbeatTimer = setInterval(() => {
            const now = performance.now();
            this.diagnostics.recordHeartbeatDelay(Math.max(0, now - nextHeartbeatAt));
            nextHeartbeatAt = now + this.HEARTBEAT_INTERVAL;
            void this.checkLeader();
        }, this.HEARTBEAT_INTERVAL);

        // 启动周期性任务检查
        this.taskTimer = setInterval(() => {
            if (this._isLeader && Date.now() >= this.electionPausedUntil) {
                this.executePeriodicTasks();
            }
        }, this.TASK_INTERVAL);
    }

    public static registerCommands(context: vscode.ExtensionContext): void {
        context.subscriptions.push(
            vscode.commands.registerCommand('gcmp.instance.resignLeader', async () => {
                try {
                    const result = await this.resignLeadership();
                    if (result === 'not-leader') {
                        void vscode.window.showInformationMessage(
                            t('This window is not the leader instance.', '当前窗口不是主实例，无需卸任。')
                        );
                    } else if (result === 'no-follower') {
                        void vscode.window.showWarningMessage(
                            t(
                                'No connected follower instance is available. Leadership was not resigned.',
                                '没有已连接的从实例可接班，已保留当前主实例。'
                            )
                        );
                    } else {
                        void vscode.window.showInformationMessage(
                            t(
                                'Leadership resigned. This window can participate in future elections.',
                                '已卸任主实例并通知接班实例，当前窗口后续仍可正常参与竞选。'
                            )
                        );
                    }
                } catch (error) {
                    StatusLogger.error('[LeaderElectionService] Manual leader resignation failed', error);
                    void vscode.window.showErrorMessage(
                        t(
                            'Failed to resign leadership. Check the output log for details.',
                            '卸任主实例失败，请查看输出日志。'
                        )
                    );
                }
            })
        );
    }

    public static async resignLeadership(): Promise<ResignationResult> {
        if (this.resignationPromise) {
            return this.resignationPromise;
        }
        if (!this.getOwnedAuthorityTerm()) {
            return 'not-leader';
        }
        const nextLeaderId = InterInstanceBus.getEligibleFollowerIds()[0];
        if (!nextLeaderId) {
            return 'no-follower';
        }

        this.electionPausedUntil = Number.POSITIVE_INFINITY;
        this.decisionGeneration++;
        const generation = this.lifecycleGeneration;
        const resignation = this.handoffLeadership(nextLeaderId);
        this.resignationPromise = resignation;
        try {
            return await resignation;
        } finally {
            if (this.resignationPromise === resignation) {
                if (generation === this.lifecycleGeneration) {
                    this.electionPausedUntil = this._isLeader ? 0 : Date.now() + this.HEARTBEAT_INTERVAL;
                }
                this.resignationPromise = undefined;
            }
        }
    }

    /**
     * 停止竞选服务
     * 注意：必须 await 整个方法，确保 resignLeader 完成后再返回，
     * 避免 deactivate 提前结束后 Leader 信息残留。
     */
    public static async stop(): Promise<void> {
        this.stopping = true;
        this.lifecycleGeneration++;
        InterInstanceBus.cancelLeaderLiveness();
        if (this.startTimer) {
            clearTimeout(this.startTimer);
            this.startTimer = undefined;
        }
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

        try {
            if (this.resignationPromise) {
                await this.resignationPromise.catch(error =>
                    StatusLogger.warn('[LeaderElectionService] Pending manual handoff failed during stop', error)
                );
            }
            await this.handoffLeadership();
            const currentInfo = this.context?.globalState.get<LeaderInfo>(this.LEADER_KEY);
            if (currentInfo?.instanceId === this.instanceId) {
                await this.context?.globalState.update(this.LEADER_KEY, undefined);
            }
        } catch (error) {
            StatusLogger.warn('[LeaderElectionService] Failed to release leader identity during stop', error);
        } finally {
            this.setLeaderState(false);
            this.periodicTasks = [];
            this.initialized = false;
            this.stopping = false;
        }
    }

    private static async handoffLeadership(nominatedLeaderId?: string): Promise<ResignationResult> {
        if (!this._isLeader) {
            return 'not-leader';
        }
        const manual = nominatedLeaderId !== undefined;
        const sourceAuthorityTerm = this.getOwnedAuthorityTerm();
        const generation = this.lifecycleGeneration;
        const electedAt = this.ownElectedAt;
        let deliveryUnconfirmed = false;
        this.handoffStateEmitter.fire(true);
        try {
            try {
                const deadline = Date.now() + this.SNAPSHOT_HANDOFF_TIMEOUT_MS;
                for (;;) {
                    let snapshotFailed = false;
                    let balanceLeaseSnapshot: ApiKeyBalanceLeaseHandoff | undefined;
                    try {
                        balanceLeaseSnapshot = await this.balanceLeaseSnapshotProvider?.(manual);
                    } catch (error) {
                        if (manual) {
                            throw error;
                        }
                        snapshotFailed = true;
                        StatusLogger.warn(
                            '[LeaderElectionService] Failed to export balance lease snapshot before resigning',
                            error
                        );
                    }
                    let rateLimitSnapshot: RateLimitStoreSnapshot | undefined;
                    try {
                        rateLimitSnapshot = await this.rateLimitSnapshotProvider?.(manual);
                    } catch (error) {
                        if (manual) {
                            throw error;
                        }
                        snapshotFailed = true;
                        StatusLogger.warn(
                            '[LeaderElectionService] Failed to export rate-limit snapshot before resigning',
                            error
                        );
                    }
                    const eligibleFollowers = InterInstanceBus.getEligibleFollowerIds();
                    const nextLeaderId =
                        nominatedLeaderId && eligibleFollowers.includes(nominatedLeaderId) ?
                            nominatedLeaderId
                        :   eligibleFollowers[0];
                    if (manual) {
                        if (!sourceAuthorityTerm || this.getOwnedAuthorityTerm() !== sourceAuthorityTerm) {
                            return 'not-leader';
                        }
                        if (!nextLeaderId) {
                            return 'no-follower';
                        }
                    }
                    // 最终核验与发布之间必须保持同步，避免微任务再次修改租约。
                    if (
                        !snapshotFailed &&
                        (this.balanceLeaseSnapshotValidator?.(balanceLeaseSnapshot) === false ||
                            this.rateLimitSnapshotValidator?.(rateLimitSnapshot) === false)
                    ) {
                        if (Date.now() >= deadline) {
                            throw new Error('Leadership handoff state did not stabilize before the deadline');
                        }
                        continue;
                    }
                    const sent = InterInstanceBus.publishIpcOnly(
                        {
                            type: 'leaderResigning',
                            payload: {
                                leaderId: this.instanceId,
                                reason: manual ? 'manual' : 'shutdown',
                                sourceAuthorityTerm,
                                nextLeaderId,
                                rateLimitSnapshot,
                                balanceLeaseSnapshot
                            }
                        },
                        manual ? nextLeaderId : undefined
                    );
                    if (manual && sent === false) {
                        throw new Error('Failed to publish leadership handoff to the nominated instance');
                    }
                    if (manual && typeof sent !== 'boolean') {
                        deliveryUnconfirmed = !(await sent);
                        if (generation !== this.lifecycleGeneration || electedAt !== this.ownElectedAt) {
                            return 'not-leader';
                        }
                    }
                    if (deliveryUnconfirmed) {
                        StatusLogger.warn(
                            '[LeaderElectionService] Handoff write not confirmed, relinquishing authority'
                        );
                        break;
                    }
                    StatusLogger.info(
                        `[LeaderElectionService] Broadcast leaderResigning before handoff${
                            nextLeaderId ? `, nominated next leader: ${nextLeaderId}` : ''
                        }`
                    );
                    break;
                }
            } catch (error) {
                if (manual) {
                    throw error;
                }
                StatusLogger.warn('[LeaderElectionService] Failed to broadcast leaderResigning', error);
            }
            const releasing = this.resignLeader();
            this.setLeaderState(false);
            await releasing;
            if (deliveryUnconfirmed) {
                // 对端可能已经收到通知，不能回滚为继续持有旧任期。
                throw new Error('Leadership handoff was not confirmed; leadership was relinquished');
            }
            return 'resigned';
        } finally {
            if (generation === this.lifecycleGeneration) {
                if (
                    electedAt === this.ownElectedAt &&
                    sourceAuthorityTerm &&
                    sourceAuthorityTerm !== this.getOwnedAuthorityTerm()
                ) {
                    this.setLeaderState(false);
                }
                this.handoffStateEmitter.fire(false);
            }
        }
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
        if (value && (!this.isElectionCurrent(this.lifecycleGeneration) || Date.now() < this.electionPausedUntil)) {
            return;
        }
        if (value) {
            const current = this.getLeaderIdentity();
            if (
                this.ownElectedAt <= 0 ||
                current?.instanceId !== this.instanceId ||
                current.electedAt !== this.ownElectedAt
            ) {
                return;
            }
        } else {
            // 同一生命周期内的落选也必须作废旧续体，包括尚未升主的候选。
            this.decisionGeneration++;
        }
        if (this._isLeader === value) {
            return;
        }
        if (value) {
            this.decisionGeneration++;
        }
        this._isLeader = value;
        StatusLogger.info(`[LeaderElectionService] Leader state changed: isLeader=${value}`);
        this.leaderChangedEmitter.fire(value);
        this.emitLeaderIdentityChanged();
    }

    private static emitLeaderIdentityChanged(): void {
        const identity = this.getLeaderIdentity();
        const key = identity ? `${identity.instanceId}:${identity.electedAt}` : undefined;
        if (key === this.lastLeaderIdentityKey) {
            return;
        }
        this.lastLeaderIdentityKey = key;
        this.decisionGeneration++;
        this.leaderIdentityChangedEmitter.fire(identity);
    }

    /**
     * 获取当前实例是否为主实例
     */
    public static isLeader(): boolean {
        return this._isLeader;
    }

    public static isInitialized(): boolean {
        return this.initialized;
    }

    /**
     * 当前是否运行在 Agents 窗体中（该环境下选举被禁用）
     */
    public static isAgentsWindow(): boolean {
        return this.agentsWindow;
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
        return this.getLeaderIdentity()?.instanceId;
    }

    public static getLeaderIdentity(): LeaderIdentity | undefined {
        if (!this.context) {
            return undefined;
        }
        // Agents 窗体的 globalState 与普通窗口隔离，读到的是本窗体独立副本，不可作为选举依据
        if (this.agentsWindow) {
            return undefined;
        }
        const leaderInfo = this.context.globalState.get<LeaderInfo>(this.LEADER_KEY);
        return leaderInfo ? this.toLeaderIdentity(leaderInfo) : undefined;
    }

    public static getAuthorityTerm(): string | undefined {
        return this.getLeaderIdentity()?.authorityTerm;
    }

    public static getOwnedAuthorityTerm(): string | undefined {
        if (
            !this._isLeader ||
            !this.instanceId ||
            this.ownElectedAt <= 0 ||
            this.ownedCandidateAuthority?.decision === -1
        ) {
            return undefined;
        }
        const current = this.getLeaderIdentity();
        if (current?.instanceId !== this.instanceId || current.electedAt !== this.ownElectedAt) {
            return undefined;
        }
        return current.authorityTerm;
    }

    /**
     * 判断当前记录的 Leader 心跳是否仍在有效期内。
     * 用于委托超时后的回退决策：委托超时≠Leader 失联（可能只是执行耗时），
     * 仅当 Leader 确实失联（无记录或心跳超时）时才允许本地兜底写盘，避免与存活 Leader 并发写。
     */
    public static isLeaderHeartbeatFresh(): boolean {
        if (!this.context) {
            return false;
        }
        const leaderInfo = this.context.globalState.get<LeaderInfo>(this.LEADER_KEY);
        if (!leaderInfo) {
            return false;
        }
        return Date.now() - leaderInfo.lastHeartbeat <= this.LEADER_TIMEOUT;
    }

    /**
     * 监听 Leader 卸任通知。
     * 在 LeaderElectionService.initialize 完成后调用，避免 InterInstanceBus 尚未初始化。
     */
    public static subscribeToLeaderResigning(): void {
        if (!this.context) {
            return;
        }
        // Agents 窗体不参与选举，收到卸任通知后也不应触发本地竞选/接管
        if (this.agentsWindow) {
            return;
        }
        this.context.subscriptions.push(
            InterInstanceBus.subscribe('leaderResigning', event => {
                const {
                    leaderId: resigningLeaderId,
                    nextLeaderId,
                    sourceAuthorityTerm
                } = (event as LeaderResigningEvent).payload;
                const now = Date.now();
                const authority = this.captureLeaderResignationAuthority();
                if (
                    resigningLeaderId === this.instanceId ||
                    resigningLeaderId !== event.senderInstanceId ||
                    resigningLeaderId !== this.getLeaderId() ||
                    (sourceAuthorityTerm !== undefined && sourceAuthorityTerm !== authority.authorityTerm) ||
                    !Number.isFinite(event.timestamp) ||
                    now - event.timestamp > 10_000 ||
                    event.timestamp - now > 1_000
                ) {
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
                    void this.takeoverAsNominated(authority).catch(error =>
                        StatusLogger.warn('[LeaderElectionService] Nominated takeover failed', error)
                    );
                    return;
                }

                // 已指定下一任 Leader 时，非提名实例等待几次确认新 Leader 是否已接管，
                // 若接管成功则无需竞争；若超时未接管再进入竞选。
                if (nextLeaderId) {
                    void this.waitForNominatedTakeover(nextLeaderId, resigningLeaderId, authority).catch(error =>
                        StatusLogger.warn('[LeaderElectionService] Waiting for nominated takeover failed', error)
                    );
                    return;
                }

                // 未指定下一任 Leader 时，直接基于卸任信号快速接管，不再受旧心跳 freshness 阻塞
                void this.recoverAfterLeaderResigning(resigningLeaderId, authority).catch(error =>
                    StatusLogger.warn('[LeaderElectionService] Fast takeover after resigning failed', error)
                );
            })
        );
    }

    public static setRateLimitSnapshotProvider(
        provider:
            | ((strict?: boolean) => RateLimitStoreSnapshot | undefined | Promise<RateLimitStoreSnapshot | undefined>)
            | undefined,
        validator?: (snapshot: RateLimitStoreSnapshot | undefined) => boolean
    ): void {
        this.rateLimitSnapshotProvider = provider;
        this.rateLimitSnapshotValidator = validator;
    }

    public static setBalanceLeaseSnapshotProvider(
        provider:
            | ((
                  strict?: boolean
              ) => ApiKeyBalanceLeaseHandoff | undefined | Promise<ApiKeyBalanceLeaseHandoff | undefined>)
            | undefined,
        validator?: (snapshot: ApiKeyBalanceLeaseHandoff | undefined) => boolean
    ): void {
        this.balanceLeaseSnapshotProvider = provider;
        this.balanceLeaseSnapshotValidator = validator;
    }

    private static isElectionCurrent(generation: number): boolean {
        return this.initialized && !this.stopping && !this.agentsWindow && generation === this.lifecycleGeneration;
    }

    private static isDecisionCurrent(generation: number, decision: number): boolean {
        return (
            this.isElectionCurrent(generation) &&
            decision === this.decisionGeneration &&
            Date.now() >= this.electionPausedUntil
        );
    }

    private static captureLeaderResignationAuthority(): LeaderResignationAuthority {
        const storage = this.getLeaderIdentity();
        const ipcAuthority = InterInstanceBus.getConfirmedLeaderAuthority();
        const confirmedTerm = ipcAuthority.authorityTerm;
        const storageTerm =
            (
                !confirmedTerm ||
                (storage &&
                    confirmedTerm.startsWith(`${storage.instanceId}:`) &&
                    storage.electedAt <= Number(confirmedTerm.slice(storage.instanceId.length + 1)))
            ) ?
                storage?.authorityTerm
            :   undefined;
        return { authorityTerm: confirmedTerm ?? storageTerm, storageTerm, ipcAuthority };
    }

    private static isLeaderResignationAuthorityCurrent(
        authority: LeaderResignationAuthority,
        observedTerm: string | undefined
    ): boolean {
        return (
            InterInstanceBus.isLeaderResignationAuthorityCurrent(authority.ipcAuthority) &&
            (observedTerm === undefined ||
                observedTerm === authority.authorityTerm ||
                observedTerm === authority.storageTerm)
        );
    }

    private static isCandidateAuthorityCurrent(expected: Pick<LeaderInfo, 'instanceId' | 'electedAt'>): boolean {
        if (
            this.ownedCandidateAuthority?.decision === -1 &&
            expected.instanceId === this.ownedCandidateAuthority.instanceId &&
            expected.electedAt === this.ownedCandidateAuthority.electedAt
        ) {
            return false;
        }
        const candidate = this.candidateAuthority;
        if (!candidate || candidate.instanceId !== expected.instanceId || expected.electedAt > candidate.electedAt) {
            return true;
        }
        if (
            expected.electedAt !== candidate.electedAt ||
            !this.isElectionCurrent(candidate.generation) ||
            candidate.decision < 0
        ) {
            return false;
        }
        if (this._isLeader && this.ownElectedAt === expected.electedAt) {
            return true;
        }
        if (!this.isDecisionCurrent(candidate.generation, candidate.decision)) {
            return false;
        }
        if (candidate.retryAuthority) {
            return this.isLeaderResignationAuthorityCurrent(candidate.retryAuthority, undefined);
        }
        const current = InterInstanceBus.getConfirmedLeaderAuthority();
        return (
            current.generation === candidate.ipcAuthority.generation &&
            current.authorityTerm === candidate.ipcAuthority.authorityTerm
        );
    }

    private static revokeFailedCandidateLeadership(generation: number): void {
        if (
            this._isLeader &&
            this.isElectionCurrent(generation) &&
            this.ownedCandidateAuthority?.decision === -1 &&
            (!this.candidateAuthority || !this.isCandidateAuthorityCurrent(this.candidateAuthority))
        ) {
            this.setLeaderState(false);
        }
    }

    private static confirmLeadership(
        expected: Pick<LeaderInfo, 'instanceId' | 'electedAt'>,
        generation: number,
        decision: number
    ): boolean {
        if (
            !this.isDecisionCurrent(generation, decision) ||
            !this.isCandidateAuthorityCurrent(expected) ||
            expected.electedAt < this.ownElectedAt
        ) {
            return false;
        }
        const current = this.context?.globalState.get<LeaderInfo>(this.LEADER_KEY);
        if (
            current?.instanceId !== this.instanceId ||
            current.instanceId !== expected.instanceId ||
            current.electedAt !== expected.electedAt
        ) {
            return false;
        }
        const candidate = this.candidateAuthority;
        const termChanged = this.ownElectedAt !== current.electedAt;
        const wasLeader = this._isLeader;
        if (termChanged) {
            this.decisionGeneration++;
            this.ownElectedAt = current.electedAt;
            this.ownedCandidateAuthority = candidate?.electedAt === current.electedAt ? candidate : undefined;
        }
        this.setLeaderState(true);
        if (termChanged && wasLeader) {
            this.emitLeaderIdentityChanged();
        }
        const confirmed = this.getOwnedAuthorityTerm() === `${current.instanceId}:${current.electedAt}`;
        if (confirmed && !candidate?.writePending && this.candidateAuthority === candidate) {
            this.candidateAuthority = undefined;
        }
        return confirmed;
    }

    private static async checkLeader(): Promise<void> {
        const generation = this.lifecycleGeneration;
        if (!this.context || !this.isElectionCurrent(generation)) {
            return;
        }

        this.revokeFailedCandidateLeadership(generation);
        const now = Date.now();
        const leaderInfo = this.context.globalState.get<LeaderInfo>(this.LEADER_KEY);
        if (
            leaderInfo?.instanceId !== this.instanceId ||
            (this._isLeader && this.ownElectedAt === leaderInfo.electedAt)
        ) {
            this.emitLeaderIdentityChanged();
        }
        if (!this.isElectionCurrent(generation) || now < this.electionPausedUntil) {
            return;
        }
        const decision = this.decisionGeneration;
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
            const wasLeader = this._isLeader;
            const electedAt = wasLeader ? Math.max(this.ownElectedAt, leaderInfo.electedAt) : leaderInfo.electedAt;
            await this.updateHeartbeat(electedAt);
            if (this.confirmLeadership({ instanceId: this.instanceId, electedAt }, generation, decision)) {
                if (!wasLeader) {
                    StatusLogger.info('[LeaderElectionService] Current instance has become the leader');
                }
            } else if (this.isDecisionCurrent(generation, decision)) {
                const current = this.context.globalState.get<LeaderInfo>(this.LEADER_KEY);
                if (
                    current?.instanceId === this.instanceId &&
                    current.electedAt === leaderInfo.electedAt &&
                    Date.now() - current.lastHeartbeat > this.LEADER_TIMEOUT
                ) {
                    await this.becomeLeader();
                }
            }
        } else {
            // 别人是 Leader
            StatusLogger.trace(`[LeaderElectionService] Detected another leader: ${leaderInfo.instanceId}`);
            // 如果我之前是 Leader，但现在 globalState 中的 Leader 不是我，说明被其他实例覆盖了
            if (this._isLeader) {
                // 双 Leader 收敛：globalState 写入-读取交错可让双方同时宣布当选。
                // 按 electedAt LWW（新当选者保留，毫秒同值时按 instanceId 字典序）确定性裁决，
                // 双方对同一对值判定结果一致，避免"覆盖-退位"随机乒乓导致限流权威反复空桶重建
                const incumbentNewer =
                    leaderInfo.electedAt > this.ownElectedAt ||
                    (leaderInfo.electedAt === this.ownElectedAt && leaderInfo.instanceId > this.instanceId);
                if (incumbentNewer) {
                    this.setLeaderState(false);
                    StatusLogger.warn(
                        `[LeaderElectionService] Leader role was overridden by instance ${leaderInfo.instanceId} (elected later), stepping down`
                    );
                } else {
                    StatusLogger.warn(
                        `[LeaderElectionService] Instance ${leaderInfo.instanceId} was elected earlier, reclaiming leadership`
                    );
                    const electedAt = this.ownElectedAt;
                    await this.updateHeartbeat(electedAt);
                    if (this.confirmLeadership({ instanceId: this.instanceId, electedAt }, generation, decision)) {
                        InterInstanceBus.syncLeaderAuthority();
                    }
                    return;
                }
            }

            // 检查该 Leader 是否超时
            const heartbeatAge = now - leaderInfo.lastHeartbeat;
            StatusLogger.trace(
                `[LeaderElectionService] Leader heartbeat age: ${heartbeatAge}ms (timeout threshold: ${this.LEADER_TIMEOUT}ms)`
            );
            if (heartbeatAge > this.LEADER_TIMEOUT) {
                StatusLogger.trace(
                    `[LeaderElectionService] Leader ${leaderInfo.instanceId} heartbeat is stale, checking takeover eligibility...`
                );
                await this.becomeLeader();
            }
        }
    }

    /**
     * 被提名实例尝试接管 Leader 身份，最多重试 NOMINATED_TAKEOVER_ATTEMPTS 次。
     * 每次失败后等待 NOMINATED_TAKEOVER_DELAY_MS 再重试，全部失败后退回到常规竞选。
     */
    private static async takeoverAsNominated(
        authority: LeaderResignationAuthority = this.captureLeaderResignationAuthority()
    ): Promise<void> {
        const generation = this.lifecycleGeneration;
        let decision = this.decisionGeneration;
        const NOMINATED_TAKEOVER_ATTEMPTS = 3;
        const NOMINATED_TAKEOVER_DELAY_MS = 200;

        for (let attempt = 1; attempt <= NOMINATED_TAKEOVER_ATTEMPTS; attempt++) {
            const currentTerm = this.getAuthorityTerm();
            if (
                !this.isDecisionCurrent(generation, decision) ||
                this._isLeader ||
                !this.isLeaderResignationAuthorityCurrent(authority, currentTerm)
            ) {
                return;
            }

            StatusLogger.info(
                `[LeaderElectionService] Attempting nominated takeover, attempt ${attempt}/${NOMINATED_TAKEOVER_ATTEMPTS}`
            );
            const retryDecision = await this.becomeLeader(true, authority);
            if (retryDecision !== undefined) {
                decision = retryDecision;
            }

            const confirmedTerm = this.getAuthorityTerm();
            if (
                !this.isDecisionCurrent(generation, decision) ||
                this._isLeader ||
                !this.isLeaderResignationAuthorityCurrent(authority, confirmedTerm)
            ) {
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
        resigningLeaderId: string,
        authority: LeaderResignationAuthority = this.captureLeaderResignationAuthority()
    ): Promise<void> {
        const generation = this.lifecycleGeneration;
        const decision = this.decisionGeneration;
        const NOMINATED_TAKEOVER_ATTEMPTS = 3;
        const NOMINATED_TAKEOVER_DELAY_MS = 200;

        for (let attempt = 1; attempt <= NOMINATED_TAKEOVER_ATTEMPTS; attempt++) {
            if (!this.isDecisionCurrent(generation, decision)) {
                return;
            }
            const currentInfo = this.context?.globalState.get<LeaderInfo>(this.LEADER_KEY);

            if (currentInfo && currentInfo.instanceId !== resigningLeaderId) {
                StatusLogger.info(
                    `[LeaderElectionService] Nominated takeover observed: new leader ${currentInfo.instanceId} at attempt ${attempt}`
                );
                return;
            }

            if (
                !this.isLeaderResignationAuthorityCurrent(
                    authority,
                    currentInfo && this.toLeaderIdentity(currentInfo).authorityTerm
                )
            ) {
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
        await this.recoverAfterLeaderResigning(resigningLeaderId, authority);
    }

    private static async recoverAfterLeaderResigning(
        resigningLeaderId: string,
        authority: LeaderResignationAuthority = this.captureLeaderResignationAuthority()
    ): Promise<void> {
        const generation = this.lifecycleGeneration;
        let decision = this.decisionGeneration;
        if (!this.isDecisionCurrent(generation, decision)) {
            return;
        }

        if (!this.isLeaderResignationAuthorityCurrent(authority, this.getAuthorityTerm())) {
            return;
        }
        const currentInfo = this.context?.globalState.get<LeaderInfo>(this.LEADER_KEY);
        if (currentInfo && currentInfo.instanceId !== resigningLeaderId) {
            StatusLogger.info(
                `[LeaderElectionService] Leader ${currentInfo.instanceId} already took over after ${resigningLeaderId} resigned`
            );
            return;
        }

        StatusLogger.info(
            `[LeaderElectionService] Attempting fast takeover after leaderResigning from ${resigningLeaderId}`
        );
        const retryDecision = await this.becomeLeader(true, authority);
        if (retryDecision !== undefined) {
            decision = retryDecision;
        }
        if (
            this.isDecisionCurrent(generation, decision) &&
            !this._isLeader &&
            this.isLeaderResignationAuthorityCurrent(authority, this.getAuthorityTerm())
        ) {
            await this.checkLeader();
        }
    }

    private static async becomeLeader(
        force: boolean = false,
        retryAuthority?: LeaderResignationAuthority
    ): Promise<number | undefined> {
        const generation = this.lifecycleGeneration;
        if (!this.context || !this.isElectionCurrent(generation) || Date.now() < this.electionPausedUntil) {
            return;
        }
        const decision = this.decisionGeneration;

        if (retryAuthority && !this.isLeaderResignationAuthorityCurrent(retryAuthority, this.getAuthorityTerm())) {
            return;
        }
        const ipcAuthority = retryAuthority?.ipcAuthority ?? InterInstanceBus.getConfirmedLeaderAuthority();
        const isAuthorityCurrent = () => {
            if (retryAuthority) {
                return this.isLeaderResignationAuthorityCurrent(retryAuthority, undefined);
            }
            const current = InterInstanceBus.getConfirmedLeaderAuthority();
            return (
                current.generation === ipcAuthority.generation && current.authorityTerm === ipcAuthority.authorityTerm
            );
        };

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
            const identity = this.toLeaderIdentity(existingLeader);
            const liveness = await InterInstanceBus.confirmLeaderLiveness(identity);
            if (!this.isDecisionCurrent(generation, decision) || liveness === 'invalidated') {
                return;
            }
            const current = this.context.globalState.get<LeaderInfo>(this.LEADER_KEY);
            if (
                !current ||
                current.instanceId !== identity.instanceId ||
                current.electedAt !== identity.electedAt ||
                Date.now() - current.lastHeartbeat <= this.LEADER_TIMEOUT
            ) {
                return;
            }
            if (liveness === 'alive') {
                StatusLogger.trace(
                    `[LeaderElectionService] Leader ${identity.authorityTerm} responded to liveness probe, skipping takeover`
                );
                return;
            }
        }

        if (!this.isDecisionCurrent(generation, decision) || !isAuthorityCurrent()) {
            return;
        }
        const now = Date.now();
        const info: LeaderInfo = {
            instanceId: this.instanceId,
            lastHeartbeat: now,
            electedAt: Math.max(now, this.ownElectedAt + 1, this.lastCandidateElectedAt + 1)
        };
        this.lastCandidateElectedAt = info.electedAt;

        StatusLogger.trace(
            `[LeaderElectionService] Writing election info: instanceId=${this.instanceId}, electedAt=${info.electedAt}`
        );
        // 尝试写入
        const candidate: LeaderCandidateAuthority = {
            instanceId: info.instanceId,
            electedAt: info.electedAt,
            generation,
            decision,
            writePending: true,
            ipcAuthority,
            retryAuthority
        };
        // 写入回执前记录已可见，提前心跳也必须校验同一候选资格。
        this.candidateAuthority = candidate;
        try {
            await this.writeLeaderInfo(info, 'election');
        } catch (error) {
            candidate.writePending = false;
            candidate.decision = -1;
            this.revokeFailedCandidateLeadership(generation);
            throw error;
        }
        candidate.writePending = false;
        if (
            this.candidateAuthority === candidate &&
            this.isElectionCurrent(generation) &&
            this._isLeader &&
            this.ownElectedAt === candidate.electedAt
        ) {
            this.candidateAuthority = undefined;
        }
        if (!this.isDecisionCurrent(generation, decision) || !isAuthorityCurrent()) {
            this.revokeFailedCandidateLeadership(generation);
            return;
        }

        // 等待一小段时间，让其他竞争者也完成写入
        StatusLogger.trace('[LeaderElectionService] Waiting for other contenders to write...');
        await new Promise(resolve => setTimeout(resolve, 100));
        if (!this.isDecisionCurrent(generation, decision) || !isAuthorityCurrent()) {
            this.revokeFailedCandidateLeadership(generation);
            return;
        }

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
            const wasLeader = this._isLeader;
            if (this.confirmLeadership(currentInfo, generation, decision) && !wasLeader) {
                StatusLogger.info('[LeaderElectionService] Election succeeded, current instance is the leader');
            }
        } else {
            StatusLogger.debug(
                `[LeaderElectionService] Election lost, instance ${currentInfo.instanceId} became the leader (electedAt: ${currentInfo.electedAt})`
            );
            // 如果之前误以为自己是 Leader，现在退位
            const wasLeader = this._isLeader;
            this.setLeaderState(false);
            if (wasLeader) {
                StatusLogger.info(
                    `[LeaderElectionService] Election lost, instance ${currentInfo.instanceId} became the leader`
                );
            } else if (
                retryAuthority &&
                this.isLeaderResignationAuthorityCurrent(
                    retryAuthority,
                    this.toLeaderIdentity(currentInfo).authorityTerm
                )
            ) {
                // 只为确认时仍是原卸任任期的落选交还重试代次。
                return decision + 1;
            }
        }
    }

    private static async updateHeartbeat(expectedElectedAt: number = this.ownElectedAt): Promise<void> {
        if (
            !this._isLeader ||
            !this.context ||
            this.ownElectedAt <= 0 ||
            this.ownedCandidateAuthority?.decision === -1 ||
            expectedElectedAt !== this.ownElectedAt ||
            !this.isElectionCurrent(this.lifecycleGeneration) ||
            Date.now() < this.electionPausedUntil
        ) {
            return;
        }

        const newHeartbeat = Date.now();

        const info: LeaderInfo = {
            instanceId: this.instanceId,
            lastHeartbeat: newHeartbeat,
            electedAt: this.ownElectedAt
        };
        StatusLogger.trace(`[LeaderElectionService] Updating heartbeat: lastHeartbeat=${newHeartbeat}`);
        await this.writeLeaderInfo(info, 'heartbeat');
    }

    private static async writeLeaderInfo(
        info: LeaderInfo,
        operation: ElectionUpdateObservation['operation']
    ): Promise<void> {
        const context = this.context!;
        const observedTerm = () => {
            const current = context.globalState.get<LeaderInfo>(this.LEADER_KEY);
            return current ? `${current.instanceId}:${current.electedAt}` : undefined;
        };
        const before: ElectionUpdateObservation = {
            operation,
            requestedTerm: `${info.instanceId}:${info.electedAt}`,
            observedTerm: observedTerm(),
            leader: this._isLeader,
            lifecycle: this.lifecycleGeneration
        };
        const startedAt = this.diagnostics.beginUpdate(before);
        let failed = true;
        try {
            await context.globalState.update(this.LEADER_KEY, info);
            failed = false;
        } finally {
            this.diagnostics.finishUpdate(
                startedAt,
                before,
                {
                    observedTerm: observedTerm(),
                    leader: this._isLeader,
                    lifecycle: this.lifecycleGeneration
                },
                failed
            );
        }
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
            if (!this._isLeader || Date.now() < this.electionPausedUntil) {
                return;
            }
            try {
                await task();
            } catch (error) {
                StatusLogger.error('[LeaderElectionService] Error executing periodic task:', error);
            }
        }
        StatusLogger.trace('[LeaderElectionService] Periodic task completed');
    }

    private static toLeaderIdentity(info: LeaderInfo): LeaderIdentity {
        return {
            instanceId: info.instanceId,
            electedAt: info.electedAt,
            authorityTerm: `${info.instanceId}:${info.electedAt}`
        };
    }
}
