import type { RequestKind } from './requestClassifier';

export type RequestOrigin = 'copilot-chat' | 'copilot-sdk' | 'gcmp' | 'other-extension' | 'core' | 'unknown';
export type AgentRole = 'main' | 'subagent' | 'undetermined' | 'not-applicable';
export type EvidenceLevel = 'contract' | 'signature' | 'heuristic' | 'unknown';

export interface DimensionEvidence {
    level: EvidenceLevel;
    conflictLevel?: EvidenceLevel;
    ruleId?: string;
    reasonCode?: string;
}

export interface RequestClassificationMetadata {
    version: 1;
    requestOrigin: RequestOrigin;
    agentRole: AgentRole;
    evidence: {
        origin: DimensionEvidence;
        purpose: DimensionEvidence;
        role: DimensionEvidence;
    };
}

export interface RequestClassification extends RequestClassificationMetadata {
    requestKind: RequestKind;
}

export interface RequestContinuity {
    version: 1;
    scope: 'chain' | 'subagent';
    source: 'marker' | 'legacy' | 'new' | 'sdk-session';
}

const ORIGINS: readonly RequestOrigin[] = ['copilot-chat', 'copilot-sdk', 'gcmp', 'other-extension', 'core', 'unknown'];
const ROLES: readonly AgentRole[] = ['main', 'subagent', 'undetermined', 'not-applicable'];
const LEVELS: readonly EvidenceLevel[] = ['unknown', 'heuristic', 'signature', 'contract'];
const EVIDENCE_CODE_PATTERN = /^[a-z0-9][a-z0-9._-]{0,63}$/;
const scopedRequestClassifications = new WeakMap<object, RequestClassification>();

export function setScopedRequestClassification(options: object, classification: RequestClassification): void {
    scopedRequestClassifications.set(options, classification);
}

export function getScopedRequestClassification(options: object): RequestClassification | undefined {
    return scopedRequestClassifications.get(options);
}

export function isVerifiedAgentConversation(classification?: RequestClassification): boolean {
    const verified = (level: EvidenceLevel) => level === 'signature' || level === 'contract';
    return (
        classification !== undefined &&
        verified(classification.evidence.purpose.level) &&
        verified(classification.evidence.role.level) &&
        ((classification.requestKind === 'main-agent' &&
            (classification.agentRole === 'main' || classification.agentRole === 'subagent')) ||
            (classification.agentRole === 'subagent' &&
                ['subagent', 'search-subagent', 'execution-subagent'].includes(classification.requestKind)))
    );
}

export function isVerifiedCopilotChat(metadata?: RequestClassificationMetadata): boolean {
    return (
        metadata === undefined ||
        (metadata.requestOrigin === 'copilot-chat' &&
            (metadata.evidence.purpose.level === 'signature' || metadata.evidence.purpose.level === 'contract'))
    );
}

export function usesLegacyTurnAffinity(classification: RequestClassification): boolean {
    return (
        isVerifiedCopilotChat(classification) &&
        classification.agentRole === 'main' &&
        classification.requestKind === 'main-agent'
    );
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function normalizeEvidence(value: unknown): DimensionEvidence | undefined {
    if (!isRecord(value) || !LEVELS.includes(value.level as EvidenceLevel)) {
        return undefined;
    }
    const result: DimensionEvidence = { level: value.level as EvidenceLevel };
    for (const key of ['ruleId', 'reasonCode'] as const) {
        const code = value[key];
        if (code !== undefined) {
            if (typeof code !== 'string' || !EVIDENCE_CODE_PATTERN.test(code)) {
                return undefined;
            }
            result[key] = code;
        }
    }
    if (value.conflictLevel !== undefined) {
        if (
            result.level !== 'unknown' ||
            result.reasonCode !== 'classification-conflict' ||
            !LEVELS.includes(value.conflictLevel as EvidenceLevel)
        ) {
            return undefined;
        }
        result.conflictLevel = value.conflictLevel as EvidenceLevel;
    }
    return result;
}

export function getRequestClassificationMetadata(classification: RequestClassification): RequestClassificationMetadata {
    return {
        version: classification.version,
        requestOrigin: classification.requestOrigin,
        agentRole: classification.agentRole,
        evidence: {
            origin: { ...classification.evidence.origin },
            purpose: { ...classification.evidence.purpose },
            role: { ...classification.evidence.role }
        }
    };
}

export function normalizeRequestClassification(value: unknown): RequestClassificationMetadata | undefined {
    try {
        if (
            !isRecord(value) ||
            value.version !== 1 ||
            !ORIGINS.includes(value.requestOrigin as RequestOrigin) ||
            !ROLES.includes(value.agentRole as AgentRole) ||
            !isRecord(value.evidence)
        ) {
            return undefined;
        }
        const origin = normalizeEvidence(value.evidence.origin);
        const purpose = normalizeEvidence(value.evidence.purpose);
        const role = normalizeEvidence(value.evidence.role);
        if (!origin || !purpose || !role) {
            return undefined;
        }
        return {
            version: 1,
            requestOrigin: value.requestOrigin as RequestOrigin,
            agentRole: value.agentRole as AgentRole,
            evidence: { origin, purpose, role }
        };
    } catch {
        return undefined;
    }
}

function mergeClassificationDimension<T extends string | undefined>(
    previousValue: T,
    previousEvidence: DimensionEvidence,
    nextValue: T,
    nextEvidence: DimensionEvidence,
    conflictValue: T
): { value: T; evidence: DimensionEvidence } {
    const previousRank = LEVELS.indexOf(previousEvidence.conflictLevel ?? previousEvidence.level);
    const nextRank = LEVELS.indexOf(nextEvidence.conflictLevel ?? nextEvidence.level);
    if (previousRank !== nextRank) {
        return nextRank > previousRank ?
                { value: nextValue, evidence: { ...nextEvidence } }
            :   { value: previousValue, evidence: { ...previousEvidence } };
    }
    if (
        previousEvidence.reasonCode === 'classification-conflict' ||
        nextEvidence.reasonCode === 'classification-conflict' ||
        previousValue !== nextValue
    ) {
        return {
            value: conflictValue,
            evidence: { level: 'unknown', conflictLevel: LEVELS[previousRank], reasonCode: 'classification-conflict' }
        };
    }
    const previousRule = previousEvidence.ruleId ?? '';
    const nextRule = nextEvidence.ruleId ?? '';
    const preferNext =
        nextRule < previousRule ||
        (nextRule === previousRule && (nextEvidence.reasonCode ?? '') < (previousEvidence.reasonCode ?? ''));
    return preferNext ?
            { value: nextValue, evidence: { ...nextEvidence } }
        :   { value: previousValue, evidence: { ...previousEvidence } };
}

export function mergeRequestClassificationFields(
    existing: { requestKind?: string; requestClassification?: unknown },
    incoming: { requestKind?: string; requestClassification?: unknown }
): { requestKind?: string; requestClassification?: RequestClassificationMetadata } {
    const previous = normalizeRequestClassification(existing.requestClassification);
    const next = normalizeRequestClassification(incoming.requestClassification);
    let requestClassification = previous ?? next;
    if (previous && next) {
        const origin = mergeClassificationDimension(
            previous.requestOrigin,
            previous.evidence.origin,
            next.requestOrigin,
            next.evidence.origin,
            'unknown'
        );
        const role = mergeClassificationDimension(
            previous.agentRole,
            previous.evidence.role,
            next.agentRole,
            next.evidence.role,
            'undetermined'
        );
        const purpose = mergeClassificationDimension(
            undefined,
            previous.evidence.purpose,
            undefined,
            next.evidence.purpose,
            undefined
        );
        requestClassification = {
            version: 1,
            requestOrigin: origin.value,
            agentRole: role.value,
            evidence: { origin: origin.evidence, purpose: purpose.evidence, role: role.evidence }
        };
    }

    let purpose: { value: string | undefined; evidence: DimensionEvidence } = {
        value: undefined,
        evidence: requestClassification?.evidence.purpose ?? { level: 'unknown' }
    };
    if (existing.requestKind !== undefined && incoming.requestKind !== undefined) {
        purpose = mergeClassificationDimension(
            existing.requestKind,
            previous?.evidence.purpose ?? { level: 'unknown' },
            incoming.requestKind,
            next?.evidence.purpose ?? { level: 'unknown' },
            'unclassified'
        );
    } else if (existing.requestKind !== undefined) {
        purpose = { value: existing.requestKind, evidence: previous?.evidence.purpose ?? { level: 'unknown' } };
    } else if (incoming.requestKind !== undefined) {
        purpose = { value: incoming.requestKind, evidence: next?.evidence.purpose ?? { level: 'unknown' } };
    }

    if (requestClassification) {
        requestClassification.evidence.purpose = { ...purpose.evidence };
    } else if (purpose.evidence.reasonCode === 'classification-conflict') {
        requestClassification = {
            version: 1,
            requestOrigin: 'unknown',
            agentRole: 'undetermined',
            evidence: { origin: { level: 'unknown' }, purpose: purpose.evidence, role: { level: 'unknown' } }
        };
    }
    return { requestKind: purpose.value, requestClassification };
}

export function mergeRequestClassification(
    existing: unknown,
    incoming: unknown
): RequestClassificationMetadata | undefined {
    return mergeRequestClassificationFields({ requestClassification: existing }, { requestClassification: incoming })
        .requestClassification;
}

export function getRequestContinuity(recoverySource: string, subSessionId?: string): RequestContinuity {
    return {
        version: 1,
        scope: subSessionId ? 'subagent' : 'chain',
        source:
            recoverySource === 'stateful-marker' ? 'marker'
            : recoverySource === 'new-uuid' ? 'new'
            : recoverySource === 'sdk-session' ? 'sdk-session'
            : 'legacy'
    };
}

export function normalizeRequestContinuity(value: unknown): RequestContinuity | undefined {
    try {
        if (
            !isRecord(value) ||
            value.version !== 1 ||
            (value.scope !== 'chain' && value.scope !== 'subagent') ||
            (value.source !== 'marker' &&
                value.source !== 'legacy' &&
                value.source !== 'new' &&
                value.source !== 'sdk-session')
        ) {
            return undefined;
        }
        return { version: 1, scope: value.scope, source: value.source };
    } catch {
        return undefined;
    }
}
