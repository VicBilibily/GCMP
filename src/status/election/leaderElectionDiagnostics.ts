import { performance } from 'node:perf_hooks';
import { StatusLogger } from '../../utils/runtime/statusLogger';

export interface ElectionUpdateObservation {
    operation: 'election' | 'heartbeat';
    requestedTerm: string;
    observedTerm: string | undefined;
    leader: boolean;
    lifecycle: number;
}

export class LeaderElectionDiagnostics {
    private lastReportAt: number;
    private readonly lastWarnings = new Map<string, number>();
    private updates = 0;
    private slowUpdates = 0;
    private failedUpdates = 0;
    private maxUpdateMs = 0;
    private ticks = 0;
    private maxDelayMs = 0;

    constructor(private readonly now: () => number = () => performance.now()) {
        this.lastReportAt = this.now();
    }

    reset(): void {
        this.lastReportAt = this.now();
        this.lastWarnings.clear();
        this.updates = this.slowUpdates = this.failedUpdates = this.maxUpdateMs = this.ticks = this.maxDelayMs = 0;
    }

    beginUpdate(before: ElectionUpdateObservation): number {
        const startedAt = this.now();
        StatusLogger.trace(
            `[LeaderElectionService] State update started: operation=${before.operation}, requestedTerm=${before.requestedTerm}, observedTerm=${before.observedTerm ?? 'none'}, leader=${before.leader}, lifecycle=${before.lifecycle}`
        );
        return startedAt;
    }

    finishUpdate(
        startedAt: number,
        before: ElectionUpdateObservation,
        after: Pick<ElectionUpdateObservation, 'observedTerm' | 'leader' | 'lifecycle'>,
        failed: boolean
    ): void {
        const now = this.now();
        const elapsedMs = Math.max(0, now - startedAt);
        this.updates++;
        this.slowUpdates += Number(elapsedMs >= 1000);
        this.failedUpdates += Number(failed);
        this.maxUpdateMs = Math.max(this.maxUpdateMs, elapsedMs);
        const detail = `operation=${before.operation}, elapsedMs=${elapsedMs.toFixed(1)}, result=${failed ? 'failed' : 'completed'}, requestedTerm=${before.requestedTerm}, observedTermBefore=${before.observedTerm ?? 'none'}, observedTermAfter=${after.observedTerm ?? 'none'}, leaderBefore=${before.leader}, leaderAfter=${after.leader}, lifecycleBefore=${before.lifecycle}, lifecycleAfter=${after.lifecycle}`;
        StatusLogger.trace(`[LeaderElectionService] State update finished: ${detail}`);
        if (failed || elapsedMs >= 1000) {
            this.warn(`${failed ? 'failed' : 'slow'}-${before.operation}`, now, `State update anomaly: ${detail}`);
        }
        this.report(now);
    }

    recordHeartbeatDelay(delayMs: number): void {
        const now = this.now();
        this.ticks++;
        this.maxDelayMs = Math.max(this.maxDelayMs, delayMs);
        if (delayMs >= 1000) {
            this.warn('schedule', now, `Heartbeat scheduling delayed: delayMs=${delayMs.toFixed(1)}`);
        }
        this.report(now);
    }

    private warn(key: string, now: number, detail: string): void {
        const previous = this.lastWarnings.get(key);
        if (previous !== undefined && now - previous < 60_000) {
            return;
        }
        this.lastWarnings.set(key, now);
        StatusLogger.warn(`[LeaderElectionService] ${detail}`);
    }

    private report(now: number): void {
        if (now - this.lastReportAt < 60_000) {
            return;
        }
        StatusLogger.debug(
            `[LeaderElectionService] Timing summary: updates=${this.updates}, slowUpdates=${this.slowUpdates}, failedUpdates=${this.failedUpdates}, maxUpdateMs=${this.maxUpdateMs.toFixed(1)}, heartbeatTicks=${this.ticks}, maxHeartbeatDelayMs=${this.maxDelayMs.toFixed(1)}`
        );
        this.lastReportAt = now;
        this.updates = this.slowUpdates = this.failedUpdates = this.maxUpdateMs = this.ticks = this.maxDelayMs = 0;
    }
}
