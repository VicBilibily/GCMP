/*---------------------------------------------------------------------------------------------
 *  会话恢复服务
 *  在 summarization 请求成功后暂存摘要文本，与后续丢失 StatefulMarker 的正式请求做桥接，
 *  尝试恢复原有 sessionId。
 *--------------------------------------------------------------------------------------------*/

import { createHash } from 'node:crypto';
import {
    isVerifiedCopilotChat,
    type RequestClassificationMetadata
} from '../handlers/classification/requestClassification';

export interface RecoveryMessageLike {
    role: number;
    content: ReadonlyArray<unknown>;
}

export interface SessionRecoveryMetadata {
    requestClassification?: RequestClassificationMetadata;
    providerKey?: string;
    telemetryTurn?: number;
    traceId?: string;
}

export interface SessionRecoveryEntry extends SessionRecoveryMetadata {
    sessionId: string;
    summaryKey: string;
    summaryHash: string;
    summaryLength: number;
    updatedAt: number;
}

interface SessionTraceHint extends SessionRecoveryMetadata {
    sessionId: string;
    updatedAt: number;
}

interface SessionTurnHint extends SessionRecoveryMetadata {
    sessionId: string;
    updatedAt: number;
}

export interface SessionRecoveryResult {
    sessionId: string;
    matchType: 'exact' | 'embedded' | 'truncated';
}

export interface SessionRecoveryDecision {
    recovered?: SessionRecoveryResult;
    hasCompactionContext: boolean;
    ambiguous: boolean;
}

interface SessionRecoveryMatchScore {
    matchType: SessionRecoveryResult['matchType'];
    score: number;
}

interface SessionRecoveryCandidate {
    text: string;
    hash: string;
    embedded: boolean;
}

interface RememberSessionHintOptions {
    publishProviderTraceHint?: boolean;
    publishProviderAgnosticTraceHint?: boolean;
}

const MAX_SUMMARY_KEY_LENGTH = 6_000;
export const MAX_RECOVERY_RESPONSE_LENGTH = 64 * 1024;
const MIN_SUMMARY_KEY_LENGTH = 80;
const MAX_ENTRIES = 1_000;
const MAX_PROVIDER_AGNOSTIC_TRACE_HINTS_PER_TRACE = 16;
// 某些直接拉起的子代理不会继承主请求的 telemetryTurn，
// 而是从 1 重新开始；此时只能在“同一 trace 的活跃 hint 仅指向一个 session”时放宽匹配。
const SUBAGENT_TRACE_TURN_RESET_VALUE = 1;
const ENTRY_TTL_MS = 7 * 24 * 60 * 60 * 1_000;
// 压缩摘要请求在网络拥塞/大上下文场景下可能持续数分钟；
// trace/turn bridge 的窗口若只有 2 分钟，会让合法续会话在 compaction 完成后退化为 new-uuid。
const RECOVERY_HINT_TTL_MS = 10 * 60 * 1_000;
const TRACE_HINT_TTL_MS = RECOVERY_HINT_TTL_MS;
// turn bridge 面向“压缩后下一轮继续”的场景：用户可能在压缩完成后隔很久才继续，
// 因此不能仅按短时 wall-clock 过期；主要靠 telemetryTurn 推进来淘汰过期候选。
const TURN_HINT_TTL_MS = ENTRY_TTL_MS;
const PROVIDERLESS_ENTRY_BUCKET = '__providerless__';

function extractTextFromContent(content: ReadonlyArray<unknown>): string {
    let text = '';
    for (const part of content) {
        const value = (part as { value?: unknown } | null)?.value;
        if (typeof value === 'string') {
            text += value;
        }
    }
    return text;
}

function normalizeSummaryText(text: string): string {
    return text.replace(/\s+/g, ' ').trim();
}

function extractSummaryBody(text: string): string {
    const match = /^(?:<analysis>[\s\S]*?<\/analysis>\s*)?<summary>([\s\S]*?)<\/summary>\s*$/.exec(text.trim());
    return match?.[1] ?? text;
}

function extractCompactionSummary(text: string): string | undefined {
    const trimmed = text.trim();
    const tagged =
        /^(?:<context>[\s\S]*?<\/context>\s*)?<conversation-summary>([\s\S]*?)<\/conversation-summary>(?:\s*<reminderInstructions>(?:(?!<\/?reminderInstructions>)[\s\S])*<\/reminderInstructions>)?$/.exec(
            trimmed
        );
    if (tagged) {
        return tagged[1];
    }
    return /^Use the following condensed context before answering:\s*([\s\S]*?)\s*Continue the conversation\.$/.exec(
        trimmed
    )?.[1];
}

function getAssistantResponseKey(text: string, providerKey?: string): string | undefined {
    if (!providerKey || text.length > MAX_RECOVERY_RESPONSE_LENGTH) {
        return undefined;
    }
    const normalized = normalizeSummaryText(text);
    if (normalized.length < MIN_SUMMARY_KEY_LENGTH) {
        return undefined;
    }
    return createHash('sha256')
        .update(JSON.stringify([providerKey, normalized]))
        .digest('hex');
}

function getTraceHintKey(metadata?: SessionRecoveryMetadata): string | undefined {
    if (!metadata?.providerKey || !metadata.traceId) {
        return undefined;
    }

    return `${metadata.providerKey}:${metadata.traceId}`;
}

function getProviderAgnosticTraceHintKey(metadata?: SessionRecoveryMetadata): string | undefined {
    return metadata?.traceId;
}

function getTraceHintScore(hint: SessionTraceHint, metadata?: SessionRecoveryMetadata): number | undefined {
    if (metadata?.telemetryTurn === undefined || hint.telemetryTurn === undefined) {
        return 0;
    }

    const diff = Math.abs(hint.telemetryTurn - metadata.telemetryTurn);
    if (diff > 1) {
        return undefined;
    }
    if (diff === 0) {
        return 20;
    }
    return 10;
}

function isProviderCompatible(entry: SessionRecoveryEntry, metadata?: SessionRecoveryMetadata): boolean {
    return !metadata?.providerKey || !entry.providerKey || metadata.providerKey === entry.providerKey;
}

function scoreMatch(
    entry: SessionRecoveryEntry,
    candidate: SessionRecoveryCandidate,
    metadata?: SessionRecoveryMetadata
): SessionRecoveryMatchScore | undefined {
    const key = entry.summaryKey;
    if (candidate.hash === entry.summaryHash) {
        return {
            matchType: candidate.embedded ? 'embedded' : 'exact',
            score: 2_000 + key.length + (metadata?.traceId && metadata.traceId === entry.traceId ? 120 : 0)
        };
    }

    if (
        candidate.embedded &&
        candidate.text.length < entry.summaryLength &&
        key.includes(candidate.text) &&
        candidate.text.length >= MIN_SUMMARY_KEY_LENGTH
    ) {
        return {
            matchType: 'truncated',
            score: 1_000 + candidate.text.length + (metadata?.traceId && metadata.traceId === entry.traceId ? 120 : 0)
        };
    }

    return undefined;
}

export class SessionRecoveryService {
    static readonly instance = new SessionRecoveryService();

    private readonly entries = new Map<string, SessionRecoveryEntry>();
    private readonly entrySessionIdsByProvider = new Map<string, Set<string>>();
    private readonly traceHints = new Map<string, SessionTraceHint>();
    private readonly providerAgnosticTraceHints = new Map<string, SessionTraceHint[]>();
    private readonly latestSessionHints = new Map<string, SessionTraceHint>();
    private readonly turnHints = new Map<string, SessionTurnHint[]>();
    private readonly sdkSessionHints = new Map<string, { sessionId?: string; updatedAt: number }>();
    private readonly assistantResponseHints = new Map<string, { sessionId?: string; updatedAt: number }>();

    constructor(private readonly now: () => number = () => Date.now()) {}

    rememberAssistantResponse(sessionId: string, text: string, metadata: SessionRecoveryMetadata): void {
        if (
            !sessionId ||
            !isVerifiedCopilotChat(metadata.requestClassification) ||
            metadata.requestClassification?.agentRole !== 'main'
        ) {
            return;
        }
        const key = getAssistantResponseKey(text, metadata.providerKey);
        if (!key) {
            return;
        }
        this.pruneAssistantResponseHints();
        const previous = this.assistantResponseHints.get(key);
        this.assistantResponseHints.delete(key);
        this.assistantResponseHints.set(key, {
            sessionId: previous && previous.sessionId !== sessionId ? undefined : sessionId,
            updatedAt: this.now()
        });
        if (this.assistantResponseHints.size > MAX_ENTRIES) {
            this.assistantResponseHints.delete(this.assistantResponseHints.keys().next().value!);
        }
    }

    resolveSessionIdFromHistory(
        messages: readonly RecoveryMessageLike[],
        metadata: SessionRecoveryMetadata
    ): string | undefined {
        if (
            !isVerifiedCopilotChat(metadata.requestClassification) ||
            metadata.requestClassification?.agentRole !== 'not-applicable'
        ) {
            return undefined;
        }
        this.pruneAssistantResponseHints();
        const candidates = new Set<string>();
        for (const message of messages) {
            if (message.role !== 2) {
                continue;
            }
            const key = getAssistantResponseKey(extractTextFromContent(message.content), metadata.providerKey);
            const hint = key ? this.assistantResponseHints.get(key) : undefined;
            if (hint) {
                if (!hint.sessionId) {
                    return undefined;
                }
                candidates.add(hint.sessionId);
                if (candidates.size > 1) {
                    return undefined;
                }
            }
        }
        return candidates.values().next().value;
    }

    private pruneAssistantResponseHints(): void {
        const cutoff = this.now() - ENTRY_TTL_MS;
        for (const [key, hint] of this.assistantResponseHints) {
            if (hint.updatedAt < cutoff) {
                this.assistantResponseHints.delete(key);
            }
        }
    }

    rememberSdkSession(contextKey: string, sessionId: string): void {
        this.pruneSdkSessionHints();
        const previous = this.sdkSessionHints.get(contextKey);
        this.sdkSessionHints.delete(contextKey);
        this.sdkSessionHints.set(contextKey, {
            // 冲突保持歧义，不能用最近的 marker 或新 UUID 覆盖既有绑定。
            sessionId: previous && previous.sessionId !== sessionId ? undefined : sessionId,
            updatedAt: this.now()
        });
        if (this.sdkSessionHints.size > MAX_ENTRIES) {
            this.sdkSessionHints.delete(this.sdkSessionHints.keys().next().value!);
        }
    }

    resolveSdkSession(contextKey: string): string | undefined {
        this.pruneSdkSessionHints();
        const sessionId = this.sdkSessionHints.get(contextKey)?.sessionId;
        if (sessionId) {
            this.rememberSdkSession(contextKey, sessionId);
        }
        return sessionId;
    }

    private pruneSdkSessionHints(): void {
        const cutoff = this.now() - ENTRY_TTL_MS;
        for (const [key, hint] of this.sdkSessionHints) {
            if (hint.updatedAt < cutoff) {
                this.sdkSessionHints.delete(key);
            }
        }
    }

    rememberSummarization(sessionId: string, summaryText: string, metadata?: SessionRecoveryMetadata): void {
        if (!sessionId || !isVerifiedCopilotChat(metadata?.requestClassification)) {
            return;
        }

        const existingEntry = this.entries.get(sessionId);
        const latestHint = this.latestSessionHints.get(sessionId);
        const providerKey = metadata?.providerKey ?? latestHint?.providerKey;
        const telemetryTurn = metadata?.telemetryTurn ?? latestHint?.telemetryTurn;
        const traceId = metadata?.traceId ?? latestHint?.traceId;
        const normalizedSummary = normalizeSummaryText(extractSummaryBody(summaryText));
        const summaryKey = normalizedSummary.slice(0, MAX_SUMMARY_KEY_LENGTH);
        if (summaryKey.length < MIN_SUMMARY_KEY_LENGTH) {
            return;
        }

        const updatedAt = this.now();
        this.entries.set(sessionId, {
            sessionId,
            summaryKey,
            summaryHash: createHash('sha256').update(normalizedSummary).digest('hex'),
            summaryLength: normalizedSummary.length,
            providerKey,
            telemetryTurn,
            traceId,
            updatedAt
        });
        this.moveEntryProviderBucket(sessionId, existingEntry?.providerKey, providerKey);
        if (providerKey) {
            const nextHint: SessionTurnHint = {
                sessionId,
                providerKey,
                telemetryTurn,
                traceId,
                updatedAt
            };
            const existingHints = this.turnHints.get(providerKey) ?? [];
            this.turnHints.set(
                providerKey,
                existingHints.filter(hint => hint.sessionId !== sessionId).concat(nextHint)
            );
            this.pruneTurnHints();
        }
        this.rememberSessionHint(
            sessionId,
            {
                providerKey,
                telemetryTurn,
                traceId
            },
            updatedAt
        );
        this.pruneEntries();
    }

    rememberSessionHint(
        sessionId: string,
        metadata?: SessionRecoveryMetadata,
        updatedAt = this.now(),
        options: RememberSessionHintOptions = {}
    ): void {
        if (!isVerifiedCopilotChat(metadata?.requestClassification)) {
            return;
        }
        const traceHintKey = getTraceHintKey(metadata);
        const providerAgnosticTraceHintKey = getProviderAgnosticTraceHintKey(metadata);
        if (!sessionId || !providerAgnosticTraceHintKey) {
            return;
        }

        const { publishProviderTraceHint = true, publishProviderAgnosticTraceHint = true } = options;

        const previousHint = this.latestSessionHints.get(sessionId);
        const { providerKey, traceId } = metadata!;
        const telemetryTurn = metadata?.telemetryTurn ?? previousHint?.telemetryTurn;

        const nextHint: SessionTraceHint = {
            sessionId,
            providerKey,
            traceId,
            telemetryTurn,
            updatedAt
        };

        if (traceHintKey && publishProviderTraceHint) {
            this.traceHints.set(traceHintKey, nextHint);
        }
        if (publishProviderAgnosticTraceHint) {
            this.rememberProviderAgnosticTraceHint(providerAgnosticTraceHintKey, nextHint);
        }
        this.latestSessionHints.set(sessionId, nextHint);
        this.pruneTraceHints();
    }

    resolveSessionIdFromTrace(metadata?: SessionRecoveryMetadata): string | undefined {
        if (!isVerifiedCopilotChat(metadata?.requestClassification)) {
            return undefined;
        }
        this.pruneTraceHints();
        const traceHintKey = getTraceHintKey(metadata);
        if (!traceHintKey) {
            return undefined;
        }

        return this.resolveSessionIdFromHint(this.traceHints.get(traceHintKey), metadata);
    }

    resolveSessionIdFromTraceAcrossProviders(metadata?: SessionRecoveryMetadata): string | undefined {
        if (!isVerifiedCopilotChat(metadata?.requestClassification)) {
            return undefined;
        }
        this.pruneTraceHints();
        const traceHintKey = getProviderAgnosticTraceHintKey(metadata);
        if (!traceHintKey) {
            return undefined;
        }

        return this.resolveSessionIdFromHints(this.providerAgnosticTraceHints.get(traceHintKey), metadata);
    }

    private resolveSessionIdFromHint(
        hint: SessionTraceHint | undefined,
        metadata?: SessionRecoveryMetadata
    ): string | undefined {
        if (!hint) {
            return undefined;
        }

        if (getTraceHintScore(hint, metadata) === undefined) {
            return undefined;
        }

        return hint.sessionId;
    }

    private resolveSessionIdFromHints(
        hints: readonly SessionTraceHint[] | undefined,
        metadata?: SessionRecoveryMetadata
    ): string | undefined {
        if (!hints || hints.length === 0) {
            return undefined;
        }

        let bestHint: SessionTraceHint | undefined;
        let bestScore = -1;
        for (const hint of hints) {
            const score = getTraceHintScore(hint, metadata);
            if (score === undefined) {
                continue;
            }
            if (!bestHint || score > bestScore || (score === bestScore && hint.updatedAt > bestHint.updatedAt)) {
                bestHint = hint;
                bestScore = score;
            }
        }

        if (bestHint) {
            return bestHint.sessionId;
        }

        return this.resolveSessionIdFromSubagentTurnResetHints(hints, metadata);
    }

    private resolveSessionIdFromSubagentTurnResetHints(
        hints: readonly SessionTraceHint[],
        metadata?: SessionRecoveryMetadata
    ): string | undefined {
        if (metadata?.telemetryTurn !== SUBAGENT_TRACE_TURN_RESET_VALUE) {
            return undefined;
        }

        const uniqueSessionIds = new Set(hints.map(hint => hint.sessionId));
        if (uniqueSessionIds.size !== 1) {
            return undefined;
        }

        return hints[0]?.sessionId;
    }

    resolveSessionIdFromTurn(metadata?: SessionRecoveryMetadata, expectedSessionId?: string): string | undefined {
        if (!isVerifiedCopilotChat(metadata?.requestClassification)) {
            return undefined;
        }
        const providerKey = metadata?.providerKey;
        const telemetryTurn = metadata?.telemetryTurn;
        if (!providerKey || telemetryTurn === undefined || !Number.isFinite(telemetryTurn)) {
            return undefined;
        }
        this.pruneTurnHints(metadata, expectedSessionId);

        const hints = this.turnHints.get(providerKey);
        if (!hints || hints.length === 0) {
            return undefined;
        }

        const candidates = hints.filter(hint => {
            if (expectedSessionId && hint.sessionId !== expectedSessionId) {
                return false;
            }
            if (hint.telemetryTurn === undefined) {
                return false;
            }
            const diff = telemetryTurn - hint.telemetryTurn;
            return diff === 0 || diff === 1;
        });

        if (candidates.length !== 1) {
            return undefined;
        }

        const matchedHint = candidates[0];
        this.consumeTurnHint(matchedHint.sessionId);
        return matchedHint.sessionId;
    }

    consumeTurnHint(sessionId: string): void {
        for (const [providerKey, hints] of this.turnHints) {
            const remaining = hints.filter(hint => hint.sessionId !== sessionId);
            if (remaining.length > 0) {
                this.turnHints.set(providerKey, remaining);
            } else {
                this.turnHints.delete(providerKey);
            }
        }
    }

    resolveSessionId(
        messages: readonly RecoveryMessageLike[],
        metadata?: SessionRecoveryMetadata
    ): SessionRecoveryResult | undefined {
        return this.resolveSummaryContext(messages, metadata).recovered;
    }

    resolveSummaryContext(
        messages: readonly RecoveryMessageLike[],
        metadata?: SessionRecoveryMetadata
    ): SessionRecoveryDecision {
        if (!isVerifiedCopilotChat(metadata?.requestClassification)) {
            return { hasCompactionContext: false, ambiguous: false };
        }
        this.pruneEntries();
        const candidateTexts = this.extractCandidateTexts(messages);
        const decision: SessionRecoveryDecision = {
            hasCompactionContext: candidateTexts.some(candidate => candidate.embedded),
            ambiguous: false
        };
        if (this.entries.size === 0 || candidateTexts.length === 0) {
            return decision;
        }

        let recovered: SessionRecoveryResult | undefined;
        for (const candidate of candidateTexts) {
            let bestMatch: { entry: SessionRecoveryEntry; result: SessionRecoveryMatchScore } | undefined;
            let ambiguous = false;
            for (const entry of this.getCandidateEntries(metadata)) {
                if (!isProviderCompatible(entry, metadata)) {
                    continue;
                }
                const result = scoreMatch(entry, candidate, metadata);
                if (!result) {
                    continue;
                }
                if (!bestMatch || result.score > bestMatch.result.score) {
                    bestMatch = { entry, result };
                    ambiguous = false;
                } else if (result.score === bestMatch.result.score && entry.sessionId !== bestMatch.entry.sessionId) {
                    ambiguous = true;
                }
            }
            if (ambiguous || (bestMatch && recovered && bestMatch.entry.sessionId !== recovered.sessionId)) {
                return { ...decision, ambiguous: true };
            }
            if (bestMatch && (!recovered || recovered.matchType === 'truncated')) {
                recovered = { sessionId: bestMatch.entry.sessionId, matchType: bestMatch.result.matchType };
            }
        }

        if (recovered) {
            this.consumeTurnHint(recovered.sessionId);
        }
        return { ...decision, recovered };
    }

    private extractCandidateTexts(messages: readonly RecoveryMessageLike[]): SessionRecoveryCandidate[] {
        const candidates = new Map<string, SessionRecoveryCandidate>();

        for (const message of messages) {
            if (message.role !== 1 && message.role !== 2) {
                continue;
            }
            const text = extractTextFromContent(message.content);
            const summary = extractCompactionSummary(text);
            const normalized = normalizeSummaryText(summary ?? text);
            if (normalized.length >= MIN_SUMMARY_KEY_LENGTH) {
                const hash = createHash('sha256').update(normalized).digest('hex');
                candidates.set(hash, { text: normalized, hash, embedded: summary !== undefined });
            }
        }

        return Array.from(candidates.values());
    }

    private getCandidateEntries(metadata?: SessionRecoveryMetadata): Iterable<SessionRecoveryEntry> {
        const providerKey = metadata?.providerKey;
        if (!providerKey) {
            return this.entries.values();
        }

        const sessionIds = new Set<string>(this.entrySessionIdsByProvider.get(providerKey));
        for (const sessionId of this.entrySessionIdsByProvider.get(PROVIDERLESS_ENTRY_BUCKET) ?? []) {
            sessionIds.add(sessionId);
        }

        return Array.from(sessionIds, sessionId => this.entries.get(sessionId)).filter(
            (entry): entry is SessionRecoveryEntry => !!entry
        );
    }

    private pruneEntries(): void {
        const cutoff = this.now() - ENTRY_TTL_MS;
        for (const [sessionId, entry] of this.entries) {
            if (entry.updatedAt < cutoff) {
                this.entries.delete(sessionId);
                this.removeEntryProviderBucket(sessionId, entry.providerKey);
            }
        }

        if (this.entries.size <= MAX_ENTRIES) {
            return;
        }

        const overflow = this.entries.size - MAX_ENTRIES;
        const oldest = Array.from(this.entries.values())
            .sort((a, b) => a.updatedAt - b.updatedAt)
            .slice(0, overflow);

        for (const entry of oldest) {
            this.entries.delete(entry.sessionId);
            this.removeEntryProviderBucket(entry.sessionId, entry.providerKey);
        }
    }

    private moveEntryProviderBucket(sessionId: string, previousProviderKey?: string, nextProviderKey?: string): void {
        this.removeEntryProviderBucket(sessionId, previousProviderKey);
        this.addEntryProviderBucket(sessionId, nextProviderKey);
    }

    private addEntryProviderBucket(sessionId: string, providerKey?: string): void {
        const bucketKey = providerKey || PROVIDERLESS_ENTRY_BUCKET;
        const sessionIds = this.entrySessionIdsByProvider.get(bucketKey) ?? new Set<string>();
        sessionIds.add(sessionId);
        this.entrySessionIdsByProvider.set(bucketKey, sessionIds);
    }

    private removeEntryProviderBucket(sessionId: string, providerKey?: string): void {
        const bucketKey = providerKey || PROVIDERLESS_ENTRY_BUCKET;
        const sessionIds = this.entrySessionIdsByProvider.get(bucketKey);
        if (!sessionIds) {
            return;
        }
        sessionIds.delete(sessionId);
        if (sessionIds.size === 0) {
            this.entrySessionIdsByProvider.delete(bucketKey);
        }
    }

    private rememberProviderAgnosticTraceHint(traceId: string, nextHint: SessionTraceHint): void {
        const existingHints = this.providerAgnosticTraceHints.get(traceId) ?? [];
        const dedupedHints = existingHints.filter(
            hint =>
                !(
                    hint.sessionId === nextHint.sessionId &&
                    hint.providerKey === nextHint.providerKey &&
                    hint.telemetryTurn === nextHint.telemetryTurn
                )
        );
        const nextHints = dedupedHints
            .concat(nextHint)
            .sort((left, right) => right.updatedAt - left.updatedAt)
            .slice(0, MAX_PROVIDER_AGNOSTIC_TRACE_HINTS_PER_TRACE);
        this.providerAgnosticTraceHints.set(traceId, nextHints);
    }

    private pruneTraceHints(): void {
        const cutoff = this.now() - TRACE_HINT_TTL_MS;
        for (const [traceId, hint] of this.traceHints) {
            if (hint.updatedAt < cutoff) {
                this.traceHints.delete(traceId);
            }
        }

        for (const [traceId, hints] of this.providerAgnosticTraceHints) {
            const aliveHints = hints.filter(hint => hint.updatedAt >= cutoff);
            if (aliveHints.length === 0) {
                this.providerAgnosticTraceHints.delete(traceId);
                continue;
            }
            this.providerAgnosticTraceHints.set(traceId, aliveHints);
        }

        for (const [sessionId, hint] of this.latestSessionHints) {
            if (hint.updatedAt < cutoff) {
                this.latestSessionHints.delete(sessionId);
            }
        }
    }

    private pruneTurnHints(metadata?: SessionRecoveryMetadata, expectedSessionId?: string): void {
        const cutoff = this.now() - TURN_HINT_TTL_MS;
        for (const [providerKey, hints] of this.turnHints) {
            const aliveHints = hints.filter(hint => {
                if (hint.updatedAt < cutoff) {
                    return false;
                }
                if (
                    metadata?.providerKey === providerKey &&
                    (!expectedSessionId || hint.sessionId === expectedSessionId) &&
                    metadata.telemetryTurn !== undefined &&
                    hint.telemetryTurn !== undefined &&
                    hint.telemetryTurn < metadata.telemetryTurn - 1
                ) {
                    return false;
                }
                return true;
            });
            if (aliveHints.length === 0) {
                this.turnHints.delete(providerKey);
                continue;
            }
            this.turnHints.set(providerKey, aliveHints);
        }
    }
}
