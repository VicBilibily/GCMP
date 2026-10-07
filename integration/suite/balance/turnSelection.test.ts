import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { InterInstanceBus } from '../../../src/interInstance';
import { registerInterInstanceHandlers } from '../../../src/interInstance/activation';
import type {
    ApiKeyBalanceAssignmentRequestedEvent,
    ApiKeyBalanceAssignmentResolvedEvent,
    ApiKeyBalanceLeaseReleasedEvent
} from '../../../src/interInstance/eventProtocol';
import { setBalanceHandoffDirectoryOverride } from '../../../src/interInstance/pathResolver';
import { LeaderElectionService } from '../../../src/status/leaderElectionService';
import { ApiKeyManager } from '../../../src/utils/config/apiKeyManager';
import { ConfigManager } from '../../../src/utils/config/configManager';
import { ConfigSetStore } from '../../../src/utils/config/configSetStore';
import {
    ApiKeyFailoverManager,
    type ApiKeyFailoverAttempt
} from '../../../src/utils/config/failover/apiKeyFailoverManager';
import { BalanceAffinityCache } from '../../../src/utils/config/failover/balanceAffinityCache';
import {
    RetryProvider,
    createContext,
    defaultRetry,
    identity,
    slot,
    successResponse,
    trackedCancellation
} from './retryFixture';

type AssignmentRequest = ApiKeyBalanceAssignmentRequestedEvent['payload'];
type Assignment = ApiKeyBalanceAssignmentResolvedEvent['payload'];
const positiveWeightError = /positive[- ]weight|正权重/i;
const hash = (balanceKey: string) =>
    Number.parseInt(createHash('sha256').update(balanceKey).digest('hex').slice(0, 8), 16);

suite('balance weighted turn selection', () => {
    const originalElection = {
        isInitialized: LeaderElectionService.isInitialized,
        isLeader: LeaderElectionService.isLeader,
        isAgentsWindow: LeaderElectionService.isAgentsWindow,
        getOwnedAuthorityTerm: LeaderElectionService.getOwnedAuthorityTerm,
        getAuthorityTerm: LeaderElectionService.getAuthorityTerm,
        getLeaderId: LeaderElectionService.getLeaderId,
        getInstanceId: LeaderElectionService.getInstanceId
    };
    const originalBus = {
        getAuthorityTerm: InterInstanceBus.getAuthorityTerm,
        hasActiveTransport: InterInstanceBus.hasActiveTransport,
        isAuthorityTransitioning: InterInstanceBus.isAuthorityTransitioning,
        publishIpcOnly: InterInstanceBus.publishIpcOnly
    };
    const originalFetch = ConfigManager.createProxyAwareFetch;
    const manager = ApiKeyFailoverManager as unknown as {
        balanceLeases: Map<string, { credentialId: string; authorityTerm: string }>;
        balanceAttemptSnapshots: Map<string, { attempt: ApiKeyFailoverAttempt }>;
        pendingBalanceAssignments: Map<string, unknown>;
    };
    let context: ReturnType<typeof createContext>;
    let term: string;
    let requests: AssignmentRequest[];
    let releases: ApiKeyBalanceLeaseReleasedEvent['payload'][];

    setup(async () => {
        ApiKeyFailoverManager.handleBalanceAuthorityLost();
        BalanceAffinityCache.instance.clear();
        setBalanceHandoffDirectoryOverride(mkdtempSync(join(tmpdir(), 'gcmp-turn-selection-')));
        term = 'turn-selection-leader:1';
        requests = [];
        releases = [];
        Object.assign(LeaderElectionService, {
            isInitialized: () => true,
            isLeader: () => true,
            isAgentsWindow: () => false,
            getOwnedAuthorityTerm: () => term,
            getAuthorityTerm: () => term,
            getLeaderId: () => 'turn-selection-leader',
            getInstanceId: () => 'turn-selection-leader'
        });
        InterInstanceBus.getAuthorityTerm = () => term;
        InterInstanceBus.hasActiveTransport = () => true;
        InterInstanceBus.isAuthorityTransitioning = () => false;
        InterInstanceBus.publishIpcOnly = () => true;
        context = createContext();
        ApiKeyManager.initialize(context);
        ConfigSetStore.initialize(context);
        for (const id of ['a', 'b', 'c']) {
            await ConfigSetStore.add(slot, { id, label: id }, `key-${id}`);
        }
        await ConfigSetStore.setActive(slot, 'a');
        await ApiKeyManager.setApiKey(slot, 'key-a');
        await ConfigSetStore.setSwitchMode(slot, 'balance');
    });

    teardown(() => {
        ApiKeyFailoverManager.handleBalanceAuthorityLost();
        BalanceAffinityCache.instance.clear();
        setBalanceHandoffDirectoryOverride(undefined);
        for (const disposable of context.subscriptions) {
            disposable.dispose();
        }
        Object.assign(LeaderElectionService, originalElection);
        Object.assign(InterInstanceBus, originalBus);
        ConfigManager.createProxyAwareFetch = originalFetch;
    });

    async function setWeights(a: number | undefined, b: number | undefined, c: number | undefined) {
        const weights = [a, b, c];
        for (const [index, id] of ['a', 'b', 'c'].entries()) {
            await ConfigSetStore.updateMeta(slot, id, { balanceWeight: weights[index] });
        }
    }

    function remoteRequest(requestId: string, preferredCredentialId?: string): AssignmentRequest {
        return {
            requestId,
            requestedBy: 'turn-follower',
            authorityTerm: term,
            slot,
            balanceKey: `m:${requestId}`,
            ...(preferredCredentialId ? { preferredCredentialId } : {})
        };
    }

    function follow(reply: (request: AssignmentRequest) => Assignment) {
        LeaderElectionService.isLeader = () => false;
        LeaderElectionService.getOwnedAuthorityTerm = () => undefined;
        LeaderElectionService.getInstanceId = () => 'turn-follower';
        InterInstanceBus.publishIpcOnly = event => {
            if (event.type === 'apiKeyBalanceAssignmentRequested') {
                const request = event.payload as AssignmentRequest;
                requests.push(request);
                queueMicrotask(() => ApiKeyFailoverManager.resolveBalanceAssignment(reply(request)));
            } else if (event.type === 'apiKeyBalanceLeaseReleased') {
                releases.push(event.payload as ApiKeyBalanceLeaseReleasedEvent['payload']);
            }
            return true;
        };
    }

    function dispatchAssignment(payload: unknown, senderInstanceId = 'turn-selection-leader', timestamp = Date.now()) {
        const bus = InterInstanceBus as unknown as {
            handlers: Map<
                string,
                Set<(event: { type: string; senderInstanceId: string; timestamp: number; payload: unknown }) => void>
            >;
        };
        const handlers = bus.handlers.get('apiKeyBalanceAssignmentResolved');
        assert.ok(handlers?.size);
        for (const handler of handlers) {
            handler({ type: 'apiKeyBalanceAssignmentResolved', senderInstanceId, timestamp, payload });
        }
    }

    for (const flag of ['weightBlocked', 'assignmentInvalidated'] as const) {
        test(`registered AssignmentResolved handlers preserve boolean ${flag} and reject malformed values`, () => {
            registerInterInstanceHandlers(context);
            const originalResolve = ApiKeyFailoverManager.resolveBalanceAssignment;
            const received: Assignment[] = [];
            ApiKeyFailoverManager.resolveBalanceAssignment = payload => {
                received.push(payload);
            };
            const base: Assignment = {
                requestId: 'ipc-weight-validation',
                targetInstanceId: 'turn-selection-leader',
                authorityTerm: term,
                handled: false
            };
            try {
                for (const handled of [true, false]) {
                    const payloads = [
                        { ...base, handled },
                        ...[true, false, undefined, 'true', 'false', '', null, 0, 1, Number.NaN, [], {}].map(value => ({
                            ...base,
                            handled,
                            [flag]: value
                        }))
                    ];
                    for (const payload of payloads) {
                        const before = received.length;
                        dispatchAssignment(payload);
                        const value = flag in payload ? payload[flag as keyof typeof payload] : undefined;
                        const accepted = value === undefined || typeof value === 'boolean';
                        assert.equal(received.length - before, accepted ? 1 : 0, `${flag}: ${String(value)}`);
                        if (accepted) {
                            assert.strictEqual(received.at(-1), payload);
                            assert.equal(received.at(-1)?.[flag], value);
                        }
                    }
                }
            } finally {
                ApiKeyFailoverManager.resolveBalanceAssignment = originalResolve;
            }
        });
    }

    test('registered AssignmentResolved handlers retain source, term, target and pending request guards', async () => {
        LeaderElectionService.isLeader = () => false;
        LeaderElectionService.getOwnedAuthorityTerm = () => undefined;
        LeaderElectionService.getInstanceId = () => 'turn-follower';
        registerInterInstanceHandlers(context);
        const published = new Promise<AssignmentRequest>(resolve => {
            InterInstanceBus.publishIpcOnly = event => {
                if (event.type === 'apiKeyBalanceAssignmentRequested') {
                    resolve(event.payload as AssignmentRequest);
                }
                return true;
            };
        });
        const cancellation = trackedCancellation();
        let fallbacks = 0;
        const pending = ApiKeyFailoverManager.captureAttempt(
            slot,
            'm:ipc-guards',
            'ipc-guards',
            undefined,
            cancellation.token,
            () => fallbacks++
        );
        try {
            const request = await published;
            const payload: Assignment = {
                requestId: request.requestId,
                targetInstanceId: request.requestedBy,
                authorityTerm: request.authorityTerm,
                handled: false,
                weightBlocked: true,
                assignmentInvalidated: true
            };
            for (const [reply, sender, timestamp] of [
                [payload, 'impostor', Date.now()],
                [{ ...payload, authorityTerm: 'turn-selection-leader:0' }, 'turn-selection-leader', Date.now()],
                [{ ...payload, targetInstanceId: 'other-follower' }, 'turn-selection-leader', Date.now()],
                [{ ...payload, requestId: '' }, 'turn-selection-leader', Date.now()],
                [{ ...payload, requestId: null }, 'turn-selection-leader', Date.now()],
                [{ ...payload, requestId: 1 }, 'turn-selection-leader', Date.now()],
                [{ ...payload, requestId: 'x'.repeat(129) }, 'turn-selection-leader', Date.now()],
                [{ ...payload, requestId: 'unrelated-request' }, 'turn-selection-leader', Date.now()],
                [payload, 'turn-selection-leader', Number.NaN],
                [payload, 'turn-selection-leader', Date.now() - 20_000],
                [payload, 'turn-selection-leader', Date.now() + 20_000]
            ] as const) {
                dispatchAssignment(reply, sender, timestamp);
                assert.equal(manager.pendingBalanceAssignments.has(request.requestId), true);
                assert.equal(manager.pendingBalanceAssignments.size, 1);
            }
            dispatchAssignment({ ...payload, weightBlocked: false });
            assert.equal(await pending, undefined);
            assert.equal(fallbacks, 0);
            assert.equal(manager.pendingBalanceAssignments.size, 0);
            assert.equal(manager.balanceAttemptSnapshots.size, 0);
        } finally {
            cancellation.cancel();
            await pending;
            cancellation.dispose();
        }
    });

    for (const mode of ['balance', 'failover'] as const) {
        for (const shape of ['single-config', 'single-key-aliases'] as const) {
            test(`${mode}: availability distinguishes a single Key from failover candidates: ${shape}`, async () => {
                if (shape === 'single-config') {
                    await ConfigSetStore.remove(slot, 'b');
                    await ConfigSetStore.remove(slot, 'c');
                } else {
                    await ConfigSetStore.setApiKey(slot, 'b', 'key-a');
                    await ConfigSetStore.setApiKey(slot, 'c', 'key-a');
                }
                await ConfigSetStore.setSwitchMode(slot, mode);
                assert.equal(await ApiKeyFailoverManager.canEnableAutoSwitch(slot, 'balance'), true);
                assert.equal(await ApiKeyFailoverManager.canEnableAutoSwitch(slot, 'failover'), false);
                assert.equal(await ApiKeyFailoverManager.canEnableAutoSwitch(slot), false);
                assert.equal(await ApiKeyFailoverManager.disableIfUnavailable(slot), mode === 'failover');
                assert.equal(ConfigSetStore.getSwitchMode(slot), mode === 'balance' ? 'balance' : 'off');
                assert.equal(ConfigSetStore.isAutoSwitchEnabled(slot), mode === 'balance');
                assert.equal(await ApiKeyManager.getApiKey(slot), 'key-a');
            });
        }
    }

    for (const weight of [undefined, 1, 3, 100]) {
        test(`equal idle weights retain the legacy hash index: ${weight ?? 'default'}`, async () => {
            await setWeights(weight, weight, weight);
            const counts = [0, 0, 0];
            for (let index = 0; index < 96; index++) {
                const balanceKey = `m:equal-${index}`;
                const expectedIndex = hash(balanceKey) % 3;
                const attempt = await ApiKeyFailoverManager.captureAttempt(slot, balanceKey);
                assert.ok(attempt);
                assert.equal(attempt.apiKey, `key-${['a', 'b', 'c'][expectedIndex]}`);
                counts[expectedIndex]++;
            }
            assert.ok(counts.every(count => count > 0));
            assert.equal(manager.balanceLeases.size, 0);
        });
    }

    test('idle 1:3 selection uses weighted hash buckets rather than an equal split', async () => {
        await setWeights(1, 3, 0);
        const counts = { a: 0, b: 0 };
        for (let index = 0; index < 256; index++) {
            const balanceKey = `m:weighted-idle-${index}`;
            const expected = hash(balanceKey) % 4 === 0 ? 'a' : 'b';
            const attempt = await ApiKeyFailoverManager.captureAttempt(slot, balanceKey);
            assert.equal(attempt?.identity, identity(`key-${expected}`));
            counts[expected]++;
        }
        assert.equal(counts.a + counts.b, 256);
        assert.ok(Math.abs(counts.a / 256 - 0.25) < 0.08, JSON.stringify(counts));
        assert.equal(manager.balanceLeases.size, 0);
    });

    test('concurrent leases converge on equal activeLeaseCount/weight', async () => {
        await setWeights(1, 3, 0);
        const attempts = await Promise.all(
            Array.from({ length: 16 }, (_, index) =>
                ApiKeyFailoverManager.captureAttempt(slot, `m:concurrent-${index}`, `concurrent-${index}`)
            )
        );
        const counts = { a: 0, b: 0 };
        const leaseIds = new Set<string>();
        for (const attempt of attempts) {
            assert.ok(attempt?.balanceLeaseId);
            assert.ok(attempt.apiKey === 'key-a' || attempt.apiKey === 'key-b');
            counts[attempt.apiKey === 'key-a' ? 'a' : 'b']++;
            leaseIds.add(attempt.balanceLeaseId);
        }
        assert.deepEqual(counts, { a: 4, b: 12 });
        assert.equal(counts.a, counts.b / 3);
        assert.equal(leaseIds.size, 16);
        assert.equal(manager.balanceLeases.size, 16);
        for (const leaseId of leaseIds) {
            ApiKeyFailoverManager.releaseBalanceLease(leaseId);
        }
        assert.equal(manager.balanceLeases.size, 0);
    });

    test('normalized load beats raw counts and equal normalized load uses weighted buckets', async () => {
        await setWeights(1, 3, 0);
        for (const [index, id] of ['a', 'b', 'b'].entries()) {
            const busy = await ApiKeyFailoverManager.captureAttempt(
                slot,
                `m:load-${index}`,
                `load-${index}`,
                identity(`key-${id}`)
            );
            assert.equal(busy?.identity, identity(`key-${id}`));
            assert.ok(busy?.balanceLeaseId);
        }
        assert.equal((await ApiKeyFailoverManager.captureAttempt(slot, 'm:normalized'))?.apiKey, 'key-b');
        const thirdB = await ApiKeyFailoverManager.captureAttempt(slot, 'm:tie-b', 'tie-b', identity('key-b'));
        assert.ok(thirdB?.balanceLeaseId);
        for (let index = 0; index < 32; index++) {
            const balanceKey = `m:normalized-tie-${index}`;
            const expected = hash(balanceKey) % 4 === 0 ? 'key-a' : 'key-b';
            assert.equal((await ApiKeyFailoverManager.captureAttempt(slot, balanceKey))?.apiKey, expected);
        }
        assert.equal(manager.balanceLeases.size, 4);
    });

    test('current-turn preferred affinity wins over load but cannot bypass a zero weight', async () => {
        await setWeights(1, 3, 0);
        const busy = await ApiKeyFailoverManager.captureAttempt(slot, 'm:busy', 'busy', identity('key-a'));
        assert.ok(busy?.balanceLeaseId);
        const sticky = await ApiKeyFailoverManager.captureAttempt(slot, 'm:sticky', 'sticky', identity('key-a'));
        assert.equal(sticky?.identity, identity('key-a'));
        await ConfigSetStore.updateMeta(slot, 'a', { balanceWeight: 0 });
        const next = await ApiKeyFailoverManager.captureAttempt(slot, 'm:sticky', 'new-request', identity('key-a'));
        assert.ok(next?.balanceLeaseId);
        assert.equal(next.apiKey, 'key-b');
        assert.strictEqual(await ApiKeyFailoverManager.captureAttempt(slot, 'm:sticky', 'sticky'), sticky);
    });

    for (const action of ['single-positive', 'single-config', 'single-credential'] as const) {
        test(`one positive credential remains assignable: ${action}`, async () => {
            if (action === 'single-positive') {
                await setWeights(0, 3, 0);
            } else if (action === 'single-config') {
                await ConfigSetStore.remove(slot, 'b');
                await ConfigSetStore.remove(slot, 'c');
            } else {
                await ConfigSetStore.setApiKey(slot, 'b', 'key-a');
                await ConfigSetStore.setApiKey(slot, 'c', 'key-a');
                await setWeights(0, 0, 3);
            }
            const expected = action === 'single-positive' ? 'key-b' : 'key-a';
            const attempt = await ApiKeyFailoverManager.captureAttempt(slot, 'm:single', 'single', identity('key-a'));
            assert.ok(attempt?.balanceLeaseId);
            assert.equal(attempt.apiKey, expected);
            assert.strictEqual(await ApiKeyFailoverManager.captureAttempt(slot, 'm:single', 'single'), attempt);
            const assigned = await ApiKeyFailoverManager.handleBalanceAssignmentRequest(
                remoteRequest('single-remote', identity('key-a')),
                'turn-follower'
            );
            assert.equal(assigned?.handled, true);
            assert.equal(assigned?.credentialId, identity(expected));
            assert.ok(assigned?.leaseId);
            assert.notEqual(assigned.leaseId, attempt.balanceLeaseId);
            assert.equal(await ApiKeyManager.getApiKey(slot), 'key-a');
        });
    }

    for (const requestId of [undefined, 'all-zero']) {
        test(`all-zero new local requests fail explicitly: ${requestId ?? 'without lease'}`, async () => {
            await setWeights(0, 0, 0);
            await assert.rejects(
                () => ApiKeyFailoverManager.captureAttempt(slot, 'm:all-zero', requestId, identity('key-a')),
                positiveWeightError
            );
            assert.equal(manager.balanceLeases.size, 0);
            assert.equal(manager.balanceAttemptSnapshots.size, 0);
            assert.equal(await ApiKeyManager.getApiKey(slot), 'key-a');
        });
    }

    test('a fault exclusion replaces affinity with a positive credential', async () => {
        await setWeights(0, 1, 3);
        const balanceKey = 'm:fault-replacement';
        const failed = await ApiKeyFailoverManager.captureAttempt(slot, balanceKey, 'failed', identity('key-c'));
        assert.ok(failed?.balanceLeaseId);
        const decision = await ApiKeyFailoverManager.handleFailure(
            slot,
            new Error('401 unauthorized'),
            failed,
            new Set<string>(),
            3,
            undefined,
            false,
            term,
            undefined,
            undefined,
            balanceKey
        );
        assert.equal(decision.shouldRetry, true);
        ApiKeyFailoverManager.releaseBalanceLease(failed.balanceLeaseId);
        const replacement = await ApiKeyFailoverManager.captureAttempt(
            slot,
            balanceKey,
            'replacement',
            failed.identity
        );
        assert.equal(replacement?.apiKey, 'key-b');
        assert.equal(
            ConfigSetStore.getBalanceExclusions(slot).some(entry => entry.credentialId === failed.identity),
            true
        );
    });

    test('all-isolated advisory fallback uses only positive candidates, including for zero preferences', async () => {
        await setWeights(0, 1, 3);
        const seen = new Set<string>();
        for (let index = 0; index < 24; index++) {
            const balanceKey = `m:advisory-${index}`;
            for (const id of ['b', 'c']) {
                await ConfigSetStore.addBalanceExclusion(slot, balanceKey, identity(`key-${id}`), Date.now(), term);
            }
            const expected = hash(balanceKey) % 4 === 0 ? 'key-b' : 'key-c';
            const attempt = await ApiKeyFailoverManager.captureAttempt(slot, balanceKey, undefined, identity('key-a'));
            assert.equal(attempt?.apiKey, expected);
            seen.add(expected);
        }
        assert.deepEqual([...seen].sort(), ['key-b', 'key-c']);
        await setWeights(0, 0, 0);
        await assert.rejects(() => ApiKeyFailoverManager.captureAttempt(slot, 'm:advisory-0'), positiveWeightError);
    });

    for (const activeId of ['a', 'alias-zero', 'alias-max']) {
        test(`aliases use their maximum weight without summing or changing group order: ${activeId}`, async () => {
            await setWeights(1, 3, 0);
            for (const [id, balanceWeight] of [
                ['alias-low', 2],
                ['alias-max', 4],
                ['alias-zero', 0]
            ] as const) {
                await ConfigSetStore.add(slot, { id, label: id, balanceWeight }, 'key-a');
            }
            await ConfigSetStore.setActive(slot, activeId);
            const seen = new Set<string>();
            for (let index = 0; index < 64; index++) {
                const balanceKey = `m:alias-${index}`;
                const expected = hash(balanceKey) % 7 < 4 ? 'key-a' : 'key-b';
                const attempt = await ApiKeyFailoverManager.captureAttempt(slot, balanceKey);
                assert.equal(attempt?.apiKey, expected);
                if (expected === 'key-a') {
                    assert.equal(attempt?.activeId, activeId);
                }
                seen.add(expected);
            }
            assert.equal(seen.size, 2);
        });
    }

    test('the same Key at different sites forms independent weighted groups', async () => {
        await setWeights(1, 3, 0);
        await ConfigSetStore.remove(slot, 'b');
        await ConfigSetStore.add(slot, { id: 'b', label: 'b', site: 'other-site', balanceWeight: 3 }, 'key-a');
        const otherIdentity = createHash('sha256').update('key-a\u0000other-site').digest('hex');
        const seen = new Set<string>();
        for (let index = 0; index < 64; index++) {
            const balanceKey = `m:site-${index}`;
            const other = hash(balanceKey) % 4 !== 0;
            const attempt = await ApiKeyFailoverManager.captureAttempt(slot, balanceKey);
            assert.ok(attempt);
            assert.equal(attempt.apiKey, 'key-a');
            assert.equal(attempt.identity, other ? otherIdentity : identity('key-a'));
            assert.equal(attempt.site, other ? 'other-site' : undefined);
            seen.add(attempt.identity);
        }
        assert.equal(seen.size, 2);
        for (const [index, preferred] of [identity('key-a'), otherIdentity, otherIdentity, otherIdentity].entries()) {
            const busy = await ApiKeyFailoverManager.captureAttempt(
                slot,
                `m:site-load-${index}`,
                `site-load-${index}`,
                preferred
            );
            assert.ok(busy?.balanceLeaseId);
            assert.equal(busy.identity, preferred);
        }
        for (let index = 0; index < 24; index++) {
            const balanceKey = `m:site-tie-${index}`;
            const expected = hash(balanceKey) % 4 === 0 ? identity('key-a') : otherIdentity;
            assert.equal((await ApiKeyFailoverManager.captureAttempt(slot, balanceKey))?.identity, expected);
        }
        assert.equal(manager.balanceLeases.size, 4);
    });

    test('alias maximum weight also controls normalized live load', async () => {
        await setWeights(1, 3, 0);
        await ConfigSetStore.add(slot, { id: 'alias', label: 'alias', balanceWeight: 4 }, 'key-a');
        for (const [index, id] of ['a', 'a', 'a', 'b', 'b'].entries()) {
            const busy = await ApiKeyFailoverManager.captureAttempt(
                slot,
                `m:alias-load-${index}`,
                `alias-load-${index}`,
                identity(`key-${id}`)
            );
            assert.ok(busy?.balanceLeaseId);
            assert.equal(busy.identity, identity(`key-${id}`));
        }
        const selected = await ApiKeyFailoverManager.captureAttempt(slot, 'm:alias-normalized');
        assert.equal(selected?.apiKey, 'key-b');
        assert.equal(manager.balanceLeases.size, 5);
    });

    test('dynamic weights affect new requests while zero-weight snapshots and leases stay idempotent', async () => {
        await setWeights(1, 0, 0);
        const first = await ApiKeyFailoverManager.captureAttempt(slot, 'm:dynamic', 'dynamic-first');
        assert.ok(first?.balanceLeaseId);
        assert.equal(first.apiKey, 'key-a');
        await setWeights(0, 3, 0);
        const second = await ApiKeyFailoverManager.captureAttempt(slot, 'm:dynamic', 'dynamic-second', first.identity);
        assert.ok(second?.balanceLeaseId);
        assert.equal(second.apiKey, 'key-b');
        assert.notEqual(second.balanceLeaseId, first.balanceLeaseId);
        assert.strictEqual(await ApiKeyFailoverManager.captureAttempt(slot, 'm:dynamic', 'dynamic-first'), first);
        await setWeights(0, 0, 0);
        assert.strictEqual(await ApiKeyFailoverManager.captureAttempt(slot, 'm:dynamic', 'dynamic-first'), first);
        assert.strictEqual(await ApiKeyFailoverManager.captureAttempt(slot, 'm:dynamic', 'dynamic-second'), second);
        manager.balanceAttemptSnapshots.delete('dynamic-first');
        const restored = await ApiKeyFailoverManager.captureAttempt(slot, 'm:dynamic', 'dynamic-first');
        assert.equal(restored?.balanceLeaseId, first.balanceLeaseId);
        assert.equal(restored?.identity, first.identity);
        assert.equal(manager.balanceLeases.size, 2);
        await assert.rejects(
            () => ApiKeyFailoverManager.captureAttempt(slot, 'm:dynamic', 'dynamic-new'),
            positiveWeightError
        );
        ApiKeyFailoverManager.releaseBalanceLease(first.balanceLeaseId);
        await assert.rejects(
            () => ApiKeyFailoverManager.captureAttempt(slot, 'm:dynamic', 'dynamic-first'),
            positiveWeightError
        );
    });

    test('clearing an explicit weight restores the default hash selection for new requests', async () => {
        await setWeights(0, 3, 0);
        await setWeights(undefined, undefined, undefined);
        assert.ok(ConfigSetStore.list(slot).every(item => !Object.hasOwn(item, 'balanceWeight')));
        for (let index = 0; index < 24; index++) {
            const balanceKey = `m:reset-${index}`;
            const expected = `key-${['a', 'b', 'c'][hash(balanceKey) % 3]}`;
            assert.equal((await ApiKeyFailoverManager.captureAttempt(slot, balanceKey))?.apiKey, expected);
        }
    });

    for (const weight of [-1, 101, 0.5, Number.NaN, Number.POSITIVE_INFINITY]) {
        test(`invalid weight edits are rejected without altering the pool: ${weight}`, async () => {
            const before = ConfigSetStore.list(slot);
            await assert.rejects(() => ConfigSetStore.updateMeta(slot, 'a', { balanceWeight: weight }), RangeError);
            assert.deepEqual(ConfigSetStore.list(slot), before);
        });
    }

    test('Leader accepts but ignores the legacy wire previousCredentialId', async () => {
        const balanceKey = 'm:session:turn:5';
        const expected = identity(`key-${['a', 'b', 'c'][hash(balanceKey) % 3]}`);
        const payload = { ...remoteRequest('legacy-wire'), balanceKey, previousCredentialId: expected };
        const assigned = await ApiKeyFailoverManager.handleBalanceAssignmentRequest(payload, 'turn-follower');
        assert.equal(assigned?.handled, true);
        assert.equal(assigned?.credentialId, expected);
        assert.deepEqual(ConfigSetStore.getBalanceExclusions(slot), []);
        const repeated = await ApiKeyFailoverManager.handleBalanceAssignmentRequest(payload, 'turn-follower');
        assert.equal(repeated?.leaseId, assigned?.leaseId);
        assert.equal(repeated?.credentialId, assigned?.credentialId);
        assert.ok(assigned?.leaseId);
        ApiKeyFailoverManager.releaseBalanceLease(assigned.leaseId);
    });

    test('Leader returns handled:false with weightBlocked:true for an all-zero Follower allocation', async () => {
        await setWeights(0, 0, 0);
        const payload = remoteRequest('remote-zero', identity('key-a'));
        const assigned = await ApiKeyFailoverManager.handleBalanceAssignmentRequest(payload, 'turn-follower');
        assert.deepEqual(assigned, {
            requestId: payload.requestId,
            targetInstanceId: 'turn-follower',
            authorityTerm: term,
            handled: false,
            weightBlocked: true
        });
        assert.equal(manager.balanceLeases.size, 0);
    });

    test('an unmatched runtime key cannot turn all-zero balance into manual fallback', async () => {
        await setWeights(0, 0, 0);
        await ApiKeyManager.setApiKey(slot, 'outside-key');
        assert.equal(await ApiKeyFailoverManager.disableIfUnavailable(slot), false);
        assert.equal(ConfigSetStore.getSwitchMode(slot), 'balance');
        await assert.rejects(() => ApiKeyFailoverManager.captureAttempt(slot, 'm:outside'), positiveWeightError);
        const blocked = await ApiKeyFailoverManager.handleBalanceAssignmentRequest(
            remoteRequest('outside-remote'),
            'turn-follower'
        );
        assert.equal(blocked?.handled, false);
        assert.equal(blocked?.weightBlocked, true);
        assert.equal(manager.balanceLeases.size, 0);
    });

    test('an unmatched runtime key cannot bypass a positive saved key in fallback', async () => {
        await setWeights(0, 3, 0);
        await ApiKeyManager.setApiKey(slot, 'outside-key');
        assert.equal(await ApiKeyFailoverManager.disableIfUnavailable(slot), false);
        assert.equal(ConfigSetStore.getSwitchMode(slot), 'balance');
        await assert.rejects(
            () => ApiKeyFailoverManager.captureAttempt(slot, 'm:outside-positive'),
            positiveWeightError
        );
        assert.equal(await ApiKeyManager.getApiKey(slot), 'outside-key');
        assert.equal(manager.balanceLeases.size, 0);
    });

    test('zero weights do not alter off requests', async () => {
        await setWeights(0, 0, 0);
        await ConfigSetStore.setSwitchMode(slot, 'off');
        assert.equal(await ApiKeyFailoverManager.captureAttempt(slot, 'm:manual'), undefined);
        assert.equal(await ApiKeyManager.getApiKey(slot), 'key-a');
    });

    test('zero-weight failover selects the only positive credential without disabling the mode', async () => {
        await setWeights(0, 3, 0);
        await ConfigSetStore.setSwitchMode(slot, 'failover');
        const attempt = await ApiKeyFailoverManager.captureAttempt(slot, 'm:failover');
        assert.equal(attempt?.mode, 'failover');
        assert.equal(attempt.apiKey, 'key-b');
        assert.equal(attempt.apiKeyName, 'b');
        assert.equal(await ApiKeyFailoverManager.canEnableAutoSwitch(slot), true);
        assert.equal(await ApiKeyFailoverManager.disableIfUnavailable(slot), false);
        assert.equal(ConfigSetStore.getSwitchMode(slot), 'failover');
        assert.equal(await ApiKeyManager.getApiKey(slot), 'key-a');
    });

    test('zero-weight failover skips disabled targets and never returns to a disabled initial credential', async () => {
        await setWeights(1, 0, 1);
        await ConfigSetStore.setSwitchMode(slot, 'failover');
        const attempt = await ApiKeyFailoverManager.captureAttempt(slot);
        assert.ok(attempt);
        const attempted = new Set<string>();
        const decision = await ApiKeyFailoverManager.handleFailure(slot, { status: 429 }, attempt, attempted, 3, 'a');
        assert.equal(decision.switched, true);
        assert.equal(ConfigSetStore.getActiveId(slot), 'c');
        await setWeights(0, 0, 1);
        const next = await ApiKeyFailoverManager.captureAttempt(slot);
        const stopped = await ApiKeyFailoverManager.handleFailure(slot, { status: 429 }, next, attempted, 3, 'a');
        assert.equal(stopped.shouldRetry, false);
        assert.equal(stopped.switched, false);
        assert.equal(ConfigSetStore.getActiveId(slot), 'c');
    });

    test('zero-weight failover keeps a credential enabled when a same-key alias has positive weight', async () => {
        await setWeights(0, 1, 0);
        await ConfigSetStore.add(slot, { id: 'a-alias', label: 'a alias', balanceWeight: 2 }, 'key-a');
        await ConfigSetStore.setSwitchMode(slot, 'failover');
        const attempt = await ApiKeyFailoverManager.captureAttempt(slot);
        assert.equal(attempt?.apiKey, 'key-a');
        assert.equal(attempt.activeId, 'a');
        const decision = await ApiKeyFailoverManager.handleFailure(slot, { status: 429 }, attempt, new Set(), 3);
        assert.equal(decision.switched, true);
        assert.equal(ConfigSetStore.getActiveId(slot), 'b');
    });

    for (const weight of [1, undefined]) {
        test(`zero-weight failover mixed weights preserve unmatched-runtime fallback: ${weight ?? 'default'}`, async () => {
            await setWeights(weight, 0, 0);
            await ConfigSetStore.setSwitchMode(slot, 'failover');
            await ApiKeyManager.setApiKey(slot, 'outside-key');
            assert.equal(await ApiKeyFailoverManager.disableIfUnavailable(slot), false);
            assert.equal(await ApiKeyFailoverManager.captureAttempt(slot), undefined);
            assert.equal(ConfigSetStore.getSwitchMode(slot), 'failover');
            assert.equal(ConfigSetStore.getActiveId(slot), 'a');
            assert.equal(await ApiKeyManager.getApiKey(slot), 'outside-key');
        });
    }

    test('zero-weight failover preserves an unmatched runtime fallback when no configurations remain', async () => {
        for (const id of ['a', 'b', 'c']) {
            await ConfigSetStore.remove(slot, id);
        }
        await ConfigSetStore.setSwitchMode(slot, 'failover');
        await ApiKeyManager.setApiKey(slot, 'outside-key');
        assert.equal(await ApiKeyFailoverManager.captureAttempt(slot), undefined);
        assert.equal(await ApiKeyManager.getApiKey(slot), 'outside-key');
    });

    test('zero-weight failover rejects an empty eligible pool despite a positive configuration without a key', async () => {
        await setWeights(0, 1, 0);
        await ConfigSetStore.updateMeta(slot, 'b', {}, null);
        await ConfigSetStore.setSwitchMode(slot, 'failover');
        await assert.rejects(() => ApiKeyFailoverManager.captureAttempt(slot), positiveWeightError);
        assert.equal(ConfigSetStore.getSwitchMode(slot), 'failover');
        assert.equal(await ApiKeyManager.getApiKey(slot), 'key-a');
    });

    test('zero-weight failover rejects all-zero pools without manual fallback or mode downgrade', async () => {
        await setWeights(0, 0, 0);
        await ConfigSetStore.setSwitchMode(slot, 'failover');
        for (const apiKey of ['key-a', 'outside-key']) {
            await ApiKeyManager.setApiKey(slot, apiKey);
            assert.equal(await ApiKeyFailoverManager.disableIfUnavailable(slot), false);
            assert.equal(ConfigSetStore.getSwitchMode(slot), 'failover');
            await assert.rejects(() => ApiKeyFailoverManager.captureAttempt(slot), positiveWeightError);
            assert.equal(await ApiKeyManager.getApiKey(slot), apiKey);
        }
        await ConfigSetStore.remove(slot, 'b');
        await ConfigSetStore.remove(slot, 'c');
        await ApiKeyManager.setApiKey(slot, 'key-a');
        assert.equal(await ApiKeyFailoverManager.disableIfUnavailable(slot), false);
        await assert.rejects(() => ApiKeyFailoverManager.captureAttempt(slot), positiveWeightError);
    });

    test('zero-weight failover Leader rotates from the positive request snapshot rather than the disabled runtime key', async () => {
        await setWeights(0, 1, 1);
        await ConfigSetStore.setSwitchMode(slot, 'failover');
        const attempt = await ApiKeyFailoverManager.captureAttempt(slot);
        assert.equal(attempt?.apiKey, 'key-b');
        const decision = await ApiKeyFailoverManager.handleFailure(
            slot,
            { status: 429 },
            attempt,
            new Set(),
            3,
            'b',
            false,
            term,
            'zero-weight-failure'
        );
        assert.equal(decision.switched, true);
        assert.equal(ConfigSetStore.getActiveId(slot), 'c');
        assert.equal((await ApiKeyFailoverManager.captureAttempt(slot))?.apiKey, 'key-c');
    });

    test('zero-weight failover Follower uses a positive snapshot without changing the runtime credential', async () => {
        await setWeights(0, 1, 0);
        await ConfigSetStore.setSwitchMode(slot, 'failover');
        LeaderElectionService.isLeader = () => false;
        LeaderElectionService.getOwnedAuthorityTerm = () => undefined;
        const attempt = await ApiKeyFailoverManager.captureAttempt(slot);
        assert.equal(attempt?.apiKey, 'key-b');
        assert.equal(attempt.activeId, 'b');
        assert.equal(ConfigSetStore.getActiveId(slot), 'a');
        assert.equal(await ApiKeyManager.getApiKey(slot), 'key-a');
    });

    test('Leader preserves a Follower lease at zero weight but blocks a new request', async () => {
        await setWeights(0, 3, 0);
        const payload = remoteRequest('remote-existing', identity('key-a'));
        const assigned = await ApiKeyFailoverManager.handleBalanceAssignmentRequest(payload, 'turn-follower');
        assert.equal(assigned?.handled, true);
        assert.equal(assigned?.credentialId, identity('key-b'));
        assert.ok(assigned?.leaseId);
        await setWeights(0, 0, 0);
        const repeated = await ApiKeyFailoverManager.handleBalanceAssignmentRequest(payload, 'turn-follower');
        assert.equal(repeated?.handled, true);
        assert.equal(repeated?.leaseId, assigned.leaseId);
        assert.equal(repeated?.credentialId, assigned.credentialId);
        assert.notEqual(repeated?.weightBlocked, true);
        const blocked = await ApiKeyFailoverManager.handleBalanceAssignmentRequest(
            remoteRequest('remote-new'),
            'turn-follower'
        );
        assert.equal(blocked?.handled, false);
        assert.equal(blocked?.weightBlocked, true);
        assert.equal(manager.balanceLeases.size, 1);
    });

    test('Follower retains its snapshot after all weights become zero without requesting another lease', async () => {
        follow(request => ({
            requestId: request.requestId,
            targetInstanceId: 'turn-follower',
            authorityTerm: term,
            handled: request.requestId === 'follower-existing',
            ...(request.requestId === 'follower-existing' ?
                {
                    configId: 'b',
                    credentialId: identity('key-b'),
                    leaseId: 'follower-lease',
                    expiresAt: Date.now() + 30_000
                }
            :   { weightBlocked: true })
        }));
        const first = await ApiKeyFailoverManager.captureAttempt(
            slot,
            'm:follower',
            'follower-existing',
            identity('key-b')
        );
        assert.ok(first?.balanceLeaseId);
        assert.equal(requests.length, 1);
        assert.equal(requests[0].preferredCredentialId, identity('key-b'));
        assert.equal(Object.hasOwn(requests[0], 'previousCredentialId'), false);
        await setWeights(0, 0, 0);
        assert.strictEqual(await ApiKeyFailoverManager.captureAttempt(slot, 'm:follower', 'follower-existing'), first);
        assert.equal(requests.length, 1);
        await assert.rejects(
            () => ApiKeyFailoverManager.captureAttempt(slot, 'm:follower', 'follower-new'),
            positiveWeightError
        );
        assert.equal(manager.pendingBalanceAssignments.size, 0);
        assert.equal(manager.balanceAttemptSnapshots.size, 1);
        assert.deepEqual(releases, []);
        ApiKeyFailoverManager.releaseBalanceLease(first.balanceLeaseId, term);
        assert.deepEqual(releases, [{ leaseId: first.balanceLeaseId, authorityTerm: term }]);
    });

    test('a pre-cancelled fifth-argument token prevents a Follower allocation', async () => {
        follow(request => ({
            requestId: request.requestId,
            targetInstanceId: 'turn-follower',
            authorityTerm: term,
            handled: false
        }));
        const cancellation = trackedCancellation();
        cancellation.cancel();
        try {
            const attempt = await ApiKeyFailoverManager.captureAttempt(
                slot,
                'm:cancelled',
                'cancelled',
                identity('key-b'),
                cancellation.token
            );
            assert.equal(attempt, undefined);
            assert.equal(requests.length, 0);
            assert.equal(manager.pendingBalanceAssignments.size, 0);
            assert.equal(manager.balanceAttemptSnapshots.size, 0);
        } finally {
            cancellation.dispose();
        }
    });

    for (const sdkMode of ['openai', 'openai-responses'] as const) {
        test(`${sdkMode}: a Follower weightBlocked reply throws the Leader error class without ordinary fallback`, async () => {
            await setWeights(0, 0, 0);
            let leaderError: Error | undefined;
            await assert.rejects(
                () => ApiKeyFailoverManager.captureAttempt(slot, 'm:leader-blocked'),
                error => {
                    assert.ok(error instanceof Error);
                    assert.match(error.message, positiveWeightError);
                    leaderError = error;
                    return true;
                }
            );
            await setWeights(1, 1, 1);
            follow(request => ({
                requestId: request.requestId,
                targetInstanceId: 'turn-follower',
                authorityTerm: term,
                handled: false,
                weightBlocked: true
            }));
            let wireCount = 0;
            ConfigManager.createProxyAwareFetch = () => async () => {
                wireCount++;
                return successResponse(sdkMode);
            };
            const cancellation = trackedCancellation();
            try {
                await assert.rejects(
                    () => RetryProvider.run(sdkMode, defaultRetry, { grants: 0 }, cancellation.token),
                    error => {
                        assert.ok(error instanceof Error);
                        assert.equal(error.constructor, leaderError?.constructor);
                        assert.match(error.message, positiveWeightError);
                        return true;
                    }
                );
                assert.ok(requests.length > 0);
                assert.equal(wireCount, 0);
                assert.equal(manager.pendingBalanceAssignments.size, 0);
                assert.equal(manager.balanceAttemptSnapshots.size, 0);
                assert.equal(cancellation.disposals, cancellation.subscriptions);
            } finally {
                cancellation.dispose();
            }
        });

        test(`${sdkMode}: ordinary handled:false still allows the positive primary fallback`, async () => {
            follow(request => ({
                requestId: request.requestId,
                targetInstanceId: 'turn-follower',
                authorityTerm: term,
                handled: false
            }));
            let wireCount = 0;
            let authorization: string | null = null;
            ConfigManager.createProxyAwareFetch = () => async (input, init) => {
                authorization = new Request(input, init).headers.get('authorization');
                wireCount++;
                return successResponse(sdkMode);
            };
            const cancellation = trackedCancellation();
            try {
                await RetryProvider.run(sdkMode, defaultRetry, { grants: 0 }, cancellation.token);
                assert.equal(wireCount, 1);
                assert.equal(authorization, 'Bearer key-a');
                assert.equal(requests.length, 1);
                assert.equal(manager.pendingBalanceAssignments.size, 0);
            } finally {
                cancellation.dispose();
            }
        });

        for (const replacement of ['key-c', 'outside-key']) {
            test(`${sdkMode}: fallback binds its validated key snapshot rather than a later runtime key: ${replacement}`, async () => {
                await setWeights(1, 3, 0);
                follow(request => ({
                    requestId: request.requestId,
                    targetInstanceId: 'turn-follower',
                    authorityTerm: term,
                    handled: false
                }));
                const originalValidate = ApiKeyFailoverManager.validateBalanceFallback;
                let validations = 0;
                ApiKeyFailoverManager.validateBalanceFallback = async (...args) => {
                    const snapshot = await originalValidate.apply(ApiKeyFailoverManager, args);
                    validations++;
                    await ApiKeyManager.setApiKey(slot, replacement);
                    return snapshot;
                };
                const authorizations: Array<string | null> = [];
                ConfigManager.createProxyAwareFetch = () => async (input, init) => {
                    authorizations.push(new Request(input, init).headers.get('authorization'));
                    return successResponse(sdkMode);
                };
                const cancellation = trackedCancellation();
                try {
                    await RetryProvider.run(sdkMode, defaultRetry, { grants: 0 }, cancellation.token);
                    assert.equal(validations, 1);
                    assert.deepEqual(authorizations, ['Bearer key-a']);
                    assert.equal(await ApiKeyManager.getApiKey(slot), replacement);
                    assert.equal(ConfigSetStore.getSwitchMode(slot), 'balance');
                } finally {
                    ApiKeyFailoverManager.validateBalanceFallback = originalValidate;
                    cancellation.dispose();
                }
            });
        }

        for (const action of ['positive-primary', 'zero-primary', 'all-zero', 'unmatched-primary'] as const) {
            test(`${sdkMode}: fallback without a Leader ignores weights: ${action}`, async () => {
                await setWeights(action === 'positive-primary' ? 1 : 0, action === 'all-zero' ? 0 : 3, 0);
                const primaryKey = action === 'unmatched-primary' ? 'outside-key' : 'key-a';
                await ApiKeyManager.setApiKey(slot, primaryKey);
                LeaderElectionService.isInitialized = () => false;
                LeaderElectionService.isLeader = () => false;
                LeaderElectionService.getOwnedAuthorityTerm = () => undefined;
                InterInstanceBus.getAuthorityTerm = () => undefined;
                InterInstanceBus.hasActiveTransport = () => false;
                let wireCount = 0;
                let authorization: string | null = null;
                ConfigManager.createProxyAwareFetch = () => async (input, init) => {
                    authorization = new Request(input, init).headers.get('authorization');
                    wireCount++;
                    return successResponse(sdkMode);
                };
                const cancellation = trackedCancellation();
                try {
                    await RetryProvider.run(sdkMode, defaultRetry, { grants: 0 }, cancellation.token);
                    assert.equal(wireCount, 1);
                    assert.equal(authorization, `Bearer ${primaryKey}`);
                    assert.equal(manager.balanceAttemptSnapshots.size, 0);
                    assert.equal(await ApiKeyManager.getApiKey(slot), primaryKey);
                    assert.equal(cancellation.disposals, cancellation.subscriptions);
                } finally {
                    cancellation.dispose();
                }
            });
        }
    }

    for (const action of ['positive-primary', 'zero-primary', 'all-zero', 'unmatched-primary'] as const) {
        test(`direct fallback without a Leader ignores weights: ${action}`, async () => {
            await setWeights(action === 'positive-primary' ? 1 : 0, action === 'all-zero' ? 0 : 3, 0);
            await ApiKeyManager.setApiKey(slot, action === 'unmatched-primary' ? 'outside-key' : 'key-a');
            LeaderElectionService.isInitialized = () => false;
            LeaderElectionService.isLeader = () => false;
            LeaderElectionService.getOwnedAuthorityTerm = () => undefined;
            InterInstanceBus.getAuthorityTerm = () => undefined;
            InterInstanceBus.hasActiveTransport = () => false;
            const pending = ApiKeyFailoverManager.captureAttempt(slot, 'm:direct-fallback', 'direct-fallback');
            assert.equal(await pending, undefined);
            assert.equal(manager.balanceLeases.size, 0);
            assert.equal(manager.balanceAttemptSnapshots.size, 0);
        });
    }

    for (const action of ['weighted-load', 'zero-weight-import', 'all-zero-import'] as const) {
        test(`handoff retains live leases and applies current weights to new allocations: ${action}`, async () => {
            await setWeights(1, 3, 0);
            const live: ApiKeyFailoverAttempt[] = [];
            for (const [index, id] of ['a', 'b', 'b'].entries()) {
                const attempt = await ApiKeyFailoverManager.captureAttempt(
                    slot,
                    `m:handoff-${index}`,
                    `handoff-${index}`,
                    identity(`key-${id}`)
                );
                assert.ok(attempt?.balanceLeaseId);
                assert.equal(attempt.identity, identity(`key-${id}`));
                live.push(attempt);
            }
            if (action !== 'weighted-load') {
                await setWeights(0, action === 'all-zero-import' ? 0 : 3, 0);
            }
            const handoff = await ApiKeyFailoverManager.prepareBalanceLeaseHandoff();
            assert.equal(handoff?.leases.length, 3);
            term = 'turn-selection-leader:2';
            await ApiKeyFailoverManager.becomeBalanceAuthority(term);
            assert.equal(manager.balanceLeases.size, 3);
            for (const attempt of live) {
                assert.ok(attempt.balanceLeaseId);
                assert.equal(manager.balanceLeases.get(attempt.balanceLeaseId)?.credentialId, attempt.identity);
                assert.equal(manager.balanceLeases.get(attempt.balanceLeaseId)?.authorityTerm, term);
            }
            if (action === 'all-zero-import') {
                await assert.rejects(
                    () => ApiKeyFailoverManager.captureAttempt(slot, 'm:after-handoff', 'after-handoff'),
                    positiveWeightError
                );
                const blocked = await ApiKeyFailoverManager.handleBalanceAssignmentRequest(
                    remoteRequest('handoff-remote'),
                    'turn-follower'
                );
                assert.equal(blocked?.weightBlocked, true);
                assert.equal(blocked?.handled, false);
                assert.equal(manager.balanceLeases.size, 3);
            } else {
                const next = await ApiKeyFailoverManager.captureAttempt(
                    slot,
                    'm:after-handoff',
                    'after-handoff',
                    action === 'zero-weight-import' ? identity('key-a') : undefined
                );
                assert.ok(next?.balanceLeaseId);
                assert.equal(next.apiKey, 'key-b');
                assert.equal(next.balanceAuthorityTerm, term);
                assert.equal(manager.balanceLeases.size, 4);
            }
        });
    }
});
