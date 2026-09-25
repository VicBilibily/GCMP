import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import test from 'node:test';
import type { UsagesQueryCompletedEvent, UsagesQueryRequestedEvent } from '../../interInstance';
import { createEmptyNativeCostSplit } from '../fileLogger/nativeCostSplit';
import type { UsagesPendingRecord } from './types';

const require = createRequire(import.meta.url);
const NodeModule = require('node:module') as {
    prototype: { require: (id: string) => unknown };
};

test('usages queries use targeted IPC and fall back only when remote delivery fails', async t => {
    const originalRequire = NodeModule.prototype.require;
    const handlers = new Map<string, (event: unknown) => void>();
    const targeted: Array<{
        target: string;
        event: Omit<UsagesQueryCompletedEvent, 'timestamp' | 'senderInstanceId'>;
    }> = [];
    let isLeader = false;
    let compatibleTransport = true;
    let remoteResponseEnabled = true;
    let suppressRemoteResponse = false;
    let forgeBeforeRemoteResponse = false;
    let malformedAuthorityResponseOnly = false;
    let remoteError: UsagesQueryCompletedEvent['payload']['error'];
    let rejectResultAsTooLarge = false;
    let remoteSuccesses = 0;
    let remoteRequests = 0;
    let localExecutions = 0;
    let executedPending: readonly UsagesPendingRecord[] = [];
    let authorityTerm = 'leader:1';
    let authorityChangedHandler: ((term: string | undefined) => void) | undefined;
    const remoteRequestEvents: Array<Omit<UsagesQueryRequestedEvent, 'timestamp' | 'senderInstanceId'>> = [];

    const bus = {
        subscribe: (type: string, handler: (event: unknown) => void) => {
            handlers.set(type, handler);
            return { dispose: () => handlers.delete(type) };
        },
        onAuthorityChanged: (handler: (term: string | undefined) => void) => {
            authorityChangedHandler = handler;
            return {
                dispose: () => {
                    if (authorityChangedHandler === handler) {
                        authorityChangedHandler = undefined;
                    }
                }
            };
        },
        hasActiveTransport: () => true,
        hasCompatibleUsagesQueryTransport: () => compatibleTransport,
        getAuthorityTerm: () => authorityTerm,
        publishIpcOnly: (event: Omit<UsagesQueryRequestedEvent, 'timestamp' | 'senderInstanceId'>) => {
            remoteRequests += 1;
            remoteRequestEvents.push(event);
            if (!remoteResponseEnabled) {
                return false;
            }
            if (suppressRemoteResponse) {
                return true;
            }
            queueMicrotask(() => {
                const request = event.payload;
                assert.equal(request.query.kind, 'recentRecords');
                if (malformedAuthorityResponseOnly) {
                    handlers.get('usagesQueryCompleted')?.({
                        type: 'usagesQueryCompleted',
                        payload: {
                            requestId: request.requestId,
                            targetInstanceId: 'follower',
                            authorityTerm: request.authorityTerm,
                            result: { kind: 'recentRecords', value: [{}] }
                        },
                        timestamp: Date.now(),
                        senderInstanceId: 'leader'
                    });
                    return;
                }
                if (forgeBeforeRemoteResponse) {
                    handlers.get('usagesQueryCompleted')?.({
                        type: 'usagesQueryCompleted',
                        payload: {
                            requestId: request.requestId,
                            targetInstanceId: 'follower',
                            authorityTerm: request.authorityTerm,
                            result: { kind: 'recentRecords', value: [{ requestId: 'forged' }] }
                        },
                        timestamp: Date.now(),
                        senderInstanceId: 'follower-b'
                    });
                }
                if (remoteError) {
                    handlers.get('usagesQueryCompleted')?.({
                        type: 'usagesQueryCompleted',
                        payload: {
                            requestId: request.requestId,
                            targetInstanceId: 'follower',
                            authorityTerm: request.authorityTerm,
                            error: remoteError
                        },
                        timestamp: Date.now(),
                        senderInstanceId: 'leader'
                    } satisfies UsagesQueryCompletedEvent);
                    return;
                }
                handlers.get('usagesQueryCompleted')?.({
                    type: 'usagesQueryCompleted',
                    payload: {
                        requestId: request.requestId,
                        targetInstanceId: 'follower',
                        authorityTerm: request.authorityTerm,
                        result: { kind: 'recentRecords', value: [] }
                    },
                    timestamp: Date.now(),
                    senderInstanceId: 'leader'
                } satisfies UsagesQueryCompletedEvent);
            });
            return true;
        },
        publishToInstance: (
            target: string,
            event: Omit<UsagesQueryCompletedEvent, 'timestamp' | 'senderInstanceId'>
        ) => {
            if (rejectResultAsTooLarge && event.payload.result) {
                return 'too-large' as const;
            }
            targeted.push({ target, event });
            return 'sent' as const;
        }
    };

    NodeModule.prototype.require = function (id: string): unknown {
        if (id.endsWith('/interInstance')) {
            return { InterInstanceBus: bus };
        }
        if (id.endsWith('/leaderElectionService')) {
            return {
                LeaderElectionService: {
                    isLeader: () => isLeader,
                    getInstanceId: () => (isLeader ? 'leader' : 'follower')
                }
            };
        }
        if (id.endsWith('/statusLogger')) {
            return { StatusLogger: { debug() {}, warn() {} } };
        }
        return originalRequire.call(this, id);
    };

    try {
        const { UsagesQueryCoordinator } = await import('./usagesQueryCoordinator');
        const coordinator = new UsagesQueryCoordinator(
            async (query, pendingRecords) => {
                localExecutions += 1;
                executedPending = pendingRecords;
                return { kind: query.kind, value: [] } as never;
            },
            () => {
                remoteSuccesses += 1;
            }
        );
        t.after(() => coordinator.dispose());

        assert.deepEqual(await coordinator.run({ kind: 'recentRecords', limit: 3 }), []);
        assert.equal(remoteSuccesses, 1);
        assert.equal(localExecutions, 0);

        malformedAuthorityResponseOnly = true;
        assert.deepEqual(await coordinator.run({ kind: 'recentRecords', limit: 3 }), []);
        assert.equal(remoteSuccesses, 1);
        assert.equal(localExecutions, 1);
        malformedAuthorityResponseOnly = false;

        forgeBeforeRemoteResponse = true;
        assert.deepEqual(await coordinator.run({ kind: 'recentRecords', limit: 3 }), []);
        assert.equal(remoteSuccesses, 2);
        assert.equal(localExecutions, 1);
        forgeBeforeRemoteResponse = false;

        remoteError = 'busy';
        assert.deepEqual(await coordinator.run({ kind: 'recentRecords', limit: 3 }), []);
        assert.equal(remoteSuccesses, 2);
        assert.equal(localExecutions, 2);
        remoteError = undefined;

        remoteResponseEnabled = false;
        assert.deepEqual(await coordinator.run({ kind: 'recentRecords', limit: 3 }), []);
        assert.equal(localExecutions, 3);

        remoteResponseEnabled = true;
        compatibleTransport = false;
        const requestsBeforeLocalFallback = remoteRequests;
        assert.deepEqual(await coordinator.run({ kind: 'recentRecords', limit: 3 }), []);
        assert.equal(remoteRequests, requestsBeforeLocalFallback);
        assert.equal(localExecutions, 4);
        compatibleTransport = true;

        await t.test('authority change cancels the pending query and ignores the old leader response', async () => {
            suppressRemoteResponse = true;
            const localExecutionsBefore = localExecutions;
            const remoteSuccessesBefore = remoteSuccesses;
            try {
                const result = coordinator.run({ kind: 'recentRecords', limit: 3 });
                const request = remoteRequestEvents.at(-1)?.payload;
                assert.ok(request);
                assert.ok(authorityChangedHandler);

                authorityTerm = 'next-leader:2';
                authorityChangedHandler(authorityTerm);

                assert.deepEqual(await result, []);
                assert.equal(localExecutions, localExecutionsBefore + 1);
                assert.equal(remoteSuccesses, remoteSuccessesBefore);

                handlers.get('usagesQueryCompleted')?.({
                    type: 'usagesQueryCompleted',
                    payload: {
                        requestId: request.requestId,
                        targetInstanceId: 'follower',
                        authorityTerm: request.authorityTerm,
                        result: { kind: 'recentRecords', value: [] }
                    },
                    timestamp: Date.now(),
                    senderInstanceId: 'leader'
                } satisfies UsagesQueryCompletedEvent);
                await Promise.resolve();

                assert.equal(localExecutions, localExecutionsBefore + 1);
                assert.equal(remoteSuccesses, remoteSuccessesBefore);
            } finally {
                authorityTerm = 'leader:1';
                suppressRemoteResponse = false;
            }
        });

        await t.test('remote timeout falls back once and ignores a late response', async () => {
            const constants = UsagesQueryCoordinator as unknown as { QUERY_TIMEOUT_MS: number };
            const originalTimeoutMs = constants.QUERY_TIMEOUT_MS;
            assert.equal(originalTimeoutMs, 15_000);
            constants.QUERY_TIMEOUT_MS = 1;
            suppressRemoteResponse = true;
            const localExecutionsBefore = localExecutions;
            const remoteSuccessesBefore = remoteSuccesses;
            try {
                const result = coordinator.run({ kind: 'recentRecords', limit: 3 });
                const request = remoteRequestEvents.at(-1)?.payload;
                assert.ok(request);
                assert.equal(localExecutions, localExecutionsBefore);

                assert.deepEqual(await result, []);
                assert.equal(localExecutions, localExecutionsBefore + 1);
                assert.equal(remoteSuccesses, remoteSuccessesBefore);

                handlers.get('usagesQueryCompleted')?.({
                    type: 'usagesQueryCompleted',
                    payload: {
                        requestId: request.requestId,
                        targetInstanceId: 'follower',
                        authorityTerm: request.authorityTerm,
                        result: { kind: 'recentRecords', value: [] }
                    },
                    timestamp: Date.now(),
                    senderInstanceId: 'leader'
                } satisfies UsagesQueryCompletedEvent);
                await Promise.resolve();

                assert.equal(localExecutions, localExecutionsBefore + 1);
                assert.equal(remoteSuccesses, remoteSuccessesBefore);
            } finally {
                constants.QUERY_TIMEOUT_MS = originalTimeoutMs;
                suppressRemoteResponse = false;
            }
        });

        isLeader = true;
        await handlers.get('usagesQueryRequested')?.({
            type: 'usagesQueryRequested',
            payload: {
                requestId: 'request-1',
                requestedBy: 'follower',
                authorityTerm: 'leader:1',
                query: { kind: 'recentRecords', limit: 3 }
            },
            timestamp: Date.now(),
            senderInstanceId: 'follower'
        } satisfies UsagesQueryRequestedEvent);
        await new Promise<void>(resolve => setImmediate(resolve));
        assert.equal(targeted.length, 1);
        assert.equal(targeted[0].target, 'follower');
        assert.equal(targeted[0].event.type, 'usagesQueryCompleted');
        assert.equal(targeted[0].event.payload.targetInstanceId, 'follower');
        assert.equal(targeted[0].event.payload.result?.kind, 'recentRecords');

        rejectResultAsTooLarge = true;
        await handlers.get('usagesQueryRequested')?.({
            type: 'usagesQueryRequested',
            payload: {
                requestId: 'request-2',
                requestedBy: 'follower',
                authorityTerm: 'leader:1',
                query: { kind: 'recentRecords', limit: 3 }
            },
            timestamp: Date.now(),
            senderInstanceId: 'follower'
        } satisfies UsagesQueryRequestedEvent);
        await new Promise<void>(resolve => setImmediate(resolve));
        assert.equal(targeted.length, 2);
        assert.equal(targeted[1].event.payload.requestId, 'request-2');
        assert.equal(targeted[1].event.payload.result, undefined);
        assert.equal(targeted[1].event.payload.error, 'response-too-large');

        await handlers.get('usagesQueryRequested')?.({
            type: 'usagesQueryRequested',
            payload: {
                requestId: 'victim-request',
                requestedBy: 'follower-a',
                authorityTerm: 'leader:1',
                query: { kind: 'recentRecords', limit: 3 }
            },
            timestamp: Date.now(),
            senderInstanceId: 'follower-b'
        } satisfies UsagesQueryRequestedEvent);
        await new Promise<void>(resolve => setImmediate(resolve));
        assert.equal(targeted.length, 2);

        assert.doesNotThrow(() =>
            handlers.get('usagesQueryCompleted')?.({
                type: 'usagesQueryCompleted',
                payload: null,
                timestamp: Date.now(),
                senderInstanceId: 'leader'
            })
        );

        const coordinatorInternals = coordinator as unknown as {
            handleRequested: (event: UsagesQueryRequestedEvent) => Promise<void>;
        };
        await assert.doesNotReject(() =>
            coordinatorInternals.handleRequested({
                type: 'usagesQueryRequested',
                payload: null,
                timestamp: Date.now(),
                senderInstanceId: 'follower'
            } as unknown as UsagesQueryRequestedEvent)
        );

        rejectResultAsTooLarge = false;
        const timestamp = Date.now();
        const pending: UsagesPendingRecord = {
            requestId: 'pending',
            timestamp,
            isoTime: new Date(timestamp).toISOString(),
            providerKey: 'test',
            providerName: 'Test',
            modelId: 'test',
            modelName: 'Test',
            estimatedInput: 10,
            status: 'estimated',
            rawUsage: null,
            sessionTitle: '本窗标题'
        };
        const request: UsagesQueryRequestedEvent = {
            type: 'usagesQueryRequested',
            payload: {
                requestId: 'with-pending',
                requestedBy: 'follower',
                authorityTerm: 'leader:1',
                query: { kind: 'recentRecords', limit: 3 },
                pendingRecords: [pending]
            },
            timestamp,
            senderInstanceId: 'follower'
        };
        await coordinatorInternals.handleRequested(request);
        assert.deepEqual(executedPending, [pending]);
        assert.notEqual(executedPending[0], pending);
        const executionsBeforeInvalid = localExecutions;
        for (const invalid of [
            null,
            [pending, pending],
            [{ ...pending, status: 'completed' }],
            [{ ...pending, outputSpeed: -1 }]
        ]) {
            await coordinatorInternals.handleRequested({
                ...request,
                payload: { ...request.payload, pendingRecords: invalid }
            } as unknown as UsagesQueryRequestedEvent);
            assert.equal(targeted.at(-1)?.event.payload.error, 'invalid-request');
            assert.equal(localExecutions, executionsBeforeInvalid);
        }

        await t.test('independent query slots are not blocked by an unrelated slow query', async () => {
            let signalFirstStarted!: () => void;
            let releaseFirst!: () => void;
            const firstStarted = new Promise<void>(resolve => {
                signalFirstStarted = resolve;
            });
            const firstBlocked = new Promise<void>(resolve => {
                releaseFirst = resolve;
            });
            let secondStarted = false;
            const independentCoordinator = new UsagesQueryCoordinator(async query => {
                if (query.kind !== 'dateOverview') {
                    throw new Error('Unexpected query kind');
                }
                if (query.date === '2026-09-24') {
                    signalFirstStarted();
                    await firstBlocked;
                } else {
                    secondStarted = true;
                }
                return {
                    kind: 'dateOverview',
                    value: {
                        allSummary: {
                            requestCount: 0,
                            totalTokens: 0,
                            completedCount: 0,
                            failedCount: 0,
                            cancelledCount: 0
                        },
                        allTotals: {
                            inputTokens: 0,
                            cacheTokens: 0,
                            outputTokens: 0,
                            totalCost: 0,
                            totalCostRmb: 0,
                            nativeCosts: createEmptyNativeCostSplit(),
                            costedRequests: 0,
                            rmbExactRequests: 0
                        },
                        nativeSplitIndex: {
                            total: createEmptyNativeCostSplit(),
                            providers: {},
                            models: {},
                            hours: {},
                            hourProviders: {},
                            hourModels: {}
                        },
                        sessionGroups: []
                    }
                };
            });
            t.after(() => independentCoordinator.dispose());

            const first = independentCoordinator.run({ kind: 'dateOverview', date: '2026-09-24' });
            await firstStarted;
            const second = independentCoordinator.run({ kind: 'dateOverview', date: '2026-09-25' });
            await new Promise<void>(resolve => setImmediate(resolve));
            assert.equal(secondStarted, true);
            releaseFirst();
            await Promise.all([first, second]);
        });

        await t.test('remote query backlog is bounded per follower', async () => {
            let signalFirstStarted!: () => void;
            let releaseQueries!: () => void;
            const firstStarted = new Promise<void>(resolve => {
                signalFirstStarted = resolve;
            });
            const blocked = new Promise<void>(resolve => {
                releaseQueries = resolve;
            });
            let executions = 0;
            const boundedCoordinator = new UsagesQueryCoordinator(async query => {
                executions += 1;
                if (executions === 1) {
                    signalFirstStarted();
                }
                await blocked;
                return { kind: query.kind, value: [] } as never;
            });
            t.after(() => boundedCoordinator.dispose());
            const internals = boundedCoordinator as unknown as {
                handleRequested: (event: UsagesQueryRequestedEvent) => Promise<void>;
            };
            const targetedBefore = targeted.length;
            const requests = Array.from({ length: 5 }, (_, index) =>
                internals.handleRequested({
                    type: 'usagesQueryRequested',
                    payload: {
                        requestId: `bounded-${index}`,
                        requestedBy: 'follower-bounded',
                        authorityTerm: 'leader:1',
                        query: { kind: 'recentRecords', limit: 3 }
                    },
                    timestamp: Date.now(),
                    senderInstanceId: 'follower-bounded'
                })
            );
            await firstStarted;
            await new Promise<void>(resolve => setImmediate(resolve));
            releaseQueries();
            await Promise.all(requests);

            const responses = targeted
                .slice(targetedBefore)
                .filter(entry => entry.event.payload.requestId.startsWith('bounded-'));
            assert.equal(responses.filter(entry => entry.event.payload.error === 'busy').length, 1);
            assert.equal(responses.filter(entry => entry.event.payload.result?.kind === 'recentRecords').length, 4);
            assert.equal(executions, 4);
        });
    } finally {
        NodeModule.prototype.require = originalRequire;
    }
});
