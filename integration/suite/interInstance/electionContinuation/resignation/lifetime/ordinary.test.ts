import assert from 'node:assert/strict';
import { InterInstanceBus } from '../../../../../../src/interInstance/interInstanceBus';
import {
    USAGES_QUERY_PROTOCOL_VERSION,
    type RemoteInstanceCapabilitiesEvent
} from '../../../../../../src/interInstance/eventProtocol';
import { LeaderElectionService } from '../../../../../../src/status/leaderElectionService';
import { createLivenessFixture, waitFor } from '../../../leaderLiveness/fixture';
import { deferred } from '../../fixture';

suite('Ordinary candidate authority after a completed negative probe', () => {
    for (const boundary of ['write', 'confirmation'] as const) {
        for (const change of [
            'unchanged',
            'new-confirmed',
            'confirmed-ABA',
            'explicit-cancellation',
            'normal-concurrent',
            'new-candidate'
        ] as const) {
            test(`${boundary}/${change}: continuation and later heartbeat retain their candidate authority`, async () => {
                const f = await createLivenessFixture();
                const originalTimeout = globalThis.setTimeout;
                const originalUpdate = f.context.globalState.update;
                const entered = deferred();
                const release = deferred();
                let timer: NodeJS.Timeout | undefined;
                let blocked = false;
                let pending: Promise<void> | undefined;
                f.setResponder(() => {});
                if (boundary === 'write') {
                    f.context.globalState.update = async (key: string, value: unknown) => {
                        await originalUpdate.call(f.context.globalState, key, value);
                        if (key === 'gcmp.leader.info.v2' && !blocked) {
                            blocked = true;
                            entered.resolve();
                            await release.promise;
                        }
                    };
                } else {
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
                }
                const sendCapability = async (term: string) => {
                    const event: RemoteInstanceCapabilitiesEvent = {
                        type: 'remoteInstanceCapabilities',
                        timestamp: Date.now(),
                        senderInstanceId: f.identity.instanceId,
                        payload: {
                            targetInstanceId: f.followerId,
                            extensionVersion: '1.0.0',
                            usagesQueryProtocolVersion: USAGES_QUERY_PROTOCOL_VERSION,
                            leaderLivenessProtocolVersion: 1,
                            authorityTerm: term
                        }
                    };
                    assert.equal(f.server.sendToInstance(f.followerId, event), 'sent');
                    await waitFor(() => InterInstanceBus.getConfirmedLeaderAuthority().authorityTerm === term);
                };
                try {
                    pending = f.election.checkLeader();
                    await entered.promise;
                    assert.equal(f.updates.length, 1);
                    assert.equal(f.events.filter(event => event.type === 'leaderLivenessRequested').length, 1);
                    assert.equal(LeaderElectionService.isLeader(), false);
                    assert.equal(f.read()?.instanceId, f.followerId);
                    const oldCandidate = f.read();
                    const decision = f.election.decisionGeneration;
                    const generation = InterInstanceBus.getConfirmedLeaderAuthority().generation;
                    const invalidated = change !== 'unchanged' && change !== 'normal-concurrent';
                    if (change === 'explicit-cancellation') {
                        InterInstanceBus.cancelLeaderLiveness();
                    } else if (invalidated) {
                        await sendCapability(`${f.identity.instanceId}:${f.identity.electedAt + 1}`);
                        if (change === 'confirmed-ABA') {
                            await sendCapability(f.identity.authorityTerm);
                        }
                    }
                    if (invalidated) {
                        assert.ok(InterInstanceBus.getConfirmedLeaderAuthority().generation > generation);
                    }
                    assert.equal(f.election.decisionGeneration, decision);
                    if (change === 'normal-concurrent') {
                        await f.election.checkLeader();
                        assert.equal(LeaderElectionService.isLeader(), true);
                        assert.deepEqual(f.roles, [true]);
                    }
                    release.resolve();
                    await pending;
                    assert.equal(LeaderElectionService.isLeader(), !invalidated);
                    assert.deepEqual(f.roles, invalidated ? [] : [true]);
                    if (invalidated) {
                        assert.equal(LeaderElectionService.getOwnedAuthorityTerm(), undefined);
                        await f.election.checkLeader();
                        assert.equal(LeaderElectionService.isLeader(), false);
                        assert.equal(LeaderElectionService.getOwnedAuthorityTerm(), undefined);
                        assert.deepEqual(f.roles, []);
                    }
                    if (change === 'new-candidate') {
                        await f.write(f.record);
                        await sendCapability(f.identity.authorityTerm);
                        const writes = f.updates.length;
                        pending = f.election.checkLeader();
                        await pending;
                        assert.equal(f.updates.length, writes + 1);
                        assert.equal(f.events.filter(event => event.type === 'leaderLivenessRequested').length, 2);
                        assert.equal(LeaderElectionService.isLeader(), true);
                        assert.deepEqual(f.roles, [true]);
                        assert.notEqual(f.read()?.electedAt, oldCandidate?.electedAt);
                        assert.equal(
                            LeaderElectionService.getOwnedAuthorityTerm(),
                            `${f.followerId}:${f.read()?.electedAt}`
                        );
                    }
                } finally {
                    release.resolve();
                    clearTimeout(timer);
                    try {
                        await pending;
                    } finally {
                        globalThis.setTimeout = originalTimeout;
                        f.context.globalState.update = originalUpdate;
                        await f.dispose();
                    }
                }
            });
        }
    }
});
