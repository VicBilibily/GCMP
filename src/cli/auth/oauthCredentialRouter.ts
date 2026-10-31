import { createHash } from 'node:crypto';
import type {
    OAuthCredentialEntry,
    OAuthCredentialRoutingSettings,
    OAuthCredentialSelection,
    OAuthCredentialSwitchMode
} from './oauthCredentialStore';

export interface OAuthRouteAttempt {
    mode: Exclude<OAuthCredentialSwitchMode, 'off'>;
    credentialName: string;
    apiKey: string;
    identity: string;
    selection: OAuthCredentialSelection;
}

export interface OAuthRouteDecision {
    handled: boolean;
    shouldRetry: boolean;
}

interface OAuthRoutingStore {
    getRoutingSettings(provider: string): OAuthCredentialRoutingSettings;
    getActiveCredentialSelection(provider: string): OAuthCredentialSelection;
    listCredentials(provider: string): OAuthCredentialEntry[];
    setActiveCredentialIfCurrent(
        provider: string,
        selection: OAuthCredentialSelection,
        name: string
    ): Promise<OAuthCredentialSelection | undefined>;
}

interface OAuthAuthenticator {
    ensureAuthenticatedForOAuthCredential(
        provider: string,
        credentialName: string
    ): Promise<{ access_token?: string } | null>;
}

interface OAuthApiKeySync {
    setApiKeyForActiveCliCredential(
        provider: string,
        selection: OAuthCredentialSelection,
        apiKey: string
    ): Promise<boolean>;
}

interface OAuthBalanceAffinity {
    get(provider: string, balanceKey: string, generation?: number): string | undefined;
    remember(provider: string, balanceKey: string, credentialId: string, generation?: number): void;
    clear(provider: string): void;
}

export interface OAuthCredentialRouterDependencies {
    store: OAuthRoutingStore;
    authenticator: OAuthAuthenticator;
    apiKeySync: OAuthApiKeySync;
    balanceAffinity: OAuthBalanceAffinity;
}

interface WeightedCredential {
    entry: OAuthCredentialEntry;
    weight: number;
}

export class OAuthCredentialRouter {
    constructor(private readonly dependencies: OAuthCredentialRouterDependencies) {}

    getCandidateCount(provider: string): number {
        const settings = this.dependencies.store.getRoutingSettings(provider);
        if (settings.mode === 'off') {
            return 0;
        }
        return this.getCandidates(provider, settings).length;
    }

    async captureAttempt(
        provider: string,
        balanceKey: string,
        preferredCredentialId?: string,
        preferredRoutingGeneration?: number
    ): Promise<OAuthRouteAttempt | undefined> {
        const settings = this.dependencies.store.getRoutingSettings(provider);
        if (settings.mode === 'off') {
            return undefined;
        }
        const candidates = this.getCandidates(provider, settings);
        const minimumCandidates = settings.mode === 'failover' ? 2 : 1;
        if (candidates.length < minimumCandidates) {
            return undefined;
        }

        const selection = this.dependencies.store.getActiveCredentialSelection(provider);
        if (settings.mode === 'failover') {
            const current = candidates.find(candidate => candidate.entry.name === selection.name);
            const startIndex = current ? candidates.indexOf(current) : 0;
            return await this.captureFailoverCandidate(provider, candidates, startIndex, selection);
        }

        const cachedAffinity = this.dependencies.balanceAffinity.get(provider, balanceKey, settings.generation);
        const isPreferredCurrent =
            preferredRoutingGeneration === undefined || preferredRoutingGeneration === settings.generation;
        const preferred =
            (isPreferredCurrent ?
                candidates.find(candidate => this.identity(provider, candidate.entry.name) === preferredCredentialId)
            :   undefined) ??
            candidates.find(candidate => this.identity(provider, candidate.entry.name) === cachedAffinity) ??
            candidates.find(candidate => candidate.entry.name === cachedAffinity);
        const weighted = preferred ?? this.selectWeightedCandidate(provider, balanceKey, candidates);
        const startIndex = weighted ? candidates.indexOf(weighted) : 0;
        for (let offset = 0; offset < candidates.length; offset += 1) {
            const candidate = candidates[(startIndex + offset) % candidates.length];
            if (!candidate) {
                continue;
            }
            const credentials = await this.dependencies.authenticator.ensureAuthenticatedForOAuthCredential(
                provider,
                candidate.entry.name
            );
            if (!credentials?.access_token) {
                continue;
            }
            this.dependencies.balanceAffinity.remember(
                provider,
                balanceKey,
                this.identity(provider, candidate.entry.name),
                settings.generation
            );
            return this.toAttempt('balance', provider, candidate.entry.name, credentials.access_token, selection);
        }
        throw new Error(`No OAuth account could authenticate for ${provider}.`);
    }

    async handleFailure(
        provider: string,
        attempt: OAuthRouteAttempt,
        error: unknown,
        attemptedIdentities: ReadonlySet<string>,
        balanceKey: string
    ): Promise<OAuthRouteDecision> {
        if (!isOAuthAccountFailure(error)) {
            return { handled: false, shouldRetry: false };
        }
        const settings = this.dependencies.store.getRoutingSettings(provider);
        if (settings.mode === 'off') {
            return { handled: false, shouldRetry: false };
        }
        const candidates = this.getCandidates(provider, settings);
        const next = this.findNextCandidate(provider, candidates, attempt.credentialName, attemptedIdentities);
        if (!next) {
            return { handled: true, shouldRetry: false };
        }

        if (settings.mode === 'balance') {
            this.dependencies.balanceAffinity.remember(
                provider,
                balanceKey,
                this.identity(provider, next.entry.name),
                settings.generation
            );
            return { handled: true, shouldRetry: true };
        }

        const currentSelection = this.dependencies.store.getActiveCredentialSelection(provider);
        if (!sameSelection(currentSelection, attempt.selection)) {
            return {
                handled: true,
                shouldRetry:
                    !!currentSelection.name && !attemptedIdentities.has(this.identity(provider, currentSelection.name))
            };
        }

        const excludedIdentities = new Set(attemptedIdentities);
        excludedIdentities.add(attempt.identity);
        let candidate: WeightedCredential | undefined = next;
        while (candidate) {
            const credentials = await this.dependencies.authenticator.ensureAuthenticatedForOAuthCredential(
                provider,
                candidate.entry.name
            );
            if (credentials?.access_token) {
                return await this.activateNext(
                    provider,
                    attempt,
                    candidate,
                    credentials.access_token,
                    excludedIdentities
                );
            }
            excludedIdentities.add(this.identity(provider, candidate.entry.name));
            candidate = this.findNextCandidate(provider, candidates, candidate.entry.name, excludedIdentities);
        }
        return { handled: true, shouldRetry: false };
    }

    clearBalanceAffinity(provider: string): void {
        this.dependencies.balanceAffinity.clear(provider);
    }

    private async captureFailoverCandidate(
        provider: string,
        candidates: WeightedCredential[],
        startIndex: number,
        selection: OAuthCredentialSelection
    ): Promise<OAuthRouteAttempt | undefined> {
        let currentSelection = selection;
        let currentCandidates = candidates;
        const maximumSelectionRetries = candidates.length;
        for (let selectionRetry = 0; selectionRetry <= maximumSelectionRetries; selectionRetry += 1) {
            const current = currentCandidates.find(candidate => candidate.entry.name === currentSelection.name);
            const currentStartIndex = current ? currentCandidates.indexOf(current) : startIndex;
            let retryWithCurrentSelection = false;
            for (let offset = 0; offset < currentCandidates.length; offset += 1) {
                const candidate = currentCandidates[(currentStartIndex + offset) % currentCandidates.length];
                if (!candidate) {
                    continue;
                }
                const credentials = await this.dependencies.authenticator.ensureAuthenticatedForOAuthCredential(
                    provider,
                    candidate.entry.name
                );
                const latestSelection = this.dependencies.store.getActiveCredentialSelection(provider);
                if (!sameSelection(latestSelection, currentSelection)) {
                    currentSelection = latestSelection;
                    retryWithCurrentSelection = true;
                    break;
                }
                if (!credentials?.access_token) {
                    continue;
                }
                if (candidate.entry.name !== currentSelection.name) {
                    const switched = await this.dependencies.store.setActiveCredentialIfCurrent(
                        provider,
                        currentSelection,
                        candidate.entry.name
                    );
                    if (!switched) {
                        currentSelection = this.dependencies.store.getActiveCredentialSelection(provider);
                        retryWithCurrentSelection = true;
                        break;
                    } else {
                        currentSelection = switched;
                    }
                }
                if (candidate.entry.name === currentSelection.name) {
                    const applied = await this.dependencies.apiKeySync.setApiKeyForActiveCliCredential(
                        provider,
                        currentSelection,
                        credentials.access_token
                    );
                    if (!applied) {
                        currentSelection = this.dependencies.store.getActiveCredentialSelection(provider);
                        retryWithCurrentSelection = true;
                        break;
                    }
                    return this.toAttempt(
                        'failover',
                        provider,
                        candidate.entry.name,
                        credentials.access_token,
                        currentSelection
                    );
                }
            }
            if (!retryWithCurrentSelection) {
                break;
            }
            const settings = this.dependencies.store.getRoutingSettings(provider);
            if (settings.mode !== 'failover') {
                return undefined;
            }
            currentCandidates = this.getCandidates(provider, settings);
            if (
                currentCandidates.length < 2 ||
                !currentSelection.name ||
                !currentCandidates.some(candidate => candidate.entry.name === currentSelection.name)
            ) {
                return undefined;
            }
        }
        throw new Error(`No active OAuth account could authenticate for ${provider}.`);
    }

    private async activateNext(
        provider: string,
        attempt: OAuthRouteAttempt,
        candidate: WeightedCredential,
        accessToken: string | undefined,
        attemptedIdentities: ReadonlySet<string>
    ): Promise<OAuthRouteDecision> {
        if (!accessToken) {
            return { handled: true, shouldRetry: false };
        }
        const selection = await this.dependencies.store.setActiveCredentialIfCurrent(
            provider,
            attempt.selection,
            candidate.entry.name
        );
        if (!selection) {
            const current = this.dependencies.store.getActiveCredentialSelection(provider);
            return {
                handled: true,
                shouldRetry: !!current.name && !attemptedIdentities.has(this.identity(provider, current.name))
            };
        }
        const applied = await this.dependencies.apiKeySync.setApiKeyForActiveCliCredential(
            provider,
            selection,
            accessToken
        );
        if (!applied) {
            const current = this.dependencies.store.getActiveCredentialSelection(provider);
            return {
                handled: true,
                shouldRetry: !!current.name && !attemptedIdentities.has(this.identity(provider, current.name))
            };
        }
        return { handled: true, shouldRetry: true };
    }

    private getCandidates(provider: string, settings: OAuthCredentialRoutingSettings): WeightedCredential[] {
        return this.dependencies.store
            .listCredentials(provider)
            .filter(entry => entry.hasAccessToken)
            .map(entry => ({
                entry,
                weight: Object.hasOwn(settings.weights, entry.name) ? (settings.weights[entry.name] ?? 1) : 1
            }))
            .filter(candidate => candidate.weight > 0);
    }

    private findNextCandidate(
        provider: string,
        candidates: WeightedCredential[],
        currentName: string,
        attemptedIdentities: ReadonlySet<string>
    ): WeightedCredential | undefined {
        const currentIndex = candidates.findIndex(candidate => candidate.entry.name === currentName);
        for (let offset = 1; offset <= candidates.length; offset += 1) {
            const candidate = candidates[(Math.max(currentIndex, -1) + offset) % candidates.length];
            if (candidate && !attemptedIdentities.has(this.identity(provider, candidate.entry.name))) {
                return candidate;
            }
        }
        return undefined;
    }

    private selectWeightedCandidate(
        provider: string,
        balanceKey: string,
        candidates: WeightedCredential[]
    ): WeightedCredential | undefined {
        const totalWeight = candidates.reduce((total, candidate) => total + candidate.weight, 0);
        if (totalWeight <= 0) {
            return undefined;
        }
        const digest = createHash('sha256').update(`${provider}\u0000${balanceKey}`).digest();
        let bucket = digest.readUInt32BE(0) % totalWeight;
        for (const candidate of candidates) {
            if (bucket < candidate.weight) {
                return candidate;
            }
            bucket -= candidate.weight;
        }
        return undefined;
    }

    private toAttempt(
        mode: Exclude<OAuthCredentialSwitchMode, 'off'>,
        provider: string,
        credentialName: string,
        apiKey: string,
        selection: OAuthCredentialSelection
    ): OAuthRouteAttempt {
        return { mode, credentialName, apiKey, identity: this.identity(provider, credentialName), selection };
    }

    private identity(provider: string, credentialName: string): string {
        return createHash('sha256').update(`oauth-credential\u0000${provider}\u0000${credentialName}`).digest('hex');
    }
}

function sameSelection(left: OAuthCredentialSelection, right: OAuthCredentialSelection): boolean {
    return left.name === right.name && left.generation === right.generation;
}

export function isOAuthAccountFailure(error: unknown): boolean {
    return hasAccountFailureSignal(error, 0);
}

function hasAccountFailureSignal(value: unknown, depth: number): boolean {
    if (!value || typeof value !== 'object' || depth > 3) {
        return false;
    }
    const record = value as Record<string, unknown>;
    const status = record.status ?? record.statusCode;
    if (status === 401 || status === 403) {
        return true;
    }
    const code = typeof record.code === 'string' ? record.code.toLowerCase() : '';
    const type = typeof record.type === 'string' ? record.type.toLowerCase() : '';
    const quotaCodes = new Set([
        'usage_limit_reached',
        'quota_exceeded',
        'insufficient_credits',
        'inference_cap_error',
        'spend_limit_exceeded'
    ]);
    if (quotaCodes.has(code) || quotaCodes.has(type)) {
        return true;
    }
    const message = typeof record.message === 'string' ? record.message : '';
    if (
        /\b(?:daily|weekly|monthly)\b[^.。]{0,40}\b(?:limit|quota|cap)\b[^.。]{0,40}\b(?:reached|exceeded|exhausted)\b/i.test(
            message
        ) ||
        /\busage\s+limit\s+(?:has\s+been\s+)?reached\b/i.test(message) ||
        /\bquota\s+(?:has\s+been\s+)?(?:reached|exceeded|exhausted)\b/i.test(message) ||
        /(?:每日|每周|每月).{0,12}(?:额度|配额|限额).{0,8}(?:耗尽|已满|超出)/.test(message)
    ) {
        return true;
    }
    return ['error', 'cause', 'details', 'response', 'data'].some(key =>
        hasAccountFailureSignal(record[key], depth + 1)
    );
}
