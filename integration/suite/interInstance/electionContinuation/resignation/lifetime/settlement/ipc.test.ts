import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { InterInstanceBus } from '../../../../../../../src/interInstance';
import type { InterInstanceEvent } from '../../../../../../../src/interInstance/eventProtocol';
import { IpcClient } from '../../../../../../../src/interInstance/ipcClient';
import { resolveIpcPath } from '../../../../../../../src/interInstance/pathResolver';
import { LeaderElectionService } from '../../../../../../../src/status/leaderElectionService';
import { createLivenessFixture, waitFor } from '../../../../leaderLiveness/fixture';
import { deferred } from '../../../fixture';

suite('Rejected owned candidate IPC authority', () => {
    for (const rejectA of [false, true]) {
        for (const outcomeB of ['rejected', 'cancelled', 'confirmed'] as const) {
            test(`A-rejected=${rejectA}/B=${outcomeB}: real IPC cannot acknowledge rejected ownership`, async () => {
                const f = await createLivenessFixture(0);
                const originalNow = Date.now;
                const update = f.context.globalState.update;
                const entered = deferred();
                const gate = deferred();
                const errorA = new Error('IPC late A receipt rejected');
                const errorB = new Error('IPC B receipt rejected');
                const events: InterInstanceEvent[] = [];
                const observerId = randomUUID();
                const observer = new IpcClient({ onMessage: event => events.push(event), onDisconnect: () => {} });
                let now = originalNow();
                let settledA: Promise<void> | undefined;
                Date.now = () => now;
                try {
                    await f.write(undefined);
                    f.context.globalState.update = async (key: string, value: unknown) => {
                        await update.call(f.context.globalState, key, value);
                        entered.resolve();
                        await gate.promise;
                        if (rejectA) {
                            throw errorA;
                        }
                    };
                    const pendingA = f.election.becomeLeader();
                    settledA = rejectA ? assert.rejects(pendingA, errorA) : pendingA;
                    await entered.promise;
                    const recordA = f.read();
                    assert.ok(recordA);
                    const termA = `${recordA.instanceId}:${recordA.electedAt}`;
                    f.context.globalState.update = update;
                    await f.election.checkLeader();
                    await f.bus.roleSwitchChain;
                    assert.equal(LeaderElectionService.getOwnedAuthorityTerm(), termA);
                    assert.ok(f.bus.server);
                    await f.write(undefined);
                    now++;
                    f.context.globalState.update = async (key: string, value: unknown) => {
                        await update.call(f.context.globalState, key, value);
                        if (outcomeB === 'rejected') {
                            throw errorB;
                        }
                        if (outcomeB === 'cancelled') {
                            InterInstanceBus.cancelLeaderLiveness();
                        }
                    };
                    if (outcomeB === 'rejected') {
                        await assert.rejects(f.election.becomeLeader(), errorB);
                    } else {
                        await f.election.becomeLeader();
                    }
                    f.context.globalState.update = update;
                    await f.bus.roleSwitchChain;
                    const recordB = f.read();
                    assert.ok(recordB);
                    assert.ok(recordB.electedAt > recordA.electedAt);
                    const termB = `${recordB.instanceId}:${recordB.electedAt}`;
                    gate.resolve();
                    await settledA;
                    await f.write(recordA);
                    for (let heartbeat = 0; heartbeat < 3; heartbeat++) {
                        await f.election.checkLeader();
                    }
                    await f.bus.roleSwitchChain;
                    const owned = LeaderElectionService.getOwnedAuthorityTerm();
                    let replyTerm: string | undefined;
                    if (owned && f.bus.server) {
                        await observer.connect(resolveIpcPath(f.followerId));
                        observer.send({
                            type: 'remoteInstanceHello',
                            timestamp: now,
                            senderInstanceId: observerId,
                            payload: {}
                        });
                        await waitFor(() => events.some(event => event.type === 'remoteInstanceCapabilities'));
                        const requestId = randomUUID();
                        observer.send({
                            type: 'leaderLivenessRequested',
                            timestamp: now,
                            senderInstanceId: observerId,
                            payload: { requestId, targetInstanceId: f.followerId, authorityTerm: owned }
                        });
                        await waitFor(() =>
                            events.some(
                                event =>
                                    event.type === 'leaderLivenessConfirmed' && event.payload.requestId === requestId
                            )
                        );
                        const reply = events.find(
                            event => event.type === 'leaderLivenessConfirmed' && event.payload.requestId === requestId
                        );
                        assert.ok(reply && reply.type === 'leaderLivenessConfirmed');
                        replyTerm = reply.payload.authorityTerm;
                    }
                    if (outcomeB === 'confirmed') {
                        assert.equal(owned, termB);
                        assert.equal(replyTerm, termB);
                    } else if (rejectA) {
                        assert.notEqual(replyTerm, termA, 'real IPC replied for the rejected owned candidate');
                        assert.equal(owned, undefined);
                        assert.equal(LeaderElectionService.isLeader(), false);
                        assert.equal(f.bus.server, undefined);
                    } else {
                        assert.equal(owned, termA);
                        assert.equal(replyTerm, termA);
                    }
                } finally {
                    gate.resolve();
                    f.context.globalState.update = update;
                    try {
                        await settledA;
                    } finally {
                        await observer.disconnect();
                        Date.now = originalNow;
                        await f.dispose();
                    }
                }
            });
        }
    }
});
