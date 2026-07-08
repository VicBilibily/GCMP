/*---------------------------------------------------------------------------------------------
 *  Pricing Tier Resolver — 按请求时间匹配峰谷定价档位
 *
 *  设计目标：
 *  1. 纯函数、无 vscode / Logger 依赖，可在 node:test 下直接单测。
 *  2. cron 解析采用最小实现（5 字段标准 unix cron，不含秒、不含 L/W/# 等扩展），
 *     覆盖峰谷定价常见的"工作日/周末/时段"场景即可，避免引入第三方依赖。
 *  3. 匹配语义与 unix cron 一致：字段定义"该档位何时开始生效"，
 *     实际匹配时只要当前时间点命中 cron 字段，即视为该 tier 生效。
 *--------------------------------------------------------------------------------------------*/

import type {
    ModelTokenPricing,
    ModelTokenPricingInput,
    ModelTokenPricingInputObject,
    PricingTier,
    PricingTierInput
} from '../types/sharedTypes';

/**
 * cron 字段含义（5 字段，顺序固定）
 */
type CronField = 'minute' | 'hour' | 'day-of-month' | 'month' | 'day-of-week';

/**
 * 各字段的合法取值范围。
 * day-of-week: 0-6（0=Sunday），与 unix cron 一致。
 */
const FIELD_RANGES: Record<CronField, { min: number; max: number }> = {
    minute: { min: 0, max: 59 },
    hour: { min: 0, max: 23 },
    'day-of-month': { min: 1, max: 31 },
    month: { min: 1, max: 12 },
    'day-of-week': { min: 0, max: 7 } // 7 也视为 Sunday（cron 惯例）
};

/**
 * 解析单个 cron 字段表达式，返回匹配该字段的数值集合。
 *
 * 支持：
 * - 星号 通配
 * - n 单值
 * - a-b 范围
 * - a,b,c 列表
 * - 星号/n 步长
 * - a-b/n 范围内步长
 *
 * @param expr 字段表达式
 * @param field 字段名（用于范围约束）
 */
function parseCronField(expr: string, field: CronField): Set<number> {
    const trimmed = expr.trim();
    if (!trimmed) {
        throw new Error(`cron field "${field}" is empty`);
    }

    const range = FIELD_RANGES[field];
    const result = new Set<number>();

    // 列表分隔：a,b,c
    for (const part of trimmed.split(',')) {
        const segment = part.trim();
        if (!segment) {
            throw new Error(`cron field "${field}" contains empty list item: "${expr}"`);
        }

        if (segment === '*') {
            for (let i = range.min; i <= range.max; i++) {
                result.add(i);
            }
            continue;
        }

        // 步长：*/n 或 a-b/n
        const stepMatch = segment.match(/^(.+?)\/(\d+)$/);
        const step = stepMatch ? parseInt(stepMatch[2], 10) : 1;
        if (step <= 0) {
            throw new Error(`cron step must be positive: "${segment}"`);
        }

        const baseExpr = stepMatch ? stepMatch[1] : segment;
        let lo: number;
        let hi: number;

        if (baseExpr === '*') {
            lo = range.min;
            hi = range.max;
        } else {
            const rangeMatch = baseExpr.match(/^(\d+)-(\d+)$/);
            if (rangeMatch) {
                lo = parseInt(rangeMatch[1], 10);
                hi = parseInt(rangeMatch[2], 10);
                if (lo < range.min || hi > range.max || lo > hi) {
                    throw new Error(`cron range out of bounds or inverted: "${segment}" in field "${field}"`);
                }
            } else {
                const single = parseInt(baseExpr, 10);
                if (Number.isNaN(single) || single < range.min || single > range.max) {
                    throw new Error(`cron value out of bounds: "${segment}" in field "${field}"`);
                }
                // 单值 + 步长时，仅该值自身
                lo = single;
                hi = single;
            }
        }

        for (let i = lo; i <= hi; i += step) {
            result.add(i);
        }
    }

    if (result.size === 0) {
        throw new Error(`cron field "${field}" parsed to empty set: "${expr}"`);
    }
    return result;
}

/**
 * 将 cron 表达式解析为 5 个字段的数值集合。
 *
 * dayOfMonthWildcard / dayOfWeekWildcard 记录对应字段是否为原始 "*"，
 * 用于 matchesCron 实现标准 cron 的 day-of-month / day-of-week 组合语义：
 * - 两者都为 *：每天都命中
 * - 只有一个为 *：按非 * 的那个约束
 * - 两者都非 *：取并集（命中任一即生效）
 */
export interface ParsedCron {
    minute: Set<number>;
    hour: Set<number>;
    dayOfMonth: Set<number>;
    month: Set<number>;
    dayOfWeek: Set<number>;
    dayOfMonthWildcard: boolean;
    dayOfWeekWildcard: boolean;
}

/**
 * 解析完整 cron 表达式（5 字段）。
 */
export function parseCron(expr: string): ParsedCron {
    const parts = expr.trim().split(/\s+/);
    if (parts.length !== 5) {
        throw new Error(`cron expression must have 5 fields, got ${parts.length}: "${expr}"`);
    }

    const [minute, hour, dayOfMonth, month, dayOfWeek] = parts;
    return {
        minute: parseCronField(minute, 'minute'),
        hour: parseCronField(hour, 'hour'),
        dayOfMonth: parseCronField(dayOfMonth, 'day-of-month'),
        month: parseCronField(month, 'month'),
        dayOfWeek: normalizeDayOfWeekSet(parseCronField(dayOfWeek, 'day-of-week')),
        dayOfMonthWildcard: isWildcardField(dayOfMonth),
        dayOfWeekWildcard: isWildcardField(dayOfWeek)
    };
}

/**
 * 判断 cron 字段表达式是否为纯通配（星号），用于 day-of-month/day-of-week 组合语义。
 * 注意：含步长的表达式（如 星号/n）不算纯通配。
 */
function isWildcardField(expr: string): boolean {
    return expr.trim() === '*';
}

/**
 * cron 惯例：0 和 7 都代表 Sunday。把 7 归一为 0，便于后续比较。
 */
function normalizeDayOfWeekSet(set: Set<number>): Set<number> {
    if (!set.has(7)) {
        return set;
    }
    const normalized = new Set<number>(set);
    normalized.delete(7);
    normalized.add(0);
    return normalized;
}

/**
 * 判断给定时间分量是否命中 cron 表达式。
 *
 * @param parsed 已解析的 cron
 * @param components 已换算到目标时区的本地时间分量
 */
function matchesCron(parsed: ParsedCron, components: ZonedTimeComponents): boolean {
    if (
        !parsed.minute.has(components.minute) ||
        !parsed.hour.has(components.hour) ||
        !parsed.month.has(components.month)
    ) {
        return false;
    }

    // 标准 cron 的 day-of-month / day-of-week 组合语义：
    // - 两者都为 *：每天都命中
    // - 只有一个为 *：按非 * 的那个约束
    // - 两者都非 *：取并集（命中任一即生效）
    const domMatch = parsed.dayOfMonth.has(components.dayOfMonth);
    const dowMatch = parsed.dayOfWeek.has(components.dayOfWeek);

    if (parsed.dayOfMonthWildcard && parsed.dayOfWeekWildcard) {
        return true;
    }
    if (parsed.dayOfMonthWildcard) {
        return dowMatch;
    }
    if (parsed.dayOfWeekWildcard) {
        return domMatch;
    }
    return domMatch || dowMatch;
}

/**
 * 已换算到目标时区的"本地时间分量"。
 *
 * 注意：这不是一个真正的 Date 对象，只是携带目标时区下的
 * minute/hour/dayOfMonth/month/dayOfWeek 数值，供 matchesCron 直接比较。
 * 用 Date 对象会引入机器本地时区的隐式转换，导致 UTC 回退分支和跨时区场景出错。
 */
interface ZonedTimeComponents {
    minute: number;
    hour: number;
    dayOfMonth: number;
    month: number; // 1-12
    dayOfWeek: number; // 0=Sunday..6=Saturday
}

/**
 * 峰谷定价的默认时区：中国标准时间（北京时间，UTC+8）。
 *
 * 峰谷定价场景主要面向国内服务商的峰谷计费规则，因此未显式配置 timezone 时，
 * 统一按北京时间匹配 cron，而不是 UTC，避免机器本地时区差异导致档位错配。
 * 若需要按其他时区计费，在 tier 上显式设置 timezone 字段即可覆盖。
 */
const DEFAULT_PRICING_TIMEZONE = 'Asia/Shanghai';

/**
 * 时区相关：把一个 UTC 时间戳转换为指定时区下的本地时间分量。
 *
 * 实现使用 Intl.DateTimeFormat，避免引入第三方 tz 库。
 * 若时区未提供，按 DEFAULT_PRICING_TIMEZONE（北京时间）换算；
 * 若时区非法，同样回退到北京时间，保证峰谷档位判定稳定。
 */
function toZonedComponents(utcDate: Date, timezone: string | undefined): ZonedTimeComponents {
    const effectiveTimezone = timezone || DEFAULT_PRICING_TIMEZONE;

    try {
        const formatter = new Intl.DateTimeFormat('en-US', {
            timeZone: effectiveTimezone,
            year: 'numeric',
            month: 'numeric',
            day: 'numeric',
            hour: 'numeric',
            minute: 'numeric',
            second: 'numeric',
            hour12: false,
            weekday: 'short'
        });
        const parts = formatter.formatToParts(utcDate);
        const map = new Map<string, string>();
        for (const p of parts) {
            if (p.type !== 'literal') {
                map.set(p.type, p.value);
            }
        }

        const hourRaw = parseInt(map.get('hour') ?? '0', 10);
        const weekdayStr = (map.get('weekday') ?? '').toLowerCase();
        const weekdayMap: Record<string, number> = {
            sun: 0,
            mon: 1,
            tue: 2,
            wed: 3,
            thu: 4,
            fri: 5,
            sat: 6
        };

        return {
            minute: parseInt(map.get('minute') ?? '0', 10),
            hour: hourRaw === 24 ? 0 : hourRaw, // hour12:false 下 24 点归一为 0
            dayOfMonth: parseInt(map.get('day') ?? '1', 10),
            month: parseInt(map.get('month') ?? '1', 10),
            dayOfWeek: weekdayMap[weekdayStr] ?? 0
        };
    } catch {
        // 非法时区：再次按默认时区（北京时间）尝试一次；仍失败才回退 UTC
        if (effectiveTimezone !== DEFAULT_PRICING_TIMEZONE) {
            try {
                return toZonedComponents(utcDate, DEFAULT_PRICING_TIMEZONE);
            } catch {
                // 继续走到下面的 UTC 回退
            }
        }
        return {
            minute: utcDate.getUTCMinutes(),
            hour: utcDate.getUTCHours(),
            dayOfMonth: utcDate.getUTCDate(),
            month: utcDate.getUTCMonth() + 1,
            dayOfWeek: utcDate.getUTCDay()
        };
    }
}

/**
 * 根据请求发生时间和服务等级从 tiers 中匹配生效档位。
 *
 * 匹配规则：
 * 1. 按 tiers 数组顺序遍历，首个同时满足以下条件的 tier 即生效：
 *    - cron 表达式命中请求时间
 *    - tier 未限定 serviceTier，或 tier.serviceTier === requestServiceTier
 * 2. 若未配置 tiers，或无任何 tier 命中，返回 undefined，由调用方回退到静态单档。
 *
 * 注意：contextSizeMin 的过滤不在此处处理，而是在 calculateCostWithBreakdown 中
 * 根据实际 input token 数判断，因为上下文阶梯计费应以实际消耗为准，而非预分配窗口。
 *
 * @param pricing 模型定价配置
 * @param at 请求发生时间，默认当前时间
 * @param requestServiceTier 请求携带的 serviceTier（如 "priority"），缺省表示未选择
 */
export function resolveActiveTier(
    pricing: ModelTokenPricing | undefined,
    at: Date = new Date(),
    requestServiceTier?: string
): PricingTier | undefined {
    if (!pricing?.tiers || pricing.tiers.length === 0) {
        return undefined;
    }

    for (const tier of pricing.tiers) {
        // 服务等级过滤
        if (tier.serviceTier && tier.serviceTier !== requestServiceTier) {
            continue;
        }

        // cron 为空且无其他匹配规则时，此 tier 不生效
        // （有 serviceTier 或 contextSizeMin 时，空 cron 视为全时段匹配）
        if (!tier.cron && !tier.serviceTier && tier.contextSizeMin === undefined) {
            continue;
        }

        let parsed: ParsedCron;
        try {
            parsed = parseCron(tier.cron || '* * * * *');
        } catch {
            // 运行时保持静默跳过，避免单个坏 tier 中断请求。
            // 观测性由配置加载阶段的预校验补充。
            continue;
        }

        const components = toZonedComponents(at, tier.timezone);
        if (matchesCron(parsed, components)) {
            return tier;
        }
    }

    return undefined;
}

/**
 * 收集 tokenPricing.tiers 中无法通过运行时 cron 解析的表达式。
 *
 * 仅用于配置加载阶段做预校验/告警，不改变运行时的静默跳过策略。
 */
export function collectInvalidTierCrons(pricing: ModelTokenPricing | undefined): string[] {
    if (!pricing?.tiers || pricing.tiers.length === 0) {
        return [];
    }

    const invalidCrons: string[] = [];
    for (const tier of pricing.tiers) {
        const cronExpr = tier.cron || '* * * * *';
        try {
            parseCron(cronExpr);
        } catch {
            invalidCrons.push(cronExpr);
        }
    }
    return invalidCrons;
}

/**
 * Token 定价归一化工具。
 *
 * 运行时 ModelTokenPricing 统一使用对象形式，但配置层（JSON settings、自定义模型表单）允许使用数组简写：
 *   [inputPrice, outputPrice]                            → 2 参数
 *   [inputPrice, outputPrice, cacheReadPrice]            → 3 参数
 *   [inputPrice, outputPrice, cacheReadPrice, cacheWritePrice] → 4 参数
 *
 * 超出范围或非数组/对象时返回 undefined，由调用方决定是否保留原值。
 */
export function normalizeTokenPricing(
    pricing: ModelTokenPricingInput | null | undefined
): ModelTokenPricing | undefined {
    if (pricing === undefined || pricing === null) {
        return undefined;
    }

    if (Array.isArray(pricing)) {
        if (pricing.length < 2 || pricing.length > 4) {
            return undefined;
        }
        const [inputPrice, outputPrice, cacheReadPrice, cacheWritePrice] = pricing;
        if (
            typeof inputPrice !== 'number' ||
            typeof outputPrice !== 'number' ||
            !isFinite(inputPrice) ||
            !isFinite(outputPrice) ||
            inputPrice < 0 ||
            outputPrice < 0
        ) {
            return undefined;
        }
        if (
            cacheReadPrice !== undefined &&
            (typeof cacheReadPrice !== 'number' || !isFinite(cacheReadPrice) || cacheReadPrice < 0)
        ) {
            return undefined;
        }
        if (
            cacheWritePrice !== undefined &&
            (typeof cacheWritePrice !== 'number' || !isFinite(cacheWritePrice) || cacheWritePrice < 0)
        ) {
            return undefined;
        }
        const result: ModelTokenPricing = { inputPrice, outputPrice, pricing };
        if (cacheReadPrice !== undefined) {
            result.cacheReadPrice = cacheReadPrice;
        }
        if (cacheWritePrice !== undefined) {
            result.cacheWritePrice = cacheWritePrice;
        }
        return result;
    }

    if (typeof pricing === 'object') {
        const obj = pricing;

        // 兼容 { pricing: [1, 2] } 形式：从 pricing 数组转换
        if (
            obj.inputPrice === undefined &&
            obj.outputPrice === undefined &&
            obj.pricing !== undefined &&
            Array.isArray(obj.pricing) &&
            obj.pricing.length >= 2 &&
            obj.pricing.length <= 4 &&
            typeof obj.pricing[0] === 'number' &&
            typeof obj.pricing[1] === 'number' &&
            isFinite(obj.pricing[0]) &&
            isFinite(obj.pricing[1]) &&
            obj.pricing[0] >= 0 &&
            obj.pricing[1] >= 0
        ) {
            const converted: ModelTokenPricingInputObject = {
                inputPrice: obj.pricing[0],
                outputPrice: obj.pricing[1],
                pricing: obj.pricing
            };
            // 转发 tiers（兼容 { pricing: [1, 2], tiers: [...] } 形式）
            if (obj.tiers !== undefined) {
                converted.tiers = obj.tiers;
            }
            // 显式定义的 cache 价格优先于 pricing 数组简写
            if (obj.cacheReadPrice !== undefined) {
                if (typeof obj.cacheReadPrice !== 'number' || !isFinite(obj.cacheReadPrice) || obj.cacheReadPrice < 0) {
                    return undefined;
                }
                converted.cacheReadPrice = obj.cacheReadPrice;
            } else if (obj.pricing[2] !== undefined) {
                if (typeof obj.pricing[2] !== 'number' || !isFinite(obj.pricing[2]) || obj.pricing[2] < 0) {
                    return undefined;
                }
                converted.cacheReadPrice = obj.pricing[2];
            }
            if (obj.cacheWritePrice !== undefined) {
                if (
                    typeof obj.cacheWritePrice !== 'number' ||
                    !isFinite(obj.cacheWritePrice) ||
                    obj.cacheWritePrice < 0
                ) {
                    return undefined;
                }
                converted.cacheWritePrice = obj.cacheWritePrice;
            } else if (obj.pricing[3] !== undefined) {
                if (typeof obj.pricing[3] !== 'number' || !isFinite(obj.pricing[3]) || obj.pricing[3] < 0) {
                    return undefined;
                }
                converted.cacheWritePrice = obj.pricing[3];
            }
            return normalizeTokenPricing(converted);
        }

        if (
            typeof obj.inputPrice !== 'number' ||
            typeof obj.outputPrice !== 'number' ||
            !isFinite(obj.inputPrice) ||
            !isFinite(obj.outputPrice) ||
            obj.inputPrice < 0 ||
            obj.outputPrice < 0
        ) {
            return undefined;
        }
        if (
            obj.cacheReadPrice !== undefined &&
            (typeof obj.cacheReadPrice !== 'number' || !isFinite(obj.cacheReadPrice) || obj.cacheReadPrice < 0)
        ) {
            return undefined;
        }
        if (
            obj.cacheWritePrice !== undefined &&
            (typeof obj.cacheWritePrice !== 'number' || !isFinite(obj.cacheWritePrice) || obj.cacheWritePrice < 0)
        ) {
            return undefined;
        }
        if (obj.pricing !== undefined) {
            if (
                !Array.isArray(obj.pricing) ||
                obj.pricing.length < 2 ||
                obj.pricing.length > 4 ||
                typeof obj.pricing[0] !== 'number' ||
                typeof obj.pricing[1] !== 'number' ||
                !isFinite(obj.pricing[0]) ||
                !isFinite(obj.pricing[1]) ||
                obj.pricing[0] < 0 ||
                obj.pricing[1] < 0
            ) {
                return undefined;
            }
            if (
                obj.pricing[2] !== undefined &&
                (typeof obj.pricing[2] !== 'number' || !isFinite(obj.pricing[2]) || obj.pricing[2] < 0)
            ) {
                return undefined;
            }
            if (
                obj.pricing[3] !== undefined &&
                (typeof obj.pricing[3] !== 'number' || !isFinite(obj.pricing[3]) || obj.pricing[3] < 0)
            ) {
                return undefined;
            }
        }
        // 校验 tiers 数组结构，防止非法值传入后续 tier 匹配逻辑
        if (obj.tiers !== undefined) {
            if (!Array.isArray(obj.tiers)) {
                return undefined;
            }
            const normalizedTiers: PricingTier[] = [];
            for (const tier of obj.tiers as Array<PricingTierInput | unknown>) {
                if (typeof tier !== 'object' || tier === null) {
                    return undefined;
                }
                const t = tier as PricingTierInput;
                // 结构性可选字段类型校验，防手误传错类型
                if (t.cron !== undefined && typeof t.cron !== 'string') {
                    return undefined;
                }
                if (t.timezone !== undefined && typeof t.timezone !== 'string') {
                    return undefined;
                }
                if (t.serviceTier !== undefined && typeof t.serviceTier !== 'string') {
                    return undefined;
                }
                if (t.contextSizeMin !== undefined) {
                    if (typeof t.contextSizeMin !== 'number' || !isFinite(t.contextSizeMin) || t.contextSizeMin < 0) {
                        return undefined;
                    }
                }
                if (t.contextSizeInputOnly !== undefined && typeof t.contextSizeInputOnly !== 'boolean') {
                    return undefined;
                }
                if (t.pricing !== undefined) {
                    if (
                        !Array.isArray(t.pricing) ||
                        t.pricing.length < 2 ||
                        t.pricing.length > 4 ||
                        typeof t.pricing[0] !== 'number' ||
                        typeof t.pricing[1] !== 'number' ||
                        !isFinite(t.pricing[0]) ||
                        !isFinite(t.pricing[1]) ||
                        t.pricing[0] < 0 ||
                        t.pricing[1] < 0
                    ) {
                        return undefined;
                    }
                    if (
                        t.pricing[2] !== undefined &&
                        (typeof t.pricing[2] !== 'number' || !isFinite(t.pricing[2]) || t.pricing[2] < 0)
                    ) {
                        return undefined;
                    }
                    if (
                        t.pricing[3] !== undefined &&
                        (typeof t.pricing[3] !== 'number' || !isFinite(t.pricing[3]) || t.pricing[3] < 0)
                    ) {
                        return undefined;
                    }
                }

                // 兼容 tier 的 { pricing: [1, 2], cron: '...' } 形式
                if (
                    t.inputPrice === undefined &&
                    t.outputPrice === undefined &&
                    Array.isArray(t.pricing) &&
                    t.pricing.length >= 2 &&
                    t.pricing.length <= 4 &&
                    typeof t.pricing[0] === 'number' &&
                    typeof t.pricing[1] === 'number' &&
                    isFinite(t.pricing[0]) &&
                    isFinite(t.pricing[1]) &&
                    t.pricing[0] >= 0 &&
                    t.pricing[1] >= 0
                ) {
                    const converted: PricingTier = {
                        inputPrice: t.pricing[0],
                        outputPrice: t.pricing[1],
                        pricing: t.pricing,
                        cron: t.cron,
                        timezone: t.timezone,
                        serviceTier: t.serviceTier,
                        contextSizeMin: t.contextSizeMin,
                        contextSizeInputOnly: t.contextSizeInputOnly
                    };
                    // 显式定义的 cache 价格优先于 pricing 数组简写
                    if (t.cacheReadPrice !== undefined) {
                        if (
                            typeof t.cacheReadPrice !== 'number' ||
                            !isFinite(t.cacheReadPrice) ||
                            t.cacheReadPrice < 0
                        ) {
                            return undefined;
                        }
                        converted.cacheReadPrice = t.cacheReadPrice;
                    } else if (t.pricing[2] !== undefined) {
                        if (typeof t.pricing[2] !== 'number' || !isFinite(t.pricing[2]) || t.pricing[2] < 0) {
                            return undefined;
                        }
                        converted.cacheReadPrice = t.pricing[2];
                    }
                    if (t.cacheWritePrice !== undefined) {
                        if (
                            typeof t.cacheWritePrice !== 'number' ||
                            !isFinite(t.cacheWritePrice) ||
                            t.cacheWritePrice < 0
                        ) {
                            return undefined;
                        }
                        converted.cacheWritePrice = t.cacheWritePrice;
                    } else if (t.pricing[3] !== undefined) {
                        if (typeof t.pricing[3] !== 'number' || !isFinite(t.pricing[3]) || t.pricing[3] < 0) {
                            return undefined;
                        }
                        converted.cacheWritePrice = t.pricing[3];
                    }
                    normalizedTiers.push(converted);
                    continue;
                }

                if (
                    typeof t.inputPrice !== 'number' ||
                    typeof t.outputPrice !== 'number' ||
                    !isFinite(t.inputPrice) ||
                    !isFinite(t.outputPrice) ||
                    t.inputPrice < 0 ||
                    t.outputPrice < 0
                ) {
                    return undefined;
                }
                if (
                    t.cacheReadPrice !== undefined &&
                    (typeof t.cacheReadPrice !== 'number' || !isFinite(t.cacheReadPrice) || t.cacheReadPrice < 0)
                ) {
                    return undefined;
                }
                if (
                    t.cacheWritePrice !== undefined &&
                    (typeof t.cacheWritePrice !== 'number' || !isFinite(t.cacheWritePrice) || t.cacheWritePrice < 0)
                ) {
                    return undefined;
                }
                const normalizedTier: PricingTier = {
                    inputPrice: t.inputPrice,
                    outputPrice: t.outputPrice,
                    pricing: t.pricing,
                    cacheReadPrice: t.cacheReadPrice,
                    cacheWritePrice: t.cacheWritePrice,
                    cron: t.cron,
                    timezone: t.timezone,
                    serviceTier: t.serviceTier,
                    contextSizeMin: t.contextSizeMin,
                    contextSizeInputOnly: t.contextSizeInputOnly
                };
                normalizedTiers.push(normalizedTier);
            }
            const normalizedPricing: ModelTokenPricing = {
                inputPrice: obj.inputPrice,
                outputPrice: obj.outputPrice,
                pricing: obj.pricing,
                cacheReadPrice: obj.cacheReadPrice,
                cacheWritePrice: obj.cacheWritePrice,
                tiers: normalizedTiers
            };
            return normalizedPricing;
        }
        return pricing as ModelTokenPricing;
    }

    return undefined;
}
