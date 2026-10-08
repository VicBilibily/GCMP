import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import type { Socket } from 'node:net';
import * as vscode from 'vscode';
import { InterInstanceBus } from '../../../src/interInstance/interInstanceBus';
import { IpcClient } from '../../../src/interInstance/ipcClient';
import { IpcServer } from '../../../src/interInstance/ipcServer';
import { LeaderFilePublisher } from '../../../src/interInstance/leaderFile';
import type { InterInstanceEvent } from '../../../src/interInstance/eventProtocol';
import { LeaderElectionService } from '../../../src/status/leaderElectionService';
import { createContext } from '../balance/retryFixture';
import { isValidBalanceLeaseHandoff } from '../../../src/utils/config/failover/balanceLeaseHandoffFile';

interface ElectionState {
    context: vscode.ExtensionContext | undefined;
    instanceId: string;
    initialized: boolean;
    _isLeader: boolean;
    ownElectedAt: number;
    agentsWindow: boolean;
    stopping: boolean;
    lifecycleGeneration: number;
    electionPausedUntil: number;
    lastLeaderIdentityKey: string | undefined;
    rateLimitSnapshotProvider: Parameters<typeof LeaderElectionService.setRateLimitSnapshotProvider>[0];
    balanceLeaseSnapshotProvider: Parameters<typeof LeaderElectionService.setBalanceLeaseSnapshotProvider>[0];
    rateLimitSnapshotValidator: unknown;
    balanceLeaseSnapshotValidator: unknown;
}

interface BusState {
    initialized: boolean;
    server: IpcServer | undefined;
    roleSwitchChain: Promise<void>;
    startFallbackTransport(): void;
}

interface ServerState {
    currentPath: string;
    socketInstanceIds: Map<Socket, string>;
    backpressuredSockets: Map<Socket, { queue: string[] }>;
}

async function waitFor(condition: () => boolean): Promise<void> {
    const deadline = Date.now() + 5000;
    while (!condition()) {
        assert.ok(Date.now() < deadline, 'IPC condition did not settle');
        await new Promise<void>(resolve => setTimeout(resolve, 5));
    }
}

suite('Leader handoff backpressure', () => {
    for (const mode of [
        'idle',
        'queued',
        'drained',
        'large-idle',
        'large-drained',
        'write-held',
        'write-error',
        'write-close',
        'write-timeout',
        'new-term',
        'foreign-term',
        'new-lifecycle'
    ] as const) {
        test(`${mode}: manual resignation preserves authority or delivers the handoff`, async () => {
            const election = LeaderElectionService as unknown as ElectionState;
            const bus = InterInstanceBus as unknown as BusState;
            assert.equal(bus.initialized, false);
            const previous: ElectionState = {
                context: election.context,
                instanceId: election.instanceId,
                initialized: election.initialized,
                _isLeader: election._isLeader,
                ownElectedAt: election.ownElectedAt,
                agentsWindow: election.agentsWindow,
                stopping: election.stopping,
                lifecycleGeneration: election.lifecycleGeneration,
                electionPausedUntil: election.electionPausedUntil,
                lastLeaderIdentityKey: election.lastLeaderIdentityKey,
                rateLimitSnapshotProvider: election.rateLimitSnapshotProvider,
                balanceLeaseSnapshotProvider: election.balanceLeaseSnapshotProvider,
                rateLimitSnapshotValidator: election.rateLimitSnapshotValidator,
                balanceLeaseSnapshotValidator: election.balanceLeaseSnapshotValidator
            };
            const originalFallback = bus.startFallbackTransport;
            const originalPublisherStart = LeaderFilePublisher.prototype.start;
            const originalPublisherStop = LeaderFilePublisher.prototype.stop;
            const context = createContext();
            const leaderId = randomUUID();
            const nomineeId = randomUUID();
            const electedAt = Date.now();
            const authorityTerm = `${leaderId}:${electedAt}`;
            const record = { instanceId: leaderId, electedAt, lastHeartbeat: electedAt };
            const received: InterInstanceEvent[] = [];
            const observerEvents: InterInstanceEvent[] = [];
            const client = new IpcClient({ onMessage: event => received.push(event) });
            const observer = new IpcClient({ onMessage: event => observerEvents.push(event) });
            let releaseWrite: ((error?: Error) => void) | undefined;
            let restoreWrite: (() => void) | undefined;
            let activeResignation: ReturnType<typeof LeaderElectionService.resignLeadership> | undefined;
            const snapshots = {
                sourceAuthorityTerm: authorityTerm,
                capturedAt: electedAt,
                leases: Array.from({ length: mode.startsWith('large-') ? 1000 : 1 }, (_, index) => ({
                    leaseId: `lease-${index}`,
                    slot: 'slot',
                    balanceKey: 'turn',
                    configId: 'config',
                    credentialId: 'a'.repeat(64),
                    ownerInstanceId: nomineeId,
                    expiresAt: electedAt + 30000
                }))
            };
            assert.equal(isValidBalanceLeaseHandoff(snapshots), true);
            try {
                await context.globalState.update('gcmp.leader.info.v2', record);
                Object.assign(election, {
                    context,
                    instanceId: leaderId,
                    initialized: true,
                    _isLeader: true,
                    ownElectedAt: electedAt,
                    agentsWindow: false,
                    stopping: false,
                    electionPausedUntil: 0,
                    lastLeaderIdentityKey: undefined,
                    rateLimitSnapshotValidator: undefined,
                    balanceLeaseSnapshotValidator: undefined
                });
                LeaderElectionService.setBalanceLeaseSnapshotProvider(() => snapshots);
                LeaderElectionService.setRateLimitSnapshotProvider(() => ({ buckets: [], grants: [] }));
                bus.startFallbackTransport = () => {};
                LeaderFilePublisher.prototype.start = async () => {};
                LeaderFilePublisher.prototype.stop = async () => {};
                InterInstanceBus.initialize(context);
                await bus.roleSwitchChain;
                const server = bus.server!;
                assert.ok(server);
                const state = server as unknown as ServerState;
                for (const [connection, id] of [
                    [client, nomineeId],
                    [observer, randomUUID()]
                ] as const) {
                    await connection.connect(state.currentPath);
                    connection.send({
                        type: 'remoteInstanceHello',
                        payload: { leaderEligible: true },
                        timestamp: Date.now(),
                        senderInstanceId: id
                    });
                    await waitFor(() => server.getEligibleFollowerIds().includes(id));
                }
                await waitFor(() => received.length > 0 && observerEvents.length > 0);
                const handoffs = () => received.filter(event => event.type === 'leaderResigning');
                if (
                    mode.startsWith('write-') ||
                    mode === 'new-term' ||
                    mode === 'foreign-term' ||
                    mode === 'new-lifecycle'
                ) {
                    const socket = [...state.socketInstanceIds].find(([, id]) => id === nomineeId)![0];
                    const write = socket.write;
                    restoreWrite = () => {
                        socket.write = write;
                    };
                    socket.write = ((
                        data: string | Uint8Array,
                        encoding?: BufferEncoding | ((error?: Error | null) => void),
                        callback?: (error?: Error | null) => void
                    ): boolean => {
                        const complete = typeof encoding === 'function' ? encoding : callback;
                        return write.call(socket, data, typeof encoding === 'string' ? encoding : 'utf8', error => {
                            releaseWrite = failure => complete?.(failure ?? error);
                        });
                    }) as Socket['write'];
                    let settled = false;
                    activeResignation = LeaderElectionService.resignLeadership();
                    const observed = activeResignation
                        .then(
                            result => ({ result, error: undefined }),
                            (error: unknown) => ({ result: undefined, error })
                        )
                        .finally(() => {
                            settled = true;
                        });
                    await waitFor(() => releaseWrite !== undefined);
                    assert.equal(settled, false);
                    assert.equal(LeaderElectionService.isLeader(), true);
                    assert.deepEqual(context.globalState.get('gcmp.leader.info.v2'), record);
                    assert.equal(
                        observerEvents.some(event => event.type === 'leaderResigning'),
                        false
                    );
                    if (mode === 'new-term' || mode === 'new-lifecycle') {
                        election.ownElectedAt = electedAt + 1;
                        if (mode === 'new-lifecycle') {
                            election.lifecycleGeneration++;
                        }
                        const replacement = { ...record, electedAt: electedAt + 1 };
                        await context.globalState.update('gcmp.leader.info.v2', replacement);
                        releaseWrite!();
                        assert.deepEqual(await observed, { result: 'not-leader', error: undefined });
                        assert.equal(LeaderElectionService.isLeader(), true);
                        assert.deepEqual(context.globalState.get('gcmp.leader.info.v2'), replacement);
                        assert.equal(
                            observerEvents.some(event => event.type === 'leaderResigning'),
                            false
                        );
                        return;
                    }
                    if (mode === 'foreign-term') {
                        await context.globalState.update('gcmp.leader.info.v2', { ...record, instanceId: nomineeId });
                    }
                    if (mode === 'write-close') {
                        socket.destroy();
                    } else if (mode !== 'write-timeout') {
                        releaseWrite!(mode === 'write-error' ? new Error('injected write failure') : undefined);
                    }
                    const outcome = await observed;
                    if (mode === 'write-error' || mode === 'write-close' || mode === 'write-timeout') {
                        assert.ok(outcome.error instanceof Error);
                        assert.match(outcome.error.message, /handoff.*not.*confirmed/i);
                        assert.equal(outcome.result, undefined);
                        assert.equal(LeaderElectionService.isLeader(), false);
                        assert.equal(context.globalState.get('gcmp.leader.info.v2'), undefined);
                        assert.equal(
                            observerEvents.some(event => event.type === 'leaderResigning'),
                            false
                        );
                        releaseWrite!();
                        return;
                    }
                    assert.deepEqual(outcome, { result: 'resigned', error: undefined });
                    await bus.roleSwitchChain;
                    await waitFor(() => !client.isConnected());
                    assert.equal(handoffs().length, 1);
                    assert.equal(LeaderElectionService.isLeader(), false);
                    if (mode === 'foreign-term') {
                        assert.deepEqual(context.globalState.get('gcmp.leader.info.v2'), {
                            ...record,
                            instanceId: nomineeId
                        });
                    }
                    return;
                }
                if (mode === 'queued' || mode === 'drained' || mode === 'large-drained') {
                    assert.equal(
                        server.sendToInstance(nomineeId, {
                            type: 'statusUpdated',
                            payload: { providerKey: 'test', source: 'cache', data: 'x'.repeat(96 * 1024) },
                            timestamp: Date.now(),
                            senderInstanceId: leaderId
                        }),
                        'sent'
                    );
                    assert.equal(state.backpressuredSockets.size, 1);
                    if (mode === 'queued') {
                        assert.equal(
                            server.sendToInstance(nomineeId, {
                                type: 'statusUpdated',
                                payload: { providerKey: 'test', source: 'cache', data: 'queued' },
                                timestamp: Date.now(),
                                senderInstanceId: leaderId
                            }),
                            'sent'
                        );
                        await assert.rejects(
                            LeaderElectionService.resignLeadership(),
                            /Failed to publish leadership handoff/
                        );
                        assert.equal(LeaderElectionService.isLeader(), true);
                        assert.deepEqual(context.globalState.get('gcmp.leader.info.v2'), record);
                        assert.equal(election.electionPausedUntil, 0);
                        assert.equal(client.isConnected(), true);
                        assert.equal(handoffs().length, 0);
                        assert.equal(
                            observerEvents.some(event => event.type === 'leaderResigning'),
                            false
                        );
                        for (const pressure of state.backpressuredSockets.values()) {
                            assert.equal(
                                pressure.queue.some(
                                    value => (JSON.parse(value) as InterInstanceEvent).type === 'leaderResigning'
                                ),
                                false
                            );
                        }
                    }
                    await waitFor(
                        () =>
                            state.backpressuredSockets.size === 0 &&
                            received.some(event => event.type === 'statusUpdated')
                    );
                    if (mode === 'queued') {
                        await waitFor(() => received.filter(event => event.type === 'statusUpdated').length === 2);
                    }
                }
                assert.equal(await LeaderElectionService.resignLeadership(), 'resigned');
                await bus.roleSwitchChain;
                await waitFor(() => !client.isConnected());
                assert.equal(handoffs().length, 1);
                const handoff = handoffs()[0];
                assert.deepEqual(handoff.payload.balanceLeaseSnapshot, snapshots);
                assert.deepEqual(handoff.payload.rateLimitSnapshot, { buckets: [], grants: [] });
                assert.equal(handoff.payload.nextLeaderId, nomineeId);
                assert.equal(LeaderElectionService.isLeader(), false);
            } finally {
                releaseWrite?.();
                await activeResignation?.catch(() => {});
                restoreWrite?.();
                await client.disconnect();
                await observer.disconnect();
                await InterInstanceBus.dispose();
                for (const disposable of context.subscriptions) {
                    disposable.dispose();
                }
                Object.assign(election, previous);
                bus.startFallbackTransport = originalFallback;
                LeaderFilePublisher.prototype.start = originalPublisherStart;
                LeaderFilePublisher.prototype.stop = originalPublisherStop;
            }
        });
    }
});
