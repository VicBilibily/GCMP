import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as vscode from 'vscode';
import { setCrossInstanceBroadcaster } from '../../../../../src/handlers/liveMetrics';
import { registerInterInstanceHandlers } from '../../../../../src/interInstance/activation';
import type { InterInstanceEvent } from '../../../../../src/interInstance/eventProtocol';
import { IpcClient } from '../../../../../src/interInstance/ipcClient';
import { resolveIpcPath, setRateLimitHandoffFilePathOverride } from '../../../../../src/interInstance/pathResolver';
import {
    RateLimiter,
    type RateLimitHandle,
    type RateLimitAcquireOptions
} from '../../../../../src/rateLimit/rateLimiter';
import { writeRateLimitLeaderHandoff } from '../../../../../src/rateLimit/leaderHandoffFile';
import {
    RateLimitStore,
    type RateLimitDimensions,
    type RateLimitStoreSnapshot
} from '../../../../../src/rateLimit/rateLimitStore';
import { LeaderElectionService } from '../../../../../src/status/leaderElectionService';
import { AtomicJsonFile } from '../../../../../src/usages/atomicJsonFile';
import { ConfigManager } from '../../../../../src/utils/config/configManager';
import { ConfigSetStore } from '../../../../../src/utils/config/configSetStore';
import { deferred } from '../../electionContinuation/fixture';
import { createLivenessFixture, waitFor } from '../fixture';

interface QuotaInternals {
    initialized: boolean;
    leaderStore: RateLimitStore;
    localStore: RateLimitStore;
    leaderRestoreReady: Promise<void> | undefined;
    sweep(): void;
    reclaimDisconnectedInstance(id: string): void;
    renewLease(handle: RateLimitHandle, now?: number): boolean;
}

export async function createQuotaFixture(holdRestore = false, snapshot?: RateLimitStoreSnapshot) {
    const f = await createLivenessFixture(0);
    const rate = RateLimiter as unknown as QuotaInternals;
    assert.equal(rate.initialized, false);
    assert.equal(ConfigSetStore.isInitialized(), false);
    const fields = [
        'leaderStore',
        'localStore',
        'leaderRestoreReady',
        'leaderRestoreAuthorityTerm',
        'pendingPersistedLeaderHandoff',
        'degraded',
        'degradedNotified',
        'lastProbeAt'
    ];
    const state = rate as unknown as Record<string, unknown>;
    const previous = Object.fromEntries(fields.map(field => [field, state[field]]));
    const originalNow = Date.now;
    const originalProvider = ConfigManager.getProviderRateLimitConfig;
    const originalModel = ConfigManager.getModelRateLimitConfig;
    const update = f.context.globalState.update;
    const gateA = deferred();
    const enteredA = deferred();
    const gateB = deferred();
    const enteredB = deferred();
    const gateRestore = deferred();
    const enteredRestore = deferred();
    const errorA = new Error('candidate A write rejected');
    const observerId = randomUUID();
    const events: InterInstanceEvent[] = [];
    const observer = new IpcClient({ onMessage: event => events.push(event) });
    const acquisitions: Array<Promise<RateLimitHandle | undefined>> = [];
    const handles: RateLimitHandle[] = [];
    const tokens: vscode.CancellationTokenSource[] = [];
    const path = join(process.env.GCMP_QUOTA_EVIDENCE ?? tmpdir(), `quota-${randomUUID()}.json`);
    let now = originalNow();
    let rejectA = true;
    let settledA: Promise<void> | undefined;
    let pendingB: Promise<void> | undefined;
    let recordA: ReturnType<typeof f.read>;
    let recordB: ReturnType<typeof f.read>;
    let fileLock: Promise<void> | undefined;
    let termA = '';
    let termB = '';
    Date.now = () => now;
    ConfigManager.getProviderRateLimitConfig = () => ({ parallel: 1 });
    ConfigManager.getModelRateLimitConfig = () => undefined;
    setRateLimitHandoffFilePathOverride(path);
    rate.localStore = new RateLimitStore();
    rate.leaderRestoreReady = undefined;
    RateLimiter.initialize(f.context);
    registerInterInstanceHandlers(f.context);
    async function barrier(): Promise<void> {
        const count = events.filter(event => event.type === 'remoteInstanceCapabilities').length;
        observer.send({ type: 'remoteInstanceHello', senderInstanceId: observerId, timestamp: now, payload: {} });
        await waitFor(() => events.filter(event => event.type === 'remoteInstanceCapabilities').length > count);
    }
    async function connect(): Promise<void> {
        await observer.disconnect();
        await observer.connect(resolveIpcPath(f.followerId));
        await barrier();
    }
    async function dispose(): Promise<void> {
        f.context.globalState.update = update;
        gateA.resolve();
        gateRestore.resolve();
        if (recordB) {
            await f.write({ ...recordB, lastHeartbeat: now });
        }
        gateB.resolve();
        for (const token of tokens) {
            token.cancel();
        }
        try {
            await settledA;
            await pendingB;
            await fileLock;
            await rate.leaderRestoreReady?.catch(() => {});
            await Promise.all(acquisitions.map(acquiring => acquiring.catch(() => {})));
            for (const handle of handles) {
                RateLimiter.release(handle, handle.costs);
            }
            await f.bus.roleSwitchChain;
        } finally {
            await observer.disconnect();
            for (const token of tokens) {
                token.dispose();
            }
            ConfigManager.getProviderRateLimitConfig = originalProvider;
            ConfigManager.getModelRateLimitConfig = originalModel;
            setCrossInstanceBroadcaster(undefined);
            Date.now = originalNow;
            await f.dispose();
            Object.assign(rate, previous);
            setRateLimitHandoffFilePathOverride(undefined);
        }
    }
    try {
        if (snapshot) {
            await writeRateLimitLeaderHandoff(
                { leaderId: 'prior', authorityTerm: 'prior:1', receivedAt: now, snapshot },
                path,
                { strict: true }
            );
        }
        if (holdRestore) {
            fileLock = AtomicJsonFile.runExclusive(path, async () => {
                enteredRestore.resolve();
                await gateRestore.promise;
            });
            await enteredRestore.promise;
        }
        await f.write(undefined);
        f.context.globalState.update = async (key: string, value: unknown) => {
            await update.call(f.context.globalState, key, value);
            enteredA.resolve();
            await gateA.promise;
            if (rejectA) {
                throw errorA;
            }
        };
        const pendingA = f.election.becomeLeader();
        settledA = pendingA.catch(error => assert.equal(error, errorA));
        await enteredA.promise;
        recordA = f.read();
        assert.ok(recordA);
        termA = `${recordA.instanceId}:${recordA.electedAt}`;
        f.context.globalState.update = update;
        await f.election.checkLeader();
        await f.bus.roleSwitchChain;
        if (!holdRestore) {
            await rate.leaderRestoreReady;
        }
        assert.equal(LeaderElectionService.getOwnedAuthorityTerm(), termA);
        await connect();
    } catch (error) {
        await dispose();
        throw error;
    }
    return {
        f,
        rate,
        events,
        observerId,
        termA,
        dispose,
        barrier,
        connect,
        get termB() {
            return termB;
        },
        get now() {
            return now;
        },
        advance(ms: number) {
            now += ms;
        },
        async beginB() {
            now++;
            await f.write(undefined);
            f.context.globalState.update = async (key: string, value: unknown) => {
                await update.call(f.context.globalState, key, value);
                enteredB.resolve();
                await gateB.promise;
            };
            pendingB = f.election.becomeLeader();
            await enteredB.promise;
            recordB = f.read();
            assert.ok(recordB);
            termB = `${recordB.instanceId}:${recordB.electedAt}`;
            f.context.globalState.update = update;
        },
        async settleA(failed = true, replay = false) {
            rejectA = failed;
            gateA.resolve();
            await settledA;
            if (replay) {
                await f.write(recordA);
                for (let index = 0; index < 3; index++) {
                    await f.election.checkLeader();
                }
            }
        },
        async confirmB() {
            assert.ok(recordB);
            await f.write({ ...recordB, lastHeartbeat: now });
            gateB.resolve();
            await pendingB;
            await f.bus.roleSwitchChain;
            assert.equal(LeaderElectionService.getOwnedAuthorityTerm(), termB);
            await connect();
        },
        async finishRestore() {
            gateRestore.resolve();
            await fileLock;
            await rate.leaderRestoreReady;
        },
        acquire(bucket: string, options?: RateLimitAcquireOptions, dims: RateLimitDimensions = { parallel: 1 }) {
            const token = new vscode.CancellationTokenSource();
            tokens.push(token);
            const promise = RateLimiter.acquire(
                bucket,
                dims,
                { requests: 1, tokens: 0 },
                { token: token.token, ...options }
            ).then(handle => {
                if (handle) {
                    handles.push(handle);
                }
                return handle;
            });
            void promise.catch(() => {});
            acquisitions.push(promise);
            return { promise, token };
        },
        async remoteAcquire(bucketKey: string, authorityTerm: string, requestId = randomUUID()) {
            observer.send({
                type: 'rateLimitAcquireRequested',
                senderInstanceId: observerId,
                timestamp: now,
                payload: {
                    requestId,
                    bucketKey,
                    authorityTerm,
                    dims: { parallel: 1 },
                    costs: { requests: 1, tokens: 0 }
                }
            });
            await barrier();
            return requestId;
        },
        grants(requestId: string) {
            return events.filter(
                (event): event is Extract<InterInstanceEvent, { type: 'rateLimitAcquireGranted' }> =>
                    event.type === 'rateLimitAcquireGranted' && event.payload.requestId === requestId
            );
        }
    };
}
