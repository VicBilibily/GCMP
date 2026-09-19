export const DEFAULT_BALANCE_WARNING_THRESHOLD = 20;

export type BalanceAlertLevel = 'none' | 'warning' | 'error';

export function resolveBalanceWarningThreshold(value: unknown): number {
    return typeof value === 'number' && Number.isFinite(value) && value >= 0 ?
            value
        :   DEFAULT_BALANCE_WARNING_THRESHOLD;
}

export function getBalanceAlertLevel(balance: number | undefined, warningThreshold: number): BalanceAlertLevel {
    if (balance === undefined || !Number.isFinite(balance)) {
        return 'none';
    }
    if (balance < 0) {
        return 'error';
    }
    return balance <= warningThreshold ? 'warning' : 'none';
}

export function getHighestBalanceAlertLevel(
    balances: ReadonlyArray<{ balance: number | undefined; warningThreshold: number }>
): BalanceAlertLevel {
    let level: BalanceAlertLevel = 'none';
    for (const item of balances) {
        const current = getBalanceAlertLevel(item.balance, item.warningThreshold);
        if (current === 'error') {
            return 'error';
        }
        if (current === 'warning') {
            level = 'warning';
        }
    }
    return level;
}
