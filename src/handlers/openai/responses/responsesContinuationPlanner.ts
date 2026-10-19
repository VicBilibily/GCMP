import { createHmac, randomBytes } from 'node:crypto';
import { isResponsesReasoningId } from '../encryptedReasoning';
import { sortObjectKeysRecursively } from '../shared/json';
import type { ResponsesTerminalReceipt } from '../transport/responsesWebSocketTransport';

interface FunctionCall {
    type: 'function_call';
    call_id: string;
    name: string;
    arguments: string;
    status: 'completed';
}

interface AssistantMessage {
    type: 'message';
    role: 'assistant';
    status: 'completed';
    content: Array<{ type: 'output_text'; text: string }>;
}

interface EncryptedReasoning {
    type: 'reasoning';
    summary: [];
    encrypted_content: string;
    id?: string;
}

interface Checkpoint {
    responseId: string;
    generation: number;
    semantics: string;
    prefix: string;
    count: number;
    pendingCalls: readonly string[];
}

type CheckpointCommitReason =
    | 'committed'
    | 'stale-plan'
    | 'invalid-input'
    | 'stale-lease'
    | 'missing-receipt'
    | 'incomplete-response'
    | 'incomplete-output'
    | 'unsupported-output'
    | 'unsupported-input'
    | 'pending-calls-limit';

export interface ResponsesRequestPlan {
    readonly fullBody: Readonly<Record<string, unknown>>;
    readonly body: Readonly<Record<string, unknown>>;
    readonly turn?: string | number;
    readonly previousResponseId?: string;
    readonly mode: 'full' | 'delta';
    readonly contextEpoch: number;
    readonly checkpointVersion: number;
    readonly generation: number;
    readonly reason: string;
    readonly semantics: string;
}

function isObject(value: unknown): value is Record<string, unknown> {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function encode(value: unknown, ancestors = new Set<object>()): string {
    if (value === undefined) {
        return 'u';
    }
    if (value === null) {
        return 'n';
    }
    if (typeof value === 'string' || typeof value === 'boolean') {
        return JSON.stringify(value);
    }
    if (typeof value === 'number' && Number.isFinite(value)) {
        return JSON.stringify(value);
    }
    if (typeof value !== 'object' || ancestors.has(value)) {
        throw new Error('Invalid Responses context value');
    }
    ancestors.add(value);
    try {
        if (Array.isArray(value)) {
            return `[${value.map(item => encode(item, ancestors)).join(',')}]`;
        }
        if (!isObject(value) || Object.getPrototypeOf(value) !== Object.prototype) {
            throw new Error('Invalid Responses context object');
        }
        return `{${Object.keys(value)
            .sort()
            .map(key => `${JSON.stringify(key)}:${encode(value[key], ancestors)}`)
            .join(',')}}`;
    } finally {
        ancestors.delete(value);
    }
}

function pendingCalls(input: readonly unknown[]): string[] {
    const calls = new Set<string>();
    const results = new Set<string>();
    for (const item of input) {
        if (!isObject(item)) {
            throw new Error('MissingReplayContext: invalid input item');
        }
        if (item.type === 'function_call') {
            if (typeof item.call_id !== 'string' || !item.call_id || calls.has(item.call_id)) {
                throw new Error('MissingReplayContext: ambiguous tool call');
            }
            calls.add(item.call_id);
        }
        if (item.type === 'function_call_output') {
            if (typeof item.call_id !== 'string' || !calls.has(item.call_id) || results.has(item.call_id)) {
                throw new Error('MissingReplayContext: orphan or duplicate tool result');
            }
            results.add(item.call_id);
        }
    }
    return [...calls].filter(callId => !results.has(callId));
}

function replayReasoning(item: Record<string, unknown>): EncryptedReasoning | undefined {
    if (
        typeof item.encrypted_content !== 'string' ||
        !item.encrypted_content ||
        !Array.isArray(item.summary) ||
        !item.summary.every(part => isObject(part) && part.type === 'summary_text' && typeof part.text === 'string') ||
        (item.id !== undefined && typeof item.id !== 'string')
    ) {
        return undefined;
    }
    return {
        type: 'reasoning',
        summary: [],
        encrypted_content: item.encrypted_content,
        ...(typeof item.id === 'string' && isResponsesReasoningId(item.id) ? { id: item.id } : {})
    };
}

function replayOutput(
    output: readonly unknown[]
): Array<AssistantMessage | FunctionCall | EncryptedReasoning> | undefined {
    const reasonings: EncryptedReasoning[] = [];
    const calls: FunctionCall[] = [];
    const texts: string[] = [];
    for (const item of output) {
        if (!isObject(item)) {
            return undefined;
        }
        if (item.type === 'message') {
            if (item.role !== 'assistant' || !Array.isArray(item.content)) {
                return undefined;
            }
            const parts: string[] = [];
            for (const part of item.content) {
                if (
                    !isObject(part) ||
                    part.type !== 'output_text' ||
                    typeof part.text !== 'string' ||
                    (part.annotations !== undefined &&
                        (!Array.isArray(part.annotations) || part.annotations.length > 0))
                ) {
                    return undefined;
                }
                parts.push(part.text);
            }
            texts.push(parts.join(''));
        } else if (item.type === 'reasoning') {
            const reasoning = replayReasoning(item);
            if (!reasoning) {
                return undefined;
            }
            reasonings.push(reasoning);
        } else if (item.type === 'function_call') {
            if (
                typeof item.call_id !== 'string' ||
                typeof item.name !== 'string' ||
                !item.name ||
                typeof item.arguments !== 'string'
            ) {
                return undefined;
            }
            let argumentsJson: string;
            try {
                const parsed: unknown = JSON.parse(item.arguments);
                if (!isObject(parsed)) {
                    return undefined;
                }
                argumentsJson = JSON.stringify(sortObjectKeysRecursively(parsed));
            } catch {
                return undefined;
            }
            calls.push({
                type: 'function_call',
                call_id: item.call_id,
                name: item.name,
                arguments: argumentsJson,
                status: 'completed'
            });
        } else {
            return undefined;
        }
    }
    if (new Set(calls.map(call => call.call_id)).size !== calls.length) {
        return undefined;
    }
    const text = texts.filter(Boolean).join('\n\n').trim();
    return [
        ...reasonings,
        ...(text ?
            [
                {
                    type: 'message' as const,
                    role: 'assistant' as const,
                    status: 'completed' as const,
                    content: [{ type: 'output_text' as const, text }]
                }
            ]
        :   []),
        ...calls
    ];
}

export class ResponsesContinuationPlanner {
    private readonly secret = randomBytes(32);
    private checkpoint?: Checkpoint;
    private contextEpoch = 0;
    private version = 0;
    private lastCommitReason?: CheckpointCommitReason;

    plan(
        body: Readonly<Record<string, unknown>>,
        generation: number,
        allowDelta: boolean,
        turn?: string | number
    ): ResponsesRequestPlan {
        if (!Array.isArray(body.input)) {
            throw new Error('MissingReplayContext: full Responses input required');
        }
        const pending = pendingCalls(body.input);
        const input = body.input;
        const parameters = { ...body };
        delete parameters.input;
        delete parameters.stream;
        const requestTurn =
            (
                (typeof turn === 'string' && turn.trim().length > 0) ||
                (typeof turn === 'number' && Number.isFinite(turn))
            ) ?
                turn
            :   undefined;
        const semantics = this.hash(parameters);
        const checkpoint = this.checkpoint;
        const suffix = checkpoint ? input.slice(checkpoint.count) : [];
        const results = suffix.filter(item => isObject(item) && item.type === 'function_call_output');
        let mismatch: string | undefined;
        if (!checkpoint) {
            mismatch = 'no-checkpoint';
        } else if (checkpoint.generation !== generation) {
            mismatch = 'generation-changed';
        } else if (checkpoint.semantics !== semantics) {
            mismatch = 'semantics-changed';
        } else if (input.length < checkpoint.count) {
            mismatch = 'input-truncated';
        } else if (this.hash(input.slice(0, checkpoint.count)) !== checkpoint.prefix) {
            mismatch = 'prefix-changed';
        } else if (
            !checkpoint.pendingCalls.every(callId => results.some(item => isObject(item) && item.call_id === callId))
        ) {
            mismatch = 'pending-results';
        } else if (pending.length > 0) {
            mismatch = 'pending-calls';
        }
        const matched = checkpoint && mismatch === undefined;
        if (allowDelta && matched && suffix.length > 0) {
            const deltaBody: Record<string, unknown> = { ...body, input: suffix };
            return {
                fullBody: body,
                body: deltaBody,
                turn: requestTurn,
                previousResponseId: checkpoint.responseId,
                mode: 'delta',
                contextEpoch: this.contextEpoch,
                checkpointVersion: this.version,
                generation,
                reason: 'verified-prefix',
                semantics
            };
        }
        if (checkpoint && !matched) {
            this.contextEpoch++;
        }
        this.checkpoint = undefined;
        this.version++;
        return {
            fullBody: body,
            body,
            turn: requestTurn,
            mode: 'full',
            contextEpoch: this.contextEpoch,
            checkpointVersion: this.version,
            generation,
            reason: !allowDelta ? 'delta-disabled' : (mismatch ?? 'no-new-input'),
            semantics
        };
    }

    commit(plan: ResponsesRequestPlan, receipt: ResponsesTerminalReceipt | undefined, leaseCurrent: boolean): boolean {
        this.lastCommitReason = undefined;
        if (plan.contextEpoch !== this.contextEpoch || plan.checkpointVersion !== this.version) {
            this.lastCommitReason = 'stale-plan';
            return false;
        }
        if (!Array.isArray(plan.fullBody.input)) {
            this.lastCommitReason = 'invalid-input';
            return false;
        }
        if (!leaseCurrent || !receipt || receipt.type !== 'response.completed') {
            this.lastCommitReason =
                !leaseCurrent ? 'stale-lease'
                : !receipt ? 'missing-receipt'
                : 'incomplete-response';
            this.invalidate();
            return false;
        }
        if (receipt.outputComplete === false) {
            this.lastCommitReason = 'incomplete-output';
            this.invalidate();
            return false;
        }
        const output = replayOutput(receipt.output);
        const supportedInput = plan.fullBody.input.every(
            item =>
                isObject(item) &&
                (['message', 'function_call', 'function_call_output'].includes(String(item.type)) ||
                    (item.type === 'reasoning' && replayReasoning(item) !== undefined))
        );
        if (!output || !supportedInput) {
            this.lastCommitReason = !output ? 'unsupported-output' : 'unsupported-input';
            this.invalidate();
            return false;
        }
        const prefix: unknown[] = [...plan.fullBody.input, ...output];
        const calls = pendingCalls(prefix);
        if (Buffer.byteLength(encode(calls)) > 256 * 1024) {
            this.lastCommitReason = 'pending-calls-limit';
            this.invalidate();
            return false;
        }
        this.checkpoint = {
            responseId: receipt.responseId,
            generation: plan.generation,
            semantics: plan.semantics,
            prefix: this.hash(prefix),
            count: prefix.length,
            pendingCalls: calls
        };
        this.version++;
        this.lastCommitReason = 'committed';
        return true;
    }

    invalidate(): void {
        this.checkpoint = undefined;
        this.contextEpoch++;
        this.version++;
    }

    diagnostics(): {
        contextEpoch: number;
        checkpointVersion: number;
        hasCheckpoint: boolean;
        lastCommitReason?: CheckpointCommitReason;
    } {
        return {
            contextEpoch: this.contextEpoch,
            checkpointVersion: this.version,
            hasCheckpoint: !!this.checkpoint,
            lastCommitReason: this.lastCommitReason
        };
    }

    private hash(value: unknown): string {
        return createHmac('sha256', this.secret)
            .update(`responses-context-v1:${encode(value)}`)
            .digest('hex');
    }
}
