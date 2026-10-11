import assert from 'node:assert/strict';
import type { Socket } from 'node:net';
import { InterInstanceBus } from '../../../../src/interInstance/interInstanceBus';
import type { InterInstanceEvent } from '../../../../src/interInstance/eventProtocol';
import { createLivenessFixture } from './fixture';

const changes = ['unchanged', 'authority ABA', 'capability ABA', 'explicit cancellation'] as const;
type Change = (typeof changes)[number];

function arrangeReply(f: Awaited<ReturnType<typeof createLivenessFixture>>, change: Change, late: boolean) {
    const bindings = (f.server as unknown as { socketInstanceIds: Map<Socket, string> }).socketInstanceIds;
    const socket = [...bindings].find(([, id]) => id === f.followerId)?.[0];
    assert.ok(socket, 'missing connected server-side follower socket');
    const probe = (InterInstanceBus as unknown as { leaderLivenessProbe: { now(): number } }).leaderLivenessProbe;
    const originalNow = probe.now;
    const originalUpdate = f.context.globalState.update;
    let now = 0;
    probe.now = () => now;
    const terms: Array<string | undefined> = [];
    let termsAtWrite: Array<string | undefined> | undefined;
    const authoritySubscription = InterInstanceBus.onAuthorityChanged(term => {
        terms.push(term);
    });
    const cancelSubscription = InterInstanceBus.subscribe('remoteInstanceCapabilities', () => {
        if (change === 'explicit cancellation') {
            InterInstanceBus.cancelLeaderLiveness();
        }
    });
    f.context.globalState.update = async (key: string, value: unknown) => {
        if (key === 'gcmp.leader.info.v2' && termsAtWrite === undefined) {
            termsAtWrite = [...terms];
        }
        await originalUpdate.call(f.context.globalState, key, value);
    };
    const nextTerm = `${f.identity.instanceId}:${f.identity.electedAt + 1}`;
    f.setResponder(event => {
        if (event.type !== 'leaderLivenessRequested') {
            return;
        }
        now = late ? 1001 : 1;
        const frames: InterInstanceEvent[] = [
            {
                type: 'leaderLivenessConfirmed',
                timestamp: Date.now(),
                senderInstanceId: f.identity.instanceId,
                payload: { ...event.payload, targetInstanceId: f.followerId }
            }
        ];
        const capabilities =
            change === 'authority ABA' ?
                [
                    { authorityTerm: nextTerm, leaderLivenessProtocolVersion: 1 },
                    { authorityTerm: f.identity.authorityTerm, leaderLivenessProtocolVersion: 1 }
                ]
            : change === 'capability ABA' ?
                [
                    { authorityTerm: f.identity.authorityTerm, leaderLivenessProtocolVersion: undefined },
                    { authorityTerm: f.identity.authorityTerm, leaderLivenessProtocolVersion: 1 }
                ]
            :   [{ authorityTerm: f.identity.authorityTerm, leaderLivenessProtocolVersion: 1 }];
        for (const capability of capabilities) {
            frames.push({
                type: 'remoteInstanceCapabilities',
                timestamp: Date.now(),
                senderInstanceId: f.identity.instanceId,
                payload: {
                    targetInstanceId: f.followerId,
                    extensionVersion: 'different',
                    usagesQueryProtocolVersion: 1,
                    ...capability
                }
            });
        }
        socket.write(frames.map(frame => JSON.stringify(frame) + '\n').join(''));
    });
    return {
        terms,
        nextTerm,
        getTermsAtWrite: () => termsAtWrite,
        restore: () => {
            authoritySubscription.dispose();
            cancelSubscription.dispose();
            probe.now = originalNow;
            f.context.globalState.update = originalUpdate;
        }
    };
}

suite('Completed liveness result invalidation', () => {
    for (const late of [false, true]) {
        for (const change of changes) {
            test(`${late ? 'late' : 'timely'} completed reply with ${change} preserves invalidation across await`, async () => {
                const f = await createLivenessFixture();
                let reply: ReturnType<typeof arrangeReply> | undefined;
                try {
                    reply = arrangeReply(f, change, late);
                    const result = await InterInstanceBus.confirmLeaderLiveness(f.identity);
                    assert.equal(
                        result,
                        change === 'unchanged' ?
                            late ? 'unconfirmed'
                            :   'alive'
                        :   'invalidated'
                    );
                    if (change === 'authority ABA') {
                        assert.deepEqual(reply.terms, [reply.nextTerm, f.identity.authorityTerm]);
                    }
                    f.assertUnchangedFollower();
                } finally {
                    reply?.restore();
                    await f.dispose();
                }
            });
        }
    }

    for (const change of changes) {
        test(`a completed negative reply with ${change} has the correct candidate-write decision`, async () => {
            const f = await createLivenessFixture();
            let reply: ReturnType<typeof arrangeReply> | undefined;
            try {
                reply = arrangeReply(f, change, true);
                await f.election.checkLeader();
                if (change === 'authority ABA') {
                    assert.deepEqual(reply.terms.slice(0, 2), [reply.nextTerm, f.identity.authorityTerm]);
                    if (f.updates.length) {
                        assert.deepEqual(reply.getTermsAtWrite(), [reply.nextTerm, f.identity.authorityTerm]);
                    }
                }
                if (change === 'unchanged') {
                    assert.equal(f.updates.length, 1);
                    assert.deepEqual(f.roles, [true]);
                } else {
                    f.assertUnchangedFollower();
                }
            } finally {
                reply?.restore();
                await f.dispose();
            }
        });
    }
});
