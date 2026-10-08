import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type * as vscode from 'vscode';
import type { LeaderIdentity } from '../../status/leaderElectionService';

class HostEmitter<T> {
    private readonly listeners = new Set<(value: T) => void>();
    readonly event = (listener: (value: T) => void) => {
        this.listeners.add(listener);
        return { dispose: () => this.listeners.delete(listener) };
    };
    fire(value: T): void {
        for (const listener of this.listeners) {
            listener(value);
        }
    }
    dispose(): void {
        this.listeners.clear();
    }
}

export function ipcPath(): string {
    const name = `gcmp-flow-${randomUUID()}`;
    return process.platform === 'win32' ? `\\\\.\\pipe\\${name}` : join(tmpdir(), `${name}.sock`);
}

export async function waitFor(condition: () => boolean, message: string): Promise<void> {
    const deadline = Date.now() + 5000;
    while (!condition()) {
        if (Date.now() >= deadline) {
            throw new Error(message);
        }
        await new Promise<void>(resolve => setTimeout(resolve, 5));
    }
}

export async function createIpcHost() {
    const require = createRequire(import.meta.url);
    const nodeModule = require('node:module') as { prototype: { require(id: string): unknown } };
    const originalRequire = nodeModule.prototype.require;
    const logs: Array<{ level: string; message: string }> = [];
    const record = (level: string) => (message: string) => logs.push({ level, message });
    const role = new HostEmitter<boolean>();
    const identity = new HostEmitter<LeaderIdentity | undefined>();
    const election = { leader: false, agents: false };
    nodeModule.prototype.require = function (id: string): unknown {
        if (id === 'vscode') {
            return {
                env: {},
                EventEmitter: HostEmitter,
                Disposable: class {
                    constructor(private readonly callback: () => void) {}
                    dispose(): void {
                        this.callback();
                    }
                }
            };
        }
        if (id.endsWith('/statusLogger')) {
            return {
                StatusLogger: {
                    info: record('info'),
                    debug: record('debug'),
                    warn: record('warn'),
                    error: record('error'),
                    trace: record('trace')
                }
            };
        }
        if (id.endsWith('/leaderElectionService')) {
            return {
                LeaderElectionService: {
                    isLeader: () => election.leader,
                    isAgentsWindow: () => election.agents,
                    getInstanceId: () => 'flow-follower',
                    getLeaderId: () => 'flow-leader',
                    onLeaderChanged: role.event,
                    onLeaderIdentityChanged: identity.event
                }
            };
        }
        return originalRequire.call(this, id);
    };
    try {
        const { IpcServer } = await import('../ipcServer');
        const { IpcClient } = await import('../ipcClient');
        const { InterInstanceBus } = await import('../interInstanceBus');
        return {
            IpcServer,
            IpcClient,
            InterInstanceBus,
            logs,
            election,
            identity,
            role,
            context: () =>
                ({
                    subscriptions: [],
                    extension: { packageJSON: { version: '1.0.0' } }
                }) as unknown as vscode.ExtensionContext,
            restore: () => {
                nodeModule.prototype.require = originalRequire;
                role.dispose();
                identity.dispose();
            }
        };
    } catch (error) {
        nodeModule.prototype.require = originalRequire;
        throw error;
    }
}
