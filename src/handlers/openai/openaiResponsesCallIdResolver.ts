import * as crypto from 'node:crypto';

import { canonicalizeJsonString } from './openaiChatRequestPreprocessor';
import { uniquifyCallId } from '../toolCallIdUtils';

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
    private readonly pendingCalls: Array<{ originalCallId?: string; resolvedCallId: string }> = [];
    private readonly usedCallIds = new Set<string>();

    resolveToolCallId(params: ResolveToolCallIdParams): string {
        const originalCallId = normalizeCallId(params.callId);
        const resolvedCallId = uniquifyCallId(this.usedCallIds, originalCallId || buildDeterministicCallId(params));
        this.pendingCalls.push({ originalCallId, resolvedCallId });
        return resolvedCallId;
    }

    resolveToolResultCallId(params: ResolveToolResultCallIdParams): string | undefined {
        const originalCallId = normalizeCallId(params.callId);
        if (!originalCallId) {
            return this.pendingCalls.shift()?.resolvedCallId;
        }
        const index = this.pendingCalls.findIndex(
            call => (call.originalCallId ?? call.resolvedCallId) === originalCallId
        );
        return index >= 0 ? this.pendingCalls.splice(index, 1)[0].resolvedCallId : originalCallId;
    }
}
