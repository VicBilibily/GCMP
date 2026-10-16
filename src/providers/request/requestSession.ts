import * as crypto from 'node:crypto';
import type { LanguageModelChatMessage, ProvideLanguageModelChatResponseOptions } from 'vscode';
import type { RequestBehavior } from '../../handlers/classification/requestBehavior';
import {
    getRequestClassificationMetadata,
    getRequestContinuity,
    type RequestClassification,
    type RequestContinuity
} from '../../handlers/classification/requestClassification';
import { getSdkSessionContextKey } from '../../handlers/classification/requestClassifier';
import { getAllStatefulMarkersAndIndicies } from '../../handlers/stateful/statefulMarker';
import { canRestoreMarkerSession } from '../../handlers/stateful/statefulMarkerRecovery';
import { SessionRecoveryService, type SessionRecoveryMetadata } from '../../usages/sessionRecoveryService';
import { SessionTitleService } from '../../usages/sessionTitleService';
import { resolveSubSessionId } from '../../usages/subSessionResolver';
import type { SessionRecoverySource } from '../../usages/fileLogger/types';
import { getBalanceTurnKey } from '../../utils/config/failover/balanceAffinityCache';
import { Logger } from '../../utils/runtime/logger';

export interface SessionIdResolution {
    sessionId: string;
    sessionRecoverySource: SessionRecoverySource | 'sdk-session';
}

export interface RequestTracking {
    sessionId: string;
    subSessionId?: string;
    sessionRecoverySource?: SessionRecoverySource;
    requestContinuity: RequestContinuity;
}

export function resolveRequestTracking(
    resolution: SessionIdResolution,
    messages: readonly LanguageModelChatMessage[],
    classification: RequestClassification
): RequestTracking {
    const { sessionId, sessionRecoverySource: recoverySource } = resolution;
    const sessionRecoverySource = recoverySource === 'sdk-session' ? undefined : recoverySource;
    let subSessionId =
        classification.agentRole === 'subagent' ?
            resolveSubSessionId(
                messages,
                sessionId,
                classification.requestKind,
                sessionRecoverySource !== 'new-uuid',
                classification.requestOrigin
            )
        :   undefined;
    if (classification.agentRole === 'undetermined' && sessionRecoverySource === 'stateful-marker') {
        for (const { statefulMarker } of getAllStatefulMarkersAndIndicies(messages)) {
            const marker = statefulMarker.marker;
            if (marker.sessionId !== sessionId) {
                continue;
            }
            if (
                marker.continuity?.scope === 'subagent' &&
                marker.subSessionId &&
                /^sub_[0-9a-f]{32}$/.test(marker.subSessionId)
            ) {
                subSessionId = marker.subSessionId;
            }
            break;
        }
    }
    return {
        sessionId,
        subSessionId,
        sessionRecoverySource,
        requestContinuity: getRequestContinuity(recoverySource, subSessionId)
    };
}

export function getRequestBalanceKey(
    tracking: RequestTracking,
    messages: readonly LanguageModelChatMessage[],
    behavior: RequestBehavior,
    telemetryTurn?: number
): string {
    const { sessionId, subSessionId } = tracking;
    if (subSessionId) {
        return `a:${subSessionId}`;
    }
    if (!behavior.legacyTurnAffinity) {
        return `s:${sessionId}`;
    }
    const turnKey = getBalanceTurnKey(sessionId, telemetryTurn);
    if (turnKey) {
        return turnKey;
    }
    const userText = SessionTitleService.extractLatestUserRequestText(messages);
    if (!userText) {
        return `s:${sessionId}`;
    }
    const digest = crypto.createHash('sha256').update(userText.replace(/\s+/g, ' ').trim()).digest('hex');
    return `m:${sessionId}:${digest}`;
}

interface RequestSessionContext {
    messages: readonly LanguageModelChatMessage[];
    options?: ProvideLanguageModelChatResponseOptions;
    providerKey: string;
    classification: RequestClassification;
    behavior: RequestBehavior;
    readMetadata: () => Pick<SessionRecoveryMetadata, 'telemetryTurn' | 'traceId'>;
}

function isSubagentRequestKind(requestKind: string): boolean {
    return requestKind === 'search-subagent' || requestKind === 'execution-subagent' || requestKind === 'subagent';
}

function resolveCopilotSession(
    context: RequestSessionContext,
    metadata: SessionRecoveryMetadata
): SessionIdResolution | undefined {
    const requestKind = context.classification.requestKind;
    if (requestKind === 'main-agent' && context.options) {
        const recovered = SessionRecoveryService.instance.resolveSessionId(context.messages, metadata);
        if (recovered) {
            Logger.info(`Recovered sessionId via summary bridge (${recovered.matchType}): ${recovered.sessionId}`);
            return { sessionId: recovered.sessionId, sessionRecoverySource: `summary-bridge-${recovered.matchType}` };
        }
        const turnSessionId = SessionRecoveryService.instance.resolveSessionIdFromTurn(metadata);
        if (turnSessionId) {
            Logger.info(`Recovered sessionId via turn bridge: ${turnSessionId}`);
            return { sessionId: turnSessionId, sessionRecoverySource: 'turn-bridge' };
        }
        if (metadata.traceId) {
            const sessionId = SessionRecoveryService.instance.resolveSessionIdFromTraceAcrossProviders(metadata);
            if (sessionId) {
                Logger.info(`Recovered sessionId via cross-provider trace bridge: ${sessionId}`);
                return { sessionId, sessionRecoverySource: 'trace-bridge' };
            }
        }
    }
    if (requestKind === 'summarization' && metadata.traceId) {
        const sessionId =
            SessionRecoveryService.instance.resolveSessionIdFromTrace(metadata) ??
            SessionRecoveryService.instance.resolveSessionIdFromTraceAcrossProviders(metadata);
        if (sessionId) {
            Logger.info(`Recovered sessionId via trace bridge: ${sessionId}`);
            return { sessionId, sessionRecoverySource: 'trace-bridge' };
        }
    }
    if (isSubagentRequestKind(requestKind) && metadata.traceId) {
        const sessionId = SessionRecoveryService.instance.resolveSessionIdFromTraceAcrossProviders(metadata);
        if (sessionId) {
            Logger.info(`Recovered sessionId via subagent trace bridge: ${sessionId}`);
            return { sessionId, sessionRecoverySource: 'trace-bridge' };
        }
    }
    return undefined;
}

export function resolveRequestSession(context: RequestSessionContext): SessionIdResolution {
    const { messages, options, providerKey, classification, behavior } = context;
    const requestKind = classification.requestKind;
    const conversationId = options?.modelOptions?._conversationId;
    if (behavior.kind === 'sdk' && typeof conversationId === 'string' && conversationId.trim().length > 0) {
        return { sessionId: conversationId, sessionRecoverySource: 'sdk-session' };
    }
    const metadata = context.readMetadata();
    const recoveryMetadata = {
        requestClassification: getRequestClassificationMetadata(classification),
        providerKey,
        telemetryTurn: metadata.telemetryTurn,
        traceId: metadata.traceId
    };
    const sdkSessionKey = getSdkSessionContextKey(messages, classification, options?.requestInitiator);
    const rememberResolved = (resolution: SessionIdResolution): SessionIdResolution => {
        SessionRecoveryService.instance.rememberSessionHint(resolution.sessionId, recoveryMetadata, undefined, {
            publishProviderAgnosticTraceHint:
                requestKind === 'main-agent' || requestKind === 'summarization' || isSubagentRequestKind(requestKind)
        });
        return resolution;
    };

    for (const result of getAllStatefulMarkersAndIndicies(messages)) {
        const marker = result.statefulMarker.marker;
        if (!canRestoreMarkerSession(marker, classification)) {
            if (
                classification.agentRole === 'subagent' &&
                classification.requestOrigin !== 'copilot-chat' &&
                marker.sessionId &&
                !marker.subSessionId
            ) {
                break;
            }
            continue;
        }
        let sessionId = marker.sessionId;
        if (sessionId) {
            const sessionIndex = sessionId.lastIndexOf('_session_');
            if (sessionIndex !== -1) {
                sessionId = sessionId.slice(sessionIndex + '_session_'.length);
                Logger.debug(`Backward compat: extracted UUID from old sessionId format: ${sessionId}`);
            }
            if (sdkSessionKey && !marker.subSessionId && marker.continuity?.scope !== 'subagent') {
                SessionRecoveryService.instance.rememberSdkSession(sdkSessionKey, sessionId);
            }
            return rememberResolved({ sessionId, sessionRecoverySource: 'stateful-marker' });
        }
    }

    if (sdkSessionKey) {
        const sessionId = SessionRecoveryService.instance.resolveSdkSession(sdkSessionKey);
        if (sessionId) {
            return { sessionId, sessionRecoverySource: 'sdk-session' };
        }
    }
    if (behavior.kind === 'copilot-chat') {
        const recovered = resolveCopilotSession(context, recoveryMetadata);
        if (recovered) {
            return rememberResolved(recovered);
        }
    }

    const sessionId = crypto.randomUUID();
    if (sdkSessionKey) {
        SessionRecoveryService.instance.rememberSdkSession(sdkSessionKey, sessionId);
    }
    const publishTraceHint = requestKind === 'main-agent' || requestKind === 'summarization';
    SessionRecoveryService.instance.rememberSessionHint(
        sessionId,
        recoveryMetadata,
        undefined,
        publishTraceHint ?
            { publishProviderAgnosticTraceHint: true }
        :   { publishProviderTraceHint: false, publishProviderAgnosticTraceHint: false }
    );
    return { sessionId, sessionRecoverySource: 'new-uuid' };
}
