import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as vscode from 'vscode';
import { InterInstanceBus } from '../../../src/interInstance';
import type { ApiKeyBalanceLeaseHandoff } from '../../../src/interInstance/eventProtocol';
import { setBalanceHandoffDirectoryOverride } from '../../../src/interInstance/pathResolver';
import { LeaderElectionService } from '../../../src/status/leaderElectionService';
import { AtomicJsonFile } from '../../../src/usages/atomicJsonFile';
import { ApiKeyManager } from '../../../src/utils/config/apiKeyManager';
import { enqueueConfigSetMutation } from '../../../src/utils/config/configSetCommands';
import { ConfigSetStore } from '../../../src/utils/config/configSetStore';
import { ApiKeyFailoverManager } from '../../../src/utils/config/failover/apiKeyFailoverManager';
import {
    readBalanceLeaseHandoff,
    writeBalanceLeaseHandoff
} from '../../../src/utils/config/failover/balanceLeaseHandoffFile';
import { createContext } from './retryFixture';

const manager = ApiKeyFailoverManager as unknown as {
    balanceLeases: Map<string, { expiresAt: number }>;
};
const balanceKey = Array.from({ length: 100 }, (_, index) => `s:recovery-${index}`).find(
    value => parseInt(createHash('sha256').update(value).digest('hex').slice(0, 8), 16) % 2 === 0
);
assert.ok(balanceKey);

suite('balance recovery renewal boundaries', () => {
    const originalElection = {
        isInitialized: LeaderElectionService.isInitialized,
        isLeader: LeaderElectionService.isLeader,
        isAgentsWindow: LeaderElectionService.isAgentsWindow,
        getOwnedAuthorityTerm: LeaderElectionService.getOwnedAuthorityTerm,
        getInstanceId: LeaderElectionService.getInstanceId
    };
    const originalBus = {
        getAuthorityTerm: InterInstanceBus.getAuthorityTerm,
        publishIpcOnly: InterInstanceBus.publishIpcOnly
    };
    const originalGetApiKey = ConfigSetStore.getApiKey;
    const originalRunExclusive = AtomicJsonFile.runExclusive;
    const originalNow = Date.now;
    let context: vscode.ExtensionContext;
    let start: number;
    let now: number;

    setup(async () => {
        ApiKeyFailoverManager.handleBalanceAuthorityLost();
        setBalanceHandoffDirectoryOverride(mkdtempSync(join(tmpdir(), 'gcmp-balance-recovery-')));
        context = createContext();
        ApiKeyManager.initialize(context);
        ConfigSetStore.initialize(context);
        now = start = originalNow();
        Date.now = () => now;
        Object.assign(LeaderElectionService, {
            isInitialized: () => true,
            isLeader: () => true,
            isAgentsWindow: () => false,
            getOwnedAuthorityTerm: () => 'leader-new:2',
            getInstanceId: () => 'leader-new'
        });
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
        ApiKeyFailoverManager.handleBalanceAuthorityLost();
        for (const disposable of context.subscriptions) {
            disposable.dispose();
        }
        Object.assign(LeaderElectionService, originalElection);
        Object.assign(InterInstanceBus, originalBus);
        ConfigSetStore.getApiKey = originalGetApiKey;
        AtomicJsonFile.runExclusive = originalRunExclusive;
        Date.now = originalNow;
        setBalanceHandoffDirectoryOverride(undefined);
    });

    for (const staged of [false, true]) {
        for (const revision of ['older', 'equal', 'newer'] as const) {
            for (const action of ['empty', 'replace', 'renew'] as const) {
                test(`快照更新顺序：${staged}, ${revision}, ${action}`, async () => {
                    const before: ApiKeyBalanceLeaseHandoff = {
                        sourceAuthorityTerm: 'leader-old:1',
                        capturedAt: start,
                        leases: [
                            {
                                leaseId: 'revision-original',
                                slot: 'slot',
                                balanceKey: 's:revision',
                                configId: 'a',
                                credentialId: createHash('sha256').update('key-a\u0000').digest('hex'),
                                ownerInstanceId: 'follower-a',
                                expiresAt: start + 10_000
                            }
                        ]
                    };
                    const after: ApiKeyBalanceLeaseHandoff = {
                        ...before,
                        capturedAt:
                            start +
                            (revision === 'older' ? -1
                            : revision === 'newer' ? 1
                            : 0),
                        leases:
                            action === 'empty' ? []
                            : action === 'replace' ?
                                [
                                    {
                                        ...before.leases[0],
                                        leaseId: 'revision-replacement',
                                        configId: 'b',
                                        credentialId: createHash('sha256').update('key-b\u0000').digest('hex')
                                    }
                                ]
                            :   [{ ...before.leases[0], expiresAt: start + 25_000 }]
                    };
                    const original = JSON.stringify([before, after]);
                    if (revision !== 'older') {
                        await writeBalanceLeaseHandoff(before);
                    }
                    if (staged) {
                        ApiKeyFailoverManager.stageBalanceLeaseHandoff(
                            before,
                            'leader-old',
                            undefined,
                            before.sourceAuthorityTerm,
                            now
                        );
                    }
                    await writeBalanceLeaseHandoff(after);
                    now = start + 100;
                    assert.deepEqual(await readBalanceLeaseHandoff(), after);
                    await ApiKeyFailoverManager.becomeBalanceAuthority('leader-new:2');
                    const expected = staged && revision === 'older' ? before : after;
                    assert.deepEqual(
                        [...manager.balanceLeases].map(([id, lease]) => ({ id, expiresAt: lease.expiresAt })),
                        expected.leases.map(lease => ({ id: lease.leaseId, expiresAt: lease.expiresAt }))
                    );
                    const persisted = await readBalanceLeaseHandoff();
                    assert.equal(persisted?.sourceAuthorityTerm, 'leader-new:2');
                    assert.deepEqual(persisted?.leases, expected.leases);
                    const next = await ApiKeyFailoverManager.captureAttempt('slot', balanceKey, 'revision-next');
                    assert.equal(next?.activeId, expected.leases.some(lease => lease.configId === 'a') ? 'b' : 'a');
                    assert.equal(JSON.stringify([before, after]), original);
                });
            }
        }
    }

    for (const strict of [false, true]) {
        for (const delta of [0, 1]) {
            for (const action of ['release', 'renew'] as const) {
                for (const storage of ['ok', 'write-fails', 'write-and-read-fail'] as const) {
                    test(`存储失败后的交接恢复：${strict}, ${delta}, ${action}, ${storage}`, async () => {
                        const originalWrite = AtomicJsonFile.writeJsonAtomically;
                        const oldTerm = 'leader-old:2';
                        const oldFile = createHash('sha256').update(oldTerm).digest('hex') + '.json';
                        const storageError = Object.assign(new Error('handoff storage denied'), { code: 'EIO' });
                        let failedWrites = 0;
                        try {
                            LeaderElectionService.getOwnedAuthorityTerm = () => oldTerm;
                            LeaderElectionService.getInstanceId = () => 'leader-old';
                            InterInstanceBus.getAuthorityTerm = () => oldTerm;
                            const initial: ApiKeyBalanceLeaseHandoff = {
                                sourceAuthorityTerm: 'leader-before:1',
                                capturedAt: start,
                                leases: ['a', 'b'].map((id, index) => ({
                                    leaseId: 'stored-' + id,
                                    slot: 'slot',
                                    balanceKey: 's:stored-' + id,
                                    configId: id,
                                    credentialId: createHash('sha256')
                                        .update('key-' + id + '\u0000')
                                        .digest('hex'),
                                    ownerInstanceId: 'follower-a',
                                    expiresAt: start + (index === 0 ? 5_000 : 25_000)
                                }))
                            };
                            await writeBalanceLeaseHandoff(initial);
                            await ApiKeyFailoverManager.becomeBalanceAuthority(oldTerm);
                            const persistedBefore = await readBalanceLeaseHandoff();
                            assert.equal(persistedBefore?.sourceAuthorityTerm, oldTerm);
                            assert.deepEqual(persistedBefore?.leases, initial.leases);
                            now = start + delta;
                            AtomicJsonFile.writeJsonAtomically = async (...args) => {
                                if (storage !== 'ok' && args[0].endsWith(oldFile)) {
                                    failedWrites++;
                                    throw storageError;
                                }
                                return originalWrite.apply(AtomicJsonFile, args);
                            };
                            if (action === 'release') {
                                ApiKeyFailoverManager.handleRemoteBalanceLeaseRelease(
                                    { leaseId: 'stored-b', authorityTerm: oldTerm },
                                    'follower-a'
                                );
                            } else {
                                ApiKeyFailoverManager.handleRemoteBalanceLeaseRenewal(
                                    { leaseId: 'stored-a', authorityTerm: oldTerm },
                                    'follower-a',
                                    now
                                );
                            }
                            const live = ApiKeyFailoverManager.exportBalanceLeaseHandoff(true);
                            assert.ok(live);
                            assert.equal(live.leases.length, action === 'release' ? 1 : 2);
                            if (action === 'renew') {
                                assert.equal(live.leases[0].expiresAt, now + 30_000);
                            }
                            if (strict && storage !== 'ok') {
                                await assert.rejects(
                                    ApiKeyFailoverManager.prepareBalanceLeaseHandoff(strict),
                                    error => error === storageError
                                );
                                assert.ok(failedWrites > 0);
                                return;
                            }
                            const prepared = await ApiKeyFailoverManager.prepareBalanceLeaseHandoff(strict);
                            ApiKeyFailoverManager.handleBalanceAuthorityLost();
                            AtomicJsonFile.writeJsonAtomically = originalWrite;
                            assert.deepEqual(prepared, live);
                            assert.ok(prepared);
                            assert.equal(
                                JSON.stringify(await readBalanceLeaseHandoff()),
                                JSON.stringify(storage === 'ok' ? live : persistedBefore)
                            );
                            const original = JSON.stringify(prepared);
                            LeaderElectionService.getOwnedAuthorityTerm = () => 'leader-new:3';
                            LeaderElectionService.getInstanceId = () => 'leader-new';
                            InterInstanceBus.getAuthorityTerm = () => 'leader-new:3';
                            ApiKeyFailoverManager.stageBalanceLeaseHandoff(
                                prepared,
                                'leader-old',
                                undefined,
                                oldTerm,
                                now
                            );
                            if (storage === 'write-and-read-fail') {
                                AtomicJsonFile.runExclusive = async <T>(
                                    path: string,
                                    task: () => Promise<T>
                                ): Promise<T> => {
                                    if (path.endsWith(oldFile)) {
                                        throw storageError;
                                    }
                                    return (originalRunExclusive<T>).call(AtomicJsonFile, path, task);
                                };
                            }
                            await ApiKeyFailoverManager.becomeBalanceAuthority('leader-new:3');
                            AtomicJsonFile.runExclusive = originalRunExclusive;
                            assert.deepEqual(
                                [...manager.balanceLeases].map(([id, lease]) => ({ id, expiresAt: lease.expiresAt })),
                                live.leases.map(lease => ({ id: lease.leaseId, expiresAt: lease.expiresAt }))
                            );
                            const next = await ApiKeyFailoverManager.captureAttempt('slot', balanceKey, 'storage-next');
                            assert.equal(next?.activeId, action === 'release' ? 'b' : 'a');
                            assert.equal(JSON.stringify(prepared), original);
                            assert.equal(failedWrites > 0, storage !== 'ok');
                        } finally {
                            ApiKeyFailoverManager.handleBalanceAuthorityLost();
                            AtomicJsonFile.writeJsonAtomically = originalWrite;
                            AtomicJsonFile.runExclusive = originalRunExclusive;
                        }
                    });
                }
            }
        }
    }

    for (const latest of ['disk', 'ipc'] as const) {
        for (const offset of [-1, 0, 1]) {
            for (const staleIpc of [false, true]) {
                test(`按序号接管而非按捕获时钟：${latest}, ${offset}, ${staleIpc}`, async () => {
                    const before = {
                        sourceAuthorityTerm: 'leader-old:1',
                        capturedAt: start,
                        revision: 1,
                        leases: [
                            {
                                leaseId: 'revision-a',
                                slot: 'slot',
                                balanceKey: 's:revision-a',
                                configId: 'a',
                                credentialId: createHash('sha256').update('key-a\u0000').digest('hex'),
                                ownerInstanceId: 'follower-a',
                                expiresAt: start + 10_000
                            }
                        ]
                    };
                    const after = { ...before, capturedAt: start + offset, revision: 2, leases: [] };
                    const original = JSON.stringify([before, after]);
                    await writeBalanceLeaseHandoff(latest === 'disk' ? after : before);
                    ApiKeyFailoverManager.stageBalanceLeaseHandoff(
                        latest === 'ipc' ? after : before,
                        'leader-old',
                        undefined,
                        before.sourceAuthorityTerm,
                        now
                    );
                    if (staleIpc) {
                        ApiKeyFailoverManager.stageBalanceLeaseHandoff(
                            before,
                            'leader-old',
                            undefined,
                            before.sourceAuthorityTerm,
                            now
                        );
                    }
                    await ApiKeyFailoverManager.becomeBalanceAuthority('leader-new:2');
                    assert.equal(manager.balanceLeases.size, 0);
                    assert.deepEqual((await readBalanceLeaseHandoff())?.leases, []);
                    assert.equal(
                        (await ApiKeyFailoverManager.captureAttempt('slot', balanceKey, 'revision-next'))?.activeId,
                        'a'
                    );
                    assert.equal(JSON.stringify([before, after]), original);
                });
            }
        }
    }

    for (const aba of [false, true]) {
        test(`快照序号保持稳定并识别状态往返：${aba}`, async () => {
            const attempt = await ApiKeyFailoverManager.captureAttempt('slot', balanceKey, 'revision-capture');
            assert.ok(attempt?.balanceLeaseId);
            const first = ApiKeyFailoverManager.exportBalanceLeaseHandoff(true);
            assert.ok(first && 'revision' in first && typeof first.revision === 'number');
            assert.ok(Number.isSafeInteger(first.revision) && first.revision > 0);
            assert.deepEqual(ApiKeyFailoverManager.exportBalanceLeaseHandoff(true), first);
            assert.equal(ApiKeyFailoverManager.isBalanceLeaseHandoffCurrent(first), true);
            const lease = manager.balanceLeases.get(attempt.balanceLeaseId);
            assert.ok(lease);
            lease.expiresAt -= 1_000;
            const second = ApiKeyFailoverManager.exportBalanceLeaseHandoff(true);
            assert.ok(second && 'revision' in second && typeof second.revision === 'number');
            assert.ok(second.revision > first.revision);
            assert.equal(second.capturedAt, first.capturedAt);
            if (aba) {
                lease.expiresAt += 1_000;
            }
            const current = ApiKeyFailoverManager.exportBalanceLeaseHandoff(true);
            assert.ok(current && 'revision' in current && typeof current.revision === 'number');
            assert.equal(current.revision, second.revision + (aba ? 1 : 0));
            assert.equal(ApiKeyFailoverManager.isBalanceLeaseHandoffCurrent(first), false);
            assert.equal(ApiKeyFailoverManager.isBalanceLeaseHandoffCurrent(current), true);
            assert.deepEqual(first.leases[0].expiresAt, start + 30_000);
        });
    }

    for (const legacy of ['disk', 'ipc'] as const) {
        for (const latest of ['disk', 'ipc'] as const) {
            test(`新旧协议混用保持时间兼容：${legacy}, ${latest}`, async () => {
                const leases = [
                    {
                        leaseId: 'legacy-a',
                        slot: 'slot',
                        balanceKey: 's:legacy-a',
                        configId: 'a',
                        credentialId: createHash('sha256').update('key-a\u0000').digest('hex'),
                        ownerInstanceId: 'follower-a',
                        expiresAt: start + 10_000
                    }
                ];
                const disk = {
                    sourceAuthorityTerm: 'leader-old:1',
                    capturedAt: start + (latest === 'disk' ? 1 : 0),
                    ...(legacy === 'disk' ? {} : { revision: 10 }),
                    leases: latest === 'disk' ? leases : []
                };
                const ipc = {
                    sourceAuthorityTerm: 'leader-old:1',
                    capturedAt: start + (latest === 'ipc' ? 1 : 0),
                    ...(legacy === 'ipc' ? {} : { revision: 10 }),
                    leases: latest === 'ipc' ? leases : []
                };
                await writeBalanceLeaseHandoff(disk);
                ApiKeyFailoverManager.stageBalanceLeaseHandoff(
                    ipc,
                    'leader-old',
                    undefined,
                    ipc.sourceAuthorityTerm,
                    now
                );
                await ApiKeyFailoverManager.becomeBalanceAuthority('leader-new:2');
                assert.equal(manager.balanceLeases.size, 1);
                assert.ok(manager.balanceLeases.has('legacy-a'));
                assert.equal(
                    (await ApiKeyFailoverManager.captureAttempt('slot', balanceKey, 'legacy-next'))?.activeId,
                    'b'
                );
            });
        }
    }

    for (const phase of ['queue', 'disk'] as const) {
        for (const source of ['cold', 'staged'] as const) {
            for (const action of ['unchanged', 'refreshed', 'empty', 'future'] as const) {
                test(`snapshot observation: ${phase}, ${source}, ${action}`, async () => {
                    const snapshot: ApiKeyBalanceLeaseHandoff = {
                        sourceAuthorityTerm: 'leader-old:1',
                        capturedAt: start - 25_000,
                        leases: [
                            {
                                leaseId: 'observed-lease',
                                slot: 'slot',
                                balanceKey: 's:observed',
                                configId: 'a',
                                credentialId: createHash('sha256').update('key-a\u0000').digest('hex'),
                                ownerInstanceId: 'follower-a',
                                expiresAt: start + 5_000
                            }
                        ]
                    };
                    await writeBalanceLeaseHandoff(snapshot);
                    if (source === 'staged') {
                        ApiKeyFailoverManager.stageBalanceLeaseHandoff(
                            snapshot,
                            'leader-old',
                            undefined,
                            'leader-old:1',
                            now
                        );
                    }
                    let unblock!: () => void;
                    let started!: () => void;
                    const gate = new Promise<void>(resolve => {
                        unblock = resolve;
                    });
                    const blocked = new Promise<void>(resolve => {
                        started = resolve;
                    });
                    let blocking: Promise<void> | undefined;
                    if (phase === 'queue') {
                        blocking = enqueueConfigSetMutation(async () => {
                            started();
                            await gate;
                        });
                    } else {
                        let firstRead = true;
                        AtomicJsonFile.runExclusive = async <T>(path: string, task: () => Promise<T>): Promise<T> => {
                            if (firstRead) {
                                firstRead = false;
                                started();
                                await gate;
                            }
                            return (originalRunExclusive<T>).call(AtomicJsonFile, path, task);
                        };
                    }
                    const becoming = ApiKeyFailoverManager.becomeBalanceAuthority('leader-new:2');
                    try {
                        await Promise.race([
                            blocked,
                            becoming.then(() => {
                                throw new Error('Recovery did not reach the observation boundary');
                            })
                        ]);
                        now = start + 2_500;
                        ApiKeyFailoverManager.handleRemoteBalanceLeaseRenewal(
                            { leaseId: 'observed-lease', authorityTerm: 'leader-new:2' },
                            'follower-a'
                        );
                        if (action !== 'unchanged') {
                            await writeBalanceLeaseHandoff({
                                ...snapshot,
                                capturedAt: action === 'future' ? start + 10_000 : now,
                                leases: action === 'empty' ? [] : snapshot.leases
                            });
                        }
                        now = start + 5_500;
                        unblock();
                        await becoming;
                        await new Promise<void>(resolve => setImmediate(resolve));
                        const next = await ApiKeyFailoverManager.captureAttempt('slot', balanceKey, 'observation-next');
                        const restored = manager.balanceLeases.get('observed-lease');
                        const expected =
                            action === 'empty' ? false
                            : action === 'future' ? source === 'staged'
                            : true;
                        assert.equal(!!restored, expected);
                        assert.equal(next?.activeId, expected ? 'b' : 'a');
                        if (restored) {
                            assert.equal(restored.expiresAt, start + 32_500);
                        }
                        assert.equal(snapshot.leases[0].expiresAt, start + 5_000);
                    } finally {
                        unblock();
                        await blocking;
                        await becoming;
                    }
                });
            }
        }
    }

    for (const phase of ['queue', 'disk', 'secret'] as const) {
        for (const origin of ['local', 'remote'] as const) {
            for (const action of [
                'fresh',
                'aged',
                'repeated',
                'no-renewal',
                'expired-renewal',
                'wrong-owner',
                'wrong-term',
                'released',
                'newer-empty',
                'newer-capture',
                'stale',
                'future',
                'lost'
            ] as const) {
                if (phase === 'secret' && ['newer-empty', 'stale', 'future'].includes(action)) {
                    continue;
                }
                if (action === 'newer-capture' && phase !== 'queue') {
                    continue;
                }
                if (action === 'wrong-owner' && origin === 'local') {
                    continue;
                }
                test(`snapshot admission: ${phase}, ${origin}, ${action}`, async () => {
                    const owner = origin === 'local' ? 'leader-new' : 'follower-a';
                    const capturedAt =
                        action === 'fresh' ? start
                        : action === 'stale' ? start - 31_001
                        : action === 'future' ? start + 10_000
                        : start - 25_000;
                    const expiresAt = action === 'stale' ? capturedAt + 30_000 : start + 5_000;
                    const snapshot: ApiKeyBalanceLeaseHandoff = {
                        sourceAuthorityTerm: 'leader-old:1',
                        capturedAt,
                        leases: [
                            {
                                leaseId: 'admitted-lease',
                                slot: 'slot',
                                balanceKey: 's:admitted',
                                configId: 'a',
                                credentialId: createHash('sha256').update('key-a\u0000').digest('hex'),
                                ownerInstanceId: owner,
                                expiresAt
                            }
                        ]
                    };
                    await writeBalanceLeaseHandoff(snapshot);
                    if (action === 'newer-empty') {
                        await writeBalanceLeaseHandoff({ ...snapshot, capturedAt: start, leases: [] });
                    }
                    let unblock!: () => void;
                    let started!: () => void;
                    const gate = new Promise<void>(resolve => {
                        unblock = resolve;
                    });
                    const boundaryStarted = new Promise<void>(resolve => {
                        started = resolve;
                    });
                    let blocker: Promise<void> | undefined;
                    let blockNext = true;
                    if (phase === 'queue') {
                        blocker = enqueueConfigSetMutation(async () => {
                            started();
                            await gate;
                        });
                    } else if (phase === 'disk') {
                        AtomicJsonFile.runExclusive = async <T>(path: string, task: () => Promise<T>): Promise<T> => {
                            if (blockNext) {
                                blockNext = false;
                                started();
                                await gate;
                            }
                            return (originalRunExclusive<T>).call(AtomicJsonFile, path, task);
                        };
                    } else {
                        ConfigSetStore.getApiKey = async (...args) => {
                            const key = await originalGetApiKey.apply(ConfigSetStore, args);
                            if (blockNext) {
                                blockNext = false;
                                started();
                                await gate;
                            }
                            return key;
                        };
                    }
                    const becoming = ApiKeyFailoverManager.becomeBalanceAuthority('leader-new:2');
                    try {
                        await Promise.race([
                            boundaryStarted,
                            becoming.then(() => {
                                throw new Error('Recovery did not reach the admission boundary');
                            })
                        ]);
                        now = start + (action === 'expired-renewal' ? 5_000 : 2_500);
                        const renew = () => {
                            const authorityTerm = action === 'wrong-term' ? 'other:3' : 'leader-new:2';
                            if (origin === 'local') {
                                ApiKeyFailoverManager.renewBalanceLease('admitted-lease', authorityTerm);
                            } else {
                                ApiKeyFailoverManager.handleRemoteBalanceLeaseRenewal(
                                    { leaseId: 'admitted-lease', authorityTerm },
                                    action === 'wrong-owner' ? 'other-owner' : owner
                                );
                            }
                        };
                        if (action !== 'no-renewal') {
                            renew();
                        }
                        if (action === 'repeated') {
                            now = start + 6_000;
                            renew();
                        } else if (action === 'released') {
                            if (origin === 'local') {
                                ApiKeyFailoverManager.releaseBalanceLease('admitted-lease', 'leader-new:2');
                            } else {
                                ApiKeyFailoverManager.handleRemoteBalanceLeaseRelease(
                                    { leaseId: 'admitted-lease', authorityTerm: 'leader-new:2' },
                                    owner
                                );
                            }
                        } else if (action === 'newer-capture') {
                            await writeBalanceLeaseHandoff({ ...snapshot, capturedAt: now });
                        } else if (action === 'lost') {
                            LeaderElectionService.isLeader = () => false;
                            LeaderElectionService.getOwnedAuthorityTerm = () => undefined;
                            ApiKeyFailoverManager.handleBalanceAuthorityLost(true);
                        }
                        now = start + (action === 'repeated' ? 6_500 : 5_500);
                        unblock();
                        await becoming;
                        await new Promise<void>(resolve => setImmediate(resolve));
                        const restored = manager.balanceLeases.get('admitted-lease');
                        const survives = ['fresh', 'aged', 'repeated', 'newer-capture'].includes(action);
                        assert.equal(!!restored, survives);
                        if (survives) {
                            assert.equal(restored?.expiresAt, start + (action === 'repeated' ? 36_000 : 32_500));
                        }
                        assert.equal(snapshot.leases[0].expiresAt, expiresAt);
                        if (action !== 'lost') {
                            const next = await ApiKeyFailoverManager.captureAttempt(
                                'slot',
                                balanceKey,
                                'admission-next'
                            );
                            assert.equal(next?.activeId, survives ? 'b' : 'a');
                        }
                    } finally {
                        unblock();
                        await blocker;
                        await becoming;
                    }
                });
            }
        }
    }

    for (const phase of ['disk', 'secret'] as const) {
        for (const origin of ['local', 'remote'] as const) {
            for (const action of [
                'before-expiry',
                'valid-renewal',
                'repeated-renewal',
                'no-renewal',
                'expired-renewal',
                'wrong-owner',
                'wrong-term',
                'old-term',
                'release-before-renewal',
                'release-after-renewal',
                'mode-cycle',
                'lose-authority',
                'newer-empty-snapshot',
                'renewal-expired'
            ] as const) {
                if (origin === 'local' && (action === 'wrong-owner' || action === 'old-term')) {
                    continue;
                }
                if (phase === 'secret' && action === 'newer-empty-snapshot') {
                    continue;
                }
                test(`${phase}, ${origin}: ${action} during recovery`, async () => {
                    const owner = origin === 'local' ? 'leader-new' : 'follower-a';
                    const snapshot: ApiKeyBalanceLeaseHandoff = {
                        sourceAuthorityTerm: 'leader-old:1',
                        capturedAt: now,
                        leases: [
                            {
                                leaseId: 'active-lease',
                                slot: 'slot',
                                balanceKey: 's:active',
                                configId: 'a',
                                credentialId: createHash('sha256').update('key-a\u0000').digest('hex'),
                                ownerInstanceId: owner,
                                expiresAt: now + 5_000
                            }
                        ]
                    };
                    await writeBalanceLeaseHandoff(snapshot);
                    ApiKeyFailoverManager.stageBalanceLeaseHandoff(
                        snapshot,
                        'leader-old',
                        undefined,
                        snapshot.sourceAuthorityTerm,
                        now
                    );
                    if (action === 'newer-empty-snapshot') {
                        await writeBalanceLeaseHandoff({ ...snapshot, capturedAt: now + 1, leases: [] });
                    }
                    let unblock!: () => void;
                    let started!: () => void;
                    const gate = new Promise<void>(resolve => {
                        unblock = resolve;
                    });
                    const boundaryStarted = new Promise<void>(resolve => {
                        started = resolve;
                    });
                    let blockNext = true;
                    if (phase === 'disk') {
                        AtomicJsonFile.runExclusive = async <T>(path: string, task: () => Promise<T>): Promise<T> => {
                            if (blockNext) {
                                blockNext = false;
                                started();
                                await gate;
                            }
                            return (originalRunExclusive<T>).call(AtomicJsonFile, path, task);
                        };
                    } else {
                        ConfigSetStore.getApiKey = async (...args) => {
                            const key = await originalGetApiKey.apply(ConfigSetStore, args);
                            if (blockNext) {
                                blockNext = false;
                                started();
                                await gate;
                            }
                            return key;
                        };
                    }
                    const becoming = ApiKeyFailoverManager.becomeBalanceAuthority('leader-new:2');
                    try {
                        await Promise.race([
                            boundaryStarted,
                            becoming.then(() => {
                                throw new Error('Recovery did not reach the blocked boundary');
                            })
                        ]);
                        now = start + (action === 'expired-renewal' ? 5_000 : 2_500);
                        const release = () => {
                            if (origin === 'local') {
                                ApiKeyFailoverManager.releaseBalanceLease('active-lease', 'leader-new:2');
                            } else {
                                ApiKeyFailoverManager.handleRemoteBalanceLeaseRelease(
                                    { leaseId: 'active-lease', authorityTerm: 'leader-new:2' },
                                    owner
                                );
                            }
                        };
                        const renew = () => {
                            const term =
                                action === 'wrong-term' ? 'other:3'
                                : action === 'old-term' ? 'leader-old:1'
                                : 'leader-new:2';
                            if (origin === 'local') {
                                ApiKeyFailoverManager.renewBalanceLease('active-lease', term);
                            } else {
                                ApiKeyFailoverManager.handleRemoteBalanceLeaseRenewal(
                                    { leaseId: 'active-lease', authorityTerm: term },
                                    action === 'wrong-owner' ? 'wrong-owner' : owner
                                );
                            }
                        };
                        if (action === 'release-before-renewal') {
                            release();
                        }
                        if (action !== 'no-renewal') {
                            renew();
                        }
                        if (action === 'repeated-renewal') {
                            now = start + 6_000;
                            renew();
                        } else if (action === 'release-after-renewal') {
                            release();
                        } else if (action === 'mode-cycle') {
                            await ConfigSetStore.setSwitchMode('slot', 'off');
                            ApiKeyFailoverManager.handleBalanceModeChanged('slot');
                            await ConfigSetStore.setSwitchMode('slot', 'balance');
                            ApiKeyFailoverManager.handleBalanceModeChanged('slot');
                        } else if (action === 'lose-authority') {
                            LeaderElectionService.isLeader = () => false;
                            LeaderElectionService.getOwnedAuthorityTerm = () => undefined;
                            ApiKeyFailoverManager.handleBalanceAuthorityLost(true);
                        }
                        now =
                            start +
                            (action === 'before-expiry' ? 3_500
                            : action === 'repeated-renewal' ? 6_500
                            : action === 'renewal-expired' ? 33_000
                            : 5_500);
                        unblock();
                        await becoming;
                        await new Promise<void>(resolve => setImmediate(resolve));
                        const restored = manager.balanceLeases.get('active-lease');
                        const survives = ['before-expiry', 'valid-renewal', 'repeated-renewal'].includes(action);
                        assert.equal(!!restored, survives);
                        if (survives) {
                            assert.equal(
                                restored?.expiresAt,
                                start + (action === 'repeated-renewal' ? 36_000 : 32_500)
                            );
                        }
                        assert.equal(snapshot.leases[0].expiresAt, start + 5_000, 'source handoff must not be mutated');
                        if (action !== 'lose-authority') {
                            const next = await ApiKeyFailoverManager.captureAttempt('slot', balanceKey, 'new-request');
                            assert.equal(next?.activeId, survives ? 'b' : 'a');
                        }
                    } finally {
                        unblock();
                        await becoming;
                    }
                });
            }
        }
    }
});
