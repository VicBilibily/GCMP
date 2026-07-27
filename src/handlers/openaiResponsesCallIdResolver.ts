import * as crypto from 'node:crypto';

import { canonicalizeJsonString } from './openaiChatRequestPreprocessor';

interface ResolveToolCallIdParams {
    callId?: string;
    messageIndex: number;
    partIndex: number;
    name: string;
    argumentsJson: string;
}

interface ResolveToolResultCallIdParams {
    callId?: string;
}

function normalizeCallId(callId?: string): string | undefined {
    const trimmed = callId?.trim();
    return trimmed ? trimmed : undefined;
}

function buildDeterministicCallId(params: ResolveToolCallIdParams): string {
    const payload = {
        type: 'function_call',
        messageIndex: params.messageIndex,
        partIndex: params.partIndex,
        name: params.name,
        arguments: canonicalizeJsonString(params.argumentsJson)
    };
    const digest = crypto.createHash('sha256').update(JSON.stringify(payload)).digest('hex').slice(0, 24);
    return `call_${digest}`;
}

export class OpenAIResponsesCallIdResolver {
    private pendingCallIds: string[] = [];

    resolveToolCallId(params: ResolveToolCallIdParams): string {
        const resolvedCallId = normalizeCallId(params.callId) || buildDeterministicCallId(params);
        this.pendingCallIds.push(resolvedCallId);
        return resolvedCallId;
    }

    resolveToolResultCallId(params: ResolveToolResultCallIdParams): string | undefined {
        const resolvedCallId = normalizeCallId(params.callId);
        if (resolvedCallId) {
            this.removePendingCallId(resolvedCallId);
            return resolvedCallId;
        }

        return this.pendingCallIds.shift();
    }

    private removePendingCallId(callId: string): void {
        const index = this.pendingCallIds.indexOf(callId);
        if (index >= 0) {
            this.pendingCallIds.splice(index, 1);
        }
    }
}
