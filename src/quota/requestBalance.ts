import { createHash } from 'node:crypto';
import type { BalanceQueryItem, BalanceQueryResult } from './compatible/balanceQuery';
import type {
    RequestBalanceLog,
    RequestStatusData,
    RequestStatusSnapshot,
    RequestRateLimitWindow,
    RequestCommandCodeWindow
} from '../usages/fileLogger/types';
import type { DeepSeekBalanceInfo } from './providers/deepseek';

function finiteAmount(value: number | string): number {
    if ((typeof value !== 'number' && typeof value !== 'string') || (typeof value === 'string' && !value.trim())) {
        throw new Error('Invalid balance amount');
    }
    const amount = Number(value);
    if (!Number.isFinite(amount)) {
        throw new Error('Invalid balance amount');
    }
    return amount;
}

function balanceItem(value: BalanceQueryItem): BalanceQueryItem {
    if (typeof value.currency !== 'string' || !value.currency.trim()) {
        throw new Error('Invalid balance currency');
    }
    return {
        balance: finiteAmount(value.balance),
        currency: value.currency,
        ...(typeof value.displayName === 'string' ? { displayName: value.displayName } : {}),
        ...(value.paid !== undefined ? { paid: finiteAmount(value.paid) } : {}),
        ...(value.granted !== undefined ? { granted: finiteAmount(value.granted) } : {})
    };
}

function balanceEntry(id: string, value: BalanceQueryResult): RequestBalanceLog['entries'][number] {
    return {
        id,
        ...balanceItem(value),
        ...(value.items ? { items: value.items.map(balanceItem) } : {})
    };
}

const MAX_SNAPSHOT_AGE_MS = 5 * 60 * 1000;
const MAX_SNAPSHOTS = 64;
interface CachedEntry {
    entry?: RequestBalanceLog['entries'][number];
    queriedAt: number;
    statusSnapshot?: RequestStatusSnapshot;
}
const snapshots = new Map<string, CachedEntry[]>();

function sameStatusSource(entry: CachedEntry, status?: RequestStatusData): boolean {
    return !status || !entry.statusSnapshot || entry.statusSnapshot.provider === status.provider;
}

function copyDeepSeekBalance(balance: DeepSeekBalanceInfo): DeepSeekBalanceInfo {
    for (const amount of [balance.total_balance, balance.topped_up_balance, balance.granted_balance]) {
        finiteAmount(statusText(amount));
    }
    return {
        currency: statusText(balance.currency),
        total_balance: balance.total_balance,
        topped_up_balance: balance.topped_up_balance,
        granted_balance: balance.granted_balance
    };
}

function statusText(value: string): string {
    if (typeof value !== 'string') {
        throw new Error('Invalid status text');
    }
    return value;
}

function optionalAmount(value: number | undefined): number | undefined {
    return value === undefined ? undefined : finiteAmount(value);
}

function copyCommandCodeWindow(window: RequestCommandCodeWindow): RequestCommandCodeWindow {
    return {
        used: finiteAmount(window.used),
        cap: finiteAmount(window.cap),
        ...(window.resetAt !== undefined ? { resetAt: statusText(window.resetAt) } : {})
    };
}

function copyRateLimitWindow(window: RequestRateLimitWindow): RequestRateLimitWindow {
    return {
        used_percent: finiteAmount(window.used_percent),
        limit_window_seconds: finiteAmount(window.limit_window_seconds),
        reset_at: finiteAmount(window.reset_at)
    };
}

function statusSnapshot(status: RequestStatusData, queriedAt: number): RequestStatusSnapshot {
    const metadata = {
        version: 1 as const,
        queriedAt
    };
    switch (status.provider) {
        case 'deepseek':
            return {
                ...metadata,
                provider: status.provider,
                data: {
                    primaryBalance: copyDeepSeekBalance(status.data.primaryBalance),
                    allBalances: status.data.allBalances.map(copyDeepSeekBalance)
                }
            };
        case 'moonshot':
            return {
                ...metadata,
                provider: status.provider,
                data: {
                    balanceInfo: {
                        available_balance: finiteAmount(status.data.balanceInfo.available_balance),
                        cash_balance: finiteAmount(status.data.balanceInfo.cash_balance),
                        voucher_balance: finiteAmount(status.data.balanceInfo.voucher_balance)
                    }
                }
            };
        case 'commandcode':
            return {
                ...metadata,
                provider: status.provider,
                data: {
                    ...(status.data.planId !== undefined ? { planId: statusText(status.data.planId) } : {}),
                    monthlyCredits: finiteAmount(status.data.monthlyCredits),
                    purchasedCredits: finiteAmount(status.data.purchasedCredits),
                    freeCredits: finiteAmount(status.data.freeCredits),
                    totalCredits: finiteAmount(status.data.totalCredits),
                    ...(status.data.fiveHour ? { fiveHour: copyCommandCodeWindow(status.data.fiveHour) } : {}),
                    ...(status.data.weekly ? { weekly: copyCommandCodeWindow(status.data.weekly) } : {})
                }
            };
        case 'clinepass':
            return {
                ...metadata,
                provider: status.provider,
                data: {
                    limits: status.data.limits.map(limit => {
                        if (limit.type !== 'five_hour' && limit.type !== 'weekly' && limit.type !== 'monthly') {
                            throw new Error('Invalid quota type');
                        }
                        return {
                            type: limit.type,
                            percentUsed: finiteAmount(limit.percentUsed),
                            ...(limit.resetsAt !== undefined ? { resetsAt: statusText(limit.resetsAt) } : {})
                        };
                    })
                }
            };
        case 'minimax-token':
            return {
                ...metadata,
                provider: status.provider,
                data: {
                    limits: status.data.limits.map(limit => {
                        if (limit.limitType !== '5h' && limit.limitType !== 'weekly') {
                            throw new Error('Invalid quota type');
                        }
                        return {
                            limitType: limit.limitType,
                            remaining: finiteAmount(limit.remaining),
                            resetTime: optionalAmount(limit.resetTime)
                        };
                    })
                }
            };
        case 'opencode':
            return {
                ...metadata,
                provider: status.provider,
                data: {
                    windows: status.data.windows.map(window => {
                        if (window.type !== 'rolling' && window.type !== 'weekly' && window.type !== 'monthly') {
                            throw new Error('Invalid quota type');
                        }
                        return {
                            type: window.type,
                            usedPercent: finiteAmount(window.usedPercent),
                            remainingPercent: finiteAmount(window.remainingPercent),
                            ...(window.resetAt !== undefined ? { resetAt: statusText(window.resetAt) } : {})
                        };
                    })
                }
            };
        case 'kimi': {
            const { summary, windows, boosterWallet, parallel } = status.data;
            if (summary.period !== 'weekly' && summary.period !== 'monthly') {
                throw new Error('Invalid quota period');
            }
            if (
                boosterWallet?.monthlyChargeLimitEnabled !== undefined &&
                typeof boosterWallet.monthlyChargeLimitEnabled !== 'boolean'
            ) {
                throw new Error('Invalid monthly cap setting');
            }
            return {
                ...metadata,
                provider: status.provider,
                data: {
                    summary: {
                        period: summary.period,
                        remaining: finiteAmount(summary.remaining),
                        resetTime: statusText(summary.resetTime)
                    },
                    windows: windows.map(window => ({
                        duration: finiteAmount(window.duration),
                        timeUnit: statusText(window.timeUnit),
                        detail: {
                            remaining: finiteAmount(window.detail.remaining),
                            ...(window.detail.resetTime !== undefined ?
                                { resetTime: statusText(window.detail.resetTime) }
                            :   {})
                        }
                    })),
                    ...(parallel ? { parallel: { limit: finiteAmount(parallel.limit) } } : {}),
                    ...(boosterWallet ?
                        {
                            boosterWallet: {
                                balance: { amountLeft: statusText(boosterWallet.balance.amountLeft) },
                                topupLimit: { currency: statusText(boosterWallet.topupLimit.currency) },
                                status: statusText(boosterWallet.status),
                                ...(boosterWallet.monthlyChargeLimitEnabled !== undefined ?
                                    { monthlyChargeLimitEnabled: boosterWallet.monthlyChargeLimitEnabled }
                                :   {}),
                                monthlyChargeLimit: {
                                    currency: statusText(boosterWallet.monthlyChargeLimit.currency),
                                    priceInCents: statusText(boosterWallet.monthlyChargeLimit.priceInCents)
                                },
                                monthlyUsed: {
                                    currency: statusText(boosterWallet.monthlyUsed.currency),
                                    priceInCents: statusText(boosterWallet.monthlyUsed.priceInCents)
                                }
                            }
                        }
                    :   {})
                }
            };
        }
        case 'codex': {
            const { rateLimit } = status.data;
            return {
                ...metadata,
                provider: status.provider,
                data: {
                    planType: statusText(status.data.planType),
                    rateLimit: {
                        primary_window: copyRateLimitWindow(rateLimit.primary_window),
                        ...(rateLimit.secondary_window ?
                            { secondary_window: copyRateLimitWindow(rateLimit.secondary_window) }
                        :   {})
                    }
                }
            };
        }
        case 'grok': {
            const { usage } = status.data;
            if (usage.type !== 'weekly' && usage.type !== 'monthly') {
                throw new Error('Invalid quota type');
            }
            return {
                ...metadata,
                provider: status.provider,
                data: {
                    usage: {
                        type: usage.type,
                        remainingPercent: finiteAmount(usage.remainingPercent),
                        ...(usage.resetAt !== undefined ? { resetAt: statusText(usage.resetAt) } : {}),
                        ...(usage.subscriptionTier !== undefined ?
                            { subscriptionTier: statusText(usage.subscriptionTier) }
                        :   {})
                    }
                }
            };
        }
        case 'zhipu':
            return {
                ...metadata,
                provider: status.provider,
                data: {
                    limits: status.data.limits.map(limit => {
                        if (limit.type !== 'TIME_LIMIT' && limit.type !== 'TOKENS_LIMIT') {
                            throw new Error('Invalid quota type');
                        }
                        return {
                            type: limit.type,
                            unit: finiteAmount(limit.unit),
                            percentage: finiteAmount(limit.percentage),
                            usage: optionalAmount(limit.usage),
                            remaining: optionalAmount(limit.remaining),
                            nextResetTime: optionalAmount(limit.nextResetTime)
                        };
                    }),
                    ...(status.data.account ?
                        {
                            account: {
                                balance: finiteAmount(status.data.account.balance),
                                rechargeAmount: optionalAmount(status.data.account.rechargeAmount),
                                giveAmount: optionalAmount(status.data.account.giveAmount),
                                totalSpendAmount: optionalAmount(status.data.account.totalSpendAmount),
                                availableBalance: optionalAmount(status.data.account.availableBalance)
                            }
                        }
                    :   {})
                }
            };
        case 'compatible':
            if (status.data.queryScope !== undefined && status.data.queryScope !== 'provider') {
                throw new Error('Invalid query scope');
            }
            return {
                ...metadata,
                provider: status.provider,
                data: {
                    providerId: statusText(status.data.providerId),
                    providerName: statusText(status.data.providerName),
                    balanceInfo: {
                        ...balanceItem(status.data.balanceInfo),
                        ...(status.data.balanceInfo.items ?
                            { items: status.data.balanceInfo.items.map(balanceItem) }
                        :   {})
                    }
                }
            };
    }
}

export function hashRequestApiKey(apiKey: string): string {
    return createHash('sha256').update(apiKey).digest('hex');
}

function snapshotKey(providerKey: string, apiKeyHash: string): string {
    return `${providerKey}:${apiKeyHash}`;
}

function isValidApiKeyHash(apiKeyHash: string): boolean {
    return /^[a-f0-9]{64}$/.test(apiKeyHash);
}

function isFresh(queriedAt: number): boolean {
    const age = Date.now() - queriedAt;
    return Number.isFinite(age) && age >= 0 && age <= MAX_SNAPSHOT_AGE_MS;
}

function saveSnapshot(key: string, entries: CachedEntry[]): void {
    for (const [storedKey, cachedEntries] of snapshots) {
        if (!cachedEntries.some(item => isFresh(item.queriedAt))) {
            snapshots.delete(storedKey);
        }
    }
    if (!snapshots.has(key) && snapshots.size >= MAX_SNAPSHOTS) {
        const oldest = snapshots.keys().next().value;
        if (oldest !== undefined) {
            snapshots.delete(oldest);
        }
    }
    snapshots.set(key, entries);
}

export function cacheRequestBalance(
    providerKey: string,
    apiKey: string,
    entries: RequestBalanceLog['entries'],
    queriedAt = Date.now(),
    status?: RequestStatusData
): void {
    if (!providerKey || !apiKey || (!entries.length && !status)) {
        return;
    }
    cacheRequestBalanceByKeyHash(providerKey, hashRequestApiKey(apiKey), entries, queriedAt, status);
}

export function cacheRequestBalanceByKeyHash(
    providerKey: string,
    apiKeyHash: string,
    entries: RequestBalanceLog['entries'],
    queriedAt = Date.now(),
    status?: RequestStatusData
): void {
    if (!providerKey || !isValidApiKeyHash(apiKeyHash) || (!entries.length && !status) || !isFresh(queriedAt)) {
        return;
    }
    if (status && status.provider !== 'compatible' && status.provider !== providerKey) {
        return;
    }
    try {
        const rawStatus = status ? statusSnapshot(status, queriedAt) : undefined;
        const safeEntries: CachedEntry[] = entries.map(entry => ({
            entry: balanceEntry(entry.id, entry),
            queriedAt,
            statusSnapshot: rawStatus
        }));
        if (!safeEntries.length && rawStatus) {
            safeEntries.push({ queriedAt, statusSnapshot: rawStatus });
        }
        const key = snapshotKey(providerKey, apiKeyHash);
        const previous = snapshots.get(key)?.filter(item => isFresh(item.queriedAt)) ?? [];
        const otherSources = previous.filter(item => !sameStatusSource(item, status));
        const newerEntries = previous.filter(item => sameStatusSource(item, status) && item.queriedAt > queriedAt);
        if (status && status.provider !== 'compatible' && newerEntries.length) {
            return;
        }
        const newerIds = new Set(newerEntries.map(item => item.entry?.id));
        saveSnapshot(key, [
            ...safeEntries.filter(item => !newerIds.has(item.entry?.id)),
            ...newerEntries,
            ...otherSources
        ]);
    } catch {
        return;
    }
}

export function cacheRequestBalanceEntry(
    providerKey: string,
    apiKey: string,
    entry: RequestBalanceLog['entries'][number]
): void {
    if (!providerKey || !apiKey) {
        return;
    }
    cacheRequestBalanceEntryByKeyHash(providerKey, hashRequestApiKey(apiKey), entry);
}

export function cacheRequestBalanceEntryByKeyHash(
    providerKey: string,
    apiKeyHash: string,
    entry: RequestBalanceLog['entries'][number],
    queriedAt = Date.now(),
    status?: RequestStatusData
): void {
    if (!providerKey || !isValidApiKeyHash(apiKeyHash) || !isFresh(queriedAt)) {
        return;
    }
    cacheEntry(snapshotKey(providerKey, apiKeyHash), entry, queriedAt, status);
}

export function cacheProviderRequestBalanceEntry(
    providerKey: string,
    entry: RequestBalanceLog['entries'][number],
    queriedAt: number,
    status: RequestStatusData
): void {
    if (
        !providerKey ||
        !isFresh(queriedAt) ||
        status.provider !== 'compatible' ||
        status.data.queryScope !== 'provider'
    ) {
        return;
    }
    cacheEntry(`${providerKey}:public`, entry, queriedAt, status);
}

function cacheEntry(
    key: string,
    entry: RequestBalanceLog['entries'][number],
    queriedAt: number,
    status?: RequestStatusData
): void {
    try {
        const safeEntry = balanceEntry(entry.id, entry);
        const previous = snapshots.get(key)?.filter(item => isFresh(item.queriedAt)) ?? [];
        if (
            previous.some(
                item => sameStatusSource(item, status) && item.entry?.id === entry.id && item.queriedAt > queriedAt
            )
        ) {
            return;
        }
        saveSnapshot(key, [
            ...previous.filter(item => !sameStatusSource(item, status) || item.entry?.id !== entry.id),
            { entry: safeEntry, queriedAt, statusSnapshot: status ? statusSnapshot(status, queriedAt) : undefined }
        ]);
    } catch {
        return;
    }
}

export function getCachedRequestBalance(providerKey: string, apiKey: string): RequestBalanceLog | undefined {
    if (!providerKey || !apiKey) {
        return undefined;
    }
    return getCachedRequestBalanceByKeyHash(providerKey, hashRequestApiKey(apiKey));
}

export function getCachedRequestBalanceByKeyHash(
    providerKey: string,
    apiKeyHash: string
): RequestBalanceLog | undefined {
    if (!providerKey || !isValidApiKeyHash(apiKeyHash)) {
        return undefined;
    }
    return getCachedRequestBalanceForRequest(providerKey, apiKeyHash);
}

export function getCachedRequestBalanceForRequest(
    providerKey: string,
    apiKeyHash?: string
): RequestBalanceLog | undefined {
    if (!providerKey || (apiKeyHash !== undefined && !isValidApiKeyHash(apiKeyHash))) {
        return undefined;
    }
    const candidates = [
        ...(snapshots.get(`${providerKey}:public`) ?? []),
        ...(apiKeyHash ? (snapshots.get(snapshotKey(providerKey, apiKeyHash)) ?? []) : [])
    ].filter(item => isFresh(item.queriedAt));
    const compatible = new Map<string, CachedEntry>();
    for (const item of candidates) {
        if (item.statusSnapshot?.provider === 'compatible') {
            const id = item.statusSnapshot.data.providerId;
            if ((compatible.get(id)?.queriedAt ?? -Infinity) <= item.queriedAt) {
                compatible.set(id, item);
            }
        }
    }
    const entries = candidates.filter(
        item =>
            item.statusSnapshot?.provider !== 'compatible' ||
            compatible.get(item.statusSnapshot.data.providerId) === item
    );
    if (!entries.length) {
        return undefined;
    }
    const statusSnapshots = Array.from(
        new Set(entries.flatMap(item => (item.statusSnapshot ? [item.statusSnapshot] : [])))
    );
    return {
        queriedAt: Math.max(...entries.map(item => item.queriedAt)),
        entries: entries.flatMap(item => (item.entry ? [balanceEntry(item.entry.id, item.entry)] : [])),
        ...(statusSnapshots.length ?
            { statusSnapshots: statusSnapshots.map(item => statusSnapshot(item, item.queriedAt)) }
        :   {})
    };
}
