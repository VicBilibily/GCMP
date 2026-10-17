import { Logger } from '../../../../utils/runtime/logger';
import { canonicalizeJsonString } from '../../shared/json';

export interface OpenAIResponsesToolCallBuffer {
    id: string;
    name: string;
    args: string;
}

function getContentEventKey(itemId?: string, contentIndex?: number): string | undefined {
    if (!itemId) {
        return undefined;
    }
    return `${itemId}:${contentIndex ?? -1}`;
}

function getSummaryEventKey(itemId?: string, summaryIndex?: number): string | undefined {
    if (!itemId) {
        return undefined;
    }
    return `${itemId}:summary:${summaryIndex ?? -1}`;
}

export class OpenAIResponsesStreamState {
    private readonly textDeltaKeys = new Set<string>();
    private readonly refusalDeltaKeys = new Set<string>();
    private readonly reasoningTextDeltaKeys = new Set<string>();
    private readonly reasoningSummaryDeltaKeys = new Set<string>();
    private readonly reasoningSummaryItemIds = new Set<string>();

    private readonly toolCallBuffers = new Map<number, OpenAIResponsesToolCallBuffer>();
    private readonly completedToolCallIndices = new Set<number>();
    private readonly deltaCountedToolCallIndices = new Set<number>();
    private readonly toolCallIdToIndex = new Map<string, number>();
    private readonly callIdAliases = new Map<string, number | null>();
    private readonly provisionalCallIds = new Set<string>();
    private readonly completedWebSearchCallIds = new Set<string>();
    private readonly outputIndices = new Map<number, number>();
    private completedPhaseCandidates = new Map<number, OpenAIResponsesToolCallBuffer>();
    private nextToolCallIndex = 0;
    private lastTextDeltaOutputIndex: number | undefined;

    rememberOutputTextDelta(itemId?: string, contentIndex?: number): void {
        const eventKey = getContentEventKey(itemId, contentIndex);
        if (eventKey) {
            this.textDeltaKeys.add(eventKey);
        }
    }

    shouldSkipOutputTextDone(itemId?: string, contentIndex?: number): boolean {
        const eventKey = getContentEventKey(itemId, contentIndex);
        return Boolean(eventKey && this.textDeltaKeys.has(eventKey));
    }

    rememberRefusalDelta(itemId?: string, contentIndex?: number): void {
        const eventKey = getContentEventKey(itemId, contentIndex);
        if (eventKey) {
            this.refusalDeltaKeys.add(eventKey);
        }
    }

    shouldSkipRefusalDone(itemId?: string, contentIndex?: number): boolean {
        const eventKey = getContentEventKey(itemId, contentIndex);
        return Boolean(eventKey && this.refusalDeltaKeys.has(eventKey));
    }

    rememberReasoningTextDelta(itemId?: string, contentIndex?: number): void {
        const eventKey = getContentEventKey(itemId, contentIndex);
        if (eventKey) {
            this.reasoningTextDeltaKeys.add(eventKey);
        }
    }

    hasReasoningTextDelta(itemId?: string, contentIndex?: number): boolean {
        const eventKey = getContentEventKey(itemId, contentIndex);
        return Boolean(eventKey && this.reasoningTextDeltaKeys.has(eventKey));
    }

    rememberReasoningSummaryDelta(itemId?: string, summaryIndex?: number): void {
        const eventKey = getSummaryEventKey(itemId, summaryIndex);
        if (eventKey) {
            this.reasoningSummaryDeltaKeys.add(eventKey);
        }
        this.rememberReasoningSummaryItem(itemId);
    }

    rememberReasoningSummaryItem(itemId?: string): void {
        if (itemId) {
            this.reasoningSummaryItemIds.add(itemId);
        }
    }

    hasReasoningSummaryDelta(itemId?: string, summaryIndex?: number): boolean {
        const eventKey = getSummaryEventKey(itemId, summaryIndex);
        return Boolean(eventKey && this.reasoningSummaryDeltaKeys.has(eventKey));
    }

    hasReasoningSummaryItem(itemId?: string): boolean {
        return Boolean(itemId && this.reasoningSummaryItemIds.has(itemId));
    }

    getToolCallIndex(callId: string): number {
        if (!this.toolCallIdToIndex.has(callId)) {
            this.toolCallIdToIndex.set(callId, this.nextToolCallIndex++);
        }
        return this.toolCallIdToIndex.get(callId)!;
    }

    linkToolCallId(callId: string, idx: number): void {
        const existing = this.callIdAliases.get(callId);
        this.callIdAliases.set(callId, existing === undefined || existing === idx ? idx : null);
        if ([...this.toolCallIdToIndex.values()].includes(idx)) {
            this.provisionalCallIds.delete(callId);
        }
    }

    getStableToolCallIndex(itemId?: string, callId?: string, outputIndex?: number): number | undefined {
        if (outputIndex !== undefined) {
            const existing = this.outputIndices.get(outputIndex);
            if (existing !== undefined) {
                if (itemId) {
                    this.toolCallIdToIndex.set(itemId, existing);
                }
                if (callId) {
                    this.linkToolCallId(callId, existing);
                }
                return existing;
            }
            const alias = callId ? this.callIdAliases.get(callId) : undefined;
            const aliasAlreadyIndexed = typeof alias === 'number' && [...this.outputIndices.values()].includes(alias);
            const idx =
                !itemId && aliasAlreadyIndexed ?
                    this.nextToolCallIndex++
                :   (this.getStableToolCallIndex(itemId, callId) ?? this.nextToolCallIndex++);
            this.outputIndices.set(outputIndex, idx);
            if (callId) {
                this.linkToolCallId(callId, idx);
            }
            return idx;
        }
        if (itemId) {
            const provisionalIndex =
                callId && this.provisionalCallIds.has(callId) ? this.callIdAliases.get(callId) : undefined;
            if (provisionalIndex !== undefined && provisionalIndex !== null && !this.toolCallIdToIndex.has(itemId)) {
                this.toolCallIdToIndex.set(itemId, provisionalIndex);
                this.provisionalCallIds.delete(callId!);
                return provisionalIndex;
            }

            const idx = this.getToolCallIndex(itemId);
            if (callId) {
                this.linkToolCallId(callId, idx);
            }
            return idx;
        }
        if (!callId) {
            return undefined;
        }

        const existingIndex = this.callIdAliases.get(callId);
        if (existingIndex !== undefined) {
            return existingIndex ?? undefined;
        }

        const provisionalIndex = this.nextToolCallIndex++;
        this.callIdAliases.set(callId, provisionalIndex);
        this.provisionalCallIds.add(callId);
        return provisionalIndex;
    }

    beginCompletedPhase(items: Array<{ id?: string }>): void {
        this.completedPhaseCandidates = new Map(this.toolCallBuffers);
        for (const [outputIndex, item] of items.entries()) {
            const idx =
                (item.id ? this.toolCallIdToIndex.get(item.id) : undefined) ?? this.outputIndices.get(outputIndex);
            if (idx !== undefined) {
                this.completedPhaseCandidates.delete(idx);
            }
        }
    }

    getCompletedPhaseToolCallIndex(
        itemId?: string,
        callId?: string,
        name?: string,
        args?: string,
        outputIndex?: number
    ): number | undefined {
        const known =
            (itemId ? this.toolCallIdToIndex.get(itemId) : undefined) ??
            (outputIndex !== undefined ? this.outputIndices.get(outputIndex) : undefined);
        if (known !== undefined) {
            this.completedPhaseCandidates.delete(known);
            return known;
        }
        const candidates = [...this.completedPhaseCandidates].filter(
            ([, buffer]) =>
                buffer.id === callId &&
                buffer.name === name &&
                (args === undefined || canonicalizeJsonString(buffer.args) === canonicalizeJsonString(args || '{}'))
        );
        if (args === undefined && candidates.length > 1) {
            Logger.warn(`Ambiguous completed tool call without arguments: ${callId}`);
            return undefined;
        }
        // 只消费终态前的记录，终态新项即使内容完全相同也保留。
        const candidate = candidates[0];
        if (candidate) {
            const [idx] = candidate;
            this.completedPhaseCandidates.delete(idx);
            if (itemId) {
                this.toolCallIdToIndex.set(itemId, idx);
            }
            if (outputIndex !== undefined) {
                this.outputIndices.set(outputIndex, idx);
            }
            return idx;
        }
        const idx = itemId ? this.getToolCallIndex(itemId) : this.nextToolCallIndex++;
        if (callId) {
            this.linkToolCallId(callId, idx);
        }
        if (outputIndex !== undefined) {
            this.outputIndices.set(outputIndex, idx);
        }
        return idx;
    }

    getPendingToolCalls(): Array<[number, OpenAIResponsesToolCallBuffer]> {
        return [...this.toolCallBuffers].filter(([idx]) => !this.isToolCallCompleted(idx));
    }

    getToolCallBuffer(idx: number): OpenAIResponsesToolCallBuffer | undefined {
        return this.toolCallBuffers.get(idx);
    }

    setToolCallBuffer(idx: number, buffer: OpenAIResponsesToolCallBuffer): void {
        this.toolCallBuffers.set(idx, buffer);
    }

    isToolCallCompleted(idx: number): boolean {
        return this.completedToolCallIndices.has(idx);
    }

    markToolCallCompleted(idx: number): void {
        this.completedToolCallIndices.add(idx);
    }

    markToolCallDeltaCounted(idx: number): void {
        this.deltaCountedToolCallIndices.add(idx);
    }

    wasToolCallDeltaCounted(idx: number): boolean {
        return this.deltaCountedToolCallIndices.has(idx);
    }

    markWebSearchCallReported(wsId?: string): boolean {
        if (!wsId || this.completedWebSearchCallIds.has(wsId)) {
            return false;
        }

        this.completedWebSearchCallIds.add(wsId);
        return true;
    }

    /** 跨 output_index 的正文需要分段，避免 commentary 与最终答案粘连。 */
    shouldSeparateOutputText(outputIndex?: number): boolean {
        if (typeof outputIndex !== 'number') {
            return false;
        }

        const shouldSeparate =
            this.lastTextDeltaOutputIndex !== undefined && this.lastTextDeltaOutputIndex !== outputIndex;
        this.lastTextDeltaOutputIndex = outputIndex;
        return shouldSeparate;
    }
}
