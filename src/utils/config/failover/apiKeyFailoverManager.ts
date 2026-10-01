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
import type {
    ApiKeyBalanceAssignmentRequestedEvent,
    ApiKeyBalanceAssignmentResolvedEvent,
    ApiKeyBalanceFailureReportedEvent,
    ApiKeyBalanceFailureResolvedEvent
} from '../../../interInstance';

export const API_KEY_FAILOVER_ERROR_THRESHOLD = 3;
const FAILOVER_COORDINATION_TIMEOUT_MS = 10_000;
const FAILOVER_FAILURE_WINDOW_MS = 10_000;
const FAILOVER_ROTATION_SETTLE_MS = 100;
// 隔离只对当前平衡单元生效，全池被隔离时仍允许回退。
const BALANCE_EXCLUSION_TTL_MS = 5 * 60_000;
const BALANCE_LEASE_TTL_MS = 30_000;
const BALANCE_COORDINATION_TIMEOUT_MS = 10_000;
const BALANCE_LEASE_RENEW_INTERVAL_MS = 10_000;

export interface ApiKeyFailoverAttempt {
    mode: 'failover' | 'balance';
    activeId: string;
    apiKey: string;
    apiKeyName?: string;
    identity: string;
    site?: string;
    balanceLeaseId?: string;
    balanceLeaseExpiresAt?: number;
    balanceAuthorityTerm?: string;
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
    keyedItems: KeyedConfigSetItem[];
    currentSite?: string;
    currentApiKeyName?: string;
}

interface LeaderRotationResult {
    decision: ApiKeyFailoverDecision;
    targetId?: string;
    targetIdentity?: string;
}

interface BalanceLease {
    leaseId: string;
    requestId?: string;
    slot: string;
    balanceKey: string;
    configId: string;
    credentialId: string;
    site?: string;
    ownerInstanceId: string;
    authorityTerm: string;
    expiresAt: number;
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
    private static balanceLeases = new Map<string, BalanceLease>();
    private static pendingBalanceAssignments = new Map<
        string,
        {
            resolve: (payload: ApiKeyBalanceAssignmentResolvedEvent['payload'] | undefined) => void;
            timer: NodeJS.Timeout;
        }
    >();
    private static pendingBalanceFailures = new Map<
        string,
        { resolve: (decision: ApiKeyFailoverDecision) => void; timer: NodeJS.Timeout }
    >();
    private static balanceLeaseRenewalTimers = new Map<string, NodeJS.Timeout>();
    private static balanceAttemptSnapshots = new Map<string, ApiKeyFailoverAttempt>();

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

    static resolveBalanceAssignment(payload: ApiKeyBalanceAssignmentResolvedEvent['payload']): void {
        const pending = this.pendingBalanceAssignments.get(payload.requestId);
        if (!pending) {
            return;
        }
        clearTimeout(pending.timer);
        this.pendingBalanceAssignments.delete(payload.requestId);
        pending.resolve(payload);
    }

    static resolveBalanceFailure(payload: ApiKeyBalanceFailureResolvedEvent['payload']): void {
        const pending = this.pendingBalanceFailures.get(payload.requestId);
        if (!pending) {
            return;
        }
        clearTimeout(pending.timer);
        this.pendingBalanceFailures.delete(payload.requestId);
        pending.resolve({
            handled: payload.handled,
            shouldRetry: payload.shouldRetry,
            switched: payload.switched
        });
    }

    static async handleBalanceFailureReport(
        payload: ApiKeyBalanceFailureReportedEvent['payload'],
        senderInstanceId: string
    ): Promise<ApiKeyBalanceFailureResolvedEvent['payload'] | undefined> {
        const lease = this.balanceLeases.get(payload.leaseId);
        if (
            !LeaderElectionService.isLeader() ||
            !lease ||
            lease.expiresAt <= Date.now() ||
            lease.ownerInstanceId !== senderInstanceId ||
            payload.requestedBy !== senderInstanceId ||
            lease.authorityTerm !== payload.authorityTerm ||
            lease.slot !== payload.slot ||
            lease.balanceKey !== payload.balanceKey ||
            lease.credentialId !== payload.credentialId ||
            payload.consecutiveFailureCount < API_KEY_FAILOVER_ERROR_THRESHOLD ||
            !this.isCurrentLeaderTerm(payload.authorityTerm) ||
            ConfigSetStore.getSwitchMode(payload.slot) !== 'balance'
        ) {
            return undefined;
        }
        const decision = await this.recordBalanceFailure(
            payload.slot,
            payload.balanceKey,
            payload.credentialId,
            payload.consecutiveFailureCount,
            payload.authorityTerm,
            lease.leaseId,
            lease.ownerInstanceId
        );
        return {
            requestId: payload.requestId,
            targetInstanceId: senderInstanceId,
            authorityTerm: payload.authorityTerm,
            handled: decision.handled,
            shouldRetry: decision.shouldRetry,
            switched: decision.switched
        };
    }

    static async handleBalanceAssignmentRequest(
        payload: ApiKeyBalanceAssignmentRequestedEvent['payload'],
        senderInstanceId: string
    ): Promise<ApiKeyBalanceAssignmentResolvedEvent['payload'] | undefined> {
        if (
            !LeaderElectionService.isLeader() ||
            !senderInstanceId ||
            payload.requestedBy !== senderInstanceId ||
            payload.authorityTerm !== LeaderElectionService.getOwnedAuthorityTerm() ||
            ConfigSetStore.getSwitchMode(payload.slot) !== 'balance'
        ) {
            return undefined;
        }
        const allocation = await enqueueConfigSetMutation(async () =>
            (
                ConfigSetStore.getSwitchMode(payload.slot) === 'balance' &&
                payload.authorityTerm === LeaderElectionService.getOwnedAuthorityTerm()
            ) ?
                this.allocateBalanceLease(payload, senderInstanceId)
            :   undefined
        );
        const lease = allocation?.balanceLeaseId ? this.balanceLeases.get(allocation.balanceLeaseId) : undefined;
        if (!allocation || !lease) {
            return {
                requestId: payload.requestId,
                targetInstanceId: senderInstanceId,
                authorityTerm: payload.authorityTerm,
                handled: false
            };
        }
        return {
            requestId: payload.requestId,
            targetInstanceId: senderInstanceId,
            authorityTerm: payload.authorityTerm,
            handled: true,
            leaseId: lease.leaseId,
            configId: lease.configId,
            credentialId: lease.credentialId,
            site: lease.site,
            apiKeyName: allocation.apiKeyName,
            expiresAt: lease.expiresAt
        };
    }

    private static async allocateBalanceLease(
        payload: ApiKeyBalanceAssignmentRequestedEvent['payload'],
        ownerInstanceId: string
    ): Promise<(ApiKeyFailoverAttempt & { balanceLeaseId: string }) | undefined> {
        for (const lease of this.balanceLeases.values()) {
            if (
                lease.requestId === payload.requestId &&
                lease.ownerInstanceId === ownerInstanceId &&
                lease.authorityTerm === payload.authorityTerm &&
                lease.slot === payload.slot &&
                lease.balanceKey === payload.balanceKey &&
                lease.expiresAt > Date.now()
            ) {
                const apiKey = await ConfigSetStore.getApiKey(payload.slot, lease.configId);
                if (!apiKey || this.getCredentialIdentity(apiKey, lease.site) !== lease.credentialId) {
                    return undefined;
                }
                return {
                    mode: 'balance',
                    activeId: lease.configId,
                    apiKey,
                    identity: lease.credentialId,
                    site: lease.site,
                    balanceLeaseId: lease.leaseId,
                    balanceLeaseExpiresAt: lease.expiresAt,
                    balanceAuthorityTerm: lease.authorityTerm
                };
            }
        }
        const attempt = await this.captureLeaderBalanceAttempt(
            payload.slot,
            payload.balanceKey,
            payload.requestId,
            ownerInstanceId
        );
        if (!attempt?.balanceLeaseId) {
            return undefined;
        }
        const lease = this.balanceLeases.get(attempt.balanceLeaseId);
        if (!lease) {
            return undefined;
        }
        const balanceLeaseId = attempt.balanceLeaseId;
        return balanceLeaseId ? { ...attempt, balanceLeaseId } : undefined;
    }

    static renewBalanceLease(leaseId: string, authorityTerm: string): void {
        const lease = this.balanceLeases.get(leaseId);
        if (lease && lease.authorityTerm === authorityTerm && this.isCurrentLeaderTerm(authorityTerm)) {
            lease.expiresAt = Date.now() + BALANCE_LEASE_TTL_MS;
            return;
        }
        if (
            LeaderElectionService.isLeader() ||
            !InterInstanceBus.publishIpcOnly({
                type: 'apiKeyBalanceLeaseRenewed',
                payload: { leaseId, authorityTerm }
            })
        ) {
            return;
        }
    }

    static startBalanceLeaseHeartbeat(attempt: ApiKeyFailoverAttempt): void {
        const leaseId = attempt.balanceLeaseId;
        if (!leaseId || this.balanceLeaseRenewalTimers.has(leaseId)) {
            return;
        }
        const timer = setInterval(() => {
            this.renewBalanceLease(leaseId, attempt.balanceAuthorityTerm ?? '');
        }, BALANCE_LEASE_RENEW_INTERVAL_MS);
        this.balanceLeaseRenewalTimers.set(leaseId, timer);
    }

    private static stopBalanceLeaseHeartbeat(leaseId: string): void {
        const timer = this.balanceLeaseRenewalTimers.get(leaseId);
        if (!timer) {
            return;
        }
        clearInterval(timer);
        this.balanceLeaseRenewalTimers.delete(leaseId);
    }

    static releaseBalanceLease(leaseId: string, authorityTerm?: string): void {
        this.stopBalanceLeaseHeartbeat(leaseId);
        for (const [requestId, attempt] of this.balanceAttemptSnapshots) {
            if (attempt.balanceLeaseId === leaseId) {
                this.balanceAttemptSnapshots.delete(requestId);
            }
        }
        const lease = this.balanceLeases.get(leaseId);
        if (lease && authorityTerm && lease.authorityTerm !== authorityTerm) {
            return;
        }
        if (LeaderElectionService.isLeader()) {
            this.balanceLeases.delete(leaseId);
            return;
        }
        const currentTerm = authorityTerm ?? InterInstanceBus.getAuthorityTerm();
        if (
            !currentTerm ||
            !InterInstanceBus.publishIpcOnly({
                type: 'apiKeyBalanceLeaseReleased',
                payload: { leaseId, authorityTerm: currentTerm }
            })
        ) {
            return;
        }
        this.balanceLeases.delete(leaseId);
    }

    static handleRemoteBalanceLeaseRenewal(
        payload: { leaseId: string; authorityTerm: string },
        senderInstanceId: string
    ): void {
        const lease = this.balanceLeases.get(payload.leaseId);
        if (
            !LeaderElectionService.isLeader() ||
            !lease ||
            lease.ownerInstanceId !== senderInstanceId ||
            lease.authorityTerm !== payload.authorityTerm ||
            !this.isCurrentLeaderTerm(payload.authorityTerm)
        ) {
            return;
        }
        lease.expiresAt = Date.now() + BALANCE_LEASE_TTL_MS;
    }

    static handleRemoteBalanceLeaseRelease(
        payload: { leaseId: string; authorityTerm: string },
        senderInstanceId: string
    ): void {
        const lease = this.balanceLeases.get(payload.leaseId);
        if (
            !LeaderElectionService.isLeader() ||
            !lease ||
            lease.ownerInstanceId !== senderInstanceId ||
            lease.authorityTerm !== payload.authorityTerm
        ) {
            return;
        }
        this.balanceLeases.delete(payload.leaseId);
    }

    static handleBalanceInstanceDisconnected(instanceId: string): void {
        if (!LeaderElectionService.isLeader() || !instanceId) {
            return;
        }
        for (const [leaseId, lease] of this.balanceLeases) {
            if (lease.ownerInstanceId === instanceId) {
                this.balanceLeases.delete(leaseId);
            }
        }
    }

    static handleBalanceAuthorityLost(): void {
        for (const [requestId, pending] of this.pendingBalanceAssignments) {
            clearTimeout(pending.timer);
            pending.resolve(undefined);
            this.pendingBalanceAssignments.delete(requestId);
        }
        for (const [requestId, pending] of this.pendingBalanceFailures) {
            clearTimeout(pending.timer);
            pending.resolve(STOP_DECISION);
            this.pendingBalanceFailures.delete(requestId);
        }
        for (const leaseId of this.balanceLeaseRenewalTimers.keys()) {
            this.stopBalanceLeaseHeartbeat(leaseId);
        }
        this.balanceLeases.clear();
        this.balanceAttemptSnapshots.clear();
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
        if (ConfigSetStore.getSwitchMode(payload.slot) !== 'failover') {
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

    private static async handleBalanceFailure(
        slot: string,
        balanceKey: string,
        attempt: ApiKeyFailoverAttempt,
        consecutiveFailureCount: number
    ): Promise<ApiKeyFailoverDecision> {
        if (consecutiveFailureCount < API_KEY_FAILOVER_ERROR_THRESHOLD) {
            return { handled: true, shouldRetry: true, switched: false };
        }
        const credentialId = this.getCredentialIdentity(attempt.apiKey, attempt.site);
        const authorityTerm = this.getRequestAuthorityTerm();
        if (
            LeaderElectionService.isLeader() &&
            authorityTerm &&
            (!attempt.balanceAuthorityTerm || attempt.balanceAuthorityTerm === authorityTerm)
        ) {
            return await this.recordBalanceFailure(
                slot,
                balanceKey,
                credentialId,
                consecutiveFailureCount,
                authorityTerm
            );
        }
        if (
            !LeaderElectionService.isInitialized() ||
            !authorityTerm ||
            !attempt.balanceLeaseId ||
            !attempt.balanceAuthorityTerm ||
            attempt.balanceAuthorityTerm !== authorityTerm
        ) {
            return STOP_DECISION;
        }
        const requestId = crypto.randomUUID();
        const pendingDecision = new Promise<ApiKeyFailoverDecision>(resolve => {
            const timer = setTimeout(() => {
                this.pendingBalanceFailures.delete(requestId);
                resolve(STOP_DECISION);
            }, BALANCE_COORDINATION_TIMEOUT_MS);
            this.pendingBalanceFailures.set(requestId, { resolve, timer });
        });
        const published = InterInstanceBus.publishIpcOnly({
            type: 'apiKeyBalanceFailureReported',
            payload: {
                requestId,
                requestedBy: LeaderElectionService.getInstanceId(),
                authorityTerm: attempt.balanceAuthorityTerm,
                slot,
                balanceKey,
                credentialId,
                leaseId: attempt.balanceLeaseId ?? '',
                consecutiveFailureCount
            }
        });
        if (!published) {
            this.resolveBalanceFailure({
                requestId,
                targetInstanceId: LeaderElectionService.getInstanceId(),
                authorityTerm,
                handled: false,
                shouldRetry: false,
                switched: false
            });
        }
        return await pendingDecision;
    }

    private static async recordBalanceFailure(
        slot: string,
        balanceKey: string,
        credentialId: string,
        consecutiveFailureCount: number,
        authorityTerm: string,
        leaseId?: string,
        leaseOwnerInstanceId?: string
    ): Promise<ApiKeyFailoverDecision> {
        try {
            const recorded = await enqueueConfigSetMutation(async () => {
                if (
                    ConfigSetStore.getSwitchMode(slot) !== 'balance' ||
                    LeaderElectionService.getOwnedAuthorityTerm() !== authorityTerm
                ) {
                    return false;
                }
                if (leaseId) {
                    const lease = this.balanceLeases.get(leaseId);
                    if (
                        !lease ||
                        lease.ownerInstanceId !== leaseOwnerInstanceId ||
                        lease.authorityTerm !== authorityTerm ||
                        lease.expiresAt <= Date.now()
                    ) {
                        return false;
                    }
                }
                await ConfigSetStore.addBalanceExclusion(slot, balanceKey, credentialId, Date.now(), authorityTerm);
                return LeaderElectionService.getOwnedAuthorityTerm() === authorityTerm;
            });
            if (!recorded) {
                return UNHANDLED_DECISION;
            }
            Logger.warn(
                `[ApiKeyFailover] ${slot}: balance unit "${balanceKey}" excluded credential after ${consecutiveFailureCount} consecutive failures (recovers in 5 min)`
            );
            return { handled: true, shouldRetry: true, switched: true };
        } catch (error) {
            Logger.warn(`[ApiKeyFailover] Failed to record balance exclusion for ${slot}:`, error);
            return STOP_DECISION;
        }
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

    static async captureAttempt(
        slot: string,
        balanceKey?: string,
        allocationRequestId?: string
    ): Promise<ApiKeyFailoverAttempt | undefined> {
        const mode = ConfigSetStore.getSwitchMode(slot);
        if (mode === 'balance' && balanceKey) {
            this.cleanupBalanceAttemptSnapshots();
            if (allocationRequestId) {
                const snapshot = this.balanceAttemptSnapshots.get(allocationRequestId);
                if (
                    snapshot?.balanceLeaseExpiresAt &&
                    snapshot.balanceLeaseExpiresAt > Date.now() &&
                    snapshot.balanceAuthorityTerm === this.getRequestAuthorityTerm()
                ) {
                    return snapshot;
                }
                this.balanceAttemptSnapshots.delete(allocationRequestId);
            }
            if (LeaderElectionService.isInitialized() && !LeaderElectionService.isLeader()) {
                const attempt = await this.captureBalanceAttempt(slot, balanceKey, allocationRequestId);
                if (attempt && allocationRequestId) {
                    this.balanceAttemptSnapshots.set(allocationRequestId, attempt);
                }
                return attempt;
            }
            const attempt = await enqueueConfigSetMutation(async () =>
                this.captureBalanceAttempt(slot, balanceKey, allocationRequestId)
            );
            if (attempt && allocationRequestId) {
                this.balanceAttemptSnapshots.set(allocationRequestId, attempt);
            }
            return attempt;
        }
        if (mode !== 'failover') {
            return undefined;
        }

        return await enqueueConfigSetMutation(async () => {
            if (ConfigSetStore.getSwitchMode(slot) !== 'failover') {
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
                mode: 'failover',
                activeId: pool.current.item.id,
                apiKey: pool.current.apiKey,
                apiKeyName: pool.currentApiKeyName,
                identity: this.getIdentity(pool.current.item.id, pool.current.apiKey, pool.currentSite),
                site: pool.currentSite
            };
        });
    }

    private static async captureBalanceAttempt(
        slot: string,
        balanceKey: string,
        allocationRequestId?: string
    ): Promise<ApiKeyFailoverAttempt | undefined> {
        if (ConfigSetStore.getSwitchMode(slot) !== 'balance') {
            return undefined;
        }
        if (!LeaderElectionService.isInitialized()) {
            return undefined;
        }
        // Agents 窗口仅作为 IPC Follower 参与均衡，必须依赖普通窗口 Leader。
        if (!LeaderElectionService.isLeader()) {
            return await this.requestBalanceAssignment(slot, balanceKey, allocationRequestId);
        }
        return await this.captureLeaderBalanceAttempt(slot, balanceKey, allocationRequestId);
    }

    private static async captureLeaderBalanceAttempt(
        slot: string,
        balanceKey: string,
        allocationRequestId?: string,
        ownerInstanceId = LeaderElectionService.getInstanceId()
    ): Promise<ApiKeyFailoverAttempt | undefined> {
        const operationToken = ConfigSetStore.getApplyOperationToken(slot);
        const authorityTerm = LeaderElectionService.getOwnedAuthorityTerm();
        if (!authorityTerm || ConfigSetStore.getSwitchMode(slot) !== 'balance') {
            return undefined;
        }
        const pool = await this.resolveConfigPool(slot);
        if (!LeaderElectionService.isLeader() || LeaderElectionService.getOwnedAuthorityTerm() !== authorityTerm) {
            return undefined;
        }
        if (
            ConfigSetStore.getApplyOperationToken(slot) !== operationToken ||
            ConfigSetStore.getSwitchMode(slot) !== 'balance'
        ) {
            throw new Error(
                t('Configuration changed while capturing the request snapshot.', '读取请求快照时配置已变化。')
            );
        }
        if (!pool) {
            return undefined;
        }
        const now = Date.now();
        const excludedCredentialIds = new Set(
            ConfigSetStore.getBalanceExclusions(slot)
                .filter(
                    entry =>
                        entry.k === balanceKey &&
                        (entry.authorityTerm === undefined || entry.authorityTerm === authorityTerm) &&
                        now - entry.at < BALANCE_EXCLUSION_TTL_MS
                )
                .map(entry => entry.credentialId)
        );
        const balanceCandidates = new Map<string, KeyedConfigSetItem>();
        for (const candidate of pool.keyedItems) {
            const credentialId = this.getCredentialIdentity(candidate.apiKey, candidate.item.site ?? pool.currentSite);
            // 激活别名只替换组代表，不能改变该凭据组的哈希位置。
            if (!balanceCandidates.has(credentialId) || candidate === pool.current) {
                balanceCandidates.set(credentialId, candidate);
            }
        }
        let candidates = [...balanceCandidates]
            .filter(([credentialId]) => !excludedCredentialIds.has(credentialId))
            .map(([, candidate]) => candidate);
        if (candidates.length === 0) {
            // 全部候选被隔离时回退完整池，隔离仅为 Advisory，不造成可用性空洞
            candidates = [...balanceCandidates.values()];
        }
        const target = this.selectLeastLoadedBalanceCandidate(slot, balanceKey, candidates, pool.currentSite);
        if (!target) {
            return undefined;
        }
        const targetSite = target.item.site ?? pool.currentSite;
        if (!allocationRequestId) {
            return {
                mode: 'balance',
                activeId: target.item.id,
                apiKey: target.apiKey,
                apiKeyName: this.resolveBalanceApiKeyName(pool, target),
                identity: this.getCredentialIdentity(target.apiKey, targetSite),
                site: targetSite
            };
        }
        if (allocationRequestId) {
            const existingLease = [...this.balanceLeases.values()].find(
                lease =>
                    lease.requestId === allocationRequestId &&
                    lease.ownerInstanceId === ownerInstanceId &&
                    lease.authorityTerm === authorityTerm &&
                    lease.slot === slot &&
                    lease.balanceKey === balanceKey &&
                    lease.expiresAt > Date.now()
            );
            if (existingLease) {
                return this.balanceAttemptFromLease(existingLease, pool);
            }
        }
        const lease: BalanceLease = {
            leaseId: crypto.randomUUID(),
            requestId: allocationRequestId,
            slot,
            balanceKey,
            configId: target.item.id,
            credentialId: this.getCredentialIdentity(target.apiKey, targetSite),
            site: targetSite,
            ownerInstanceId,
            authorityTerm,
            expiresAt: Date.now() + BALANCE_LEASE_TTL_MS
        };
        this.cleanupBalanceLeases();
        this.balanceLeases.set(lease.leaseId, lease);
        return {
            mode: 'balance',
            activeId: target.item.id,
            apiKey: target.apiKey,
            apiKeyName: this.resolveBalanceApiKeyName(pool, target),
            identity: this.getCredentialIdentity(target.apiKey, targetSite),
            site: targetSite,
            balanceLeaseId: lease.leaseId,
            balanceLeaseExpiresAt: lease.expiresAt,
            balanceAuthorityTerm: lease.authorityTerm
        };
    }

    private static async requestBalanceAssignment(
        slot: string,
        balanceKey: string,
        allocationRequestId?: string
    ): Promise<ApiKeyFailoverAttempt | undefined> {
        const authorityTerm = InterInstanceBus.getAuthorityTerm();
        if (!authorityTerm || !InterInstanceBus.hasActiveTransport()) {
            return undefined;
        }
        const requestId = allocationRequestId ?? crypto.randomUUID();
        const response = new Promise<ApiKeyBalanceAssignmentResolvedEvent['payload'] | undefined>(resolve => {
            const timer = setTimeout(() => {
                this.pendingBalanceAssignments.delete(requestId);
                resolve(undefined);
            }, BALANCE_COORDINATION_TIMEOUT_MS);
            this.pendingBalanceAssignments.set(requestId, { resolve, timer });
        });
        const published = InterInstanceBus.publishIpcOnly({
            type: 'apiKeyBalanceAssignmentRequested',
            payload: {
                requestId,
                requestedBy: LeaderElectionService.getInstanceId(),
                authorityTerm,
                slot,
                balanceKey
            }
        });
        if (!published) {
            this.resolveBalanceAssignment({
                requestId,
                targetInstanceId: LeaderElectionService.getInstanceId(),
                authorityTerm,
                handled: false
            });
        }
        const assigned = await response;
        if (
            !assigned?.handled ||
            !assigned.configId ||
            !assigned.credentialId ||
            !assigned.leaseId ||
            assigned.authorityTerm !== InterInstanceBus.getAuthorityTerm() ||
            ConfigSetStore.getSwitchMode(slot) !== 'balance' ||
            !InterInstanceBus.hasActiveTransport() ||
            InterInstanceBus.isAuthorityTransitioning() ||
            !assigned.expiresAt ||
            assigned.expiresAt <= Date.now()
        ) {
            if (assigned?.leaseId) {
                this.releaseBalanceLease(assigned.leaseId, assigned.authorityTerm);
            }
            return undefined;
        }
        const apiKey = await ConfigSetStore.getApiKey(slot, assigned.configId);
        const site = assigned.site;
        if (
            ConfigSetStore.getSwitchMode(slot) !== 'balance' ||
            assigned.authorityTerm !== InterInstanceBus.getAuthorityTerm() ||
            !InterInstanceBus.hasActiveTransport() ||
            InterInstanceBus.isAuthorityTransitioning() ||
            !assigned.expiresAt ||
            assigned.expiresAt <= Date.now() ||
            !apiKey ||
            this.getCredentialIdentity(apiKey, site) !== assigned.credentialId
        ) {
            this.releaseBalanceLease(assigned.leaseId, assigned.authorityTerm);
            return undefined;
        }
        return {
            mode: 'balance',
            activeId: assigned.configId,
            apiKey,
            apiKeyName: assigned.apiKeyName,
            identity: assigned.credentialId,
            site,
            balanceLeaseId: assigned.leaseId,
            balanceLeaseExpiresAt: assigned.expiresAt,
            balanceAuthorityTerm: assigned.authorityTerm
        };
    }

    private static async balanceAttemptFromLease(
        lease: BalanceLease,
        pool: ResolvedConfigPool
    ): Promise<ApiKeyFailoverAttempt | undefined> {
        const apiKey = await ConfigSetStore.getApiKey(lease.slot, lease.configId);
        if (!apiKey || this.getCredentialIdentity(apiKey, lease.site) !== lease.credentialId) {
            return undefined;
        }
        const target = pool.keyedItems.find(candidate => candidate.item.id === lease.configId);
        return {
            mode: 'balance',
            activeId: lease.configId,
            apiKey,
            apiKeyName: target ? this.resolveBalanceApiKeyName(pool, target) : undefined,
            identity: lease.credentialId,
            site: lease.site,
            balanceLeaseId: lease.leaseId,
            balanceLeaseExpiresAt: lease.expiresAt,
            balanceAuthorityTerm: lease.authorityTerm
        };
    }

    private static selectLeastLoadedBalanceCandidate(
        slot: string,
        balanceKey: string,
        candidates: KeyedConfigSetItem[],
        currentSite?: string
    ): KeyedConfigSetItem | undefined {
        this.cleanupBalanceLeases();
        const counts = new Map<string, number>();
        for (const lease of this.balanceLeases.values()) {
            if (lease.slot === slot) {
                counts.set(lease.credentialId, (counts.get(lease.credentialId) ?? 0) + 1);
            }
        }
        const min = Math.min(
            ...candidates.map(
                candidate =>
                    counts.get(this.getCredentialIdentity(candidate.apiKey, candidate.item.site ?? currentSite)) ?? 0
            )
        );
        const leastLoaded = candidates.filter(
            candidate =>
                (counts.get(this.getCredentialIdentity(candidate.apiKey, candidate.item.site ?? currentSite)) ?? 0) ===
                min
        );
        return leastLoaded[this.balanceIndex(balanceKey, leastLoaded.length)];
    }

    private static cleanupBalanceLeases(): void {
        const now = Date.now();
        for (const [leaseId, lease] of this.balanceLeases) {
            if (lease.expiresAt <= now) {
                this.balanceLeases.delete(leaseId);
                this.stopBalanceLeaseHeartbeat(leaseId);
            }
        }
    }

    private static cleanupBalanceAttemptSnapshots(): void {
        const now = Date.now();
        for (const [requestId, attempt] of this.balanceAttemptSnapshots) {
            if (!attempt.balanceLeaseExpiresAt || attempt.balanceLeaseExpiresAt <= now) {
                this.balanceAttemptSnapshots.delete(requestId);
            }
        }
    }

    private static balanceIndex(balanceKey: string, length: number): number {
        return parseInt(crypto.createHash('sha256').update(balanceKey).digest('hex').slice(0, 8), 16) % length;
    }

    /** 同凭据出现在多套配置时名称有歧义，与激活配置的名称规则保持一致 */
    private static resolveBalanceApiKeyName(pool: ResolvedConfigPool, target: KeyedConfigSetItem): string | undefined {
        if (target === pool.current) {
            return pool.currentApiKeyName;
        }
        const targetCredential = this.getCredentialIdentity(target.apiKey, target.item.site ?? pool.currentSite);
        const ambiguous = pool.keyedItems.some(
            candidate =>
                candidate !== target &&
                this.getCredentialIdentity(candidate.apiKey, candidate.item.site ?? pool.currentSite) ===
                    targetCredential
        );
        return !ambiguous && target.item.label.trim() ? target.item.label.trim() : undefined;
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
        token?: vscode.CancellationToken,
        balanceKey?: string
    ): Promise<ApiKeyFailoverDecision> {
        if (!attempt || !isApiKeyFailoverError(error)) {
            return UNHANDLED_DECISION;
        }
        if (token?.isCancellationRequested) {
            return STOP_DECISION;
        }
        if (ConfigSetStore.getSwitchMode(slot) !== attempt.mode) {
            return UNHANDLED_DECISION;
        }
        if (attempt.mode === 'balance' && balanceKey) {
            return await this.handleBalanceFailure(slot, balanceKey, attempt, consecutiveFailureCount);
        }
        if (attempt.mode !== 'failover') {
            return UNHANDLED_DECISION;
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
                if (ConfigSetStore.getSwitchMode(slot) !== 'failover' || (canContinue && !canContinue())) {
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
        return candidates.length >= 2 ? { current, candidates, keyedItems, currentSite, currentApiKeyName } : undefined;
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
