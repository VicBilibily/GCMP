import { convertUsdToRmb } from '../utils/pricingCurrency';
import { formatCost } from './utils';

export type DisplayCurrency = 'MIXED' | 'USD' | 'RMB';

export interface CostDisplayStatsLike {
    estimatedCost?: number;
    estimatedCostRmb?: number;
    costedRequests?: number;
    rmbExactRequests?: number;
}

export interface DisplayCostSegment {
    text: string;
    currency: 'USD' | 'RMB';
}

export interface DisplayCostPresentation {
    text: string;
    segments: DisplayCostSegment[];
}

function hasPositiveCost(value: number | undefined): value is number {
    return value !== undefined && value > 0;
}

export function getDisplayCostPresentation(options: {
    usd?: number;
    rmb?: number;
    nativeUsd?: number;
    nativeRmb?: number;
    currency: DisplayCurrency;
    fixedDecimals?: number;
    exactRmb?: boolean;
}): DisplayCostPresentation {
    const { usd, rmb, nativeUsd, nativeRmb, currency, fixedDecimals, exactRmb = false } = options;
    if (!hasPositiveCost(usd) && !hasPositiveCost(rmb)) {
        return { text: '', segments: [] };
    }

    const usdText = hasPositiveCost(usd) ? formatCost(usd, fixedDecimals) : '';

    if (currency === 'MIXED') {
        const hasNativeUsd = hasPositiveCost(nativeUsd);
        const hasNativeRmb = hasPositiveCost(nativeRmb);
        const mixedUsd =
            hasNativeUsd ? nativeUsd
            : !hasNativeRmb && !exactRmb ? usd
            : undefined;
        const mixedRmb =
            hasNativeRmb ? nativeRmb
            : !hasNativeUsd && exactRmb ? rmb
            : undefined;
        const segments: DisplayCostSegment[] = [];
        if (hasPositiveCost(mixedUsd)) {
            segments.push({
                text: formatCost(mixedUsd, fixedDecimals),
                currency: 'USD'
            });
        }
        if (hasPositiveCost(mixedRmb)) {
            segments.push({
                text: formatCost(mixedRmb, { fixedDecimals, currencySymbol: '¥' }),
                currency: 'RMB'
            });
        }
        return {
            text: segments.map(segment => segment.text).join(' + '),
            segments
        };
    }

    if (currency === 'USD') {
        const segments = usdText ? [{ text: usdText, currency: 'USD' as const }] : [];
        return {
            text: usdText,
            segments
        };
    }

    const displayRmb = hasPositiveCost(rmb) ? rmb : (convertUsdToRmb(usd) ?? 0);
    const rmbText = displayRmb > 0 ? formatCost(displayRmb, { fixedDecimals, currencySymbol: '¥' }) : '';
    const segments = rmbText ? [{ text: rmbText, currency: 'RMB' as const }] : [];
    return {
        text: rmbText,
        segments
    };
}

export function formatDisplayCostAmount(options: {
    usd?: number;
    rmb?: number;
    nativeUsd?: number;
    nativeRmb?: number;
    currency: DisplayCurrency;
    fixedDecimals?: number;
    exactRmb?: boolean;
}): string {
    return getDisplayCostPresentation(options).text;
}

export function formatDisplayCostFromStats(
    stats: CostDisplayStatsLike,
    currency: DisplayCurrency,
    fixedDecimals?: number
): string {
    const usd = stats.estimatedCost ?? 0;
    if (!(usd > 0)) {
        return '';
    }

    const exactRmb = stats.estimatedCostRmb;
    const costedRequests = stats.costedRequests ?? 0;
    const rmbExactRequests = stats.rmbExactRequests ?? 0;
    return formatDisplayCostAmount({
        usd,
        rmb: exactRmb,
        currency,
        fixedDecimals,
        exactRmb: costedRequests > 0 && rmbExactRequests >= costedRequests
    });
}

export function formatDisplayCostFromUsd(
    usd: number | undefined,
    currency: DisplayCurrency,
    fixedDecimals?: number,
    approximateRmb = true
): string {
    if (!(usd && usd > 0)) {
        return '';
    }

    return formatDisplayCostAmount({
        usd,
        currency,
        fixedDecimals,
        exactRmb: !approximateRmb
    });
}
