/*---------------------------------------------------------------------------------------------
 *  Grok 订阅用量响应解析
 *  将 Grok CLI billing API 的每周额度和统一账单月度额度转换为统一展示模型
 *--------------------------------------------------------------------------------------------*/

const DEFAULT_GROK_BILLING_BASE_URL = 'https://cli-chat-proxy.grok.com/v1';
const WEEKLY_WINDOW_MINUTES = 7 * 24 * 60;
const MONTHLY_WINDOW_MINUTES = 30 * 24 * 60;

type BillingSource = 'credits' | 'billing';

export interface GrokUsageLimit {
    type: 'weekly' | 'monthly';
    usedPercent: number;
    remainingPercent: number;
    resetAt?: string;
    windowMinutes: number;
    subscriptionTier?: string;
}

export type GrokBillingParseResult =
    | { kind: 'usage'; usage: GrokUsageLimit }
    | { kind: 'unavailable'; subscriptionTier?: string }
    | { kind: 'invalid'; error: string };

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hasOwn(record: Record<string, unknown>, key: string): boolean {
    return Object.prototype.hasOwnProperty.call(record, key);
}

function parseDate(value: unknown): { iso: string; timestamp: number } | undefined {
    if (typeof value !== 'string' || value.length === 0) {
        return undefined;
    }

    const timestamp = Date.parse(value);
    if (!Number.isFinite(timestamp)) {
        return undefined;
    }

    return { iso: value, timestamp };
}

function getResetAt(config: Record<string, unknown>): string | undefined {
    const currentPeriod = isRecord(config.currentPeriod) ? config.currentPeriod : undefined;
    if (currentPeriod && hasOwn(currentPeriod, 'end')) {
        return parseDate(currentPeriod.end)?.iso;
    }

    return parseDate(config.billingPeriodEnd)?.iso;
}

function getSubscriptionTier(config: Record<string, unknown>): string | undefined {
    return typeof config.subscriptionTier === 'string' && config.subscriptionTier.length > 0 ?
            config.subscriptionTier
        :   undefined;
}

function getBillingConfig(payload: unknown, source: BillingSource): Record<string, unknown> | undefined {
    if (!isRecord(payload)) {
        return undefined;
    }

    if (isRecord(payload.config)) {
        return payload.config;
    }

    // Grok 的 credits 端点曾直接返回 config 字段；仅在明确带有 creditUsagePercent 时兼容该结构。
    if (source === 'credits' && hasOwn(payload, 'creditUsagePercent')) {
        return payload;
    }

    return undefined;
}

function isExplicitWeeklyZero(config: Record<string, unknown>): boolean {
    if (!isRecord(config.currentPeriod)) {
        return false;
    }

    const currentPeriod = config.currentPeriod;
    if (currentPeriod.type !== 'USAGE_PERIOD_TYPE_WEEKLY') {
        return false;
    }

    const periodStart = parseDate(currentPeriod.start);
    const periodEnd = parseDate(currentPeriod.end);
    const billingStart = parseDate(config.billingPeriodStart);
    const billingEnd = parseDate(config.billingPeriodEnd);

    return (
        periodStart !== undefined &&
        periodEnd !== undefined &&
        billingStart !== undefined &&
        billingEnd !== undefined &&
        periodStart.timestamp === billingStart.timestamp &&
        periodEnd.timestamp === billingEnd.timestamp
    );
}

function parseWeeklyUsage(config: Record<string, unknown>): GrokBillingParseResult {
    let usedPercent: number;
    if (hasOwn(config, 'creditUsagePercent')) {
        if (typeof config.creditUsagePercent !== 'number' || !Number.isFinite(config.creditUsagePercent)) {
            return { kind: 'invalid', error: 'creditUsagePercent must be a finite number' };
        }
        if (config.creditUsagePercent < 0) {
            return { kind: 'invalid', error: 'creditUsagePercent must not be negative' };
        }
        usedPercent = config.creditUsagePercent;
    } else if (isExplicitWeeklyZero(config)) {
        // protobuf JSON 会省略数值 0。仅当 weekly period 与 billing period 完全一致时才能确认这是 0% 已用。
        usedPercent = 0;
    } else {
        const subscriptionTier = getSubscriptionTier(config);
        return {
            kind: 'unavailable',
            ...(subscriptionTier ? { subscriptionTier } : {})
        };
    }

    const resetAt = getResetAt(config);
    const subscriptionTier = getSubscriptionTier(config);
    return {
        kind: 'usage',
        usage: {
            type: 'weekly',
            usedPercent,
            remainingPercent: Math.max(0, 100 - usedPercent),
            ...(resetAt ? { resetAt } : {}),
            windowMinutes: WEEKLY_WINDOW_MINUTES,
            ...(subscriptionTier ? { subscriptionTier } : {})
        }
    };
}

function parseAmount(value: unknown, fieldName: string): { value: number } | { error: string } | undefined {
    if (!isRecord(value) || !hasOwn(value, 'val')) {
        return undefined;
    }

    const rawValue = value.val;
    if (typeof rawValue === 'number' && Number.isFinite(rawValue)) {
        return { value: rawValue };
    }

    if (typeof rawValue === 'string' && rawValue.trim().length > 0) {
        const parsed = Number(rawValue);
        if (Number.isFinite(parsed)) {
            return { value: parsed };
        }
    }

    return { error: `${fieldName}.val must be a finite number or numeric string` };
}

function parseMonthlyUsage(config: Record<string, unknown>): GrokBillingParseResult {
    const limitResult = parseAmount(config.monthlyLimit, 'monthlyLimit');
    const usedResult = parseAmount(config.used, 'used');

    if (!limitResult || !usedResult) {
        const subscriptionTier = getSubscriptionTier(config);
        return {
            kind: 'unavailable',
            ...(subscriptionTier ? { subscriptionTier } : {})
        };
    }
    if ('error' in limitResult) {
        return { kind: 'invalid', error: limitResult.error };
    }
    if ('error' in usedResult) {
        return { kind: 'invalid', error: usedResult.error };
    }
    if (limitResult.value <= 0) {
        return { kind: 'invalid', error: 'monthlyLimit.val must be greater than zero' };
    }
    if (usedResult.value < 0) {
        return { kind: 'invalid', error: 'used.val must not be negative' };
    }

    const usedPercent = (usedResult.value / limitResult.value) * 100;
    const resetAt = getResetAt(config);
    const subscriptionTier = getSubscriptionTier(config);
    return {
        kind: 'usage',
        usage: {
            type: 'monthly',
            usedPercent,
            remainingPercent: Math.max(0, 100 - usedPercent),
            ...(resetAt ? { resetAt } : {}),
            windowMinutes: MONTHLY_WINDOW_MINUTES,
            ...(subscriptionTier ? { subscriptionTier } : {})
        }
    };
}

export function parseGrokBillingUsage(payload: unknown, source: BillingSource): GrokBillingParseResult {
    const config = getBillingConfig(payload, source);
    if (!config) {
        return { kind: 'unavailable' };
    }

    return source === 'credits' ? parseWeeklyUsage(config) : parseMonthlyUsage(config);
}

export function resolveGrokBillingBaseUrl(env: NodeJS.ProcessEnv): string {
    const configuredUrl = env.GROK_CLI_CHAT_PROXY_BASE_URL?.trim();
    if (!configuredUrl) {
        return DEFAULT_GROK_BILLING_BASE_URL;
    }

    return configuredUrl.replace(/\/+$/, '');
}
