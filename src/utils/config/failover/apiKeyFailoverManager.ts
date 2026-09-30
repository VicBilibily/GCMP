import * as crypto from 'node:crypto';
import * as vscode from 'vscode';
import { ApiKeyManager } from '../apiKeyManager';
import { ConfigSetStore, type ConfigSetItem } from '../configSetStore';
import {
    applyConfigSetUnlocked,
    enqueueConfigSetMutation,
    getSiteOwnerProvider,
    readCurrentSite
} from '../configSetCommands';
import { Logger } from '../../runtime/logger';
import { t } from '../../runtime/l10n';
import { isApiKeyFailoverError } from './apiKeyFailoverClassifier';
import { InterInstanceBus } from '../../../interInstance';
import { LeaderElectionService } from '../../../status/leaderElectionService';

export const API_KEY_FAILOVER_ERROR_THRESHOLD = 3;
const FAILOVER_COORDINATION_TIMEOUT_MS = 10_000;
const FAILOVER_FAILURE_WINDOW_MS = 10_000;
const FAILOVER_ROTATION_SETTLE_MS = 100;

export interface ApiKeyFailoverAttempt {
    activeId: string;
    apiKey: string;
    apiKeyName?: string;
    identity: string;
    site?: string;
}

export interface ApiKeyFailoverDecision {
    handled: boolean;
    shouldRetry: boolean;
    switched: boolean;
    switchedToInitial?: boolean;
}

interface KeyedConfigSetItem {
    item: ConfigSetItem;
    apiKey: string;
}

interface ResolvedConfigPool {
    current: KeyedConfigSetItem;
    candidates: KeyedConfigSetItem[];
    currentSite?: string;
    currentApiKeyName?: string;
}

interface LeaderRotationResult {
    decision: ApiKeyFailoverDecision;
    targetId?: string;
    targetIdentity?: string;
}

const UNHANDLED_DECISION: ApiKeyFailoverDecision = {
    handled: false,
    shouldRetry: false,
    switched: false
};

const STOP_DECISION: ApiKeyFailoverDecision = {
    handled: true,
    shouldRetry: false,
    switched: false
};

export class ApiKeyFailoverManager {
    private static pendingLeaderDecisions = new Map<
        string,
        {
            resolve: (decision: ApiKeyFailoverDecision) => void;
            timer: NodeJS.Timeout;
            cancellation?: vscode.Disposable;
        }
    >();
    private static leaderFailureWindows = new Map<
        string,
        {
            authorityTerm: string;
            slot: string;
            expiresAt: number;
            aggregateFailureCount: number;
            requestFailureCounts: Map<string, number>;
            rotationDecision?: Promise<LeaderRotationResult>;
        }
    >();
    private static leaderFailureResets = new Map<string, number>();

    static resolveLeaderDecision(requestId: string, decision: ApiKeyFailoverDecision): void {
        const pending = this.pendingLeaderDecisions.get(requestId);
        if (!pending) {
            return;
        }
        clearTimeout(pending.timer);
        pending.cancellation?.dispose();
        this.pendingLeaderDecisions.delete(requestId);
        pending.resolve(decision);
    }

    static resetFailureCount(slot: string, failureRequestId: string): void {
        if (!failureRequestId || !LeaderElectionService.isInitialized()) {
            return;
        }
        const authorityTerm = this.getRequestAuthorityTerm();
        if (!authorityTerm) {
            return;
        }
        if (LeaderElectionService.isLeader()) {
            this.clearLeaderFailureSource(authorityTerm, slot, failureRequestId);
            return;
        }
        try {
            InterInstanceBus.publish({
                type: 'apiKeyFailoverReset',
                payload: {
                    requestId: crypto.randomUUID(),
                    failureRequestId,
                    requestedBy: LeaderElectionService.getInstanceId(),
                    authorityTerm,
                    slot
                }
            });
        } catch (error) {
            Logger.warn(`[ApiKeyFailover] Failed to publish failure reset for ${slot}:`, error);
        }
    }

    static handleLeaderFailureReset(payload: { authorityTerm: string; slot: string; failureRequestId: string }): void {
        if (!this.isCurrentLeaderTerm(payload.authorityTerm)) {
            return;
        }
        this.clearLeaderFailureSource(payload.authorityTerm, payload.slot, payload.failureRequestId);
    }

    static async handleLeaderFailureSignal(payload: {
        requestId: string;
        failureRequestId: string;
        authorityTerm: string;
        slot: string;
        activeId: string;
        identity: string;
        site?: string;
        consecutiveFailureCount: number;
        attemptedIdentities: string[];
        initialConfigId?: string;
        returnedToInitial: boolean;
    }): Promise<ApiKeyFailoverDecision> {
        if (!this.isCurrentLeaderTerm(payload.authorityTerm)) {
            return STOP_DECISION;
        }
        if (!ConfigSetStore.isAutoSwitchEnabled(payload.slot)) {
            return STOP_DECISION;
        }
        const now = Date.now();
        this.cleanupLeaderFailureState(now);
        if (this.leaderFailureResets.has(this.getLeaderFailureResetKey(payload))) {
            return { handled: true, shouldRetry: true, switched: false };
        }

        const currentPool = await this.resolveConfigPool(payload.slot);
        if (!currentPool || currentPool.candidates.length < 2) {
            return STOP_DECISION;
        }
        if (this.leaderFailureResets.has(this.getLeaderFailureResetKey(payload))) {
            return { handled: true, shouldRetry: true, switched: false };
        }
        const currentIdentity = this.getIdentity(
            currentPool.current.item.id,
            currentPool.current.apiKey,
            currentPool.currentSite
        );
        if (currentIdentity !== payload.identity) {
            this.leaderFailureWindows.delete(this.getLeaderFailureWindowKey(payload));
            return this.getRequestDecisionForTarget(payload, currentPool.current.item.id, currentIdentity);
        }
        if (payload.returnedToInitial) {
            return STOP_DECISION;
        }
        const failureWindowKey = this.getLeaderFailureWindowKey(payload);
        let failureWindow = this.leaderFailureWindows.get(failureWindowKey);
        if (!failureWindow || failureWindow.expiresAt <= now) {
            failureWindow = {
                authorityTerm: payload.authorityTerm,
                slot: payload.slot,
                expiresAt: now + FAILOVER_FAILURE_WINDOW_MS,
                aggregateFailureCount: 0,
                requestFailureCounts: new Map()
            };
            this.leaderFailureWindows.set(failureWindowKey, failureWindow);
        }
        if (failureWindow.rotationDecision) {
            return this.getRequestDecisionForRotation(payload, await failureWindow.rotationDecision);
        }

        const reportedFailureCount = Math.max(1, payload.consecutiveFailureCount);
        const previousFailureCount = failureWindow.requestFailureCounts.get(payload.failureRequestId) ?? 0;
        const newFailureCount = Math.max(0, reportedFailureCount - previousFailureCount);
        if (newFailureCount === 0) {
            return { handled: true, shouldRetry: true, switched: false };
        }
        failureWindow.requestFailureCounts.set(payload.failureRequestId, reportedFailureCount);
        failureWindow.aggregateFailureCount += newFailureCount;
        if (failureWindow.aggregateFailureCount < API_KEY_FAILOVER_ERROR_THRESHOLD) {
            return { handled: true, shouldRetry: true, switched: false };
        }

        failureWindow.rotationDecision = this.rotateLeaderConfiguration(payload, failureWindowKey, failureWindow);
        return this.getRequestDecisionForRotation(payload, await failureWindow.rotationDecision);
    }

    private static async rotateLeaderConfiguration(
        payload: {
            authorityTerm: string;
            slot: string;
            activeId: string;
            identity: string;
            site?: string;
        },
        failureWindowKey: string,
        failureWindow: {
            authorityTerm: string;
            slot: string;
            expiresAt: number;
            aggregateFailureCount: number;
            requestFailureCounts: Map<string, number>;
            rotationDecision?: Promise<LeaderRotationResult>;
        }
    ): Promise<LeaderRotationResult> {
        await new Promise(resolve => setTimeout(resolve, FAILOVER_ROTATION_SETTLE_MS));
        if (
            this.leaderFailureWindows.get(failureWindowKey) !== failureWindow ||
            failureWindow.aggregateFailureCount < API_KEY_FAILOVER_ERROR_THRESHOLD
        ) {
            failureWindow.rotationDecision = undefined;
            return {
                decision: { handled: true, shouldRetry: true, switched: false }
            };
        }

        try {
            const decision = await this.rotateConfiguration(
                payload.slot,
                payload,
                new Set(),
                failureWindow.aggregateFailureCount,
                undefined,
                false,
                payload.authorityTerm,
                () =>
                    this.leaderFailureWindows.get(failureWindowKey) === failureWindow &&
                    failureWindow.aggregateFailureCount >= API_KEY_FAILOVER_ERROR_THRESHOLD
            );
            if (!decision.switched) {
                if (failureWindow.aggregateFailureCount < API_KEY_FAILOVER_ERROR_THRESHOLD) {
                    return {
                        decision: { handled: true, shouldRetry: true, switched: false }
                    };
                }
                return { decision };
            }

            const targetPool = await this.resolveConfigPool(payload.slot);
            if (!targetPool) {
                return { decision: STOP_DECISION };
            }
            return {
                decision,
                targetId: targetPool.current.item.id,
                targetIdentity: this.getIdentity(
                    targetPool.current.item.id,
                    targetPool.current.apiKey,
                    targetPool.currentSite
                )
            };
        } finally {
            if (this.leaderFailureWindows.get(failureWindowKey) === failureWindow) {
                this.leaderFailureWindows.delete(failureWindowKey);
            }
        }
    }

    private static getRequestDecisionForRotation(
        payload: {
            activeId: string;
            identity: string;
            attemptedIdentities: string[];
            initialConfigId?: string;
            returnedToInitial: boolean;
        },
        result: LeaderRotationResult
    ): ApiKeyFailoverDecision {
        if (!result.decision.switched || !result.targetId || !result.targetIdentity) {
            return result.decision;
        }
        return this.getRequestDecisionForTarget(payload, result.targetId, result.targetIdentity);
    }

    private static getRequestDecisionForTarget(
        payload: {
            activeId: string;
            identity: string;
            attemptedIdentities: string[];
            initialConfigId?: string;
            returnedToInitial: boolean;
        },
        targetId: string,
        targetIdentity: string
    ): ApiKeyFailoverDecision {
        const attemptedIdentities = new Set(payload.attemptedIdentities);
        const returnedToInitial = targetId === payload.initialConfigId;
        const switchedToInitial = returnedToInitial && targetId !== payload.activeId;
        const shouldRetry =
            !attemptedIdentities.has(targetIdentity) || (switchedToInitial && !payload.returnedToInitial);
        const decision: ApiKeyFailoverDecision = {
            handled: true,
            shouldRetry,
            switched: true
        };
        if (shouldRetry && switchedToInitial) {
            decision.switchedToInitial = true;
        }
        return decision;
    }

    private static cleanupLeaderFailureState(now: number): void {
        for (const [failureWindowKey, state] of this.leaderFailureWindows) {
            if (state.expiresAt <= now) {
                this.leaderFailureWindows.delete(failureWindowKey);
            }
        }
        for (const [resetKey, expiresAt] of this.leaderFailureResets) {
            if (expiresAt <= now) {
                this.leaderFailureResets.delete(resetKey);
            }
        }
    }

    private static clearLeaderFailureSource(authorityTerm: string, slot: string, failureRequestId: string): void {
        const now = Date.now();
        this.cleanupLeaderFailureState(now);
        this.leaderFailureResets.set(
            this.getLeaderFailureResetKey({ authorityTerm, slot, failureRequestId }),
            now + FAILOVER_FAILURE_WINDOW_MS
        );
        for (const [failureWindowKey, state] of this.leaderFailureWindows) {
            if (state.authorityTerm !== authorityTerm || state.slot !== slot) {
                continue;
            }
            const previousFailureCount = state.requestFailureCounts.get(failureRequestId);
            if (previousFailureCount === undefined) {
                continue;
            }
            state.requestFailureCounts.delete(failureRequestId);
            state.aggregateFailureCount = Math.max(0, state.aggregateFailureCount - previousFailureCount);
            if (!state.rotationDecision && state.aggregateFailureCount === 0) {
                this.leaderFailureWindows.delete(failureWindowKey);
            }
        }
    }

    private static getLeaderFailureResetKey(payload: {
        authorityTerm: string;
        slot: string;
        failureRequestId: string;
    }): string {
        return JSON.stringify([payload.authorityTerm, payload.slot, payload.failureRequestId]);
    }

    private static getLeaderFailureWindowKey(payload: {
        requestId: string;
        authorityTerm: string;
        slot: string;
        activeId: string;
        identity: string;
        site?: string;
        consecutiveFailureCount: number;
        attemptedIdentities: string[];
        initialConfigId?: string;
        returnedToInitial: boolean;
    }): string {
        return JSON.stringify([
            payload.authorityTerm,
            payload.slot,
            payload.activeId,
            payload.identity,
            payload.site ?? ''
        ]);
    }

    static getCandidateCountUpperBound(slot: string): number {
        return ConfigSetStore.isAutoSwitchEnabled(slot) ? ConfigSetStore.list(slot).length : 0;
    }

    static async canEnableAutoSwitch(slot: string): Promise<boolean> {
        try {
            const pool = await this.resolveConfigPool(slot);
            return !!pool && pool.candidates.length >= 2;
        } catch (error) {
            Logger.warn(`[ApiKeyFailover] Failed to validate candidate configurations for ${slot}:`, error);
            return false;
        }
    }

    static async disableIfUnavailable(slot: string): Promise<boolean> {
        if (!ConfigSetStore.isAutoSwitchEnabled(slot)) {
            return false;
        }
        return await enqueueConfigSetMutation(async () => {
            if (!ConfigSetStore.isAutoSwitchEnabled(slot)) {
                return false;
            }
            const pool = await this.resolveConfigPool(slot);
            if (pool && pool.candidates.length >= 2) {
                return false;
            }
            await ConfigSetStore.setAutoSwitchEnabled(slot, false);
            return true;
        });
    }

    static async captureAttempt(slot: string): Promise<ApiKeyFailoverAttempt | undefined> {
        if (!ConfigSetStore.isAutoSwitchEnabled(slot)) {
            return undefined;
        }

        return await enqueueConfigSetMutation(async () => {
            if (!ConfigSetStore.isAutoSwitchEnabled(slot)) {
                return undefined;
            }
            const operationToken = ConfigSetStore.getApplyOperationToken(slot);
            const pool = await this.resolveConfigPool(slot);
            if (ConfigSetStore.getApplyOperationToken(slot) !== operationToken) {
                throw new Error(
                    t('Configuration changed while capturing the request snapshot.', '读取请求快照时配置已变化。')
                );
            }
            if (!pool || pool.candidates.length < 2) {
                return undefined;
            }
            return {
                activeId: pool.current.item.id,
                apiKey: pool.current.apiKey,
                apiKeyName: pool.currentApiKeyName,
                identity: this.getIdentity(pool.current.item.id, pool.current.apiKey, pool.currentSite),
                site: pool.currentSite
            };
        });
    }

    static async handleFailure(
        slot: string,
        error: unknown,
        attempt: ApiKeyFailoverAttempt | undefined,
        attemptedIdentities: Set<string>,
        consecutiveFailureCount: number,
        initialConfigId?: string,
        returnedToInitial = false,
        authorityTerm?: string,
        failureRequestId?: string,
        canContinue?: () => boolean,
        token?: vscode.CancellationToken
    ): Promise<ApiKeyFailoverDecision> {
        if (!attempt || !isApiKeyFailoverError(error)) {
            return UNHANDLED_DECISION;
        }
        if (token?.isCancellationRequested) {
            return STOP_DECISION;
        }

        const requestAuthorityTerm = this.getRequestAuthorityTerm();
        if (LeaderElectionService.isAgentsWindow() && !requestAuthorityTerm) {
            return STOP_DECISION;
        }

        // 失败计数达标即切换 Key，请求取消不阻止全局切换。
        if (LeaderElectionService.isInitialized() && LeaderElectionService.isLeader() && failureRequestId) {
            if (!requestAuthorityTerm) {
                return STOP_DECISION;
            }
            attemptedIdentities.add(attempt.identity);
            return await this.handleLeaderFailureSignal({
                requestId: crypto.randomUUID(),
                failureRequestId,
                authorityTerm: requestAuthorityTerm,
                slot,
                activeId: attempt.activeId,
                identity: attempt.identity,
                site: attempt.site,
                consecutiveFailureCount,
                attemptedIdentities: [...attemptedIdentities],
                initialConfigId,
                returnedToInitial
            });
        }

        if (LeaderElectionService.isInitialized() && !LeaderElectionService.isLeader()) {
            if (!requestAuthorityTerm) {
                return STOP_DECISION;
            }
            const requestId = crypto.randomUUID();
            const requestedBy = LeaderElectionService.getInstanceId();
            attemptedIdentities.add(attempt.identity);
            if (token?.isCancellationRequested) {
                return STOP_DECISION;
            }
            const decision = new Promise<ApiKeyFailoverDecision>(resolve => {
                const timer = setTimeout(() => {
                    const pending = this.pendingLeaderDecisions.get(requestId);
                    pending?.cancellation?.dispose();
                    this.pendingLeaderDecisions.delete(requestId);
                    resolve(STOP_DECISION);
                }, FAILOVER_COORDINATION_TIMEOUT_MS);
                const pending: {
                    resolve: (decision: ApiKeyFailoverDecision) => void;
                    timer: NodeJS.Timeout;
                    cancellation?: vscode.Disposable;
                } = { resolve, timer };
                this.pendingLeaderDecisions.set(requestId, pending);
                pending.cancellation = token?.onCancellationRequested(() => {
                    this.resolveLeaderDecision(requestId, STOP_DECISION);
                });
            });
            if (token?.isCancellationRequested) {
                this.resolveLeaderDecision(requestId, STOP_DECISION);
                return await decision;
            }
            try {
                InterInstanceBus.publish({
                    type: 'apiKeyFailoverRequested',
                    payload: {
                        requestId,
                        failureRequestId: failureRequestId ?? requestId,
                        requestedBy,
                        authorityTerm: requestAuthorityTerm,
                        slot,
                        activeId: attempt.activeId,
                        identity: attempt.identity,
                        site: attempt.site,
                        consecutiveFailureCount,
                        attemptedIdentities: [...attemptedIdentities],
                        initialConfigId,
                        returnedToInitial
                    }
                });
            } catch (publishError) {
                Logger.warn(`[ApiKeyFailover] Failed to publish failover request for ${slot}:`, publishError);
                this.resolveLeaderDecision(requestId, STOP_DECISION);
            }
            return await decision;
        }

        return await this.rotateConfiguration(
            slot,
            attempt,
            attemptedIdentities,
            consecutiveFailureCount,
            initialConfigId,
            returnedToInitial,
            authorityTerm,
            canContinue
        );
    }

    private static async rotateConfiguration(
        slot: string,
        attempt: Pick<ApiKeyFailoverAttempt, 'activeId' | 'identity'>,
        attemptedIdentities: Set<string>,
        consecutiveFailureCount: number,
        initialConfigId?: string,
        returnedToInitial = false,
        authorityTerm?: string,
        canContinue?: () => boolean
    ): Promise<ApiKeyFailoverDecision> {
        try {
            return await enqueueConfigSetMutation(async () => {
                if (!ConfigSetStore.isAutoSwitchEnabled(slot) || (canContinue && !canContinue())) {
                    return STOP_DECISION;
                }

                const sourceOperationToken = ConfigSetStore.getApplyOperationToken(slot);
                const pool = await this.resolveConfigPool(slot);
                if (!pool || pool.candidates.length < 2) {
                    return UNHANDLED_DECISION;
                }
                if (!this.isCurrentLeaderTerm(authorityTerm)) {
                    return STOP_DECISION;
                }
                const siteProvider = getSiteOwnerProvider(slot);
                const canStart = (): boolean =>
                    ConfigSetStore.getApplyOperationToken(slot) === sourceOperationToken &&
                    (!siteProvider || readCurrentSite(siteProvider) === pool.currentSite);

                const currentIdentity = this.getIdentity(pool.current.item.id, pool.current.apiKey, pool.currentSite);
                if (currentIdentity !== attempt.identity) {
                    attemptedIdentities.add(attempt.identity);
                    return this.getRequestDecisionForTarget(
                        {
                            activeId: attempt.activeId,
                            identity: attempt.identity,
                            attemptedIdentities: [...attemptedIdentities],
                            initialConfigId,
                            returnedToInitial
                        },
                        pool.current.item.id,
                        currentIdentity
                    );
                }

                if (returnedToInitial) {
                    return STOP_DECISION;
                }

                if (consecutiveFailureCount < API_KEY_FAILOVER_ERROR_THRESHOLD) {
                    return { handled: true, shouldRetry: true, switched: false };
                }

                attemptedIdentities.add(currentIdentity);
                let target = this.findNextCandidate(pool, attemptedIdentities);
                const returningToInitial = !target && !!initialConfigId && pool.current.item.id !== initialConfigId;
                if (returningToInitial) {
                    target = pool.candidates.find(candidate => candidate.item.id === initialConfigId);
                }
                if (!target) {
                    return STOP_DECISION;
                }

                let applied = false;
                try {
                    if (!this.isCurrentLeaderTerm(authorityTerm)) {
                        return STOP_DECISION;
                    }
                    applied = await applyConfigSetUnlocked(
                        slot,
                        target.item,
                        () =>
                            this.isCurrentLeaderTerm(authorityTerm) &&
                            ConfigSetStore.isAutoSwitchEnabled(slot) &&
                            (!canContinue || canContinue()),
                        { canStart }
                    );
                } catch (error) {
                    Logger.warn(`[ApiKeyFailover] Failed to switch configuration for ${slot}:`, error);
                }
                if (!applied) {
                    return STOP_DECISION;
                }

                if (!returningToInitial) {
                    Logger.warn(
                        `[ApiKeyFailover] ${slot}: switched to configuration "${target.item.label}" after ${consecutiveFailureCount} consecutive request failures`
                    );
                    vscode.window.setStatusBarMessage(
                        `$(key) ${t(
                            '{0}: automatically switched to API Key configuration "{1}"',
                            '{0}：已自动切换到 API Key 配置“{1}”',
                            slot,
                            target.item.label
                        )}`,
                        5000
                    );
                }
                return {
                    handled: true,
                    shouldRetry: true,
                    switched: true,
                    ...(target.item.id === initialConfigId ? { switchedToInitial: true } : {})
                };
            });
        } catch (switchError) {
            Logger.warn(`[ApiKeyFailover] Failed to process automatic switch for ${slot}:`, switchError);
            return STOP_DECISION;
        }
    }

    private static getRequestAuthorityTerm(): string | undefined {
        if (LeaderElectionService.isAgentsWindow()) {
            if (!InterInstanceBus.hasActiveTransport()) {
                return undefined;
            }
            return InterInstanceBus.getAuthorityTerm();
        }
        if (LeaderElectionService.isLeader()) {
            return LeaderElectionService.getOwnedAuthorityTerm();
        }
        return LeaderElectionService.getAuthorityTerm() ?? InterInstanceBus.getAuthorityTerm();
    }

    private static isCurrentLeaderTerm(authorityTerm?: string): boolean {
        if (!LeaderElectionService.isInitialized()) {
            return true;
        }
        const ownedAuthorityTerm = LeaderElectionService.getOwnedAuthorityTerm();
        return (
            LeaderElectionService.isLeader() &&
            !!ownedAuthorityTerm &&
            (!authorityTerm || ownedAuthorityTerm === authorityTerm)
        );
    }

    private static async resolveConfigPool(slot: string): Promise<ResolvedConfigPool | undefined> {
        const items = ConfigSetStore.list(slot);
        if (items.length < 2) {
            return undefined;
        }

        const [currentApiKey, ...savedKeys] = await Promise.all([
            ApiKeyManager.getApiKey(slot),
            ...items.map(item => ConfigSetStore.getApiKey(slot, item.id))
        ]);
        if (!currentApiKey) {
            return undefined;
        }

        const keyedItems: KeyedConfigSetItem[] = [];
        const candidatesById = new Map<string, KeyedConfigSetItem>();
        for (let index = 0; index < items.length; index += 1) {
            const apiKey = savedKeys[index];
            if (!apiKey?.trim()) {
                continue;
            }
            const candidate = { item: items[index]!, apiKey };
            keyedItems.push(candidate);
            candidatesById.set(candidate.item.id, candidate);
        }

        const siteProvider = getSiteOwnerProvider(slot);
        const currentSite = siteProvider ? readCurrentSite(siteProvider) : undefined;
        const matchesCurrent = (candidate: KeyedConfigSetItem): boolean =>
            candidate.apiKey === currentApiKey &&
            (!siteProvider || (candidate.item.site ?? currentSite) === currentSite);

        const marked = candidatesById.get(ConfigSetStore.getActiveId(slot) ?? '');
        const current = marked && matchesCurrent(marked) ? marked : keyedItems.find(matchesCurrent);
        if (!current) {
            return undefined;
        }

        const currentCredentialIdentity = this.getCredentialIdentity(current.apiKey, current.item.site ?? currentSite);
        const seenCredentialIdentities = new Set<string>();
        const candidates = keyedItems.filter(candidate => {
            const credentialIdentity = this.getCredentialIdentity(candidate.apiKey, candidate.item.site ?? currentSite);
            if (credentialIdentity === currentCredentialIdentity) {
                if (candidate.item.id !== current.item.id || seenCredentialIdentities.has(credentialIdentity)) {
                    return false;
                }
                seenCredentialIdentities.add(credentialIdentity);
                return true;
            }
            if (seenCredentialIdentities.has(credentialIdentity)) {
                return false;
            }
            seenCredentialIdentities.add(credentialIdentity);
            return true;
        });
        const currentApiKeyName =
            current === marked || keyedItems.filter(matchesCurrent).length === 1 ?
                current.item.label.trim() || undefined
            :   undefined;
        return candidates.length >= 2 ? { current, candidates, currentSite, currentApiKeyName } : undefined;
    }

    private static findNextCandidate(
        pool: ResolvedConfigPool,
        attemptedIdentities: ReadonlySet<string>
    ): KeyedConfigSetItem | undefined {
        const currentIndex = pool.candidates.findIndex(candidate => candidate.item.id === pool.current.item.id);
        for (let offset = 1; offset < pool.candidates.length; offset += 1) {
            const candidate = pool.candidates[(currentIndex + offset) % pool.candidates.length];
            if (
                candidate &&
                !attemptedIdentities.has(
                    this.getIdentity(candidate.item.id, candidate.apiKey, candidate.item.site ?? pool.currentSite)
                )
            ) {
                return candidate;
            }
        }
        return undefined;
    }

    private static getIdentity(id: string, apiKey: string, site?: string): string {
        const fingerprint = crypto.createHash('sha256').update(apiKey).digest('hex').slice(0, 16);
        return `${id}:${fingerprint}:${site ?? ''}`;
    }

    private static getCredentialIdentity(apiKey: string, site?: string): string {
        return crypto
            .createHash('sha256')
            .update(`${apiKey}\u0000${site ?? ''}`)
            .digest('hex');
    }
}
