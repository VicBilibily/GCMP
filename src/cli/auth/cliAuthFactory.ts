/*---------------------------------------------------------------------------------------------
 *  CLI 认证工厂
 *  管理不同 CLI 提供商的认证实例
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { BaseCliAuth } from './baseCliAuth';
import { CodexCliAuth } from './codexCliAuth';
import { GrokCliAuth } from './grokCliAuth';
import { Logger } from '../../utils/logger';
import { OAuthCredentials } from '../type';
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
        { resolve: (result: { success: boolean; error?: string }) => void; timer: ReturnType<typeof setTimeout> }
    >();
    private static readonly CLI_AUTH_REFRESH_TIMEOUT_MS = 15_000;

    /**
     * 初始化跨实例 CLI 刷新协调
     */
    static initialize(context: vscode.ExtensionContext): void {
        if (this.initialized) {
            return;
        }

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
                if (!pending) {
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
            return await this.delegateRefreshToLeader(cliType, instance);
        }

        return await instance.ensureAuthenticated(true);
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
        instance: BaseCliAuth
    ): Promise<OAuthCredentials | null> {
        const requestId = `${Date.now().toString(36)}_${Math.random().toString(36).slice(2)}`;
        const waitForCompletion = this.waitForRefreshCompletion(requestId);

        Logger.info(`[CliAuthFactory] Delegating ${cliType} CLI auth refresh to leader`);
        InterInstanceBus.publish({
            type: 'cliAuthRefreshRequested',
            payload: {
                requestId,
                providerKey: cliType,
                forceRefresh: true,
                requestedBy: LeaderElectionService.getInstanceId()
            }
        });

        const result = await waitForCompletion;
        if (!result.success) {
            Logger.warn(`[CliAuthFactory] Leader refresh failed for ${cliType}: ${result.error ?? 'unknown error'}`);

            if (result.error === this.LEADER_REFRESH_TIMEOUT_ERROR) {
                Logger.warn(`[CliAuthFactory] Leader refresh timed out for ${cliType}, falling back to local refresh`);
                return await instance.ensureAuthenticated(true);
            }

            const currentLeaderId = LeaderElectionService.getLeaderId();
            if (!currentLeaderId || currentLeaderId === LeaderElectionService.getInstanceId()) {
                return await instance.ensureAuthenticated(true);
            }

            return null;
        }

        instance.invalidateCredentialCache();
        return await instance.loadCredentials();
    }

    private static waitForRefreshCompletion(requestId: string): Promise<{ success: boolean; error?: string }> {
        return new Promise(resolve => {
            const timer = setTimeout(() => {
                if (this.pendingRefreshRequests.has(requestId)) {
                    this.pendingRefreshRequests.delete(requestId);
                    Logger.warn(`[CliAuthFactory] CLI auth refresh request timed out: ${requestId}`);
                }
                resolve({ success: false, error: this.LEADER_REFRESH_TIMEOUT_ERROR });
            }, this.CLI_AUTH_REFRESH_TIMEOUT_MS);

            this.pendingRefreshRequests.set(requestId, { resolve, timer });
        });
    }

    private static async handleRefreshRequested(event: CliAuthRefreshRequestedEvent): Promise<void> {
        const payload = event.payload;
        const instance = this.getInstance(payload.providerKey);
        if (!instance) {
            this.publishRefreshCompleted(payload.requestId, payload.providerKey, false, 'unsupported CLI provider');
            return;
        }

        try {
            const credentials = await instance.ensureAuthenticated(payload.forceRefresh);
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
        InterInstanceBus.publish({
            type: 'cliAuthRefreshCompleted',
            payload: {
                requestId,
                providerKey,
                success,
                ...(error ? { error } : {})
            }
        });
    }
}
