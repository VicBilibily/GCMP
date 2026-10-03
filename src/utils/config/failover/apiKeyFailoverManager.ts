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
import { BalanceAffinityCache } from './balanceAffinityCache';
import { InterInstanceBus } from '../../../interInstance';
import { LeaderElectionService } from '../../../status/leaderElectionService';
import type {
    ApiKeyBalanceAssignmentRequestedEvent,
    ApiKeyBalanceAssignmentResolvedEvent,
    ApiKeyBalanceFailureReportedEvent,
    ApiKeyBalanceFailureResolvedEvent
} from '../../../interInstance';
import type { ApiKeyBalanceLeaseHandoff } from '../../../interInstance/eventProtocol';
import {
    BALANCE_HANDOFF_MAX_LEASES,
    BALANCE_HANDOFF_TTL_MS,
    BALANCE_LEASE_TTL_MS,
    isBalanceLeaseHandoffNewer,
    isValidBalanceLeaseHandoff,
    readBalanceLeaseHandoff,
    writeBalanceLeaseHandoff
} from './balanceLeaseHandoffFile';

export const API_KEY_FAILOVER_ERROR_THRESHOLD = 3;
const FAILOVER_COORDINATION_TIMEOUT_MS = 10_000;
const FAILOVER_FAILURE_WINDOW_MS = 10_000;
const FAILOVER_ROTATION_SETTLE_MS = 100;
// 隔离只对当前平衡单元生效，全池被隔离时仍允许回退。
const BALANCE_EXCLUSION_TTL_MS = 5 * 60_000;
const BALANCE_COORDINATION_TIMEOUT_MS = 10_000;
const BALANCE_ABANDONED_ASSIGNMENTS_LIMIT = 1000;
const BALANCE_LEASE_RENEW_INTERVAL_MS = 10_000;
const BALANCE_INSTANCE_DISCONNECT_GRACE_MS = 3_000;

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
    handoffSourceAuthorityTerm?: string;
    expiresAt: number;
}

interface BalanceAttemptSnapshot {
    slot: string;
    attempt: ApiKeyFailoverAttempt;
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
            slot: string;
            authorityTerm: string;
            resolve: (payload: ApiKeyBalanceAssignmentResolvedEvent['payload'] | undefined) => void;
            timer: NodeJS.Timeout;
            cancellation?: vscode.Disposable;
        }
    >();
    private static abandonedBalanceAssignments = new Map<string, number>();
    private static pendingBalanceFailures = new Map<
        string,
        {
            slot: string;
            resolve: (decision: ApiKeyFailoverDecision) => void;
            timer: NodeJS.Timeout;
            cancellation?: vscode.Disposable;
        }
    >();
    private static balanceLeaseRenewalTimers = new Map<string, NodeJS.Timeout>();
    private static activeBalanceLeaseSlots = new Map<string, string | undefined>();
    private static pendingBalanceDisconnectReclaims = new Map<string, NodeJS.Timeout>();
    private static balanceAttemptSnapshots = new Map<string, BalanceAttemptSnapshot>();
    private static pendingBalanceLeaseHandoff:
        | { sourceLeaderId: string; handoff: ApiKeyBalanceLeaseHandoff }
        | undefined;
    private static balanceAuthorityTerm: string | undefined;
    private static balanceAuthorityReady: Promise<void> | undefined;
    private static balancePersistenceTimer: NodeJS.Timeout | undefined;
    private static balanceResigningTerm: string | undefined;
    private static balanceAuthorityGeneration = 0;
    private static balanceModeGenerations = new Map<string, number>();
    private static balanceModeEventTimestamps = new Map<string, number>();

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
        if (pending?.authorityTerm === payload.authorityTerm) {
            this.resolvePendingBalanceAssignment(payload.requestId, payload);
            return;
        }
        const key = JSON.stringify([payload.authorityTerm, payload.requestId]);
        const abandonedUntil = this.abandonedBalanceAssignments.get(key);
        if (abandonedUntil !== undefined && (payload.leaseId || abandonedUntil <= Date.now())) {
            this.abandonedBalanceAssignments.delete(key);
            if (abandonedUntil > Date.now() && payload.leaseId) {
                this.releaseBalanceLease(payload.leaseId, payload.authorityTerm);
            }
        }
    }

    private static resolvePendingBalanceAssignment(
        requestId: string,
        payload?: ApiKeyBalanceAssignmentResolvedEvent['payload']
    ): void {
        const pending = this.pendingBalanceAssignments.get(requestId);
        if (!pending) {
            return;
        }
        this.pendingBalanceAssignments.delete(requestId);
        clearTimeout(pending.timer);
        pending.cancellation?.dispose();
        if (!payload) {
            const now = Date.now();
            for (const [key, expiresAt] of this.abandonedBalanceAssignments) {
                if (expiresAt <= now) {
                    this.abandonedBalanceAssignments.delete(key);
                }
            }
            while (this.abandonedBalanceAssignments.size >= BALANCE_ABANDONED_ASSIGNMENTS_LIMIT) {
                this.abandonedBalanceAssignments.delete(this.abandonedBalanceAssignments.keys().next().value!);
            }
            // 仅跟踪放弃的分配，正常重复回执不能释放仍在使用的租约。
            this.abandonedBalanceAssignments.set(
                JSON.stringify([pending.authorityTerm, requestId]),
                now + BALANCE_COORDINATION_TIMEOUT_MS + BALANCE_LEASE_TTL_MS
            );
        }
        pending.resolve(payload);
    }

    static resolveBalanceFailure(payload: ApiKeyBalanceFailureResolvedEvent['payload']): void {
        this.resolvePendingBalanceFailure(payload.requestId, {
            handled: payload.handled,
            shouldRetry: payload.shouldRetry,
            switched: payload.switched
        });
    }

    private static resolvePendingBalanceFailure(requestId: string, decision: ApiKeyFailoverDecision): void {
        const pending = this.pendingBalanceFailures.get(requestId);
        if (!pending) {
            return;
        }
        this.pendingBalanceFailures.delete(requestId);
        clearTimeout(pending.timer);
        pending.cancellation?.dispose();
        pending.resolve(decision);
    }

    static exportBalanceLeaseHandoff(includeEmpty = false): ApiKeyBalanceLeaseHandoff | undefined {
        const authorityTerm = LeaderElectionService.getOwnedAuthorityTerm();
        if (!authorityTerm) {
            return undefined;
        }
        this.cleanupBalanceLeases();
        const leases = [...this.balanceLeases.values()]
            .filter(lease => lease.authorityTerm === authorityTerm && lease.expiresAt > Date.now())
            .map(lease => ({
                leaseId: lease.leaseId,
                slot: lease.slot,
                balanceKey: lease.balanceKey,
                configId: lease.configId,
                credentialId: lease.credentialId,
                site: lease.site,
                ownerInstanceId: lease.ownerInstanceId,
                expiresAt: lease.expiresAt
            }));
        if ((!includeEmpty && leases.length === 0) || leases.length > BALANCE_HANDOFF_MAX_LEASES) {
            return undefined;
        }
        return {
            sourceAuthorityTerm: authorityTerm,
            capturedAt: Date.now(),
            leases
        };
    }

    private static async persistBalanceLeases(expectedAuthorityTerm?: string): Promise<void> {
        const snapshot = this.exportBalanceLeaseHandoff(true);
        if (
            snapshot &&
            (expectedAuthorityTerm === undefined || snapshot.sourceAuthorityTerm === expectedAuthorityTerm)
        ) {
            try {
                await writeBalanceLeaseHandoff(snapshot);
            } catch (error) {
                Logger.warn('[ApiKeyBalance] Failed to persist lease handoff', error);
            }
        }
    }

    private static scheduleBalanceLeasePersistence(): void {
        if (
            this.deferBalanceLeaseMutation(() => this.scheduleBalanceLeasePersistence()) ||
            this.balancePersistenceTimer
        ) {
            return;
        }
        this.balancePersistenceTimer = setTimeout(() => {
            this.balancePersistenceTimer = undefined;
            void this.persistBalanceLeases();
        }, 50);
    }

    static prepareBalanceLeaseHandoff(): Promise<ApiKeyBalanceLeaseHandoff | undefined> {
        const authorityTerm = LeaderElectionService.getOwnedAuthorityTerm();
        if (!authorityTerm) {
            return Promise.resolve(undefined);
        }
        this.balanceResigningTerm = authorityTerm;
        return enqueueConfigSetMutation(async () => {
            if (LeaderElectionService.getOwnedAuthorityTerm() !== authorityTerm) {
                return undefined;
            }
            await this.persistBalanceLeases();
            return this.exportBalanceLeaseHandoff();
        });
    }

    static stageBalanceLeaseHandoff(
        handoff: ApiKeyBalanceLeaseHandoff,
        senderInstanceId: string,
        targetLeaderId: string | undefined,
        expectedSourceAuthorityTerm: string | undefined,
        eventTimestamp: number
    ): void {
        if (
            !senderInstanceId ||
            senderInstanceId.length > 128 ||
            !isValidBalanceLeaseHandoff(handoff) ||
            (targetLeaderId !== undefined &&
                (typeof targetLeaderId !== 'string' || targetLeaderId.length === 0 || targetLeaderId.length > 128))
        ) {
            return;
        }
        const now = Date.now();
        if (
            !expectedSourceAuthorityTerm ||
            expectedSourceAuthorityTerm !== handoff.sourceAuthorityTerm ||
            !Number.isFinite(eventTimestamp) ||
            now - eventTimestamp > 10_000 ||
            eventTimestamp - now > 1_000 ||
            now - handoff.capturedAt > BALANCE_HANDOFF_TTL_MS ||
            handoff.capturedAt - now > 1_000
        ) {
            return;
        }
        const existing = this.pendingBalanceLeaseHandoff;
        if (existing && isBalanceLeaseHandoffNewer(existing.handoff, handoff)) {
            return;
        }
        this.pendingBalanceLeaseHandoff = {
            sourceLeaderId: senderInstanceId,
            handoff
        };
    }

    static becomeBalanceAuthority(authorityTerm: string | undefined): Promise<void> {
        if (
            !authorityTerm ||
            !LeaderElectionService.isLeader() ||
            LeaderElectionService.getOwnedAuthorityTerm() !== authorityTerm ||
            !ConfigSetStore.isInitialized()
        ) {
            return Promise.resolve();
        }
        if (this.balanceAuthorityTerm === authorityTerm) {
            return this.balanceAuthorityReady ?? Promise.resolve();
        }
        this.handleBalanceAuthorityLost(true);
        this.balanceAuthorityTerm = authorityTerm;
        const authorityGeneration = this.balanceAuthorityGeneration;
        const modeGenerations = new Map(this.balanceModeGenerations);
        const ready = enqueueConfigSetMutation(async () => {
            await this.importBalanceLeaseHandoff(authorityTerm, authorityGeneration, modeGenerations);
            if (
                this.balanceAuthorityGeneration === authorityGeneration &&
                LeaderElectionService.getOwnedAuthorityTerm() === authorityTerm
            ) {
                await this.persistBalanceLeases();
            }
        }).catch(error => Logger.warn('[ApiKeyBalance] Failed to restore lease handoff', error));
        this.balanceAuthorityReady = ready;
        void ready.then(() => {
            if (this.balanceAuthorityReady === ready) {
                this.balanceAuthorityReady = undefined;
            }
        });
        return ready;
    }

    private static async importBalanceLeaseHandoff(
        authorityTerm: string,
        authorityGeneration: number,
        modeGenerations: ReadonlyMap<string, number>
    ): Promise<void> {
        let pending = this.pendingBalanceLeaseHandoff;
        this.pendingBalanceLeaseHandoff = undefined;
        const persisted = await readBalanceLeaseHandoff().catch(error => {
            Logger.warn('[ApiKeyBalance] Failed to read persisted lease handoff', error);
            return undefined;
        });
        if (persisted && (!pending || isBalanceLeaseHandoffNewer(persisted, pending.handoff))) {
            const separator = persisted.sourceAuthorityTerm.lastIndexOf(':');
            if (separator > 0) {
                pending = { sourceLeaderId: persisted.sourceAuthorityTerm.slice(0, separator), handoff: persisted };
            }
        }
        if (
            this.balanceAuthorityGeneration !== authorityGeneration ||
            LeaderElectionService.getOwnedAuthorityTerm() !== authorityTerm
        ) {
            return;
        }
        if (!pending || pending.handoff.sourceAuthorityTerm === authorityTerm) {
            return;
        }
        const now = Date.now();
        if (
            !pending.sourceLeaderId ||
            pending.sourceLeaderId.length > 128 ||
            now - pending.handoff.capturedAt > BALANCE_HANDOFF_TTL_MS ||
            pending.handoff.capturedAt - now > 1_000
        ) {
            return;
        }

        const operationTokens = new Map<string, string | undefined>();
        for (const sourceLease of pending.handoff.leases) {
            if (!operationTokens.has(sourceLease.slot)) {
                operationTokens.set(sourceLease.slot, ConfigSetStore.getApplyOperationToken(sourceLease.slot));
            }
        }
        const imported: BalanceLease[] = [];
        for (const sourceLease of pending.handoff.leases) {
            if (
                sourceLease.expiresAt <= now ||
                (modeGenerations.get(sourceLease.slot) ?? 0) !== this.getBalanceModeGeneration(sourceLease.slot) ||
                ConfigSetStore.getSwitchMode(sourceLease.slot) !== 'balance'
            ) {
                continue;
            }
            const apiKey = await ConfigSetStore.getApiKey(sourceLease.slot, sourceLease.configId);
            if (
                !apiKey ||
                sourceLease.expiresAt <= Date.now() ||
                this.getCredentialIdentity(apiKey, sourceLease.site) !== sourceLease.credentialId ||
                operationTokens.get(sourceLease.slot) !== ConfigSetStore.getApplyOperationToken(sourceLease.slot) ||
                ConfigSetStore.getSwitchMode(sourceLease.slot) !== 'balance'
            ) {
                continue;
            }
            imported.push({
                leaseId: sourceLease.leaseId,
                slot: sourceLease.slot,
                balanceKey: sourceLease.balanceKey,
                configId: sourceLease.configId,
                credentialId: sourceLease.credentialId,
                site: sourceLease.site,
                ownerInstanceId: sourceLease.ownerInstanceId,
                authorityTerm,
                handoffSourceAuthorityTerm: pending.handoff.sourceAuthorityTerm,
                expiresAt: sourceLease.expiresAt
            });
        }
        if (
            LeaderElectionService.isLeader() &&
            LeaderElectionService.getOwnedAuthorityTerm() === authorityTerm &&
            this.balanceAuthorityGeneration === authorityGeneration
        ) {
            for (const lease of imported) {
                if (
                    lease.expiresAt > Date.now() &&
                    (modeGenerations.get(lease.slot) ?? 0) === this.getBalanceModeGeneration(lease.slot) &&
                    operationTokens.get(lease.slot) === ConfigSetStore.getApplyOperationToken(lease.slot) &&
                    ConfigSetStore.getSwitchMode(lease.slot) === 'balance'
                ) {
                    this.balanceLeases.set(lease.leaseId, lease);
                }
            }
        }
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
            this.balanceResigningTerm === payload.authorityTerm ||
            ConfigSetStore.getSwitchMode(payload.slot) !== 'balance'
        ) {
            return undefined;
        }
        await this.becomeBalanceAuthority(payload.authorityTerm);
        const allocation = await enqueueConfigSetMutation(async () =>
            (
                ConfigSetStore.getSwitchMode(payload.slot) === 'balance' &&
                this.balanceResigningTerm !== payload.authorityTerm &&
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
                const operationToken = ConfigSetStore.getApplyOperationToken(payload.slot);
                const pool = await this.resolveConfigPool(payload.slot);
                if (!pool) {
                    return undefined;
                }
                return await this.balanceAttemptFromLease(lease, pool, operationToken);
            }
        }
        const attempt = await this.captureLeaderBalanceAttempt(
            payload.slot,
            payload.balanceKey,
            payload.requestId,
            ownerInstanceId,
            payload.preferredCredentialId
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
        if (this.deferBalanceLeaseMutation(() => this.renewBalanceLease(leaseId, authorityTerm))) {
            return;
        }
        const lease = this.balanceLeases.get(leaseId);
        if (lease && lease.authorityTerm === authorityTerm && this.isCurrentLeaderTerm(authorityTerm)) {
            const now = Date.now();
            if (lease.expiresAt <= now) {
                this.balanceLeases.delete(leaseId);
                this.stopBalanceLeaseHeartbeat(leaseId);
                return;
            }
            lease.expiresAt = now + BALANCE_LEASE_TTL_MS;
            this.scheduleBalanceLeasePersistence();
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

    static startBalanceLeaseHeartbeat(attempt: ApiKeyFailoverAttempt, slot?: string): void {
        const leaseId = attempt.balanceLeaseId;
        if (!leaseId || this.balanceLeaseRenewalTimers.has(leaseId)) {
            return;
        }
        slot ??= [...this.balanceAttemptSnapshots.values()].find(
            snapshot => snapshot.attempt.balanceLeaseId === leaseId
        )?.slot;
        this.activeBalanceLeaseSlots.set(leaseId, slot);
        const timer = setInterval(() => {
            const authorityTerm =
                LeaderElectionService.isLeader() ?
                    LeaderElectionService.getOwnedAuthorityTerm()
                :   InterInstanceBus.getAuthorityTerm();
            if (authorityTerm) {
                attempt.balanceAuthorityTerm = authorityTerm;
                this.renewBalanceLease(leaseId, authorityTerm);
            }
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
        this.activeBalanceLeaseSlots.delete(leaseId);
    }

    static releaseBalanceLease(leaseId: string, authorityTerm?: string): void {
        const ownedAuthorityTerm = LeaderElectionService.getOwnedAuthorityTerm();
        if (
            authorityTerm &&
            LeaderElectionService.isLeader() &&
            ownedAuthorityTerm &&
            authorityTerm !== ownedAuthorityTerm
        ) {
            return;
        }
        this.stopBalanceLeaseHeartbeat(leaseId);
        if (this.deferBalanceLeaseMutation(() => this.releaseBalanceLease(leaseId, authorityTerm))) {
            return;
        }
        for (const [requestId, attempt] of this.balanceAttemptSnapshots) {
            if (attempt.attempt.balanceLeaseId === leaseId) {
                this.balanceAttemptSnapshots.delete(requestId);
            }
        }
        const lease = this.balanceLeases.get(leaseId);
        if (lease && authorityTerm && lease.authorityTerm !== authorityTerm) {
            return;
        }
        if (LeaderElectionService.isLeader()) {
            this.balanceLeases.delete(leaseId);
            void this.persistBalanceLeases();
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
        if (this.deferBalanceLeaseMutation(() => this.handleRemoteBalanceLeaseRenewal(payload, senderInstanceId))) {
            return;
        }
        const lease = this.balanceLeases.get(payload.leaseId);
        if (
            !LeaderElectionService.isLeader() ||
            !lease ||
            !this.isCurrentLeaderTerm(lease.authorityTerm) ||
            lease.ownerInstanceId !== senderInstanceId ||
            (lease.authorityTerm !== payload.authorityTerm &&
                lease.handoffSourceAuthorityTerm !== payload.authorityTerm) ||
            (lease.authorityTerm !== payload.authorityTerm && lease.expiresAt <= Date.now()) ||
            (lease.authorityTerm === payload.authorityTerm && !this.isCurrentLeaderTerm(payload.authorityTerm))
        ) {
            return;
        }
        const now = Date.now();
        if (lease.expiresAt <= now) {
            this.balanceLeases.delete(payload.leaseId);
            return;
        }
        lease.expiresAt =
            lease.authorityTerm === payload.authorityTerm ?
                now + BALANCE_LEASE_TTL_MS
            :   Math.min(lease.expiresAt, now + BALANCE_LEASE_TTL_MS);
        this.scheduleBalanceLeasePersistence();
    }

    static handleRemoteBalanceLeaseRelease(
        payload: { leaseId: string; authorityTerm: string },
        senderInstanceId: string
    ): void {
        if (this.deferBalanceLeaseMutation(() => this.handleRemoteBalanceLeaseRelease(payload, senderInstanceId))) {
            return;
        }
        const lease = this.balanceLeases.get(payload.leaseId);
        if (
            !LeaderElectionService.isLeader() ||
            !lease ||
            !this.isCurrentLeaderTerm(lease.authorityTerm) ||
            lease.ownerInstanceId !== senderInstanceId ||
            lease.authorityTerm !== payload.authorityTerm
        ) {
            return;
        }
        this.balanceLeases.delete(payload.leaseId);
        void this.persistBalanceLeases();
    }

    private static deferBalanceLeaseMutation(task: () => void): boolean {
        const ready = this.balanceAuthorityReady;
        if (!ready) {
            return false;
        }
        const generation = this.balanceAuthorityGeneration;
        void ready.then(() => {
            if (this.balanceAuthorityGeneration === generation) {
                task();
            }
        });
        return true;
    }

    static handleBalanceInstanceDisconnected(instanceId: string): void {
        if (!LeaderElectionService.isLeader() || !instanceId) {
            return;
        }
        if (InterInstanceBus.getConnectedFollowerIds().includes(instanceId)) {
            this.cancelPendingBalanceDisconnectReclaim(instanceId);
            return;
        }
        if (this.pendingBalanceDisconnectReclaims.has(instanceId)) {
            return;
        }
        const timer = setTimeout(() => {
            this.pendingBalanceDisconnectReclaims.delete(instanceId);
            this.reclaimDisconnectedBalanceInstance(instanceId);
        }, BALANCE_INSTANCE_DISCONNECT_GRACE_MS);
        this.pendingBalanceDisconnectReclaims.set(instanceId, timer);
    }

    static handleBalanceInstanceReconnected(instanceId: string): void {
        if (!instanceId) {
            return;
        }
        this.cancelPendingBalanceDisconnectReclaim(instanceId);
    }

    static handleBalanceAuthorityLost(preserveActiveAttempts = false): void {
        this.balanceAuthorityGeneration++;
        if (this.balancePersistenceTimer) {
            clearTimeout(this.balancePersistenceTimer);
            this.balancePersistenceTimer = undefined;
        }
        for (const requestId of this.pendingBalanceAssignments.keys()) {
            this.resolvePendingBalanceAssignment(requestId);
        }
        for (const requestId of this.pendingBalanceFailures.keys()) {
            this.resolvePendingBalanceFailure(requestId, STOP_DECISION);
        }
        if (!preserveActiveAttempts) {
            this.pendingBalanceLeaseHandoff = undefined;
            for (const leaseId of this.balanceLeaseRenewalTimers.keys()) {
                this.stopBalanceLeaseHeartbeat(leaseId);
            }
        }
        this.clearPendingBalanceDisconnectReclaims();
        this.balanceLeases.clear();
        this.balanceAttemptSnapshots.clear();
        this.balanceAuthorityTerm = undefined;
        this.balanceAuthorityReady = undefined;
        this.balanceResigningTerm = undefined;
        this.balanceModeGenerations.clear();
        this.balanceModeEventTimestamps.clear();
    }

    static handleBalanceModeChanged(slot: string, eventTimestamp?: number): void {
        const timestamp = eventTimestamp ?? Date.now();
        const previousTimestamp = this.balanceModeEventTimestamps.get(slot);
        if (eventTimestamp !== undefined && previousTimestamp !== undefined && eventTimestamp <= previousTimestamp) {
            return;
        }
        this.balanceModeEventTimestamps.set(slot, timestamp);
        this.balanceModeGenerations.set(slot, this.getBalanceModeGeneration(slot) + 1);
        BalanceAffinityCache.instance.clear(slot);
        for (const [leaseId, activeSlot] of this.activeBalanceLeaseSlots) {
            if (activeSlot === slot) {
                this.stopBalanceLeaseHeartbeat(leaseId);
            }
        }
        for (const [requestId, pending] of this.pendingBalanceAssignments) {
            if (pending.slot !== slot) {
                continue;
            }
            this.resolvePendingBalanceAssignment(requestId);
        }
        for (const [requestId, pending] of this.pendingBalanceFailures) {
            if (pending.slot !== slot) {
                continue;
            }
            this.resolvePendingBalanceFailure(requestId, STOP_DECISION);
        }
        for (const [leaseId, lease] of this.balanceLeases) {
            if (lease.slot !== slot) {
                continue;
            }
            this.stopBalanceLeaseHeartbeat(leaseId);
            this.balanceLeases.delete(leaseId);
        }
        for (const [requestId, snapshot] of this.balanceAttemptSnapshots) {
            if (snapshot.slot === slot) {
                this.balanceAttemptSnapshots.delete(requestId);
            }
        }
        const pendingHandoff = this.pendingBalanceLeaseHandoff;
        if (pendingHandoff) {
            const leases = pendingHandoff.handoff.leases.filter(lease => lease.slot !== slot);
            this.pendingBalanceLeaseHandoff =
                leases.length > 0 ? { ...pendingHandoff, handoff: { ...pendingHandoff.handoff, leases } } : undefined;
        }
        this.scheduleBalanceLeasePersistence();
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
        consecutiveFailureCount: number,
        token?: vscode.CancellationToken
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
                this.resolvePendingBalanceFailure(requestId, STOP_DECISION);
            }, BALANCE_COORDINATION_TIMEOUT_MS);
            this.pendingBalanceFailures.set(requestId, { slot, resolve, timer });
        });
        const cancellation = token?.onCancellationRequested(() => {
            this.resolvePendingBalanceFailure(requestId, STOP_DECISION);
        });
        const pending = this.pendingBalanceFailures.get(requestId);
        if (pending) {
            pending.cancellation = cancellation;
        } else {
            cancellation?.dispose();
        }
        if (token?.isCancellationRequested) {
            this.resolvePendingBalanceFailure(requestId, STOP_DECISION);
            return await pendingDecision;
        }
        try {
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
                this.resolvePendingBalanceFailure(requestId, UNHANDLED_DECISION);
            }
            return await pendingDecision;
        } finally {
            this.resolvePendingBalanceFailure(requestId, STOP_DECISION);
        }
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
            this.handleBalanceModeChanged(slot);
            return true;
        });
    }

    static async captureAttempt(
        slot: string,
        balanceKey?: string,
        allocationRequestId?: string,
        preferredCredentialId?: string,
        token?: vscode.CancellationToken
    ): Promise<ApiKeyFailoverAttempt | undefined> {
        if (token?.isCancellationRequested) {
            return undefined;
        }
        const mode = ConfigSetStore.getSwitchMode(slot);
        if (mode === 'balance' && balanceKey) {
            const ownedAuthorityTerm = LeaderElectionService.getOwnedAuthorityTerm();
            if (ownedAuthorityTerm && this.balanceResigningTerm === ownedAuthorityTerm) {
                return undefined;
            }
            if (LeaderElectionService.isLeader()) {
                await this.becomeBalanceAuthority(ownedAuthorityTerm);
            }
            if (token?.isCancellationRequested) {
                return undefined;
            }
            this.cleanupBalanceAttemptSnapshots();
            if (allocationRequestId) {
                const snapshot = this.balanceAttemptSnapshots.get(allocationRequestId);
                if (
                    snapshot?.slot === slot &&
                    snapshot.attempt.balanceLeaseId &&
                    snapshot.attempt.balanceLeaseExpiresAt &&
                    snapshot.attempt.balanceLeaseExpiresAt > Date.now() &&
                    snapshot.attempt.balanceAuthorityTerm === this.getRequestAuthorityTerm() &&
                    (LeaderElectionService.isLeader() ||
                        (!InterInstanceBus.isAuthorityTransitioning() && InterInstanceBus.hasActiveTransport()))
                ) {
                    const authorityGeneration = this.balanceAuthorityGeneration;
                    const modeGeneration = this.getBalanceModeGeneration(slot);
                    const operationToken = ConfigSetStore.getApplyOperationToken(slot);
                    const apiKey = await ConfigSetStore.getApiKey(slot, snapshot.attempt.activeId);
                    if (token?.isCancellationRequested) {
                        this.releaseBalanceLease(
                            snapshot.attempt.balanceLeaseId,
                            snapshot.attempt.balanceAuthorityTerm
                        );
                        return undefined;
                    }
                    if (
                        authorityGeneration !== this.balanceAuthorityGeneration ||
                        modeGeneration !== this.getBalanceModeGeneration(slot) ||
                        operationToken !== ConfigSetStore.getApplyOperationToken(slot) ||
                        this.balanceAttemptSnapshots.get(allocationRequestId) !== snapshot ||
                        ConfigSetStore.getSwitchMode(slot) !== 'balance' ||
                        !LeaderElectionService.isInitialized() ||
                        snapshot.attempt.balanceLeaseExpiresAt <= Date.now() ||
                        snapshot.attempt.balanceAuthorityTerm !== this.getRequestAuthorityTerm() ||
                        snapshot.attempt.balanceAuthorityTerm === this.balanceResigningTerm ||
                        (!LeaderElectionService.isLeader() &&
                            (InterInstanceBus.isAuthorityTransitioning() || !InterInstanceBus.hasActiveTransport()))
                    ) {
                        return undefined;
                    }
                    const item = ConfigSetStore.list(slot).find(item => item.id === snapshot.attempt.activeId);
                    const siteProvider = getSiteOwnerProvider(slot);
                    const site = item?.site ?? (siteProvider ? readCurrentSite(siteProvider) : undefined);
                    if (item && apiKey && this.getCredentialIdentity(apiKey, site) === snapshot.attempt.identity) {
                        return snapshot.attempt;
                    }
                    this.releaseBalanceLease(snapshot.attempt.balanceLeaseId, snapshot.attempt.balanceAuthorityTerm);
                }
                this.balanceAttemptSnapshots.delete(allocationRequestId);
            }
            const attempt =
                LeaderElectionService.isInitialized() && !LeaderElectionService.isLeader() ?
                    await this.captureBalanceAttempt(
                        slot,
                        balanceKey,
                        allocationRequestId,
                        preferredCredentialId,
                        token
                    )
                :   await enqueueConfigSetMutation(async () =>
                        this.captureBalanceAttempt(slot, balanceKey, allocationRequestId, preferredCredentialId, token)
                    );
            if (token?.isCancellationRequested) {
                if (attempt?.balanceLeaseId) {
                    this.releaseBalanceLease(attempt.balanceLeaseId, attempt.balanceAuthorityTerm);
                }
                return undefined;
            }
            if (attempt && allocationRequestId) {
                this.balanceAttemptSnapshots.set(allocationRequestId, { slot, attempt });
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
        allocationRequestId?: string,
        preferredCredentialId?: string,
        token?: vscode.CancellationToken
    ): Promise<ApiKeyFailoverAttempt | undefined> {
        if (token?.isCancellationRequested || ConfigSetStore.getSwitchMode(slot) !== 'balance') {
            return undefined;
        }
        if (!LeaderElectionService.isInitialized()) {
            return undefined;
        }
        // Agents 窗口仅作为 IPC Follower 参与均衡，必须依赖普通窗口 Leader。
        if (!LeaderElectionService.isLeader()) {
            return await this.requestBalanceAssignment(
                slot,
                balanceKey,
                allocationRequestId,
                preferredCredentialId,
                token
            );
        }
        return await this.captureLeaderBalanceAttempt(
            slot,
            balanceKey,
            allocationRequestId,
            undefined,
            preferredCredentialId
        );
    }

    private static async captureLeaderBalanceAttempt(
        slot: string,
        balanceKey: string,
        allocationRequestId?: string,
        ownerInstanceId = LeaderElectionService.getInstanceId(),
        preferredCredentialId?: string
    ): Promise<ApiKeyFailoverAttempt | undefined> {
        const operationToken = ConfigSetStore.getApplyOperationToken(slot);
        const authorityTerm = LeaderElectionService.getOwnedAuthorityTerm();
        if (
            !authorityTerm ||
            this.balanceResigningTerm === authorityTerm ||
            ConfigSetStore.getSwitchMode(slot) !== 'balance'
        ) {
            return undefined;
        }
        const pool = await this.resolveConfigPool(slot);
        if (
            !LeaderElectionService.isLeader() ||
            this.balanceResigningTerm === authorityTerm ||
            LeaderElectionService.getOwnedAuthorityTerm() !== authorityTerm
        ) {
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
        const target =
            candidates.find(
                candidate =>
                    this.getCredentialIdentity(candidate.apiKey, candidate.item.site ?? pool.currentSite) ===
                    preferredCredentialId
            ) ?? this.selectLeastLoadedBalanceCandidate(slot, balanceKey, candidates, pool.currentSite);
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
                return this.balanceAttemptFromLease(existingLease, pool, operationToken);
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
        await this.persistBalanceLeases(authorityTerm);
        if (
            !this.isCurrentLeaderTerm(authorityTerm) ||
            this.balanceResigningTerm === authorityTerm ||
            ConfigSetStore.getApplyOperationToken(slot) !== operationToken ||
            lease.expiresAt <= Date.now() ||
            this.balanceLeases.get(lease.leaseId) !== lease ||
            ConfigSetStore.getSwitchMode(slot) !== 'balance'
        ) {
            if (this.balanceLeases.get(lease.leaseId) === lease) {
                this.balanceLeases.delete(lease.leaseId);
                await this.persistBalanceLeases(authorityTerm);
            }
            return undefined;
        }
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
        allocationRequestId?: string,
        preferredCredentialId?: string,
        token?: vscode.CancellationToken
    ): Promise<ApiKeyFailoverAttempt | undefined> {
        const authorityTerm = InterInstanceBus.getAuthorityTerm();
        if (token?.isCancellationRequested || !authorityTerm || !InterInstanceBus.hasActiveTransport()) {
            return undefined;
        }
        const authorityGeneration = this.balanceAuthorityGeneration;
        const modeGeneration = this.getBalanceModeGeneration(slot);
        const operationToken = ConfigSetStore.getApplyOperationToken(slot);
        const requestId = allocationRequestId ?? crypto.randomUUID();
        this.abandonedBalanceAssignments.delete(JSON.stringify([authorityTerm, requestId]));
        const response = new Promise<ApiKeyBalanceAssignmentResolvedEvent['payload'] | undefined>(resolve => {
            const timer = setTimeout(() => {
                this.resolvePendingBalanceAssignment(requestId);
            }, BALANCE_COORDINATION_TIMEOUT_MS);
            this.pendingBalanceAssignments.set(requestId, { slot, authorityTerm, resolve, timer });
        });
        const cancellation = token?.onCancellationRequested(() => {
            this.resolvePendingBalanceAssignment(requestId);
        });
        const pending = this.pendingBalanceAssignments.get(requestId);
        if (pending) {
            pending.cancellation = cancellation;
        } else {
            cancellation?.dispose();
        }
        let retained = false;
        try {
            if (token?.isCancellationRequested) {
                return undefined;
            }
            const published = InterInstanceBus.publishIpcOnly({
                type: 'apiKeyBalanceAssignmentRequested',
                payload: {
                    requestId,
                    requestedBy: LeaderElectionService.getInstanceId(),
                    authorityTerm,
                    slot,
                    balanceKey,
                    ...(preferredCredentialId ? { preferredCredentialId } : {})
                }
            });
            if (!published) {
                this.resolvePendingBalanceAssignment(requestId);
            }
            const assigned = await response;
            if (
                token?.isCancellationRequested ||
                !assigned?.handled ||
                !assigned.configId ||
                !assigned.credentialId ||
                !assigned.leaseId ||
                authorityGeneration !== this.balanceAuthorityGeneration ||
                modeGeneration !== this.getBalanceModeGeneration(slot) ||
                operationToken !== ConfigSetStore.getApplyOperationToken(slot) ||
                assigned.authorityTerm !== InterInstanceBus.getAuthorityTerm() ||
                ConfigSetStore.getSwitchMode(slot) !== 'balance' ||
                !InterInstanceBus.hasActiveTransport() ||
                InterInstanceBus.isAuthorityTransitioning() ||
                !assigned.expiresAt ||
                assigned.expiresAt <= Date.now()
            ) {
                return undefined;
            }
            const apiKey = await ConfigSetStore.getApiKey(slot, assigned.configId);
            const site = assigned.site;
            if (
                token?.isCancellationRequested ||
                authorityGeneration !== this.balanceAuthorityGeneration ||
                modeGeneration !== this.getBalanceModeGeneration(slot) ||
                operationToken !== ConfigSetStore.getApplyOperationToken(slot) ||
                ConfigSetStore.getSwitchMode(slot) !== 'balance' ||
                assigned.authorityTerm !== InterInstanceBus.getAuthorityTerm() ||
                !InterInstanceBus.hasActiveTransport() ||
                InterInstanceBus.isAuthorityTransitioning() ||
                !assigned.expiresAt ||
                assigned.expiresAt <= Date.now() ||
                !apiKey ||
                this.getCredentialIdentity(apiKey, site) !== assigned.credentialId
            ) {
                return undefined;
            }
            retained = true;
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
        } finally {
            this.resolvePendingBalanceAssignment(requestId);
            if (!retained) {
                const assigned = await response;
                if (assigned?.leaseId) {
                    this.releaseBalanceLease(assigned.leaseId, assigned.authorityTerm);
                }
            }
        }
    }

    private static async balanceAttemptFromLease(
        lease: BalanceLease,
        pool: ResolvedConfigPool,
        operationToken: string | undefined
    ): Promise<(ApiKeyFailoverAttempt & { balanceLeaseId: string }) | undefined> {
        const apiKey = await ConfigSetStore.getApiKey(lease.slot, lease.configId);
        if (
            !this.isCurrentLeaderTerm(lease.authorityTerm) ||
            this.balanceResigningTerm === lease.authorityTerm ||
            ConfigSetStore.getApplyOperationToken(lease.slot) !== operationToken ||
            ConfigSetStore.getSwitchMode(lease.slot) !== 'balance' ||
            lease.expiresAt <= Date.now() ||
            this.balanceLeases.get(lease.leaseId) !== lease ||
            !apiKey ||
            this.getCredentialIdentity(apiKey, lease.site) !== lease.credentialId
        ) {
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

    private static getBalanceModeGeneration(slot: string): number {
        return this.balanceModeGenerations.get(slot) ?? 0;
    }

    private static reclaimDisconnectedBalanceInstance(instanceId: string): void {
        if (this.deferBalanceLeaseMutation(() => this.reclaimDisconnectedBalanceInstance(instanceId))) {
            return;
        }
        if (
            !LeaderElectionService.isLeader() ||
            !instanceId ||
            InterInstanceBus.getConnectedFollowerIds().includes(instanceId)
        ) {
            return;
        }
        for (const [leaseId, lease] of this.balanceLeases) {
            if (lease.ownerInstanceId !== instanceId) {
                continue;
            }
            this.stopBalanceLeaseHeartbeat(leaseId);
            this.balanceLeases.delete(leaseId);
            for (const [requestId, snapshot] of this.balanceAttemptSnapshots) {
                if (snapshot.attempt.balanceLeaseId === leaseId) {
                    this.balanceAttemptSnapshots.delete(requestId);
                }
            }
        }
        void this.persistBalanceLeases();
    }

    private static cancelPendingBalanceDisconnectReclaim(instanceId: string): void {
        const timer = this.pendingBalanceDisconnectReclaims.get(instanceId);
        if (!timer) {
            return;
        }
        clearTimeout(timer);
        this.pendingBalanceDisconnectReclaims.delete(instanceId);
    }

    private static clearPendingBalanceDisconnectReclaims(): void {
        for (const timer of this.pendingBalanceDisconnectReclaims.values()) {
            clearTimeout(timer);
        }
        this.pendingBalanceDisconnectReclaims.clear();
    }

    private static cleanupBalanceAttemptSnapshots(): void {
        const now = Date.now();
        for (const [requestId, attempt] of this.balanceAttemptSnapshots) {
            if (!attempt.attempt.balanceLeaseExpiresAt || attempt.attempt.balanceLeaseExpiresAt <= now) {
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
            return await this.handleBalanceFailure(slot, balanceKey, attempt, consecutiveFailureCount, token);
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
