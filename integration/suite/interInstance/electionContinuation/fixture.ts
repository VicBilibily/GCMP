import assert from 'node:assert/strict';
import * as vscode from 'vscode';
import { InterInstanceBus } from '../../../../src/interInstance';
import { LeaderElectionService } from '../../../../src/status/leaderElectionService';
import { UserActivityService } from '../../../../src/status/userActivityService';
import { createContext } from '../../balance/retryFixture';

export interface LeaderRecord {
    instanceId: string;
    electedAt: number;
    lastHeartbeat: number;
}

interface ElectionState {
    context: vscode.ExtensionContext | undefined;
    instanceId: string;
    initialized: boolean;
    agentsWindow: boolean;
    _isLeader: boolean;
    ownElectedAt: number;
    lastCandidateElectedAt: number;
    stopping: boolean;
    lifecycleGeneration: number;
    decisionGeneration: number;
    candidateAuthority: unknown;
    ownedCandidateAuthority: unknown;
    electionPausedUntil: number;
    lastLeaderIdentityKey: string | undefined;
    periodicTasks: Array<() => Promise<void>>;
    startTimer: NodeJS.Timeout | undefined;
    heartbeatTimer: NodeJS.Timeout | undefined;
    taskTimer: NodeJS.Timeout | undefined;
    resignationPromise: unknown;
    rateLimitSnapshotProvider: Parameters<typeof LeaderElectionService.setRateLimitSnapshotProvider>[0];
    rateLimitSnapshotValidator: unknown;
    balanceLeaseSnapshotProvider: Parameters<typeof LeaderElectionService.setBalanceLeaseSnapshotProvider>[0];
    balanceLeaseSnapshotValidator: unknown;
}

interface ElectionInternals extends ElectionState {
    checkLeader(): Promise<void>;
    becomeLeader(force?: boolean): Promise<void>;
    setLeaderState(value: boolean): void;
}

export function deferred() {
    let resolve!: () => void;
    const promise = new Promise<void>(done => {
        resolve = done;
    });
    return { promise, resolve };
}

export function createElectionFixture() {
    const election = LeaderElectionService as unknown as ElectionInternals;
    const fields: Array<keyof ElectionState> = [
        'context',
        'instanceId',
        'initialized',
        'agentsWindow',
        '_isLeader',
        'ownElectedAt',
        'lastCandidateElectedAt',
        'stopping',
        'lifecycleGeneration',
        'decisionGeneration',
        'candidateAuthority',
        'ownedCandidateAuthority',
        'electionPausedUntil',
        'lastLeaderIdentityKey',
        'periodicTasks',
        'startTimer',
        'heartbeatTimer',
        'taskTimer',
        'resignationPromise',
        'rateLimitSnapshotProvider',
        'rateLimitSnapshotValidator',
        'balanceLeaseSnapshotProvider',
        'balanceLeaseSnapshotValidator'
    ];
    const previous = Object.fromEntries(fields.map(field => [field, election[field]]));
    const originalNow = Date.now;
    const originalTimeout = globalThis.setTimeout;
    const originalActivity = { initialize: UserActivityService.initialize, stop: UserActivityService.stop };
    const originalBus = {
        getEligibleFollowerIds: InterInstanceBus.getEligibleFollowerIds,
        publishIpcOnly: InterInstanceBus.publishIpcOnly
    };
    const context = createContext();
    const key = 'gcmp.leader.info.v2';
    const write = context.globalState.update.bind(context.globalState);
    const gates: Array<ReturnType<typeof deferred>> = [];
    const confirmations: Array<{ timer: NodeJS.Timeout; finish: () => void }> = [];
    const confirmationEntered = deferred();
    const roles: Array<{ leader: boolean; term: string | undefined }> = [];
    const identities: Array<{ term: string | undefined; ownedTerm: string | undefined; leader: boolean }> = [];
    const updates: unknown[] = [];
    let held: { entered: ReturnType<typeof deferred>; gate: ReturnType<typeof deferred> } | undefined;
    let now = 100_000;
    Date.now = () => now;
    globalThis.setTimeout = ((...args: Parameters<typeof setTimeout>) => {
        if (args[1] !== 100) {
            return originalTimeout(...args);
        }
        const timer = originalTimeout(() => {}, 60_000);
        confirmations.push({ timer, finish: () => args[0](undefined) });
        confirmationEntered.resolve();
        return timer;
    }) as typeof setTimeout;
    UserActivityService.initialize = () => {};
    UserActivityService.stop = () => {};
    InterInstanceBus.getEligibleFollowerIds = () => ['successor'];
    InterInstanceBus.publishIpcOnly = () => true;
    Object.assign(election, {
        context,
        instanceId: 'continuation-local',
        initialized: true,
        agentsWindow: false,
        _isLeader: false,
        ownElectedAt: 0,
        lastCandidateElectedAt: 0,
        stopping: false,
        decisionGeneration: 0,
        candidateAuthority: undefined,
        ownedCandidateAuthority: undefined,
        electionPausedUntil: 0,
        lastLeaderIdentityKey: undefined,
        periodicTasks: [],
        startTimer: undefined,
        heartbeatTimer: undefined,
        taskTimer: undefined,
        resignationPromise: undefined,
        rateLimitSnapshotProvider: undefined,
        rateLimitSnapshotValidator: undefined,
        balanceLeaseSnapshotProvider: undefined,
        balanceLeaseSnapshotValidator: undefined
    });
    context.globalState.update = async (entry: string, value: unknown) => {
        const waiting = held;
        held = undefined;
        updates.push(value);
        await write(entry, value);
        if (waiting) {
            waiting.entered.resolve();
            await waiting.gate.promise;
        }
    };
    context.subscriptions.push(
        LeaderElectionService.onLeaderChanged(leader => {
            roles.push({ leader, term: LeaderElectionService.getOwnedAuthorityTerm() });
        }),
        LeaderElectionService.onLeaderIdentityChanged(identity => {
            identities.push({
                term: identity?.authorityTerm,
                ownedTerm: LeaderElectionService.getOwnedAuthorityTerm(),
                leader: LeaderElectionService.isLeader()
            });
        })
    );

    function self(electedAt = 100_000): LeaderRecord {
        return { instanceId: election.instanceId, electedAt, lastHeartbeat: now };
    }

    async function seed(branch: 'self' | 'reclaim' = 'self'): Promise<void> {
        election._isLeader = true;
        election.ownElectedAt = 100_000;
        await write(key, branch === 'self' ? self() : { instanceId: 'older', electedAt: 99_000, lastHeartbeat: now });
    }

    function holdNextWrite() {
        assert.equal(held, undefined);
        const waiting = { entered: deferred(), gate: deferred() };
        held = waiting;
        gates.push(waiting.gate);
        return waiting;
    }

    async function completeCandidate(pending: Promise<void>): Promise<void> {
        await new Promise<void>(resolve => setImmediate(resolve));
        for (const waiting of confirmations.splice(0)) {
            clearTimeout(waiting.timer);
            waiting.finish();
        }
        await pending;
    }

    async function dispose(): Promise<void> {
        for (const gate of gates) {
            gate.resolve();
        }
        for (const waiting of confirmations.splice(0)) {
            clearTimeout(waiting.timer);
            waiting.finish();
        }
        for (const timer of [election.startTimer, election.heartbeatTimer, election.taskTimer]) {
            clearTimeout(timer);
        }
        for (const subscription of context.subscriptions) {
            subscription.dispose();
        }
        Object.assign(election, previous);
        Object.assign(UserActivityService, originalActivity);
        Object.assign(InterInstanceBus, originalBus);
        Date.now = originalNow;
        globalThis.setTimeout = originalTimeout;
    }

    return {
        election,
        context,
        roles,
        identities,
        updates,
        self,
        seed,
        holdNextWrite,
        completeCandidate,
        confirmationEntered,
        dispose,
        write: (record: LeaderRecord | undefined) => write(key, record),
        read: () => context.globalState.get<LeaderRecord>(key),
        advance: (milliseconds: number) => {
            now += milliseconds;
        },
        assertFollower: () => {
            assert.equal(LeaderElectionService.isLeader(), false);
            assert.equal(LeaderElectionService.getOwnedAuthorityTerm(), undefined);
            assert.ok(
                roles.every(role => !role.leader || role.term !== undefined),
                'published a leader without authority'
            );
        }
    };
}
