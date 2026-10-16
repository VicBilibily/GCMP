import * as crypto from 'node:crypto';
import * as vscode from 'vscode';
import type { RequestBehavior } from '../../handlers/classification/requestBehavior';
import type { RequestClassification, RequestContinuity } from '../../handlers/classification/requestClassification';
import {
    decodeStatefulMarker,
    encodeStatefulMarker,
    type StatefulMarkerContainer
} from '../../handlers/stateful/statefulMarker';
import { describeStatefulMarkerPayload } from '../../handlers/stateful/statefulMarkerCodec';
import { CustomDataPartMimeTypes, isStatefulMarkerMimeType } from '../../handlers/types';
import type { SdkUsageCache } from '../../utils/model/sdkUsageCache';
import type { SdkReplayCache } from '../../handlers/stateful/statefulReplay';
import { Logger } from '../../utils/runtime/logger';

interface ResponseContext {
    behavior: RequestBehavior;
    classification: RequestClassification;
    providerKey: string;
    modelId: string;
    sdkMode: string;
    requestId: string;
    sessionId: string;
    subSessionId?: string;
    continuity: RequestContinuity;
    continuityAgentRole: RequestClassification['agentRole'];
    options: vscode.ProvideLanguageModelChatResponseOptions;
    token: vscode.CancellationToken;
    sdkUsageCache?: SdkUsageCache;
    sdkReplayCache?: SdkReplayCache;
}

interface ResponseAttempt {
    balanceAffinity?: StatefulMarkerContainer['balanceAffinity'];
    statefulCredentialId?: string;
}

export function createResponseProcessor(
    context: ResponseContext
): (value: vscode.LanguageModelResponsePart, attempt: ResponseAttempt) => vscode.LanguageModelResponsePart | undefined {
    const { behavior, classification, providerKey, modelId, sdkMode, sessionId, subSessionId, options, token } =
        context;
    return (value, { balanceAffinity, statefulCredentialId }) => {
        const replayIdentity = {
            provider: providerKey,
            modelId,
            sdkMode:
                sdkMode === 'openai-sse' ? 'openai'
                : sdkMode === 'gemini-sse' ? 'gemini'
                : sdkMode,
            sessionId,
            subSessionId,
            credentialId: statefulCredentialId
        };
        if (value instanceof vscode.LanguageModelThinkingPart) {
            if (behavior.kind === 'sdk' && !token.isCancellationRequested) {
                context.sdkReplayCache?.remember(value.metadata, replayIdentity);
            }
            value = new vscode.LanguageModelThinkingPart(value.value, value.id, {
                ...value.metadata,
                provider: providerKey,
                modelId,
                sdkMode:
                    sdkMode === 'openai-sse' ? 'openai'
                    : sdkMode === 'gemini-sse' ? 'gemini'
                    : sdkMode,
                statefulCredentialId
            }) as unknown as vscode.LanguageModelResponsePart;
        }
        if (
            behavior.kind === 'sdk' &&
            value instanceof vscode.LanguageModelDataPart &&
            isStatefulMarkerMimeType(value.mimeType)
        ) {
            const decoded = decodeStatefulMarker(value.data);
            if (
                !token.isCancellationRequested &&
                decoded?.modelId === modelId &&
                decoded.marker.sessionId === sessionId &&
                decoded.marker.subSessionId === subSessionId
            ) {
                context.sdkUsageCache?.remember(options, { ...decoded.marker, provider: providerKey });
                context.sdkReplayCache?.rememberGeminiReplay(
                    { ...decoded.marker, provider: providerKey },
                    replayIdentity
                );
            }
            return undefined;
        }
        if (
            value instanceof vscode.LanguageModelDataPart &&
            value.mimeType === CustomDataPartMimeTypes.StatefulMarker
        ) {
            const decoded = decodeStatefulMarker(value.data);
            if (
                decoded?.marker?.extension === 'vicanent.gcmp' &&
                decoded.marker.sessionId === sessionId &&
                decoded.marker.subSessionId === subSessionId
            ) {
                value = new vscode.LanguageModelDataPart(
                    encodeStatefulMarker(modelId, {
                        ...decoded.marker,
                        provider: providerKey,
                        balanceAffinity,
                        statefulCredentialId,
                        continuity: {
                            version: 1,
                            scope: context.continuity.scope,
                            agentRole: context.continuityAgentRole
                        }
                    }),
                    CustomDataPartMimeTypes.StatefulMarker
                );
            }
            try {
                if (Logger.isDebugEnabled() && options.requestInitiator === 'core') {
                    Logger.debug(
                        `[MarkerContinuity] output ${JSON.stringify({
                            version: 1,
                            requestHash: crypto.createHash('sha256').update(context.requestId).digest('hex'),
                            origin: classification.requestOrigin,
                            mimeType: (value as vscode.LanguageModelDataPart).mimeType,
                            modelHash: crypto.createHash('sha256').update(modelId).digest('hex'),
                            sessionHash: crypto.createHash('sha256').update(sessionId).digest('hex'),
                            ...describeStatefulMarkerPayload((value as vscode.LanguageModelDataPart).data, modelId)
                        })}`
                    );
                }
            } catch {
                // 诊断失败不得影响模型请求。
            }
        }
        return value;
    };
}
