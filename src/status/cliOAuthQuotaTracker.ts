/*---------------------------------------------------------------------------------------------
 *  CLI OAuth 负载均衡账号配额汇总
 *  逐个查询命名账号的额度，并在查询前后校验账号清单、路由设置和活跃选择。
 *--------------------------------------------------------------------------------------------*/

import { createHash } from 'node:crypto';
import type { MultiKeyEntry, MultiKeySectionLabels, MultiKeyStatusData } from './multiKeyQuotaTracker';
import { renderMultiKeySections } from './multiKeyQuotaTracker';
import type {
    OAuthCredentialEntry,
    OAuthCredentialRoutingSettings,
    OAuthCredentialSelection
} from '../cli/auth/oauthCredentialStore';

export interface CliOAuthQuotaSource {
    getRoutingSettings(): OAuthCredentialRoutingSettings;
    listCredentials(): OAuthCredentialEntry[];
    getActiveSelection(): OAuthCredentialSelection;
}

export interface CliOAuthQuotaQueryResult<TRaw> {
    success: boolean;
    data?: TRaw;
    error?: string;
    requestBalanceKeyHash?: string;
    queriedAt?: number;
    credentialExpiryDate?: number;
}

export interface CliOAuthQuotaQuery<TRaw> {
    query(credentialName: string): Promise<CliOAuthQuotaQueryResult<TRaw>>;
    summary(data: TRaw): string;
}

export interface CliOAuthQuotaStatus<TRaw> extends MultiKeyStatusData<TRaw> {
    routingGeneration: number;
    activeSelection: OAuthCredentialSelection;
    credentials: Array<{
        name: string;
        label?: string;
        hasAccessToken: boolean;
        accessTokenHash?: string;
        identity: string;
    }>;
}

export interface ActiveCliOAuthQuotaQuery<TRaw> {
    credentialName: string | undefined;
    result: CliOAuthQuotaQueryResult<TRaw>;
}

export function isCliOAuthQuotaEnabled(source: CliOAuthQuotaSource): boolean {
    return source.getRoutingSettings().mode === 'balance' && source.listCredentials().length > 1;
}

export async function collectCliOAuthQuotaStatus<TRaw>(
    source: CliOAuthQuotaSource,
    query: CliOAuthQuotaQuery<TRaw>,
    activeQuery?: ActiveCliOAuthQuotaQuery<TRaw>
): Promise<CliOAuthQuotaStatus<TRaw> | undefined> {
    const settings = source.getRoutingSettings();
    const routingGeneration = settings.generation;
    const credentials = source.listCredentials();
    const activeSelection = { ...source.getActiveSelection() };
    if (settings.mode !== 'balance' || credentials.length <= 1) {
        return undefined;
    }

    const credentialSnapshot = credentials.map(credential => ({
        name: credential.name,
        label: credential.label,
        hasAccessToken: credential.hasAccessToken,
        accessTokenHash: credential.accessTokenHash,
        identity: hashCredentialIdentity(credential)
    }));
    const entries = await Promise.all(
        credentials.map(async credential =>
            queryCredential(
                credential,
                credential.name === activeQuery?.credentialName ? activeQuery.result : undefined,
                query,
                activeSelection.name
            )
        )
    );
    const status: CliOAuthQuotaStatus<TRaw> = {
        entries,
        timestamp: Date.now(),
        routingGeneration,
        activeSelection,
        credentials: credentialSnapshot
    };
    return isCliOAuthQuotaStatusCurrent(status, source) ? status : undefined;
}

export function isCliOAuthQuotaStatusCurrent<TRaw>(
    status: CliOAuthQuotaStatus<TRaw> | undefined,
    source: CliOAuthQuotaSource
): status is CliOAuthQuotaStatus<TRaw> {
    if (!status) {
        return false;
    }
    const settings = source.getRoutingSettings();
    const activeSelection = source.getActiveSelection();
    const credentials = source.listCredentials();
    return (
        settings.mode === 'balance' &&
        settings.generation === status.routingGeneration &&
        activeSelection.name === status.activeSelection.name &&
        activeSelection.generation === status.activeSelection.generation &&
        credentials.length === status.credentials.length &&
        credentials.every((credential, index) => {
            const snapshot = status.credentials[index];
            return (
                snapshot?.name === credential.name &&
                snapshot.label === credential.label &&
                snapshot.hasAccessToken === credential.hasAccessToken &&
                snapshot.accessTokenHash === credential.accessTokenHash &&
                snapshot.identity === hashCredentialIdentity(credential)
            );
        })
    );
}

export function renderCliOAuthQuotaSection<TRaw>(
    status: CliOAuthQuotaStatus<TRaw> | undefined,
    source: CliOAuthQuotaSource,
    query: Pick<CliOAuthQuotaQuery<TRaw>, 'summary'>,
    labels: MultiKeySectionLabels
): string {
    if (!isCliOAuthQuotaStatusCurrent(status, source)) {
        return '';
    }
    return renderMultiKeySections(status, query, labels);
}

async function queryCredential<TRaw>(
    credential: OAuthCredentialEntry,
    activeResult: CliOAuthQuotaQueryResult<TRaw> | undefined,
    query: CliOAuthQuotaQuery<TRaw>,
    activeName: string | undefined
): Promise<MultiKeyEntry<TRaw>> {
    const base = {
        configId: credential.name,
        label: credential.label || credential.name,
        isActive: credential.name === activeName,
        keyHash: hashCredentialIdentity(credential),
        timestamp: Date.now()
    };
    if (!credential.hasAccessToken) {
        return { ...base, status: 'missing-key' };
    }

    try {
        const result = activeResult ?? (await query.query(credential.name));
        const timestamp = result.queriedAt ?? Date.now();
        if (!result.success || result.data === undefined) {
            return {
                ...base,
                ...(result.requestBalanceKeyHash ? { requestBalanceKeyHash: result.requestBalanceKeyHash } : {}),
                status: 'error',
                ...(result.error ? { error: result.error } : {}),
                timestamp
            };
        }
        if (
            (result.credentialExpiryDate !== undefined && result.credentialExpiryDate !== credential.expiryDate) ||
            (result.requestBalanceKeyHash !== undefined &&
                credential.accessTokenHash !== undefined &&
                result.requestBalanceKeyHash !== credential.accessTokenHash)
        ) {
            return {
                ...base,
                ...(result.requestBalanceKeyHash ? { requestBalanceKeyHash: result.requestBalanceKeyHash } : {}),
                status: 'stale',
                timestamp
            };
        }
        return {
            ...base,
            ...(result.requestBalanceKeyHash ? { requestBalanceKeyHash: result.requestBalanceKeyHash } : {}),
            status: 'success',
            data: result.data,
            timestamp
        };
    } catch (error) {
        return {
            ...base,
            status: 'error',
            error: error instanceof Error ? error.message : String(error)
        };
    }
}

function hashCredentialIdentity(credential: OAuthCredentialEntry): string {
    return createHash('sha256')
        .update(
            `${credential.name}\u0000${credential.filePath}\u0000${credential.expiryDate ?? ''}\u0000${credential.accessTokenHash ?? ''}`
        )
        .digest('hex')
        .slice(0, 16);
}
