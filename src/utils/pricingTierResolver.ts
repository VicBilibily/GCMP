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
    DualCurrencyPricingMap,
    ModelTokenPricing,
    ModelTokenPricingInput,
    PricingArray,
    PricingFields,
    PricingFieldsRmb,
    PricingInput,
    PricingTier,
    PricingTierInput
} from '../types/sharedTypes';
import { convertRmbToUsd } from './pricingCurrency';

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
 * 根据实际上下文用量判断，因为上下文阶梯计费应以实际消耗为准，而非预分配窗口。
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
 * 运行时 ModelTokenPricing 统一使用对象形式，但配置层（JSON settings、自定义模型表单）允许使用多种简写：
 *   数组简写：[inputPrice, outputPrice, cacheReadPrice?, cacheWritePrice?]（默认 USD）
 *   双币映射：{ "USD": [...], "RMB": [...] }（pricing 字段扩展形式）
 *   对象简写：{ pricing: [...], tiers? }
 *
 * pricing 字段支持三种形式：
 *   1. PricingArray — 数组简写，默认 USD
 *   2. DualCurrencyPricingMap — { "USD": [...], "RMB": [...] }，双币定价
 *      USD 数组 → 主价格字段（inputPrice/outputPrice 等）
 *      RMB 数组 → rmb 子对象（PricingFieldsRmb）
 *
 * 超出范围或非数组/对象时返回 undefined，由调用方决定是否保留原值。
 */

const DUAL_CURRENCY_KEY_SET = new Set(['USD', 'RMB']);
const RMB_PRICING_KEY_SET = new Set(['inputPrice', 'outputPrice', 'cacheReadPrice', 'cacheWritePrice']);
const TOP_LEVEL_SHORTHAND_KEY_SET = new Set(['pricing', 'tiers']);
const TOP_LEVEL_EXPLICIT_KEY_SET = new Set([
    'inputPrice',
    'outputPrice',
    'pricing',
    'cacheReadPrice',
    'cacheWritePrice',
    'rmb',
    'tiers',
    'nativeCurrency'
]);
const TIER_SHORTHAND_KEY_SET = new Set(['pricing', 'cron', 'timezone', 'serviceTier', 'contextSizeMin']);
const TIER_EXPLICIT_KEY_SET = new Set([
    ...TIER_SHORTHAND_KEY_SET,
    'inputPrice',
    'outputPrice',
    'cacheReadPrice',
    'cacheWritePrice',
    'rmb',
    'nativeCurrency'
]);

function hasOnlyKnownKeys(value: object, allowedKeys: ReadonlySet<string>): boolean {
    return Object.keys(value).every(key => allowedKeys.has(key));
}

interface TokenPricingInputObjectLike {
    USD?: PricingArray;
    RMB?: PricingArray;
    inputPrice?: number;
    outputPrice?: number;
    pricing?: PricingInput;
    cacheReadPrice?: number;
    cacheWritePrice?: number;
    rmb?: PricingFieldsRmb;
    tiers?: PricingTierInput[];
    nativeCurrency?: 'USD' | 'RMB';
}

interface TokenPricingTierInputLike {
    pricing?: PricingArray;
    inputPrice?: number;
    outputPrice?: number;
    cacheReadPrice?: number;
    cacheWritePrice?: number;
    rmb?: PricingFieldsRmb;
    cron?: string;
    timezone?: string;
    serviceTier?: string;
    contextSizeMin?: number;
    nativeCurrency?: 'USD' | 'RMB';
}

/**
 * 从 PricingArray 提取价格字段，返回 [inputPrice, outputPrice, cacheReadPrice?, cacheWritePrice?]。
 * 校验失败返回 undefined。
 */
function extractPricingArrayFields(arr: PricingArray):
    | {
          inputPrice: number;
          outputPrice: number;
          cacheReadPrice?: number;
          cacheWritePrice?: number;
      }
    | undefined {
    if (arr.length < 2 || arr.length > 4) {
        return undefined;
    }
    const [inputPrice, outputPrice, cacheReadPrice, cacheWritePrice] = arr;
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
    const result: { inputPrice: number; outputPrice: number; cacheReadPrice?: number; cacheWritePrice?: number } = {
        inputPrice,
        outputPrice
    };
    if (cacheReadPrice !== undefined) {
        result.cacheReadPrice = cacheReadPrice;
    }
    if (cacheWritePrice !== undefined) {
        result.cacheWritePrice = cacheWritePrice;
    }
    return result;
}

/**
 * 从 DualCurrencyPricingMap 提取 USD 和 RMB 价格。
 * USD 数组 → 主价格字段；RMB 数组 → rmb 子对象。
 * 至少需要一个币种。
 */
function extractDualCurrencyPricing(map: DualCurrencyPricingMap):
    | {
          usd:
              | {
                    inputPrice: number;
                    outputPrice: number;
                    cacheReadPrice?: number;
                    cacheWritePrice?: number;
                    pricing: PricingArray;
                }
              | undefined;
          rmb: PricingFieldsRmb | undefined;
      }
    | undefined {
    if (!hasOnlyKnownKeys(map, DUAL_CURRENCY_KEY_SET)) {
        return undefined;
    }
    const usdArr = map.USD;
    const rmbArr = map.RMB;
    if (!usdArr && !rmbArr) {
        return undefined;
    }

    let usd:
        | {
              inputPrice: number;
              outputPrice: number;
              cacheReadPrice?: number;
              cacheWritePrice?: number;
              pricing: PricingArray;
          }
        | undefined;
    if (usdArr) {
        const fields = extractPricingArrayFields(usdArr);
        if (!fields) {
            return undefined;
        }
        usd = { ...fields, pricing: usdArr };
    }

    let rmb: PricingFieldsRmb | undefined;
    if (rmbArr) {
        const fields = extractPricingArrayFields(rmbArr);
        if (!fields) {
            return undefined;
        }
        rmb = { inputPrice: fields.inputPrice, outputPrice: fields.outputPrice };
        if (fields.cacheReadPrice !== undefined) {
            rmb.cacheReadPrice = fields.cacheReadPrice;
        }
        if (fields.cacheWritePrice !== undefined) {
            rmb.cacheWritePrice = fields.cacheWritePrice;
        }
    }

    return { usd, rmb };
}

function isValidRmbPricingFields(value: unknown): value is PricingFieldsRmb {
    if (typeof value !== 'object' || value === null) {
        return false;
    }
    if (!hasOnlyKnownKeys(value, RMB_PRICING_KEY_SET)) {
        return false;
    }
    const r = value as PricingFieldsRmb;
    if (
        typeof r.inputPrice !== 'number' ||
        typeof r.outputPrice !== 'number' ||
        !isFinite(r.inputPrice) ||
        !isFinite(r.outputPrice) ||
        r.inputPrice < 0 ||
        r.outputPrice < 0
    ) {
        return false;
    }
    if (
        r.cacheReadPrice !== undefined &&
        (typeof r.cacheReadPrice !== 'number' || !isFinite(r.cacheReadPrice) || r.cacheReadPrice < 0)
    ) {
        return false;
    }
    if (
        r.cacheWritePrice !== undefined &&
        (typeof r.cacheWritePrice !== 'number' || !isFinite(r.cacheWritePrice) || r.cacheWritePrice < 0)
    ) {
        return false;
    }
    return true;
}

function buildPricingArray(
    inputPrice: number,
    outputPrice: number,
    cacheReadPrice?: number,
    cacheWritePrice?: number
): PricingArray {
    if (cacheWritePrice !== undefined) {
        return [inputPrice, outputPrice, cacheReadPrice ?? 0, cacheWritePrice];
    }
    if (cacheReadPrice !== undefined) {
        return [inputPrice, outputPrice, cacheReadPrice];
    }
    return [inputPrice, outputPrice];
}

function buildPricingArrayFromFields(
    fields: Pick<PricingFields, 'inputPrice' | 'outputPrice' | 'cacheReadPrice' | 'cacheWritePrice'>
): PricingArray {
    return buildPricingArray(fields.inputPrice, fields.outputPrice, fields.cacheReadPrice, fields.cacheWritePrice);
}

function buildPricingArrayFromRmbFields(fields: PricingFieldsRmb): PricingArray {
    return buildPricingArray(fields.inputPrice, fields.outputPrice, fields.cacheReadPrice, fields.cacheWritePrice);
}

function isValidPricingArray(value: unknown): value is PricingArray {
    return Array.isArray(value) && extractPricingArrayFields(value as PricingArray) !== undefined;
}

function scaleRmbPricing(fields: PricingFieldsRmb, multiplier: number): PricingFieldsRmb {
    return {
        inputPrice: fields.inputPrice * multiplier,
        outputPrice: fields.outputPrice * multiplier,
        cacheReadPrice: fields.cacheReadPrice !== undefined ? fields.cacheReadPrice * multiplier : undefined,
        cacheWritePrice: fields.cacheWritePrice !== undefined ? fields.cacheWritePrice * multiplier : undefined
    };
}

function serializePricingInput(
    fields: Pick<PricingFields, 'inputPrice' | 'outputPrice' | 'cacheReadPrice' | 'cacheWritePrice'>,
    rmb?: PricingFieldsRmb
): PricingInput {
    const usdPricing = buildPricingArrayFromFields(fields);
    if (!rmb) {
        return usdPricing;
    }

    return { USD: usdPricing, RMB: buildPricingArrayFromRmbFields(rmb) };
}

function getTierMatchFields(tier: {
    cron?: string;
    timezone?: string;
    serviceTier?: string;
    contextSizeMin?: number;
}): Pick<PricingTier, 'cron' | 'timezone' | 'serviceTier' | 'contextSizeMin'> {
    return {
        cron: tier.cron,
        timezone: tier.timezone,
        serviceTier: tier.serviceTier,
        contextSizeMin: tier.contextSizeMin
    };
}

function hasValidTierMatchFields(tier: {
    cron?: string;
    timezone?: string;
    serviceTier?: string;
    contextSizeMin?: number;
}): boolean {
    if (tier.cron !== undefined && typeof tier.cron !== 'string') {
        return false;
    }
    if (tier.timezone !== undefined && typeof tier.timezone !== 'string') {
        return false;
    }
    if (tier.serviceTier !== undefined && typeof tier.serviceTier !== 'string') {
        return false;
    }
    if (tier.contextSizeMin !== undefined) {
        if (typeof tier.contextSizeMin !== 'number' || !isFinite(tier.contextSizeMin) || tier.contextSizeMin < 0) {
            return false;
        }
    }
    return true;
}

function normalizeShorthandTier(
    tier: PricingTierInput,
    basePricing: Pick<
        ModelTokenPricing,
        'inputPrice' | 'outputPrice' | 'cacheReadPrice' | 'cacheWritePrice' | 'rmb' | 'nativeCurrency'
    >
): PricingTier | undefined {
    if (!hasOnlyKnownKeys(tier, TIER_SHORTHAND_KEY_SET) || !hasValidTierMatchFields(tier)) {
        return undefined;
    }

    const tierMatchFields = getTierMatchFields(tier);
    if (Array.isArray(tier.pricing)) {
        const fields = extractPricingArrayFields(tier.pricing as PricingArray);
        if (!fields) {
            return undefined;
        }
        return {
            ...tierMatchFields,
            ...fields,
            pricing: tier.pricing as PricingArray
        };
    }

    if (typeof tier.pricing === 'object' && tier.pricing !== null) {
        const dual = extractDualCurrencyPricing(tier.pricing as DualCurrencyPricingMap);
        if (!dual || (!dual.usd && !dual.rmb)) {
            return undefined;
        }
        const converted: PricingTier =
            dual.usd ?
                {
                    ...tierMatchFields,
                    inputPrice: dual.usd.inputPrice,
                    outputPrice: dual.usd.outputPrice,
                    pricing: dual.usd.pricing,
                    cacheReadPrice: dual.usd.cacheReadPrice,
                    cacheWritePrice: dual.usd.cacheWritePrice
                }
            :   {
                    ...tierMatchFields,
                    inputPrice: convertRmbToUsd(dual.rmb!.inputPrice)!,
                    outputPrice: convertRmbToUsd(dual.rmb!.outputPrice)!,
                    cacheReadPrice:
                        dual.rmb!.cacheReadPrice !== undefined ? convertRmbToUsd(dual.rmb!.cacheReadPrice) : undefined,
                    cacheWritePrice:
                        dual.rmb!.cacheWritePrice !== undefined ?
                            convertRmbToUsd(dual.rmb!.cacheWritePrice)
                        :   undefined,
                    nativeCurrency: 'RMB'
                };
        if (dual.rmb) {
            converted.rmb = dual.rmb;
        }
        return converted;
    }

    if (typeof tier.pricing === 'number' && isFinite(tier.pricing) && tier.pricing >= 0) {
        const multiplier = tier.pricing;
        return {
            ...tierMatchFields,
            inputPrice: basePricing.inputPrice * multiplier,
            outputPrice: basePricing.outputPrice * multiplier,
            cacheReadPrice:
                basePricing.cacheReadPrice !== undefined ? basePricing.cacheReadPrice * multiplier : undefined,
            cacheWritePrice:
                basePricing.cacheWritePrice !== undefined ? basePricing.cacheWritePrice * multiplier : undefined,
            rmb: basePricing.rmb ? scaleRmbPricing(basePricing.rmb, multiplier) : undefined,
            ...(basePricing.nativeCurrency !== undefined ? { nativeCurrency: basePricing.nativeCurrency } : {})
        };
    }

    return undefined;
}

function normalizeShorthandTiers(
    tiers: PricingTierInput[] | undefined,
    basePricing: Pick<
        ModelTokenPricing,
        'inputPrice' | 'outputPrice' | 'cacheReadPrice' | 'cacheWritePrice' | 'rmb' | 'nativeCurrency'
    >
): PricingTier[] | undefined {
    if (tiers === undefined) {
        return undefined;
    }

    const normalizedTiers: PricingTier[] = [];
    for (const tier of tiers) {
        const normalizedTier = normalizeShorthandTier(tier, basePricing);
        if (!normalizedTier) {
            return undefined;
        }
        normalizedTiers.push(normalizedTier);
    }
    return normalizedTiers;
}

function normalizeExplicitTier(tier: TokenPricingTierInputLike): PricingTier | undefined {
    if (!hasOnlyKnownKeys(tier, TIER_EXPLICIT_KEY_SET) || !hasValidTierMatchFields(tier)) {
        return undefined;
    }
    if (
        typeof tier.inputPrice !== 'number' ||
        typeof tier.outputPrice !== 'number' ||
        !isFinite(tier.inputPrice) ||
        !isFinite(tier.outputPrice) ||
        tier.inputPrice < 0 ||
        tier.outputPrice < 0
    ) {
        return undefined;
    }
    if (
        tier.cacheReadPrice !== undefined &&
        (typeof tier.cacheReadPrice !== 'number' || !isFinite(tier.cacheReadPrice) || tier.cacheReadPrice < 0)
    ) {
        return undefined;
    }
    if (
        tier.cacheWritePrice !== undefined &&
        (typeof tier.cacheWritePrice !== 'number' || !isFinite(tier.cacheWritePrice) || tier.cacheWritePrice < 0)
    ) {
        return undefined;
    }
    if (tier.rmb !== undefined && !isValidRmbPricingFields(tier.rmb)) {
        return undefined;
    }
    if (tier.nativeCurrency !== undefined && tier.nativeCurrency !== 'USD' && tier.nativeCurrency !== 'RMB') {
        return undefined;
    }
    if (tier.pricing !== undefined && !isValidPricingArray(tier.pricing)) {
        return undefined;
    }

    const pricingFields = tier.pricing ? extractPricingArrayFields(tier.pricing) : undefined;

    return {
        inputPrice: tier.inputPrice,
        outputPrice: tier.outputPrice,
        ...(tier.pricing !== undefined ? { pricing: tier.pricing } : {}),
        ...(tier.cacheReadPrice !== undefined ? { cacheReadPrice: tier.cacheReadPrice }
        : pricingFields?.cacheReadPrice !== undefined ? { cacheReadPrice: pricingFields.cacheReadPrice }
        : {}),
        ...(tier.cacheWritePrice !== undefined ? { cacheWritePrice: tier.cacheWritePrice }
        : pricingFields?.cacheWritePrice !== undefined ? { cacheWritePrice: pricingFields.cacheWritePrice }
        : {}),
        ...(tier.rmb !== undefined ? { rmb: tier.rmb } : {}),
        ...(tier.nativeCurrency !== undefined ? { nativeCurrency: tier.nativeCurrency } : {}),
        ...getTierMatchFields(tier)
    };
}

export function serializeTokenPricingInput(pricing: ModelTokenPricing | undefined): ModelTokenPricingInput | undefined {
    if (!pricing) {
        return undefined;
    }

    return {
        pricing: serializePricingInput(pricing, pricing.rmb),
        ...(pricing.tiers && pricing.tiers.length > 0 ?
            {
                tiers: pricing.tiers.map(tier => ({
                    pricing: serializePricingInput(tier, tier.rmb),
                    cron: tier.cron,
                    timezone: tier.timezone,
                    serviceTier: tier.serviceTier,
                    contextSizeMin: tier.contextSizeMin
                }))
            }
        :   {})
    };
}

export function normalizeTokenPricing(
    pricing: ModelTokenPricingInput | null | undefined
): ModelTokenPricing | undefined {
    if (pricing === undefined || pricing === null) {
        return undefined;
    }

    // 1. 数组简写：[input, output, cacheRead?, cacheWrite?]（默认 USD）
    if (Array.isArray(pricing)) {
        const fields = extractPricingArrayFields(pricing as PricingArray);
        if (!fields) {
            return undefined;
        }
        const result: ModelTokenPricing = { ...fields, pricing };
        return result;
    }

    if (typeof pricing !== 'object') {
        return undefined;
    }

    const obj = pricing as TokenPricingInputObjectLike;

    // 2. 顶层双币映射：{ "USD": [...], "RMB": [...] }
    //    判断条件：对象有 USD 或 RMB 键，且无 inputPrice/outputPrice/pricing/tiers 等字段
    if (
        ('USD' in obj || 'RMB' in obj) &&
        obj.inputPrice === undefined &&
        obj.outputPrice === undefined &&
        obj.pricing === undefined &&
        obj.tiers === undefined
    ) {
        const dual = extractDualCurrencyPricing(obj as unknown as DualCurrencyPricingMap);
        if (!dual) {
            return undefined;
        }
        // 至少有 USD 或 RMB
        if (!dual.usd && !dual.rmb) {
            return undefined;
        }
        const result: ModelTokenPricing =
            dual.usd ?
                {
                    inputPrice: dual.usd.inputPrice,
                    outputPrice: dual.usd.outputPrice,
                    pricing: dual.usd.pricing,
                    cacheReadPrice: dual.usd.cacheReadPrice,
                    cacheWritePrice: dual.usd.cacheWritePrice
                }
                // 无 USD 时，从 RMB 按默认汇率换算 USD 主价格
            :   {
                    inputPrice: convertRmbToUsd(dual.rmb!.inputPrice)!,
                    outputPrice: convertRmbToUsd(dual.rmb!.outputPrice)!,
                    cacheReadPrice:
                        dual.rmb!.cacheReadPrice !== undefined ? convertRmbToUsd(dual.rmb!.cacheReadPrice) : undefined,
                    cacheWritePrice:
                        dual.rmb!.cacheWritePrice !== undefined ?
                            convertRmbToUsd(dual.rmb!.cacheWritePrice)
                        :   undefined,
                    nativeCurrency: 'RMB'
                };
        if (dual.rmb) {
            result.rmb = dual.rmb;
        }
        return result;
    }

    // 3. 对象形式：{ pricing: [...] | { "USD": [...], "RMB": [...] }, ... }
    //    兼容 { pricing: [1, 2] } 和 { pricing: { "USD": [1, 2], "RMB": [7, 14] } }

    // 3a. { pricing: [...] } 简写形式
    if (
        obj.inputPrice === undefined &&
        obj.outputPrice === undefined &&
        obj.pricing !== undefined &&
        Array.isArray(obj.pricing)
    ) {
        if (!hasOnlyKnownKeys(obj, TOP_LEVEL_SHORTHAND_KEY_SET)) {
            return undefined;
        }
        const fields = extractPricingArrayFields(obj.pricing as PricingArray);
        if (!fields) {
            return undefined;
        }
        const converted: ModelTokenPricing = {
            inputPrice: fields.inputPrice,
            outputPrice: fields.outputPrice,
            pricing: obj.pricing as PricingArray,
            cacheReadPrice: fields.cacheReadPrice,
            cacheWritePrice: fields.cacheWritePrice
        };
        const normalizedTiers = normalizeShorthandTiers(obj.tiers, converted);
        if (obj.tiers !== undefined && normalizedTiers === undefined) {
            return undefined;
        }
        if (normalizedTiers) {
            converted.tiers = normalizedTiers;
        }
        return converted;
    }

    // 3b. { pricing: { "USD": [...], "RMB": [...] } } 双币映射形式
    if (
        obj.inputPrice === undefined &&
        obj.outputPrice === undefined &&
        obj.pricing !== undefined &&
        typeof obj.pricing === 'object' &&
        !Array.isArray(obj.pricing)
    ) {
        if (!hasOnlyKnownKeys(obj, TOP_LEVEL_SHORTHAND_KEY_SET)) {
            return undefined;
        }
        const dual = extractDualCurrencyPricing(obj.pricing as DualCurrencyPricingMap);
        if (!dual) {
            return undefined;
        }
        if (!dual.usd && !dual.rmb) {
            return undefined;
        }
        const converted: ModelTokenPricing =
            dual.usd ?
                {
                    inputPrice: dual.usd.inputPrice,
                    outputPrice: dual.usd.outputPrice,
                    pricing: dual.usd.pricing,
                    cacheReadPrice: dual.usd.cacheReadPrice,
                    cacheWritePrice: dual.usd.cacheWritePrice
                }
            :   {
                    inputPrice: convertRmbToUsd(dual.rmb!.inputPrice)!,
                    outputPrice: convertRmbToUsd(dual.rmb!.outputPrice)!,
                    cacheReadPrice:
                        dual.rmb!.cacheReadPrice !== undefined ? convertRmbToUsd(dual.rmb!.cacheReadPrice) : undefined,
                    cacheWritePrice:
                        dual.rmb!.cacheWritePrice !== undefined ?
                            convertRmbToUsd(dual.rmb!.cacheWritePrice)
                        :   undefined,
                    nativeCurrency: 'RMB'
                };
        if (dual.rmb) {
            converted.rmb = dual.rmb;
        }
        const normalizedTiers = normalizeShorthandTiers(obj.tiers, converted);
        if (obj.tiers !== undefined && normalizedTiers === undefined) {
            return undefined;
        }
        if (normalizedTiers) {
            converted.tiers = normalizedTiers;
        }
        return converted;
    }

    // 3c. 显式对象形式：{ inputPrice, outputPrice, ... }
    if (!hasOnlyKnownKeys(obj, TOP_LEVEL_EXPLICIT_KEY_SET)) {
        return undefined;
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
    // rmb 校验
    if (obj.rmb !== undefined && !isValidRmbPricingFields(obj.rmb)) {
        return undefined;
    }
    if (obj.nativeCurrency !== undefined && obj.nativeCurrency !== 'USD' && obj.nativeCurrency !== 'RMB') {
        return undefined;
    }
    // pricing 字段校验（仅数组形式，双币映射已在 3b 处理）
    if (obj.pricing !== undefined) {
        if (typeof obj.pricing === 'object' && obj.pricing !== null && !Array.isArray(obj.pricing)) {
            // 显式主价格对象不接受 dual-currency pricing 映射，避免运行时 pricing 字段污染为对象
            return undefined;
        }
        if (!isValidPricingArray(obj.pricing)) {
            // pricing 为非法类型（字符串等）
            return undefined;
        }
    }

    const explicitPricingFields = obj.pricing ? extractPricingArrayFields(obj.pricing) : undefined;
    const normalizedExplicitPricing: ModelTokenPricing = {
        inputPrice: obj.inputPrice,
        outputPrice: obj.outputPrice,
        ...(Array.isArray(obj.pricing) ? { pricing: obj.pricing } : {}),
        ...(obj.cacheReadPrice !== undefined ? { cacheReadPrice: obj.cacheReadPrice }
        : explicitPricingFields?.cacheReadPrice !== undefined ? { cacheReadPrice: explicitPricingFields.cacheReadPrice }
        : {}),
        ...(obj.cacheWritePrice !== undefined ? { cacheWritePrice: obj.cacheWritePrice }
        : explicitPricingFields?.cacheWritePrice !== undefined ?
            { cacheWritePrice: explicitPricingFields.cacheWritePrice }
        :   {}),
        ...(obj.rmb !== undefined ? { rmb: obj.rmb } : {}),
        ...(obj.nativeCurrency !== undefined ? { nativeCurrency: obj.nativeCurrency } : {})
    };

    // 校验 tiers 数组结构
    if (obj.tiers !== undefined) {
        if (!Array.isArray(obj.tiers)) {
            return undefined;
        }
        const normalizedTiers: PricingTier[] = [];
        for (const tier of obj.tiers as Array<TokenPricingTierInputLike | unknown>) {
            if (typeof tier !== 'object' || tier === null) {
                return undefined;
            }
            const normalizedTier = normalizeExplicitTier(tier as TokenPricingTierInputLike);
            if (!normalizedTier) {
                return undefined;
            }
            normalizedTiers.push(normalizedTier);
        }
        return {
            ...normalizedExplicitPricing,
            tiers: normalizedTiers
        };
    }
    return normalizedExplicitPricing;
}
