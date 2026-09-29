import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { LiveMetricsTracker } from '../../handlers/liveMetricsTracker';
import type { LiveStreamMetricEvent } from '../../handlers/liveMetrics';
import { DateUtils } from './dateUtils';
import { UsageParser } from './usageParser';

const require = createRequire(import.meta.url);
const NodeModule = require('node:module') as {
    prototype: { require: (id: string) => unknown };
};

function mockLoggerHost(): () => void {
    const originalRequire = NodeModule.prototype.require;
    NodeModule.prototype.require = function (id: string): unknown {
        if (id === 'vscode') {
            return { window: {}, env: { language: 'zh-cn' } };
        }
        if (id.endsWith('/leaderElectionService')) {
            return { LeaderElectionService: { getLeaderId: () => 'self', getInstanceId: () => 'self' } };
        }
        if (id.endsWith('/interInstance')) {
            return { InterInstanceBus: { subscribe: () => ({ dispose() {} }) } };
        }
        if (id.endsWith('/liveMetrics')) {
            return { onLiveMetrics: () => ({ dispose() {} }) };
        }
        return originalRequire.call(this, id);
    };
    return () => {
        NodeModule.prototype.require = originalRequire;
    };
}

for (const status of ['completed', 'failed', 'cancelled'] as const) {
    for (const finishOrder of ['before', 'during', 'after'] as const) {
        test(`${status} timing survives metrics finishing ${finishOrder} terminal write`, async context => {
            const dir = await mkdtemp(join(tmpdir(), 'gcmp-terminal-metrics-'));
            const restoreHost = mockLoggerHost();
            let logger: import('./index').TokenFileLogger | undefined;
            let terminalWrite: Promise<void> | undefined;
            let releaseWrite!: () => void;
            const writeReleased = new Promise<void>(resolve => {
                releaseWrite = resolve;
            });
            try {
                const { TokenFileLogger } = await import('./index');
                logger = new TokenFileLogger({ globalStorageUri: { fsPath: dir } } as never);
                const internals = logger as unknown as {
                    pathManager: import('./logPathManager').LogPathManager;
                    finalizingRequestIds: Set<string>;
                    updateStreamingMetrics(event: LiveStreamMetricEvent): void;
                    refreshCurrentStats(): void;
                };
                context.mock.method(internals, 'refreshCurrentStats', () => {});
                const requestStartTime = Date.now();
                const streamStartTime = requestStartTime + 100;
                const streamEndTime = streamStartTime + 1000;
                const requestId = `${status}-${finishOrder}`;
                await logger.recordEstimatedTokens({
                    requestId,
                    providerKey: 'test',
                    providerName: 'Test',
                    modelId: 'test',
                    modelName: 'Test',
                    estimatedInput: 10,
                    timestamp: requestStartTime
                });
                const pending = logger.getPendingLogs()[0];
                assert.ok(pending);
                let now = streamStartTime;
                const tracker = new LiveMetricsTracker({
                    requestId,
                    requestStartTime,
                    providerName: 'Test',
                    modelName: 'Test',
                    now: () => now,
                    onLiveMetrics: event => internals.updateStreamingMetrics(event)
                });
                tracker.markStreamStarted(streamStartTime);
                now = streamEndTime;
                tracker.reportOutput(100);
                assert.equal(pending.streamStartTime, streamStartTime);
                assert.equal(pending.outputSpeed, 100);
                assert.equal(pending.outputTokens, 100);

                let signalWriteStarted!: () => void;
                const writeStarted = new Promise<void>(resolve => {
                    signalWriteStarted = resolve;
                });
                const ensureDirectoryExists = internals.pathManager.ensureDirectoryExists.bind(internals.pathManager);
                context.mock.method(internals.pathManager, 'ensureDirectoryExists', async (folder: string) => {
                    await ensureDirectoryExists(folder);
                    signalWriteStarted();
                    await writeReleased;
                });

                now = streamEndTime + 500;
                if (finishOrder === 'before') {
                    tracker.finishMetrics();
                    assert.equal(pending.streamEndTime, now);
                }
                const rawUsage = { prompt_tokens: 10, completion_tokens: 100, total_tokens: 110 };
                terminalWrite = logger.updateActualTokens({
                    requestId,
                    status,
                    requestMetricStartTime: requestStartTime,
                    streamStartTime,
                    streamEndTime,
                    rawUsage,
                    estimatedCost: 0.125
                });
                await writeStarted;
                assert.equal(internals.finalizingRequestIds.has(requestId), true);
                assert.equal(pending.status, status);
                assert.equal(pending.streamEndTime, streamEndTime);
                if (finishOrder === 'during') {
                    tracker.finishMetrics();
                }
                releaseWrite();
                await terminalWrite;
                if (finishOrder === 'after') {
                    tracker.finishMetrics();
                }

                assert.equal(internals.finalizingRequestIds.has(requestId), false);
                assert.equal(logger.getPendingLogs().length, 0);
                const records = await logger.readDateLogs(DateUtils.formatDate(new Date(pending.timestamp)));
                const saved = records.find(record => record.requestId === requestId && record.status === status);
                assert.ok(saved);
                assert.equal(saved.requestMetricStartTime, requestStartTime);
                assert.equal(saved.streamStartTime, streamStartTime);
                assert.equal(saved.streamEndTime, streamEndTime);
                assert.deepEqual(saved.rawUsage, rawUsage);
                assert.equal(saved.estimatedCost, 0.125);
                const usage = UsageParser.parseFromLog(saved);
                assert.equal(usage.streamDuration, 1000);
                assert.equal(usage.outputTokens, 100);
                assert.equal(usage.outputSpeed, 100);
            } finally {
                releaseWrite();
                await terminalWrite?.catch(() => {});
                await logger?.dispose();
                restoreHost();
                await rm(dir, { recursive: true, force: true });
            }
        });
    }
}
