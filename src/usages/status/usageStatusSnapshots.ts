import { EventEmitter } from 'node:events';
import type { Disposable } from 'vscode';
import {
    InterInstanceBus,
    type RemoteInstanceCapabilitiesEvent,
    type UsageStatusSnapshotEvent,
    type UsageStatusSnapshotRequestedEvent
} from '../../interInstance';
import { LeaderElectionService } from '../../status/leaderElectionService';
import { StatusLogger } from '../../utils/runtime/statusLogger';
import { DateUtils } from '../fileLogger/dateUtils';
import type { TokenUsageStatsFromFile } from '../fileLogger/types';
import type { StatsResultSource } from '../fileLogger/refresh/statsRefreshQueue';
import {
    isUsageStatusSnapshot,
    projectUsageStatus,
    freezeUsageStatusStats,
    type UsageStatusSnapshot,
    type UsageStatusStats,
    type LatestUsageStatus
} from './snapshot';
import { SnapshotRequests } from './snapshotRequests';

export class UsageStatusSnapshots {
    private static nextRevision = 0;
    private readonly events = new EventEmitter();
    private readonly subscriptions: Disposable[] = [];
    private snapshot: UsageStatusSnapshot | undefined;
    private content = '';
    private sourceRevision = 0;
    private lastSyncedAt = 0;
    private generation = 0;
    private disposed = false;
    private initialFileMode: boolean;
    private readonly requests = new SnapshotRequests(
        () => this.get(),
        () => this.generation,
        () => !this.disposed
    );
    private read: { key: string; promise: Promise<UsageStatusSnapshot | undefined> } | undefined;

    constructor(
        readonly fileMode: boolean,
        private readonly readSaved: (date: string) => Promise<TokenUsageStatsFromFile | null>,
        private readonly readOwned: (date: string) => Promise<TokenUsageStatsFromFile>,
        private readonly getSource?: (stats: TokenUsageStatsFromFile) => StatsResultSource | undefined,
        private readonly getLatest?: (date: string) => LatestUsageStatus | undefined
    ) {
        this.initialFileMode =
            !fileMode && !LeaderElectionService.getLeaderId() && !InterInstanceBus.getAuthorityTerm();
        if (!fileMode) {
            this.subscriptions.push(
                InterInstanceBus.subscribe<UsageStatusSnapshotEvent>('usageStatusSnapshot', event =>
                    this.receive(event)
                ),
                InterInstanceBus.subscribe<UsageStatusSnapshotRequestedEvent>('usageStatusSnapshotRequested', event => {
                    void this.requests
                        .reply(event)
                        .catch(error => StatusLogger.warn('[UsageStatusSnapshots] Snapshot reply failed', error));
                }),
                InterInstanceBus.onAuthorityChanged(() => {
                    this.generation++;
                    this.requests.complete(undefined);
                    void this.get().catch(error =>
                        StatusLogger.trace('[UsageStatusSnapshots] Snapshot sync failed', error)
                    );
                }),
                InterInstanceBus.subscribe<RemoteInstanceCapabilitiesEvent>('remoteInstanceCapabilities', event => {
                    if (event.payload.targetInstanceId === LeaderElectionService.getInstanceId()) {
                        void this.requests.request();
                    }
                })
            );
        }
    }

    onUpdate(listener: (snapshot: UsageStatusSnapshot) => void): Disposable {
        this.events.on('update', listener);
        return { dispose: () => this.events.off('update', listener) };
    }
    peek(): UsageStatusSnapshot | undefined {
        if (this.disposed || this.snapshot?.date !== DateUtils.getTodayDateString()) {
            return;
        }
        return this.snapshot;
    }
    update(
        date: string,
        stats: TokenUsageStatsFromFile,
        source = this.getSource?.(stats)
    ): UsageStatusSnapshot | undefined {
        if (
            this.getSource &&
            (!source || (!this.fileMode && source.authorityTerm !== LeaderElectionService.getOwnedAuthorityTerm()))
        ) {
            return;
        }
        const latest = this.getLatest?.(date);
        return (
            latest && source && latest.source.revision > source.revision ?
                this.apply(date, latest.stats, latest.source, latest)
            : source?.stale ? undefined
            : this.apply(date, stats, source, latest)
        );
    }
    isCurrent(stats: TokenUsageStatsFromFile): boolean {
        const source = this.getSource?.(stats);
        return (
            !source?.stale &&
            (!source ||
                source.revision >= this.sourceRevision ||
                JSON.stringify(projectUsageStatus(stats)) === this.content)
        );
    }
    private apply(
        date: string,
        stats: TokenUsageStatsFromFile | UsageStatusStats,
        source?: StatsResultSource,
        latest?: LatestUsageStatus,
        initialFileMode = false
    ): UsageStatusSnapshot | undefined {
        if (this.disposed || source?.stale || date !== DateUtils.getTodayDateString()) {
            return;
        }
        const term = this.fileMode || initialFileMode ? 'file' : LeaderElectionService.getOwnedAuthorityTerm();
        if (!term) {
            return;
        }
        if (this.getSource && (!source || (!this.fileMode && !initialFileMode && source.authorityTerm !== term))) {
            return;
        }
        if (
            source &&
            this.snapshot?.date === date &&
            this.snapshot.authorityTerm === term &&
            source.revision === this.sourceRevision
        ) {
            return this.snapshot;
        }
        const projected = latest !== undefined && latest.source === source ? latest.stats : projectUsageStatus(stats);
        const content = JSON.stringify(projected);
        if (source && this.snapshot?.authorityTerm === term && source.revision < this.sourceRevision) {
            return content === this.content ? this.snapshot : undefined;
        }
        this.sourceRevision = source?.revision ?? 0;
        if (this.snapshot?.date === date && this.snapshot.authorityTerm === term && this.content === content) {
            return this.snapshot;
        }
        const snapshot = { date, authorityTerm: term, revision: ++UsageStatusSnapshots.nextRevision, stats: projected };
        if (!isUsageStatusSnapshot(snapshot)) {
            throw new Error('Invalid usage status snapshot');
        }
        this.accept(snapshot, content);
        if (!this.fileMode && !initialFileMode && LeaderElectionService.getOwnedAuthorityTerm() === term) {
            InterInstanceBus.publishIpcOnly({ type: 'usageStatusSnapshot', payload: { snapshot } });
        }
        return snapshot;
    }

    private canReadInitialFile(): boolean {
        if (this.initialFileMode && (LeaderElectionService.getLeaderId() || InterInstanceBus.getAuthorityTerm())) {
            this.initialFileMode = false;
        }
        return this.initialFileMode;
    }

    get(): Promise<UsageStatusSnapshot | undefined> {
        if (this.disposed) {
            return Promise.resolve(undefined);
        }
        const date = DateUtils.getTodayDateString();
        const initialFileMode = this.canReadInitialFile();
        const savedRead = this.fileMode || initialFileMode;
        const term = savedRead ? 'file' : LeaderElectionService.getOwnedAuthorityTerm();
        if (!savedRead && !term) {
            const current = this.peek();
            const age = Date.now() - this.lastSyncedAt;
            return current?.authorityTerm === InterInstanceBus.getAuthorityTerm() && age >= 0 && age < 30000 ?
                    Promise.resolve(current)
                :   this.requests.request();
        }
        const current = this.peek();
        const latest = this.getLatest?.(date);
        if (
            !this.fileMode &&
            latest &&
            latest.source.authorityTerm === term &&
            (current?.authorityTerm !== term || latest.source.revision > this.sourceRevision)
        ) {
            return Promise.resolve(this.apply(date, latest.stats, latest.source, latest));
        }
        if (!this.fileMode && current?.authorityTerm === term) {
            return Promise.resolve(current);
        }
        const key = `${date}:${term}:${this.generation}`;
        if (this.read?.key === key) {
            return this.read.promise;
        }
        const generation = this.generation;
        const previous = this.snapshot;
        const previousSource = this.sourceRevision;
        const promise = (savedRead ? this.readSaved(date) : this.readOwned(date))
            .then(stats => {
                if (
                    this.disposed ||
                    generation !== this.generation ||
                    date !== DateUtils.getTodayDateString() ||
                    (!this.fileMode &&
                        (initialFileMode ?
                            !this.canReadInitialFile()
                        :   LeaderElectionService.getOwnedAuthorityTerm() !== term))
                ) {
                    return undefined;
                }
                if (this.snapshot !== previous || this.sourceRevision !== previousSource) {
                    return this.peek();
                }
                return (
                    !stats ? undefined
                    : initialFileMode ? this.apply(date, stats, this.getSource?.(stats), this.getLatest?.(date), true)
                    : this.update(date, stats)
                );
            })
            .finally(() => {
                if (this.read?.promise === promise) {
                    this.read = undefined;
                }
            });
        this.read = { key, promise };
        return promise;
    }

    private receive(event: UsageStatusSnapshotEvent): void {
        const payload = event.payload;
        const snapshot = payload?.snapshot;
        const term = InterInstanceBus.getAuthorityTerm();
        if (
            this.disposed ||
            !isUsageStatusSnapshot(snapshot) ||
            snapshot.date !== DateUtils.getTodayDateString() ||
            snapshot.authorityTerm !== term ||
            term?.slice(0, term.lastIndexOf(':')) !== event.senderInstanceId ||
            (payload.targetInstanceId !== undefined &&
                payload.targetInstanceId !== LeaderElectionService.getInstanceId()) ||
            (payload.requestId !== undefined && !this.requests.matches(payload.requestId))
        ) {
            return;
        }
        if (this.snapshot?.authorityTerm === term && snapshot.revision <= this.snapshot.revision) {
            if (snapshot.revision === this.snapshot.revision && payload.requestId !== undefined) {
                this.lastSyncedAt = Date.now();
                this.requests.complete(this.peek());
            }
            return;
        }
        const canonical = { ...snapshot, stats: projectUsageStatus(snapshot.stats) };
        this.accept(canonical, JSON.stringify(canonical.stats));
        this.requests.complete(canonical);
    }

    private accept(snapshot: UsageStatusSnapshot, content: string): void {
        if (snapshot.authorityTerm !== 'file') {
            this.initialFileMode = false;
        }
        freezeUsageStatusStats(snapshot.stats);
        Object.freeze(snapshot);
        this.snapshot = snapshot;
        this.content = content;
        this.lastSyncedAt = Date.now();
        this.events.emit('update', snapshot);
    }
    dispose(): void {
        this.disposed = true;
        this.generation++;
        this.requests.complete(undefined);
        for (const subscription of this.subscriptions) {
            subscription.dispose();
        }
        this.events.removeAllListeners();
        this.snapshot = undefined;
    }
}
