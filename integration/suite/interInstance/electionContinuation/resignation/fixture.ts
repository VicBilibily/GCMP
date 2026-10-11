import assert from 'node:assert/strict';
import { InterInstanceBus } from '../../../../../src/interInstance';
import {
    USAGES_QUERY_PROTOCOL_VERSION,
    type InterInstanceEvent,
    type LeaderResigningEvent
} from '../../../../../src/interInstance/eventProtocol';
import { LEADER_LIVENESS_PROTOCOL_VERSION } from '../../../../../src/interInstance/liveness/protocol';
import { LeaderElectionService } from '../../../../../src/status/leaderElectionService';
import { createElectionFixture } from '../fixture';

export interface ResignationAuthority {
    authorityTerm: string | undefined;
    storageTerm: string | undefined;
    ipcAuthority: { authorityTerm: string | undefined; generation: number };
}
export type Election = ReturnType<typeof createElectionFixture>['election'] & {
    takeoverAsNominated(authority?: ResignationAuthority): Promise<void>;
    waitForNominatedTakeover(next: string, source: string, authority?: ResignationAuthority): Promise<void>;
    recoverAfterLeaderResigning(source: string, authority?: ResignationAuthority): Promise<void>;
};
interface Bus {
    instanceId: string | undefined;
    authorityTerm: string | undefined;
    confirmedLeaderAuthorityTerm: string | undefined;
    extensionVersion: string;
    clientTarget: { instanceId: string; authorityTerm?: string; ipcPath: string } | undefined;
    remoteUsagesQueryCompatible: boolean;
    remoteLeaderLivenessCompatible: boolean;
    leaderLivenessGeneration: number;
    setAuthorityTerm(term: string | undefined): void;
    dispatchEvent(event: InterInstanceEvent, source?: 'ipc'): void;
}

export function createResignationFixture() {
    const f = createElectionFixture();
    const election = f.election as Election;
    const bus = InterInstanceBus as unknown as Bus;
    const previous = {
        instanceId: bus.instanceId,
        authorityTerm: bus.authorityTerm,
        confirmedLeaderAuthorityTerm: bus.confirmedLeaderAuthorityTerm,
        extensionVersion: bus.extensionVersion,
        clientTarget: bus.clientTarget,
        remoteUsagesQueryCompatible: bus.remoteUsagesQueryCompatible,
        remoteLeaderLivenessCompatible: bus.remoteLeaderLivenessCompatible,
        leaderLivenessGeneration: bus.leaderLivenessGeneration
    };
    const original = {
        takeoverAsNominated: election.takeoverAsNominated,
        waitForNominatedTakeover: election.waitForNominatedTakeover,
        recoverAfterLeaderResigning: election.recoverAfterLeaderResigning,
        checkLeader: election.checkLeader
    };
    const source = { instanceId: 'confirmed-source', electedAt: 99_500, lastHeartbeat: 100_000 };
    const confirmedTerm = `${source.instanceId}:99501`;
    const pending: Promise<void>[] = [];
    const calls: string[] = [];
    let fallbackChecks = 0;
    Object.assign(bus, {
        instanceId: election.instanceId,
        authorityTerm: `${source.instanceId}:${source.electedAt}`,
        confirmedLeaderAuthorityTerm: undefined,
        extensionVersion: '1.0.0',
        clientTarget: {
            instanceId: source.instanceId,
            authorityTerm: `${source.instanceId}:${source.electedAt}`,
            ipcPath: 'unused-regression-pipe'
        },
        remoteUsagesQueryCompatible: false,
        remoteLeaderLivenessCompatible: false
    });
    const track = (branch: string, operation: Promise<void>) => {
        calls.push(branch);
        pending.push(operation);
        return operation;
    };
    election.takeoverAsNominated = (...args) => track('self', original.takeoverAsNominated.call(election, ...args));
    election.waitForNominatedTakeover = (...args) =>
        track('other', original.waitForNominatedTakeover.call(election, ...args));
    election.recoverAfterLeaderResigning = (...args) =>
        track('none', original.recoverAfterLeaderResigning.call(election, ...args));
    election.checkLeader = async () => {
        fallbackChecks++;
        await original.checkLeader.call(election);
    };
    LeaderElectionService.subscribeToLeaderResigning();

    function capability(
        term: string | undefined = confirmedTerm,
        sourceChannel: 'ipc' | 'fallback' = 'ipc',
        protocol = true,
        target = election.instanceId
    ) {
        bus.dispatchEvent(
            {
                type: 'remoteInstanceCapabilities',
                timestamp: Date.now(),
                senderInstanceId: source.instanceId,
                payload: {
                    targetInstanceId: target,
                    extensionVersion: '1.0.0',
                    usagesQueryProtocolVersion: USAGES_QUERY_PROTOCOL_VERSION,
                    leaderLivenessProtocolVersion: protocol ? LEADER_LIVENESS_PROTOCOL_VERSION : undefined,
                    authorityTerm: term
                }
            },
            sourceChannel === 'ipc' ? 'ipc' : undefined
        );
    }
    function dispatch(branch: 'self' | 'other' | 'none', term: string | undefined = confirmedTerm) {
        const event: LeaderResigningEvent = {
            type: 'leaderResigning',
            timestamp: Date.now() - 1000,
            senderInstanceId: source.instanceId,
            payload: {
                leaderId: source.instanceId,
                reason: 'manual',
                sourceAuthorityTerm: term,
                nextLeaderId:
                    branch === 'self' ? election.instanceId
                    : branch === 'other' ? 'nominated-other'
                    : undefined
            }
        };
        bus.dispatchEvent(event, 'ipc');
    }
    async function dispose() {
        election.stopping = true;
        election.lifecycleGeneration++;
        try {
            await f.completeCandidate(Promise.all(pending).then(() => {}));
        } finally {
            Object.assign(election, original);
            Object.assign(bus, previous);
            await f.dispose();
        }
    }
    return {
        ...f,
        election,
        bus,
        source,
        confirmedTerm,
        pending,
        calls,
        capability,
        dispatch,
        dispose,
        fallbackChecks: () => fallbackChecks,
        checkLeader: () => original.checkLeader.call(election),
        assertPromoted: (electedAt = Date.now()) => {
            assert.equal(LeaderElectionService.getOwnedAuthorityTerm(), `continuation-local:${electedAt}`);
            assert.deepEqual(
                f.roles.map(role => role.leader),
                [true]
            );
        }
    };
}
