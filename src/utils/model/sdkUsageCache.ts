import { createHash } from 'node:crypto';
import type { LanguageModelChatMessage, ProvideLanguageModelChatResponseOptions } from 'vscode';
import type { MarkerUsage, StatefulMarkerContainer } from '../../handlers/stateful/statefulMarker';
import type { PromptUsageReference } from './promptAnalyzer';

const MAX_ENTRIES = 1_000;
const ENTRY_TTL_MS = 7 * 24 * 60 * 60 * 1_000;

type UsageIdentity = Pick<StatefulMarkerContainer, 'provider' | 'modelId' | 'sdkMode' | 'sessionId'>;

interface UsageRequest {
    key: string;
    messageCount: number;
    historyHash: string;
    toolsHash: string;
    sequence: number;
}

interface UsageEntry extends UsageRequest {
    usage: MarkerUsage;
    expiresAt: number;
}

function identityKey(identity: UsageIdentity): string {
    return JSON.stringify([identity.provider, identity.modelId, identity.sdkMode, identity.sessionId]);
}

function historyHash(messages: readonly LanguageModelChatMessage[], count: number): string {
    const hash = createHash('sha256');
    for (let index = 0; index < count; index++) {
        hash.update(JSON.stringify(messages[index])).update('\n');
    }
    return hash.digest('hex');
}

export class SdkUsageCache {
    private readonly entries = new Map<string, UsageEntry>();
    private requests = new WeakMap<object, UsageRequest>();
    private sequence = 0;
    private disposed = false;

    constructor(private readonly now: () => number = () => Date.now()) {}

    begin(
        options: ProvideLanguageModelChatResponseOptions,
        identity: UsageIdentity,
        messages: readonly LanguageModelChatMessage[]
    ): void {
        this.requests.delete(options);
        if (this.disposed || !identity.sessionId.trim() || messages.length === 0) {
            return;
        }
        this.prune();
        try {
            this.requests.set(options, {
                key: identityKey(identity),
                messageCount: messages.length,
                historyHash: historyHash(messages, messages.length),
                toolsHash: createHash('sha256')
                    .update(JSON.stringify([options.tools ?? [], options.toolMode]))
                    .digest('hex'),
                sequence: ++this.sequence
            });
        } catch {
            this.requests.delete(options);
        }
    }

    get(
        options: ProvideLanguageModelChatResponseOptions,
        messages: readonly LanguageModelChatMessage[]
    ): PromptUsageReference | undefined {
        this.prune();
        const request = this.requests.get(options);
        const entry = request && this.entries.get(request.key);
        if (
            this.disposed ||
            !request ||
            !entry ||
            request.toolsHash !== entry.toolsHash ||
            entry.messageCount > messages.length
        ) {
            return undefined;
        }
        try {
            if (historyHash(messages, entry.messageCount) !== entry.historyHash) {
                return undefined;
            }
            return { usage: { ...entry.usage }, messageCount: entry.messageCount };
        } catch {
            return undefined;
        }
    }

    remember(options: ProvideLanguageModelChatResponseOptions, marker: StatefulMarkerContainer): void {
        const request = this.requests.get(options);
        const usage = marker.usage;
        if (
            this.disposed ||
            !request ||
            marker.extension !== 'vicanent.gcmp' ||
            marker.subSessionId !== undefined ||
            marker.continuity?.scope === 'subagent' ||
            identityKey(marker) !== request.key ||
            !usage ||
            ![usage.prompt_tokens, usage.completion_tokens, usage.total_tokens].every(
                value => Number.isSafeInteger(value) && value >= 0
            ) ||
            usage.prompt_tokens === 0
        ) {
            return;
        }
        this.prune();
        const previous = this.entries.get(request.key);
        if (previous && previous.sequence > request.sequence) {
            return;
        }
        this.entries.delete(request.key);
        this.entries.set(request.key, {
            ...request,
            usage: {
                prompt_tokens: usage.prompt_tokens,
                completion_tokens: usage.completion_tokens,
                total_tokens: usage.total_tokens
            },
            expiresAt: this.now() + ENTRY_TTL_MS
        });
        if (this.entries.size > MAX_ENTRIES) {
            const oldestKey = this.entries.keys().next().value;
            if (oldestKey !== undefined) {
                this.entries.delete(oldestKey);
            }
        }
    }

    dispose(): void {
        this.disposed = true;
        this.entries.clear();
        this.requests = new WeakMap();
    }

    private prune(): void {
        const now = this.now();
        for (const [key, entry] of this.entries) {
            if (entry.expiresAt <= now) {
                this.entries.delete(key);
            }
        }
    }
}
