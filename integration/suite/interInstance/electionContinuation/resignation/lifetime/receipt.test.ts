import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { InterInstanceBus } from '../../../../../../src/interInstance/interInstanceBus';
import {
    USAGES_QUERY_PROTOCOL_VERSION,
    type InterInstanceEvent
} from '../../../../../../src/interInstance/eventProtocol';
import type { IpcClient } from '../../../../../../src/interInstance/ipcClient';
import { IpcServer } from '../../../../../../src/interInstance/ipcServer';
import { resolveIpcPath } from '../../../../../../src/interInstance/pathResolver';
import { LeaderElectionService } from '../../../../../../src/status/leaderElectionService';
import { createLivenessFixture, waitFor } from '../../../leaderLiveness/fixture';
import { deferred } from '../../fixture';
import type { Election } from '../fixture';

interface ConnectionState {
    client: IpcClient | undefined;
    getLeaderConnectionTarget(): { instanceId: string; authorityTerm?: string; ipcPath: string } | undefined;
}

suite('Accepted resignation receipt invalidation after source close', () => {
    for (const change of [
        'synchronous-close-cancellation',
        'same-term-new-connection',
        'target-unavailable'
    ] as const) {
        test(`none/${change}: an invalidated receipt cannot resume or be adopted by a heartbeat`, async () => {
            const f = await createLivenessFixture(0);
            const election = f.election as Election;
            const state = InterInstanceBus as unknown as ConnectionState;
            const originalRecovery = election.recoverAfterLeaderResigning;
            const originalTarget = state.getLeaderConnectionTarget;
            const originalTimeout = globalThis.setTimeout;
            const originalNow = Date.now;
            const acceptedAt = originalNow();
            const entered = deferred();
            const release = deferred();
            const pending: Promise<void>[] = [];
            const sources: string[] = [];
            let timer: NodeJS.Timeout | undefined;
            let blocked = false;
            let cancellations = 0;
            let authoritySubscription: ReturnType<typeof InterInstanceBus.onAuthorityChanged> | undefined;
            let replacement: IpcServer | undefined;
            election.recoverAfterLeaderResigning = (...args) => {
                sources.push(args[0]);
                const operation = originalRecovery.call(election, ...args);
                pending.push(operation);
                return operation;
            };
            Date.now = () => acceptedAt;
            globalThis.setTimeout = ((...args: Parameters<typeof setTimeout>) => {
                if (args[1] !== 100 || blocked) {
                    return originalTimeout(...args);
                }
                blocked = true;
                timer = originalTimeout(() => {}, 60_000);
                entered.resolve();
                void release.promise.then(() => args[0](undefined));
                return timer;
            }) as typeof setTimeout;
            try {
                const sourceClient = state.client;
                assert.ok(sourceClient);
                assert.equal(sourceClient.isConnected(), true);
                LeaderElectionService.subscribeToLeaderResigning();
                assert.equal(
                    f.server.sendToInstance(f.followerId, {
                        type: 'leaderResigning',
                        senderInstanceId: f.identity.instanceId,
                        timestamp: acceptedAt,
                        payload: {
                            leaderId: f.identity.instanceId,
                            reason: 'manual',
                            sourceAuthorityTerm: f.identity.authorityTerm
                        }
                    }),
                    'sent'
                );
                await waitFor(() => pending.length > 0);
                assert.equal(pending.length, 1);
                await Promise.race([entered.promise, pending[0]]);
                assert.equal(blocked, true);
                assert.deepEqual(sources, [f.identity.instanceId]);
                const candidate = f.read();
                assert.deepEqual(candidate, {
                    instanceId: f.followerId,
                    electedAt: acceptedAt,
                    lastHeartbeat: acceptedAt
                });
                assert.deepEqual(f.updates, [candidate]);
                assert.equal(LeaderElectionService.isLeader(), false);
                assert.deepEqual(f.roles, []);
                const beforeClose = InterInstanceBus.getConfirmedLeaderAuthority();
                assert.equal(beforeClose.authorityTerm, f.identity.authorityTerm);
                if (change === 'synchronous-close-cancellation') {
                    authoritySubscription = InterInstanceBus.onAuthorityChanged(term => {
                        if (term === undefined) {
                            cancellations++;
                            InterInstanceBus.cancelLeaderLiveness();
                        }
                    });
                }
                await f.server.stop();
                await waitFor(() => !f.bus.clientTarget);
                assert.equal(sourceClient.isConnected(), false);
                assert.equal(state.client, sourceClient);
                assert.equal(InterInstanceBus.getAuthorityTerm(), undefined);
                assert.equal(f.bus.remoteLeaderLivenessCompatible, false);
                const closedAuthority = InterInstanceBus.getConfirmedLeaderAuthority();
                assert.equal(closedAuthority.authorityTerm, undefined);
                assert.ok(closedAuthority.generation > beforeClose.generation);
                if (change === 'synchronous-close-cancellation') {
                    assert.equal(cancellations, 1);
                    assert.equal(closedAuthority.generation, beforeClose.generation + 3);
                } else if (change === 'same-term-new-connection') {
                    const events: InterInstanceEvent[] = [];
                    const target = {
                        instanceId: f.identity.instanceId,
                        authorityTerm: f.identity.authorityTerm,
                        ipcPath: resolveIpcPath(randomUUID())
                    };
                    replacement = new IpcServer({
                        onMessage: event => {
                            events.push(event);
                        }
                    });
                    await replacement.start(target.ipcPath);
                    state.getLeaderConnectionTarget = () => ({ ...target });
                    await f.bus.connectToLeader();
                    await waitFor(() =>
                        events.some(
                            event =>
                                event.type === 'remoteInstanceHello' &&
                                event.senderInstanceId === f.followerId &&
                                event.payload.leaderEligible === true
                        )
                    );
                    assert.deepEqual(replacement.getEligibleFollowerIds(), [f.followerId]);
                    assert.notEqual(state.client, sourceClient);
                    assert.equal(state.client?.isConnected(), true);
                    assert.deepEqual(f.bus.clientTarget, target);
                    assert.equal(InterInstanceBus.getAuthorityTerm(), f.identity.authorityTerm);
                    const unconfirmed = InterInstanceBus.getConfirmedLeaderAuthority();
                    assert.equal(unconfirmed.authorityTerm, undefined);
                    assert.equal(f.bus.remoteLeaderLivenessCompatible, false);
                    assert.equal(
                        replacement.sendToInstance(f.followerId, {
                            type: 'remoteInstanceCapabilities',
                            senderInstanceId: f.identity.instanceId,
                            timestamp: acceptedAt,
                            payload: {
                                targetInstanceId: f.followerId,
                                extensionVersion: '1.0.0',
                                usagesQueryProtocolVersion: USAGES_QUERY_PROTOCOL_VERSION,
                                leaderLivenessProtocolVersion: 1,
                                authorityTerm: f.identity.authorityTerm
                            }
                        }),
                        'sent'
                    );
                    await waitFor(
                        () =>
                            InterInstanceBus.getConfirmedLeaderAuthority().authorityTerm === f.identity.authorityTerm &&
                            f.bus.remoteLeaderLivenessCompatible
                    );
                    assert.ok(InterInstanceBus.getConfirmedLeaderAuthority().generation > unconfirmed.generation);
                    assert.ok(unconfirmed.generation > closedAuthority.generation);
                } else {
                    state.getLeaderConnectionTarget = () => undefined;
                    await f.bus.connectToLeader();
                    assert.equal(state.client, sourceClient);
                    assert.equal(f.bus.clientTarget, undefined);
                    assert.equal(InterInstanceBus.getAuthorityTerm(), undefined);
                    assert.deepEqual(InterInstanceBus.getConfirmedLeaderAuthority(), closedAuthority);
                }
                release.resolve();
                await Promise.all(pending);
                assert.equal(pending.length, 1);
                assert.equal(LeaderElectionService.isLeader(), false);
                assert.equal(LeaderElectionService.getOwnedAuthorityTerm(), undefined);
                assert.deepEqual(f.roles, []);
                assert.deepEqual(f.updates, [candidate]);
                assert.deepEqual(f.read(), candidate);
                await f.election.checkLeader();
                assert.equal(LeaderElectionService.isLeader(), false);
                assert.equal(LeaderElectionService.getOwnedAuthorityTerm(), undefined);
                assert.deepEqual(f.roles, []);
                assert.deepEqual(f.updates, [candidate]);
                assert.deepEqual(f.read(), candidate);
            } finally {
                release.resolve();
                clearTimeout(timer);
                try {
                    await Promise.all(pending);
                } finally {
                    globalThis.setTimeout = originalTimeout;
                    Date.now = originalNow;
                    election.recoverAfterLeaderResigning = originalRecovery;
                    state.getLeaderConnectionTarget = originalTarget;
                    try {
                        authoritySubscription?.dispose();
                    } finally {
                        try {
                            await f.dispose();
                        } finally {
                            await replacement?.stop();
                        }
                    }
                }
            }
        });
    }
});
