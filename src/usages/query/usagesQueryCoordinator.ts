import { randomUUID } from 'node:crypto';
import type * as vscode from 'vscode';
import { InterInstanceBus, type UsagesQueryCompletedEvent, type UsagesQueryRequestedEvent } from '../../interInstance';
import { LeaderElectionService } from '../../status/leaderElectionService';
import { StatusLogger } from '../../utils/runtime/statusLogger';
import type { TokenRequestLog } from '../fileLogger/types';
import type { UsagesPendingRecord, UsagesQuery, UsagesQueryResult, UsagesQueryResultFor } from './types';
import { isUsagesQueryResult, normalizeUsagesPendingRecords, normalizeUsagesQuery } from './validation';

const MAX_REMOTE_QUERIES_PER_INSTANCE = 4;

type QueryExecutor = (
    query: UsagesQuery,
    pendingRecords: readonly UsagesPendingRecord[],
    isRemote: boolean
) => Promise<UsagesQueryResult>;

interface PendingQuery {
    query: UsagesQuery;
    authorityTerm: string;
    resolve: (result: UsagesQueryResult | undefined) => void;
    timer: ReturnType<typeof setTimeout>;
}

const QUERY_ERRORS = new Set(['invalid-request', 'query-failed', 'response-too-large', 'busy']);

function isRecord(value: unknown): value is Record<string, unknown> {
    return !!value && typeof value === 'object' && !Array.isArray(value);
}

function getAuthorityInstanceId(authorityTerm: string): string | undefined {
    const separator = authorityTerm.lastIndexOf(':');
    return separator > 0 ? authorityTerm.slice(0, separator) : undefined;
}

export class UsagesQueryCoordinator implements vscode.Disposable {
    private static readonly QUERY_TIMEOUT_MS = 15_000;
    private readonly pendingQueries = new Map<string, PendingQuery>();
    private readonly disposables: vscode.Disposable[];
    private readonly executionChains = new Map<string, Promise<void>>();
    private readonly remoteQueryCounts = new Map<string, number>();

    constructor(
        private readonly executeQuery: QueryExecutor,
        private readonly onRemoteQuerySucceeded?: () => void,
        private readonly canUseRemoteQuery: (
            query: UsagesQuery,
            pendingRecords?: readonly UsagesPendingRecord[]
        ) => boolean = () => true
    ) {
        this.disposables = [
            InterInstanceBus.subscribe<UsagesQueryRequestedEvent>('usagesQueryRequested', event => {
                void this.handleRequested(event).catch(error =>
                    StatusLogger.warn('[UsagesQueryCoordinator] Failed to handle query request', error)
                );
            }),
            InterInstanceBus.subscribe<UsagesQueryCompletedEvent>('usagesQueryCompleted', event => {
                this.handleCompleted(event);
            }),
            InterInstanceBus.onAuthorityChanged(() => this.cancelPendingQueries())
        ];
    }

    async run<Query extends UsagesQuery>(
        query: Query,
        pendingRecords: readonly TokenRequestLog[] = []
    ): Promise<UsagesQueryResultFor<Query>> {
        const normalized = normalizeUsagesQuery(query);
        if (!normalized) {
            throw new Error('Invalid usages query');
        }

        if (!LeaderElectionService.isLeader() && InterInstanceBus.hasCompatibleUsagesQueryTransport()) {
            const pending = normalizeUsagesPendingRecords(pendingRecords);
            const remote =
                pending && this.canUseRemoteQuery(normalized, pending) ?
                    await this.requestRemote(normalized, pending)
                :   undefined;
            if (remote?.kind === normalized.kind && this.canUseRemoteQuery(normalized, pending)) {
                this.onRemoteQuerySucceeded?.();
                return remote.value as UsagesQueryResultFor<Query>;
            }
            StatusLogger.debug(`[UsagesQueryCoordinator] Falling back to local ${normalized.kind} query`);
        }

        const local = await this.executeSerialized(
            normalized,
            [],
            false,
            `local:${LeaderElectionService.getInstanceId()}`
        );
        if (local.kind !== normalized.kind) {
            throw new Error(`Usages query result kind mismatch: expected ${normalized.kind}, got ${local.kind}`);
        }
        return local.value as UsagesQueryResultFor<Query>;
    }

    dispose(): void {
        this.cancelPendingQueries();
        for (const disposable of this.disposables) {
            disposable.dispose();
        }
        this.disposables.length = 0;
        this.executionChains.clear();
        this.remoteQueryCounts.clear();
    }

    private requestRemote(
        query: UsagesQuery,
        pendingRecords: UsagesPendingRecord[]
    ): Promise<UsagesQueryResult | undefined> {
        const authorityTerm = InterInstanceBus.getAuthorityTerm();
        if (!authorityTerm) {
            return Promise.resolve(undefined);
        }

        const requestId = randomUUID();
        return new Promise(resolve => {
            const timer = setTimeout(() => {
                this.pendingQueries.delete(requestId);
                resolve(undefined);
            }, UsagesQueryCoordinator.QUERY_TIMEOUT_MS);
            this.pendingQueries.set(requestId, { query, authorityTerm, resolve, timer });

            const sent = InterInstanceBus.publishIpcOnly({
                type: 'usagesQueryRequested',
                payload: {
                    requestId,
                    requestedBy: LeaderElectionService.getInstanceId(),
                    authorityTerm,
                    query,
                    pendingRecords
                }
            });
            if (!sent) {
                clearTimeout(timer);
                this.pendingQueries.delete(requestId);
                resolve(undefined);
            }
        });
    }

    private async handleRequested(event: UsagesQueryRequestedEvent): Promise<void> {
        if (!LeaderElectionService.isLeader()) {
            return;
        }

        const payload = event.payload as unknown;
        if (!payload || typeof payload !== 'object') {
            return;
        }
        const {
            requestId,
            requestedBy,
            authorityTerm,
            query: untrustedQuery,
            pendingRecords: untrustedPendingRecords
        } = payload as Partial<UsagesQueryRequestedEvent['payload']>;
        const currentAuthorityTerm = InterInstanceBus.getAuthorityTerm();
        const query = normalizeUsagesQuery(untrustedQuery as UsagesQuery);
        const requestIdentityValid =
            typeof requestedBy === 'string' &&
            requestedBy.length > 0 &&
            requestedBy.length <= 128 &&
            requestedBy === event.senderInstanceId;
        if (!requestIdentityValid) {
            return;
        }
        const pendingRecords = normalizeUsagesPendingRecords(untrustedPendingRecords);
        if (
            !query ||
            !pendingRecords ||
            typeof requestId !== 'string' ||
            !requestId ||
            requestId.length > 128 ||
            typeof authorityTerm !== 'string' ||
            !currentAuthorityTerm ||
            authorityTerm !== currentAuthorityTerm
        ) {
            if (typeof requestId === 'string' && requestId.length > 0 && requestId.length <= 128) {
                this.sendError(event.senderInstanceId, requestId, currentAuthorityTerm, 'invalid-request');
            }
            return;
        }

        const activeRemoteQueries = this.remoteQueryCounts.get(requestedBy) ?? 0;
        if (activeRemoteQueries >= MAX_REMOTE_QUERIES_PER_INSTANCE) {
            this.sendError(requestedBy, requestId, currentAuthorityTerm, 'busy');
            return;
        }
        this.remoteQueryCounts.set(requestedBy, activeRemoteQueries + 1);

        try {
            const result = await this.executeSerialized(
                query,
                pendingRecords,
                true,
                `remote:${event.senderInstanceId}`
            );
            if (!LeaderElectionService.isLeader() || InterInstanceBus.getAuthorityTerm() !== currentAuthorityTerm) {
                return;
            }
            const sendResult = InterInstanceBus.publishToInstance(requestedBy, {
                type: 'usagesQueryCompleted',
                payload: {
                    requestId,
                    targetInstanceId: requestedBy,
                    authorityTerm: currentAuthorityTerm,
                    result
                }
            });
            if (sendResult === 'too-large') {
                this.sendError(requestedBy, requestId, currentAuthorityTerm, 'response-too-large');
            }
        } catch (error) {
            StatusLogger.warn(`[UsagesQueryCoordinator] Failed to execute ${query.kind} query`, error);
            this.sendError(requestedBy, requestId, currentAuthorityTerm, 'query-failed');
        } finally {
            const remaining = (this.remoteQueryCounts.get(requestedBy) ?? 1) - 1;
            if (remaining > 0) {
                this.remoteQueryCounts.set(requestedBy, remaining);
            } else {
                this.remoteQueryCounts.delete(requestedBy);
            }
        }
    }

    private handleCompleted(event: UsagesQueryCompletedEvent): void {
        const payload = event.payload as unknown;
        if (!isRecord(payload)) {
            return;
        }
        const { requestId, targetInstanceId, authorityTerm, result, error } = payload;
        if (
            typeof requestId !== 'string' ||
            typeof targetInstanceId !== 'string' ||
            typeof authorityTerm !== 'string' ||
            targetInstanceId !== LeaderElectionService.getInstanceId()
        ) {
            return;
        }
        const pending = this.pendingQueries.get(requestId);
        if (!pending) {
            return;
        }
        const authorityInstanceId = getAuthorityInstanceId(pending.authorityTerm);
        const hasError = error !== undefined;
        if (
            !authorityInstanceId ||
            event.senderInstanceId !== authorityInstanceId ||
            authorityTerm !== pending.authorityTerm ||
            authorityTerm !== InterInstanceBus.getAuthorityTerm()
        ) {
            return;
        }

        let resolvedResult: UsagesQueryResult | undefined;
        if (hasError) {
            if (typeof error !== 'string' || !QUERY_ERRORS.has(error) || result !== undefined) {
                StatusLogger.debug('[UsagesQueryCoordinator] Invalid remote error response, falling back locally');
            }
            resolvedResult = undefined;
        } else {
            resolvedResult = isUsagesQueryResult(result, pending.query) ? result : undefined;
        }

        clearTimeout(pending.timer);
        this.pendingQueries.delete(requestId);
        pending.resolve(resolvedResult);
    }

    private executeSerialized(
        query: UsagesQuery,
        pendingRecords: readonly UsagesPendingRecord[] = [],
        isRemote = false,
        scope = 'local'
    ): Promise<UsagesQueryResult> {
        const key = this.getExecutionKey(query, scope);
        const previous = this.executionChains.get(key) ?? Promise.resolve();
        const execution = previous.then(() => this.executeQuery(query, pendingRecords, isRemote));
        const chain = execution.then(
            () => undefined,
            () => undefined
        );
        this.executionChains.set(key, chain);
        void chain.then(() => {
            if (this.executionChains.get(key) === chain) {
                this.executionChains.delete(key);
            }
        });
        return execution;
    }

    private getExecutionKey(query: UsagesQuery, scope: string): string {
        switch (query.kind) {
            case 'dateOverview':
                return `${scope}:overview:${query.date}`;
            case 'recordsPage':
                return `${scope}:detail:${query.date}`;
            case 'trackRecords':
                return `${scope}:detail:${query.date}`;
            case 'recentRecords':
                return `${scope}:recent:${query.limit}`;
            case 'sessionTitle':
                return `${scope}:title:${query.sessionId}`;
        }
    }

    private sendError(
        targetInstanceId: string,
        requestId: string,
        authorityTerm: string | undefined,
        error: NonNullable<UsagesQueryCompletedEvent['payload']['error']>
    ): void {
        if (!targetInstanceId || !requestId) {
            return;
        }
        InterInstanceBus.publishToInstance(targetInstanceId, {
            type: 'usagesQueryCompleted',
            payload: { requestId, targetInstanceId, authorityTerm, error }
        });
    }

    private cancelPendingQueries(): void {
        for (const pending of this.pendingQueries.values()) {
            clearTimeout(pending.timer);
            pending.resolve(undefined);
        }
        this.pendingQueries.clear();
    }
}
