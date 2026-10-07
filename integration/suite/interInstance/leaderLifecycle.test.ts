import assert from 'node:assert/strict';
import * as vscode from 'vscode';
import { InterInstanceBus } from '../../../src/interInstance/interInstanceBus';
import { IpcServer } from '../../../src/interInstance/ipcServer';
import { LeaderFilePublisher } from '../../../src/interInstance/leaderFile';
import { LeaderElectionService } from '../../../src/status/leaderElectionService';
import { UserActivityService } from '../../../src/status/userActivityService';
import { createContext } from '../balance/retryFixture';

interface LeaderRecord {
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
    electionPausedUntil: number;
    lastLeaderIdentityKey: string | undefined;
    periodicTasks: Array<() => Promise<void>>;
    startTimer: NodeJS.Timeout | undefined;
    heartbeatTimer: NodeJS.Timeout | undefined;
    taskTimer: NodeJS.Timeout | undefined;
    rateLimitSnapshotProvider: Parameters<typeof LeaderElectionService.setRateLimitSnapshotProvider>[0];
}

interface ElectionInternals extends ElectionState {
    checkLeader(): Promise<void>;
    becomeLeader(force?: boolean): Promise<void>;
    takeoverAsNominated(): Promise<void>;
    waitForNominatedTakeover(nextLeaderId: string, resigningLeaderId: string): Promise<void>;
    recoverAfterLeaderResigning(resigningLeaderId: string): Promise<void>;
}

interface BusInternals {
    initialized: boolean;
    roleSwitchChain: Promise<void>;
    startFallbackTransport(): void;
}

function deferred() {
    let resolve!: () => void;
    const promise = new Promise<void>(done => {
        resolve = done;
    });
    return { promise, resolve };
}

suite('Leader lifecycle recovery', () => {
    const election = LeaderElectionService as unknown as ElectionInternals;
    const bus = InterInstanceBus as unknown as BusInternals;
    const originalNow = Date.now;
    const originalSetTimeout = globalThis.setTimeout;
    const originalStopActivity = UserActivityService.stop;
    const originalInitializeActivity = UserActivityService.initialize;
    const originalStartFallback = bus.startFallbackTransport;
    const originalServerStart = IpcServer.prototype.start;
    const originalServerStop = IpcServer.prototype.stop;
    const serverConnections = IpcServer.prototype as unknown as { disconnectClients?: () => void };
    const originalDisconnectClients = serverConnections.disconnectClients;
    const originalPublisherStart = LeaderFilePublisher.prototype.start;
    const originalPublisherStop = LeaderFilePublisher.prototype.stop;
    const key = 'gcmp.leader.info.v2';
    let previous: ElectionState;
    let context: vscode.ExtensionContext;
    let now: number;
    let written: ReturnType<typeof deferred>;
    let serverEntered: ReturnType<typeof deferred>;
    let serverGate: ReturnType<typeof deferred>;
    let stopEntered: ReturnType<typeof deferred>;
    let stopGate: ReturnType<typeof deferred>;
    let serverStarts: number;
    let serverStops: number;
    let activeServers: number;
    let publishedTerms: string[];
    let stoppedTerms: string[];
    let disconnectedTerms: Array<string | undefined>;
    let busStarted: boolean;
    let retry: (() => void) | undefined;
    let retryTimer: NodeJS.Timeout | undefined;
    let roles: Array<{ initialized: boolean; leader: boolean; term: string | undefined }>;

    setup(() => {
        assert.equal(bus.initialized, false);
        previous = {
            context: election.context,
            instanceId: election.instanceId,
            initialized: election.initialized,
            agentsWindow: election.agentsWindow,
            _isLeader: election._isLeader,
            ownElectedAt: election.ownElectedAt,
            electionPausedUntil: election.electionPausedUntil,
            lastLeaderIdentityKey: election.lastLeaderIdentityKey,
            periodicTasks: election.periodicTasks,
            startTimer: election.startTimer,
            heartbeatTimer: election.heartbeatTimer,
            taskTimer: election.taskTimer,
            rateLimitSnapshotProvider: election.rateLimitSnapshotProvider
        };
        context = createContext();
        now = 100_000;
        written = deferred();
        serverEntered = deferred();
        serverGate = deferred();
        stopEntered = deferred();
        stopGate = deferred();
        stopGate.resolve();
        serverStarts = 0;
        serverStops = 0;
        activeServers = 0;
        publishedTerms = [];
        stoppedTerms = [];
        disconnectedTerms = [];
        busStarted = false;
        retry = undefined;
        retryTimer = undefined;
        roles = [];
        Date.now = () => now;
        globalThis.setTimeout = ((...args: Parameters<typeof setTimeout>) => {
            if (args[1] === 2000) {
                retry = () => {
                    clearTimeout(retryTimer);
                    args[0](undefined);
                };
                retryTimer = originalSetTimeout(() => {}, 60_000);
                return retryTimer;
            }
            return originalSetTimeout(...args);
        }) as typeof setTimeout;
        UserActivityService.stop = () => {};
        UserActivityService.initialize = () => {};
        Object.assign(election, {
            context,
            instanceId: 'lifecycle-local',
            initialized: true,
            agentsWindow: false,
            _isLeader: false,
            ownElectedAt: 0,
            electionPausedUntil: 0,
            lastLeaderIdentityKey: undefined,
            periodicTasks: [],
            startTimer: undefined,
            heartbeatTimer: undefined,
            taskTimer: undefined,
            rateLimitSnapshotProvider: undefined
        });
        const originalUpdate = context.globalState.update;
        context.globalState.update = async (entry: string, value: unknown) => {
            await originalUpdate.call(context.globalState, entry, value);
            if (entry === key) {
                written.resolve();
            }
        };
        bus.startFallbackTransport = () => {};
        IpcServer.prototype.start = async () => {
            serverStarts++;
            serverEntered.resolve();
            await serverGate.promise;
            activeServers++;
        };
        IpcServer.prototype.stop = async () => {
            serverStops++;
            stopEntered.resolve();
            await stopGate.promise;
            activeServers = Math.max(0, activeServers - 1);
        };
        LeaderFilePublisher.prototype.start = async function () {
            publishedTerms.push((this as unknown as { authorityTerm: string }).authorityTerm);
        };
        serverConnections.disconnectClients = () => {
            assert.equal(publishedTerms.at(-1), LeaderElectionService.getOwnedAuthorityTerm());
            disconnectedTerms.push(publishedTerms.at(-1));
        };
        LeaderFilePublisher.prototype.stop = async function () {
            stoppedTerms.push((this as unknown as { authorityTerm: string }).authorityTerm);
        };
        context.subscriptions.push(
            LeaderElectionService.onLeaderChanged(leader => {
                roles.push({
                    initialized: LeaderElectionService.isInitialized(),
                    leader,
                    term: LeaderElectionService.getOwnedAuthorityTerm()
                });
            })
        );
    });

    teardown(async () => {
        serverGate.resolve();
        stopGate.resolve();
        if (busStarted) {
            await InterInstanceBus.dispose();
        }
        clearTimeout(retryTimer);
        for (const disposable of context.subscriptions) {
            disposable.dispose();
        }
        for (const timer of [election.startTimer, election.heartbeatTimer, election.taskTimer]) {
            if (timer) {
                clearTimeout(timer);
            }
        }
        Object.assign(election, previous);
        Date.now = originalNow;
        globalThis.setTimeout = originalSetTimeout;
        UserActivityService.stop = originalStopActivity;
        UserActivityService.initialize = originalInitializeActivity;
        bus.startFallbackTransport = originalStartFallback;
        IpcServer.prototype.start = originalServerStart;
        IpcServer.prototype.stop = originalServerStop;
        if (originalDisconnectClients) {
            serverConnections.disconnectClients = originalDisconnectClients;
        } else {
            delete serverConnections.disconnectClients;
        }
        LeaderFilePublisher.prototype.start = originalPublisherStart;
        LeaderFilePublisher.prototype.stop = originalPublisherStop;
    });

    async function checkHeartbeats(): Promise<void> {
        for (let index = 0; index < 3; index++) {
            now += 5000;
            await election.checkLeader();
            await bus.roleSwitchChain;
        }
    }

    function restart(nextContext: vscode.ExtensionContext): void {
        LeaderElectionService.initialize(nextContext);
        clearTimeout(election.startTimer);
        election.startTimer = undefined;
    }

    async function changeOwnedIdentity(): Promise<string> {
        now += 1000;
        election.ownElectedAt = now;
        await context.globalState.update(key, {
            instanceId: election.instanceId,
            electedAt: now,
            lastHeartbeat: now
        });
        await election.checkLeader();
        return `${election.instanceId}:${now}`;
    }

    test('stable election and repeated identity notifications keep one IPC server', async () => {
        await election.becomeLeader(true);
        InterInstanceBus.initialize(context);
        busStarted = true;
        await serverEntered.promise;
        for (let index = 0; index < 3; index++) {
            election.lastLeaderIdentityKey = undefined;
            await election.checkLeader();
        }
        serverGate.resolve();
        await bus.roleSwitchChain;
        await checkHeartbeats();
        assert.equal(LeaderElectionService.getOwnedAuthorityTerm(), 'lifecycle-local:100000');
        assert.equal(serverStarts, 1);
        assert.equal(serverStops, 0);
        assert.equal(activeServers, 1);
        assert.equal(InterInstanceBus.hasActiveTransport(), true);
        assert.deepEqual(publishedTerms, ['lifecycle-local:100000']);
        assert.deepEqual(stoppedTerms, []);
        assert.deepEqual(disconnectedTerms, []);
    });

    test('a settled same-instance term change reconnects followers without replacing IPC', async () => {
        serverGate.resolve();
        await election.becomeLeader(true);
        InterInstanceBus.initialize(context);
        busStarted = true;
        await bus.roleSwitchChain;
        const term = await changeOwnedIdentity();
        await bus.roleSwitchChain;
        await checkHeartbeats();
        assert.deepEqual(disconnectedTerms, [term]);
        assert.equal(serverStarts, 1);
        assert.equal(serverStops, 0);
        assert.equal(activeServers, 1);
    });

    for (const changes of [1, 2]) {
        test(`discovery follows ${changes} re-elections during publication without replacing IPC`, async () => {
            const gates = Array.from({ length: changes + 1 }, () => deferred());
            const entered = Array.from({ length: changes + 1 }, () => deferred());
            const publish = LeaderFilePublisher.prototype.start;
            LeaderFilePublisher.prototype.start = async function () {
                const index = publishedTerms.length;
                entered[index].resolve();
                await gates[index].promise;
                await publish.call(this);
            };
            serverGate.resolve();
            await election.becomeLeader(true);
            InterInstanceBus.initialize(context);
            busStarted = true;
            const expectedTerms = ['lifecycle-local:100000'];
            try {
                await entered[0].promise;
                assert.deepEqual(disconnectedTerms, []);
                for (let index = 0; index < changes; index++) {
                    const electedAt = now + 1;
                    now += 20_000;
                    await context.globalState.update(key, {
                        instanceId: 'expired-newer-contender',
                        electedAt,
                        lastHeartbeat: electedAt
                    });
                    await election.checkLeader();
                    expectedTerms.push(`lifecycle-local:${now}`);
                    assert.deepEqual(disconnectedTerms, []);
                    gates[index].resolve();
                    if (index + 1 < changes) {
                        await Promise.race([
                            entered[index + 1].promise,
                            bus.roleSwitchChain.then(() => assert.fail('Discovery replacement was skipped'))
                        ]);
                    }
                }
                gates[changes].resolve();
                await bus.roleSwitchChain;
                await checkHeartbeats();
                assert.deepEqual(publishedTerms, expectedTerms);
                assert.deepEqual(stoppedTerms, expectedTerms.slice(0, -1));
                assert.equal(InterInstanceBus.getAuthorityTerm(), expectedTerms.at(-1));
                assert.equal(LeaderElectionService.getOwnedAuthorityTerm(), expectedTerms.at(-1));
                assert.equal(serverStarts, 1);
                assert.equal(serverStops, 0);
                assert.equal(activeServers, 1);
                assert.deepEqual(disconnectedTerms, [expectedTerms.at(-1)]);
            } finally {
                for (const gate of gates) {
                    gate.resolve();
                }
                await bus.roleSwitchChain;
            }
        });
    }

    for (const outcome of ['newer-term', 'dispose'] as const) {
        test(`retiring discovery observes ${outcome} before starting another publisher`, async () => {
            const entered = deferred();
            const gate = deferred();
            const stop = LeaderFilePublisher.prototype.stop;
            LeaderFilePublisher.prototype.stop = async function () {
                entered.resolve();
                await gate.promise;
                await stop.call(this);
            };
            serverGate.resolve();
            await election.becomeLeader(true);
            InterInstanceBus.initialize(context);
            busStarted = true;
            await bus.roleSwitchChain;
            let disposing: Promise<void> | undefined;
            try {
                await changeOwnedIdentity();
                await Promise.race([
                    entered.promise,
                    bus.roleSwitchChain.then(() => assert.fail('Existing server skipped discovery refresh'))
                ]);
                let expectedTerm: string | undefined;
                if (outcome === 'newer-term') {
                    expectedTerm = await changeOwnedIdentity();
                } else {
                    disposing = InterInstanceBus.dispose();
                }
                gate.resolve();
                await bus.roleSwitchChain;
                await disposing;
                assert.deepEqual(
                    publishedTerms,
                    expectedTerm ? ['lifecycle-local:100000', expectedTerm] : ['lifecycle-local:100000']
                );
                assert.deepEqual(stoppedTerms, ['lifecycle-local:100000']);
                assert.equal(serverStarts, 1);
                assert.equal(activeServers, outcome === 'newer-term' ? 1 : 0);
                assert.deepEqual(disconnectedTerms, expectedTerm ? [expectedTerm] : []);
            } finally {
                gate.resolve();
                await bus.roleSwitchChain;
                await disposing;
            }
        });
    }

    test('ownership lost during discovery publication closes IPC and retains recovery', async () => {
        const entered = deferred();
        const gate = deferred();
        const publish = LeaderFilePublisher.prototype.start;
        LeaderFilePublisher.prototype.start = async function () {
            entered.resolve();
            await gate.promise;
            await publish.call(this);
        };
        serverGate.resolve();
        await election.becomeLeader(true);
        const self = context.globalState.get<LeaderRecord>(key)!;
        InterInstanceBus.initialize(context);
        busStarted = true;
        try {
            await entered.promise;
            await context.globalState.update(key, {
                instanceId: 'older-contender',
                electedAt: now - 1,
                lastHeartbeat: now
            });
            gate.resolve();
            await bus.roleSwitchChain;
            assert.equal(activeServers, 0);
            assert.deepEqual(stoppedTerms, ['lifecycle-local:100000']);
            assert.equal(InterInstanceBus.getAuthorityTerm(), undefined);
            assert.deepEqual(disconnectedTerms, []);
            assert.ok(retry);
            await context.globalState.update(key, self);
            retry();
            await bus.roleSwitchChain;
            assert.equal(serverStarts, 2);
            assert.equal(activeServers, 1);
            assert.equal(InterInstanceBus.getAuthorityTerm(), 'lifecycle-local:100000');
        } finally {
            gate.resolve();
            await bus.roleSwitchChain;
        }
    });

    test('disposing during publication cannot leave a publisher or server active', async () => {
        const entered = deferred();
        const gate = deferred();
        const publish = LeaderFilePublisher.prototype.start;
        LeaderFilePublisher.prototype.start = async function () {
            entered.resolve();
            await gate.promise;
            await publish.call(this);
        };
        serverGate.resolve();
        await election.becomeLeader(true);
        InterInstanceBus.initialize(context);
        busStarted = true;
        let disposing: Promise<void> | undefined;
        try {
            await entered.promise;
            disposing = InterInstanceBus.dispose();
            gate.resolve();
            await disposing;
            retry?.();
            await bus.roleSwitchChain;
            assert.deepEqual(publishedTerms, ['lifecycle-local:100000']);
            assert.deepEqual(stoppedTerms, ['lifecycle-local:100000']);
            assert.equal(serverStarts, 1);
            assert.equal(activeServers, 0);
        } finally {
            gate.resolve();
            await bus.roleSwitchChain;
            await disposing;
        }
        assert.deepEqual(disconnectedTerms, []);
    });

    test('failed discovery replacement closes the reused server and retries the current term', async () => {
        const publish = LeaderFilePublisher.prototype.start;
        let attempts = 0;
        LeaderFilePublisher.prototype.start = async function () {
            if (++attempts === 2) {
                throw new Error('replacement publication failed');
            }
            await publish.call(this);
        };
        serverGate.resolve();
        await election.becomeLeader(true);
        InterInstanceBus.initialize(context);
        busStarted = true;
        await bus.roleSwitchChain;
        const term = await changeOwnedIdentity();
        await bus.roleSwitchChain;
        assert.equal(serverStops, 1);
        assert.equal(activeServers, 0);
        assert.deepEqual(stoppedTerms, ['lifecycle-local:100000', term]);
        assert.ok(retry);
        retry();
        await bus.roleSwitchChain;
        assert.equal(serverStarts, 2);
        assert.equal(activeServers, 1);
        assert.deepEqual(publishedTerms, ['lifecycle-local:100000', term]);
        assert.equal(InterInstanceBus.getAuthorityTerm(), term);
        assert.deepEqual(disconnectedTerms, []);
    });

    for (const timing of ['after-stop', 'during-stop'] as const) {
        test(`IPC recovers when ownership is reclaimed ${timing}`, async () => {
            await election.becomeLeader(true);
            InterInstanceBus.initialize(context);
            busStarted = true;
            await serverEntered.promise;
            await context.globalState.update(key, {
                instanceId: 'older-contender',
                electedAt: now - 1,
                lastHeartbeat: now
            });
            if (timing === 'during-stop') {
                stopGate = deferred();
            }
            serverGate.resolve();
            await stopEntered.promise;
            try {
                if (timing === 'during-stop') {
                    await election.checkLeader();
                    await election.checkLeader();
                }
            } finally {
                stopGate.resolve();
            }
            await bus.roleSwitchChain;
            await checkHeartbeats();
            assert.equal(LeaderElectionService.getOwnedAuthorityTerm(), 'lifecycle-local:100000');
            assert.equal(InterInstanceBus.getAuthorityTerm(), 'lifecycle-local:100000');
            assert.equal(InterInstanceBus.hasActiveTransport(), true);
            assert.equal(serverStarts, 2);
            assert.equal(serverStops, 1);
            assert.equal(activeServers, 1);
        });
    }

    test('missing IPC retries even when the transient identity was never observed by a heartbeat', async () => {
        await election.becomeLeader(true);
        const self = context.globalState.get<LeaderRecord>(key)!;
        InterInstanceBus.initialize(context);
        busStarted = true;
        await serverEntered.promise;
        await context.globalState.update(key, {
            instanceId: 'older-contender',
            electedAt: now - 1,
            lastHeartbeat: now
        });
        serverGate.resolve();
        await bus.roleSwitchChain;
        await context.globalState.update(key, self);
        await checkHeartbeats();
        assert.ok(retry, 'Missing IPC must retain a bounded retry even without an identity notification');
        retry();
        await bus.roleSwitchChain;
        assert.equal(InterInstanceBus.hasActiveTransport(), true);
        assert.equal(serverStarts, 2);
        assert.equal(activeServers, 1);
    });

    test('a failed discovery publication closes its server before retrying', async () => {
        let publications = 0;
        LeaderFilePublisher.prototype.start = async () => {
            if (++publications === 1) {
                throw new Error('discovery write failed');
            }
        };
        serverGate.resolve();
        await election.becomeLeader(true);
        InterInstanceBus.initialize(context);
        busStarted = true;
        await bus.roleSwitchChain;
        assert.equal(serverStarts, 1);
        assert.equal(serverStops, 1);
        assert.equal(activeServers, 0);
        assert.ok(retry);
        retry();
        await bus.roleSwitchChain;
        assert.equal(serverStarts, 2);
        assert.equal(activeServers, 1);
        assert.equal(InterInstanceBus.hasActiveTransport(), true);
    });

    test('disposing the bus invalidates queued recovery and its retry timer', async () => {
        await election.becomeLeader(true);
        InterInstanceBus.initialize(context);
        busStarted = true;
        await serverEntered.promise;
        await context.globalState.update(key, {
            instanceId: 'older-contender',
            electedAt: now - 1,
            lastHeartbeat: now
        });
        serverGate.resolve();
        await bus.roleSwitchChain;
        await election.checkLeader();
        const checking = election.checkLeader();
        const disposing = InterInstanceBus.dispose();
        await Promise.all([checking, disposing]);
        retry?.();
        await bus.roleSwitchChain;
        assert.equal(serverStarts, 1);
        assert.equal(activeServers, 0);
        assert.equal(InterInstanceBus.hasActiveTransport(), false);
    });

    test('IPC-disabled hosts do not start a server on identity changes', async () => {
        await election.becomeLeader(true);
        InterInstanceBus.initialize(context, { enabled: false });
        busStarted = true;
        election.lastLeaderIdentityKey = undefined;
        await checkHeartbeats();
        assert.equal(serverStarts, 0);
        assert.equal(retry, undefined);
    });

    test('stopping a settled leader clears authority', async () => {
        await election.becomeLeader(true);
        await LeaderElectionService.stop();
        assert.equal(LeaderElectionService.isInitialized(), false);
        assert.equal(LeaderElectionService.isLeader(), false);
        assert.equal(context.globalState.get(key), undefined);
        assert.equal(LeaderElectionService.getOwnedAuthorityTerm(), undefined);
    });

    for (const replacement of ['none', 'successor'] as const) {
        test(`stopping an unconfirmed candidate preserves only the ${replacement} record`, async () => {
            const pending = election.becomeLeader(true);
            const successor = { instanceId: 'successor', electedAt: now + 1, lastHeartbeat: now + 1 };
            try {
                await written.promise;
                if (replacement === 'successor') {
                    await context.globalState.update(key, successor);
                }
                await LeaderElectionService.stop();
                assert.equal(LeaderElectionService.isInitialized(), false);
                assert.equal(LeaderElectionService.isLeader(), false);
                await pending;
                assert.equal(LeaderElectionService.isLeader(), false);
                assert.equal(LeaderElectionService.getOwnedAuthorityTerm(), undefined);
                assert.deepEqual(context.globalState.get(key), replacement === 'successor' ? successor : undefined);
                assert.deepEqual(roles, []);
            } finally {
                await pending;
            }
        });
    }

    test('a heartbeat awaiting persistence cannot promote a stopped service', async () => {
        await election.becomeLeader(true);
        const entered = deferred();
        const gate = deferred();
        const originalUpdate = context.globalState.update;
        context.globalState.update = async (entry: string, value: unknown) => {
            await originalUpdate.call(context.globalState, entry, value);
            if (entry === key && value !== undefined) {
                entered.resolve();
                await gate.promise;
            }
        };
        const pending = election.checkLeader();
        try {
            await entered.promise;
            await LeaderElectionService.stop();
            gate.resolve();
            await pending;
            assert.equal(LeaderElectionService.isInitialized(), false);
            assert.equal(LeaderElectionService.isLeader(), false);
            assert.equal(context.globalState.get(key), undefined);
            assert.deepEqual(
                roles.map(event => event.leader),
                [true, false]
            );
        } finally {
            gate.resolve();
            await pending;
        }
    });

    test('shutdown blocks new elections while retaining authority for snapshot handoff', async () => {
        await election.becomeLeader(true);
        const entered = deferred();
        const gate = deferred();
        const term = LeaderElectionService.getOwnedAuthorityTerm();
        LeaderElectionService.setRateLimitSnapshotProvider(async () => {
            entered.resolve();
            await gate.promise;
            assert.equal(LeaderElectionService.getOwnedAuthorityTerm(), term);
            return undefined;
        });
        const stopping = LeaderElectionService.stop();
        try {
            await entered.promise;
            now += 1;
            await election.becomeLeader(true);
            await election.checkLeader();
            assert.equal(LeaderElectionService.getOwnedAuthorityTerm(), term);
            assert.equal(context.globalState.get<LeaderRecord>(key)?.electedAt, 100_000);
        } finally {
            gate.resolve();
            await stopping;
        }
        assert.equal(LeaderElectionService.isLeader(), false);
        assert.equal(context.globalState.get(key), undefined);
    });

    for (const operation of ['election', 'nominated', 'recovery'] as const) {
        test(`a pending ${operation} cannot act on a restarted lifecycle`, async () => {
            const gate = deferred();
            const entered = deferred();
            const originalUpdate = context.globalState.update;
            context.globalState.update = async (entry: string, value: unknown) => {
                await originalUpdate.call(context.globalState, entry, value);
                if (entry === key && value !== undefined) {
                    entered.resolve();
                    await gate.promise;
                }
            };
            const pending =
                operation === 'election' ? election.becomeLeader(true)
                : operation === 'nominated' ? election.takeoverAsNominated()
                : election.recoverAfterLeaderResigning('departing');
            const nextContext = createContext();
            try {
                await entered.promise;
                await LeaderElectionService.stop();
                restart(nextContext);
                gate.resolve();
                await pending;
                assert.equal(LeaderElectionService.isLeader(), false);
                assert.equal(nextContext.globalState.get(key), undefined);
                assert.deepEqual(roles, []);
            } finally {
                gate.resolve();
                await pending;
            }
        });
    }

    test('waiting for a nominated successor does not survive stop and restart', async () => {
        const departing = { instanceId: 'departing', electedAt: now - 1, lastHeartbeat: now };
        await context.globalState.update(key, departing);
        const pending = election.waitForNominatedTakeover('nominee', 'departing');
        const nextContext = createContext();
        try {
            await LeaderElectionService.stop();
            await nextContext.globalState.update(key, departing);
            restart(nextContext);
            await pending;
            assert.equal(LeaderElectionService.isLeader(), false);
            assert.deepEqual(nextContext.globalState.get(key), departing);
        } finally {
            await pending;
        }
    });

    test('a pause introduced during candidate confirmation prevents promotion', async () => {
        const pending = election.becomeLeader(true);
        try {
            await written.promise;
            election.electionPausedUntil = Number.POSITIVE_INFINITY;
            await pending;
            assert.equal(LeaderElectionService.isLeader(), false);
            assert.equal(LeaderElectionService.getOwnedAuthorityTerm(), undefined);
            assert.deepEqual(roles, []);
        } finally {
            await pending;
        }
    });
});
