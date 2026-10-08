import { AsyncLocalStorage } from 'node:async_hooks';
import { mkdtemp, rm } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { TestContext } from 'node:test';
import type * as vscode from 'vscode';
import type {
    StatsRefreshCompletedEvent,
    StatsRefreshRequestedEvent,
    TokenUsageUpdatedEvent
} from '../../interInstance/eventProtocol';
import type { LogPathManager } from '../fileLogger/logPathManager';
import type { LogReadManager } from '../fileLogger/logReadManager';
import type { LogStatsManager } from '../fileLogger/logStatsManager';
import type { LogWriteManager } from '../fileLogger/logWriteManager';
import type { SnapshotManager } from '../fileLogger/snapshotManager';
import type { TokenUsagesManager } from '../usagesManager';

export type UsageEvent = StatsRefreshRequestedEvent | StatsRefreshCompletedEvent | TokenUsageUpdatedEvent;
type OutgoingEvent =
    | Omit<StatsRefreshRequestedEvent, 'timestamp' | 'senderInstanceId'>
    | Omit<StatsRefreshCompletedEvent, 'timestamp' | 'senderInstanceId'>
    | Omit<TokenUsageUpdatedEvent, 'timestamp' | 'senderInstanceId'>;

export interface LoggerInternals {
    pathManager: LogPathManager;
    readManager: LogReadManager;
    logStatsManager: LogStatsManager;
    writeManager: LogWriteManager;
    snapshotManager: SnapshotManager;
    pendingStatsRefreshRequests: Map<string, unknown>;
    refreshCurrentStats(): void;
    doRefreshCurrentStats(): Promise<void>;
}

export async function createUsageHost() {
    const require = createRequire(import.meta.url);
    const NodeModule = require('node:module') as { prototype: { require(id: string): unknown } };
    const originalRequire = NodeModule.prototype.require;
    const scope = new AsyncLocalStorage<string>();
    const currentId = () => scope.getStore() ?? 'leader';
    const listeners = new Set<{ owner: string; type: string; callback(event: UsageEvent): void }>();
    const events: Array<{ event: UsageEvent; alsoFallback: boolean }> = [];
    const warnings: string[] = [];
    const periodic: Array<() => Promise<void>> = [];
    const managers = new Map<string, TokenUsagesManager>();
    const state = {
        leaderId: 'leader' as string | undefined,
        heartbeatFresh: true,
        deliver: true,
        createPanel: undefined as (() => vscode.WebviewPanel) | undefined
    };
    const run = <T>(id: string, action: () => T): T => scope.run(id, action);
    const deliver = (event: UsageEvent) => {
        for (const listener of [...listeners]) {
            if (listener.owner !== event.senderInstanceId && listener.type === event.type) {
                run(listener.owner, () => listener.callback(event));
            }
        }
    };
    const bus = {
        subscribe(type: string, callback: (event: UsageEvent) => void) {
            const listener = { owner: currentId(), type, callback };
            listeners.add(listener);
            return { dispose: () => listeners.delete(listener) };
        },
        publish(event: OutgoingEvent, options?: { alsoFallback?: boolean }) {
            const full = { ...event, timestamp: Date.now(), senderInstanceId: currentId() } as UsageEvent;
            events.push({ event: full, alsoFallback: options?.alsoFallback === true });
            if (state.deliver) {
                deliver(full);
            }
        }
    };
    const logger = {
        trace() {},
        debug() {},
        info() {},
        warn: (message: unknown) => warnings.push(String(message)),
        error: (message: unknown) => warnings.push(String(message))
    };
    NodeModule.prototype.require = function (id: string): unknown {
        if (id === 'vscode') {
            return {
                window: { createWebviewPanel: () => state.createPanel?.() },
                ViewColumn: { One: 1 },
                env: { language: 'zh-cn' }
            };
        }
        if (id.endsWith('/interInstance')) {
            return { InterInstanceBus: bus };
        }
        if (id.endsWith('/leaderElectionService')) {
            return {
                LeaderElectionService: {
                    getLeaderId: () => state.leaderId,
                    getInstanceId: currentId,
                    isLeader: () => currentId() === state.leaderId,
                    isLeaderHeartbeatFresh: () => state.heartbeatFresh,
                    registerPeriodicTask: (callback: () => Promise<void>) => periodic.push(callback)
                }
            };
        }
        if (id.endsWith('/liveMetrics')) {
            return { onLiveMetrics: () => ({ dispose() {} }) };
        }
        if (id.endsWith('/statusLogger')) {
            return { StatusLogger: logger };
        }
        if (id.endsWith('/runtime/logger')) {
            return { Logger: logger };
        }
        return originalRequire.call(this, id);
    };
    try {
        const { TokenFileLogger } = await import('../fileLogger');
        const { TokenUsagesManager: ManagerClass } = await import('../usagesManager');
        const { StatsCalculator } = await import('../fileLogger/statsCalculator');
        const originalInstance = Object.getOwnPropertyDescriptor(ManagerClass, 'instance')!;
        const Manager = ManagerClass as unknown as new () => TokenUsagesManager;
        Object.defineProperty(ManagerClass, 'instance', {
            configurable: true,
            get: () => managers.get(currentId()) ?? originalInstance.value
        });
        return {
            run,
            deliver,
            bus,
            events,
            warnings,
            periodic,
            state,
            emptyStats: () => StatsCalculator.aggregateLogs([]),
            async fixture(context: TestContext, id = 'leader') {
                const dir = await mkdtemp(join(tmpdir(), 'gcmp-usages-opt-'));
                const extensionContext = {
                    globalStorageUri: { fsPath: dir },
                    extensionPath: dir,
                    subscriptions: [] as vscode.Disposable[]
                } as vscode.ExtensionContext;
                const fileLogger = run(id, () => new TokenFileLogger(extensionContext));
                const manager = new Manager();
                Object.assign(manager, { initialized: true, fileLogger });
                managers.set(id, manager);
                const internals = fileLogger as unknown as LoggerInternals;
                context.mock.method(internals, 'refreshCurrentStats', () => {});
                context.after(async () => {
                    for (const subscription of extensionContext.subscriptions) {
                        subscription.dispose();
                    }
                    await run(id, () => manager.dispose());
                    if (managers.get(id) === manager) {
                        managers.delete(id);
                    }
                    await rm(dir, { recursive: true, force: true });
                });
                return { dir, extensionContext, fileLogger, manager, internals };
            },
            reset() {
                events.length = 0;
                warnings.length = 0;
                periodic.length = 0;
                state.leaderId = 'leader';
                state.heartbeatFresh = true;
                state.deliver = true;
            },
            restore() {
                Object.defineProperty(ManagerClass, 'instance', originalInstance);
                NodeModule.prototype.require = originalRequire;
            }
        };
    } catch (error) {
        NodeModule.prototype.require = originalRequire;
        throw error;
    }
}
