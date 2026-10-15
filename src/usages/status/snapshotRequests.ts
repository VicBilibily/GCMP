import { randomUUID } from 'node:crypto';
import { InterInstanceBus, type UsageStatusSnapshotRequestedEvent } from '../../interInstance';
import { LeaderElectionService } from '../../status/leaderElectionService';
import { DateUtils } from '../fileLogger/dateUtils';
import type { UsageStatusSnapshot } from './snapshot';

interface PendingSnapshot {
    requestId: string;
    term: string;
    date: string;
    promise: Promise<UsageStatusSnapshot | undefined>;
    resolve(value: UsageStatusSnapshot | undefined): void;
    timer: ReturnType<typeof setTimeout>;
}

export class SnapshotRequests {
    private pending: PendingSnapshot | undefined;

    constructor(
        private readonly read: () => Promise<UsageStatusSnapshot | undefined>,
        private readonly generation: () => number,
        private readonly active: () => boolean
    ) {}

    matches(requestId: string): boolean {
        return this.pending?.requestId === requestId;
    }

    request(): Promise<UsageStatusSnapshot | undefined> {
        if (!this.active() || !InterInstanceBus.hasActiveTransport()) {
            return Promise.resolve(undefined);
        }
        const term = InterInstanceBus.getAuthorityTerm();
        if (!term) {
            return Promise.resolve(undefined);
        }
        const date = DateUtils.getTodayDateString();
        if (this.pending?.term === term && this.pending.date === date) {
            return this.pending.promise;
        }
        this.complete(undefined);
        const requestId = randomUUID();
        let resolve!: PendingSnapshot['resolve'];
        const promise = new Promise<UsageStatusSnapshot | undefined>(done => {
            resolve = done;
        });
        const timer = setTimeout(() => {
            if (this.pending?.requestId === requestId) {
                this.complete(undefined);
            }
        }, 2000);
        timer.unref();
        this.pending = { requestId, term, date, promise, resolve, timer };
        if (
            !InterInstanceBus.publishIpcOnly({
                type: 'usageStatusSnapshotRequested',
                payload: { requestId, requestedBy: LeaderElectionService.getInstanceId(), authorityTerm: term, date }
            })
        ) {
            this.complete(undefined);
        }
        return promise;
    }

    async reply(event: UsageStatusSnapshotRequestedEvent): Promise<void> {
        const payload = event.payload;
        const term = LeaderElectionService.getOwnedAuthorityTerm();
        if (
            !this.active() ||
            !term ||
            !payload ||
            typeof payload.requestId !== 'string' ||
            !payload.requestId ||
            payload.requestId.length > 128 ||
            payload.requestedBy !== event.senderInstanceId ||
            payload.authorityTerm !== term ||
            payload.date !== DateUtils.getTodayDateString()
        ) {
            return;
        }
        const generation = this.generation();
        const snapshot = await this.read();
        if (
            !this.active() ||
            generation !== this.generation() ||
            LeaderElectionService.getOwnedAuthorityTerm() !== term ||
            snapshot?.authorityTerm !== term ||
            snapshot.date !== DateUtils.getTodayDateString()
        ) {
            return;
        }
        InterInstanceBus.publishToInstance(event.senderInstanceId, {
            type: 'usageStatusSnapshot',
            payload: { snapshot, requestId: payload.requestId, targetInstanceId: event.senderInstanceId }
        });
    }

    complete(snapshot: UsageStatusSnapshot | undefined): void {
        const pending = this.pending;
        this.pending = undefined;
        if (pending) {
            clearTimeout(pending.timer);
            pending.resolve(snapshot);
        }
    }
}
