import assert from 'node:assert/strict';
import test from 'node:test';

import { SessionRecoveryService, type RecoveryMessageLike } from './sessionRecoveryService';

const ROLE_USER = 1;
const ROLE_ASSISTANT = 2;

function message(role: number, text: string): RecoveryMessageLike {
    return {
        role,
        content: [{ value: text }]
    };
}

function buildSummary(topic: string): string {
    return `Summary for ${topic}: ` + `${topic} `.repeat(24);
}

test('resolveSessionId recovers exact summary bridge match', () => {
    const service = new SessionRecoveryService();
    const summary = buildSummary('stateful marker recovery');

    service.rememberSummarization('sess-1', summary, {
        providerKey: 'longcat',
        telemetryTurn: 7,
        traceId: 'trace-1'
    });

    assert.deepEqual(
        service.resolveSessionId([message(ROLE_ASSISTANT, summary)], {
            providerKey: 'longcat',
            telemetryTurn: 7,
            traceId: 'trace-1'
        }),
        {
            sessionId: 'sess-1',
            matchType: 'exact'
        }
    );
});

test('resolveSessionId matches when summary text is wrapped inside a larger prompt message', () => {
    const service = new SessionRecoveryService();
    const summary = buildSummary('conversation compaction');

    service.rememberSummarization('sess-2', summary);

    const wrapped = `Use the following condensed context before answering:\n\n${summary}\n\nContinue the conversation.`;
    assert.deepEqual(service.resolveSessionId([message(ROLE_USER, wrapped)]), {
        sessionId: 'sess-2',
        matchType: 'embedded'
    });
});

test('resolveSessionId prefers entry whose traceId and telemetryTurn align when summaries collide', () => {
    const service = new SessionRecoveryService();
    const summary = buildSummary('same summary body');

    service.rememberSummarization('sess-a', summary, {
        providerKey: 'longcat',
        telemetryTurn: 3,
        traceId: 'trace-a'
    });
    service.rememberSummarization('sess-b', summary, {
        providerKey: 'longcat',
        telemetryTurn: 9,
        traceId: 'trace-b'
    });

    assert.deepEqual(
        service.resolveSessionId([message(ROLE_ASSISTANT, summary)], {
            providerKey: 'longcat',
            telemetryTurn: 9,
            traceId: 'trace-b'
        }),
        {
            sessionId: 'sess-b',
            matchType: 'exact'
        }
    );
});

test('resolveSessionId keeps summary bridge isolated by provider', () => {
    const service = new SessionRecoveryService();
    const summary = buildSummary('shared summary body');

    service.rememberSummarization('sess-longcat', summary, {
        providerKey: 'longcat',
        telemetryTurn: 3,
        traceId: 'trace-longcat'
    });
    service.rememberSummarization('sess-kimi', summary, {
        providerKey: 'kimi',
        telemetryTurn: 3,
        traceId: 'trace-kimi'
    });

    assert.deepEqual(
        service.resolveSessionId([message(ROLE_ASSISTANT, summary)], {
            providerKey: 'longcat',
            telemetryTurn: 3,
            traceId: 'trace-longcat'
        }),
        {
            sessionId: 'sess-longcat',
            matchType: 'exact'
        }
    );
});

test('rememberSummarization ignores short summaries to reduce false positives', () => {
    const service = new SessionRecoveryService();
    const shortSummary = 'too short to become a reliable recovery bridge';

    service.rememberSummarization('sess-3', shortSummary);

    assert.equal(service.resolveSessionId([message(ROLE_ASSISTANT, shortSummary)]), undefined);
});

test('resolveSessionId prunes expired summary bridges', () => {
    let now = 0;
    const service = new SessionRecoveryService(() => now);
    const summary = buildSummary('cross day resume');

    service.rememberSummarization('sess-4', summary, {
        providerKey: 'longcat',
        telemetryTurn: 12,
        traceId: 'trace-4'
    });

    now = 8 * 24 * 60 * 60 * 1_000;

    assert.equal(
        service.resolveSessionId([message(ROLE_ASSISTANT, summary)], {
            providerKey: 'longcat',
            telemetryTurn: 12,
            traceId: 'trace-4'
        }),
        undefined
    );
});

test('resolveSessionIdFromTrace reuses recent trace hint across compaction boundary', () => {
    const service = new SessionRecoveryService();

    service.rememberSessionHint('sess-trace', {
        providerKey: 'longcat',
        telemetryTurn: 5,
        traceId: 'trace-27'
    });

    assert.equal(
        service.resolveSessionIdFromTrace({
            providerKey: 'longcat',
            telemetryTurn: 5,
            traceId: 'trace-27'
        }),
        'sess-trace'
    );
});

test('resolveSessionIdFromTrace survives long compaction latencies beyond three minutes', () => {
    let now = 0;
    const service = new SessionRecoveryService(() => now);

    service.rememberSessionHint('sess-trace', {
        providerKey: 'longcat',
        telemetryTurn: 5,
        traceId: 'trace-long-compaction'
    });

    now = 3 * 60 * 1_000 + 1;

    assert.equal(
        service.resolveSessionIdFromTrace({
            providerKey: 'longcat',
            telemetryTurn: 5,
            traceId: 'trace-long-compaction'
        }),
        'sess-trace'
    );
});

test('resolveSessionIdFromTrace rejects stale telemetry turn jumps on same trace', () => {
    const service = new SessionRecoveryService();

    service.rememberSessionHint('sess-trace', {
        providerKey: 'longcat',
        telemetryTurn: 2,
        traceId: 'trace-88'
    });

    assert.equal(
        service.resolveSessionIdFromTrace({
            providerKey: 'longcat',
            telemetryTurn: 5,
            traceId: 'trace-88'
        }),
        undefined
    );
});

test('resolveSessionIdFromTrace keeps hints isolated by provider', () => {
    const service = new SessionRecoveryService();

    service.rememberSessionHint('sess-trace', {
        providerKey: 'longcat',
        telemetryTurn: 2,
        traceId: 'trace-shared'
    });

    assert.equal(
        service.resolveSessionIdFromTrace({
            providerKey: 'kimi',
            telemetryTurn: 2,
            traceId: 'trace-shared'
        }),
        undefined
    );

    assert.equal(
        service.resolveSessionIdFromTrace({
            providerKey: 'longcat',
            telemetryTurn: 2,
            traceId: 'trace-shared'
        }),
        'sess-trace'
    );
});

test('resolveSessionIdFromTrace prefers the latest hint when the same provider trace is reused', () => {
    const service = new SessionRecoveryService();

    service.rememberSessionHint('sess-old', {
        providerKey: 'longcat',
        telemetryTurn: 4,
        traceId: 'trace-reused'
    });

    service.rememberSessionHint('sess-new', {
        providerKey: 'longcat',
        telemetryTurn: 5,
        traceId: 'trace-reused'
    });

    assert.equal(
        service.resolveSessionIdFromTrace({
            providerKey: 'longcat',
            telemetryTurn: 5,
            traceId: 'trace-reused'
        }),
        'sess-new'
    );
});

test('resolveSessionIdFromTurn resumes the same provider session on the next turn after summarization', () => {
    const service = new SessionRecoveryService();
    const summary = buildSummary('vue 3.6 latest status');

    service.rememberSessionHint('sess-turn', {
        providerKey: 'longcat',
        telemetryTurn: 4,
        traceId: 'trace-before-compaction'
    });
    service.rememberSummarization('sess-turn', summary, {
        providerKey: 'longcat',
        traceId: 'trace-before-compaction'
    });

    assert.equal(
        service.resolveSessionIdFromTurn({
            providerKey: 'longcat',
            telemetryTurn: 5,
            traceId: 'trace-after-compaction'
        }),
        'sess-turn'
    );
});

test('resolveSessionIdFromTurn survives slow compaction handoff beyond three minutes', () => {
    let now = 0;
    const service = new SessionRecoveryService(() => now);

    service.rememberSummarization('sess-turn', buildSummary('slow handoff'), {
        providerKey: 'longcat',
        telemetryTurn: 4,
        traceId: 'trace-before-compaction'
    });

    now = 3 * 60 * 1_000 + 1;

    assert.equal(
        service.resolveSessionIdFromTurn({
            providerKey: 'longcat',
            telemetryTurn: 5,
            traceId: 'trace-after-compaction'
        }),
        'sess-turn'
    );
});

test('resolveSessionIdFromTurn still resumes after a long idle gap following compaction completion', () => {
    let now = 0;
    const service = new SessionRecoveryService(() => now);

    service.rememberSummarization('sess-turn', buildSummary('idle resume'), {
        providerKey: 'longcat',
        telemetryTurn: 4,
        traceId: 'trace-idle-compaction'
    });

    now = 6 * 60 * 60 * 1_000;

    assert.equal(
        service.resolveSessionIdFromTurn({
            providerKey: 'longcat',
            telemetryTurn: 5,
            traceId: 'trace-idle-follow-up'
        }),
        'sess-turn'
    );
});

test('resolveSessionIdFromTurn does not bridge unrelated later turns', () => {
    const service = new SessionRecoveryService();
    const summary = buildSummary('vue 3.6 latest status');

    service.rememberSessionHint('sess-turn', {
        providerKey: 'longcat',
        telemetryTurn: 4,
        traceId: 'trace-before-compaction'
    });
    service.rememberSummarization('sess-turn', summary, {
        providerKey: 'longcat',
        traceId: 'trace-before-compaction'
    });

    assert.equal(
        service.resolveSessionIdFromTurn({
            providerKey: 'longcat',
            telemetryTurn: 7,
            traceId: 'trace-after-compaction'
        }),
        undefined
    );
});

test('resolveSessionIdFromTurn prunes stale pending hints once a later turn already advanced past them', () => {
    const service = new SessionRecoveryService();

    service.rememberSummarization('sess-turn', buildSummary('stale turn'), {
        providerKey: 'longcat',
        telemetryTurn: 4,
        traceId: 'trace-stale-turn'
    });

    assert.equal(
        service.resolveSessionIdFromTurn({
            providerKey: 'longcat',
            telemetryTurn: 7,
            traceId: 'trace-later-turn'
        }),
        undefined
    );

    assert.equal(
        service.resolveSessionIdFromTurn({
            providerKey: 'longcat',
            telemetryTurn: 5,
            traceId: 'trace-backfill-turn'
        }),
        undefined
    );
});

test('resolveSessionIdFromTurn does not bridge when multiple provider sessions qualify', () => {
    const service = new SessionRecoveryService();

    service.rememberSessionHint('sess-a', {
        providerKey: 'longcat',
        telemetryTurn: 4,
        traceId: 'trace-a-before-compaction'
    });
    service.rememberSummarization('sess-a', buildSummary('session a'), {
        providerKey: 'longcat',
        traceId: 'trace-a-before-compaction'
    });

    service.rememberSessionHint('sess-b', {
        providerKey: 'longcat',
        telemetryTurn: 4,
        traceId: 'trace-b-before-compaction'
    });
    service.rememberSummarization('sess-b', buildSummary('session b'), {
        providerKey: 'longcat',
        traceId: 'trace-b-before-compaction'
    });

    assert.equal(
        service.resolveSessionIdFromTurn({
            providerKey: 'longcat',
            telemetryTurn: 5,
            traceId: 'trace-after-compaction'
        }),
        undefined
    );
});

test('resolveSessionIdFromTurn consumes matched hint after successful bridge', () => {
    const service = new SessionRecoveryService();
    const summary = buildSummary('single compaction follow-up');

    service.rememberSessionHint('sess-turn', {
        providerKey: 'longcat',
        telemetryTurn: 4,
        traceId: 'trace-before-compaction'
    });
    service.rememberSummarization('sess-turn', summary, {
        providerKey: 'longcat',
        traceId: 'trace-before-compaction'
    });

    assert.equal(
        service.resolveSessionIdFromTurn({
            providerKey: 'longcat',
            telemetryTurn: 5,
            traceId: 'trace-after-compaction'
        }),
        'sess-turn'
    );

    assert.equal(
        service.resolveSessionIdFromTurn({
            providerKey: 'longcat',
            telemetryTurn: 5,
            traceId: 'trace-after-compaction'
        }),
        undefined
    );
});

test('resolveSessionIdFromTrace prunes stale trace hints after the recovery window expires', () => {
    let now = 0;
    const service = new SessionRecoveryService(() => now);

    service.rememberSessionHint('sess-trace', {
        providerKey: 'longcat',
        telemetryTurn: 2,
        traceId: 'trace-short-lived'
    });

    now = 10 * 60 * 1_000 + 1;

    assert.equal(
        service.resolveSessionIdFromTrace({
            providerKey: 'longcat',
            telemetryTurn: 2,
            traceId: 'trace-short-lived'
        }),
        undefined
    );
});
