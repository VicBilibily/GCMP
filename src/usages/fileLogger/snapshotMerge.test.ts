import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, stat, utimes, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { DateUtils } from './dateUtils';
import { UsageParser } from './usageParser';
import {
    mergeSnapshotFiles,
    mergeSnapshotRecord,
    ORDERED_SNAPSHOT_FORMAT_MARKER,
    parseSnapshotFileContent,
    stringifySnapshotFile,
    type SnapshotFile,
    type SnapshotRequestRecord
} from './snapshotMerge';
import { sanitizeRawUsage, type TokenRequestLog } from './types';
import type {
    RequestClassificationMetadata,
    RequestContinuity
} from '../../handlers/classification/requestClassification';

const classification: RequestClassificationMetadata = {
    version: 1,
    requestOrigin: 'copilot-sdk',
    agentRole: 'subagent',
    evidence: {
        origin: { level: 'signature', ruleId: 'sdk-identity' },
        purpose: { level: 'signature', ruleId: 'subagent-task' },
        role: { level: 'contract', ruleId: 'explicit-subagent' }
    }
};
const continuity: RequestContinuity = { version: 1, scope: 'subagent', source: 'new' };

for (const status of ['completed', 'failed', 'cancelled'] as const) {
    test(`snapshot ${status} without metadata preserves estimated metadata in both merge orders`, () => {
        const estimated = {
            ...createRecord(),
            requestClassification: classification,
            requestContinuity: continuity
        };
        const terminal = {
            ...createRecord({ status, timestamp: 2000, rawUsage: { prompt_tokens: 10, completion_tokens: 5 } }),
            requestClassification: undefined,
            requestContinuity: undefined,
            estimatedCost: 0.125
        };
        for (const [base, overlay] of [
            [estimated, terminal],
            [terminal, estimated]
        ]) {
            const merged = mergeSnapshotRecord(base, overlay);
            assert.deepEqual(merged.requestClassification, classification);
            assert.deepEqual(merged.requestContinuity, continuity);
            assert.equal(merged.status, status);
            assert.equal(merged.timestamp, 1000);
            assert.equal(merged.estimatedCost, 0.125);
            assert.deepEqual(merged.rawUsage, terminal.rawUsage);
        }
    });
}

for (const level of ['heuristic', 'signature', 'contract'] as const) {
    test(`snapshot merge pairs kind and purpose independently of terminal preference for ${level}`, () => {
        const estimated = { ...createRecord({ requestKind: 'subagent' }), requestClassification: classification };
        const terminal = {
            ...createRecord({
                requestKind: 'chat-title',
                status: 'completed',
                timestamp: 2000,
                rawUsage: { prompt_tokens: 10, completion_tokens: 5 }
            }),
            estimatedCost: 0.125,
            requestClassification: {
                ...classification,
                evidence: { ...classification.evidence, purpose: { level, ruleId: 'title-purpose' } }
            }
        };
        const before = structuredClone({ estimated, terminal });
        for (const [base, overlay] of [
            [estimated, terminal],
            [terminal, estimated]
        ]) {
            const merged = mergeSnapshotRecord(base, overlay);
            assert.equal(
                merged.requestKind,
                level === 'signature' ? 'unclassified'
                : level === 'contract' ? 'chat-title'
                : 'subagent'
            );
            assert.deepEqual(
                merged.requestClassification?.evidence.purpose,
                level === 'signature' ?
                    { level: 'unknown', conflictLevel: 'signature', reasonCode: 'classification-conflict' }
                :   (level === 'contract' ? terminal : estimated).requestClassification.evidence.purpose
            );
            assert.equal(merged.status, 'completed');
            assert.equal(merged.timestamp, 1000);
            assert.equal(merged.estimatedCost, 0.125);
            assert.deepEqual(merged.rawUsage, terminal.rawUsage);
        }
        assert.deepEqual({ estimated, terminal }, before);
    });
}

test('snapshot metadata without kind cannot replace the existing kind or purpose', () => {
    const estimated = { ...createRecord({ requestKind: 'subagent' }), requestClassification: classification };
    const terminal = {
        ...createRecord({ status: 'completed' }),
        requestClassification: {
            ...classification,
            evidence: { ...classification.evidence, purpose: { level: 'contract' as const, ruleId: 'orphan-purpose' } }
        }
    };
    for (const [base, overlay] of [
        [estimated, terminal],
        [terminal, estimated]
    ]) {
        const merged = mergeSnapshotRecord(base, overlay);
        assert.equal(merged.requestKind, 'subagent');
        assert.deepEqual(merged.requestClassification?.evidence.purpose, classification.evidence.purpose);
        assert.equal(merged.status, 'completed');
    }
});

test('snapshot signature conflict survives JSONL and equal/weaker updates but yields to contract commit', () => {
    const first = { ...createRecord({ requestKind: 'subagent' }), requestClassification: classification };
    const second = { ...first, requestKind: 'chat-title' };
    const conflicted = mergeSnapshotFiles({ 'req-1': first }, { 'req-1': second });
    const restored = parseSnapshotFileContent(stringifySnapshotFile(conflicted));
    assert.equal(restored['req-1'].requestKind, 'unclassified');
    assert.deepEqual(restored['req-1'].requestClassification?.evidence.purpose, {
        level: 'unknown',
        conflictLevel: 'signature',
        reasonCode: 'classification-conflict'
    });
    for (const level of ['unknown', 'heuristic', 'signature'] as const) {
        const update = {
            ...first,
            requestClassification: {
                ...classification,
                evidence: { ...classification.evidence, purpose: { level, ruleId: 'repeated-purpose' } }
            }
        };
        for (const [base, overlay] of [
            [restored, { 'req-1': update }],
            [{ 'req-1': update }, restored]
        ]) {
            const merged = mergeSnapshotFiles(base, overlay)['req-1'];
            assert.equal(merged.requestKind, 'unclassified');
            assert.deepEqual(merged.requestClassification, restored['req-1'].requestClassification);
        }
    }
    const terminal = {
        ...createRecord({ requestKind: 'git-commit-message', status: 'completed' }),
        estimatedCost: 0.5,
        requestClassification: {
            ...classification,
            evidence: { ...classification.evidence, purpose: { level: 'contract' as const, ruleId: 'commit-purpose' } }
        }
    };
    const merged = mergeSnapshotFiles(restored, { 'req-1': terminal })['req-1'];
    assert.equal(merged.requestKind, 'git-commit-message');
    assert.deepEqual(merged.requestClassification, terminal.requestClassification);
    assert.equal(merged.status, 'completed');
    assert.equal(merged.estimatedCost, 0.5);
});

test('snapshot contract commit wins over signature main/title across all orders, groups and JSONL round trips', () => {
    const [first, second, third] = (
        [
            ['main-agent', 'signature', 'main-purpose'],
            ['chat-title', 'signature', 'title-purpose'],
            ['git-commit-message', 'contract', 'commit-purpose']
        ] as const
    ).map(([requestKind, level, ruleId]) => ({
        ...createRecord({ requestKind }),
        requestClassification: {
            ...classification,
            evidence: { ...classification.evidence, purpose: { level, ruleId } }
        }
    }));
    const before = structuredClone([first, second, third]);
    for (const [a, b, c] of [
        [first, second, third],
        [first, third, second],
        [second, first, third],
        [second, third, first],
        [third, first, second],
        [third, second, first]
    ]) {
        const ab = mergeSnapshotFiles({ 'req-1': a }, { 'req-1': b });
        const bc = mergeSnapshotFiles({ 'req-1': b }, { 'req-1': c });
        const restoredAB = parseSnapshotFileContent(stringifySnapshotFile(ab));
        const restoredBC = parseSnapshotFileContent(stringifySnapshotFile(bc));
        const mergedRecords = [
            mergeSnapshotRecord(mergeSnapshotRecord(a, b), c),
            mergeSnapshotRecord(a, mergeSnapshotRecord(b, c)),
            mergeSnapshotFiles(ab, { 'req-1': c })['req-1'],
            mergeSnapshotFiles({ 'req-1': a }, bc)['req-1'],
            mergeSnapshotFiles(restoredAB, { 'req-1': c })['req-1'],
            mergeSnapshotFiles({ 'req-1': a }, restoredBC)['req-1']
        ];
        for (const merged of mergedRecords) {
            assert.equal(merged.requestKind, 'git-commit-message');
            assert.deepEqual(merged.requestClassification, third.requestClassification);
        }
    }
    assert.deepEqual([first, second, third], before);
});

test('snapshot conflicting metadata keeps reliable evidence independent of terminal preference', () => {
    const reliable = { ...createRecord(), requestClassification: classification };
    const weaker: RequestClassificationMetadata = {
        ...classification,
        agentRole: 'main',
        evidence: { ...classification.evidence, role: { level: 'heuristic', ruleId: 'weak-role' } }
    };
    const terminal = { ...createRecord({ status: 'completed' }), requestClassification: weaker, estimatedCost: 0.5 };
    for (const [base, overlay] of [
        [reliable, terminal],
        [terminal, reliable]
    ]) {
        const merged = mergeSnapshotRecord(base, overlay);
        assert.equal(merged.requestClassification?.agentRole, 'subagent');
        assert.equal(merged.requestClassification?.evidence.role.level, 'contract');
        assert.equal(merged.estimatedCost, 0.5);
    }
});

test('snapshot parsing drops only unsupported metadata and preserves future target kinds', () => {
    const record = {
        ...createRecord({ status: 'completed', requestKind: 'future-kind', rawUsage: { prompt_tokens: 10 } }),
        requestClassification: { ...classification, agentRole: 'future-role' },
        requestContinuity: { ...continuity, source: 'future-source' },
        estimatedCost: 0.5
    };
    const parsed = parseSnapshotFileContent(JSON.stringify(record))['req-1'];
    assert.ok(parsed);
    assert.equal(parsed.requestClassification, undefined);
    assert.equal(parsed.requestContinuity, undefined);
    assert.equal(parsed.requestKind, 'future-kind');
    assert.equal(parsed.estimatedCost, 0.5);
    assert.deepEqual(parsed.rawUsage, record.rawUsage);
});

test('snapshot files round trip classification and preserve it after old-writer terminal upsert', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'gcmp-classification-snapshot-'));
    const restoreHost = mockLoggerHost();
    try {
        const { SnapshotManager } = await import('./snapshotManager');
        const { LogPathManager } = await import('./logPathManager');
        const snapshots = new SnapshotManager(new LogPathManager(dir), () => {});
        const date = DateUtils.getDateStringDaysAgo(3);
        const timestamp = new Date(`${date}T10:00:00`).getTime();
        const estimated = {
            ...createRequestLog('classification-snapshot'),
            timestamp,
            isoTime: new Date(timestamp).toISOString(),
            status: 'estimated' as const,
            requestClassification: classification,
            requestContinuity: continuity,
            requestKind: 'subagent',
            requestInitiator: 'core'
        };
        await snapshots.buildSnapshotFromLogs(date, [estimated]);
        const firstRead = await snapshots.readRecord(date, estimated.requestId);
        assert.deepEqual(firstRead?.requestClassification, classification);
        assert.deepEqual(firstRead?.requestContinuity, continuity);
        await snapshots.upsertRecord(date, {
            ...estimated,
            requestClassification: undefined,
            requestContinuity: undefined,
            status: 'completed',
            rawUsage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
            estimatedCost: 0.125
        });
        const records = await snapshots.read(date);
        assert.equal(records?.length, 1);
        assert.deepEqual(records?.[0].requestClassification, classification);
        assert.deepEqual(records?.[0].requestContinuity, continuity);
        assert.equal(records?.[0].requestKind, 'subagent');
        assert.equal(records?.[0].requestInitiator, 'core');
        assert.equal(records?.[0].totalTokens, 15);
        assert.equal(records?.[0].estimatedCost, 0.125);
        const content = await readFile(join(dir, 'usages', date, 'requests.jsonl'), 'utf8');
        assert.equal(content.split('\n')[0], ORDERED_SNAPSHOT_FORMAT_MARKER);
        assert.deepEqual(parseSnapshotFileContent(content)[estimated.requestId].requestClassification, classification);
    } finally {
        restoreHost();
        await rm(dir, { recursive: true, force: true });
    }
});

const require = createRequire(import.meta.url);
const NodeModule = require('node:module') as {
    prototype: { require: (id: string) => unknown };
};

function createRequestLog(requestId: string): TokenRequestLog {
    return {
        requestId,
        timestamp: Date.now(),
        isoTime: new Date().toISOString(),
        providerKey: 'test',
        providerName: 'Test',
        modelId: 'test',
        modelName: 'Test',
        estimatedInput: 1,
        rawUsage: null,
        status: 'completed'
    };
}

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

function createRecord(overrides: Partial<SnapshotRequestRecord> = {}): SnapshotRequestRecord {
    return {
        requestId: overrides.requestId ?? 'req-1',
        timestamp: overrides.timestamp ?? 1000,
        isoTime: overrides.isoTime ?? '1970-01-01T00:00:01.000Z',
        providerKey: overrides.providerKey ?? 'provider',
        providerName: overrides.providerName ?? 'Provider',
        modelId: overrides.modelId ?? 'model',
        modelName: overrides.modelName ?? 'Model',
        estimatedInput: overrides.estimatedInput ?? 10,
        rawUsage: overrides.rawUsage ?? null,
        status: overrides.status ?? 'estimated',
        maxInputTokens: overrides.maxInputTokens,
        requestKind: overrides.requestKind,
        sessionId: overrides.sessionId,
        sessionRecoverySource: overrides.sessionRecoverySource,
        sessionTitle: overrides.sessionTitle,
        requestInitiator: overrides.requestInitiator,
        capturingTokenCorrelationId: overrides.capturingTokenCorrelationId,
        otelTraceContext: overrides.otelTraceContext,
        telemetryTurn: overrides.telemetryTurn,
        requestMetricStartTime: overrides.requestMetricStartTime,
        streamStartTime: overrides.streamStartTime,
        streamEndTime: overrides.streamEndTime,
        actualInput: overrides.actualInput,
        outputTokens: overrides.outputTokens,
        totalTokens: overrides.totalTokens,
        cacheRead: overrides.cacheRead,
        cacheCreation: overrides.cacheCreation,
        streamDuration: overrides.streamDuration,
        outputSpeed: overrides.outputSpeed
    };
}

test('mergeSnapshotRecord keeps completed status and usage when overlay falls back to estimated', () => {
    const completed = createRecord({
        status: 'completed',
        timestamp: 1000,
        isoTime: '1970-01-01T00:00:01.000Z',
        sessionRecoverySource: 'summary-bridge-truncated',
        telemetryTurn: 7,
        rawUsage: { prompt_tokens: 120, completion_tokens: 30, total_tokens: 150 },
        actualInput: 120,
        outputTokens: 30,
        totalTokens: 150,
        streamStartTime: 1100,
        streamEndTime: 1500,
        outputSpeed: 75
    });
    const estimated = createRecord({
        status: 'estimated',
        timestamp: 1200,
        isoTime: '1970-01-01T00:00:01.200Z',
        rawUsage: null,
        outputTokens: undefined,
        totalTokens: undefined,
        streamEndTime: undefined,
        outputSpeed: undefined
    });

    const merged = mergeSnapshotRecord(completed, estimated);

    assert.equal(merged.status, 'completed');
    assert.equal(merged.timestamp, 1000);
    assert.equal(merged.isoTime, '1970-01-01T00:00:01.000Z');
    assert.deepEqual(merged.rawUsage, completed.rawUsage);
    assert.equal(merged.actualInput, 120);
    assert.equal(merged.outputTokens, 30);
    assert.equal(merged.totalTokens, 150);
    assert.equal(merged.streamEndTime, 1500);
    assert.equal(merged.outputSpeed, 75);
    assert.equal(merged.sessionRecoverySource, 'summary-bridge-truncated');
    assert.equal(merged.telemetryTurn, 7);
});

for (const scenario of ['known', 'unknown-name', 'unknown-key'] as const) {
    for (const terminalIsOverlay of [false, true]) {
        test(`snapshot merge preserves ${scenario} key identity with terminal overlay ${terminalIsOverlay}`, () => {
            const partial = { ...createRecord(), apiKeyHash: 'old-hash', apiKeyName: 'Old name' };
            const apiKeyHash = scenario === 'unknown-key' ? undefined : 'new-hash';
            const apiKeyName = scenario === 'known' ? 'Request name' : undefined;
            const terminal = parseSnapshotFileContent(
                JSON.stringify({ ...createRecord({ status: 'completed' }), apiKeyHash, apiKeyName })
            )['req-1']!;
            const merged =
                terminalIsOverlay ? mergeSnapshotRecord(partial, terminal) : mergeSnapshotRecord(terminal, partial);
            assert.equal(merged.apiKeyHash, apiKeyHash);
            assert.equal(merged.apiKeyName, apiKeyName);
        });
    }
}

test('mergeSnapshotFiles keeps records unique to both stores and upgrades shared request to completed', () => {
    const baseOnly = createRecord({ requestId: 'base-only', status: 'completed', actualInput: 40, outputTokens: 8 });
    const oldShared = createRecord({ requestId: 'shared', status: 'estimated', timestamp: 2000 });
    const overlayOnly = createRecord({ requestId: 'overlay-only', status: 'failed', timestamp: 3000 });
    const newShared = createRecord({
        requestId: 'shared',
        status: 'completed',
        timestamp: 2100,
        rawUsage: { prompt_tokens: 50, completion_tokens: 10, total_tokens: 60 },
        actualInput: 50,
        outputTokens: 10,
        totalTokens: 60
    });

    const baseStore: SnapshotFile = {
        'base-only': baseOnly,
        shared: oldShared
    };
    const overlayStore: SnapshotFile = {
        'overlay-only': overlayOnly,
        shared: newShared
    };

    const merged = mergeSnapshotFiles(baseStore, overlayStore);

    assert.deepEqual(Object.keys(merged).sort(), ['base-only', 'overlay-only', 'shared']);
    assert.equal(merged['base-only']?.status, 'completed');
    assert.equal(merged['overlay-only']?.status, 'failed');
    assert.equal(merged.shared?.status, 'completed');
    assert.equal(merged.shared?.actualInput, 50);
    assert.equal(merged.shared?.outputTokens, 10);
    assert.equal(merged.shared?.timestamp, 2000, 'request start time should remain the earliest timestamp');
});

test('mergeSnapshotFiles prevents completed record from being overwritten by older partial snapshot', () => {
    const fullSnapshot: SnapshotFile = {
        a: createRecord({ requestId: 'a', status: 'completed', actualInput: 10, outputTokens: 2 }),
        b: createRecord({ requestId: 'b', status: 'completed', actualInput: 20, outputTokens: 4 })
    };
    const stalePartialSnapshot: SnapshotFile = {
        a: createRecord({ requestId: 'a', status: 'estimated', timestamp: 1100 }),
        c: createRecord({ requestId: 'c', status: 'completed', actualInput: 30, outputTokens: 6 })
    };

    const merged = mergeSnapshotFiles(fullSnapshot, stalePartialSnapshot);

    assert.deepEqual(Object.keys(merged).sort(), ['a', 'b', 'c']);
    assert.equal(merged.a?.status, 'completed');
    assert.equal(merged.a?.actualInput, 10);
    assert.equal(merged.b?.actualInput, 20);
    assert.equal(merged.c?.actualInput, 30);
});

test('mergeSnapshotRecord prefers newer terminal overlay fields while preserving earliest request start time', () => {
    const baseCompleted = createRecord({
        status: 'completed',
        timestamp: 1000,
        isoTime: '1970-01-01T00:00:01.000Z',
        requestMetricStartTime: 1050,
        rawUsage: { prompt_tokens: 80, completion_tokens: 20, total_tokens: 100 },
        actualInput: 80,
        outputTokens: 20,
        totalTokens: 100,
        streamStartTime: 1100,
        streamEndTime: 1400,
        outputSpeed: 66
    });
    const overlayCompleted = createRecord({
        status: 'completed',
        timestamp: 1300,
        isoTime: '1970-01-01T00:00:01.300Z',
        requestMetricStartTime: 1350,
        rawUsage: { prompt_tokens: 90, completion_tokens: 25, total_tokens: 115 },
        actualInput: 90,
        outputTokens: 25,
        totalTokens: 115,
        streamStartTime: undefined,
        streamEndTime: 1600,
        outputSpeed: 83
    });

    const merged = mergeSnapshotRecord(baseCompleted, overlayCompleted);

    assert.equal(merged.status, 'completed');
    assert.equal(merged.timestamp, 1000);
    assert.equal(merged.isoTime, '1970-01-01T00:00:01.000Z');
    assert.deepEqual(merged.rawUsage, overlayCompleted.rawUsage);
    assert.equal(merged.actualInput, 90);
    assert.equal(merged.outputTokens, 25);
    assert.equal(merged.totalTokens, 115);
    assert.equal(merged.requestMetricStartTime, 1350);
    assert.equal(merged.streamStartTime, 1100, 'overlay 缺失时保留 base 的首流时间');
    assert.equal(merged.streamEndTime, 1600);
    assert.equal(merged.outputSpeed, 83);
});

test('mergeSnapshotRecord keeps base requestMetricStartTime when overlay is sparse', () => {
    const baseCompleted = createRecord({
        status: 'completed',
        requestMetricStartTime: 1050,
        rawUsage: { prompt_tokens: 60, completion_tokens: 12, total_tokens: 72 },
        actualInput: 60,
        outputTokens: 12,
        totalTokens: 72
    });
    const sparseCompleted = createRecord({
        status: 'completed',
        timestamp: 1300,
        requestMetricStartTime: undefined,
        rawUsage: null,
        actualInput: undefined,
        outputTokens: undefined,
        totalTokens: undefined
    });

    const merged = mergeSnapshotRecord(baseCompleted, sparseCompleted);

    assert.equal(merged.requestMetricStartTime, 1050);
    assert.deepEqual(merged.rawUsage, baseCompleted.rawUsage);
});

test('mergeSnapshotRecord keeps late chat-title session reassignment metadata', () => {
    const completedTitleRequest = createRecord({
        requestId: 'req-chat-title',
        status: 'completed',
        timestamp: 1000,
        isoTime: '1970-01-01T00:00:01.000Z',
        requestKind: 'chat-title',
        sessionId: 'temp-session',
        sessionRecoverySource: 'new-uuid'
    });
    const lateMerge = createRecord({
        requestId: 'req-chat-title',
        status: 'completed',
        timestamp: 2000,
        isoTime: '1970-01-01T00:00:02.000Z',
        requestKind: 'chat-title',
        sessionId: 'main-session',
        sessionTitle: '查询 Vue 3.6 最新动态'
    });

    const merged = mergeSnapshotRecord(completedTitleRequest, lateMerge);

    assert.equal(merged.requestKind, 'chat-title');
    assert.equal(merged.sessionId, 'main-session');
    assert.equal(merged.sessionRecoverySource, 'new-uuid');
    assert.equal(merged.sessionTitle, '查询 Vue 3.6 最新动态');
    assert.equal(merged.timestamp, 1000);
});

test('three-stage merge keeps all unique records and lets latest overlay upgrade stale incoming snapshot', () => {
    const latestBase: SnapshotFile = {
        baseOnly: createRecord({ requestId: 'baseOnly', status: 'completed', actualInput: 10, outputTokens: 1 }),
        shared: createRecord({ requestId: 'shared', status: 'completed', actualInput: 20, outputTokens: 2 })
    };

    const incomingStore: SnapshotFile = {
        shared: createRecord({ requestId: 'shared', status: 'estimated', timestamp: 1200 }),
        incomingOnly: createRecord({ requestId: 'incomingOnly', status: 'completed', actualInput: 30, outputTokens: 3 })
    };

    const latestOverlay: SnapshotFile = {
        shared: createRecord({
            requestId: 'shared',
            status: 'completed',
            timestamp: 1300,
            rawUsage: { prompt_tokens: 25, completion_tokens: 4, total_tokens: 29 },
            actualInput: 25,
            outputTokens: 4,
            totalTokens: 29,
            outputSpeed: 40
        }),
        overlayOnly: createRecord({ requestId: 'overlayOnly', status: 'failed', timestamp: 1400 })
    };

    const merged = mergeSnapshotFiles(mergeSnapshotFiles(latestBase, incomingStore), latestOverlay);

    assert.deepEqual(Object.keys(merged).sort(), ['baseOnly', 'incomingOnly', 'overlayOnly', 'shared']);
    assert.equal(merged.baseOnly?.actualInput, 10);
    assert.equal(merged.incomingOnly?.actualInput, 30);
    assert.equal(merged.overlayOnly?.status, 'failed');
    assert.equal(merged.shared?.status, 'completed');
    assert.equal(merged.shared?.actualInput, 25);
    assert.equal(merged.shared?.outputTokens, 4);
    assert.equal(merged.shared?.outputSpeed, 40);
    assert.equal(merged.shared?.timestamp, 1000, '共享请求仍保留最早开始时间');
});

test('mergeSnapshotRecord keeps base parsed usage fields when same-rank overlay is sparse', () => {
    const baseCompleted = createRecord({
        status: 'completed',
        rawUsage: { prompt_tokens: 60, completion_tokens: 12, total_tokens: 72 },
        actualInput: 60,
        outputTokens: 12,
        totalTokens: 72,
        cacheRead: 8,
        cacheCreation: 52,
        outputSpeed: 24
    });
    const sparseCompleted = createRecord({
        status: 'completed',
        timestamp: 1300,
        rawUsage: null,
        actualInput: undefined,
        outputTokens: undefined,
        totalTokens: undefined,
        cacheRead: undefined,
        cacheCreation: undefined,
        outputSpeed: undefined
    });

    const merged = mergeSnapshotRecord(baseCompleted, sparseCompleted);

    assert.equal(merged.status, 'completed');
    assert.deepEqual(merged.rawUsage, baseCompleted.rawUsage);
    assert.equal(merged.actualInput, 60);
    assert.equal(merged.outputTokens, 12);
    assert.equal(merged.totalTokens, 72);
    assert.equal(merged.cacheRead, 8);
    assert.equal(merged.cacheCreation, 52);
    assert.equal(merged.outputSpeed, 24);
});

test('mergeSnapshotRecord uses earlier estimated timestamp and isoTime even when completed base remains preferred', () => {
    const completed = createRecord({
        status: 'completed',
        timestamp: 2000,
        isoTime: '1970-01-01T00:00:02.000Z',
        actualInput: 70,
        outputTokens: 14
    });
    const earlierEstimated = createRecord({
        status: 'estimated',
        timestamp: 900,
        isoTime: '1970-01-01T00:00:00.900Z'
    });

    const merged = mergeSnapshotRecord(completed, earlierEstimated);

    assert.equal(merged.status, 'completed');
    assert.equal(merged.timestamp, 900);
    assert.equal(merged.isoTime, '1970-01-01T00:00:00.900Z');
    assert.equal(merged.actualInput, 70);
    assert.equal(merged.outputTokens, 14);
});

test('mergeSnapshotFiles does not mutate input stores or source records', () => {
    const baseRecord = createRecord({ requestId: 'shared', status: 'completed', actualInput: 11, outputTokens: 2 });
    const overlayRecord = createRecord({ requestId: 'shared', status: 'estimated', timestamp: 1200 });
    const baseStore: SnapshotFile = { shared: baseRecord };
    const overlayStore: SnapshotFile = { shared: overlayRecord };

    const baseBefore = structuredClone(baseStore);
    const overlayBefore = structuredClone(overlayStore);

    const merged = mergeSnapshotFiles(baseStore, overlayStore);

    assert.deepEqual(baseStore, baseBefore);
    assert.deepEqual(overlayStore, overlayBefore);
    assert.notEqual(merged.shared, baseStore.shared);
    assert.notEqual(merged.shared, overlayStore.shared);
});

test('snapshot JSONL parse skips corrupt lines and keeps valid request records', () => {
    const first = createRecord({ requestId: 'req-1', status: 'completed', actualInput: 10 });
    const second = createRecord({ requestId: 'req-2', status: 'failed', timestamp: 2000 });
    const content = [
        JSON.stringify(first),
        '{bad json',
        JSON.stringify({ ignored: true }),
        JSON.stringify(second)
    ].join('\n');

    const parsed = parseSnapshotFileContent(content);

    assert.deepEqual(Object.keys(parsed).sort(), ['req-1', 'req-2']);
    assert.equal(parsed['req-1']?.actualInput, 10);
    assert.equal(parsed['req-2']?.status, 'failed');
});

test('snapshot JSONL stringify marks ordered files and writes one final request record per line', () => {
    const store: SnapshotFile = {
        'req-2': createRecord({ requestId: 'req-2', timestamp: 2000 }),
        'req-1': createRecord({ requestId: 'req-1' })
    };

    const content = stringifySnapshotFile(store);
    const lines = content.split('\n');

    assert.equal(lines.length, 3);
    assert.equal(lines[0], ORDERED_SNAPSHOT_FORMAT_MARKER);
    assert.deepEqual(
        lines.slice(1).map(line => JSON.parse(line).requestId),
        ['req-1', 'req-2']
    );
    assert.deepEqual(Object.keys(parseSnapshotFileContent(content)), ['req-1', 'req-2']);
});

test('persistent usage sanitization removes attribution while retaining token fields', () => {
    const rawUsage = {
        input_tokens: 10,
        output_tokens: 2,
        attribution: { items: { large: { input_tokens: 999 } } }
    };

    assert.deepEqual(sanitizeRawUsage(rawUsage), { input_tokens: 10, output_tokens: 2 });
    assert.deepEqual(sanitizeRawUsage({ input_tokens: 10 }), { input_tokens: 10 });
});

test('historical snapshot cleanup removes attribution from existing requests.jsonl records', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'gcmp-sanitize-snapshot-'));
    const restoreHost = mockLoggerHost();
    try {
        const { SnapshotManager } = await import('./snapshotManager');
        const { LogPathManager } = await import('./logPathManager');
        const paths = new LogPathManager(dir);
        const snapshot = new SnapshotManager(paths, () => {});
        const date = DateUtils.getDateStringDaysAgo(3);
        const record = {
            ...createRequestLog('legacy-attribution'),
            rawUsage: {
                input_tokens: 10,
                output_tokens: 2,
                attribution: { items: { large: { input_tokens: 999 } } }
            }
        };
        await mkdir(paths.getDateFolderPath(date), { recursive: true });
        const snapshotPath = paths.getSnapshotFilePath(date);
        await writeFile(snapshotPath, stringifySnapshotFile({ [record.requestId]: record }));
        const oldTime = new Date(Date.now() - 60_000);
        await utimes(snapshotPath, oldTime, oldTime);

        const versionTimestamp = Date.now();
        assert.equal(await snapshot.sanitizeHistoricalSnapshots(versionTimestamp), 1);
        const content = await readFile(snapshotPath, 'utf8');
        assert.equal(content.includes('"attribution"'), false);
        assert.deepEqual((await snapshot.readRecord(date, record.requestId))?.rawUsage, {
            input_tokens: 10,
            output_tokens: 2
        });
    } finally {
        restoreHost();
        await rm(dir, { recursive: true, force: true });
    }
});

test('historical snapshot cleanup reruns after a snapshot changed after the previous marker', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'gcmp-sanitize-snapshot-version-marker-'));
    const restoreHost = mockLoggerHost();
    try {
        const { SnapshotManager } = await import('./snapshotManager');
        const { LogPathManager } = await import('./logPathManager');
        const paths = new LogPathManager(dir);
        const snapshot = new SnapshotManager(paths, () => {});
        const date = DateUtils.getDateStringDaysAgo(3);
        const record = {
            ...createRequestLog('late-attribution'),
            rawUsage: { input_tokens: 10, attribution: { items: { late: true } } }
        };
        const snapshotPath = paths.getSnapshotFilePath(date);
        await mkdir(paths.getDateFolderPath(date), { recursive: true });
        await writeFile(snapshotPath, stringifySnapshotFile({ [record.requestId]: record }));

        const previousMarker = new Date('2026-09-29T00:00:00+08:00').getTime();
        const snapshotModifiedAt = new Date('2026-10-01T00:00:00+08:00');
        const currentMarker = new Date('2026-10-06T00:00:00+08:00').getTime();
        await utimes(snapshotPath, snapshotModifiedAt, snapshotModifiedAt);

        assert.equal(await snapshot.sanitizeHistoricalSnapshots(previousMarker), 0);
        assert.equal((await readFile(snapshotPath, 'utf8')).includes('"attribution"'), true);

        assert.equal(await snapshot.sanitizeHistoricalSnapshots(currentMarker), 1);
        assert.equal((await readFile(snapshotPath, 'utf8')).includes('"attribution"'), false);
    } finally {
        restoreHost();
        await rm(dir, { recursive: true, force: true });
    }
});

test('historical snapshot cleanup marks clean snapshots by mtime', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'gcmp-sanitize-clean-snapshot-'));
    const restoreHost = mockLoggerHost();
    try {
        const { SnapshotManager } = await import('./snapshotManager');
        const { LogPathManager } = await import('./logPathManager');
        const paths = new LogPathManager(dir);
        const snapshot = new SnapshotManager(paths, () => {});
        const date = DateUtils.getDateStringDaysAgo(3);
        const record = createRequestLog('clean-snapshot');
        const snapshotPath = paths.getSnapshotFilePath(date);
        await mkdir(paths.getDateFolderPath(date), { recursive: true });
        await writeFile(snapshotPath, stringifySnapshotFile({ [record.requestId]: record }));
        const originalContent = await readFile(snapshotPath, 'utf8');
        const oldTime = new Date(Date.now() - 60_000);
        await utimes(snapshotPath, oldTime, oldTime);

        const internals = snapshot as unknown as {
            readFile: (filePath: string) => Promise<SnapshotFile>;
        };
        const readSnapshotFile = internals.readFile.bind(snapshot);
        let fullReads = 0;
        internals.readFile = async filePath => {
            fullReads++;
            return readSnapshotFile(filePath);
        };
        const versionTimestamp = Date.now();

        assert.equal(await snapshot.sanitizeHistoricalSnapshots(versionTimestamp), 0);
        assert.equal(fullReads, 1);
        assert.equal(await readFile(snapshotPath, 'utf8'), originalContent);
        assert.ok((await stat(snapshotPath)).mtimeMs >= versionTimestamp);

        fullReads = 0;
        assert.equal(await snapshot.sanitizeHistoricalSnapshots(versionTimestamp), 0);
        assert.equal(fullReads, 0);
    } finally {
        restoreHost();
        await rm(dir, { recursive: true, force: true });
    }
});

test('UsageParser reparses historical snapshot rawUsage with unified OpenAI-compatible semantics', () => {
    const historicalSnapshotRecord = {
        requestId: 'req-hyper',
        timestamp: 1000,
        isoTime: '1970-01-01T00:00:01.000Z',
        providerKey: 'provider',
        providerName: 'Provider',
        modelId: 'model',
        modelName: 'Model',
        estimatedInput: 17,
        rawUsage: {
            prompt_tokens: 17,
            completion_tokens: 26,
            total_tokens: 5844,
            prompt_tokens_details: {
                cached_tokens: 5801
            }
        },
        status: 'completed' as const,
        // 模拟旧/错误快照字段：曾按 prompt_tokens 直接落 actualInput
        actualInput: 17,
        cacheReadTokens: 5801,
        cacheCreationTokens: 0,
        totalTokens: 43,
        outputTokens: 26
    };

    const extended = UsageParser.extendLog(historicalSnapshotRecord);

    assert.equal(extended.actualInput, 5818);
    assert.equal(extended.cacheReadTokens, 5801);
    assert.equal(extended.cacheCreationTokens, 17);
    assert.equal(extended.outputTokens, 26);
    assert.equal(extended.totalTokens, 5844);
});

test('missing and empty snapshots remain readable and allow the first record to be written', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'gcmp-empty-snapshot-'));
    const restoreHost = mockLoggerHost();
    try {
        const { SnapshotManager } = await import('./snapshotManager');
        const { LogPathManager } = await import('./logPathManager');
        const paths = new LogPathManager(dir);
        const snapshot = new SnapshotManager(paths, () => {});
        const date = DateUtils.getDateStringDaysAgo(3);
        assert.equal(await snapshot.read(date), null);
        await mkdir(paths.getDateFolderPath(date), { recursive: true });
        await writeFile(paths.getSnapshotFilePath(date), '');
        assert.equal(await snapshot.read(date), null);
        await snapshot.upsertRecord(date, createRequestLog('first'));
        assert.deepEqual(
            (await snapshot.read(date))?.map(record => record.requestId),
            ['first']
        );
    } finally {
        restoreHost();
        await rm(dir, { recursive: true, force: true });
    }
});

test('legacy snapshot timing falls back to stored duration and recalculates output speed', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'gcmp-legacy-snapshot-timing-'));
    const restoreHost = mockLoggerHost();
    try {
        const { SnapshotManager } = await import('./snapshotManager');
        const { LogPathManager } = await import('./logPathManager');
        const paths = new LogPathManager(dir);
        const snapshot = new SnapshotManager(paths, () => {});
        const date = DateUtils.getDateStringDaysAgo(3);
        await mkdir(paths.getDateFolderPath(date), { recursive: true });
        await writeFile(
            paths.getSnapshotFilePath(date),
            stringifySnapshotFile({
                legacy: createRecord({
                    requestId: 'legacy',
                    status: 'completed',
                    rawUsage: { prompt_tokens: 10, completion_tokens: 20, total_tokens: 30 },
                    outputTokens: 20,
                    streamDuration: 1000,
                    outputSpeed: 19
                })
            })
        );

        const restored = (await snapshot.read(date))?.[0];
        const extended = restored ? UsageParser.extendLog(restored) : undefined;

        assert.equal(restored?.streamDuration, 1000);
        assert.equal(restored?.timePerOutputToken, 50);
        assert.equal(restored?.outputSpeed, 20);
        assert.equal(extended?.streamDuration, 1000);
        assert.equal(extended?.timePerOutputToken, 50);
        assert.equal(extended?.outputSpeed, 20);
    } finally {
        restoreHost();
        await rm(dir, { recursive: true, force: true });
    }
});

test('full snapshot read preserves large records and descending timestamp order', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'gcmp-large-reverse-snapshot-record-'));
    const restoreHost = mockLoggerHost();
    try {
        const { SnapshotManager } = await import('./snapshotManager');
        const { LogPathManager } = await import('./logPathManager');
        const paths = new LogPathManager(dir);
        const snapshot = new SnapshotManager(paths, () => {});
        const date = DateUtils.getDateStringDaysAgo(3);
        const baseTimestamp = new Date(`${date}T00:00:00`).getTime();
        const oversizedRecord = {
            ...createRequestLog('oversized-record'),
            timestamp: baseTimestamp + 1,
            isoTime: new Date(baseTimestamp + 1).toISOString(),
            sessionTitle: 'x'.repeat(70 * 1024)
        };
        const newestRecord = {
            ...createRequestLog('newest-after-oversized'),
            timestamp: baseTimestamp + 2,
            isoTime: new Date(baseTimestamp + 2).toISOString()
        };

        await snapshot.buildSnapshotFromLogs(date, [oversizedRecord, newestRecord]);

        const records = await snapshot.read(date);
        assert.deepEqual(
            records?.map(record => record.requestId),
            ['newest-after-oversized', 'oversized-record']
        );
        assert.equal(records?.[1].sessionTitle?.length, 70 * 1024);
    } finally {
        restoreHost();
        await rm(dir, { recursive: true, force: true });
    }
});

test('full snapshot read sorts legacy files without an ordered format marker', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'gcmp-legacy-descending-snapshot-'));
    const restoreHost = mockLoggerHost();
    try {
        const { SnapshotManager } = await import('./snapshotManager');
        const { LogPathManager } = await import('./logPathManager');
        const paths = new LogPathManager(dir);
        const snapshot = new SnapshotManager(paths, () => {});
        const date = DateUtils.getDateStringDaysAgo(3);
        const baseTimestamp = new Date(`${date}T00:00:00`).getTime();
        const records = Array.from({ length: 50 }, (_, index) => ({
            ...createRequestLog(`legacy-desc-${index}`),
            timestamp: baseTimestamp + index,
            isoTime: new Date(baseTimestamp + index).toISOString()
        })).reverse();
        await mkdir(paths.getDateFolderPath(date), { recursive: true });
        await writeFile(paths.getSnapshotFilePath(date), records.map(record => JSON.stringify(record)).join('\n'));

        assert.deepEqual(
            (await snapshot.read(date))?.map(record => record.requestId),
            Array.from({ length: 50 }, (_, index) => `legacy-desc-${49 - index}`)
        );
    } finally {
        restoreHost();
        await rm(dir, { recursive: true, force: true });
    }
});

test('historical request details fully read and sort an unsorted legacy snapshot', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'gcmp-legacy-details-'));
    const restoreHost = mockLoggerHost();
    let logger: import('./index').TokenFileLogger | undefined;
    try {
        const { TokenFileLogger } = await import('./index');
        const { LogPathManager } = await import('./logPathManager');
        const paths = new LogPathManager(dir);
        const date = DateUtils.getDateStringDaysAgo(3);
        const baseTimestamp = new Date(`${date}T12:00:00`).getTime();
        const newestRecords = Array.from({ length: 12 }, (_, index) => ({
            ...createRequestLog(`new-${index}`),
            timestamp: baseTimestamp + index * 1000,
            isoTime: new Date(baseTimestamp + index * 1000).toISOString()
        }));
        const appendedOlderRecords = Array.from({ length: 6 }, (_, index) => ({
            ...createRequestLog(`old-${index}`),
            timestamp: baseTimestamp - (6 - index) * 1000,
            isoTime: new Date(baseTimestamp - (6 - index) * 1000).toISOString()
        }));
        await mkdir(paths.getDateFolderPath(date), { recursive: true });
        await writeFile(
            paths.getSnapshotFilePath(date),
            [...newestRecords, ...appendedOlderRecords].map(record => JSON.stringify(record)).join('\n')
        );
        logger = new TokenFileLogger({ globalStorageUri: { fsPath: dir } } as never);

        assert.deepEqual(
            (await logger.getRequestDetails(date)).map(record => record.requestId),
            [
                ...Array.from({ length: 12 }, (_, index) => `new-${11 - index}`),
                ...Array.from({ length: 6 }, (_, index) => `old-${5 - index}`)
            ]
        );
    } finally {
        await logger?.dispose();
        restoreHost();
        await rm(dir, { recursive: true, force: true });
    }
});

test('full snapshot read skips corrupt tail lines', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'gcmp-corrupt-snapshot-tail-'));
    const restoreHost = mockLoggerHost();
    try {
        const { SnapshotManager } = await import('./snapshotManager');
        const { LogPathManager } = await import('./logPathManager');
        const paths = new LogPathManager(dir);
        const snapshot = new SnapshotManager(paths, () => {});
        const date = DateUtils.getDateStringDaysAgo(3);
        await snapshot.buildSnapshotFromLogs(date, [createRequestLog('authoritative-record')]);
        const snapshotPath = paths.getSnapshotFilePath(date);
        await writeFile(snapshotPath, `${await readFile(snapshotPath, 'utf8')}\n{bad json`, 'utf8');

        assert.deepEqual(
            (await snapshot.read(date))?.map(record => record.requestId),
            ['authoritative-record']
        );
    } finally {
        restoreHost();
        await rm(dir, { recursive: true, force: true });
    }
});

test('full snapshot read merges uncompressed raw logs without losing snapshot records', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'gcmp-snapshot-with-raw-'));
    const restoreHost = mockLoggerHost();
    try {
        const { SnapshotManager } = await import('./snapshotManager');
        const { LogPathManager } = await import('./logPathManager');
        const paths = new LogPathManager(dir);
        const snapshot = new SnapshotManager(paths, () => {});
        const date = DateUtils.getDateStringDaysAgo(3);
        const record = createRequestLog('saved-record');
        await snapshot.buildSnapshotFromLogs(date, [record]);
        const rawOnly = createRequestLog('raw-only');
        const rawPartial = { ...record, status: 'estimated', rawUsage: null } satisfies TokenRequestLog;
        await writeFile(
            paths.getHourFilePath(date, 0),
            `${JSON.stringify(rawPartial)}\n${JSON.stringify(rawOnly)}\n`,
            'utf8'
        );

        const records = await snapshot.read(date);
        assert.deepEqual(records?.map(item => item.requestId).sort(), ['raw-only', 'saved-record']);
        assert.equal(records?.find(item => item.requestId === record.requestId)?.status, 'completed');
    } finally {
        restoreHost();
        await rm(dir, { recursive: true, force: true });
    }
});

test('independent snapshot managers preserve concurrent records', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'gcmp-cross-host-snapshot-'));
    const restoreHost = mockLoggerHost();
    try {
        const { SnapshotManager } = await import('./snapshotManager');
        const { LogPathManager } = await import('./logPathManager');
        const paths = new LogPathManager(dir);
        const date = DateUtils.getDateStringDaysAgo(3);
        const first = new SnapshotManager(paths, () => {});
        const second = new SnapshotManager(paths, () => {});

        await Promise.all([
            first.upsertRecord(date, createRequestLog('cross-host-a')),
            second.upsertRecord(date, createRequestLog('cross-host-b'))
        ]);

        assert.deepEqual((await first.read(date))?.map(record => record.requestId).sort(), [
            'cross-host-a',
            'cross-host-b'
        ]);
    } finally {
        restoreHost();
        await rm(dir, { recursive: true, force: true });
    }
});

test('snapshot writes reclaim a lock left by a stopped host', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'gcmp-stale-snapshot-lock-'));
    const restoreHost = mockLoggerHost();
    try {
        const { SnapshotManager } = await import('./snapshotManager');
        const { LogPathManager } = await import('./logPathManager');
        const paths = new LogPathManager(dir);
        const date = DateUtils.getDateStringDaysAgo(3);
        const folder = paths.getDateFolderPath(date);
        const lockPath = join(folder, '.requests.lock');
        const snapshot = new SnapshotManager(paths, () => {});
        await mkdir(lockPath, { recursive: true });
        await writeFile(join(lockPath, 'owner.json'), JSON.stringify({ pid: process.pid, token: 'stopped-host' }));

        const internals = snapshot as unknown as { isProcessAlive: (pid: number) => boolean };
        internals.isProcessAlive = () => false;
        await snapshot.upsertRecord(date, createRequestLog('after-stale-lock'));

        assert.deepEqual(
            (await snapshot.read(date))?.map(record => record.requestId),
            ['after-stale-lock']
        );
        await assert.rejects(stat(lockPath), error => (error as NodeJS.ErrnoException).code === 'ENOENT');
        await assert.rejects(stat(`${lockPath}.reclaim`), error => (error as NodeJS.ErrnoException).code === 'ENOENT');
    } finally {
        restoreHost();
        await rm(dir, { recursive: true, force: true });
    }
});

test('snapshot writes reclaim an ownerless orphaned lock', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'gcmp-ownerless-snapshot-lock-'));
    const restoreHost = mockLoggerHost();
    try {
        const { SnapshotManager } = await import('./snapshotManager');
        const { LogPathManager } = await import('./logPathManager');
        const paths = new LogPathManager(dir);
        const date = DateUtils.getDateStringDaysAgo(3);
        const lockPath = join(paths.getDateFolderPath(date), '.requests.lock');
        const snapshot = new SnapshotManager(paths, () => {});
        await mkdir(lockPath, { recursive: true });
        const staleTime = new Date(Date.now() - 10_000);
        await utimes(lockPath, staleTime, staleTime);

        await snapshot.upsertRecord(date, createRequestLog('after-ownerless-lock'));

        assert.deepEqual(
            (await snapshot.read(date))?.map(record => record.requestId),
            ['after-ownerless-lock']
        );
        await assert.rejects(stat(lockPath), error => (error as NodeJS.ErrnoException).code === 'ENOENT');
        await assert.rejects(stat(`${lockPath}.reclaim`), error => (error as NodeJS.ErrnoException).code === 'ENOENT');
    } finally {
        restoreHost();
        await rm(dir, { recursive: true, force: true });
    }
});

test('snapshot writes recover an orphaned stale-lock reclaim guard', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'gcmp-orphaned-snapshot-reclaim-'));
    const restoreHost = mockLoggerHost();
    let constants:
        | {
              SNAPSHOT_LOCK_WAIT_MS: number;
              SNAPSHOT_LOCK_RETRY_MS: number;
          }
        | undefined;
    let originalWaitMs = 0;
    let originalRetryMs = 0;
    try {
        const { SnapshotManager } = await import('./snapshotManager');
        const { LogPathManager } = await import('./logPathManager');
        constants = SnapshotManager as unknown as typeof constants & object;
        originalWaitMs = constants.SNAPSHOT_LOCK_WAIT_MS;
        originalRetryMs = constants.SNAPSHOT_LOCK_RETRY_MS;
        constants.SNAPSHOT_LOCK_WAIT_MS = 100;
        constants.SNAPSHOT_LOCK_RETRY_MS = 5;
        const paths = new LogPathManager(dir);
        const date = DateUtils.getDateStringDaysAgo(3);
        const reclaimPath = join(paths.getDateFolderPath(date), '.requests.lock.reclaim');
        const snapshot = new SnapshotManager(paths, () => {});
        await mkdir(reclaimPath, { recursive: true });
        const staleTime = new Date(Date.now() - 1_000);
        await utimes(reclaimPath, staleTime, staleTime);

        await snapshot.upsertRecord(date, createRequestLog('after-orphaned-reclaim'));

        assert.deepEqual(
            (await snapshot.read(date))?.map(record => record.requestId),
            ['after-orphaned-reclaim']
        );
        await assert.rejects(stat(reclaimPath), error => (error as NodeJS.ErrnoException).code === 'ENOENT');
    } finally {
        if (constants) {
            constants.SNAPSHOT_LOCK_WAIT_MS = originalWaitMs;
            constants.SNAPSHOT_LOCK_RETRY_MS = originalRetryMs;
        }
        restoreHost();
        await rm(dir, { recursive: true, force: true });
    }
});

test('historical compaction keeps raw logs when their source changes during the write', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'gcmp-compaction-source-race-'));
    const restoreHost = mockLoggerHost();
    try {
        const { SnapshotManager } = await import('./snapshotManager');
        const { LogPathManager } = await import('./logPathManager');
        const paths = new LogPathManager(dir);
        const date = DateUtils.getDateStringDaysAgo(3);
        const folder = paths.getDateFolderPath(date);
        const rawFile = paths.getHourFilePath(date, 0);
        const concurrentRawFile = paths.getHourFilePath(date, 1);
        const snapshot = new SnapshotManager(paths, () => {});
        await mkdir(folder, { recursive: true });
        await writeFile(rawFile, `${JSON.stringify(createRequestLog('before-compaction'))}\n`);

        const internals = snapshot as unknown as {
            atomicWriteStore: (filePath: string, store: SnapshotFile) => Promise<void>;
        };
        const atomicWriteStore = internals.atomicWriteStore.bind(snapshot);
        let injected = false;
        internals.atomicWriteStore = async (filePath, store) => {
            if (!injected) {
                injected = true;
                await writeFile(concurrentRawFile, `${JSON.stringify(createRequestLog('during-compaction'))}\n`);
            }
            await atomicWriteStore(filePath, store);
        };

        assert.equal(await snapshot.compactHistoricalDates(2), 0);
        await assert.doesNotReject(readFile(rawFile, 'utf8'));
        await assert.doesNotReject(readFile(concurrentRawFile, 'utf8'));
        assert.deepEqual((await snapshot.read(date))?.map(record => record.requestId).sort(), [
            'before-compaction',
            'during-compaction'
        ]);

        internals.atomicWriteStore = atomicWriteStore;
        assert.equal(await snapshot.compactHistoricalDates(2), 1);
        await assert.rejects(readFile(rawFile, 'utf8'), error => {
            return (error as NodeJS.ErrnoException).code === 'ENOENT';
        });
        await assert.rejects(readFile(concurrentRawFile, 'utf8'), error => {
            return (error as NodeJS.ErrnoException).code === 'ENOENT';
        });
        assert.deepEqual((await snapshot.read(date))?.map(record => record.requestId).sort(), [
            'before-compaction',
            'during-compaction'
        ]);
    } finally {
        restoreHost();
        await rm(dir, { recursive: true, force: true });
    }
});

test('historical compaction rescans after finding attribution in raw logs', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'gcmp-compaction-attribution-rescan-'));
    const restoreHost = mockLoggerHost();
    try {
        const { SnapshotManager } = await import('./snapshotManager');
        const { LogPathManager } = await import('./logPathManager');
        const paths = new LogPathManager(dir);
        const date = DateUtils.getDateStringDaysAgo(3);
        const folder = paths.getDateFolderPath(date);
        const rawFile = paths.getHourFilePath(date, 0);
        const concurrentRawFile = paths.getHourFilePath(date, 1);
        const snapshot = new SnapshotManager(paths, () => {});
        const first = {
            ...createRequestLog('attribution-before'),
            rawUsage: { prompt_tokens: 10, attribution: { items: { first: true } } }
        };
        const second = {
            ...createRequestLog('attribution-during'),
            rawUsage: { prompt_tokens: 20, attribution: { items: { second: true } } }
        };
        await mkdir(folder, { recursive: true });
        await writeFile(rawFile, `${JSON.stringify(first)}\n`);

        const internals = snapshot as unknown as {
            atomicWriteStore: (filePath: string, store: SnapshotFile) => Promise<void>;
        };
        const atomicWriteStore = internals.atomicWriteStore.bind(snapshot);
        let writes = 0;
        internals.atomicWriteStore = async (filePath, store) => {
            writes++;
            if (writes === 1) {
                await writeFile(concurrentRawFile, `${JSON.stringify(second)}\n`);
            }
            await atomicWriteStore(filePath, store);
        };

        assert.equal(await snapshot.compactHistoricalDates(2), 1);
        assert.equal(writes, 2);
        await assert.rejects(readFile(rawFile, 'utf8'));
        await assert.rejects(readFile(concurrentRawFile, 'utf8'));
        const records = await snapshot.read(date);
        assert.equal(records?.length, 2);
        assert.equal(
            records?.some(
                record => record.rawUsage && Object.prototype.hasOwnProperty.call(record.rawUsage, 'attribution')
            ),
            false
        );
    } finally {
        restoreHost();
        await rm(dir, { recursive: true, force: true });
    }
});

for (const scenario of [
    { name: 'completed across hours', status: 'completed', startHour: 10, daysAgo: 0 },
    { name: 'cancelled across hours', status: 'cancelled', startHour: 10, daysAgo: 0 },
    { name: 'failed across hours', status: 'failed', startHour: 10, daysAgo: 0 },
    { name: 'completed within one hour', status: 'completed', startHour: 11, daysAgo: 0 },
    { name: 'completed yesterday across hours', status: 'completed', startHour: 10, daysAgo: 1 }
] as const) {
    test(`title backfill preserves hourly totals for ${scenario.name}`, async () => {
        const dir = await mkdtemp(join(tmpdir(), 'gcmp-hourly-title-totals-'));
        const restoreHost = mockLoggerHost();
        let logger: import('./index').TokenFileLogger | undefined;
        try {
            const { TokenFileLogger } = await import('./index');
            const date = DateUtils.getDateStringDaysAgo(scenario.daysAgo);
            const startedAt = new Date(`${date}T${scenario.startHour}:00:00`).getTime();
            const completedAt = new Date(`${date}T11:01:00`).getTime();
            const requestId = `${startedAt}_title-totals`;
            const estimated: TokenRequestLog = {
                ...createRequestLog(requestId),
                timestamp: startedAt,
                isoTime: new Date(startedAt).toISOString(),
                estimatedInput: 10,
                status: 'estimated',
                sessionId: 'session-a'
            };
            const terminal: TokenRequestLog = {
                ...estimated,
                timestamp: completedAt,
                isoTime: new Date(completedAt).toISOString(),
                status: scenario.status,
                sessionTitle: 'Original title',
                rawUsage:
                    scenario.status === 'failed' ? null : { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12 },
                ...(scenario.status === 'failed' ? {} : { estimatedCost: 0.25 }),
                streamStartTime: startedAt + 500,
                streamEndTime: completedAt
            };
            const folder = join(dir, 'usages', date);
            const sourcePath = join(folder, `${scenario.startHour}.jsonl`);
            const terminalPath = join(folder, '11.jsonl');
            const estimatedContent = `${JSON.stringify(estimated)}\n`;
            const terminalContent = `${JSON.stringify(terminal)}\n`;
            await mkdir(folder, { recursive: true });
            if (sourcePath === terminalPath) {
                await writeFile(terminalPath, estimatedContent + terminalContent);
            } else {
                await writeFile(sourcePath, estimatedContent);
                await writeFile(terminalPath, terminalContent);
            }
            logger = new TokenFileLogger({ globalStorageUri: { fsPath: dir } } as never);
            const before = await logger.getDateStats(date, true);
            if (scenario.status !== 'failed') {
                assert.equal(before.total.actualInput, 10);
                assert.equal(before.total.outputTokens, 2);
                assert.equal(before.total.estimatedCost, 0.25);
            }

            for (const title of ['Resolved title', 'Renamed title']) {
                assert.equal(
                    await logger.backfillSessionTitle({ requestId, sessionId: 'session-a', sessionTitle: title }),
                    true
                );
                await logger.flush();
                const after = await logger.getDateStats(date, true);
                assert.deepEqual(after.total, before.total);
                assert.deepEqual(after.providers, before.providers);
                for (const [hour, stats] of Object.entries(before.hourly ?? {})) {
                    assert.deepEqual({ ...after.hourly?.[hour], modifiedTime: stats.modifiedTime }, stats);
                }
                if (sourcePath !== terminalPath) {
                    assert.equal(await readFile(sourcePath, 'utf8'), estimatedContent);
                }
                const terminalLines = (await readFile(terminalPath, 'utf8')).trim().split('\n');
                const appended = JSON.parse(terminalLines[terminalLines.length - 1]) as TokenRequestLog;
                assert.deepEqual(appended, { ...terminal, sessionTitle: title });
                logger.clearDetailCaches();
                const details = await logger.getRequestDetails(date);
                assert.equal(details.length, 1);
                assert.equal(details[0].timestamp, startedAt);
                assert.equal(details[0].status, scenario.status);
                assert.equal(details[0].sessionTitle, title);
                assert.deepEqual(details[0].rawUsage, terminal.rawUsage);
                const persisted = await readFile(terminalPath, 'utf8');
                assert.equal(
                    await logger.backfillSessionTitle({ requestId, sessionId: 'session-a', sessionTitle: title }),
                    true
                );
                assert.equal(await readFile(terminalPath, 'utf8'), persisted);
            }
        } finally {
            await logger?.dispose();
            restoreHost();
            await rm(dir, { recursive: true, force: true });
        }
    });
}

test('historical title backfill updates the locked snapshot instead of appending compactable raw logs', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'gcmp-historical-title-snapshot-'));
    const restoreHost = mockLoggerHost();
    let logger: import('./index').TokenFileLogger | undefined;
    try {
        const { TokenFileLogger } = await import('./index');
        const date = DateUtils.getDateStringDaysAgo(3);
        const startedAt = new Date(`${date}T10:00:00`).getTime();
        const completedAt = new Date(`${date}T11:00:00`).getTime();
        const requestId = `${startedAt}_historical-title`;
        const estimated: TokenRequestLog = {
            ...createRequestLog(requestId),
            timestamp: startedAt,
            isoTime: new Date(startedAt).toISOString(),
            status: 'estimated',
            sessionId: 'historical-session'
        };
        const terminal: TokenRequestLog = {
            ...estimated,
            timestamp: completedAt,
            isoTime: new Date(completedAt).toISOString(),
            status: 'completed',
            sessionTitle: 'Original title',
            rawUsage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 }
        };
        const folder = join(dir, 'usages', date);
        const rawFile = join(folder, '10.jsonl');
        const appendedRawFile = join(folder, '11.jsonl');
        const rawContent = `${JSON.stringify(estimated)}\n${JSON.stringify(terminal)}\n`;
        await mkdir(folder, { recursive: true });
        await writeFile(rawFile, rawContent);
        logger = new TokenFileLogger({ globalStorageUri: { fsPath: dir } } as never);

        assert.equal(
            await logger.backfillSessionTitle({
                requestId,
                sessionId: 'historical-session',
                sessionTitle: 'Resolved historical title'
            }),
            true
        );
        assert.equal(await readFile(rawFile, 'utf8'), rawContent);
        await assert.rejects(readFile(appendedRawFile, 'utf8'), error => {
            return (error as NodeJS.ErrnoException).code === 'ENOENT';
        });
        logger.clearDetailCaches();
        assert.equal((await logger.getRequestDetails(date))[0]?.sessionTitle, 'Resolved historical title');

        const snapshotManager = (logger as unknown as { snapshotManager: import('./snapshotManager').SnapshotManager })
            .snapshotManager;
        assert.equal(await snapshotManager.compactHistoricalDates(2), 1);
        await assert.rejects(readFile(rawFile, 'utf8'), error => {
            return (error as NodeJS.ErrnoException).code === 'ENOENT';
        });
        logger.clearDetailCaches();
        assert.equal((await logger.getRequestDetails(date))[0]?.sessionTitle, 'Resolved historical title');
    } finally {
        await logger?.dispose();
        restoreHost();
        await rm(dir, { recursive: true, force: true });
    }
});

test('late title backfill does not overwrite a cross-midnight terminal record', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'gcmp-cross-midnight-title-'));
    const restoreHost = mockLoggerHost();
    let logger: import('./index').TokenFileLogger | undefined;
    try {
        const { TokenFileLogger } = await import('./index');
        const sourceDate = DateUtils.getDateStringDaysAgo(1);
        const completedDate = DateUtils.getTodayDateString();
        const startedAt = new Date(`${sourceDate}T23:59:00`).getTime();
        const completedAt = new Date(`${completedDate}T00:01:00`).getTime();
        const requestId = `${startedAt}_cross-midnight`;
        const sourceFolder = join(dir, 'usages', sourceDate);
        const completedFolder = join(dir, 'usages', completedDate);
        const baseLog = {
            ...createRequestLog(requestId),
            sessionId: 'session-a'
        };
        await mkdir(sourceFolder, { recursive: true });
        await mkdir(completedFolder, { recursive: true });
        await writeFile(
            join(sourceFolder, '23.jsonl'),
            `${JSON.stringify({
                ...baseLog,
                timestamp: startedAt,
                isoTime: new Date(startedAt).toISOString(),
                rawUsage: null,
                status: 'estimated'
            })}\n`
        );
        await writeFile(
            join(completedFolder, '00.jsonl'),
            `${JSON.stringify({
                ...baseLog,
                timestamp: completedAt,
                isoTime: new Date(completedAt).toISOString(),
                rawUsage: { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12 },
                status: 'completed'
            })}\n`
        );

        logger = new TokenFileLogger({ globalStorageUri: { fsPath: dir } } as never);
        assert.equal(
            await logger.backfillSessionTitle({ requestId, sessionId: 'session-a', sessionTitle: 'Late title' }),
            true
        );
        await logger.flush();

        const sourceRecord = (await logger.getRequestDetails(sourceDate)).find(log => log.requestId === requestId);
        const completedRecord = (await logger.getRequestDetails(completedDate)).find(
            log => log.requestId === requestId
        );
        assert.equal(sourceRecord?.sessionTitle, 'Late title');
        assert.equal(completedRecord?.status, 'completed');
        assert.equal(completedRecord?.rawUsage?.total_tokens, 12);
    } finally {
        await logger?.dispose();
        restoreHost();
        await rm(dir, { recursive: true, force: true });
    }
});

for (const recoveryPath of ['fast-index', 'cached-stats'] as const) {
    test(`${recoveryPath} repairs a failed index write without rereading raw hours`, async () => {
        const dir = await mkdtemp(join(tmpdir(), 'gcmp-index-write-retry-'));
        const restoreHost = mockLoggerHost();
        const { AtomicJsonFile } = await import('../atomicJsonFile');
        const write = AtomicJsonFile.writeJsonAtomically;
        let logger: import('./index').TokenFileLogger | undefined;
        try {
            const { TokenFileLogger } = await import('./index');
            const { LogIndexManager } = await import('./logIndexManager');
            logger = new TokenFileLogger({ globalStorageUri: { fsPath: dir } } as never);
            const { readManager, indexManager, logStatsManager } = logger as unknown as {
                readManager: import('./logReadManager').LogReadManager;
                indexManager: import('./logIndexManager').LogIndexManager;
                logStatsManager: import('./logStatsManager').LogStatsManager;
            };
            const date = DateUtils.getTodayDateString();
            const folder = join(dir, 'usages', date);
            const rawFile = join(folder, '00.jsonl');
            await mkdir(folder, { recursive: true });
            await writeFile(rawFile, `${JSON.stringify(createRequestLog('first'))}\n`);
            const oldTime = new Date(Date.now() - 60_000);
            await utimes(rawFile, oldTime, oldTime);
            assert.equal((await logger.getDateStats(date, true)).total.requests, 1);
            await logger.getIndex();
            const indexPath = indexManager.getIndexPath();
            const internals = indexManager as unknown as { getAllStatsDates(): Promise<string[]> };
            const getAllStatsDates = internals.getAllStatsDates.bind(indexManager);
            let scans = 0;
            internals.getAllStatsDates = async () => {
                scans++;
                return getAllStatsDates();
            };
            let failWrites = true;
            let statsWrites = 0;
            AtomicJsonFile.writeJsonAtomically = async (file, value, serializer) => {
                if (file === indexPath && failWrites) {
                    throw new Error('Injected index write failure');
                }
                if (file === join(folder, 'stats.json')) {
                    statsWrites++;
                }
                return write.call(AtomicJsonFile, file, value, serializer);
            };
            await writeFile(
                rawFile,
                `${await readFile(rawFile, 'utf8')}${JSON.stringify(createRequestLog('second'))}\n`
            );
            assert.equal((await logger.getDateStats(date)).total.requests, 2);
            statsWrites = 0;
            let rawReads = 0;
            const readHourLogs = readManager.readHourLogs.bind(readManager);
            readManager.readHourLogs = async (...args) => {
                rawReads++;
                return readHourLogs(...args);
            };
            if (recoveryPath === 'cached-stats') {
                logStatsManager.setCanWriteStats(() => false);
                assert.equal((await logger.getDateStats(date)).total.requests, 2);
                assert.equal(scans, 0);
                logStatsManager.setCanWriteStats(() => true);
                assert.equal((await logger.getDateStats(date)).total.requests, 2);
                assert.equal(scans, 1);
            }
            failWrites = false;
            if (recoveryPath === 'fast-index') {
                assert.equal((await logger.getIndexFast())[date].total_requests, 2);
            } else {
                assert.equal((await logger.getDateStats(date)).total.requests, 2);
                const observer = new LogIndexManager(dir);
                assert.equal((await observer.getIndexFast())[date].total_requests, 2);
            }
            const recoveredScans = scans;
            assert.equal(recoveredScans, recoveryPath === 'fast-index' ? 1 : 2);
            for (let attempt = 0; attempt < 3; attempt++) {
                assert.equal((await logger.getDateStats(date)).total.requests, 2);
                assert.equal((await logger.getIndexFast())[date].total_requests, 2);
            }
            assert.equal(rawReads, 0);
            assert.equal(statsWrites, 0);
            assert.equal(scans, recoveredScans);
        } finally {
            AtomicJsonFile.writeJsonAtomically = write;
            await logger?.dispose();
            restoreHost();
            await rm(dir, { recursive: true, force: true });
        }
    });
}
