import { AsyncLocalStorage } from 'node:async_hooks';
import { createRequire } from 'node:module';
import type { TestContext } from 'node:test';
import type { InterInstanceEvent } from '../../../interInstance/eventProtocol';
import type { TokenStats, TokenUsageStatsFromFile } from '../../fileLogger/types';
import type { StatsResultSource } from '../../fileLogger/refresh/statsRefreshQueue';
import type { LatestUsageStatus } from '../snapshot';

export function stats(count = 1): TokenUsageStatsFromFile {
    const total: TokenStats = {
        estimatedInput: 0,
        actualInput: count * 10,
        cacheTokens: count * 4,
        outputTokens: count * 5,
        requests: count,
        costedRequests: count,
        rmbExactRequests: 0,
        estimatedCost: count * 0.1,
        estimatedCostRmb: count * 0.7,
        inputCost: 0,
        inputCostRmb: 0,
        outputCost: 0,
        outputCostRmb: 0,
        cacheReadCost: 0,
        cacheReadCostRmb: 0,
        cacheWriteCost: 0,
        cacheWriteCostRmb: 0,
        completedRequests: count,
        failedRequests: 0,
        cancelledRequests: 0,
        outputSpeeds: 5,
        firstTokenLatency: 100
    };
    return { total, providers: { test: { ...total, providerName: 'Test', models: {} } }, hourly: {} };
}

export function gate() {
    let release!: () => void;
    const promise = new Promise<void>(resolve => {
        release = resolve;
    });
    return { promise, release };
}

type Outgoing =
    InterInstanceEvent extends infer E ?
        E extends InterInstanceEvent ?
            Omit<E, 'timestamp' | 'senderInstanceId'>
        :   never
    :   never;

export async function createStatusHost() {
    const require = createRequire(import.meta.url);
    const NodeModule = require('node:module') as { prototype: { require(id: string): unknown } };
    const original = NodeModule.prototype.require;
    const scope = new AsyncLocalStorage<string>();
    const current = () => scope.getStore() ?? 'leader';
    const run = <T>(id: string, action: () => T) => scope.run(id, action);
    const listeners = new Set<{ id: string; type: string; callback(event: InterInstanceEvent): void }>();
    const authorityListeners = new Set<{ id: string; callback(): void }>();
    const events: InterInstanceEvent[] = [];
    const state = {
        leader: 'leader',
        term: 'leader:1',
        connected: true,
        send: true,
        deliver: true,
        savedReads: 0,
        ownedReads: 0
    };
    const deliver = (event: InterInstanceEvent, target?: string) => {
        for (const listener of listeners) {
            if (
                listener.type === event.type &&
                listener.id !== event.senderInstanceId &&
                (target === undefined || listener.id === target)
            ) {
                run(listener.id, () => listener.callback(event));
            }
        }
    };
    const bus = {
        publish(event: Outgoing) {
            return this.publishIpcOnly(event);
        },
        subscribe(type: string, callback: (event: InterInstanceEvent) => void) {
            const listener = { id: current(), type, callback };
            listeners.add(listener);
            return { dispose: () => listeners.delete(listener) };
        },
        onAuthorityChanged(callback: () => void) {
            const listener = { id: current(), callback };
            authorityListeners.add(listener);
            return { dispose: () => authorityListeners.delete(listener) };
        },
        getAuthorityTerm: () => state.term,
        hasCompatibleUsagesQueryTransport: () => state.connected,
        publishIpcOnly(event: Outgoing) {
            if (!state.send || !state.connected) {
                return false;
            }
            const full = { ...event, timestamp: Date.now(), senderInstanceId: current() } as InterInstanceEvent;
            events.push(full);
            if (state.deliver) {
                deliver(full);
            }
            return true;
        },
        publishToInstance(target: string, event: Outgoing) {
            const full = { ...event, timestamp: Date.now(), senderInstanceId: current() } as InterInstanceEvent;
            events.push(full);
            deliver(full, target);
            return true;
        }
    };
    NodeModule.prototype.require = function (id: string): unknown {
        if (id === 'vscode') {
            return { window: {}, env: { language: 'zh-cn' } };
        }
        if (id.endsWith('/interInstance')) {
            return { InterInstanceBus: bus };
        }
        if (id.endsWith('/leaderElectionService')) {
            return {
                LeaderElectionService: {
                    getInstanceId: current,
                    getLeaderId: () => state.leader || undefined,
                    getAuthorityTerm: () => state.term,
                    getOwnedAuthorityTerm: () => (current() === state.leader ? state.term : undefined)
                }
            };
        }
        if (id.endsWith('/statusLogger')) {
            return { StatusLogger: { warn() {}, trace() {} } };
        }
        return original.call(this, id);
    };
    try {
        const { UsageStatusSnapshots } = await import('../usageStatusSnapshots');
        return {
            state,
            events,
            run,
            deliver,
            bus,
            fixture(
                t: TestContext,
                id = 'leader',
                fileMode = false,
                readSaved: () => Promise<TokenUsageStatsFromFile | null> = async () => stats(),
                readOwned: () => Promise<TokenUsageStatsFromFile> = async () => stats(),
                getSource?: (value: TokenUsageStatsFromFile) => StatsResultSource | undefined,
                getLatest?: (date: string) => LatestUsageStatus | undefined
            ) {
                const service = run(
                    id,
                    () =>
                        new UsageStatusSnapshots(
                            fileMode,
                            async () => {
                                state.savedReads++;
                                return readSaved();
                            },
                            async () => {
                                state.ownedReads++;
                                return readOwned();
                            },
                            getSource,
                            getLatest
                        )
                );
                t.after(() => service.dispose());
                return service;
            },
            changeTerm(term: string) {
                state.term = term;
                for (const listener of authorityListeners) {
                    run(listener.id, listener.callback);
                }
            },
            reset() {
                events.length = 0;
                state.savedReads = 0;
                state.ownedReads = 0;
                state.leader = 'leader';
                state.term = 'leader:1';
                state.connected = true;
                state.send = true;
                state.deliver = true;
            },
            restore() {
                NodeModule.prototype.require = original;
            }
        };
    } catch (error) {
        NodeModule.prototype.require = original;
        throw error;
    }
}
