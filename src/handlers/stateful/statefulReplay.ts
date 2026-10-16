import { createHash } from 'node:crypto';
import * as vscode from 'vscode';
import { decodeStatefulMarker, encodeStatefulMarker, type StatefulMarkerContainer } from './statefulMarker';
import { CustomDataPartMimeTypes, isStatefulMarkerMimeType } from '../types';

interface ReplayIdentity {
    provider: string;
    modelId: string;
    sdkMode: string;
    credentialId?: string;
    sessionId: string;
    subSessionId?: string;
}

const MAX_SDK_REPLAY_BINDINGS = 1_000;
const SDK_REPLAY_TTL_MS = 7 * 24 * 60 * 60 * 1_000;
const MAX_GEMINI_REPLAY_BYTES = 16 * 1024 * 1024;

interface GeminiReplayCall {
    callId: string;
    name: string;
    input: object;
}

interface GeminiReplayEntry {
    data: Uint8Array;
    expiresAt: number;
}

function geminiReplayKey(
    identity: ReplayIdentity,
    calls: GeminiReplayCall[],
    signatures: string[]
): string | undefined {
    if (
        identity.sdkMode !== 'gemini' ||
        !identity.credentialId ||
        !identity.sessionId.trim() ||
        (calls.length === 0 && signatures.length === 0) ||
        calls.some(
            call =>
                !call.callId || !call.name || !call.input || typeof call.input !== 'object' || Array.isArray(call.input)
        ) ||
        new Set(calls.map(call => call.callId)).size !== calls.length ||
        signatures.some(signature => typeof signature !== 'string' || !signature)
    ) {
        return undefined;
    }
    const proof = JSON.stringify([calls, [...new Set(signatures)].sort()], (_key: string, value: unknown) =>
        value && typeof value === 'object' && !Array.isArray(value) ?
            Object.fromEntries(Object.entries(value).sort(([left], [right]) => left.localeCompare(right)))
        :   value
    );
    return `${replayIdentityHash(identity)}:${createHash('sha256').update(proof).digest('hex')}`;
}

function opaqueStateHashes(metadata: vscode.LanguageModelThinkingPart['metadata']): string[] | undefined {
    const hashes: string[] = [];
    for (const field of ['signature', 'data', 'redactedData', 'encrypted_content', 'encrypted'] as const) {
        const value = metadata?.[field];
        if (value === undefined || value === null || value === '') {
            continue;
        }
        if (typeof value !== 'string') {
            return undefined;
        }
        hashes.push(
            createHash('sha256')
                .update(JSON.stringify([field === 'signature' ? field : 'cipher', value]))
                .digest('hex')
        );
    }
    return hashes;
}

function replayIdentityHash(identity: ReplayIdentity): string {
    return createHash('sha256')
        .update(
            JSON.stringify([
                identity.provider,
                identity.modelId,
                identity.sdkMode,
                identity.credentialId,
                identity.sessionId,
                identity.subSessionId
            ])
        )
        .digest('hex');
}

export class SdkReplayCache {
    private readonly bindings = new Map<string, number>();
    private readonly geminiReplays = new Map<string, GeminiReplayEntry>();
    private geminiReplayBytes = 0;
    private disposed = false;

    constructor(private readonly now: () => number = () => Date.now()) {}

    remember(metadata: vscode.LanguageModelThinkingPart['metadata'], identity: ReplayIdentity): void {
        const hashes = opaqueStateHashes(metadata);
        if (this.disposed || !identity.credentialId || !identity.sessionId.trim() || !hashes?.length) {
            return;
        }
        this.prune();
        const identityHash = replayIdentityHash(identity);
        for (const hash of hashes) {
            const key = `${identityHash}:${hash}`;
            this.bindings.delete(key);
            this.bindings.set(key, this.now() + SDK_REPLAY_TTL_MS);
            if (this.bindings.size > MAX_SDK_REPLAY_BINDINGS) {
                const oldest = this.bindings.keys().next().value;
                if (oldest !== undefined) {
                    this.bindings.delete(oldest);
                }
            }
        }
    }

    rememberGeminiReplay(marker: StatefulMarkerContainer, identity: ReplayIdentity): void {
        if (
            this.disposed ||
            marker.sdkMode !== 'gemini' ||
            marker.provider !== identity.provider ||
            marker.modelId !== identity.modelId ||
            marker.sessionId !== identity.sessionId ||
            marker.subSessionId !== identity.subSessionId ||
            !marker.geminiRequestIdentity ||
            !marker.geminiContents?.length
        ) {
            return;
        }
        this.prune();
        try {
            if (marker.geminiContents.some(content => content.role !== 'model')) {
                return;
            }
            const nativeCalls = marker.geminiContents.flatMap(content =>
                content.parts.flatMap(part => (part.functionCall ? [part.functionCall] : []))
            );
            const references = marker.geminiToolCalls ?? [];
            if (nativeCalls.length !== references.length) {
                return;
            }
            const calls: GeminiReplayCall[] = [];
            for (const [index, call] of nativeCalls.entries()) {
                const reference = references[index];
                if (reference.name !== call.name || reference.upstreamCallId !== call.id) {
                    return;
                }
                calls.push({ callId: reference.localCallId, name: reference.name, input: call.args ?? {} });
            }
            const signatures = (marker.geminiThoughtSignatures ?? []).map(item => item.signature);
            const key = geminiReplayKey(identity, calls, signatures);
            if (!key) {
                return;
            }
            const data = encodeStatefulMarker(identity.modelId, {
                provider: identity.provider,
                modelId: identity.modelId,
                sdkMode: 'gemini',
                sessionId: identity.sessionId,
                subSessionId: identity.subSessionId,
                statefulCredentialId: identity.credentialId,
                responseId: '',
                geminiRequestIdentity: marker.geminiRequestIdentity,
                geminiContents: marker.geminiContents,
                geminiThoughtSignatures: marker.geminiThoughtSignatures,
                geminiToolCalls: marker.geminiToolCalls
            });
            if (data.byteLength > MAX_GEMINI_REPLAY_BYTES) {
                return;
            }
            this.deleteGeminiReplay(key);
            this.geminiReplays.set(key, { data, expiresAt: this.now() + SDK_REPLAY_TTL_MS });
            this.geminiReplayBytes += data.byteLength;
            while (
                this.geminiReplays.size > MAX_SDK_REPLAY_BINDINGS ||
                this.geminiReplayBytes > MAX_GEMINI_REPLAY_BYTES
            ) {
                const oldest = this.geminiReplays.keys().next().value;
                if (oldest === undefined) {
                    break;
                }
                this.deleteGeminiReplay(oldest);
            }
        } catch {
            return;
        }
    }

    getGeminiReplay(
        content: vscode.LanguageModelChatMessage['content'],
        identity: ReplayIdentity
    ): Uint8Array | undefined {
        if (this.disposed || identity.sdkMode !== 'gemini') {
            return undefined;
        }
        this.prune();
        try {
            const calls: GeminiReplayCall[] = [];
            const signatures: string[] = [];
            for (const part of content) {
                if (part instanceof vscode.LanguageModelToolCallPart) {
                    calls.push({ callId: part.callId, name: part.name, input: part.input });
                } else if (part instanceof vscode.LanguageModelThinkingPart) {
                    const metadata = part.metadata;
                    const hashes = opaqueStateHashes(metadata);
                    const signature = metadata?.signature;
                    if (
                        !hashes ||
                        hashes.length !== (signature ? 1 : 0) ||
                        (signature && typeof signature !== 'string') ||
                        (metadata &&
                            'statefulCredentialId' in metadata &&
                            (metadata.provider !== identity.provider ||
                                metadata.modelId !== identity.modelId ||
                                metadata.sdkMode !== identity.sdkMode ||
                                metadata.statefulCredentialId !== identity.credentialId))
                    ) {
                        return undefined;
                    }
                    if (typeof signature === 'string' && signature) {
                        signatures.push(signature);
                    }
                }
            }
            const key = geminiReplayKey(identity, calls, signatures);
            const entry = key ? this.geminiReplays.get(key) : undefined;
            return entry ? Uint8Array.from(entry.data) : undefined;
        } catch {
            return undefined;
        }
    }

    matches(metadata: vscode.LanguageModelThinkingPart['metadata'], identity: ReplayIdentity): boolean {
        const hashes = opaqueStateHashes(metadata);
        if (!hashes) {
            return false;
        }
        if (hashes.length === 0) {
            return true;
        }
        if (this.disposed || !identity.credentialId || !identity.sessionId.trim()) {
            return false;
        }
        this.prune();
        const identityHash = replayIdentityHash(identity);
        return hashes.every(hash => this.bindings.has(`${identityHash}:${hash}`));
    }

    dispose(): void {
        this.disposed = true;
        this.bindings.clear();
        this.geminiReplays.clear();
        this.geminiReplayBytes = 0;
    }

    private deleteGeminiReplay(key: string): void {
        const entry = this.geminiReplays.get(key);
        if (entry) {
            this.geminiReplayBytes -= entry.data.byteLength;
            this.geminiReplays.delete(key);
        }
    }

    private prune(): void {
        const now = this.now();
        for (const [key, expiresAt] of this.bindings) {
            if (expiresAt <= now) {
                this.bindings.delete(key);
            }
        }
        for (const [key, entry] of this.geminiReplays) {
            if (entry.expiresAt <= now) {
                this.deleteGeminiReplay(key);
            }
        }
    }
}

export function filterStatefulReplay(
    messages: readonly vscode.LanguageModelChatMessage[],
    expected: ReplayIdentity,
    sdkReplayCache?: SdkReplayCache
): vscode.LanguageModelChatMessage[] {
    let leadingMarkerMatches: boolean | undefined;
    return messages.map((message, messageIndex) => {
        const isAssistant = message.role === vscode.LanguageModelChatMessageRole.Assistant;
        if (
            sdkReplayCache &&
            isAssistant &&
            leadingMarkerMatches === undefined &&
            !message.content.some(
                part => part instanceof vscode.LanguageModelDataPart && isStatefulMarkerMimeType(part.mimeType)
            )
        ) {
            const replay = sdkReplayCache.getGeminiReplay(message.content, expected);
            if (replay) {
                message = {
                    ...message,
                    content: [
                        ...message.content,
                        new vscode.LanguageModelDataPart(replay, CustomDataPartMimeTypes.SdkContinuity)
                    ]
                };
            }
        }
        let latest: ReturnType<typeof decodeStatefulMarker>;
        let latestIndex = -1;
        if (isAssistant) {
            for (let index = message.content.length - 1; index >= 0; index--) {
                const part = message.content[index];
                if (part instanceof vscode.LanguageModelDataPart && isStatefulMarkerMimeType(part.mimeType)) {
                    latest = decodeStatefulMarker(part.data);
                    if (latest) {
                        latestIndex = index;
                        break;
                    }
                }
            }
        }

        let matches: boolean | undefined;
        if (latest) {
            const marker = latest.marker;
            const credentialId = marker.statefulCredentialId;
            const affinityCredentialId = marker.balanceAffinity?.credentialId;
            matches =
                marker.provider === expected.provider &&
                marker.modelId === expected.modelId &&
                marker.sdkMode === expected.sdkMode &&
                marker.sessionId === expected.sessionId &&
                marker.subSessionId === expected.subSessionId &&
                (credentialId === undefined || credentialId === expected.credentialId) &&
                (affinityCredentialId === undefined || affinityCredentialId === expected.credentialId) &&
                (marker.continuity === undefined || credentialId !== undefined || affinityCredentialId !== undefined);
        }

        if (messageIndex === 0 && latest && message.content.length === 1) {
            leadingMarkerMatches = matches;
        }
        const markerMatches = matches ?? leadingMarkerMatches;
        const rejectThinking = isAssistant && markerMatches === false;

        const content: vscode.LanguageModelChatMessage['content'] = [];
        let changed = false;
        for (const [index, part] of message.content.entries()) {
            if (part instanceof vscode.LanguageModelThinkingPart) {
                const metadata = part.metadata;
                const sdkBindingMatches =
                    sdkReplayCache && isAssistant && markerMatches !== true ?
                        sdkReplayCache.matches(metadata, expected)
                    :   undefined;
                if (
                    rejectThinking ||
                    (metadata &&
                        'statefulCredentialId' in metadata &&
                        (metadata.provider !== expected.provider ||
                            metadata.modelId !== expected.modelId ||
                            metadata.sdkMode !== expected.sdkMode ||
                            metadata.statefulCredentialId !== expected.credentialId)) ||
                    sdkBindingMatches === false
                ) {
                    if (sdkReplayCache) {
                        const value = typeof part.value === 'string' ? part.value : part.value.join('');
                        const complete =
                            typeof metadata?._completeThinking === 'string' ? metadata._completeThinking : '';
                        const visible = complete.length > value.length ? complete : value;
                        if (visible.trim()) {
                            content.push(new vscode.LanguageModelTextPart(visible));
                        }
                    }
                    changed = true;
                    continue;
                }
                if (sdkBindingMatches === true && opaqueStateHashes(metadata)?.length) {
                    content.push(
                        new vscode.LanguageModelThinkingPart(part.value, part.id, {
                            ...metadata,
                            provider: expected.provider,
                            modelId: expected.modelId,
                            sdkMode: expected.sdkMode,
                            statefulCredentialId: expected.credentialId
                        }) as unknown as vscode.LanguageModelChatMessage['content'][number]
                    );
                    changed = true;
                    continue;
                }
            }
            if (isAssistant && part instanceof vscode.LanguageModelDataPart) {
                if (
                    (rejectThinking || (sdkReplayCache && markerMatches !== true)) &&
                    part.mimeType === CustomDataPartMimeTypes.ThinkingData
                ) {
                    changed = true;
                    continue;
                }
                if (latest && isStatefulMarkerMimeType(part.mimeType) && (!matches || index !== latestIndex)) {
                    const decoded = decodeStatefulMarker(part.data);
                    if (decoded) {
                        // 部分转换器正序读取首个含协议状态的 marker。
                        content.push(
                            new vscode.LanguageModelDataPart(
                                encodeStatefulMarker(decoded.modelId, {
                                    ...decoded.marker,
                                    responseId: '',
                                    completeSignature: undefined,
                                    encryptedReasoning: undefined,
                                    encryptedThinkingData: undefined,
                                    geminiContents: undefined,
                                    geminiThoughtSignatures: undefined,
                                    geminiRequestIdentity: undefined,
                                    geminiToolCalls: undefined
                                }),
                                part.mimeType
                            )
                        );
                        changed = true;
                        continue;
                    }
                }
            }
            content.push(part);
        }
        return changed ? { ...message, content } : message;
    });
}
