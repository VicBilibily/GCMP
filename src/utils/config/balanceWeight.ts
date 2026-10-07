export interface BalanceWeightConfig {
    balanceWeight?: number;
}

export function isValidBalanceWeight(value: unknown): boolean {
    return value === undefined || (typeof value === 'number' && Number.isInteger(value) && value >= 0 && value <= 100);
}

export function getBalanceWeight(item: BalanceWeightConfig): number {
    if (!isValidBalanceWeight(item.balanceWeight)) {
        throw new RangeError('Weight must be an integer between 0 and 100 (权重必须是 0–100 的整数).');
    }
    return item.balanceWeight ?? 1;
}
