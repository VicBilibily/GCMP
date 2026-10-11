import assert from 'node:assert/strict';
import test from 'node:test';
import { LeaderLivenessProbe } from './probe';
import type { InterInstanceEvent } from '../eventProtocol';
import type { LeaderLivenessConfirmedEvent } from './protocol';

function fixture(timeoutMs = 60_000) {
    let now = 0;
    const sent: InterInstanceEvent[] = [];
    const client = {
        send: (event: InterInstanceEvent) => {
            sent.push(event);
        }
    };
    const probe = new LeaderLivenessProbe(timeoutMs, () => now);
    const identity = { instanceId: 'leader', authorityTerm: 'leader:1' };
    function response(index = 0): LeaderLivenessConfirmedEvent {
        const request = sent[index];
        assert.equal(request.type, 'leaderLivenessRequested');
        if (request.type !== 'leaderLivenessRequested') {
            throw new Error('Missing request');
        }
        return {
            type: 'leaderLivenessConfirmed',
            timestamp: Date.now(),
            senderInstanceId: identity.instanceId,
            payload: { ...request.payload, targetInstanceId: 'follower' }
        };
    }
    return {
        probe,
        client,
        sent,
        identity,
        response,
        advance: (milliseconds: number) => {
            now += milliseconds;
        }
    };
}

test('leader liveness requires a fresh matching reply, not a writable client', async t => {
    const f = fixture();
    t.after(() => f.probe.cancel());
    const pending = f.probe.confirm(f.client, f.identity, 'follower');
    assert.equal(f.sent.length, 1);
    assert.ok((f.probe as unknown as { pending?: unknown }).pending);
    f.probe.accept(f.response(), f.client);
    assert.equal(await pending, 'alive');
    assert.equal((f.probe as unknown as { pending?: unknown }).pending, undefined);
});

for (const mismatch of ['sender', 'nonce', 'target', 'term', 'client', 'type', 'payload'] as const) {
    test(`leader liveness rejects ${mismatch} mismatch without completing the probe`, async t => {
        const f = fixture();
        t.after(() => f.probe.cancel());
        const pending = f.probe.confirm(f.client, f.identity, 'follower');
        const reply = f.response();
        let source = f.client;
        if (mismatch === 'sender') {
            reply.senderInstanceId = 'other';
        } else if (mismatch === 'nonce') {
            reply.payload.requestId = 'other';
        } else if (mismatch === 'target') {
            reply.payload.targetInstanceId = 'other';
        } else if (mismatch === 'term') {
            reply.payload.authorityTerm = 'leader:2';
        } else if (mismatch === 'client') {
            source = { send: () => {} };
        }
        const event: InterInstanceEvent = mismatch === 'type' ? { ...reply, type: 'leaderLivenessRequested' } : reply;
        if (mismatch === 'payload') {
            Object.assign(event, { payload: { ...reply.payload, requestId: 1 } });
        }
        f.probe.accept(event, source);
        assert.ok((f.probe as unknown as { pending?: unknown }).pending);
        f.probe.accept(f.response(), f.client);
        assert.equal(await pending, 'alive');
    });
}

test('leader liveness coalesces overlapping probes for the same connection and term', async t => {
    const f = fixture();
    t.after(() => f.probe.cancel());
    const first = f.probe.confirm(f.client, f.identity, 'follower');
    const second = f.probe.confirm(f.client, f.identity, 'follower');
    assert.equal(first, second);
    assert.equal(f.sent.length, 1);
    f.probe.accept(f.response(), f.client);
    assert.deepEqual(await Promise.all([first, second]), ['alive', 'alive']);
});

for (const change of ['client', 'term', 'leader', 'requester'] as const) {
    test(`leader liveness supersedes the old probe on ${change} change`, async t => {
        const f = fixture();
        t.after(() => f.probe.cancel());
        const first = f.probe.confirm(f.client, f.identity, 'follower');
        const staleReply = f.response();
        const client = change === 'client' ? { send: f.client.send } : f.client;
        const identity = {
            instanceId: change === 'leader' ? 'next' : f.identity.instanceId,
            authorityTerm: change === 'term' ? 'leader:2' : f.identity.authorityTerm
        };
        const requester = change === 'requester' ? 'next-follower' : 'follower';
        const second = f.probe.confirm(client, identity, requester);
        assert.equal(await first, 'invalidated');
        f.probe.accept(staleReply, f.client);
        assert.ok((f.probe as unknown as { pending?: unknown }).pending);
        const reply = f.response(1);
        reply.senderInstanceId = identity.instanceId;
        reply.payload.targetInstanceId = requester;
        f.probe.accept(reply, client);
        assert.equal(await second, 'alive');
    });
}

for (const age of [1000, 1001]) {
    test(`leader liveness rejects a reply at monotonic deadline age ${age}`, async t => {
        const f = fixture(1000);
        t.after(() => f.probe.cancel());
        const pending = f.probe.confirm(f.client, f.identity, 'follower');
        f.advance(age);
        f.probe.accept(f.response(), f.client);
        assert.equal(await pending, 'unconfirmed');
    });
}

test('leader liveness accepts a reply before its monotonic deadline', async t => {
    const f = fixture(1000);
    t.after(() => f.probe.cancel());
    const pending = f.probe.confirm(f.client, f.identity, 'follower');
    f.advance(999);
    f.probe.accept(f.response(), f.client);
    assert.equal(await pending, 'alive');
});

test('leader liveness silence settles within its bounded timer', async t => {
    const f = fixture(20);
    t.after(() => f.probe.cancel());
    const pending = f.probe.confirm(f.client, f.identity, 'follower');
    assert.equal(await pending, 'unconfirmed');
    assert.equal((f.probe as unknown as { pending?: unknown }).pending, undefined);
});

test('leader liveness cancellation clears the wait and rejects late replies', async t => {
    const f = fixture();
    t.after(() => f.probe.cancel());
    const pending = f.probe.confirm(f.client, f.identity, 'follower');
    const old = f.response();
    f.probe.cancel();
    f.probe.cancel();
    assert.equal(await pending, 'invalidated');
    f.probe.accept(old, f.client);
    const next = f.probe.confirm(f.client, f.identity, 'follower');
    assert.notEqual(f.sent[0], f.sent[1]);
    f.probe.accept(old, f.client);
    assert.ok((f.probe as unknown as { pending?: unknown }).pending);
    f.probe.accept(f.response(1), f.client);
    assert.equal(await next, 'alive');
});

test('leader liveness duplicate acknowledgement cannot satisfy a later probe', async t => {
    const f = fixture();
    t.after(() => f.probe.cancel());
    const first = f.probe.confirm(f.client, f.identity, 'follower');
    const reply = f.response();
    f.probe.accept(reply, f.client);
    assert.equal(await first, 'alive');
    const next = f.probe.confirm(f.client, f.identity, 'follower');
    f.probe.accept(reply, f.client);
    assert.ok((f.probe as unknown as { pending?: unknown }).pending);
    f.probe.accept(f.response(1), f.client);
    assert.equal(await next, 'alive');
});

test('leader liveness send failures remain unconfirmed without leaving pending resources', async t => {
    const f = fixture();
    t.after(() => f.probe.cancel());
    assert.equal(
        await f.probe.confirm(
            {
                send: () => {
                    throw new Error('closed');
                }
            },
            f.identity,
            'follower'
        ),
        'unconfirmed'
    );
    assert.equal((f.probe as unknown as { pending?: unknown }).pending, undefined);
});
