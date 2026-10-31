/*---------------------------------------------------------------------------------------------
 *  CLI 认证工厂
 *  管理不同 CLI 提供商的认证实例
 *--------------------------------------------------------------------------------------------*/

import * as path from 'path';
import * as vscode from 'vscode';
import { BaseCliAuth } from './baseCliAuth';
import { CodexCliAuth } from './codexCliAuth';
import { GrokCliAuth } from './grokCliAuth';
import { Logger } from '../../utils/runtime/logger';
import { CliCredentialSourceInfo, OAuthCredentials } from '../type';
import { OAuthCredentialEntry, OAuthCredentialSelection, OAuthCredentialStore } from './oauthCredentialStore';
import { CliAuthRefreshCompletedEvent, CliAuthRefreshRequestedEvent, InterInstanceBus } from '../../interInstance';
import { LeaderElectionService } from '../../status';

/**
 * CLI 认证工厂
 * 单例模式，管理所有 CLI 提供商的认证实例
 */
export class CliAuthFactory {
    private static instances = new Map<string, BaseCliAuth>();
    private static initialized = false;
    private static readonly LEADER_REFRESH_TIMEOUT_ERROR = 'timed out waiting for leader refresh';
    private static readonly pendingRefreshRequests = new Map<
        string,
        {
            leaderId: string;
            resolve: (result: { success: boolean; error?: string }) => void;
            timer: ReturnType<typeof setTimeout>;
        }
    >();
    private static readonly CLI_AUTH_REFRESH_TIMEOUT_MS = 15_000;
    /** 委托刷新超时后的宽限轮询：Leader 可能刚好在超时窗口后完成刷新并落盘 */
    private static readonly LEADER_REFRESH_GRACE_PERIOD_MS = 10_000;
    private static readonly LEADER_REFRESH_GRACE_POLL_INTERVAL_MS = 1_000;

    /**
     * 初始化跨实例 CLI 刷新协调与 oauth 命名凭证存储
     */
    static initialize(context: vscode.ExtensionContext): void {
        if (this.initialized) {
            return;
        }

        OAuthCredentialStore.initialize({ oauthDir: path.join(context.globalStorageUri.fsPath, 'oauth') });

        context.subscriptions.push(
            InterInstanceBus.subscribe('cliAuthRefreshRequested', event => {
                if (!LeaderElectionService.isLeader()) {
                    return;
                }
                void this.handleRefreshRequested(event as CliAuthRefreshRequestedEvent);
            }),
            InterInstanceBus.subscribe('cliAuthRefreshCompleted', event => {
                const payload = (event as CliAuthRefreshCompletedEvent).payload;
                const pending = this.pendingRefreshRequests.get(payload.requestId);
                if (!pending || event.senderInstanceId !== pending.leaderId) {
                    return;
                }

                clearTimeout(pending.timer);
                this.pendingRefreshRequests.delete(payload.requestId);
                pending.resolve({ success: payload.success, error: payload.error });
            })
        );

        this.initialized = true;
    }

    /**
     * 获取指定 CLI 类型的认证实例
     */
    static getInstance(cliType: string): BaseCliAuth | null {
        // 如果已存在实例，直接返回
        if (this.instances.has(cliType)) {
            return this.instances.get(cliType)!;
        }
        // 创建新实例
        let instance: BaseCliAuth | null = null;
        switch (cliType) {
            case 'codex':
                instance = new CodexCliAuth();
                break;
            case 'grok':
                instance = new GrokCliAuth();
                break;
            default:
                Logger.warn(`[CliAuthFactory] Unknown CLI type: ${cliType}`);
                return null;
        }
        if (instance) {
            this.instances.set(cliType, instance);
        }
        return instance;
    }

    /**
     * 加载 CLI OAuth 凭证
     */
    static async loadCredentials(cliType: string): Promise<OAuthCredentials | null> {
        const instance = this.getInstance(cliType);
        if (!instance) {
            return null;
        }
        return await instance.loadCredentials();
    }

    /**
     * 确保认证有效（自动刷新过期令牌）
     */
    static async ensureAuthenticated(cliType: string, forceRefresh = false): Promise<OAuthCredentials | null> {
        const instance = this.getInstance(cliType);
        if (!instance) {
            return null;
        }

        const credentials = await instance.loadCredentials();
        if (!credentials) {
            return null;
        }

        const needsRefresh = forceRefresh || (instance.isExpired(credentials) && !!credentials.refresh_token);
        if (!needsRefresh) {
            return credentials;
        }

        if (!credentials.refresh_token) {
            return forceRefresh ? null : credentials;
        }

        const leaderId = LeaderElectionService.getLeaderId();
        if (leaderId && leaderId !== LeaderElectionService.getInstanceId()) {
            return await this.delegateRefreshToLeader(cliType, instance, leaderId);
        }

        return await instance.ensureAuthenticated(true);
    }

    /** 验证 CLI 原生凭证；可强制刷新以确认服务端仍接受凭证，不读取或切换 OAuth 活跃凭证 */
    static async ensureCliNativeAuthenticated(cliType: string, forceRefresh = false): Promise<OAuthCredentials | null> {
        const instance = this.getInstance(cliType);
        if (!instance) {
            return null;
        }

        const credentialPath = instance.getCliNativeCredentialPath();
        const credentials = await instance.loadCredentialsFromPath(credentialPath);
        if (!credentials?.access_token) {
            return null;
        }
        if (!forceRefresh && !instance.isExpired(credentials)) {
            return credentials;
        }
        if (!credentials.refresh_token) {
            return null;
        }

        const leaderId = LeaderElectionService.getLeaderId();
        if (leaderId && leaderId !== LeaderElectionService.getInstanceId()) {
            return await this.delegateRefreshToLeader(
                cliType,
                instance,
                leaderId,
                undefined,
                forceRefresh,
                'cliNative'
            );
        }

        return await instance.ensureAuthenticatedFromPath(credentialPath, forceRefresh);
    }

    /** 确保指定命名 OAuth 凭证有效；刷新时不改变当前活跃账号 */
    static async ensureAuthenticatedForOAuthCredential(
        cliType: string,
        credentialName: string,
        forceRefresh = false
    ): Promise<OAuthCredentials | null> {
        const instance = this.getInstance(cliType);
        const credentialPath = OAuthCredentialStore.getCredentialPath(cliType, credentialName);
        if (!instance || !credentialPath) {
            return null;
        }

        const credentials = await instance.loadCredentialsFromPath(credentialPath);
        if (!credentials) {
            return null;
        }
        const needsRefresh = forceRefresh || (instance.isExpired(credentials) && !!credentials.refresh_token);
        if (!needsRefresh) {
            return credentials;
        }
        if (!credentials.refresh_token) {
            return null;
        }

        const leaderId = LeaderElectionService.getLeaderId();
        if (leaderId && leaderId !== LeaderElectionService.getInstanceId()) {
            return await this.delegateRefreshToLeader(cliType, instance, leaderId, credentialName, forceRefresh);
        }

        return await instance.ensureAuthenticatedFromPath(credentialPath, forceRefresh);
    }

    /**
     * 判断凭证是否已过期（只读，不触发网络刷新）
     * 由各 CLI 子类的 getExpiryBufferMs() 决定具体缓冲时间
     */
    static isCredentialExpired(cliType: string, credentials: OAuthCredentials): boolean {
        const instance = this.getInstance(cliType);
        if (!instance) {
            return true;
        }
        return instance.isExpired(credentials);
    }

    /**
     * 检查 CLI 是否已安装
     */
    static async isCliInstalled(cliType: string): Promise<boolean> {
        const instance = this.getInstance(cliType);
        if (!instance) {
            return false;
        }
        return await instance.isCliInstalled();
    }

    /**
     * 获取凭证文件路径
     */
    static getCredentialPath(cliType: string): string | null {
        const instance = this.getInstance(cliType);
        return instance ? instance.getCredentialPath() : null;
    }

    /**
     * 列出指定 CLI provider 在 oauth 文件夹中的全部命名凭证
     */
    static listOAuthCredentials(cliType: string): OAuthCredentialEntry[] {
        return OAuthCredentialStore.listCredentials(cliType);
    }

    /**
     * 获取当前生效凭证的来源信息（oauth 命名凭证 / CLI 默认目录）
     */
    static getCredentialSourceInfo(cliType: string): CliCredentialSourceInfo {
        const name = OAuthCredentialStore.getActiveCredentialName(cliType);
        return name ? { source: 'oauth', name } : { source: 'cli' };
    }

    static getActiveCredentialSelection(cliType: string): OAuthCredentialSelection {
        return OAuthCredentialStore.getActiveCredentialSelection(cliType);
    }

    /**
     * 设置指定 CLI provider 的活跃 oauth 凭证，并使本进程凭证缓存失效
     */
    static async setActiveCredential(cliType: string, name: string): Promise<OAuthCredentialSelection> {
        const selection = await OAuthCredentialStore.setActiveCredential(cliType, name);
        this.getInstance(cliType)?.invalidateCredentialCache();
        return selection;
    }

    /**
     * 获取 oauth 命名凭证文件夹路径（未初始化时为 undefined）
     */
    static getOAuthCredentialDir(): string | undefined {
        return OAuthCredentialStore.getOAuthDir();
    }

    /**
     * 获取 CLI 进程环境变量（包含 provider 级代理）
     */
    static getProcessEnv(cliType: string): NodeJS.ProcessEnv {
        const instance = this.getInstance(cliType);
        return instance ? instance.getCliProcessEnv() : { ...process.env };
    }

    /** 获取 Codex 请求所需的 ChatGPT 账户 ID */
    static async getCodexAccountId(): Promise<string | null> {
        const instance = this.getInstance('codex');
        return instance instanceof CodexCliAuth ? instance.getAccountId() : null;
    }

    /**
     * 获取支持的 CLI 类型列表
     */
    static getSupportedCliTypes(): Array<{ id: string; name: string }> {
        return [
            { id: 'codex', name: 'Codex CLI' },
            { id: 'grok', name: 'Grok Build' }
        ];
    }

    private static async delegateRefreshToLeader(
        cliType: string,
        instance: BaseCliAuth,
        leaderId: string,
        credentialName?: string,
        forceRefresh = true,
        credentialSource?: 'cliNative'
    ): Promise<OAuthCredentials | null> {
        const requestId = `${Date.now().toString(36)}_${Math.random().toString(36).slice(2)}`;
        const waitForCompletion = this.waitForRefreshCompletion(requestId, leaderId);

        Logger.info(`[CliAuthFactory] Delegating ${cliType} CLI auth refresh to leader`);
        InterInstanceBus.publish({
            type: 'cliAuthRefreshRequested',
            payload: {
                requestId,
                providerKey: cliType,
                ...(credentialName ? { credentialName } : {}),
                ...(credentialSource ? { credentialSource } : {}),
                forceRefresh,
                requestedBy: LeaderElectionService.getInstanceId()
            }
        });

        const result = await waitForCompletion;
        if (!result.success) {
            Logger.warn(`[CliAuthFactory] Leader refresh failed for ${cliType}: ${result.error ?? 'unknown error'}`);

            if (result.error === this.LEADER_REFRESH_TIMEOUT_ERROR) {
                if (forceRefresh) {
                    return null;
                }
                // 回退本地刷新前先重读凭证：超时≠失败，Leader 可能刚好在超时窗口后完成刷新并落盘。
                // refresh_token 单次轮换，若持旧凭证再次刷新会导致 invalid_grant，甚至整条授权链被撤销。
                instance.invalidateCredentialCache();
                const reloaded = await this.loadRefreshTarget(cliType, instance, credentialName, credentialSource);
                if (reloaded?.access_token && !instance.isExpired(reloaded)) {
                    Logger.info(
                        `[CliAuthFactory] Credentials refreshed by leader after timeout for ${cliType}, using reloaded credentials`
                    );
                    return reloaded;
                }

                const currentLeaderId = LeaderElectionService.getLeaderId();
                if (
                    currentLeaderId &&
                    currentLeaderId !== LeaderElectionService.getInstanceId() &&
                    LeaderElectionService.isLeaderHeartbeatFresh()
                ) {
                    // Leader 仍存活：refresh_token 单次轮换，本地不能并行刷新，
                    // 轮询等待 Leader 完成刷新落盘；宽限期内 Leader 失联则转本地兜底。
                    const graceCredentials = await this.waitForLeaderRefreshedCredentials(
                        cliType,
                        instance,
                        credentialName,
                        credentialSource
                    );
                    if (graceCredentials) {
                        return graceCredentials;
                    }
                    if (!LeaderElectionService.isLeaderHeartbeatFresh()) {
                        Logger.warn(
                            `[CliAuthFactory] Leader went offline during grace period for ${cliType}, falling back to local refresh`
                        );
                        return await this.ensureRefreshTarget(
                            cliType,
                            instance,
                            credentialName,
                            true,
                            credentialSource
                        );
                    }
                    Logger.warn(
                        `[CliAuthFactory] Leader refresh timed out for ${cliType} and no refreshed credentials after grace period, giving up`
                    );
                    return null;
                }

                Logger.warn(
                    `[CliAuthFactory] Leader refresh timed out for ${cliType} and leader appears offline, falling back to local refresh`
                );
                return await this.ensureRefreshTarget(cliType, instance, credentialName, true, credentialSource);
            }

            const currentLeaderId = LeaderElectionService.getLeaderId();
            if (!currentLeaderId || currentLeaderId === LeaderElectionService.getInstanceId()) {
                return await this.ensureRefreshTarget(cliType, instance, credentialName, true, credentialSource);
            }

            return null;
        }

        instance.invalidateCredentialCache();
        return await this.loadRefreshTarget(cliType, instance, credentialName, credentialSource);
    }

    private static async loadRefreshTarget(
        cliType: string,
        instance: BaseCliAuth,
        credentialName?: string,
        credentialSource?: 'cliNative'
    ): Promise<OAuthCredentials | null> {
        if (credentialSource === 'cliNative') {
            return await instance.loadCredentialsFromPath(instance.getCliNativeCredentialPath());
        }
        if (!credentialName) {
            return await instance.loadCredentials();
        }
        const credentialPath = OAuthCredentialStore.getCredentialPath(cliType, credentialName);
        return credentialPath ? await instance.loadCredentialsFromPath(credentialPath) : null;
    }

    private static async ensureRefreshTarget(
        cliType: string,
        instance: BaseCliAuth,
        credentialName: string | undefined,
        forceRefresh: boolean,
        credentialSource?: 'cliNative'
    ): Promise<OAuthCredentials | null> {
        if (credentialSource === 'cliNative') {
            return await instance.ensureAuthenticatedFromPath(instance.getCliNativeCredentialPath(), forceRefresh);
        }
        if (!credentialName) {
            return await instance.ensureAuthenticated(forceRefresh);
        }
        const credentialPath = OAuthCredentialStore.getCredentialPath(cliType, credentialName);
        return credentialPath ? await instance.ensureAuthenticatedFromPath(credentialPath, forceRefresh) : null;
    }

    private static waitForRefreshCompletion(
        requestId: string,
        leaderId: string
    ): Promise<{ success: boolean; error?: string }> {
        return new Promise(resolve => {
            const timer = setTimeout(() => {
                if (this.pendingRefreshRequests.has(requestId)) {
                    this.pendingRefreshRequests.delete(requestId);
                    Logger.warn(`[CliAuthFactory] CLI auth refresh request timed out: ${requestId}`);
                }
                resolve({ success: false, error: this.LEADER_REFRESH_TIMEOUT_ERROR });
            }, this.CLI_AUTH_REFRESH_TIMEOUT_MS);

            this.pendingRefreshRequests.set(requestId, { leaderId, resolve, timer });
        });
    }

    /**
     * Leader 仍存活但委托刷新已超时：轮询凭证文件，等待 Leader 完成刷新落盘。
     * refresh_token 单次轮换，本地不能并行刷新，只能等待 Leader 的刷新结果；
     * 宽限期内拿到未过期凭证即视为成功，Leader 失联或宽限超时则返回 null 由调用方处理。
     */
    private static async waitForLeaderRefreshedCredentials(
        cliType: string,
        instance: BaseCliAuth,
        credentialName?: string,
        credentialSource?: 'cliNative'
    ): Promise<OAuthCredentials | null> {
        const deadline = Date.now() + this.LEADER_REFRESH_GRACE_PERIOD_MS;
        while (Date.now() < deadline) {
            await new Promise(resolve => setTimeout(resolve, this.LEADER_REFRESH_GRACE_POLL_INTERVAL_MS));
            // Leader 可能在等待期间下线：及时退出，让调用方走本地兜底刷新
            if (!LeaderElectionService.isLeaderHeartbeatFresh()) {
                return null;
            }
            instance.invalidateCredentialCache();
            const credentials = await this.loadRefreshTarget(cliType, instance, credentialName, credentialSource);
            if (credentials?.access_token && !instance.isExpired(credentials)) {
                Logger.info(`[CliAuthFactory] Credentials refreshed by leader during grace period for ${cliType}`);
                return credentials;
            }
        }
        return null;
    }

    private static async handleRefreshRequested(event: CliAuthRefreshRequestedEvent): Promise<void> {
        const payload = event.payload;
        const instance = this.getInstance(payload.providerKey);
        if (!instance) {
            this.publishRefreshCompleted(payload.requestId, payload.providerKey, false, 'unsupported CLI provider');
            return;
        }

        try {
            const credentialPath =
                payload.credentialSource === 'cliNative' ? undefined
                : payload.credentialName ?
                    OAuthCredentialStore.getCredentialPath(payload.providerKey, payload.credentialName)
                :   undefined;
            const credentials =
                payload.credentialSource === 'cliNative' ?
                    await instance.ensureAuthenticatedFromPath(
                        instance.getCliNativeCredentialPath(),
                        payload.forceRefresh
                    )
                : payload.credentialName ?
                    credentialPath ? await instance.ensureAuthenticatedFromPath(credentialPath, payload.forceRefresh)
                    :   null
                :   await instance.ensureAuthenticated(payload.forceRefresh);
            if (!credentials?.access_token) {
                this.publishRefreshCompleted(
                    payload.requestId,
                    payload.providerKey,
                    false,
                    'credentials unavailable after refresh'
                );
                return;
            }

            this.publishRefreshCompleted(payload.requestId, payload.providerKey, true);
        } catch (error) {
            this.publishRefreshCompleted(
                payload.requestId,
                payload.providerKey,
                false,
                error instanceof Error ? error.message : String(error)
            );
        }
    }

    private static publishRefreshCompleted(
        requestId: string,
        providerKey: string,
        success: boolean,
        error?: string
    ): void {
        // alsoFallback：Leader 的 IPC 广播到不了已降级到文件通道的 Follower，
        // 双写保证降级 Follower 也能收到回执；IPC 直连 Follower 重复接收时按 requestId 幂等处理
        InterInstanceBus.publish(
            {
                type: 'cliAuthRefreshCompleted',
                payload: {
                    requestId,
                    providerKey,
                    success,
                    ...(error ? { error } : {})
                }
            },
            { alsoFallback: true }
        );
    }
}
