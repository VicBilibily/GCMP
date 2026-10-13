import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import * as vscode from 'vscode';
import { InterInstanceBus } from '../../../../src/interInstance/interInstanceBus';
import type { InterInstanceEvent } from '../../../../src/interInstance/eventProtocol';
import { IpcServer } from '../../../../src/interInstance/ipcServer';
import { LeaderFilePublisher } from '../../../../src/interInstance/leaderFile';
import { resolveIpcPath } from '../../../../src/interInstance/pathResolver';
import { LeaderElectionService, type LeaderIdentity } from '../../../../src/status/leaderElectionService';
import { UserActivityService } from '../../../../src/status/userActivityService';
import { createContext } from '../../balance/retryFixture';

interface LeaderRecord {
    instanceId: string;
    electedAt: number;
    lastHeartbeat: number;
}
interface ElectionInternals {
    context: vscode.ExtensionContext | undefined;
    instanceId: string;
    _isLeader: boolean;
    ownElectedAt: number;
    lastCandidateElectedAt: number;
    ownedCandidateAuthority: unknown;
    initialized: boolean;
    lifecycleGeneration: number;
    decisionGeneration: number;
    checkLeader(): Promise<void>;
    becomeLeader(force?: boolean): Promise<void>;
}
export interface BusInternals {
    initialized: boolean;
    instanceId: string | undefined;
    server: IpcServer | undefined;
    roleSwitchChain: Promise<void>;
    clientTarget: { instanceId: string; authorityTerm?: string; ipcPath: string } | undefined;
    client: { isConnected(): boolean; send(event: InterInstanceEvent): void; disconnect(): Promise<void> } | undefined;
    remoteLeaderLivenessCompatible: boolean;
    startFallbackTransport(): void;
    dispatchEvent(event: InterInstanceEvent, source?: 'ipc'): void;
    connectToLeader(): Promise<void>;
    setAuthorityTerm(term: string | undefined): void;
}

export async function waitFor(condition: () => boolean): Promise<void> {
    const deadline = performance.now() + 5000;
    while (!condition()) {
        assert.ok(performance.now() < deadline, 'IPC fixture did not settle');
        await new Promise<void>(resolve => setTimeout(resolve, 5));
    }
}

export async function createLivenessFixture(age = 20_000) {
    const election = LeaderElectionService as unknown as ElectionInternals;
    const bus = InterInstanceBus as unknown as BusInternals;
    assert.equal(bus.initialized, false);
    const fields = [
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
    const state = election as unknown as Record<string, unknown>;
    const previous = Object.fromEntries(fields.map(field => [field, state[field]]));
    const context = createContext();
    const leaderContext = createContext();
    const key = 'gcmp.leader.info.v2';
    const leaderId = randomUUID();
    const followerId = randomUUID();
    const electedAt = Date.now() - 60_000;
    const record: LeaderRecord = { instanceId: leaderId, electedAt, lastHeartbeat: Date.now() - age };
    const identity: LeaderIdentity = { instanceId: leaderId, electedAt, authorityTerm: `${leaderId}:${electedAt}` };
    const original = {
        fallback: bus.startFallbackTransport,
        publisherStart: LeaderFilePublisher.prototype.start,
        publisherStop: LeaderFilePublisher.prototype.stop,
        initializeActivity: UserActivityService.initialize,
        stopActivity: UserActivityService.stop
    };
    const events: InterInstanceEvent[] = [];
    const updates: unknown[] = [];
    const roles: boolean[] = [];
    const write = context.globalState.update.bind(context.globalState);
    await write(key, record);
    await leaderContext.globalState.update(key, { ...record, lastHeartbeat: Date.now() });
    context.globalState.update = async (entry: string, value: unknown) => {
        if (entry === key) {
            updates.push(value);
        }
        await write(entry, value);
    };
    Object.assign(election, {
        context,
        instanceId: followerId,
        initialized: true,
        agentsWindow: false,
        _isLeader: false,
        ownElectedAt: 0,
        lastCandidateElectedAt: 0,
        stopping: false,
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
    bus.startFallbackTransport = () => {};
    LeaderFilePublisher.prototype.start = async () => {};
    LeaderFilePublisher.prototype.stop = async () => {};
    UserActivityService.initialize = () => {};
    UserActivityService.stop = () => {};
    let respond: ((event: InterInstanceEvent) => void) | undefined;
    let leaderOwns = true;
    const server = new IpcServer({
        onMessage: event => {
            events.push(event);
            if (event.type === 'usagesQueryRequested') {
                server.sendToInstance(event.senderInstanceId, {
                    type: 'usagesQueryCompleted',
                    payload: {
                        requestId: event.payload.requestId,
                        targetInstanceId: event.senderInstanceId,
                        authorityTerm: identity.authorityTerm,
                        result: { kind: 'sessionTitle', value: 'Responsive leader' }
                    },
                    timestamp: Date.now(),
                    senderInstanceId: leaderId
                });
                return;
            }
            if (respond && event.type !== 'remoteInstanceHello') {
                respond(event);
                return;
            }
            withLeader(() => bus.dispatchEvent(event, 'ipc'));
        }
    });
    function withLeader(action: () => void): void {
        const saved = {
            context: election.context,
            instanceId: election.instanceId,
            _isLeader: election._isLeader,
            ownElectedAt: election.ownElectedAt,
            ownedCandidateAuthority: election.ownedCandidateAuthority,
            busId: bus.instanceId,
            server: bus.server
        };
        Object.assign(election, {
            context: leaderContext,
            instanceId: leaderId,
            _isLeader: leaderOwns,
            ownElectedAt: electedAt,
            ownedCandidateAuthority: undefined
        });
        bus.instanceId = leaderId;
        bus.server = server;
        try {
            action();
        } finally {
            Object.assign(election, {
                context: saved.context,
                instanceId: saved.instanceId,
                _isLeader: saved._isLeader,
                ownElectedAt: saved.ownElectedAt,
                ownedCandidateAuthority: saved.ownedCandidateAuthority
            });
            bus.instanceId = saved.busId;
            bus.server = saved.server;
        }
    }
    context.subscriptions.push(
        LeaderElectionService.onLeaderChanged(value => {
            roles.push(value);
        })
    );
    const dispose = async () => {
        await InterInstanceBus.dispose();
        await server.stop();
        for (const timer of ['startTimer', 'heartbeatTimer', 'taskTimer']) {
            clearTimeout(state[timer] as NodeJS.Timeout | undefined);
        }
        for (const subscription of context.subscriptions) {
            subscription.dispose();
        }
        Object.assign(election, previous);
        bus.startFallbackTransport = original.fallback;
        LeaderFilePublisher.prototype.start = original.publisherStart;
        LeaderFilePublisher.prototype.stop = original.publisherStop;
        UserActivityService.initialize = original.initializeActivity;
        UserActivityService.stop = original.stopActivity;
    };
    try {
        await server.start(resolveIpcPath(leaderId));
        InterInstanceBus.initialize(context);
        await bus.roleSwitchChain;
        await waitFor(() => events.some(event => event.type === 'remoteInstanceHello'));
        await waitFor(() => InterInstanceBus.getAuthorityTerm() === identity.authorityTerm);
        await waitFor(() => bus.remoteLeaderLivenessCompatible);
    } catch (error) {
        await dispose();
        throw error;
    }

    async function proveResponsive(): Promise<void> {
        const requestId = randomUUID();
        let received = false;
        const subscription = InterInstanceBus.subscribe('usagesQueryCompleted', event => {
            if (
                event.type === 'usagesQueryCompleted' &&
                event.payload.requestId === requestId &&
                event.senderInstanceId === leaderId &&
                event.payload.authorityTerm === identity.authorityTerm &&
                event.payload.targetInstanceId === followerId
            ) {
                received = true;
            }
        });
        try {
            assert.equal(
                InterInstanceBus.publishIpcOnly({
                    type: 'usagesQueryRequested',
                    payload: {
                        requestId,
                        requestedBy: followerId,
                        authorityTerm: identity.authorityTerm,
                        query: { kind: 'sessionTitle', sessionId: followerId }
                    }
                }),
                true
            );
            await waitFor(() => received);
        } finally {
            subscription.dispose();
        }
    }
    return {
        context,
        leaderContext,
        election,
        bus,
        server,
        events,
        updates,
        roles,
        record,
        identity,
        followerId,
        dispose,
        proveResponsive,
        withLeader,
        setResponder: (handler: ((event: InterInstanceEvent) => void) | undefined) => {
            respond = handler;
        },
        setLeaderOwns: (owns: boolean) => {
            leaderOwns = owns;
        },
        write: (value: LeaderRecord | undefined) => write(key, value),
        read: () => context.globalState.get<LeaderRecord>(key),
        assertUnchangedFollower: () => {
            assert.equal(LeaderElectionService.isLeader(), false);
            assert.deepEqual(updates, []);
            assert.deepEqual(context.globalState.get(key), record);
            assert.deepEqual(roles, []);
        }
    };
}
