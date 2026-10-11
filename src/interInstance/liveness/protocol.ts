import type { InterInstanceEventBase } from '../eventProtocol';

export const LEADER_LIVENESS_PROTOCOL_VERSION = 1;

export interface LeaderLivenessPayload {
    requestId: string;
    targetInstanceId: string;
    authorityTerm: string;
}

export interface LeaderLivenessRequestedEvent extends InterInstanceEventBase {
    type: 'leaderLivenessRequested';
    payload: LeaderLivenessPayload;
}

export interface LeaderLivenessConfirmedEvent extends InterInstanceEventBase {
    type: 'leaderLivenessConfirmed';
    payload: LeaderLivenessPayload;
}

export function isLeaderLivenessPayload(value: unknown): value is LeaderLivenessPayload {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
        return false;
    }
    const payload = value as Partial<LeaderLivenessPayload>;
    return (
        typeof payload.requestId === 'string' &&
        payload.requestId.length > 0 &&
        payload.requestId.length <= 128 &&
        typeof payload.targetInstanceId === 'string' &&
        payload.targetInstanceId.length > 0 &&
        payload.targetInstanceId.length <= 128 &&
        typeof payload.authorityTerm === 'string' &&
        payload.authorityTerm.length > 0 &&
        payload.authorityTerm.length <= 160
    );
}
