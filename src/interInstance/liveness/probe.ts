import { randomUUID } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import type { InterInstanceEvent } from '../eventProtocol';
import type { IpcClient } from '../ipcClient';
import type { LeaderIdentity } from '../../status/leaderElectionService';
import { isLeaderLivenessPayload } from './protocol';

type ProbeClient = Pick<IpcClient, 'send'>;
export type LeaderLivenessResult = 'alive' | 'unconfirmed' | 'invalidated';

interface PendingProbe {
    client: ProbeClient;
    leaderId: string;
    authorityTerm: string;
    requesterId: string;
    requestId: string;
    deadline: number;
    promise: Promise<LeaderLivenessResult>;
    resolve(value: LeaderLivenessResult): void;
    timer: ReturnType<typeof setTimeout>;
}

export class LeaderLivenessProbe {
    private pending: PendingProbe | undefined;

    constructor(
        private readonly timeoutMs = 1000,
        private readonly now: () => number = () => performance.now()
    ) {}

    confirm(
        client: ProbeClient,
        identity: Pick<LeaderIdentity, 'instanceId' | 'authorityTerm'>,
        requesterId: string
    ): Promise<LeaderLivenessResult> {
        const current = this.pending;
        if (
            current &&
            current.client === client &&
            current.leaderId === identity.instanceId &&
            current.authorityTerm === identity.authorityTerm &&
            current.requesterId === requesterId
        ) {
            return current.promise;
        }
        this.cancel();
        let resolve!: (value: LeaderLivenessResult) => void;
        const promise = new Promise<LeaderLivenessResult>(done => {
            resolve = done;
        });
        const pending: PendingProbe = {
            client,
            leaderId: identity.instanceId,
            authorityTerm: identity.authorityTerm,
            requesterId,
            requestId: randomUUID(),
            deadline: this.now() + this.timeoutMs,
            promise,
            resolve,
            timer: setTimeout(() => this.finish(pending, 'unconfirmed'), this.timeoutMs)
        };
        this.pending = pending;
        try {
            client.send({
                type: 'leaderLivenessRequested',
                payload: {
                    requestId: pending.requestId,
                    targetInstanceId: identity.instanceId,
                    authorityTerm: identity.authorityTerm
                },
                timestamp: Date.now(),
                senderInstanceId: requesterId
            });
        } catch {
            this.finish(pending, 'unconfirmed');
        }
        return promise;
    }

    accept(event: InterInstanceEvent, client: ProbeClient): void {
        const pending = this.pending;
        if (
            !pending ||
            pending.client !== client ||
            event.type !== 'leaderLivenessConfirmed' ||
            !isLeaderLivenessPayload(event.payload)
        ) {
            return;
        }
        if (this.now() >= pending.deadline) {
            this.finish(pending, 'unconfirmed');
            return;
        }
        if (
            event.senderInstanceId === pending.leaderId &&
            event.payload.requestId === pending.requestId &&
            event.payload.targetInstanceId === pending.requesterId &&
            event.payload.authorityTerm === pending.authorityTerm
        ) {
            this.finish(pending, 'alive');
        }
    }

    cancel(): void {
        if (this.pending) {
            this.finish(this.pending, 'invalidated');
        }
    }

    private finish(pending: PendingProbe, result: LeaderLivenessResult): void {
        if (this.pending !== pending) {
            return;
        }
        this.pending = undefined;
        clearTimeout(pending.timer);
        pending.resolve(result);
    }
}
