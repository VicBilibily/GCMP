/*---------------------------------------------------------------------------------------------
 *  定价/币种换算与成本量化工具
 *--------------------------------------------------------------------------------------------*/

export const RMB_TO_USD_RATE = 7.0;
export const USD_TO_RMB_RATE = RMB_TO_USD_RATE;
export const COST_DECIMAL_PLACES = 6;

const COST_SCALE = 10 ** COST_DECIMAL_PLACES;
const SCALE_EPSILON = 1e-9;

export function toCostMicros(value: number | null | undefined): number {
    if (value === undefined || value === null || !Number.isFinite(value)) {
        return 0;
    }
    const scaled = value * COST_SCALE;
    return scaled >= 0 ? Math.floor(scaled + SCALE_EPSILON) : Math.ceil(scaled - SCALE_EPSILON);
}

export function fromCostMicros(value: number): number {
    return value / COST_SCALE;
}

export function truncateCost(value: number | null | undefined): number | undefined {
    if (value === undefined || value === null || !Number.isFinite(value)) {
        return undefined;
    }
    return fromCostMicros(toCostMicros(value));
}

export function sumCosts(values: Array<number | null | undefined>): number {
    let totalMicros = 0;
    for (const value of values) {
        totalMicros += toCostMicros(value);
    }
    return fromCostMicros(totalMicros);
}

export function convertUsdToRmb(value: number | null | undefined): number | undefined {
    if (value === undefined || value === null || !Number.isFinite(value)) {
        return undefined;
    }
    return truncateCost(value * USD_TO_RMB_RATE);
}

export function convertRmbToUsd(value: number | null | undefined): number | undefined {
    if (value === undefined || value === null || !Number.isFinite(value)) {
        return undefined;
    }
    return truncateCost(value / RMB_TO_USD_RATE);
}
