import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Socket } from 'node:net';
import * as vscode from 'vscode';
import { InterInstanceBus } from '../../../src/interInstance';
import { registerInterInstanceHandlers } from '../../../src/interInstance/activation';
import { IpcServer } from '../../../src/interInstance/ipcServer';
import type {
    ApiKeyBalanceLeaseHandoff,
    InterInstanceEvent,
    LeaderResigningEvent
} from '../../../src/interInstance/eventProtocol';
import {
    clearRemoteLiveMetrics,
    getActiveMetricsSnapshot,
    onLiveMetrics,
    receiveRemoteLiveMetrics,
    setCrossInstanceBroadcaster
} from '../../../src/handlers/liveMetrics';
import type { RateLimitStoreSnapshot } from '../../../src/rateLimit/rateLimitStore';
import { LeaderElectionService } from '../../../src/status/leaderElectionService';
import { UserActivityService } from '../../../src/status/userActivityService';

type ResignationResult = 'resigned' | 'not-leader' | 'no-follower';
type ResignationEvent = Omit<LeaderResigningEvent, 'timestamp' | 'senderInstanceId'>;

interface LeaderRecord {
    instanceId: string;
    lastHeartbeat: number;
    electedAt: number;
}

interface ElectionInternals {
    context: vscode.ExtensionContext | undefined;
    instanceId: string;
    initialized: boolean;
    agentsWindow: boolean;
    _isLeader: boolean;
    ownElectedAt: number;
    electionPausedUntil: number;
    resignationPromise: Promise<ResignationResult> | undefined;
    lastLeaderIdentityKey: string | undefined;
    periodicTasks: Array<() => Promise<void>>;
    startTimer: NodeJS.Timeout | undefined;
    heartbeatTimer: NodeJS.Timeout | undefined;
    taskTimer: NodeJS.Timeout | undefined;
    rateLimitSnapshotProvider: Parameters<typeof LeaderElectionService.setRateLimitSnapshotProvider>[0];
    rateLimitSnapshotValidator: ((snapshot: RateLimitStoreSnapshot | undefined) => boolean) | undefined;
    balanceLeaseSnapshotProvider: Parameters<typeof LeaderElectionService.setBalanceLeaseSnapshotProvider>[0];
    balanceLeaseSnapshotValidator: ((snapshot: ApiKeyBalanceLeaseHandoff | undefined) => boolean) | undefined;
    resignLeadership: () => Promise<ResignationResult>;
    registerCommands: (context: vscode.ExtensionContext) => void;
    checkLeader: () => Promise<void>;
    becomeLeader: (force?: boolean) => Promise<void>;
    updateHeartbeat: () => Promise<void>;
    setLeaderState: (value: boolean) => void;
    executePeriodicTasks: () => Promise<void>;
}

function deferred(): { promise: Promise<void>; resolve: () => void } {
    let resolve!: () => void;
    const promise = new Promise<void>(done => {
        resolve = done;
    });
    return { promise, resolve };
}

suite('Manual leader resignation', () => {
    const election = LeaderElectionService as unknown as ElectionInternals;
    const originalNow = Date.now;
    const originalFollowers = InterInstanceBus.getConnectedFollowerIds;
    const originalEligibleFollowers = InterInstanceBus.getEligibleFollowerIds;
    const originalPublish = InterInstanceBus.publishIpcOnly;
    const originalStopActivity = UserActivityService.stop;
    const originalIsUserActive = UserActivityService.isUserActive;
    const originalRegisterCommand = vscode.commands.registerCommand;
    const originalInfo = vscode.window.showInformationMessage;
    const originalWarning = vscode.window.showWarningMessage;
    const originalError = vscode.window.showErrorMessage;
    let previous: Pick<
        ElectionInternals,
        | 'context'
        | 'instanceId'
        | 'initialized'
        | 'agentsWindow'
        | '_isLeader'
        | 'ownElectedAt'
        | 'electionPausedUntil'
        | 'resignationPromise'
        | 'lastLeaderIdentityKey'
        | 'periodicTasks'
        | 'startTimer'
        | 'heartbeatTimer'
        | 'taskTimer'
        | 'rateLimitSnapshotProvider'
        | 'rateLimitSnapshotValidator'
        | 'balanceLeaseSnapshotProvider'
        | 'balanceLeaseSnapshotValidator'
    >;
    let context: vscode.ExtensionContext;
    let now: number;
    let record: LeaderRecord | undefined;
    let followers: string[];
    let eligibleFollowers: string[] | undefined;
    let events: Array<Parameters<typeof InterInstanceBus.publishIpcOnly>[0]>;
    let updates: Array<LeaderRecord | undefined>;
    let messages: Array<{ kind: string; text: string }>;
    let command: (() => Promise<void>) | undefined;
    let registeredId: string | undefined;
    let activityStops: number;
    let snapshotCalls: number;

    setup(() => {
        previous = {
            context: election.context,
            instanceId: election.instanceId,
            initialized: election.initialized,
            agentsWindow: election.agentsWindow,
            _isLeader: election._isLeader,
            ownElectedAt: election.ownElectedAt,
            electionPausedUntil: election.electionPausedUntil,
            resignationPromise: election.resignationPromise,
            lastLeaderIdentityKey: election.lastLeaderIdentityKey,
            periodicTasks: election.periodicTasks,
            startTimer: election.startTimer,
            heartbeatTimer: election.heartbeatTimer,
            taskTimer: election.taskTimer,
            rateLimitSnapshotProvider: election.rateLimitSnapshotProvider,
            rateLimitSnapshotValidator: election.rateLimitSnapshotValidator,
            balanceLeaseSnapshotProvider: election.balanceLeaseSnapshotProvider,
            balanceLeaseSnapshotValidator: election.balanceLeaseSnapshotValidator
        };
        now = 100_000;
        record = { instanceId: 'leader-old', lastHeartbeat: now, electedAt: now };
        followers = ['follower-first', 'follower-second'];
        eligibleFollowers = undefined;
        events = [];
        updates = [];
        messages = [];
        command = undefined;
        registeredId = undefined;
        activityStops = 0;
        snapshotCalls = 0;
        context = {
            subscriptions: [],
            globalState: {
                get: <T>(key: string): T => {
                    assert.equal(key, 'gcmp.leader.info.v2');
                    return record as T;
                },
                update: async (key: string, value: unknown): Promise<void> => {
                    assert.equal(key, 'gcmp.leader.info.v2');
                    record = value as LeaderRecord | undefined;
                    updates.push(record);
                }
            }
        } as unknown as vscode.ExtensionContext;
        Object.assign(election, {
            context,
            instanceId: 'leader-old',
            initialized: true,
            agentsWindow: false,
            _isLeader: true,
            ownElectedAt: now,
            electionPausedUntil: 0,
            resignationPromise: undefined,
            lastLeaderIdentityKey: undefined,
            periodicTasks: [],
            startTimer: undefined,
            heartbeatTimer: undefined,
            taskTimer: undefined
        });
        Date.now = () => now;
        InterInstanceBus.getConnectedFollowerIds = () => followers;
        InterInstanceBus.getEligibleFollowerIds = () => eligibleFollowers ?? followers;
        InterInstanceBus.publishIpcOnly = event => {
            events.push(event);
            return true;
        };
        UserActivityService.stop = () => {
            activityStops += 1;
        };
        UserActivityService.isUserActive = () => true;
        LeaderElectionService.setRateLimitSnapshotProvider(() => {
            snapshotCalls += 1;
            return undefined;
        });
        LeaderElectionService.setBalanceLeaseSnapshotProvider(() => {
            snapshotCalls += 1;
            return undefined;
        });
        vscode.commands.registerCommand = (id, callback) => {
            registeredId = id;
            command = callback as () => Promise<void>;
            return new vscode.Disposable(() => {});
        };
        vscode.window.showInformationMessage = (async (text: string) => {
            messages.push({ kind: 'info', text });
            return undefined;
        }) as typeof vscode.window.showInformationMessage;
        vscode.window.showWarningMessage = (async (text: string) => {
            messages.push({ kind: 'warning', text });
            return undefined;
        }) as typeof vscode.window.showWarningMessage;
        vscode.window.showErrorMessage = (async (text: string) => {
            messages.push({ kind: 'error', text });
            return undefined;
        }) as typeof vscode.window.showErrorMessage;
    });

    teardown(() => {
        for (const disposable of context.subscriptions) {
            disposable.dispose();
        }
        if (election.heartbeatTimer && election.heartbeatTimer !== previous.heartbeatTimer) {
            clearInterval(election.heartbeatTimer);
        }
        if (election.taskTimer && election.taskTimer !== previous.taskTimer) {
            clearInterval(election.taskTimer);
        }
        Object.assign(election, previous);
        Date.now = originalNow;
        InterInstanceBus.getConnectedFollowerIds = originalFollowers;
        InterInstanceBus.getEligibleFollowerIds = originalEligibleFollowers;
        InterInstanceBus.publishIpcOnly = originalPublish;
        UserActivityService.stop = originalStopActivity;
        UserActivityService.isUserActive = originalIsUserActive;
        vscode.commands.registerCommand = originalRegisterCommand;
        vscode.window.showInformationMessage = originalInfo;
        vscode.window.showWarningMessage = originalWarning;
        vscode.window.showErrorMessage = originalError;
    });

    test('followers cannot resign the current leader', async () => {
        election._isLeader = false;
        record!.instanceId = 'leader-other';
        assert.equal(await election.resignLeadership(), 'not-leader');
        assert.equal(record?.instanceId, 'leader-other');
        assert.deepEqual(updates, []);
        assert.deepEqual(events, []);
        assert.equal(snapshotCalls, 0);
        assert.equal(election.electionPausedUntil, 0);
    });

    test('stale local leadership cannot resign another authority', async () => {
        record!.instanceId = 'leader-other';
        assert.equal(await election.resignLeadership(), 'not-leader');
        assert.equal(election.electionPausedUntil, 0);
        assert.deepEqual(events, []);
        assert.equal(snapshotCalls, 0);
    });

    test('no connected follower leaves leadership and snapshots untouched', async () => {
        followers = [];
        assert.equal(await election.resignLeadership(), 'no-follower');
        assert.equal(LeaderElectionService.isLeader(), true);
        assert.equal(record?.instanceId, 'leader-old');
        assert.deepEqual(updates, []);
        assert.deepEqual(events, []);
        assert.equal(snapshotCalls, 0);
        assert.equal(election.electionPausedUntil, 0);
    });

    test('handoff nominates the first follower and preserves the active service', async () => {
        const rateLimitSnapshot: RateLimitStoreSnapshot = { buckets: [], grants: [] };
        const balanceLeaseSnapshot: ApiKeyBalanceLeaseHandoff = {
            sourceAuthorityTerm: 'leader-old:100000',
            capturedAt: now,
            leases: []
        };
        const steps: string[] = [];
        LeaderElectionService.setBalanceLeaseSnapshotProvider(() => {
            steps.push('balance');
            return balanceLeaseSnapshot;
        });
        LeaderElectionService.setRateLimitSnapshotProvider(async () => {
            steps.push('rate-limit');
            return rateLimitSnapshot;
        });
        const tasks = [async () => {}];
        election.periodicTasks = tasks;
        const heartbeatTimer = setInterval(() => {}, 60_000);
        const taskTimer = setInterval(() => {}, 60_000);
        election.heartbeatTimer = heartbeatTimer;
        election.taskTimer = taskTimer;
        const roles: boolean[] = [];
        context.subscriptions.push(LeaderElectionService.onLeaderChanged(value => roles.push(value)));

        assert.equal(await election.resignLeadership(), 'resigned');
        assert.deepEqual(steps, ['balance', 'rate-limit']);
        assert.deepEqual(events, [
            {
                type: 'leaderResigning',
                payload: {
                    leaderId: 'leader-old',
                    reason: 'manual',
                    sourceAuthorityTerm: 'leader-old:100000',
                    nextLeaderId: 'follower-first',
                    rateLimitSnapshot,
                    balanceLeaseSnapshot
                }
            }
        ]);
        assert.deepEqual(updates, [undefined]);
        assert.deepEqual(roles, [false]);
        assert.equal(LeaderElectionService.isInitialized(), true);
        assert.equal(election.periodicTasks, tasks);
        assert.equal(election.heartbeatTimer, heartbeatTimer);
        assert.equal(election.taskTimer, taskTimer);
        assert.equal(activityStops, 0);
    });

    test('handoff does not clear a successor that has already taken over', async () => {
        InterInstanceBus.publishIpcOnly = event => {
            events.push(event);
            record = { instanceId: 'follower-first', electedAt: now + 1, lastHeartbeat: now + 1 };
            return true;
        };
        assert.equal(await election.resignLeadership(), 'resigned');
        assert.equal(record?.instanceId, 'follower-first');
        assert.deepEqual(updates, []);
        assert.equal(LeaderElectionService.isLeader(), false);
    });

    test('elections and heartbeats wait for snapshot persistence and the handoff grace period', async () => {
        const started = deferred();
        const gate = deferred();
        LeaderElectionService.setRateLimitSnapshotProvider(async () => {
            started.resolve();
            await gate.promise;
            return undefined;
        });
        const resignation = election.resignLeadership();
        try {
            await started.promise;
            await election.checkLeader();
            await election.becomeLeader(true);
            await election.updateHeartbeat();
            assert.deepEqual(updates, []);
            assert.deepEqual(events, []);
        } finally {
            gate.resolve();
            await resignation;
        }
        await election.checkLeader();
        await election.becomeLeader(true);
        election.setLeaderState(true);
        assert.equal(LeaderElectionService.isLeader(), false);
        assert.deepEqual(updates, [undefined]);
        now += 5_001;
        await election.checkLeader();
        assert.equal(LeaderElectionService.isLeader(), true);
        assert.equal(record?.instanceId, 'leader-old');
        assert.equal(LeaderElectionService.getOwnedAuthorityTerm(), `leader-old:${now}`);
    });

    test('joint snapshot retries stop at the deadline and allow a later manual retry', async () => {
        LeaderElectionService.setBalanceLeaseSnapshotProvider(
            () => {
                now += 16_000;
                return undefined;
            },
            () => false
        );
        await assert.rejects(election.resignLeadership(), /deadline/);
        assert.equal(LeaderElectionService.getOwnedAuthorityTerm(), 'leader-old:100000');
        assert.equal(election.electionPausedUntil, 0);
        assert.deepEqual(events, []);
        assert.deepEqual(updates, []);
        LeaderElectionService.setBalanceLeaseSnapshotProvider(() => undefined);
        assert.equal(await election.resignLeadership(), 'resigned');
    });

    test('normal follower monitoring resumes after the grace period without taking over a healthy leader', async () => {
        await election.resignLeadership();
        record = { instanceId: 'follower-first', electedAt: now + 1, lastHeartbeat: now + 1 };
        now += 5_001;
        await election.checkLeader();
        assert.equal(LeaderElectionService.isLeader(), false);
        assert.equal(LeaderElectionService.getLeaderId(), 'follower-first');
        assert.deepEqual(updates, [undefined]);
    });

    test('concurrent resignations share one snapshot and one broadcast', async () => {
        const gate = deferred();
        const started = deferred();
        LeaderElectionService.setRateLimitSnapshotProvider(async () => {
            snapshotCalls += 1;
            started.resolve();
            await gate.promise;
            return undefined;
        });
        const first = election.resignLeadership();
        try {
            await started.promise;
            const second = election.resignLeadership();
            gate.resolve();
            assert.deepEqual(await Promise.all([first, second]), ['resigned', 'resigned']);
            assert.equal(snapshotCalls, 2);
            assert.equal(events.length, 1);
            assert.deepEqual(updates, [undefined]);
        } finally {
            gate.resolve();
            await first;
        }
    });

    test('shutdown waits for a pending manual handoff without broadcasting twice', async () => {
        const gate = deferred();
        const started = deferred();
        LeaderElectionService.setRateLimitSnapshotProvider(async () => {
            started.resolve();
            await gate.promise;
            return undefined;
        });
        const resignation = election.resignLeadership();
        try {
            await started.promise;
            const stopping = LeaderElectionService.stop();
            gate.resolve();
            await Promise.all([resignation, stopping]);
            assert.equal(events.length, 1);
            assert.equal(LeaderElectionService.isInitialized(), false);
            assert.deepEqual(election.periodicTasks, []);
            assert.equal(activityStops, 1);
        } finally {
            gate.resolve();
            await resignation;
        }
    });

    test('periodic tasks stop between callbacks when leadership is handed off', async () => {
        const calls: string[] = [];
        election.periodicTasks = [
            async () => {
                calls.push('first');
                await election.resignLeadership();
            },
            async () => {
                calls.push('second');
            }
        ];
        await election.executePeriodicTasks();
        assert.deepEqual(calls, ['first']);
    });

    test('a failed shared-state release does not leave local authority frozen as leader', async () => {
        context.globalState.update = async () => {
            throw new Error('release failed');
        };
        await assert.rejects(election.resignLeadership(), /release failed/);
        assert.equal(LeaderElectionService.isLeader(), false);
        assert.equal(LeaderElectionService.isInitialized(), true);
        assert.equal(election.resignationPromise, undefined);
        now += 5_001;
        await election.checkLeader();
        assert.equal(LeaderElectionService.isLeader(), true);
    });

    for (const outcome of ['success', 'follower', 'no-follower', 'release-error'] as const) {
        test(`command registration and user feedback: ${outcome}`, async () => {
            if (outcome === 'follower') {
                election._isLeader = false;
            } else if (outcome === 'no-follower') {
                followers = [];
            } else if (outcome === 'release-error') {
                context.globalState.update = async () => {
                    throw new Error('release failed');
                };
            }
            election.registerCommands(context);
            assert.equal(registeredId, 'gcmp.instance.resignLeader');
            assert.equal(context.subscriptions.length, 1);
            assert.ok(command);
            await command();
            assert.equal(messages.length, 1);
            assert.equal(
                messages[0].kind,
                outcome === 'no-follower' ? 'warning'
                : outcome === 'release-error' ? 'error'
                : 'info'
            );
            assert.match(
                messages[0].text,
                outcome === 'success' ? /resigned/i
                : outcome === 'no-follower' ? /connected follower/i
                : outcome === 'release-error' ? /failed/i
                : /not the leader/i
            );
        });
    }

    test('only an explicitly eligible follower can be nominated', async () => {
        followers = ['agents-first', 'follower-second'];
        eligibleFollowers = ['follower-second'];
        assert.equal(await election.resignLeadership(), 'resigned');
        const event = events.find(item => item.type === 'leaderResigning') as ResignationEvent | undefined;
        assert.equal(event?.payload.nextLeaderId, 'follower-second');
    });

    test('an Agents-only IPC client cannot cause manual resignation', async () => {
        const server = new IpcServer();
        const socket = new Socket();
        const internals = server as unknown as {
            acceptSocketEvents: (socket: Socket, events: InterInstanceEvent[]) => boolean;
        };
        try {
            assert.equal(
                internals.acceptSocketEvents(socket, [
                    {
                        type: 'remoteInstanceHello',
                        payload: { leaderEligible: false },
                        timestamp: now,
                        senderInstanceId: 'agents-only'
                    }
                ]),
                true
            );
            InterInstanceBus.getConnectedFollowerIds = () => server.getConnectedFollowerIds();
            InterInstanceBus.getEligibleFollowerIds = () => server.getEligibleFollowerIds();
            assert.equal(await election.resignLeadership(), 'no-follower');
            assert.equal(LeaderElectionService.isLeader(), true);
            assert.deepEqual(events, []);
            assert.equal(snapshotCalls, 0);
        } finally {
            socket.destroy();
            await server.stop();
        }
    });

    test('loss of all successors aborts concurrent callers and permits a later retry', async () => {
        const started = deferred();
        const gate = deferred();
        LeaderElectionService.setRateLimitSnapshotProvider(async () => {
            started.resolve();
            await gate.promise;
            return undefined;
        });
        const first = election.resignLeadership();
        try {
            await started.promise;
            const second = election.resignLeadership();
            followers = [];
            gate.resolve();
            assert.deepEqual(await Promise.all([first, second]), ['no-follower', 'no-follower']);
            assert.equal(LeaderElectionService.isLeader(), true);
            assert.equal(election.electionPausedUntil, 0);
            assert.equal(record?.instanceId, 'leader-old');
            assert.deepEqual(events, []);
            assert.deepEqual(updates, []);
            followers = ['replacement'];
            assert.equal(await election.resignLeadership(), 'resigned');
        } finally {
            gate.resolve();
            await first;
        }
    });

    test('a disconnected nominee is replaced with a still-eligible follower', async () => {
        LeaderElectionService.setRateLimitSnapshotProvider(async () => {
            followers = ['follower-second'];
            return undefined;
        });
        assert.equal(await election.resignLeadership(), 'resigned');
        const event = events.find(item => item.type === 'leaderResigning') as ResignationEvent | undefined;
        assert.equal(event?.payload.nextLeaderId, 'follower-second');
    });

    for (const failure of ['not-sent', 'throw', 'balance-snapshot', 'rate-limit-snapshot'] as const) {
        test(`handoff failure preserves authority and reports an error: ${failure}`, async () => {
            if (failure === 'not-sent' || failure === 'throw') {
                InterInstanceBus.publishIpcOnly = () => {
                    if (failure === 'throw') {
                        throw new Error('IPC failed');
                    }
                    return false;
                };
            } else if (failure === 'balance-snapshot') {
                LeaderElectionService.setBalanceLeaseSnapshotProvider(async () => {
                    throw new Error('balance snapshot failed');
                });
            } else {
                LeaderElectionService.setRateLimitSnapshotProvider(async () => {
                    throw new Error('rate-limit snapshot failed');
                });
            }
            election.registerCommands(context);
            assert.ok(command);
            await command();
            assert.equal(messages[0]?.kind, 'error');
            assert.equal(LeaderElectionService.isLeader(), true);
            assert.equal(election.electionPausedUntil, 0);
            assert.equal(election.resignationPromise, undefined);
            assert.equal(record?.instanceId, 'leader-old');
            assert.deepEqual(updates, []);
            await election.updateHeartbeat();
            assert.equal(updates.length, 1);
        });
    }

    test('ownership lost during snapshot preparation is not published or cleared', async () => {
        LeaderElectionService.setRateLimitSnapshotProvider(async () => {
            record = { instanceId: 'leader-new', electedAt: now + 1, lastHeartbeat: now + 1 };
            return undefined;
        });
        assert.equal(await election.resignLeadership(), 'not-leader');
        assert.equal(record?.instanceId, 'leader-new');
        assert.deepEqual(events, []);
        assert.deepEqual(updates, []);
        assert.equal(LeaderElectionService.isLeader(), false);
    });

    test('shutdown still releases leadership after an aborted manual handoff', async () => {
        const started = deferred();
        const gate = deferred();
        LeaderElectionService.setRateLimitSnapshotProvider(async () => {
            started.resolve();
            await gate.promise;
            return undefined;
        });
        const resignation = election.resignLeadership();
        let stopping: Promise<void> | undefined;
        try {
            await started.promise;
            stopping = LeaderElectionService.stop();
            followers = [];
            gate.resolve();
            assert.equal(await resignation, 'no-follower');
            await stopping;
            assert.equal(LeaderElectionService.isInitialized(), false);
            assert.equal(LeaderElectionService.isLeader(), false);
            assert.equal(record, undefined);
            assert.equal(events.length, 1);
            const event = events[0] as ResignationEvent;
            assert.equal(event.type, 'leaderResigning');
            if (event.type === 'leaderResigning') {
                assert.equal(event.payload.reason, 'shutdown');
            }
        } finally {
            gate.resolve();
            await resignation;
            await stopping;
        }
    });

    test('shutdown remains best-effort when IPC publication fails', async () => {
        InterInstanceBus.publishIpcOnly = () => false;
        await LeaderElectionService.stop();
        assert.equal(LeaderElectionService.isLeader(), false);
        assert.equal(LeaderElectionService.isInitialized(), false);
        assert.equal(record, undefined);
        assert.equal(activityStops, 1);
    });

    for (const phase of ['rateLimitWaiting', 'streamingUpdate'] as const) {
        test(`manual resignation preserves an active old-window metric: ${phase}`, async () => {
            const bus = InterInstanceBus as unknown as {
                instanceId: string | undefined;
                authorityTerm: string | undefined;
                dispatchEvent: (event: InterInstanceEvent) => void;
            };
            const saved = { instanceId: bus.instanceId, authorityTerm: bus.authorityTerm };
            const requestId = `manual-resignation-${phase}`;
            let syntheticEnds = 0;
            try {
                bus.instanceId = 'receiver';
                bus.authorityTerm = 'leader-old:100000';
                registerInterInstanceHandlers(context);
                LeaderElectionService.setBalanceLeaseSnapshotProvider(() => undefined);
                receiveRemoteLiveMetrics(
                    {
                        type: phase,
                        requestId,
                        requestStartTime: now,
                        providerName: 'test',
                        modelName: 'test'
                    },
                    'leader-old'
                );
                context.subscriptions.push(
                    onLiveMetrics(event => {
                        if (event.requestId === requestId && event.type === 'streamEnd') {
                            syntheticEnds += 1;
                        }
                    })
                );
                InterInstanceBus.publishIpcOnly = event => {
                    events.push(event);
                    if (event.type === 'leaderResigning') {
                        bus.dispatchEvent({
                            ...(event as ResignationEvent),
                            timestamp: now,
                            senderInstanceId: 'leader-old'
                        });
                    }
                    return true;
                };
                assert.equal(await election.resignLeadership(), 'resigned');
                assert.equal(
                    getActiveMetricsSnapshot().some(event => event.requestId === requestId),
                    true
                );
                assert.equal(syntheticEnds, 0);
                bus.authorityTerm = 'leader-new:100001';
                bus.dispatchEvent({
                    type: 'remoteInstanceDisconnected',
                    payload: { instanceId: 'leader-old' },
                    timestamp: now,
                    senderInstanceId: 'leader-new'
                });
                assert.equal(
                    getActiveMetricsSnapshot().some(event => event.requestId === requestId),
                    false
                );
                assert.equal(syntheticEnds, 1);
            } finally {
                clearRemoteLiveMetrics('leader-old');
                setCrossInstanceBroadcaster(undefined);
                Object.assign(bus, saved);
            }
        });
    }

    test('command palette contribution has both localized titles', () => {
        const extension = vscode.extensions.getExtension('vicanent.gcmp');
        assert.ok(extension);
        const manifest = JSON.parse(readFileSync(join(extension.extensionPath, 'package.json'), 'utf8')) as {
            contributes: { commands: Array<{ command: string; title: string; category: string }> };
        };
        const contribution = manifest.contributes.commands.find(item => item.command === 'gcmp.instance.resignLeader');
        assert.ok(contribution);
        assert.equal(contribution.category, 'GCMP');
        assert.equal(contribution.title, '%command.instance.resignLeader%');
        for (const locale of ['package.nls.json', 'package.nls.zh-cn.json']) {
            const titles = JSON.parse(readFileSync(join(extension.extensionPath, locale), 'utf8')) as Record<
                string,
                string
            >;
            assert.ok(titles['command.instance.resignLeader']);
        }
    });
});
