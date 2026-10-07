import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as vscode from 'vscode';
import { InterInstanceBus, type InterInstanceEvent } from '../../src/interInstance';
import { registerInterInstanceHandlers } from '../../src/interInstance/activation';
import type { ApiKeyBalanceLeaseHandoff } from '../../src/interInstance/eventProtocol';
import { setBalanceHandoffDirectoryOverride } from '../../src/interInstance/pathResolver';
import {
    clearRemoteLiveMetrics,
    getCrossInstanceLiveMetricsSnapshot,
    receiveRemoteLiveMetrics
} from '../../src/handlers/liveMetrics';
import { LeaderElectionService } from '../../src/status/leaderElectionService';
import { AtomicJsonFile } from '../../src/usages/atomicJsonFile';
import { ApiKeyManager } from '../../src/utils/config/apiKeyManager';
import { enqueueConfigSetMutation } from '../../src/utils/config/configSetCommands';
import { ConfigSetStore } from '../../src/utils/config/configSetStore';
import { ApiKeyFailoverManager } from '../../src/utils/config/failover/apiKeyFailoverManager';
import {
    readBalanceLeaseHandoff,
    writeBalanceLeaseHandoff
} from '../../src/utils/config/failover/balanceLeaseHandoffFile';

function createContext(): vscode.ExtensionContext {
    const state = new Map<string, unknown>();
    const secrets = new Map<string, string>();
    return {
        globalState: {
            get: <T>(key: string, fallback?: T): T => (state.has(key) ? state.get(key) : fallback) as T,
            keys: () => [...state.keys()],
            async update(key: string, value: unknown) {
                if (value === undefined) {
                    state.delete(key);
                } else {
                    state.set(key, structuredClone(value));
                }
            }
        },
        subscriptions: [],
        secrets: {
            get: async (key: string) => secrets.get(key),
            store: async (key: string, value: string) => {
                secrets.set(key, value);
            },
            delete: async (key: string) => {
                secrets.delete(key);
            },
            onDidChange: () => ({ dispose() {} })
        }
    } as unknown as vscode.ExtensionContext;
}

function handoff(now = Date.now()): ApiKeyBalanceLeaseHandoff {
    return {
        sourceAuthorityTerm: 'leader-old:1',
        capturedAt: now,
        leases: [
            {
                leaseId: 'lease-inflight',
                slot: 'slot',
                balanceKey: 's:handoff',
                configId: 'a',
                credentialId: createHash('sha256').update('key-a\u0000').digest('hex'),
                ownerInstanceId: 'follower-a',
                expiresAt: now + 30_000
            }
        ]
    };
}

function stage(snapshot = handoff(), targetLeaderId?: string): void {
    ApiKeyFailoverManager.stageBalanceLeaseHandoff(
        snapshot,
        'leader-old',
        targetLeaderId,
        snapshot.sourceAuthorityTerm,
        Date.now()
    );
}

const manager = ApiKeyFailoverManager as unknown as {
    balanceLeases: Map<string, { configId: string; expiresAt: number }>;
    balanceLeaseRenewalTimers: Map<string, NodeJS.Timeout>;
    pendingBalanceDisconnectReclaims: Map<string, NodeJS.Timeout>;
    pendingBalanceLeaseHandoff: unknown;
};
const bus = InterInstanceBus as unknown as {
    authorityChangedEmitter: vscode.EventEmitter<string | undefined>;
    handlers: Map<string, Set<(event: InterInstanceEvent) => void>>;
};

suite('balance handoff continuation regressions', () => {
    const originalLeader = LeaderElectionService.isLeader;
    const originalInitialized = LeaderElectionService.isInitialized;
    const originalAgents = LeaderElectionService.isAgentsWindow;
    const originalInstanceId = LeaderElectionService.getInstanceId;
    const originalOwnedTerm = LeaderElectionService.getOwnedAuthorityTerm;
    const originalAuthorityTerm = InterInstanceBus.getAuthorityTerm;
    const originalHasTransport = InterInstanceBus.hasActiveTransport;
    const originalTransitioning = InterInstanceBus.isAuthorityTransitioning;
    const originalPublish = InterInstanceBus.publishIpcOnly;
    const originalGetApiKey = ConfigSetStore.getApiKey;
    const originalRunExclusive = AtomicJsonFile.runExclusive;
    const originalWriteJson = AtomicJsonFile.writeJsonAtomically;
    const originalNow = Date.now;
    let context: vscode.ExtensionContext;

    setup(async () => {
        ApiKeyFailoverManager.handleBalanceAuthorityLost();
        setBalanceHandoffDirectoryOverride(mkdtempSync(join(tmpdir(), 'gcmp-balance-handoff-suite-')));
        context = createContext();
        ApiKeyManager.initialize(context);
        ConfigSetStore.initialize(context);
        LeaderElectionService.isLeader = () => true;
        LeaderElectionService.isInitialized = () => true;
        LeaderElectionService.isAgentsWindow = () => false;
        LeaderElectionService.getInstanceId = () => 'leader-new';
        LeaderElectionService.getOwnedAuthorityTerm = () => 'leader-new:2';
        InterInstanceBus.getAuthorityTerm = () => 'leader-new:2';
        InterInstanceBus.publishIpcOnly = () => true;
        for (const id of ['a', 'b']) {
            await ConfigSetStore.add('slot', { id, label: id }, `key-${id}`);
        }
        await ConfigSetStore.setActive('slot', 'a');
        await ApiKeyManager.setApiKey('slot', 'key-a');
        await ConfigSetStore.setSwitchMode('slot', 'balance');
    });

    teardown(() => {
        for (const disposable of context.subscriptions) {
            disposable.dispose();
        }
        ApiKeyFailoverManager.handleBalanceAuthorityLost();
        manager.pendingBalanceLeaseHandoff = undefined;
        LeaderElectionService.setBalanceLeaseSnapshotProvider(undefined);
        clearRemoteLiveMetrics('leader-old');
        clearRemoteLiveMetrics('follower-other');
        LeaderElectionService.isLeader = originalLeader;
        LeaderElectionService.isInitialized = originalInitialized;
        LeaderElectionService.isAgentsWindow = originalAgents;
        LeaderElectionService.getInstanceId = originalInstanceId;
        LeaderElectionService.getOwnedAuthorityTerm = originalOwnedTerm;
        InterInstanceBus.getAuthorityTerm = originalAuthorityTerm;
        InterInstanceBus.hasActiveTransport = originalHasTransport;
        InterInstanceBus.isAuthorityTransitioning = originalTransitioning;
        InterInstanceBus.publishIpcOnly = originalPublish;
        ConfigSetStore.getApiKey = originalGetApiKey;
        AtomicJsonFile.runExclusive = originalRunExclusive;
        AtomicJsonFile.writeJsonAtomically = originalWriteJson;
        Date.now = originalNow;
        setBalanceHandoffDirectoryOverride(undefined);
    });

    test('new assignment waits for the entire handoff import', async () => {
        stage();
        let unblock!: () => void;
        let started!: () => void;
        const gate = new Promise<void>(resolve => {
            unblock = resolve;
        });
        const lookupStarted = new Promise<void>(resolve => {
            started = resolve;
        });
        let blockNextLookup = true;
        ConfigSetStore.getApiKey = async (...args) => {
            if (blockNextLookup) {
                blockNextLookup = false;
                started();
                await gate;
            }
            return originalGetApiKey.apply(ConfigSetStore, args);
        };
        const becoming = ApiKeyFailoverManager.becomeBalanceAuthority('leader-new:2');
        await lookupStarted;
        let resolved = false;
        const assignment = ApiKeyFailoverManager.handleBalanceAssignmentRequest(
            {
                requestId: 'new-assignment',
                requestedBy: 'follower-b',
                authorityTerm: 'leader-new:2',
                slot: 'slot',
                balanceKey: 's:handoff'
            },
            'follower-b'
        ).then(value => {
            resolved = true;
            return value;
        });
        try {
            await new Promise<void>(resolve => setImmediate(resolve));
            assert.equal(resolved, false, 'assignment must not overtake the import');
            unblock();
            await becoming;
            assert.equal((await assignment)?.configId, 'b');
        } finally {
            unblock();
            await Promise.all([becoming, assignment]);
        }
    });

    test('follower authority transition keeps active request heartbeats', async () => {
        const attempt = await ApiKeyFailoverManager.captureAttempt('slot', 's:active-stream', 'request-active-stream');
        assert.ok(attempt?.balanceLeaseId);
        ApiKeyFailoverManager.startBalanceLeaseHeartbeat(attempt);
        LeaderElectionService.isLeader = () => false;
        registerInterInstanceHandlers(context);
        bus.authorityChangedEmitter.fire('leader-next:3');
        assert.equal(manager.balanceLeaseRenewalTimers.has(attempt.balanceLeaseId), true);
    });

    test('an active heartbeat migrates to the newly imported authority', async () => {
        let now = originalNow();
        Date.now = () => now;
        LeaderElectionService.getInstanceId = () => 'follower-a';
        LeaderElectionService.getOwnedAuthorityTerm = () => 'leader-old:1';
        const attempt = await ApiKeyFailoverManager.captureAttempt('slot', 's:active-stream', 'request-active-stream');
        assert.ok(attempt?.balanceLeaseId);
        ApiKeyFailoverManager.startBalanceLeaseHeartbeat(attempt);
        const snapshot = ApiKeyFailoverManager.exportBalanceLeaseHandoff();
        assert.ok(snapshot);
        LeaderElectionService.isLeader = () => false;
        registerInterInstanceHandlers(context);
        bus.authorityChangedEmitter.fire('leader-new:2');
        stage(snapshot);
        LeaderElectionService.isLeader = () => true;
        LeaderElectionService.getOwnedAuthorityTerm = () => 'leader-new:2';
        await ApiKeyFailoverManager.becomeBalanceAuthority('leader-new:2');
        now += 20_000;
        const timer = manager.balanceLeaseRenewalTimers.get(attempt.balanceLeaseId) as
            | (NodeJS.Timeout & { _onTimeout: () => void })
            | undefined;
        assert.ok(timer, 'the stream must retain its renewal timer');
        timer._onTimeout();
        assert.equal(manager.balanceLeases.get(attempt.balanceLeaseId)?.expiresAt, now + 30_000);
        now += 20_000;
        timer._onTimeout();
        assert.equal(manager.balanceLeases.get(attempt.balanceLeaseId)?.expiresAt, now + 30_000);
    });

    test('invalid resigning payload never clears other instances metrics', () => {
        registerInterInstanceHandlers(context);
        InterInstanceBus.getAuthorityTerm = () => 'leader-old:1';
        for (const source of ['leader-old', 'follower-other']) {
            receiveRemoteLiveMetrics(
                {
                    type: 'requestStarted',
                    requestId: `handoff-metrics-${source}`,
                    requestStartTime: Date.now(),
                    providerName: 'test',
                    modelName: 'test'
                },
                source
            );
        }
        const dispatch = (payload: unknown): void => {
            const event = {
                type: 'leaderResigning',
                payload,
                timestamp: Date.now(),
                senderInstanceId: 'leader-old'
            } as InterInstanceEvent;
            for (const handler of bus.handlers.get('leaderResigning') ?? []) {
                handler(event);
            }
        };
        for (const payload of [{}, { leaderId: '' }, { leaderId: 'follower-other' }]) {
            dispatch(payload);
            const ids = getCrossInstanceLiveMetricsSnapshot().map(entry => entry.event.requestId);
            assert.ok(ids.includes('handoff-metrics-leader-old'));
            assert.ok(ids.includes('handoff-metrics-follower-other'));
        }
        dispatch({ leaderId: 'leader-old' });
        const ids = getCrossInstanceLiveMetricsSnapshot().map(entry => entry.event.requestId);
        assert.equal(ids.includes('handoff-metrics-leader-old'), false);
        assert.ok(ids.includes('handoff-metrics-follower-other'));
    });

    test('non-nominated follower retains a handoff for fallback takeover', async () => {
        registerInterInstanceHandlers(context);
        InterInstanceBus.getAuthorityTerm = () => 'leader-old:1';
        const event: InterInstanceEvent = {
            type: 'leaderResigning',
            payload: {
                leaderId: 'leader-old',
                sourceAuthorityTerm: 'leader-old:1',
                nextLeaderId: 'nominated-but-unavailable',
                balanceLeaseSnapshot: handoff()
            },
            timestamp: Date.now(),
            senderInstanceId: 'leader-old'
        };
        for (const handler of bus.handlers.get('leaderResigning') ?? []) {
            handler(event);
        }
        assert.ok(manager.pendingBalanceLeaseHandoff);
        await ApiKeyFailoverManager.becomeBalanceAuthority('leader-new:2');
        assert.ok(manager.balanceLeases.has('lease-inflight'));
    });

    test('snapshot provider freezes new assignments before exporting', async () => {
        registerInterInstanceHandlers(context);
        const first = await ApiKeyFailoverManager.captureAttempt('slot', 's:active', 'request-active');
        assert.ok(first?.balanceLeaseId);
        const election = LeaderElectionService as unknown as {
            balanceLeaseSnapshotProvider: () =>
                | ApiKeyBalanceLeaseHandoff
                | undefined
                | Promise<ApiKeyBalanceLeaseHandoff | undefined>;
        };
        const snapshot = await election.balanceLeaseSnapshotProvider();
        assert.ok(snapshot?.leases.some(lease => lease.leaseId === first.balanceLeaseId));
        const assignment = await ApiKeyFailoverManager.handleBalanceAssignmentRequest(
            {
                requestId: 'request-during-stop',
                requestedBy: 'follower-b',
                authorityTerm: 'leader-new:2',
                slot: 'slot',
                balanceKey: 's:active'
            },
            'follower-b'
        );
        assert.notEqual(assignment?.handled, true);
        assert.equal(await ApiKeyFailoverManager.captureAttempt('slot', 's:active', 'local-during-stop'), undefined);
    });

    test('cold takeover restores persisted leases without any resigning event', async () => {
        await writeBalanceLeaseHandoff(handoff());
        await ApiKeyFailoverManager.becomeBalanceAuthority('leader-new:2');
        assert.ok(manager.balanceLeases.has('lease-inflight'));
        const next = await ApiKeyFailoverManager.captureAttempt('slot', 's:handoff', 'request-after-restart');
        assert.equal(next?.activeId, 'b');
        const persisted = await readBalanceLeaseHandoff();
        assert.equal(persisted?.sourceAuthorityTerm, 'leader-new:2');
        assert.equal(persisted?.leases.length, 2);
        assert.equal(Object.hasOwn(persisted!.leases[0], 'requestId'), false);
        assert.equal(JSON.stringify(persisted).includes('key-a'), false);
        assert.equal(JSON.stringify(persisted).includes('key-b'), false);
    });

    test('every allocated lease is persisted before the request receives it', async () => {
        const assigned = await ApiKeyFailoverManager.handleBalanceAssignmentRequest(
            {
                requestId: 'request-before-crash',
                requestedBy: 'follower-a',
                authorityTerm: 'leader-new:2',
                slot: 'slot',
                balanceKey: 's:crash'
            },
            'follower-a'
        );
        assert.ok(assigned?.leaseId);
        assert.ok((await readBalanceLeaseHandoff())?.leases.some(lease => lease.leaseId === assigned.leaseId));
        ApiKeyFailoverManager.handleBalanceAuthorityLost();
        LeaderElectionService.getInstanceId = () => 'leader-third';
        LeaderElectionService.getOwnedAuthorityTerm = () => 'leader-third:3';
        await ApiKeyFailoverManager.becomeBalanceAuthority('leader-third:3');
        assert.ok(manager.balanceLeases.has(assigned.leaseId));
    });

    for (const boundary of ['mutation-queue', 'disk-read', 'secret-lookup'] as const) {
        for (const action of [
            'unchanged',
            'release',
            'renew',
            'lose-authority',
            'expire',
            'change-mode',
            'mode-off',
            'mode-cycle',
            'other-slot-mode',
            'disconnect',
            'replace-key'
        ] as const) {
            test(`${action} during handoff ${boundary} preserves lease validity`, async () => {
                let now = originalNow();
                Date.now = () => now;
                await writeBalanceLeaseHandoff(handoff(now));
                let unblock!: () => void;
                let started!: () => void;
                const gate = new Promise<void>(resolve => {
                    unblock = resolve;
                });
                const boundaryStarted = new Promise<void>(resolve => {
                    started = resolve;
                });
                const changeDuringImport = async (): Promise<void> => {
                    if (action === 'release') {
                        ApiKeyFailoverManager.handleRemoteBalanceLeaseRelease(
                            { leaseId: 'lease-inflight', authorityTerm: 'leader-new:2' },
                            'follower-a'
                        );
                    } else if (action === 'renew') {
                        now += 5_000;
                        ApiKeyFailoverManager.handleRemoteBalanceLeaseRenewal(
                            { leaseId: 'lease-inflight', authorityTerm: 'leader-new:2' },
                            'follower-a'
                        );
                    } else if (action === 'lose-authority') {
                        LeaderElectionService.isLeader = () => false;
                        ApiKeyFailoverManager.handleBalanceAuthorityLost(true);
                    } else if (action === 'expire') {
                        now += 30_001;
                    } else if (action === 'replace-key') {
                        await ConfigSetStore.setApiKey('slot', 'a', 'replacement-key');
                    } else if (action === 'disconnect') {
                        ApiKeyFailoverManager.handleBalanceInstanceDisconnected('follower-a');
                        const timer = manager.pendingBalanceDisconnectReclaims.get('follower-a') as NodeJS.Timeout & {
                            _onTimeout: () => void;
                        };
                        const reclaim = timer._onTimeout;
                        clearTimeout(timer);
                        reclaim();
                    } else if (action === 'mode-off' || action === 'mode-cycle') {
                        await ConfigSetStore.setSwitchMode('slot', 'off');
                        ApiKeyFailoverManager.handleBalanceModeChanged('slot');
                        if (action === 'mode-cycle') {
                            await ConfigSetStore.setSwitchMode('slot', 'balance');
                            ApiKeyFailoverManager.handleBalanceModeChanged('slot');
                        }
                    } else if (action === 'change-mode' || action === 'other-slot-mode') {
                        ApiKeyFailoverManager.handleBalanceModeChanged(action === 'change-mode' ? 'slot' : 'other');
                    }
                };
                let blocking: Promise<void> | undefined;
                if (boundary === 'mutation-queue') {
                    blocking = enqueueConfigSetMutation(async () => {
                        started();
                        await gate;
                        await changeDuringImport();
                    });
                } else if (boundary === 'disk-read') {
                    const runExclusive = originalRunExclusive.bind(AtomicJsonFile);
                    let blockNextRead = true;
                    AtomicJsonFile.runExclusive = async <T>(path: string, operation: () => Promise<T>): Promise<T> => {
                        const value = await runExclusive(path, operation);
                        if (blockNextRead) {
                            blockNextRead = false;
                            started();
                            await gate;
                        }
                        return value;
                    };
                } else {
                    ConfigSetStore.getApiKey = async (...args) => {
                        const apiKey = await originalGetApiKey.apply(ConfigSetStore, args);
                        started();
                        await gate;
                        return apiKey;
                    };
                }
                const becoming = ApiKeyFailoverManager.becomeBalanceAuthority('leader-new:2');
                try {
                    await Promise.race([
                        boundaryStarted,
                        becoming.then(() => {
                            throw new Error(`Import did not reach ${boundary}`);
                        })
                    ]);
                    if (boundary !== 'mutation-queue') {
                        await changeDuringImport();
                    }
                    unblock();
                    await becoming;
                    await new Promise<void>(resolve => setImmediate(resolve));
                    const shouldRestore = action === 'unchanged' || action === 'other-slot-mode';
                    if (action === 'renew') {
                        assert.equal(manager.balanceLeases.get('lease-inflight')?.expiresAt, now + 30_000);
                    } else {
                        assert.equal(manager.balanceLeases.has('lease-inflight'), shouldRestore);
                    }
                    if (shouldRestore || action === 'change-mode' || action === 'mode-off' || action === 'mode-cycle') {
                        const persisted = await readBalanceLeaseHandoff();
                        assert.equal(persisted?.sourceAuthorityTerm, 'leader-new:2');
                        assert.equal(
                            persisted.leases.some(lease => lease.leaseId === 'lease-inflight'),
                            shouldRestore
                        );
                    }
                    if (action === 'lose-authority') {
                        LeaderElectionService.isLeader = () => true;
                        LeaderElectionService.getInstanceId = () => 'leader-third';
                        LeaderElectionService.getOwnedAuthorityTerm = () => 'leader-third:3';
                        await ApiKeyFailoverManager.becomeBalanceAuthority('leader-third:3');
                        assert.ok(manager.balanceLeases.has('lease-inflight'));
                    }
                    if (action === 'release') {
                        await ApiKeyFailoverManager.prepareBalanceLeaseHandoff();
                        ApiKeyFailoverManager.handleBalanceAuthorityLost();
                        LeaderElectionService.getInstanceId = () => 'leader-third';
                        LeaderElectionService.getOwnedAuthorityTerm = () => 'leader-third:3';
                        await ApiKeyFailoverManager.becomeBalanceAuthority('leader-third:3');
                        assert.equal(manager.balanceLeases.has('lease-inflight'), false);
                    }
                } finally {
                    unblock();
                    await blocking;
                    await becoming;
                }
            });
        }
    }

    test('credential replacement after an earlier lookup cannot leave a stale imported lease', async () => {
        const snapshot = handoff();
        snapshot.leases.push({
            ...snapshot.leases[0],
            leaseId: 'lease-second',
            configId: 'b',
            credentialId: createHash('sha256').update('key-b\u0000').digest('hex')
        });
        stage(snapshot);
        let unblock!: () => void;
        let started!: () => void;
        const gate = new Promise<void>(resolve => {
            unblock = resolve;
        });
        const lookupStarted = new Promise<void>(resolve => {
            started = resolve;
        });
        ConfigSetStore.getApiKey = async (slot, id) => {
            const apiKey = await originalGetApiKey.call(ConfigSetStore, slot, id);
            if (id === 'b') {
                started();
                await gate;
            }
            return apiKey;
        };
        const becoming = ApiKeyFailoverManager.becomeBalanceAuthority('leader-new:2');
        try {
            await lookupStarted;
            await ConfigSetStore.setApiKey('slot', 'a', 'replacement-key');
            unblock();
            await becoming;
            assert.equal(manager.balanceLeases.has('lease-inflight'), false);
        } finally {
            unblock();
            await becoming;
        }
    });

    for (const action of ['replace-key', 'mode-cycle', 'expire', 'change-authority'] as const) {
        test(`${action} during allocation persistence preserves lease and handoff validity`, async () => {
            let now = originalNow();
            Date.now = () => now;
            const active = await ApiKeyFailoverManager.captureAttempt('slot', 's:active', 'request-active');
            assert.ok(active?.balanceLeaseId);
            let unblock!: () => void;
            let started!: () => void;
            const gate = new Promise<void>(resolve => {
                unblock = resolve;
            });
            const writeStarted = new Promise<void>(resolve => {
                started = resolve;
            });
            let blockNextWrite = true;
            AtomicJsonFile.writeJsonAtomically = async (...args) => {
                if (blockNextWrite) {
                    blockNextWrite = false;
                    started();
                    await gate;
                }
                return originalWriteJson.apply(AtomicJsonFile, args);
            };
            const allocation = ApiKeyFailoverManager.captureAttempt('slot', 's:active', 'request-during-write');
            let becoming: Promise<void> | undefined;
            try {
                await writeStarted;
                if (action === 'replace-key') {
                    const allocated = [...manager.balanceLeases.entries()].find(
                        ([leaseId]) => leaseId !== active.balanceLeaseId
                    )?.[1];
                    assert.ok(allocated);
                    await ConfigSetStore.setApiKey('slot', allocated.configId, 'replacement-key');
                } else if (action === 'mode-cycle') {
                    await ConfigSetStore.setSwitchMode('slot', 'off');
                    ApiKeyFailoverManager.handleBalanceModeChanged('slot');
                    await ConfigSetStore.setSwitchMode('slot', 'balance');
                    ApiKeyFailoverManager.handleBalanceModeChanged('slot');
                } else if (action === 'expire') {
                    now += 30_001;
                } else {
                    LeaderElectionService.getInstanceId = () => 'leader-third';
                    LeaderElectionService.getOwnedAuthorityTerm = () => 'leader-third:3';
                    becoming = ApiKeyFailoverManager.becomeBalanceAuthority('leader-third:3');
                }
                unblock();
                assert.equal(await allocation, undefined);
                if (becoming) {
                    await becoming;
                    assert.ok(manager.balanceLeases.has(active.balanceLeaseId));
                    assert.ok(
                        (await readBalanceLeaseHandoff())?.leases.some(lease => lease.leaseId === active.balanceLeaseId)
                    );
                }
            } finally {
                unblock();
                await allocation;
                await becoming;
            }
        });
    }

    for (const source of ['local', 'remote'] as const) {
        for (const action of [
            'unchanged',
            'lose-authority',
            'mode-off',
            'mode-cycle',
            'expire',
            'freeze',
            'release',
            'replace-key',
            'pool-config-change'
        ] as const) {
            if (source === 'local' && action === 'pool-config-change') {
                continue;
            }
            test(`${source} lease reuse revalidates after key lookup: ${action}`, async () => {
                let now = originalNow();
                Date.now = () => now;
                const capture = async (): Promise<string | undefined> => {
                    if (source === 'local') {
                        return (await ApiKeyFailoverManager.captureAttempt('slot', 's:reuse', 'request-reuse'))
                            ?.balanceLeaseId;
                    }
                    const assigned = await ApiKeyFailoverManager.handleBalanceAssignmentRequest(
                        {
                            requestId: 'request-reuse',
                            requestedBy: 'follower-a',
                            authorityTerm: 'leader-new:2',
                            slot: 'slot',
                            balanceKey: 's:reuse'
                        },
                        'follower-a'
                    );
                    return assigned?.handled ? assigned.leaseId : undefined;
                };
                const leaseId = await capture();
                assert.ok(leaseId);
                const lease = manager.balanceLeases.get(leaseId);
                assert.ok(lease);
                now += 20_000;
                ApiKeyFailoverManager.renewBalanceLease(leaseId, 'leader-new:2');
                now += 11_000;
                let unblock!: () => void;
                let started!: () => void;
                const gate = new Promise<void>(resolve => {
                    unblock = resolve;
                });
                const lookupStarted = new Promise<void>(resolve => {
                    started = resolve;
                });
                let selectedReads = 0;
                ConfigSetStore.getApiKey = async (...args) => {
                    const apiKey = await originalGetApiKey.apply(ConfigSetStore, args);
                    if (args[1] === lease.configId && ++selectedReads === (action === 'pool-config-change' ? 1 : 2)) {
                        started();
                        await gate;
                    }
                    return apiKey;
                };
                const pending = capture();
                let resigning: Promise<ApiKeyBalanceLeaseHandoff | undefined> | undefined;
                try {
                    await Promise.race([
                        lookupStarted,
                        pending.then(() => {
                            throw new Error('Lease reuse did not reach the blocked key lookup');
                        })
                    ]);
                    if (action === 'lose-authority') {
                        LeaderElectionService.isLeader = () => false;
                        LeaderElectionService.getOwnedAuthorityTerm = () => undefined;
                        ApiKeyFailoverManager.handleBalanceAuthorityLost(true);
                    } else if (action === 'mode-off' || action === 'mode-cycle') {
                        await ConfigSetStore.setSwitchMode('slot', 'off');
                        ApiKeyFailoverManager.handleBalanceModeChanged('slot');
                        if (action === 'mode-cycle') {
                            await ConfigSetStore.setSwitchMode('slot', 'balance');
                            ApiKeyFailoverManager.handleBalanceModeChanged('slot');
                        }
                    } else if (action === 'expire') {
                        now += 30_001;
                    } else if (action === 'freeze') {
                        resigning = ApiKeyFailoverManager.prepareBalanceLeaseHandoff();
                    } else if (action === 'release') {
                        ApiKeyFailoverManager.releaseBalanceLease(leaseId);
                    } else if (action === 'replace-key') {
                        await ConfigSetStore.setApiKey('slot', lease.configId, 'replacement-key');
                    } else if (action === 'pool-config-change') {
                        await ConfigSetStore.setApiKey('slot', lease.configId === 'a' ? 'b' : 'a', 'replacement-key');
                    }
                    unblock();
                    assert.equal(await pending, action === 'unchanged' ? leaseId : undefined);
                } finally {
                    unblock();
                    await pending;
                    await resigning;
                }
            });
        }
    }

    for (const action of [
        'unchanged',
        'mode-cycle',
        'mode-off',
        'replace-key',
        'same-term-reset',
        'change-authority',
        'expire',
        'transport-lost',
        'transition',
        'other-slot-mode',
        'mode-before-lookup',
        'config-before-lookup'
    ] as const) {
        test(`follower assignment revalidates after key lookup: ${action}`, async () => {
            const originalValidate = ApiKeyFailoverManager.validateBalanceFallback;
            let fallbackValidations = 0;
            ApiKeyFailoverManager.validateBalanceFallback = (...args) => {
                fallbackValidations++;
                return originalValidate.apply(ApiKeyFailoverManager, args);
            };
            let now = originalNow();
            Date.now = () => now;
            LeaderElectionService.isLeader = () => false;
            LeaderElectionService.getOwnedAuthorityTerm = () => undefined;
            InterInstanceBus.hasActiveTransport = () => true;
            InterInstanceBus.isAuthorityTransitioning = () => false;
            let unblock!: () => void;
            let started!: () => void;
            const gate = new Promise<void>(resolve => {
                unblock = resolve;
            });
            const lookupStarted = new Promise<void>(resolve => {
                started = resolve;
            });
            let keyLookups = 0;
            ConfigSetStore.getApiKey = async (...args) => {
                keyLookups++;
                const apiKey = await originalGetApiKey.apply(ConfigSetStore, args);
                started();
                await gate;
                return apiKey;
            };
            const releases: Array<{ leaseId: string; authorityTerm: string }> = [];
            let configurationUpdate: Promise<void> | undefined;
            InterInstanceBus.publishIpcOnly = event => {
                if (event.type === 'apiKeyBalanceAssignmentRequested') {
                    ApiKeyFailoverManager.resolveBalanceAssignment({
                        requestId: (event.payload as { requestId: string }).requestId,
                        targetInstanceId: 'leader-new',
                        authorityTerm: 'leader-new:2',
                        handled: true,
                        leaseId: 'assigned-before-change',
                        configId: 'a',
                        credentialId: createHash('sha256').update('key-a\u0000').digest('hex'),
                        expiresAt: now + 30_000
                    });
                    if (action === 'mode-before-lookup') {
                        ApiKeyFailoverManager.handleBalanceModeChanged('slot');
                    } else if (action === 'config-before-lookup') {
                        configurationUpdate = ConfigSetStore.setApplyOperationToken('slot', 'updated-before-lookup');
                    }
                } else if (event.type === 'apiKeyBalanceLeaseReleased') {
                    releases.push(event.payload as { leaseId: string; authorityTerm: string });
                }
                return true;
            };
            const pending = ApiKeyFailoverManager.captureAttempt('slot', 's:lookup', 'request-lookup');
            try {
                if (action === 'mode-before-lookup' || action === 'config-before-lookup') {
                    unblock();
                    assert.equal(await pending, undefined);
                    assert.equal(keyLookups, 0);
                    assert.equal(fallbackValidations, 0);
                    assert.deepEqual(releases, [{ leaseId: 'assigned-before-change', authorityTerm: 'leader-new:2' }]);
                    return;
                }
                await Promise.race([
                    lookupStarted,
                    pending.then(() => {
                        throw new Error('Assignment did not reach the blocked key lookup');
                    })
                ]);
                if (action === 'mode-off' || action === 'mode-cycle') {
                    await ConfigSetStore.setSwitchMode('slot', 'off');
                    ApiKeyFailoverManager.handleBalanceModeChanged('slot');
                    if (action === 'mode-cycle') {
                        await ConfigSetStore.setSwitchMode('slot', 'balance');
                        ApiKeyFailoverManager.handleBalanceModeChanged('slot');
                    }
                } else if (action === 'replace-key') {
                    await ConfigSetStore.setApiKey('slot', 'a', 'replacement-key');
                } else if (action === 'same-term-reset' || action === 'change-authority') {
                    if (action === 'change-authority') {
                        InterInstanceBus.getAuthorityTerm = () => 'leader-third:3';
                    }
                    ApiKeyFailoverManager.handleBalanceAuthorityLost(true);
                } else if (action === 'expire') {
                    now += 30_001;
                } else if (action === 'transport-lost') {
                    InterInstanceBus.hasActiveTransport = () => false;
                } else if (action === 'transition') {
                    InterInstanceBus.isAuthorityTransitioning = () => true;
                } else if (action === 'other-slot-mode') {
                    ApiKeyFailoverManager.handleBalanceModeChanged('other');
                }
                unblock();
                const attempt = await pending;
                assert.equal(fallbackValidations, 0);
                if (action === 'unchanged' || action === 'other-slot-mode') {
                    assert.equal(attempt?.balanceLeaseId, 'assigned-before-change');
                    assert.deepEqual(releases, []);
                } else {
                    assert.equal(attempt, undefined);
                    assert.deepEqual(releases, [{ leaseId: 'assigned-before-change', authorityTerm: 'leader-new:2' }]);
                }
            } finally {
                unblock();
                ApiKeyFailoverManager.validateBalanceFallback = originalValidate;
                await pending;
                await configurationUpdate;
            }
        });
    }

    test('preserved heartbeat uses the connected authority and clears on a slot mode change', async () => {
        const attempt = await ApiKeyFailoverManager.captureAttempt('slot', 's:active', 'request-active');
        assert.ok(attempt?.balanceLeaseId);
        ApiKeyFailoverManager.startBalanceLeaseHeartbeat(attempt, 'slot');
        LeaderElectionService.isLeader = () => false;
        registerInterInstanceHandlers(context);
        InterInstanceBus.getAuthorityTerm = () => 'leader-third:3';
        bus.authorityChangedEmitter.fire('leader-third:3');
        const sent: unknown[] = [];
        InterInstanceBus.publishIpcOnly = event => {
            sent.push(event);
            return true;
        };
        const timer = manager.balanceLeaseRenewalTimers.get(attempt.balanceLeaseId) as NodeJS.Timeout & {
            _onTimeout: () => void;
        };
        timer._onTimeout();
        assert.deepEqual(sent, [
            {
                type: 'apiKeyBalanceLeaseRenewed',
                payload: { leaseId: attempt.balanceLeaseId, authorityTerm: 'leader-third:3' }
            }
        ]);
        ApiKeyFailoverManager.handleBalanceModeChanged('other');
        assert.ok(manager.balanceLeaseRenewalTimers.has(attempt.balanceLeaseId));
        ApiKeyFailoverManager.handleBalanceModeChanged('slot');
        assert.equal(manager.balanceLeaseRenewalTimers.has(attempt.balanceLeaseId), false);
    });

    test('new-term renewal verifies owner and never revives an expired imported lease', async () => {
        let now = originalNow();
        Date.now = () => now;
        stage();
        await ApiKeyFailoverManager.becomeBalanceAuthority('leader-new:2');
        now += 10_000;
        ApiKeyFailoverManager.handleRemoteBalanceLeaseRenewal(
            { leaseId: 'lease-inflight', authorityTerm: 'leader-new:2' },
            'follower-other'
        );
        assert.equal(manager.balanceLeases.get('lease-inflight')?.expiresAt, now + 20_000);
        ApiKeyFailoverManager.handleRemoteBalanceLeaseRenewal(
            { leaseId: 'lease-inflight', authorityTerm: 'leader-new:2' },
            'follower-a'
        );
        assert.equal(manager.balanceLeases.get('lease-inflight')?.expiresAt, now + 30_000);
        now += 30_001;
        ApiKeyFailoverManager.handleRemoteBalanceLeaseRenewal(
            { leaseId: 'lease-inflight', authorityTerm: 'leader-new:2' },
            'follower-a'
        );
        assert.equal(manager.balanceLeases.has('lease-inflight'), false);
    });

    test('two consecutive handoffs retain the heartbeat and reject a late local old-term release', async () => {
        let now = originalNow();
        Date.now = () => now;
        const attempt = await ApiKeyFailoverManager.captureAttempt('slot', 's:active', 'request-active');
        assert.ok(attempt?.balanceLeaseId);
        ApiKeyFailoverManager.startBalanceLeaseHeartbeat(attempt, 'slot');
        for (const term of ['leader-new:3', 'leader-new:4']) {
            await ApiKeyFailoverManager.prepareBalanceLeaseHandoff();
            ApiKeyFailoverManager.handleBalanceAuthorityLost(true);
            LeaderElectionService.getOwnedAuthorityTerm = () => term;
            await ApiKeyFailoverManager.becomeBalanceAuthority(term);
            now += 20_000;
            const timer = manager.balanceLeaseRenewalTimers.get(attempt.balanceLeaseId) as NodeJS.Timeout & {
                _onTimeout: () => void;
            };
            assert.ok(timer);
            timer._onTimeout();
            assert.equal(manager.balanceLeases.get(attempt.balanceLeaseId)?.expiresAt, now + 30_000);
        }
        ApiKeyFailoverManager.releaseBalanceLease(attempt.balanceLeaseId, 'leader-new:2');
        assert.ok(manager.balanceLeases.has(attempt.balanceLeaseId));
        assert.ok(manager.balanceLeaseRenewalTimers.has(attempt.balanceLeaseId));
        ApiKeyFailoverManager.releaseBalanceLease(attempt.balanceLeaseId);
        assert.equal(manager.balanceLeases.has(attempt.balanceLeaseId), false);
        assert.equal(manager.balanceLeaseRenewalTimers.has(attempt.balanceLeaseId), false);
    });

    test('stop freezes balance before waiting for the rate-limit snapshot and awaits persistence', async () => {
        registerInterInstanceHandlers(context);
        const attempt = await ApiKeyFailoverManager.captureAttempt('slot', 's:active', 'request-active');
        assert.ok(attempt?.balanceLeaseId);
        const election = LeaderElectionService as unknown as {
            _isLeader: boolean;
            initialized: boolean;
            periodicTasks: Array<() => Promise<void>>;
            startTimer?: NodeJS.Timeout;
            heartbeatTimer?: NodeJS.Timeout;
            taskTimer?: NodeJS.Timeout;
            resignLeader: () => Promise<void>;
        };
        assert.equal(election.startTimer, undefined);
        assert.equal(election.heartbeatTimer, undefined);
        assert.equal(election.taskTimer, undefined);
        const previous = {
            isLeader: election._isLeader,
            initialized: election.initialized,
            tasks: election.periodicTasks,
            resignLeader: election.resignLeader
        };
        let unblock!: () => void;
        let started!: () => void;
        const gate = new Promise<void>(resolve => {
            unblock = resolve;
        });
        const snapshotStarted = new Promise<void>(resolve => {
            started = resolve;
        });
        LeaderElectionService.setRateLimitSnapshotProvider(async () => {
            started();
            await gate;
            return undefined;
        });
        election._isLeader = true;
        election.resignLeader = async () => {};
        const events: unknown[] = [];
        InterInstanceBus.publishIpcOnly = event => {
            events.push(event);
            return true;
        };
        const stopping = LeaderElectionService.stop();
        try {
            await snapshotStarted;
            assert.equal(await ApiKeyFailoverManager.captureAttempt('slot', 's:active', 'during-stop'), undefined);
            assert.deepEqual(events, []);
            unblock();
            await stopping;
            assert.ok(
                (await readBalanceLeaseHandoff())?.leases.some(lease => lease.leaseId === attempt.balanceLeaseId)
            );
            assert.equal(events.length, 1);
            assert.equal((events[0] as { type: string }).type, 'leaderResigning');
        } finally {
            unblock();
            await stopping;
            election._isLeader = previous.isLeader;
            election.initialized = previous.initialized;
            election.periodicTasks = previous.tasks;
            election.resignLeader = previous.resignLeader;
            LeaderElectionService.setRateLimitSnapshotProvider(undefined);
        }
    });
});
