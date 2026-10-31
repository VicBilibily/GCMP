const MAX_ENTRIES = 1_000;
const ENTRY_TTL_MS = 7 * 24 * 60 * 60 * 1_000;

interface BalanceAffinityEntry {
    slot: string;
    credentialId: string;
    expiresAt: number;
}

export function getBalanceTurnKey(sessionId: string, telemetryTurn: unknown): string | undefined {
    if (typeof telemetryTurn !== 'number' || !Number.isSafeInteger(telemetryTurn) || telemetryTurn < 0) {
        return undefined;
    }
    return `m:${sessionId}:turn:${telemetryTurn}`;
}

export class BalanceAffinityCache {
    static readonly instance = new BalanceAffinityCache();

    private readonly entries = new Map<string, BalanceAffinityEntry>();

    constructor(private readonly now: () => number = () => Date.now()) {}

    get(slot: string, balanceKey: string, generation?: number): string | undefined {
        this.prune();
        return this.entries.get(this.getKey(slot, balanceKey, generation))?.credentialId;
    }

    remember(slot: string, balanceKey: string, credentialId: string, generation?: number): void {
        this.prune();
        const key = this.getKey(slot, balanceKey, generation);
        this.entries.delete(key);
        this.entries.set(key, { slot, credentialId, expiresAt: this.now() + ENTRY_TTL_MS });
        if (this.entries.size > MAX_ENTRIES) {
            const oldestKey = this.entries.keys().next().value;
            if (oldestKey !== undefined) {
                this.entries.delete(oldestKey);
            }
        }
    }

    clear(slot?: string): void {
        if (slot === undefined) {
            this.entries.clear();
            return;
        }
        for (const [key, entry] of this.entries) {
            if (entry.slot === slot) {
                this.entries.delete(key);
            }
        }
    }

    private prune(): void {
        const now = this.now();
        for (const [key, entry] of this.entries) {
            if (entry.expiresAt <= now) {
                this.entries.delete(key);
            }
        }
    }

    private getKey(slot: string, balanceKey: string, generation?: number): string {
        return generation === undefined ?
                JSON.stringify([slot, balanceKey])
            :   JSON.stringify([slot, balanceKey, generation]);
    }
}
