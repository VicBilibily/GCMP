import { isVerifiedCopilotChat, usesLegacyTurnAffinity, type RequestClassification } from './requestClassification';

export interface RequestBehavior {
    readonly kind: 'sdk' | 'copilot-chat' | 'fallback';
    readonly cacheUsage: boolean;
    readonly legacyTurnAffinity: boolean;
    readonly auxiliaryResponse: 'title' | 'summary' | undefined;
}

export function resolveRequestBehavior(classification: RequestClassification): RequestBehavior {
    const kind =
        classification.requestOrigin === 'copilot-sdk' ? 'sdk'
        : isVerifiedCopilotChat(classification) ? 'copilot-chat'
        : 'fallback';
    return {
        kind,
        cacheUsage:
            kind === 'sdk' && classification.agentRole === 'main' && classification.requestKind === 'main-agent',
        legacyTurnAffinity: usesLegacyTurnAffinity(classification),
        auxiliaryResponse:
            kind !== 'copilot-chat' ? undefined
            : classification.requestKind === 'chat-title' ? 'title'
            : classification.requestKind === 'summarization' ? 'summary'
            : undefined
    };
}
