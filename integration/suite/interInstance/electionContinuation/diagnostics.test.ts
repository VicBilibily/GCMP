import assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';
import {
    LeaderElectionDiagnostics,
    type ElectionUpdateObservation
} from '../../../../src/status/election/leaderElectionDiagnostics';
import { StatusLogger } from '../../../../src/utils/runtime/statusLogger';
import { createElectionFixture } from './fixture';

suite('Leader election timing diagnostics', () => {
    const original = { trace: StatusLogger.trace, warn: StatusLogger.warn, debug: StatusLogger.debug };
    let now: number;
    let diagnostics: LeaderElectionDiagnostics;
    let traces: string[];
    let warnings: string[];
    let summaries: string[];
    const before: ElectionUpdateObservation = {
        operation: 'heartbeat',
        requestedTerm: 'leader:1',
        observedTerm: 'leader:1',
        leader: true,
        lifecycle: 1
    };
    const after = { observedTerm: 'leader:1', leader: true, lifecycle: 1 };
    setup(() => {
        now = 0;
        diagnostics = new LeaderElectionDiagnostics(() => now);
        traces = [];
        warnings = [];
        summaries = [];
        StatusLogger.trace = message => {
            traces.push(message);
        };
        StatusLogger.warn = message => {
            warnings.push(message);
        };
        StatusLogger.debug = message => {
            summaries.push(message);
        };
    });
    teardown(() => {
        Object.assign(StatusLogger, original);
    });

    function update(elapsed: number, failed = false, operation: ElectionUpdateObservation['operation'] = 'heartbeat') {
        const observation = { ...before, operation };
        const startedAt = diagnostics.beginUpdate(observation);
        now += elapsed;
        diagnostics.finishUpdate(startedAt, observation, after, failed);
    }

    test('fast updates and on-time ticks emit no warning or per-operation info', () => {
        update(999);
        diagnostics.recordHeartbeatDelay(999);
        assert.equal(warnings.length, 0);
        assert.equal(summaries.length, 0);
        assert.equal(traces.length, 2);
        assert.match(traces[1], /elapsedMs=999\.0, result=completed/);
    });

    test('one-second threshold records a slow update with before and after authority', () => {
        const startedAt = diagnostics.beginUpdate(before);
        now = 1000;
        diagnostics.finishUpdate(
            startedAt,
            before,
            { observedTerm: 'successor:2', leader: false, lifecycle: 2 },
            false
        );
        assert.equal(warnings.length, 1);
        assert.match(warnings[0], /elapsedMs=1000\.0, result=completed/);
        assert.match(warnings[0], /requestedTerm=leader:1, observedTermBefore=leader:1, observedTermAfter=successor:2/);
        assert.match(warnings[0], /leaderBefore=true, leaderAfter=false, lifecycleBefore=1, lifecycleAfter=2/);
    });

    test('slow warnings are throttled while aggregate counters retain every observation', () => {
        update(7500);
        update(10_000);
        assert.equal(warnings.length, 1);
        now = 59_999;
        diagnostics.recordHeartbeatDelay(0);
        assert.equal(summaries.length, 0);
        now = 60_000;
        diagnostics.recordHeartbeatDelay(1500);
        assert.equal(summaries.length, 1);
        assert.match(summaries[0], /updates=2, slowUpdates=2, failedUpdates=0, maxUpdateMs=10000\.0/);
        assert.match(summaries[0], /heartbeatTicks=2, maxHeartbeatDelayMs=1500\.0/);
        now = 67_500;
        update(1000);
        assert.equal(warnings.filter(message => message.includes('State update anomaly')).length, 2);
    });

    test('failed updates are not hidden by a preceding slow-update warning', () => {
        update(1000);
        update(0, true);
        update(0, true);
        assert.equal(warnings.length, 2);
        assert.match(warnings[1], /elapsedMs=0\.0, result=failed/);
        now = 60_000;
        diagnostics.recordHeartbeatDelay(0);
        assert.match(summaries[0], /updates=3, slowUpdates=1, failedUpdates=2/);
    });

    test('election and heartbeat anomalies have independent warning budgets', () => {
        update(1000);
        update(1000, false, 'election');
        assert.equal(warnings.length, 2);
        assert.match(warnings[0], /operation=heartbeat/);
        assert.match(warnings[1], /operation=election/);
    });

    test('scheduling anomalies are bounded and normal intervals stay quiet', () => {
        diagnostics.recordHeartbeatDelay(0);
        diagnostics.recordHeartbeatDelay(1000);
        diagnostics.recordHeartbeatDelay(20_000);
        assert.equal(warnings.length, 1);
        assert.match(warnings[0], /Heartbeat scheduling delayed: delayMs=1000\.0/);
        now = 60_000;
        diagnostics.recordHeartbeatDelay(1500);
        assert.equal(warnings.length, 2);
        assert.match(summaries[0], /heartbeatTicks=4, maxHeartbeatDelayMs=20000\.0/);
    });

    test('measurement uses the injected monotonic clock despite wall-clock changes', () => {
        const wallClock = Date.now;
        try {
            Date.now = () => -1_000_000;
            update(7500);
            assert.match(warnings[0], /elapsedMs=7500\.0/);
        } finally {
            Date.now = wallClock;
        }
    });

    test('reset clears interval counters and warning throttles', () => {
        update(1000, true);
        diagnostics.reset();
        update(1000, true);
        assert.equal(warnings.length, 2);
        now = 61_000;
        diagnostics.recordHeartbeatDelay(0);
        assert.match(summaries[0], /updates=1, slowUpdates=1, failedUpdates=1/);
    });

    test('real heartbeat wiring records delayed completion after leadership changes', async () => {
        const fixture = createElectionFixture();
        const internals = fixture.election as unknown as { diagnostics: LeaderElectionDiagnostics };
        const saved = internals.diagnostics;
        internals.diagnostics = diagnostics;
        let pending: Promise<void> | undefined;
        const waiting = fixture.holdNextWrite();
        try {
            await fixture.seed();
            pending = fixture.election.checkLeader();
            await waiting.entered.promise;
            await fixture.write({ instanceId: 'successor', electedAt: 100_001, lastHeartbeat: 100_000 });
            await fixture.election.checkLeader();
            now = 10_000;
            waiting.gate.resolve();
            await pending;
            const warning = warnings.find(message => message.includes('State update anomaly'));
            assert.ok(warning);
            assert.match(warning, /operation=heartbeat, elapsedMs=10000\.0, result=completed/);
            assert.match(warning, /observedTermAfter=successor:100001, leaderBefore=true, leaderAfter=false/);
            fixture.assertFollower();
        } finally {
            waiting.gate.resolve();
            if (pending) {
                await fixture.completeCandidate(pending);
            }
            internals.diagnostics = saved;
            await fixture.dispose();
        }
    });

    for (const operation of ['election', 'heartbeat'] as const) {
        test(`real ${operation} wiring reports failure without swallowing the rejection`, async () => {
            const fixture = createElectionFixture();
            const internals = fixture.election as unknown as { diagnostics: LeaderElectionDiagnostics };
            const saved = internals.diagnostics;
            internals.diagnostics = diagnostics;
            const failure = new Error('controlled update failure');
            try {
                if (operation === 'heartbeat') {
                    await fixture.seed();
                }
                fixture.context.globalState.update = async () => {
                    throw failure;
                };
                await assert.rejects(
                    operation === 'heartbeat' ? fixture.election.checkLeader() : fixture.election.becomeLeader(),
                    error => error === failure
                );
                assert.equal(warnings.length, 1);
                assert.match(warnings[0], new RegExp(`operation=${operation}, elapsedMs=0\\.0, result=failed`));
            } finally {
                internals.diagnostics = saved;
                await fixture.dispose();
            }
        });
    }

    test('real heartbeat interval wiring measures scheduling delay without a separate timer', async () => {
        const fixture = createElectionFixture();
        const internals = fixture.election as unknown as { diagnostics: LeaderElectionDiagnostics; start(): void };
        const saved = internals.diagnostics;
        const interval = globalThis.setInterval;
        const descriptor = Object.getOwnPropertyDescriptor(performance, 'now');
        let tick: (() => void) | undefined;
        let intervals = 0;
        internals.diagnostics = diagnostics;
        try {
            await fixture.write({ instanceId: 'healthy-foreign', electedAt: 100_001, lastHeartbeat: 100_000 });
            Object.defineProperty(performance, 'now', { configurable: true, value: () => now });
            globalThis.setInterval = ((...args: Parameters<typeof setInterval>) => {
                intervals++;
                if (args[1] === 5000) {
                    tick = () => args[0](undefined);
                }
                return interval(() => {}, 60_000);
            }) as typeof setInterval;
            internals.start();
            assert.equal(intervals, 2, 'diagnostics introduced an extra timer');
            assert.ok(tick);
            now = 6000;
            tick();
            await new Promise<void>(resolve => setImmediate(resolve));
            assert.ok(warnings.some(message => /Heartbeat scheduling delayed: delayMs=1000\.0/.test(message)));
        } finally {
            globalThis.setInterval = interval;
            if (descriptor) {
                Object.defineProperty(performance, 'now', descriptor);
            } else {
                Reflect.deleteProperty(performance, 'now');
            }
            internals.diagnostics = saved;
            await fixture.dispose();
        }
    });
});
