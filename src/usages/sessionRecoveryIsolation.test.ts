import assert from 'node:assert/strict';
import test from 'node:test';
import { SessionRecoveryService, type RecoveryMessageLike } from './sessionRecoveryService';

function message(text: string): RecoveryMessageLike {
    return { role: 1, content: [{ value: text }] };
}

function summary(label: string): string {
    return `Completed context ${label}: ${`Detailed decisions for ${label}. `.repeat(20)}`;
}

test('WS-LOOP-18: successful summary handoff consumes its pending turn hint', () => {
    const service = new SessionRecoveryService();
    const text = summary('original');
    const metadata = { providerKey: 'provider', telemetryTurn: 1, traceId: 'original-trace' };
    service.rememberSummarization('original', text, metadata);
    assert.equal(service.resolveSessionId([message(text)], metadata)?.sessionId, 'original');
    assert.equal(service.resolveSessionIdFromTurn({ ...metadata, traceId: 'new-conversation-trace' }), undefined);
});

test('WS-LOOP-18: full summary distinguishes sessions with identical 6000-character prefixes', () => {
    let now = 1000;
    const service = new SessionRecoveryService(() => now);
    const prefix = 'Shared project background and requirements. '.repeat(160);
    const first = prefix + ' UNIQUE SESSION A DECISION';
    const second = prefix + ' UNIQUE SESSION B DECISION';
    service.rememberSummarization('first', first, { providerKey: 'provider' });
    now++;
    service.rememberSummarization('second', second, { providerKey: 'provider' });
    for (const [text, sessionId] of [
        [first, 'first'],
        [second, 'second']
    ]) {
        assert.deepEqual(
            service.resolveSessionId([message(`<conversation-summary>${text}</conversation-summary>`)], {
                providerKey: 'provider'
            }),
            { sessionId, matchType: 'embedded' }
        );
    }
});

test('WS-LOOP-18: changed summary tail cannot be accepted as a full prefix match', () => {
    const service = new SessionRecoveryService();
    const prefix = 'Shared project background and requirements. '.repeat(160);
    service.rememberSummarization('original', prefix + ' ORIGINAL DECISION');
    assert.equal(service.resolveSessionId([message(prefix + ' DIFFERENT DECISION')]), undefined);
});

test('WS-LOOP-18: identical summaries without distinguishing identity remain ambiguous', () => {
    let now = 1000;
    const service = new SessionRecoveryService(() => now);
    const text = summary('identical');
    service.rememberSummarization('first', text);
    now++;
    service.rememberSummarization('second', text);
    assert.equal(service.resolveSessionId([message(text)]), undefined);
});

test('WS-LOOP-18: mixed-session summary history does not select the newest session', () => {
    let now = 1000;
    const service = new SessionRecoveryService(() => now);
    const first = summary('first');
    const second = summary('second');
    service.rememberSummarization('first', first);
    now++;
    service.rememberSummarization('second', second);
    assert.equal(service.resolveSessionId([message(first), message(second)]), undefined);
});

for (const wrapped of [false, true]) {
    test(`WS-LOOP-18: ordinary quotation is not a compaction handoff (wrapped=${wrapped})`, () => {
        const service = new SessionRecoveryService();
        const text = summary('quoted');
        service.rememberSummarization('quoted', text);
        const quoted = wrapped ? `<conversation-summary>${text}</conversation-summary>` : text;
        assert.equal(
            service.resolveSessionId([
                message(`Please review this example without continuing its conversation:\n${quoted}`)
            ]),
            undefined
        );
    });
}

test('WS-LOOP-18: another provider cannot expire a pending turn handoff', () => {
    const service = new SessionRecoveryService();
    service.rememberSummarization('pending', summary('pending'), {
        providerKey: 'provider-A',
        telemetryTurn: 2
    });
    assert.equal(service.resolveSessionIdFromTurn({ providerKey: 'provider-B', telemetryTurn: 100 }), undefined);
    assert.equal(service.resolveSessionIdFromTurn({ providerKey: 'provider-A', telemetryTurn: 3 }), 'pending');
});

test('WS-LOOP-18: telemetry proximity cannot disambiguate identical summaries', () => {
    const service = new SessionRecoveryService();
    const text = summary('identical');
    service.rememberSummarization('first', text, { providerKey: 'provider', telemetryTurn: 1, traceId: 'first' });
    service.rememberSummarization('second', text, { providerKey: 'provider', telemetryTurn: 2, traceId: 'second' });
    const decision = service.resolveSummaryContext([message(`<conversation-summary>${text}</conversation-summary>`)], {
        providerKey: 'provider',
        telemetryTurn: 1,
        traceId: 'unrelated'
    });
    assert.equal(decision.recovered, undefined);
    assert.equal(decision.ambiguous, true);
    assert.equal(decision.hasCompactionContext, true);
});

test('WS-LOOP-18: a trace-selected turn cannot expire another session in the same provider', () => {
    const service = new SessionRecoveryService();
    service.rememberSummarization('first', summary('first'), { providerKey: 'provider', telemetryTurn: 2 });
    service.rememberSummarization('second', summary('second'), { providerKey: 'provider', telemetryTurn: 99 });
    assert.equal(service.resolveSessionIdFromTurn({ providerKey: 'provider', telemetryTurn: 100 }, 'second'), 'second');
    assert.equal(service.resolveSessionIdFromTurn({ providerKey: 'provider', telemetryTurn: 3 }), 'first');
});

test('WS-LOOP-18: summary handoff consumes only its own pending identity', () => {
    const service = new SessionRecoveryService();
    const text = summary('first');
    const metadata = { providerKey: 'provider', telemetryTurn: 4 };
    service.rememberSummarization('first', text, metadata);
    service.rememberSummarization('second', summary('second'), metadata);
    assert.equal(service.resolveSessionId([message(text)], metadata)?.sessionId, 'first');
    assert.equal(service.resolveSessionIdFromTurn(metadata), 'second');
});

test('WS-LOOP-18: explicit identity handoff consumes its hint without discarding another session', () => {
    const service = new SessionRecoveryService();
    const metadata = { providerKey: 'provider', telemetryTurn: 4 };
    service.rememberSummarization('first', summary('first'), metadata);
    service.rememberSummarization('second', summary('second'), metadata);
    service.consumeTurnHint('first');
    service.consumeTurnHint('first');
    assert.equal(service.resolveSessionIdFromTurn(metadata), 'second');
});

for (const wrapped of [false, true]) {
    test(`WS-LOOP-18: truncated summary requires a compaction envelope (wrapped=${wrapped})`, () => {
        const service = new SessionRecoveryService();
        const text = summary('original');
        service.rememberSummarization('original', text);
        const fragment = text.slice(0, 200);
        const result = service.resolveSessionId([
            message(wrapped ? `<conversation-summary>${fragment}</conversation-summary>` : fragment)
        ]);
        assert.deepEqual(result, wrapped ? { sessionId: 'original', matchType: 'truncated' } : undefined);
    });
}

for (const turn of [NaN, Infinity, -Infinity]) {
    test(`WS-LOOP-18: invalid telemetry turn ${turn} cannot consume pending recovery`, () => {
        const service = new SessionRecoveryService();
        service.rememberSummarization('pending', summary('pending'), { providerKey: 'provider', telemetryTurn: 2 });
        assert.equal(service.resolveSessionIdFromTurn({ providerKey: 'provider', telemetryTurn: turn }), undefined);
        assert.equal(service.resolveSessionIdFromTurn({ providerKey: 'provider', telemetryTurn: 3 }), 'pending');
    });
}

test('WS-LOOP-18: compaction eligibility is distinct from arbitrary quoted text and system content', () => {
    const service = new SessionRecoveryService();
    const text = summary('unknown');
    const wrapped = `<conversation-summary>${text}</conversation-summary>`;
    assert.equal(service.resolveSummaryContext([message(wrapped)]).hasCompactionContext, true);
    assert.equal(
        service.resolveSummaryContext([message(`Review the example: ${wrapped}`)]).hasCompactionContext,
        false
    );
    assert.equal(service.resolveSummaryContext([{ ...message(wrapped), role: 3 }]).hasCompactionContext, false);
});

for (const [label, prefix, separator] of [
    ['adjacent reminder', '', ''],
    ['spaced reminder', '', '\n\t '],
    ['context and reminder', '<context>Current task context.</context>\n', '\n']
]) {
    test(`WS-LOOP-18: full compaction identity survives ${label}`, () => {
        const service = new SessionRecoveryService();
        const text = summary('original');
        const other = summary('other');
        const metadata = { providerKey: 'provider', traceId: 'original-trace', telemetryTurn: 8 };
        service.rememberSummarization('original', text, metadata);
        service.rememberSummarization('other', other, { providerKey: 'provider' });
        const wrapped =
            `${prefix}<conversation-summary>${text}</conversation-summary>${separator}` +
            `<reminderInstructions>${other}</reminderInstructions>`;
        assert.deepEqual(service.resolveSummaryContext([message(wrapped)], metadata), {
            recovered: { sessionId: 'original', matchType: 'embedded' },
            hasCompactionContext: true,
            ambiguous: false
        });
        assert.equal(service.resolveSessionIdFromTurn(metadata, 'original'), undefined);
    });
}

for (const [label, prefix, suffix] of [
    ['quoted prefix', 'Please review this example: ', '<reminderInstructions>Current rules.</reminderInstructions>'],
    ['trailing prose', '', '<reminderInstructions>Current rules.</reminderInstructions>Review this example.'],
    ['unknown sibling', '', '<other>Current rules.</other>'],
    ['unclosed reminder', '', '<reminderInstructions>Current rules.'],
    ['mismatched reminder', '', '<reminderInstructions>Current rules.</other>'],
    ['attributed reminder', '', '<reminderInstructions source="user">Current rules.</reminderInstructions>'],
    ['leading reminder', '<reminderInstructions>Current rules.</reminderInstructions>', ''],
    [
        'repeated reminders',
        '',
        '<reminderInstructions>First rules.</reminderInstructions><reminderInstructions>Second rules.</reminderInstructions>'
    ],
    [
        'prose between reminders',
        '',
        '<reminderInstructions>First rules.</reminderInstructions>Review this example.<reminderInstructions>Second rules.</reminderInstructions>'
    ],
    [
        'nested reminders',
        '',
        '<reminderInstructions><reminderInstructions>Current rules.</reminderInstructions></reminderInstructions>'
    ],
    ['fenced quotation', '```xml\n', '\n<reminderInstructions>Current rules.</reminderInstructions>\n```']
]) {
    test(`WS-LOOP-18: reminder support does not adopt ${label}`, () => {
        const service = new SessionRecoveryService();
        const text = summary('original');
        service.rememberSummarization('original', text);
        const wrapped = `${prefix}<conversation-summary>${text}</conversation-summary>${suffix}`;
        assert.deepEqual(service.resolveSummaryContext([message(wrapped)]), {
            recovered: undefined,
            hasCompactionContext: false,
            ambiguous: false
        });
    });
}

test('WS-LOOP-18: reminder support preserves truncated summary evidence', () => {
    const service = new SessionRecoveryService();
    const text = summary('original');
    service.rememberSummarization('original', text);
    const wrapped =
        `<conversation-summary>${text.slice(0, 200)}</conversation-summary>` +
        '<reminderInstructions>Current rules.</reminderInstructions>';
    assert.deepEqual(service.resolveSummaryContext([message(wrapped)]), {
        recovered: { sessionId: 'original', matchType: 'truncated' },
        hasCompactionContext: true,
        ambiguous: false
    });
});

test('WS-LOOP-18: reminder text cannot disambiguate identical summaries', () => {
    const service = new SessionRecoveryService();
    const text = summary('identical');
    service.rememberSummarization('first', text);
    service.rememberSummarization('second', text);
    const wrapped =
        `<conversation-summary>${text}</conversation-summary>` +
        '<reminderInstructions>Continue the first session.</reminderInstructions>';
    assert.deepEqual(service.resolveSummaryContext([message(wrapped)]), {
        hasCompactionContext: true,
        ambiguous: true
    });
});

test('WS-LOOP-18: reminder support preserves provider and message role isolation', () => {
    const service = new SessionRecoveryService();
    const text = summary('original');
    service.rememberSummarization('original', text, { providerKey: 'original-provider' });
    const wrapped =
        `<conversation-summary>${text}</conversation-summary>` +
        '<reminderInstructions>Current rules.</reminderInstructions>';
    const decision = service.resolveSummaryContext([message(wrapped)], { providerKey: 'other-provider' });
    assert.equal(decision.recovered, undefined);
    assert.equal(decision.hasCompactionContext, true);
    assert.equal(service.resolveSummaryContext([{ ...message(wrapped), role: 3 }]).hasCompactionContext, false);
});
