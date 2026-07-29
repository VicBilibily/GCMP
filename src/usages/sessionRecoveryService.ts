/*---------------------------------------------------------------------------------------------
 *  会话恢复服务
 *  在 summarization 请求成功后暂存摘要文本，与后续丢失 StatefulMarker 的正式请求做桥接，
 *  尝试恢复原有 sessionId。
 *--------------------------------------------------------------------------------------------*/

export interface RecoveryMessageLike {
    role: number;
    content: ReadonlyArray<unknown>;
}

export interface SessionRecoveryMetadata {
    providerKey?: string;
    telemetryTurn?: number;
    traceId?: string;
}

export interface SessionRecoveryEntry extends SessionRecoveryMetadata {
    sessionId: string;
    summaryKey: string;
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

interface SessionRecoveryMatchScore {
    matchType: SessionRecoveryResult['matchType'];
    score: number;
}

const MAX_SUMMARY_KEY_LENGTH = 6_000;
const MIN_SUMMARY_KEY_LENGTH = 80;
const MAX_ENTRIES = 1_000;
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
    return text.replace(/\s+/g, ' ').trim().slice(0, MAX_SUMMARY_KEY_LENGTH);
}

function getTraceHintKey(metadata?: SessionRecoveryMetadata): string | undefined {
    if (!metadata?.providerKey || !metadata.traceId) {
        return undefined;
    }

    return `${metadata.providerKey}:${metadata.traceId}`;
}

function isTelemetryTurnClose(left?: number, right?: number): boolean {
    return left !== undefined && right !== undefined && Math.abs(left - right) <= 1;
}

function getTurnBonus(entry: SessionRecoveryEntry, metadata?: SessionRecoveryMetadata): number {
    if (metadata?.telemetryTurn === undefined || entry.telemetryTurn === undefined) {
        return 0;
    }
    const diff = Math.abs(entry.telemetryTurn - metadata.telemetryTurn);
    if (diff === 0) {
        return 60;
    }
    if (diff === 1) {
        return 30;
    }
    return 0;
}

function isProviderCompatible(entry: SessionRecoveryEntry, metadata?: SessionRecoveryMetadata): boolean {
    return !metadata?.providerKey || !entry.providerKey || metadata.providerKey === entry.providerKey;
}

function scoreMatch(
    entry: SessionRecoveryEntry,
    candidate: string,
    metadata?: SessionRecoveryMetadata
): SessionRecoveryMatchScore | undefined {
    const key = entry.summaryKey;
    if (candidate === key) {
        return {
            matchType: 'exact',
            score:
                2_000 +
                key.length +
                (metadata?.traceId && metadata.traceId === entry.traceId ? 120 : 0) +
                getTurnBonus(entry, metadata)
        };
    }

    if (candidate.length >= key.length && candidate.includes(key)) {
        return {
            matchType: 'embedded',
            score:
                1_500 +
                key.length +
                (metadata?.traceId && metadata.traceId === entry.traceId ? 120 : 0) +
                getTurnBonus(entry, metadata)
        };
    }

    if (key.length >= candidate.length && key.includes(candidate) && candidate.length >= MIN_SUMMARY_KEY_LENGTH) {
        return {
            matchType: 'truncated',
            score:
                1_000 +
                candidate.length +
                (metadata?.traceId && metadata.traceId === entry.traceId ? 120 : 0) +
                getTurnBonus(entry, metadata)
        };
    }

    return undefined;
}

export class SessionRecoveryService {
    static readonly instance = new SessionRecoveryService();

    private readonly entries = new Map<string, SessionRecoveryEntry>();
    private readonly entrySessionIdsByProvider = new Map<string, Set<string>>();
    private readonly traceHints = new Map<string, SessionTraceHint>();
    private readonly latestSessionHints = new Map<string, SessionTraceHint>();
    private readonly turnHints = new Map<string, SessionTurnHint[]>();

    constructor(private readonly now: () => number = () => Date.now()) {}

    rememberSummarization(sessionId: string, summaryText: string, metadata?: SessionRecoveryMetadata): void {
        if (!sessionId) {
            return;
        }

        const existingEntry = this.entries.get(sessionId);
        const latestHint = this.latestSessionHints.get(sessionId);
        const providerKey = metadata?.providerKey ?? latestHint?.providerKey;
        const telemetryTurn = metadata?.telemetryTurn ?? latestHint?.telemetryTurn;
        const traceId = metadata?.traceId ?? latestHint?.traceId;
        const summaryKey = normalizeSummaryText(summaryText);
        if (summaryKey.length < MIN_SUMMARY_KEY_LENGTH) {
            return;
        }

        const updatedAt = this.now();
        this.entries.set(sessionId, {
            sessionId,
            summaryKey,
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

    rememberSessionHint(sessionId: string, metadata?: SessionRecoveryMetadata, updatedAt = this.now()): void {
        const traceHintKey = getTraceHintKey(metadata);
        if (!sessionId || !traceHintKey) {
            return;
        }

        const { providerKey, traceId, telemetryTurn } = metadata!;

        this.traceHints.set(traceHintKey, {
            sessionId,
            providerKey,
            traceId,
            telemetryTurn,
            updatedAt
        });
        this.latestSessionHints.set(sessionId, {
            sessionId,
            providerKey,
            traceId,
            telemetryTurn,
            updatedAt
        });
        this.pruneTraceHints();
    }

    resolveSessionIdFromTrace(metadata?: SessionRecoveryMetadata): string | undefined {
        this.pruneTraceHints();
        const traceHintKey = getTraceHintKey(metadata);
        if (!traceHintKey) {
            return undefined;
        }

        const hint = this.traceHints.get(traceHintKey);
        if (!hint) {
            return undefined;
        }

        if (
            metadata?.telemetryTurn !== undefined &&
            hint.telemetryTurn !== undefined &&
            Math.abs(hint.telemetryTurn - metadata.telemetryTurn) > 1
        ) {
            return undefined;
        }

        return hint.sessionId;
    }

    resolveSessionIdFromTurn(metadata?: SessionRecoveryMetadata): string | undefined {
        this.pruneTurnHints(metadata?.telemetryTurn);
        const providerKey = metadata?.providerKey;
        if (!providerKey) {
            return undefined;
        }

        const hints = this.turnHints.get(providerKey);
        if (!hints || hints.length === 0) {
            return undefined;
        }

        if (metadata?.telemetryTurn === undefined) {
            return undefined;
        }

        const candidates = hints.filter(hint => {
            if (hint.telemetryTurn === undefined) {
                return false;
            }
            const diff = metadata.telemetryTurn! - hint.telemetryTurn;
            return diff === 0 || diff === 1;
        });

        if (candidates.length !== 1) {
            return undefined;
        }

        const matchedHint = candidates[0];
        const remainingHints = hints.filter(hint => hint.sessionId !== matchedHint.sessionId);
        if (remainingHints.length > 0) {
            this.turnHints.set(providerKey, remainingHints);
        } else {
            this.turnHints.delete(providerKey);
        }
        return matchedHint.sessionId;
    }

    resolveSessionId(
        messages: readonly RecoveryMessageLike[],
        metadata?: SessionRecoveryMetadata
    ): SessionRecoveryResult | undefined {
        this.pruneEntries();
        if (this.entries.size === 0) {
            return undefined;
        }

        const candidateTexts = this.extractCandidateTexts(messages);
        if (candidateTexts.length === 0) {
            return undefined;
        }

        let bestMatch:
            | {
                  entry: SessionRecoveryEntry;
                  result: SessionRecoveryMatchScore;
              }
            | undefined;

        for (const candidate of candidateTexts) {
            for (const entry of this.getCandidateEntries(metadata)) {
                if (!isProviderCompatible(entry, metadata)) {
                    continue;
                }
                const result = scoreMatch(entry, candidate, metadata);
                if (!result) {
                    continue;
                }
                if (
                    !bestMatch ||
                    result.score > bestMatch.result.score ||
                    (result.score === bestMatch.result.score && entry.updatedAt > bestMatch.entry.updatedAt) ||
                    (result.score === bestMatch.result.score &&
                        entry.updatedAt === bestMatch.entry.updatedAt &&
                        isTelemetryTurnClose(entry.telemetryTurn, metadata?.telemetryTurn) &&
                        !isTelemetryTurnClose(bestMatch.entry.telemetryTurn, metadata?.telemetryTurn))
                ) {
                    bestMatch = { entry, result };
                }
            }
        }

        if (!bestMatch) {
            return undefined;
        }

        return {
            sessionId: bestMatch.entry.sessionId,
            matchType: bestMatch.result.matchType
        };
    }

    private extractCandidateTexts(messages: readonly RecoveryMessageLike[]): string[] {
        const candidates = new Set<string>();

        for (const message of messages) {
            const normalized = normalizeSummaryText(extractTextFromContent(message.content));
            if (normalized.length >= MIN_SUMMARY_KEY_LENGTH) {
                candidates.add(normalized);
            }
        }

        return Array.from(candidates);
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

    private pruneTraceHints(): void {
        const cutoff = this.now() - TRACE_HINT_TTL_MS;
        for (const [traceId, hint] of this.traceHints) {
            if (hint.updatedAt < cutoff) {
                this.traceHints.delete(traceId);
            }
        }

        for (const [sessionId, hint] of this.latestSessionHints) {
            if (hint.updatedAt < cutoff) {
                this.latestSessionHints.delete(sessionId);
            }
        }
    }

    private pruneTurnHints(currentTelemetryTurn?: number): void {
        const cutoff = this.now() - TURN_HINT_TTL_MS;
        for (const [providerKey, hints] of this.turnHints) {
            const aliveHints = hints.filter(hint => {
                if (hint.updatedAt < cutoff) {
                    return false;
                }
                if (
                    currentTelemetryTurn !== undefined &&
                    hint.telemetryTurn !== undefined &&
                    hint.telemetryTurn < currentTelemetryTurn - 1
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
