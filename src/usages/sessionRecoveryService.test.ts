import assert from 'node:assert/strict';
import test from 'node:test';
import type { RequestClassificationMetadata } from '../handlers/classification/requestClassification';

import {
    MAX_RECOVERY_RESPONSE_LENGTH,
    SessionRecoveryService,
    type RecoveryMessageLike,
    type SessionRecoveryMetadata
} from './sessionRecoveryService';

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

function historyMetadata(agentRole: RequestClassificationMetadata['agentRole']): SessionRecoveryMetadata {
    return {
        providerKey: 'history-provider',
        requestClassification: {
            version: 1,
            requestOrigin: 'copilot-chat',
            agentRole,
            evidence: {
                origin: { level: 'signature' },
                purpose: { level: 'signature' },
                role: { level: 'signature' }
            }
        }
    };
}

test('WS-LOOP-18: completed assistant history restores only matching provider and assistant content', () => {
    const service = new SessionRecoveryService();
    const text = buildSummary('completed assistant response');
    const metadata = historyMetadata('not-applicable');
    service.rememberAssistantResponse('original-session', text, historyMetadata('main'));
    assert.equal(
        service.resolveSessionIdFromHistory([message(ROLE_ASSISTANT, text.replaceAll(' ', '\n '))], metadata),
        'original-session'
    );
    assert.equal(service.resolveSessionIdFromHistory([message(ROLE_USER, text)], metadata), undefined);
    assert.equal(service.resolveSessionIdFromHistory([message(ROLE_ASSISTANT, text + 'changed')], metadata), undefined);
    assert.equal(
        service.resolveSessionIdFromHistory([message(ROLE_ASSISTANT, text)], { ...metadata, providerKey: 'other' }),
        undefined
    );
    assert.equal(
        service.resolveSessionIdFromHistory([message(ROLE_ASSISTANT, text)], { ...metadata, providerKey: undefined }),
        undefined
    );
});

test('WS-LOOP-18: completed assistant history rejects unobserved, short and oversized output', () => {
    const service = new SessionRecoveryService();
    const metadata = historyMetadata('not-applicable');
    assert.equal(
        service.resolveSessionIdFromHistory([message(ROLE_ASSISTANT, buildSummary('unobserved'))], metadata),
        undefined
    );
    for (const text of ['', 'short output', ' '.repeat(100), 'x'.repeat(MAX_RECOVERY_RESPONSE_LENGTH + 1)]) {
        service.rememberAssistantResponse('session', text, historyMetadata('main'));
        assert.equal(service.resolveSessionIdFromHistory([message(ROLE_ASSISTANT, text)], metadata), undefined);
    }
    const boundary = 'x'.repeat(MAX_RECOVERY_RESPONSE_LENGTH);
    service.rememberAssistantResponse('boundary', boundary, historyMetadata('main'));
    assert.equal(service.resolveSessionIdFromHistory([message(ROLE_ASSISTANT, boundary)], metadata), 'boundary');
});

for (const requestOrigin of ['copilot-sdk', 'core', 'other-extension', 'unknown'] as const) {
    test(`WS-LOOP-18: ${requestOrigin} cannot publish or recover assistant history`, () => {
        const service = new SessionRecoveryService();
        const text = buildSummary('trusted output');
        const foreign = buildSummary('foreign output');
        const main = historyMetadata('main');
        const summary = historyMetadata('not-applicable');
        service.rememberAssistantResponse('trusted', text, main);
        service.rememberAssistantResponse('foreign', foreign, {
            ...main,
            requestClassification: { ...main.requestClassification!, requestOrigin }
        });
        assert.equal(service.resolveSessionIdFromHistory([message(ROLE_ASSISTANT, foreign)], summary), undefined);
        assert.equal(
            service.resolveSessionIdFromHistory([message(ROLE_ASSISTANT, text)], {
                ...summary,
                requestClassification: { ...summary.requestClassification!, requestOrigin }
            }),
            undefined
        );
        assert.equal(service.resolveSessionIdFromHistory([message(ROLE_ASSISTANT, text)], summary), 'trusted');
    });
}

test('WS-LOOP-18: assistant history requires verified purpose and eligible roles', () => {
    const service = new SessionRecoveryService();
    const text = buildSummary('verified main response');
    const main = historyMetadata('main');
    const summary = historyMetadata('not-applicable');
    const weak = {
        ...main,
        requestClassification: {
            ...main.requestClassification!,
            evidence: { ...main.requestClassification!.evidence, purpose: { level: 'heuristic' as const } }
        }
    };
    service.rememberAssistantResponse('weak', text, weak);
    assert.equal(service.resolveSessionIdFromHistory([message(ROLE_ASSISTANT, text)], summary), undefined);
    for (const role of ['subagent', 'undetermined', 'not-applicable'] as const) {
        service.rememberAssistantResponse('wrong-role', text, historyMetadata(role));
    }
    assert.equal(service.resolveSessionIdFromHistory([message(ROLE_ASSISTANT, text)], summary), undefined);
    service.rememberAssistantResponse('main', text, main);
    for (const role of ['main', 'subagent', 'undetermined'] as const) {
        assert.equal(
            service.resolveSessionIdFromHistory([message(ROLE_ASSISTANT, text)], historyMetadata(role)),
            undefined
        );
    }
    assert.equal(service.resolveSessionIdFromHistory([message(ROLE_ASSISTANT, text)], {}), undefined);
    assert.equal(
        service.resolveSessionIdFromHistory([message(ROLE_ASSISTANT, text)], {
            ...weak,
            requestClassification: { ...weak.requestClassification, agentRole: 'not-applicable' }
        }),
        undefined
    );
});

test('WS-LOOP-18: identical outputs remain ambiguous rather than selecting the most recent session', () => {
    const service = new SessionRecoveryService();
    const text = buildSummary('identical assistant response');
    service.rememberAssistantResponse('first', text, historyMetadata('main'));
    service.rememberAssistantResponse('second', text, historyMetadata('main'));
    service.rememberAssistantResponse('first', text, historyMetadata('main'));
    assert.equal(
        service.resolveSessionIdFromHistory([message(ROLE_ASSISTANT, text)], historyMetadata('not-applicable')),
        undefined
    );
});

test('WS-LOOP-18: mixed-session assistant history cannot select a single session', () => {
    const service = new SessionRecoveryService();
    const first = buildSummary('first session');
    const second = buildSummary('second session');
    service.rememberAssistantResponse('first', first, historyMetadata('main'));
    service.rememberAssistantResponse('second', second, historyMetadata('main'));
    assert.equal(
        service.resolveSessionIdFromHistory(
            [message(ROLE_ASSISTANT, first), message(ROLE_ASSISTANT, second)],
            historyMetadata('not-applicable')
        ),
        undefined
    );
    assert.equal(
        service.resolveSessionIdFromHistory([message(ROLE_ASSISTANT, second)], historyMetadata('not-applicable')),
        'second'
    );
});

test('WS-LOOP-18: completed assistant history expires after seven days', () => {
    let now = 0;
    const service = new SessionRecoveryService(() => now);
    const text = buildSummary('expired response');
    service.rememberAssistantResponse('old', text, historyMetadata('main'));
    now = 7 * 24 * 60 * 60 * 1000 + 1;
    assert.equal(
        service.resolveSessionIdFromHistory([message(ROLE_ASSISTANT, text)], historyMetadata('not-applicable')),
        undefined
    );
    service.rememberAssistantResponse('new', text, historyMetadata('main'));
    assert.equal(
        service.resolveSessionIdFromHistory([message(ROLE_ASSISTANT, text)], historyMetadata('not-applicable')),
        'new'
    );
});

test('WS-LOOP-18: completed assistant history keeps at most one thousand fingerprints', () => {
    const service = new SessionRecoveryService();
    for (let index = 0; index <= 1000; index++) {
        service.rememberAssistantResponse(
            `session-${index}`,
            buildSummary(`response-${index}`),
            historyMetadata('main')
        );
    }
    assert.equal(
        service.resolveSessionIdFromHistory(
            [message(ROLE_ASSISTANT, buildSummary('response-0'))],
            historyMetadata('not-applicable')
        ),
        undefined
    );
    assert.equal(
        service.resolveSessionIdFromHistory(
            [message(ROLE_ASSISTANT, buildSummary('response-1000'))],
            historyMetadata('not-applicable')
        ),
        'session-1000'
    );
});

for (const requestOrigin of ['copilot-sdk', 'core', 'other-extension', 'unknown'] as const) {
    test(`classified ${requestOrigin} cannot observe or recover legacy summaries or trace hints`, () => {
        const service = new SessionRecoveryService();
        const summary = buildSummary('origin-isolated-summary');
        const requestClassification: RequestClassificationMetadata = {
            version: 1,
            requestOrigin,
            agentRole: 'undetermined',
            evidence: {
                origin: { level: 'signature' },
                purpose: { level: 'unknown' },
                role: { level: 'unknown' }
            }
        };
        const metadata = { providerKey: 'slot', traceId: 'shared-trace', telemetryTurn: 2, requestClassification };
        service.rememberSessionHint('legacy', { providerKey: 'slot', traceId: 'shared-trace', telemetryTurn: 2 });
        service.rememberSummarization('legacy', summary, { providerKey: 'slot', telemetryTurn: 2 });
        assert.equal(service.resolveSessionId([message(ROLE_USER, summary)], metadata), undefined);
        assert.equal(service.resolveSessionIdFromTurn(metadata), undefined);
        assert.equal(service.resolveSessionIdFromTrace(metadata), undefined);
        assert.equal(service.resolveSessionIdFromTraceAcrossProviders(metadata), undefined);
        service.rememberSummarization('foreign', buildSummary('foreign-summary'), metadata);
        service.rememberSessionHint('foreign', metadata);
        assert.equal(service.resolveSessionId([message(ROLE_USER, buildSummary('foreign-summary'))]), undefined);
        assert.equal(
            service.resolveSessionIdFromTrace({ providerKey: 'slot', traceId: 'shared-trace', telemetryTurn: 2 }),
            'legacy'
        );
    });
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

for (const length of [6000, 6001, 12000]) {
    for (const prefixLength of [0, 40, 6400]) {
        test(`WS-LOOP-18: Chat summary length=${length} prefix=${prefixLength} preserves session`, () => {
            const service = new SessionRecoveryService();
            const summary = buildSummary('long Chat compaction recovery').repeat(40).slice(0, length);
            const requestClassification: RequestClassificationMetadata = {
                version: 1,
                requestOrigin: 'copilot-chat',
                agentRole: 'main',
                evidence: {
                    origin: { level: 'contract' },
                    purpose: { level: 'signature' },
                    role: { level: 'signature' }
                }
            };
            service.rememberSummarization('chat-session', summary, {
                providerKey: 'chat-provider',
                telemetryTurn: 8,
                traceId: 'summary-trace',
                requestClassification: { ...requestClassification, agentRole: 'not-applicable' }
            });
            const wrapped =
                prefixLength === 0 ? summary : (
                    `<context>${'p'.repeat(prefixLength)}</context>\n<conversation-summary>\n${summary}\n</conversation-summary>`
                );
            assert.deepEqual(
                service.resolveSessionId([message(ROLE_USER, wrapped)], {
                    providerKey: 'chat-provider',
                    requestClassification
                }),
                { sessionId: 'chat-session', matchType: prefixLength === 0 ? 'exact' : 'embedded' }
            );
            assert.equal(
                service.resolveSessionId([message(ROLE_USER, wrapped)], {
                    providerKey: 'another-provider',
                    requestClassification
                }),
                undefined
            );
        });
    }
}

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

for (const analysisLength of [0, 120, 12434]) {
    test(`WS-LOOP-18: manual compaction matches summary body after analysis length=${analysisLength}`, () => {
        const service = new SessionRecoveryService();
        const summary = buildSummary('manual compaction summary').repeat(20);
        const analysis = analysisLength ? `<analysis>${'a'.repeat(analysisLength)}</analysis>\n` : '';
        service.rememberSummarization('manual-session', `${analysis}<summary>\n${summary}\n</summary>`, {
            providerKey: 'manual-provider'
        });
        assert.deepEqual(
            service.resolveSessionId(
                [message(ROLE_USER, `<conversation-summary>\n${summary}\n</conversation-summary>`)],
                {
                    providerKey: 'manual-provider'
                }
            ),
            { sessionId: 'manual-session', matchType: 'embedded' }
        );
    });
}

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

    assert.equal(
        service.resolveSessionIdFromTraceAcrossProviders({
            providerKey: 'kimi',
            telemetryTurn: 2,
            traceId: 'trace-shared'
        }),
        'sess-trace'
    );
});

test('resolveSessionIdFromTraceAcrossProviders rejects stale telemetry turn jumps on same trace', () => {
    const service = new SessionRecoveryService();

    service.rememberSessionHint('sess-trace', {
        providerKey: 'longcat',
        telemetryTurn: 2,
        traceId: 'trace-cross-provider'
    });

    assert.equal(
        service.resolveSessionIdFromTraceAcrossProviders({
            providerKey: 'kimi',
            telemetryTurn: 5,
            traceId: 'trace-cross-provider'
        }),
        undefined
    );
});

test('resolveSessionIdFromTraceAcrossProviders falls back to older same-trace hint when latest hint is another turn', () => {
    const service = new SessionRecoveryService();

    service.rememberSessionHint('sess-parent', {
        providerKey: 'longcat',
        telemetryTurn: 1,
        traceId: 'trace-reused-across-providers'
    });
    service.rememberSessionHint('sess-unrelated', {
        providerKey: 'kimi',
        telemetryTurn: 6,
        traceId: 'trace-reused-across-providers'
    });

    assert.equal(
        service.resolveSessionIdFromTraceAcrossProviders({
            providerKey: 'minimax',
            telemetryTurn: 1,
            traceId: 'trace-reused-across-providers'
        }),
        'sess-parent'
    );
});

test('resolveSessionIdFromTraceAcrossProviders bridges direct subagent when parent turn is not 1', () => {
    const service = new SessionRecoveryService();

    service.rememberSessionHint('sess-parent', {
        providerKey: 'longcat',
        telemetryTurn: 3,
        traceId: 'trace-subagent-turn-reset'
    });

    assert.equal(
        service.resolveSessionIdFromTraceAcrossProviders({
            providerKey: 'minimax',
            telemetryTurn: 1,
            traceId: 'trace-subagent-turn-reset'
        }),
        'sess-parent'
    );
});

test('resolveSessionIdFromTraceAcrossProviders keeps turn-reset fallback disabled for ambiguous traces', () => {
    const service = new SessionRecoveryService();

    service.rememberSessionHint('sess-a', {
        providerKey: 'longcat',
        telemetryTurn: 3,
        traceId: 'trace-subagent-turn-reset-ambiguous'
    });
    service.rememberSessionHint('sess-b', {
        providerKey: 'kimi',
        telemetryTurn: 5,
        traceId: 'trace-subagent-turn-reset-ambiguous'
    });

    assert.equal(
        service.resolveSessionIdFromTraceAcrossProviders({
            providerKey: 'minimax',
            telemetryTurn: 1,
            traceId: 'trace-subagent-turn-reset-ambiguous'
        }),
        undefined
    );
});

test('rememberSessionHint can skip publishing provider-agnostic trace hints', () => {
    const service = new SessionRecoveryService();

    service.rememberSessionHint(
        'sess-main',
        {
            providerKey: 'longcat',
            telemetryTurn: 2,
            traceId: 'trace-provider-specific-only'
        },
        undefined,
        {
            publishProviderAgnosticTraceHint: false
        }
    );

    assert.equal(
        service.resolveSessionIdFromTrace({
            providerKey: 'longcat',
            telemetryTurn: 2,
            traceId: 'trace-provider-specific-only'
        }),
        'sess-main'
    );

    assert.equal(
        service.resolveSessionIdFromTraceAcrossProviders({
            providerKey: 'minimax',
            telemetryTurn: 2,
            traceId: 'trace-provider-specific-only'
        }),
        undefined
    );
});

test('rememberSessionHint can suppress all trace hint publication without losing latest session metadata', () => {
    const service = new SessionRecoveryService();
    const summary = buildSummary('subagent child session');

    service.rememberSessionHint(
        'sess-child',
        {
            providerKey: 'minimax',
            telemetryTurn: 2,
            traceId: 'trace-hidden-child'
        },
        undefined,
        {
            publishProviderTraceHint: false,
            publishProviderAgnosticTraceHint: false
        }
    );

    assert.equal(
        service.resolveSessionIdFromTrace({
            providerKey: 'minimax',
            telemetryTurn: 2,
            traceId: 'trace-hidden-child'
        }),
        undefined
    );

    assert.equal(
        service.resolveSessionIdFromTraceAcrossProviders({
            providerKey: 'longcat',
            telemetryTurn: 2,
            traceId: 'trace-hidden-child'
        }),
        undefined
    );

    service.rememberSummarization('sess-child', summary, {
        providerKey: 'minimax',
        traceId: 'trace-hidden-child'
    });

    assert.equal(
        service.resolveSessionIdFromTurn({
            providerKey: 'minimax',
            telemetryTurn: 3,
            traceId: 'trace-hidden-child-next'
        }),
        'sess-child'
    );
});

test('suppressed helper session hint does not overwrite parent trace recovery mapping', () => {
    const service = new SessionRecoveryService();

    service.rememberSessionHint('sess-parent', {
        providerKey: 'longcat',
        telemetryTurn: 4,
        traceId: 'trace-shared-between-parent-and-helper'
    });

    service.rememberSessionHint(
        'sess-helper',
        {
            providerKey: 'longcat',
            telemetryTurn: 4,
            traceId: 'trace-shared-between-parent-and-helper'
        },
        undefined,
        {
            publishProviderTraceHint: false,
            publishProviderAgnosticTraceHint: false
        }
    );

    assert.equal(
        service.resolveSessionIdFromTrace({
            providerKey: 'longcat',
            telemetryTurn: 4,
            traceId: 'trace-shared-between-parent-and-helper'
        }),
        'sess-parent'
    );

    assert.equal(
        service.resolveSessionIdFromTraceAcrossProviders({
            providerKey: 'minimax',
            telemetryTurn: 4,
            traceId: 'trace-shared-between-parent-and-helper'
        }),
        'sess-parent'
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

test('resolveSessionIdFromTurn keeps the previous telemetryTurn when trace-bridged summarization omits it', () => {
    const service = new SessionRecoveryService();
    const summary = buildSummary('compaction after final reply');

    service.rememberSessionHint('sess-turn', {
        providerKey: 'longcat',
        telemetryTurn: 6,
        traceId: 'trace-before-compaction'
    });

    service.rememberSessionHint('sess-turn', {
        providerKey: 'longcat',
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

// 以下为“切换模型 + 上下文压缩”场景的回归测试：
// 压缩请求/压缩后请求到达新提供商时，原会话 hint 记录在旧提供商名下，
// 同提供商隔离的桥接全部 miss，只能靠跨提供商 trace 回退恢复原 sessionId。

test('model switch then compaction: summarization recovers session via cross-provider trace hint', () => {
    const service = new SessionRecoveryService();
    const summary = buildSummary('model switch compaction');

    // 旧提供商（codex）时代的正式请求建立 trace hint
    service.rememberSessionHint('sess-switch', {
        providerKey: 'codex',
        telemetryTurn: 12,
        traceId: 'trace-model-switch'
    });

    // 切换模型后新提供商（kimi）收到的首个请求即压缩请求：同提供商 miss
    assert.equal(
        service.resolveSessionIdFromTrace({
            providerKey: 'kimi',
            telemetryTurn: 13,
            traceId: 'trace-model-switch'
        }),
        undefined
    );
    // 跨提供商回退命中原会话
    assert.equal(
        service.resolveSessionIdFromTraceAcrossProviders({
            providerKey: 'kimi',
            telemetryTurn: 13,
            traceId: 'trace-model-switch'
        }),
        'sess-switch'
    );

    // 压缩成功：摘要记到原 sessionId + 新提供商名下
    service.rememberSummarization('sess-switch', summary, {
        providerKey: 'kimi',
        telemetryTurn: 13,
        traceId: 'trace-model-switch'
    });

    // 压缩后下一轮正式请求（仍为新提供商）：turn bridge 正常衔接
    assert.equal(
        service.resolveSessionIdFromTurn({
            providerKey: 'kimi',
            telemetryTurn: 14,
            traceId: 'trace-model-switch'
        }),
        'sess-switch'
    );
});

test('compaction then model switch: follow-up request recovers session via cross-provider trace hint', () => {
    const service = new SessionRecoveryService();
    const summary = buildSummary('compaction before switch');

    // 旧提供商时代：正式请求建立 hint，随后压缩在同一 trace 下完成
    service.rememberSessionHint('sess-pre-switch', {
        providerKey: 'codex',
        telemetryTurn: 8,
        traceId: 'trace-switch-after-compaction'
    });
    service.rememberSummarization('sess-pre-switch', summary, {
        providerKey: 'codex',
        telemetryTurn: 8,
        traceId: 'trace-switch-after-compaction'
    });

    // 压缩完成后用户切换模型：压缩后首轮请求到达新提供商（kimi）
    // summary bridge 因提供商隔离 miss
    assert.equal(
        service.resolveSessionId([message(ROLE_ASSISTANT, summary)], {
            providerKey: 'kimi',
            telemetryTurn: 9,
            traceId: 'trace-switch-after-compaction'
        }),
        undefined
    );
    // turn bridge 新提供商分桶为空，miss
    assert.equal(
        service.resolveSessionIdFromTurn({
            providerKey: 'kimi',
            telemetryTurn: 9,
            traceId: 'trace-switch-after-compaction'
        }),
        undefined
    );
    // 跨提供商 trace 兜底命中原会话
    assert.equal(
        service.resolveSessionIdFromTraceAcrossProviders({
            providerKey: 'kimi',
            telemetryTurn: 9,
            traceId: 'trace-switch-after-compaction'
        }),
        'sess-pre-switch'
    );
});

test('SDK session identity binds independently and never selects the most recent session', () => {
    const service = new SessionRecoveryService();
    service.rememberSdkSession('context-a', 'session-a');
    service.rememberSdkSession('context-b', 'session-b');
    assert.equal(service.resolveSdkSession('context-a'), 'session-a');
    assert.equal(service.resolveSdkSession('context-b'), 'session-b');
    assert.equal(service.resolveSdkSession('context-missing'), undefined);
    assert.equal(new SessionRecoveryService().resolveSdkSession('context-a'), undefined);
});

test('SDK conflicting marker bindings stay ambiguous instead of overwriting an existing session', () => {
    const service = new SessionRecoveryService();
    service.rememberSdkSession('context-a', 'session-a');
    service.rememberSdkSession('context-a', 'session-b');
    service.rememberSdkSession('context-a', 'session-a');
    assert.equal(service.resolveSdkSession('context-a'), undefined);
});

test('SDK session bindings expire and have bounded capacity', () => {
    let now = 1_000;
    const service = new SessionRecoveryService(() => now);
    service.rememberSdkSession('context-a', 'session-a');
    service.rememberSdkSession('context-a', 'session-b');
    now += 7 * 24 * 60 * 60 * 1_000 + 1;
    assert.equal(service.resolveSdkSession('context-a'), undefined);
    service.rememberSdkSession('context-a', 'session-c');
    assert.equal(service.resolveSdkSession('context-a'), 'session-c');
    for (let i = 0; i <= 1_000; i++) {
        service.rememberSdkSession(`context-${i}`, `session-${i}`);
    }
    assert.equal(service.resolveSdkSession('context-0'), undefined);
    assert.equal(service.resolveSdkSession('context-a'), undefined);
    assert.equal(service.resolveSdkSession('context-1000'), 'session-1000');
});

test('model switch with telemetry turn reset: cross-provider fallback bridges unique session on same trace', () => {
    const service = new SessionRecoveryService();

    // 旧提供商时代 turn 已推进到 12；切换模型后 Copilot 将 telemetryTurn 重置为 1
    service.rememberSessionHint('sess-turn-reset', {
        providerKey: 'codex',
        telemetryTurn: 12,
        traceId: 'trace-turn-reset-switch'
    });

    // 同提供商 miss
    assert.equal(
        service.resolveSessionIdFromTrace({
            providerKey: 'kimi',
            telemetryTurn: 1,
            traceId: 'trace-turn-reset-switch'
        }),
        undefined
    );
    // 跨提供商回退：turn 差 11 超窗，但同 trace 仅一个候选会话，走 turn-reset 唯一候选兜底
    assert.equal(
        service.resolveSessionIdFromTraceAcrossProviders({
            providerKey: 'kimi',
            telemetryTurn: 1,
            traceId: 'trace-turn-reset-switch'
        }),
        'sess-turn-reset'
    );
});
