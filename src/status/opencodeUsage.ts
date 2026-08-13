const DEFAULT_OPENCODE_USAGE_URL = 'https://opencode.ai/zen/go/v1/usage';

export type OpenCodeUsageWindowType = 'rolling' | 'weekly' | 'monthly';

interface OpenCodeUsageWindowPayload {
    status?: unknown;
    percent?: unknown;
    resetsAt?: unknown;
}

export interface OpenCodeUsageWindow {
    type: OpenCodeUsageWindowType;
    usedPercent: number;
    remainingPercent: number;
    resetAt?: string;
    status: string;
}

export interface OpenCodeUsageData {
    windows: OpenCodeUsageWindow[];
}

type OpenCodeUsageParseResult = { kind: 'usage'; usage: OpenCodeUsageData } | { kind: 'invalid'; error: string };

export function formatOpenCodeStatusBarText(icon: string, data: OpenCodeUsageData): string {
    const monthly = data.windows.find(window => window.type === 'monthly');
    const weekly = data.windows.find(window => window.type === 'weekly');
    const rolling = data.windows.find(window => window.type === 'rolling');
    const primaryCandidates = [monthly, weekly].filter((window): window is OpenCodeUsageWindow => Boolean(window));
    const primaryRemaining =
        primaryCandidates.length > 0 ?
            Math.min(...primaryCandidates.map(window => window.remainingPercent))
        :   (rolling?.remainingPercent ?? data.windows[0].remainingPercent);

    if (rolling && rolling.usedPercent > 0 && primaryCandidates.length > 0) {
        return `${icon} ${primaryRemaining.toFixed(0)}% (${rolling.remainingPercent.toFixed(0)}%)`;
    }

    return `${icon} ${primaryRemaining.toFixed(0)}%`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function parseIsoDate(value: unknown): string | undefined {
    if (typeof value !== 'string' || value.length === 0) {
        return undefined;
    }

    const timestamp = Date.parse(value);
    if (!Number.isFinite(timestamp)) {
        return undefined;
    }

    return value;
}

function parseWindow(type: OpenCodeUsageWindowType, payload: unknown): OpenCodeUsageWindow | string {
    if (!isRecord(payload)) {
        return `${type} must be an object`;
    }

    const { percent, resetsAt, status } = payload as OpenCodeUsageWindowPayload;
    if (typeof percent !== 'number' || !Number.isFinite(percent)) {
        return `${type}.percent must be a finite number`;
    }
    if (percent < 0) {
        return `${type}.percent must not be negative`;
    }
    if (typeof status !== 'string' || status.length === 0) {
        return `${type}.status must be a non-empty string`;
    }

    const resetAt = parseIsoDate(resetsAt);
    if (resetsAt !== undefined && resetAt === undefined) {
        return `${type}.resetsAt must be a valid ISO date string`;
    }

    return {
        type,
        usedPercent: percent,
        remainingPercent: Math.max(0, 100 - percent),
        ...(resetAt ? { resetAt } : {}),
        status
    };
}

function isMissingWindowPayload(payload: unknown): boolean {
    return payload === undefined || payload === null;
}

export function parseOpenCodeUsage(payload: unknown): OpenCodeUsageParseResult {
    if (!isRecord(payload)) {
        return { kind: 'invalid', error: 'payload must be an object' };
    }

    const usage = payload.usage;
    if (!isRecord(usage)) {
        return { kind: 'invalid', error: 'usage must be an object' };
    }

    const windows: OpenCodeUsageWindow[] = [];
    for (const type of ['rolling', 'weekly', 'monthly'] as const) {
        if (isMissingWindowPayload(usage[type])) {
            continue;
        }

        const window = parseWindow(type, usage[type]);
        if (typeof window === 'string') {
            return { kind: 'invalid', error: window };
        }
        windows.push(window);
    }

    if (windows.length === 0) {
        return { kind: 'invalid', error: 'usage must include at least one window' };
    }

    return { kind: 'usage', usage: { windows } };
}

export function resolveOpenCodeUsageUrl(env: NodeJS.ProcessEnv): string {
    const configuredUrl = env.OPENCODE_USAGE_URL?.trim();
    if (!configuredUrl) {
        return DEFAULT_OPENCODE_USAGE_URL;
    }

    return configuredUrl.replace(/\/+$/, '');
}
