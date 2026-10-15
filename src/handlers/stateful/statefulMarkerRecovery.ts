import type { RequestClassification } from '../classification/requestClassification';

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function canRestoreMarkerSession(marker: unknown, classification: RequestClassification): boolean {
    try {
        if (
            !isRecord(marker) ||
            marker.extension !== 'vicanent.gcmp' ||
            typeof marker.sessionId !== 'string' ||
            !marker.sessionId ||
            (marker.subSessionId !== undefined && (typeof marker.subSessionId !== 'string' || !marker.subSessionId))
        ) {
            return false;
        }
        if (classification.agentRole === 'subagent' && classification.requestOrigin !== 'copilot-chat') {
            return (
                typeof marker.subSessionId === 'string' &&
                isRecord(marker.continuity) &&
                marker.continuity.version === 1 &&
                marker.continuity.scope === 'subagent' &&
                marker.continuity.agentRole === 'subagent'
            );
        }
        return classification.agentRole !== 'main' || !marker.subSessionId;
    } catch {
        return false;
    }
}

export function getMarkerBalanceCredential(
    marker: unknown,
    expected: {
        sessionId: string;
        subSessionId?: string;
        provider: string;
        modelId: string;
        sdkMode: string;
        balanceKey: string;
    }
): string | undefined {
    try {
        if (
            !isRecord(marker) ||
            !isRecord(expected) ||
            ![expected.sessionId, expected.provider, expected.modelId, expected.sdkMode, expected.balanceKey].every(
                value => typeof value === 'string' && value.length > 0
            ) ||
            (expected.subSessionId !== undefined &&
                (typeof expected.subSessionId !== 'string' || !expected.subSessionId))
        ) {
            return undefined;
        }
        const affinity = marker.balanceAffinity;
        if (
            marker.extension !== 'vicanent.gcmp' ||
            marker.sessionId !== expected.sessionId ||
            marker.subSessionId !== expected.subSessionId ||
            marker.provider !== expected.provider ||
            marker.modelId !== expected.modelId ||
            marker.sdkMode !== expected.sdkMode ||
            !isRecord(affinity) ||
            affinity.slot !== expected.provider ||
            affinity.balanceKey !== expected.balanceKey ||
            typeof affinity.credentialId !== 'string' ||
            !/^[a-f0-9]{64}$/.test(affinity.credentialId)
        ) {
            return undefined;
        }
        return affinity.credentialId;
    } catch {
        return undefined;
    }
}
