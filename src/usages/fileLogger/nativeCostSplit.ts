import { sumCosts } from '../../utils/pricingCurrency';

import type { NativeCostSplit, TokenRequestLog } from './types';

export function createEmptyNativeCostSplit(): NativeCostSplit {
    return {
        totalUsd: 0,
        totalRmb: 0,
        inputUsd: 0,
        inputRmb: 0,
        outputUsd: 0,
        outputRmb: 0,
        cacheReadUsd: 0,
        cacheReadRmb: 0,
        cacheWriteUsd: 0,
        cacheWriteRmb: 0
    };
}

export function hasNativeCostSplit(split: NativeCostSplit | undefined): split is NativeCostSplit {
    return split !== undefined;
}

export function mergeNativeCostSplit(target: NativeCostSplit, source: NativeCostSplit): void {
    target.totalUsd = sumCosts([target.totalUsd, source.totalUsd]);
    target.totalRmb = sumCosts([target.totalRmb, source.totalRmb]);
    target.inputUsd = sumCosts([target.inputUsd, source.inputUsd]);
    target.inputRmb = sumCosts([target.inputRmb, source.inputRmb]);
    target.outputUsd = sumCosts([target.outputUsd, source.outputUsd]);
    target.outputRmb = sumCosts([target.outputRmb, source.outputRmb]);
    target.cacheReadUsd = sumCosts([target.cacheReadUsd, source.cacheReadUsd]);
    target.cacheReadRmb = sumCosts([target.cacheReadRmb, source.cacheReadRmb]);
    target.cacheWriteUsd = sumCosts([target.cacheWriteUsd, source.cacheWriteUsd]);
    target.cacheWriteRmb = sumCosts([target.cacheWriteRmb, source.cacheWriteRmb]);
}

export function getLogNativeCostSplit(
    log: Pick<TokenRequestLog, 'estimatedCost' | 'costBreakdown'>
): NativeCostSplit | undefined {
    const usd = log.costBreakdown?.currencies?.USD;
    const rmb = log.costBreakdown?.currencies?.RMB;

    if (rmb) {
        return {
            totalUsd: 0,
            totalRmb: rmb.total,
            inputUsd: 0,
            inputRmb: rmb.cost[0] ?? 0,
            outputUsd: 0,
            outputRmb: rmb.cost[1] ?? 0,
            cacheReadUsd: 0,
            cacheReadRmb: rmb.cost[2] ?? 0,
            cacheWriteUsd: 0,
            cacheWriteRmb: rmb.cost[3] ?? 0
        };
    }

    const totalUsd = log.estimatedCost ?? usd?.total ?? 0;
    if (!(totalUsd > 0)) {
        return undefined;
    }

    return {
        totalUsd,
        totalRmb: 0,
        inputUsd: usd?.cost[0] ?? 0,
        inputRmb: 0,
        outputUsd: usd?.cost[1] ?? 0,
        outputRmb: 0,
        cacheReadUsd: usd?.cost[2] ?? 0,
        cacheReadRmb: 0,
        cacheWriteUsd: usd?.cost[3] ?? 0,
        cacheWriteRmb: 0
    };
}
