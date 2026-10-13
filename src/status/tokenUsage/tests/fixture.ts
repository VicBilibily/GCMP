import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import type { TestContext } from 'node:test';
import type { ConfigurationChangeEvent, ExtensionContext } from 'vscode';
import type { TokenUsageUpdatedEvent } from '../../../interInstance/eventProtocol';
import { DateUtils } from '../../../usages/fileLogger/dateUtils';
import type { UsageStatusSnapshot, UsageStatusTotals } from '../../../usages/status/snapshot';

export const allowedCommands = [
    'gcmp.tokenUsage.showDetails',
    'gcmp.configSet.manage',
    'gcmp.modelSettings.wizard',
    'gcmp.har.revealCurrent'
];

export class MarkdownString {
    value = '';
    supportHtml = false;
    isTrusted: boolean | { enabledCommands: readonly string[] } | undefined = false;

    appendMarkdown(value: string): this {
        this.value += value;
        return this;
    }
}

class StatusItem {
    name = '';
    command = '';
    text = '';
    tooltip: string | MarkdownString = '';
    shows = 0;
    disposeCalls = 0;

    show(): void {
        this.shows++;
    }

    dispose(): void {
        this.disposeCalls++;
    }
}

class Signal<T> {
    readonly listeners = new Set<(value: T) => void>();
    disposals = 0;

    subscribe(listener: (value: T) => void): { dispose(): void } {
        this.listeners.add(listener);
        let active = true;
        return {
            dispose: () => {
                if (active) {
                    active = false;
                    this.listeners.delete(listener);
                    this.disposals++;
                }
            }
        };
    }

    emit(value: T): void {
        for (const listener of [...this.listeners]) {
            listener(value);
        }
    }
}

export function snapshot(requests = 2, overrides: Partial<UsageStatusTotals> = {}): UsageStatusSnapshot {
    const total: UsageStatusTotals = {
        actualInput: requests * 50,
        cacheTokens: requests * 10,
        outputTokens: requests * 25,
        requests,
        costedRequests: requests,
        rmbExactRequests: 0,
        estimatedCost: requests * 0.01,
        estimatedCostRmb: requests * 0.07,
        nativeCosts: { totalUsd: requests * 0.01, totalRmb: 0 },
        firstTokenLatency: 250,
        outputSpeeds: 12.5,
        ...overrides
    };
    return {
        date: DateUtils.getTodayDateString(),
        authorityTerm: 'leader:1',
        revision: Math.max(1, requests),
        stats: {
            total,
            providers: requests === 0 ? {} : { test: { ...total, providerName: 'Test Provider' } }
        }
    };
}

export function deferred<T>(): { promise: Promise<T>; resolve(value: T): void } {
    let resolve!: (value: T) => void;
    const promise = new Promise<T>(release => {
        resolve = release;
    });
    return { promise, resolve };
}

export function settle(): Promise<void> {
    return new Promise(resolve => setImmediate(resolve));
}

export function tooltip(item: StatusItem): MarkdownString {
    assert.ok(item.tooltip instanceof MarkdownString);
    return item.tooltip;
}

type SnapshotReader = () => Promise<UsageStatusSnapshot | undefined>;

export async function createStatusBarHost(parent: TestContext) {
    const require = createRequire(import.meta.url);
    const NodeModule = require('node:module') as { prototype: { require(id: string): unknown } };
    const originalRequire = NodeModule.prototype.require;
    parent.after(() => {
        NodeModule.prototype.require = originalRequire;
    });
    const snapshots = new Signal<UsageStatusSnapshot>();
    const usage = new Signal<TokenUsageUpdatedEvent>();
    const role = new Signal<void>();
    const configuration = new Signal<Pick<ConfigurationChangeEvent, 'affectsConfiguration'>>();
    const state = {
        language: 'zh-cn',
        leader: false,
        har: false,
        active: true,
        fileMode: false,
        reads: 0,
        dateReads: 0,
        detailReads: 0,
        created: 0,
        errors: [] as unknown[],
        item: new StatusItem(),
        read: (async () => snapshot()) as SnapshotReader
    };
    const manager = {
        onStatusSnapshot: (listener: (value: UsageStatusSnapshot) => void) => snapshots.subscribe(listener),
        isStatusFileMode: () => state.fileMode,
        async getStatusSnapshot(): Promise<UsageStatusSnapshot | undefined> {
            state.reads++;
            return state.read();
        },
        getDateStats(): never {
            state.dateReads++;
            throw new Error('Status bar must not query date statistics');
        },
        getRecordsPage(): never {
            state.detailReads++;
            throw new Error('Status bar must not query request details');
        }
    };
    NodeModule.prototype.require = function (id: string): unknown {
        if (id === 'vscode') {
            return {
                window: {
                    createStatusBarItem: () => {
                        state.created++;
                        return state.item;
                    }
                },
                workspace: { onDidChangeConfiguration: configuration.subscribe.bind(configuration) },
                env: {
                    get language() {
                        return state.language;
                    }
                },
                StatusBarAlignment: { Right: 2 },
                MarkdownString
            };
        }
        if (id.endsWith('/usagesManager')) {
            return {
                TokenUsagesManager: {
                    get instance() {
                        return manager;
                    }
                }
            };
        }
        if (id.endsWith('/leaderElectionService')) {
            return {
                LeaderElectionService: {
                    isLeader: () => state.leader,
                    onLeaderChanged: role.subscribe.bind(role)
                }
            };
        }
        if (id.endsWith('/interInstance')) {
            return {
                InterInstanceBus: {
                    subscribe: (type: string, listener: (event: TokenUsageUpdatedEvent) => void) => {
                        assert.equal(type, 'tokenUsageUpdated');
                        return usage.subscribe(listener);
                    }
                }
            };
        }
        if (id.endsWith('/harRecorder')) {
            return { HarRecorder: { getInstance: () => ({ isEnabled: () => state.har }) } };
        }
        if (id.endsWith('/l10n')) {
            return { t: (english: string, chinese: string) => (state.language.startsWith('zh') ? chinese : english) };
        }
        if (id.endsWith('/userActivityService')) {
            return { UserActivityService: { isUserActive: () => state.active } };
        }
        if (id.endsWith('/statusLogger')) {
            return {
                StatusLogger: {
                    debug() {},
                    trace() {},
                    error(_message: string, error: unknown) {
                        state.errors.push(error);
                    }
                }
            };
        }
        return originalRequire.call(this, id);
    };
    const { TokenUsageStatusBar } = await import('../../tokenUsageStatusBar');
    return {
        state,
        snapshots,
        usage,
        role,
        configuration,
        emitUsage(date: string): void {
            usage.emit({
                type: 'tokenUsageUpdated',
                timestamp: Date.now(),
                senderInstanceId: 'other',
                payload: { date, totalTokens: 0, totalRequests: 0 }
            });
        },
        configure(section = 'gcmp.debug.captureHar'): void {
            configuration.emit({ affectsConfiguration: candidate => candidate === section });
        },
        async start(context: TestContext, read: SnapshotReader = async () => snapshot()) {
            context.mock.timers.enable({ apis: ['Date', 'setTimeout', 'setInterval'], now: new Date(2026, 9, 13, 12) });
            Object.assign(state, {
                language: 'zh-cn',
                leader: false,
                har: false,
                active: true,
                fileMode: false,
                reads: 0,
                dateReads: 0,
                detailReads: 0,
                created: 0,
                errors: [],
                item: new StatusItem(),
                read
            });
            for (const signal of [snapshots, usage, role, configuration]) {
                assert.equal(signal.listeners.size, 0);
                signal.disposals = 0;
            }
            const subscriptions: { dispose(): void }[] = [];
            const bar = new TokenUsageStatusBar({ subscriptions } as unknown as ExtensionContext);
            const item = state.item;
            context.after(() => {
                bar.dispose();
                assert.equal(state.dateReads, 0);
                assert.equal(state.detailReads, 0);
                assert.equal(item.disposeCalls, 1);
                for (const signal of [snapshots, usage, role, configuration]) {
                    assert.equal(signal.listeners.size, 0);
                    assert.equal(signal.disposals, 1);
                }
            });
            await bar.initialize();
            await settle();
            assert.equal(subscriptions.length, 5);
            return { bar, item };
        }
    };
}
