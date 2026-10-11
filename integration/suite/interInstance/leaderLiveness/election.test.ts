import assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';
import { randomUUID } from 'node:crypto';
import { InterInstanceBus } from '../../../../src/interInstance/interInstanceBus';
import { LeaderElectionService } from '../../../../src/status/leaderElectionService';
import { createLivenessFixture, waitFor } from './fixture';

suite('Leader liveness takeover guard', () => {
    for (const age of [15_001, 30_000]) {
        test(`responsive same-term leader is not replaced for stale heartbeat age ${age}`, async () => {
            const fixture = await createLivenessFixture(age);
            try {
                await fixture.proveResponsive();
                assert.ok(fixture.bus.client?.isConnected());
                await fixture.election.checkLeader();
                fixture.assertUnchangedFollower();
            } finally {
                await fixture.dispose();
            }
        });
    }

    test('healthy stored heartbeat still needs no takeover or new write', async () => {
        const fixture = await createLivenessFixture(1000);
        try {
            await fixture.proveResponsive();
            await fixture.election.checkLeader();
            fixture.assertUnchangedFollower();
            assert.equal(fixture.events.filter(event => event.type === 'leaderLivenessRequested').length, 0);
        } finally {
            await fixture.dispose();
        }
    });

    test('explicit nominated takeover remains possible while the old leader responds', async () => {
        const fixture = await createLivenessFixture();
        try {
            await fixture.proveResponsive();
            await fixture.election.becomeLeader(true);
            assert.equal(LeaderElectionService.isLeader(), true);
            assert.equal(fixture.updates.length, 1);
            assert.equal(fixture.events.filter(event => event.type === 'leaderLivenessRequested').length, 0);
        } finally {
            await fixture.dispose();
        }
    });

    for (const mode of [
        'silent',
        'lost ownership',
        'owned term mismatch',
        'wrong nonce',
        'wrong target',
        'wrong term',
        'wrong sender',
        'fallback reply'
    ]) {
        test(`expired heartbeat remains recoverable when connected leader has ${mode}`, async () => {
            const f = await createLivenessFixture();
            try {
                await f.proveResponsive();
                if (mode === 'lost ownership') {
                    f.setLeaderOwns(false);
                } else if (mode === 'owned term mismatch') {
                    await f.leaderContext.globalState.update('gcmp.leader.info.v2', {
                        ...f.record,
                        electedAt: f.record.electedAt + 1
                    });
                } else {
                    f.setResponder(event => {
                        if (event.type !== 'leaderLivenessRequested' || mode === 'silent') {
                            return;
                        }
                        const reply = {
                            type: 'leaderLivenessConfirmed' as const,
                            timestamp: Date.now(),
                            senderInstanceId: mode === 'wrong sender' ? 'imposter' : f.identity.instanceId,
                            payload: {
                                ...event.payload,
                                requestId: mode === 'wrong nonce' ? 'other' : event.payload.requestId,
                                targetInstanceId: mode === 'wrong target' ? 'other' : f.followerId,
                                authorityTerm:
                                    mode === 'wrong term' ? `${f.identity.instanceId}:1` : f.identity.authorityTerm
                            }
                        };
                        if (mode === 'fallback reply') {
                            f.bus.dispatchEvent(reply);
                        } else {
                            f.server.sendToInstance(f.followerId, reply);
                        }
                    });
                }
                const start = performance.now();
                await f.election.checkLeader();
                assert.ok(performance.now() - start >= 990, 'did not wait for the bounded liveness check');
                assert.equal(LeaderElectionService.isLeader(), true);
                assert.equal(f.updates.length, 1);
                assert.equal(f.events.filter(event => event.type === 'leaderLivenessRequested').length, 1);
            } finally {
                await f.dispose();
            }
        });
    }

    for (const mode of ['unsupported peer', 'IPC disabled', 'disconnected client', 'no leader'] as const) {
        test(`${mode} retains the original timeout takeover path`, async () => {
            const f = await createLivenessFixture();
            try {
                if (mode === 'unsupported peer') {
                    f.bus.remoteLeaderLivenessCompatible = false;
                }
                if (mode === 'IPC disabled') {
                    await InterInstanceBus.dispose();
                }
                if (mode === 'disconnected client') {
                    await f.bus.client?.disconnect();
                }
                if (mode === 'no leader') {
                    await f.write(undefined);
                }
                await f.election.becomeLeader();
                assert.equal(LeaderElectionService.isLeader(), true);
                assert.equal(f.updates.length, 1);
                assert.equal(f.events.filter(event => event.type === 'leaderLivenessRequested').length, 0);
            } finally {
                await f.dispose();
            }
        });
    }

    for (const change of [
        'heartbeat',
        'new term',
        'new leader',
        'removed record',
        'decision',
        'lifecycle',
        'bus dispose',
        'authority',
        'authority ABA',
        'disconnect'
    ] as const) {
        test(`in-flight liveness ${change} change prevents stale candidate writes`, async () => {
            const f = await createLivenessFixture();
            try {
                f.setResponder(() => {});
                const pending = f.election.checkLeader();
                await waitFor(() => f.events.some(event => event.type === 'leaderLivenessRequested'));
                if (change === 'heartbeat') {
                    await f.write({ ...f.record, lastHeartbeat: Date.now() });
                }
                if (change === 'new term') {
                    await f.write({ ...f.record, electedAt: f.record.electedAt + 1 });
                }
                if (change === 'new leader') {
                    await f.write({ ...f.record, instanceId: randomUUID() });
                }
                if (change === 'removed record') {
                    await f.write(undefined);
                }
                if (change === 'decision') {
                    f.election.decisionGeneration++;
                }
                if (change === 'lifecycle') {
                    f.election.lifecycleGeneration++;
                }
                if (change === 'bus dispose') {
                    await InterInstanceBus.dispose();
                }
                if (change === 'authority') {
                    f.bus.setAuthorityTerm(`${f.identity.instanceId}:2`);
                }
                if (change === 'authority ABA') {
                    f.bus.setAuthorityTerm(`${f.identity.instanceId}:2`);
                    f.bus.setAuthorityTerm(f.identity.authorityTerm);
                    f.bus.remoteLeaderLivenessCompatible = true;
                }
                if (change === 'disconnect') {
                    await f.bus.client?.disconnect();
                }
                await pending;
                assert.equal(LeaderElectionService.isLeader(), false);
                assert.deepEqual(f.updates, []);
                assert.deepEqual(f.roles, []);
            } finally {
                await f.dispose();
            }
        });
    }

    test('overlapping checks coalesce one probe and write at most one takeover candidate', async () => {
        const f = await createLivenessFixture();
        try {
            f.setResponder(() => {});
            await Promise.all([f.election.checkLeader(), f.election.checkLeader()]);
            assert.equal(f.events.filter(event => event.type === 'leaderLivenessRequested').length, 1);
            assert.equal(f.updates.length, 1);
            assert.equal(LeaderElectionService.isLeader(), true);
            assert.deepEqual(f.roles, [true]);
        } finally {
            await f.dispose();
        }
    });

    test('responsive liveness is not cached across checks or used to rewrite foreign heartbeat', async () => {
        const f = await createLivenessFixture();
        try {
            await f.election.checkLeader();
            f.assertUnchangedFollower();
            await f.election.checkLeader();
            f.assertUnchangedFollower();
            const requests = f.events.filter(event => event.type === 'leaderLivenessRequested');
            assert.equal(requests.length, 2);
            if (requests[0].type !== 'leaderLivenessRequested' || requests[1].type !== 'leaderLivenessRequested') {
                throw new Error('Missing requests');
            }
            assert.notEqual(requests[0].payload.requestId, requests[1].payload.requestId);
            f.setResponder(() => {});
            await f.election.checkLeader();
            assert.equal(LeaderElectionService.isLeader(), true);
            assert.equal(f.updates.length, 1);
        } finally {
            await f.dispose();
        }
    });

    test('stopping election cancels the probe and a restart cannot inherit its acknowledgement', async () => {
        const f = await createLivenessFixture();
        try {
            f.setResponder(() => {});
            const pending = f.election.checkLeader();
            await waitFor(() => f.events.some(event => event.type === 'leaderLivenessRequested'));
            const request = f.events.find(event => event.type === 'leaderLivenessRequested');
            assert.ok(request && request.type === 'leaderLivenessRequested');
            await LeaderElectionService.stop();
            await pending;
            assert.deepEqual(f.updates, []);
            assert.equal(LeaderElectionService.isLeader(), false);
            f.election.initialized = true;
            Object.assign(f.election, { stopping: false });
            f.server.sendToInstance(f.followerId, {
                type: 'leaderLivenessConfirmed',
                timestamp: Date.now(),
                senderInstanceId: f.identity.instanceId,
                payload: { ...request.payload, targetInstanceId: f.followerId }
            });
            await f.election.checkLeader();
            assert.equal(LeaderElectionService.isLeader(), true);
            assert.equal(f.updates.length, 1);
        } finally {
            await f.dispose();
        }
    });
});
