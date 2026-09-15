/*---------------------------------------------------------------------------------------------
 *  Kimi 用量响应解析（纯逻辑，无宿主依赖，可被 node:test 直接覆盖）
 *  新版接口在 usage/limits 之外新增 Codex 风格 usages（limit_5h/limit_7d + used_ratio），
 *  存在时优先作为数据来源；旧 usage/limits 字段兜底。
 *--------------------------------------------------------------------------------------------*/

/** 归一化后的周配额摘要 */
export interface KimiUsageSummary {
    limit: number;
    used: number;
    remaining: number;
    resetTime: string;
}

/** 归一化后的频限窗口 */
export interface KimiUsageWindow {
    duration: number;
    timeUnit: string;
    detail: {
        limit: number;
        used: number;
        remaining: number;
        resetTime?: string;
    };
}

/** 归一化后的 Kimi 用量（summary 为每周额度，windows 为短窗列表） */
export interface KimiNormalizedUsage {
    summary: KimiUsageSummary;
    windows: KimiUsageWindow[];
}

interface KimiRawRatioWindow {
    used_ratio?: unknown;
    reset_time?: unknown;
}

interface KimiRawResponse {
    usage?: {
        limit: string | number;
        used?: string | number;
        remaining?: string | number;
        resetTime: string;
    };
    limits?: Array<{
        window: { duration: number; timeUnit: string };
        detail: { limit: string | number; used?: string | number; remaining?: string | number; resetTime?: string };
    }>;
    usages?: {
        limit_5h?: KimiRawRatioWindow;
        limit_7d?: KimiRawRatioWindow;
    };
}

/** 5 小时短窗按 300 分钟归一化，与 limits 中既有窗口对齐 */
const SHORT_WINDOW_MINUTES = 300;

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function toInt(value: string | number | undefined, fallback: number): number {
    if (typeof value === 'string') {
        const parsed = Number.parseInt(value, 10);
        return Number.isFinite(parsed) ? parsed : fallback;
    }
    return value ?? fallback;
}

function toRatioWindow(raw: KimiRawRatioWindow | undefined): { usedRatio: number; resetTime: string } | undefined {
    if (!isRecord(raw) || typeof raw.reset_time !== 'string' || raw.reset_time.length === 0) {
        return undefined;
    }
    if (typeof raw.used_ratio !== 'number' && typeof raw.used_ratio !== 'string') {
        return undefined;
    }
    const usedRatio = Number(raw.used_ratio);
    if (!Number.isFinite(usedRatio) || usedRatio < 0 || usedRatio > 1) {
        return undefined;
    }
    return { usedRatio, resetTime: raw.reset_time };
}

function remainingPercent(usedRatio: number): number {
    return Math.round((1 - usedRatio) * 100);
}

function isShortWindow(window: KimiUsageWindow): boolean {
    return (
        (window.timeUnit === 'TIME_UNIT_MINUTE' && window.duration === SHORT_WINDOW_MINUTES) ||
        (window.timeUnit === 'TIME_UNIT_HOUR' && window.duration === 5)
    );
}

/**
 * 归一化 Kimi 用量响应：usages.limit_7d 优先作为每周摘要，limit_5h 补齐 5 小时短窗；
 * 旧 usage/limits 字段兜底。周额度数据完全缺失时返回 undefined。
 */
export function normalizeKimiUsage(payload: unknown): KimiNormalizedUsage | undefined {
    if (!isRecord(payload)) {
        return undefined;
    }
    const response = payload as KimiRawResponse;
    const limit5h = toRatioWindow(response.usages?.limit_5h);
    const limit7d = toRatioWindow(response.usages?.limit_7d);

    const usage = response.usage;
    if (!usage && !limit7d) {
        return undefined;
    }

    const summary: KimiUsageSummary =
        limit7d ?
            {
                limit: 100,
                used: 100 - remainingPercent(limit7d.usedRatio),
                remaining: remainingPercent(limit7d.usedRatio),
                resetTime: limit7d.resetTime
            }
        :   {
                limit: toInt(usage!.limit, 100),
                used: toInt(usage!.used, 0),
                remaining: toInt(usage!.remaining, 0),
                resetTime: usage!.resetTime
            };

    const windows: KimiUsageWindow[] = (response.limits ?? []).map(item => ({
        duration: item.window.duration,
        timeUnit: item.window.timeUnit,
        detail: {
            limit: toInt(item.detail.limit, 100),
            used: toInt(item.detail.used, 0),
            remaining: toInt(item.detail.remaining, 0),
            resetTime: item.detail.resetTime
        }
    }));

    if (limit5h && !windows.some(isShortWindow)) {
        const remaining = remainingPercent(limit5h.usedRatio);
        windows.push({
            duration: SHORT_WINDOW_MINUTES,
            timeUnit: 'TIME_UNIT_MINUTE',
            detail: { limit: 100, used: 100 - remaining, remaining, resetTime: limit5h.resetTime }
        });
    }

    return { summary, windows };
}

/** 月限额是否启用：旧版有显式开关；新版已移除该字段，按限额金额 > 0 判断 */
export function isKimiMonthlyCapEnabled(
    monthlyChargeLimitEnabled: boolean | undefined,
    monthlyChargeLimit: { priceInCents: string } | undefined
): boolean {
    if (monthlyChargeLimitEnabled !== undefined) {
        return monthlyChargeLimitEnabled;
    }
    const cents = monthlyChargeLimit ? Number.parseInt(monthlyChargeLimit.priceInCents, 10) : Number.NaN;
    return Number.isFinite(cents) && cents > 0;
}
