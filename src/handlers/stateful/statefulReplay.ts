import * as vscode from 'vscode';
import { decodeStatefulMarker, encodeStatefulMarker } from './statefulMarker';
import { CustomDataPartMimeTypes } from '../types';

export function filterStatefulReplay(
    messages: readonly vscode.LanguageModelChatMessage[],
    expected: {
        provider: string;
        modelId: string;
        sdkMode: string;
        credentialId?: string;
        sessionId: string;
        subSessionId?: string;
    }
): vscode.LanguageModelChatMessage[] {
    let leadingMarkerMatches: boolean | undefined;
    return messages.map((message, messageIndex) => {
        const isAssistant = message.role === vscode.LanguageModelChatMessageRole.Assistant;
        let latest: ReturnType<typeof decodeStatefulMarker>;
        let latestIndex = -1;
        if (isAssistant) {
            for (let index = message.content.length - 1; index >= 0; index--) {
                const part = message.content[index];
                if (
                    part instanceof vscode.LanguageModelDataPart &&
                    part.mimeType === CustomDataPartMimeTypes.StatefulMarker
                ) {
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
        const rejectThinking = isAssistant && (matches ?? leadingMarkerMatches) === false;

        const content: vscode.LanguageModelChatMessage['content'] = [];
        let changed = false;
        for (const [index, part] of message.content.entries()) {
            if (part instanceof vscode.LanguageModelThinkingPart) {
                const metadata = part.metadata;
                if (
                    rejectThinking ||
                    (metadata &&
                        'statefulCredentialId' in metadata &&
                        (metadata.provider !== expected.provider ||
                            metadata.modelId !== expected.modelId ||
                            metadata.sdkMode !== expected.sdkMode ||
                            metadata.statefulCredentialId !== expected.credentialId))
                ) {
                    changed = true;
                    continue;
                }
            }
            if (isAssistant && part instanceof vscode.LanguageModelDataPart) {
                if (rejectThinking && part.mimeType === CustomDataPartMimeTypes.ThinkingData) {
                    changed = true;
                    continue;
                }
                if (
                    latest &&
                    part.mimeType === CustomDataPartMimeTypes.StatefulMarker &&
                    (!matches || index !== latestIndex)
                ) {
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
