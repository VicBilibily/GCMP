/*---------------------------------------------------------------------------------------------
 *  Kimi 用量响应解析（纯逻辑，无宿主依赖，可被 node:test 直接覆盖）
 *  新版接口在 usage/limits 之外新增 Codex 风格 usages（used_ratio + reset_time），
 *  存在时优先作为数据来源；旧 usage/limits 字段兜底。
 *  旧会员体系为 limit_5h/limit_7d；2026-09 新会员体系改为 limit_5h + limit_month_code
 *  （limit_month_total 为账户总额度，不作为编程额度展示）。
 *--------------------------------------------------------------------------------------------*/

/** 归一化后的配额摘要（period 标识每周/每月额度） */
export interface KimiUsageSummary {
    limit: number;
    used: number;
    remaining: number;
    resetTime: string;
    period: 'weekly' | 'monthly';
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

/** 归一化后的 Kimi 用量（summary 为每周/每月额度，windows 为短窗列表） */
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
        limit?: string | number;
        used?: string | number;
        remaining?: string | number;
        resetTime?: string;
    };
    limits?: Array<{
        window?: { duration?: number; timeUnit?: string };
        detail?: { limit?: string | number; used?: string | number; remaining?: string | number; resetTime?: string };
    }>;
    usages?: {
        limit_5h?: KimiRawRatioWindow;
        limit_7d?: KimiRawRatioWindow;
        limit_month_code?: KimiRawRatioWindow;
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
    return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
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
 * 归一化 Kimi 用量响应：limit_7d 优先作为每周摘要，新会员的 limit_month_code 作为每月摘要，
 * limit_5h 补齐 5 小时短窗；旧 usage/limits 字段兜底。
 * usage/limits 后续可能被官方移除：usage 缺 resetTime 时忽略，limits 缺 window/detail 的条目跳过；
 * 额度数据完全缺失时返回 undefined。
 */
export function normalizeKimiUsage(payload: unknown): KimiNormalizedUsage | undefined {
    if (!isRecord(payload)) {
        return undefined;
    }
    const response = payload as KimiRawResponse;
    const limit5h = toRatioWindow(response.usages?.limit_5h);
    const limit7d = toRatioWindow(response.usages?.limit_7d);
    const limitMonthCode = toRatioWindow(response.usages?.limit_month_code);

    const rawUsage = response.usage;
    const usage =
        rawUsage && typeof rawUsage.resetTime === 'string' && rawUsage.resetTime.length > 0 ?
            {
                limit: rawUsage.limit,
                used: rawUsage.used,
                remaining: rawUsage.remaining,
                resetTime: rawUsage.resetTime
            }
        :   undefined;
    if (!usage && !limit7d && !limitMonthCode) {
        return undefined;
    }

    const summary: KimiUsageSummary =
        limit7d ?
            {
                limit: 100,
                used: 100 - remainingPercent(limit7d.usedRatio),
                remaining: remainingPercent(limit7d.usedRatio),
                resetTime: limit7d.resetTime,
                period: 'weekly'
            }
        : limitMonthCode ?
            {
                limit: 100,
                used: 100 - remainingPercent(limitMonthCode.usedRatio),
                remaining: remainingPercent(limitMonthCode.usedRatio),
                resetTime: limitMonthCode.resetTime,
                period: 'monthly'
            }
        :   {
                limit: toInt(usage!.limit, 100),
                used: toInt(usage!.used, 0),
                remaining: toInt(usage!.remaining, 0),
                resetTime: usage!.resetTime,
                period: 'weekly'
            };

    const windows: KimiUsageWindow[] = (Array.isArray(response.limits) ? response.limits : []).flatMap(item => {
        if (!item || !item.window || !item.detail) {
            return [];
        }
        const { duration, timeUnit } = item.window;
        if (typeof duration !== 'number' || !Number.isFinite(duration) || typeof timeUnit !== 'string' || !timeUnit) {
            return [];
        }
        const detail = item.detail;
        return [
            {
                duration,
                timeUnit,
                detail: {
                    limit: toInt(detail.limit, 100),
                    used: toInt(detail.used, 0),
                    remaining: toInt(detail.remaining, 0),
                    resetTime: detail.resetTime
                }
            }
        ];
    });

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
