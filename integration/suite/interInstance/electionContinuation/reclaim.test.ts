import assert from 'node:assert/strict';
import { InterInstanceBus } from '../../../../src/interInstance/interInstanceBus';
import { LeaderFilePublisher } from '../../../../src/interInstance/leaderFile';
import { LeaderElectionService } from '../../../../src/status/leaderElectionService';
import { createElectionFixture } from './fixture';

interface Bus {
    initialized: boolean;
    roleSwitchChain: Promise<void>;
    startFallbackTransport(): void;
}

suite('Reclaimed leader authority synchronization', () => {
    let fixture: ReturnType<typeof createElectionFixture>;
    const bus = InterInstanceBus as unknown as Bus;
    let originals: {
        fallback: Bus['startFallbackTransport'];
        start: typeof LeaderFilePublisher.prototype.start;
        stop: typeof LeaderFilePublisher.prototype.stop;
    };
    setup(async () => {
        assert.equal(bus.initialized, false);
        fixture = createElectionFixture();
        originals = {
            fallback: bus.startFallbackTransport,
            start: LeaderFilePublisher.prototype.start,
            stop: LeaderFilePublisher.prototype.stop
        };
        bus.startFallbackTransport = () => {};
        LeaderFilePublisher.prototype.start = async () => {};
        LeaderFilePublisher.prototype.stop = async () => {};
        await fixture.seed();
        InterInstanceBus.initialize(fixture.context);
        await bus.roleSwitchChain;
        assert.equal(InterInstanceBus.getAuthorityTerm(), 'continuation-local:100000');
        assert.equal(InterInstanceBus.hasActiveTransport(), true);
    });
    teardown(async () => {
        try {
            await InterInstanceBus.dispose();
        } finally {
            Object.assign(LeaderFilePublisher.prototype, { start: originals.start, stop: originals.stop });
            bus.startFallbackTransport = originals.fallback;
            await fixture.dispose();
        }
    });

    for (const reclaim of [false, true]) {
        test(`${reclaim ? 'reclaimed' : 'unchanged'} identity has authority immediately without another heartbeat`, async () => {
            const authorities: Array<string | undefined> = [];
            fixture.context.subscriptions.push(
                InterInstanceBus.onAuthorityChanged(term => {
                    authorities.push(term);
                })
            );
            if (reclaim) {
                await fixture.write({ instanceId: 'older-competitor', electedAt: 99_000, lastHeartbeat: 100_000 });
            }
            await fixture.election.checkLeader();
            assert.equal(LeaderElectionService.getOwnedAuthorityTerm(), 'continuation-local:100000');
            assert.equal(InterInstanceBus.hasActiveTransport(), true);
            assert.equal(InterInstanceBus.getAuthorityTerm(), 'continuation-local:100000');
            assert.deepEqual(fixture.roles, []);
            assert.deepEqual(authorities, reclaim ? [undefined, 'continuation-local:100000'] : []);
            await fixture.election.checkLeader();
            const notifications = fixture.identities.length;
            assert.deepEqual(fixture.identities.at(-1), {
                term: 'continuation-local:100000',
                ownedTerm: 'continuation-local:100000',
                leader: true
            });
            await fixture.election.checkLeader();
            assert.equal(
                fixture.identities.length,
                notifications,
                'unchanged identity emitted a duplicate notification'
            );
        });
    }

    test('a superseded reclaim completion does not restore the old bus authority', async () => {
        await fixture.election.checkLeader();
        await fixture.write({ instanceId: 'older-competitor', electedAt: 99_000, lastHeartbeat: 100_000 });
        const waiting = fixture.holdNextWrite();
        const pending = fixture.election.checkLeader();
        try {
            await waiting.entered.promise;
            const successor = { instanceId: 'newer-successor', electedAt: 100_001, lastHeartbeat: 100_000 };
            await fixture.write(successor);
            await fixture.election.checkLeader();
            fixture.assertFollower();
            const notifications = fixture.identities.length;
            waiting.gate.resolve();
            await pending;
            assert.equal(fixture.identities.length, notifications);
            assert.deepEqual(fixture.read(), successor);
            assert.notEqual(InterInstanceBus.getAuthorityTerm(), 'continuation-local:100000');
            fixture.assertFollower();
        } finally {
            waiting.gate.resolve();
            await pending;
        }
    });
});
