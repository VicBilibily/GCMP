/*---------------------------------------------------------------------------------------------
 *  Cost Calculator — 客户端 Token 成本估算
 *  参考 Copilot CLI 的 yF9() 实现，根据 usage + pricing 计算预估费用。
 *--------------------------------------------------------------------------------------------*/

import type { ModelTokenPricing, ModelTokenPricingInput, PricingFieldsRmb, PricingTier } from '../types/sharedTypes';
import type {
    CostBreakdownLog,
    CostVector,
    CurrencyCostBreakdownLog,
    GenericUsageData
} from '../usages/fileLogger/types';
import { UsageParser } from '../usages/fileLogger/usageParser';
import { resolveActiveTier, normalizeTokenPricing } from './pricingTierResolver';
import { sumCosts, truncateCost } from './pricingCurrency';

/**
 * 镜像 Anthropic SDK 的 Usage 结构，允许传入部分字段。
 */
export interface RawTokenUsage {
    input_tokens?: number | null;
    output_tokens?: number | null;
    cache_read_input_tokens?: number | null;
    cache_creation_input_tokens?: number | null;
    /** 来自 Anthropic stream event 的 usage.cache_creation 嵌套字段 */
    cache_creation?: {
        ephemeral_5m_input_tokens?: number | null;
        ephemeral_1h_input_tokens?: number | null;
    } | null;
    /** 兼容 OpenAI 风格 */
    prompt_tokens?: number;
    completion_tokens?: number;
    total_tokens?: number;
    prompt_tokens_details?: {
        cached_tokens?: number;
        cache_creation_input_tokens?: number;
    };
    /** 兼容 Responses API 风格 */
    input_tokens_details?: {
        cached_tokens?: number;
    };
    /** 兼容 usageMetadata */
    promptTokenCount?: number;
    responseTokenCount?: number;
    candidatesTokenCount?: number;
    totalTokenCount?: number;
    cachedContentTokenCount?: number;
}

const TOKENS_PER_MILLION = 1_000_000;

/**
 * 根据 token 用量和定价计算预估成本。
 *
 * @param pricing 模型定价配置，支持 {inputPrice, outputPrice, ...} 对象或 [inputPrice, outputPrice, cacheReadPrice?, cacheWritePrice?] 数组简写
 */
export function calculateCost(
    usage: RawTokenUsage | undefined,
    pricing: ModelTokenPricingInput | undefined,
    at: Date = new Date(),
    requestServiceTier?: string
): number {
    return calculateCostWithBreakdown(usage, pricing, at, requestServiceTier)?.total ?? 0;
}

/**
 * 成本计算明细，用于 debug 日志输出。
 */
export interface CostBreakdown {
    inputTokens: number;
    outputTokens: number;
    cacheReadTokens: number;
    cacheCreationTokens: number;
    inputCost: number;
    outputCost: number;
    cacheReadCost: number;
    cacheWriteCost: number;
    total: number;
    /**
     * 生效的定价档位标识（峰谷定价时用于日志区分）。
     * - undefined：使用静态单档（未配置 tiers 或无 tier 命中）
     * - 其他值：匹配到的 tier 的 cron 表达式，便于在日志中回溯
     */
    activeTierCron?: string;
    /**
     * 生效的 serviceTier 标识（按服务等级计费时用于日志区分）。
     * 当 tier 配置了 serviceTier 且命中时，记录该值便于日志回溯。
     */
    activeTierServiceTier?: string;
    /**
     * 实际生效的单价（来自 tier 或回退到静态单档），供日志准确展示。
     * 单位：USD / 百万 token。
     */
    effectiveInputPrice: number;
    effectiveOutputPrice: number;
    effectiveCacheReadPrice?: number;
    effectiveCacheWritePrice?: number;
    effectiveRmbPricing?: PricingFieldsRmb;
    inputCostRmb?: number;
    outputCostRmb?: number;
    cacheReadCostRmb?: number;
    cacheWriteCostRmb?: number;
    totalRmb?: number;
}

interface ResolvedPricingBreakdown {
    activeTier?: PricingTier;
    effectivePricing: Pick<ModelTokenPricing, 'inputPrice' | 'outputPrice' | 'cacheReadPrice' | 'cacheWritePrice'>;
    effectivePricingRmb?: PricingFieldsRmb;
}

function mergeRmbPricing(primary?: PricingFieldsRmb, fallback?: PricingFieldsRmb): PricingFieldsRmb | undefined {
    const inputPrice = primary?.inputPrice ?? fallback?.inputPrice;
    const outputPrice = primary?.outputPrice ?? fallback?.outputPrice;
    if (inputPrice === undefined || outputPrice === undefined) {
        return undefined;
    }

    return {
        inputPrice,
        outputPrice,
        cacheReadPrice: primary?.cacheReadPrice ?? fallback?.cacheReadPrice,
        cacheWritePrice: primary?.cacheWritePrice ?? fallback?.cacheWritePrice
    };
}

function toCostVector(input: number, output: number, cacheRead?: number, cacheWrite?: number): CostVector {
    const vector: CostVector = [input, output];
    if (cacheWrite !== undefined) {
        vector[2] = cacheRead ?? 0;
        vector[3] = cacheWrite;
        return vector;
    }
    if (cacheRead !== undefined) {
        vector[2] = cacheRead;
    }
    return vector;
}

function toCurrencyCostBreakdownLog(
    inputPrice: number,
    outputPrice: number,
    cacheReadPrice: number | undefined,
    cacheWritePrice: number | undefined,
    inputCost: number,
    outputCost: number,
    cacheReadCost: number,
    cacheWriteCost: number,
    total: number
): CurrencyCostBreakdownLog {
    return {
        pricing: toCostVector(
            truncateCost(inputPrice) ?? 0,
            truncateCost(outputPrice) ?? 0,
            truncateCost(cacheReadPrice),
            truncateCost(cacheWritePrice)
        ),
        cost: toCostVector(
            truncateCost(inputCost) ?? 0,
            truncateCost(outputCost) ?? 0,
            truncateCost(cacheReadCost),
            truncateCost(cacheWriteCost)
        ),
        total: truncateCost(total) ?? 0
    };
}

/**
 * 解析请求实际生效的定价信息（含命中的 activeTier）。
 *
 * 在 resolveActiveTier 的 cron + serviceTier 匹配基础上，额外检查 contextSizeMin：
 * 默认按输入与输出之和比较；contextSizeInputOnly 为 true 时仅按输入比较。
 * 若命中的 tier 不满足 contextSizeMin，跳过它继续检查下一个 tier。
 *
 * @param actualInput 从 usage 解析出的实际 input token 数（含缓存）
 * @param outputTokens 从 usage 解析出的实际 output token 数
 *
 * 导出供测试直接验证 contextSizeMin 回退逻辑。
 */
export function resolvePricingBreakdown(
    pricing: ModelTokenPricing | undefined,
    at: Date,
    requestServiceTier?: string,
    actualInput?: number,
    outputTokens?: number
): ResolvedPricingBreakdown | undefined {
    if (!pricing) {
        return undefined;
    }

    // 先按 cron + serviceTier 匹配（不含 contextSizeMin）
    const activeTier = resolveActiveTier(pricing, at, requestServiceTier);
    if (activeTier) {
        // contextSizeMin 检查：contextSizeInputOnly 为 true 时排除输出 token
        const effectiveInput =
            actualInput === undefined ? undefined
            : activeTier.contextSizeInputOnly ? actualInput
            : actualInput + Math.max(0, outputTokens ?? 0);
        if (
            activeTier.contextSizeMin === undefined ||
            (effectiveInput !== undefined && effectiveInput >= activeTier.contextSizeMin)
        ) {
            return {
                activeTier,
                effectivePricing: {
                    inputPrice: activeTier.inputPrice,
                    outputPrice: activeTier.outputPrice,
                    cacheReadPrice: activeTier.cacheReadPrice ?? pricing.cacheReadPrice,
                    cacheWritePrice: activeTier.cacheWritePrice ?? pricing.cacheWritePrice
                },
                effectivePricingRmb: mergeRmbPricing(activeTier.rmb, pricing.rmb)
            };
        }
        // contextSizeMin 不满足 → 移除该 tier，用剩余 tiers 重新匹配
        const remainingTiers = pricing.tiers?.filter(t => t !== activeTier);
        if (remainingTiers && remainingTiers.length > 0) {
            const retryPricing: ModelTokenPricing = { ...pricing, tiers: remainingTiers };
            const retryResult = resolvePricingBreakdown(
                retryPricing,
                at,
                requestServiceTier,
                actualInput,
                outputTokens
            );
            if (retryResult) {
                return retryResult;
            }
        }
        // 无剩余 tier 或剩余 tier 都不匹配 → 回退静态单档
        return {
            activeTier: undefined,
            effectivePricing: {
                inputPrice: pricing.inputPrice,
                outputPrice: pricing.outputPrice,
                cacheReadPrice: pricing.cacheReadPrice,
                cacheWritePrice: pricing.cacheWritePrice
            },
            effectivePricingRmb: pricing.rmb
        };
    }

    // 无 tier 命中 → 回退静态单档
    return {
        activeTier: undefined,
        effectivePricing: {
            inputPrice: pricing.inputPrice,
            outputPrice: pricing.outputPrice,
            cacheReadPrice: pricing.cacheReadPrice,
            cacheWritePrice: pricing.cacheWritePrice
        },
        effectivePricingRmb: pricing.rmb
    };
}

/**
 * 将 USD 成本换算为 nano-AIU。
 *
 * 对任意正成本使用 `Math.ceil`，避免极小的非零成本被 `Math.round()` 舍入为 0，
 * 从而在 usage DataPart 中伪装成“零成本请求”。
 */
export function toNanoAiu(cost: number): number | undefined {
    if (!(cost > 0)) {
        return undefined;
    }
    return Math.ceil(cost * 1_000_000_000);
}

/**
 * 生成统一的成本明细日志文本。
 *
 * 只负责格式化，不做阈值/是否输出判断；调用方可据 `breakdown.total` 决定是否记录。
 */
export function formatCostBreakdownLog(modelName: string, breakdown: CostBreakdown): string {
    return (
        `[${modelName}] Cost breakdown:\n` +
        `  pricing  $${breakdown.effectiveInputPrice} $${breakdown.effectiveOutputPrice}` +
        (breakdown.effectiveCacheReadPrice !== undefined ? ` $${breakdown.effectiveCacheReadPrice}` : '') +
        (breakdown.effectiveCacheWritePrice !== undefined ? ` $${breakdown.effectiveCacheWritePrice}` : '') +
        ' per 1M tokens (USD)\n' +
        (breakdown.activeTierCron || breakdown.activeTierServiceTier ?
            `  tier     ${breakdown.activeTierCron || 'all-time'}` +
            (breakdown.activeTierServiceTier ? ` (serviceTier: ${breakdown.activeTierServiceTier})` : '') +
            '\n'
        :   '') +
        `  usage   input=${breakdown.inputTokens} output=${breakdown.outputTokens}` +
        (breakdown.cacheReadTokens > 0 ? ` cacheRead=${breakdown.cacheReadTokens}` : '') +
        (breakdown.cacheCreationTokens > 0 ? ` cacheWrite=${breakdown.cacheCreationTokens}` : '') +
        '\n' +
        `  subtotal input=$${breakdown.inputCost.toFixed(6)} output=$${breakdown.outputCost.toFixed(6)}` +
        (breakdown.cacheReadCost > 0 ? ` cacheRead=$${breakdown.cacheReadCost.toFixed(6)}` : '') +
        (breakdown.cacheWriteCost > 0 ? ` cacheWrite=$${breakdown.cacheWriteCost.toFixed(6)}` : '') +
        '\n' +
        `  total=$${breakdown.total.toFixed(6)} (${toNanoAiu(breakdown.total) ?? 0} nano-AIU)`
    );
}

/**
 * 计算成本并返回明细（供 handler 写 debug 日志）。
 *
 * @param pricing 模型定价配置，支持 {inputPrice, outputPrice, ...} 对象或 [inputPrice, outputPrice, cacheReadPrice?, cacheWritePrice?] 数组简写
 * @param at 请求发生时间，用于峰谷定价 tier 匹配。默认当前时间。
 * @param requestServiceTier 请求携带的 serviceTier，用于按服务等级计费的 tier 匹配。
 */
export function calculateCostWithBreakdown(
    usage: RawTokenUsage | undefined,
    pricing: ModelTokenPricingInput | undefined,
    at: Date = new Date(),
    requestServiceTier?: string
): CostBreakdown | undefined {
    if (!usage || !pricing) {
        return undefined;
    }

    // 支持数组简写形式：在入口处归一化，后续逻辑统一按对象处理
    const normalizedPricing = normalizeTokenPricing(pricing);
    if (!normalizedPricing) {
        return undefined;
    }

    const parsed = UsageParser.parseRawUsage(usage as GenericUsageData);
    const actualInput = parsed.actualInput;
    const outputTokens = Math.max(0, parsed.outputTokens);
    const cacheReadTokens = Math.max(0, parsed.cacheReadTokens);

    const resolvedPricing = resolvePricingBreakdown(
        normalizedPricing,
        at,
        requestServiceTier,
        actualInput,
        outputTokens
    );
    if (!resolvedPricing) {
        return undefined;
    }

    const { activeTier, effectivePricing, effectivePricingRmb } = resolvedPricing;

    const cacheCreationTokens = getExplicitCacheWriteTokens(usage);
    const inputTokens = getUncachedInputTokens(usage, parsed.actualInput, cacheReadTokens, cacheCreationTokens);

    const inputCost = truncateCost((inputTokens / TOKENS_PER_MILLION) * effectivePricing.inputPrice) ?? 0;
    const outputCost = truncateCost((outputTokens / TOKENS_PER_MILLION) * effectivePricing.outputPrice) ?? 0;
    const cacheReadCost =
        cacheReadTokens > 0 && effectivePricing.cacheReadPrice !== undefined ?
            (truncateCost((cacheReadTokens / TOKENS_PER_MILLION) * effectivePricing.cacheReadPrice) ?? 0)
        :   0;
    const cacheWriteCost =
        cacheCreationTokens > 0 && effectivePricing.cacheWritePrice !== undefined ?
            (truncateCost((cacheCreationTokens / TOKENS_PER_MILLION) * effectivePricing.cacheWritePrice) ?? 0)
        :   0;

    const inputCostRmb =
        effectivePricingRmb ?
            truncateCost((inputTokens / TOKENS_PER_MILLION) * effectivePricingRmb.inputPrice)
        :   undefined;
    const outputCostRmb =
        effectivePricingRmb ?
            truncateCost((outputTokens / TOKENS_PER_MILLION) * effectivePricingRmb.outputPrice)
        :   undefined;
    const cacheReadCostRmb =
        cacheReadTokens > 0 && effectivePricingRmb?.cacheReadPrice !== undefined ?
            truncateCost((cacheReadTokens / TOKENS_PER_MILLION) * effectivePricingRmb.cacheReadPrice)
        :   undefined;
    const cacheWriteCostRmb =
        cacheCreationTokens > 0 && effectivePricingRmb?.cacheWritePrice !== undefined ?
            truncateCost((cacheCreationTokens / TOKENS_PER_MILLION) * effectivePricingRmb.cacheWritePrice)
        :   undefined;
    const totalRmb =
        effectivePricingRmb ? sumCosts([inputCostRmb, outputCostRmb, cacheReadCostRmb, cacheWriteCostRmb]) : undefined;

    return {
        inputTokens,
        outputTokens,
        cacheReadTokens,
        cacheCreationTokens,
        inputCost,
        outputCost,
        cacheReadCost,
        cacheWriteCost,
        total: Math.max(0, sumCosts([inputCost, outputCost, cacheReadCost, cacheWriteCost])),
        activeTierCron: activeTier?.cron,
        activeTierServiceTier: activeTier?.serviceTier,
        effectiveInputPrice: effectivePricing.inputPrice,
        effectiveOutputPrice: effectivePricing.outputPrice,
        effectiveCacheReadPrice: effectivePricing.cacheReadPrice,
        effectiveCacheWritePrice: effectivePricing.cacheWritePrice,
        effectiveRmbPricing: effectivePricingRmb,
        inputCostRmb,
        outputCostRmb,
        cacheReadCostRmb,
        cacheWriteCostRmb,
        totalRmb
    };
}

function getExplicitCacheWriteTokens(usage: RawTokenUsage): number {
    // cache_creation_input_tokens（顶层）与 cache_creation.ephemeral_*_input_tokens（嵌套）
    // 是同一缓存写入事件的不同表示，并非可叠加的独立来源。
    // 取 max 防止两者同时出现时重复计费。
    const topLevel = typeof usage.cache_creation_input_tokens === 'number' ? usage.cache_creation_input_tokens : 0;
    const nested5m = usage.cache_creation?.ephemeral_5m_input_tokens ?? 0;
    const nested1h = usage.cache_creation?.ephemeral_1h_input_tokens ?? 0;
    return Math.max(0, topLevel, nested5m + nested1h);
}

function getUncachedInputTokens(
    usage: RawTokenUsage,
    actualInputTokens: number,
    cacheReadTokens: number,
    cacheCreationTokens: number
): number {
    // Anthropic/Claude 风格：input_tokens 不含缓存 token，可直接信任。
    // 注意：此判断依赖 input_tokens_details?.cached_tokens 为 undefined 作为 Anthropic 信号，
    // 若未来有 provider 设置 input_tokens（含缓存）但未填充 input_tokens_details，会产生过计费。
    if (typeof usage.input_tokens === 'number' && usage.input_tokens_details?.cached_tokens === undefined) {
        return Math.max(0, usage.input_tokens);
    }

    return Math.max(0, actualInputTokens - cacheReadTokens - cacheCreationTokens);
}

/**
 * 将 CostBreakdown 转为精简日志格式 CostBreakdownLog。
 * 字段顺序固定：tokens/pricing/cost 均为 [input, output, cacheRead, cacheWrite]。
 */
export function toCostBreakdownLog(breakdown: CostBreakdown): CostBreakdownLog {
    const activeTier =
        breakdown.activeTierCron || breakdown.activeTierServiceTier ?
            [breakdown.activeTierCron, breakdown.activeTierServiceTier].filter(Boolean).join(' ')
        :   undefined;

    const usd = toCurrencyCostBreakdownLog(
        breakdown.effectiveInputPrice,
        breakdown.effectiveOutputPrice,
        breakdown.effectiveCacheReadPrice,
        breakdown.effectiveCacheWritePrice,
        breakdown.inputCost,
        breakdown.outputCost,
        breakdown.cacheReadCost,
        breakdown.cacheWriteCost,
        breakdown.total
    );

    const rmb =
        (
            breakdown.effectiveRmbPricing &&
            breakdown.inputCostRmb !== undefined &&
            breakdown.outputCostRmb !== undefined &&
            breakdown.totalRmb !== undefined
        ) ?
            toCurrencyCostBreakdownLog(
                breakdown.effectiveRmbPricing.inputPrice,
                breakdown.effectiveRmbPricing.outputPrice,
                breakdown.effectiveRmbPricing.cacheReadPrice,
                breakdown.effectiveRmbPricing.cacheWritePrice,
                breakdown.inputCostRmb,
                breakdown.outputCostRmb,
                breakdown.cacheReadCostRmb ?? 0,
                breakdown.cacheWriteCostRmb ?? 0,
                breakdown.totalRmb
            )
        :   undefined;

    return {
        tokens: [
            breakdown.inputTokens,
            breakdown.outputTokens,
            breakdown.cacheReadTokens,
            breakdown.cacheCreationTokens
        ],
        pricing: usd.pricing,
        cost: usd.cost,
        total: usd.total,
        activeTier,
        currencies: {
            USD: usd,
            ...(rmb ? { RMB: rmb } : {})
        }
    };
}
