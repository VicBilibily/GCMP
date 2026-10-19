import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import * as vscode from 'vscode';
import { ApiKeyManager } from '../../src/utils/config/apiKeyManager';
import { StreamReporter } from '../../src/handlers/streamReporter';
import { OpenAIResponsesStreamProcessor } from '../../src/handlers/openai/openaiResponsesStreamProcessor';
import {
    SDK_COMPACTION,
    SDK_EXPLORE_SUBAGENT,
    SDK_SESSION_CONTEXT
} from '../../src/handlers/classification/testFixtures/sdkPurposeSamples';
import { createLiveResponsesFixture } from '../fixtures/responsesWebSocketLiveFixture';

const COPILOT_CHAT_MAIN = 'You are an expert AI programming assistant, working with a user in the VS Code editor.';

suite('Responses WebSocket roundtrip scenario matrix', function () {
    this.timeout(30_000);
    if (process.env.GCMP_WS_HOST_E2E !== '1') {
        return;
    }

    for (const variant of ['summary', 'SDK compaction', 'title', 'unclassified'] as const) {
        test(`WS-LOOP-01: public independent ${variant} uses HTTP without retiring Agent WS`, async () => {
            const fixture = await createLiveResponsesFixture('text', { delta: true });
            fixture.configure({ extraBody: { store: false, parallel_tool_calls: true } });
            try {
                const history = fixture.history('first');
                const sessionContext = SDK_SESSION_CONTEXT.replace(
                    '11111111-1111-4111-8111-111111111111',
                    randomUUID()
                );
                if (variant === 'SDK compaction') {
                    history[0].content.push(new vscode.LanguageModelTextPart('\n' + sessionContext));
                }
                fixture.failFastCapture();
                const first = await fixture.begin(history, 1).result;
                assert.equal(fixture.text(first), 'mock response');
                const independent =
                    variant === 'SDK compaction' ? fixture.history(SDK_COMPACTION)
                    : variant === 'unclassified' ? [vscode.LanguageModelChatMessage.User('standalone request')]
                    : [
                            new vscode.LanguageModelChatMessage(
                                vscode.LanguageModelChatMessageRole.System,
                                variant === 'summary' ?
                                    'Your task is to create a comprehensive, detailed summary of the entire conversation'
                                :   'You are an expert in crafting pithy titles'
                            ),
                            vscode.LanguageModelChatMessage.User('standalone request')
                        ];
                if (variant === 'SDK compaction') {
                    independent[0].content.push(new vscode.LanguageModelTextPart('\n' + sessionContext));
                    independent.splice(
                        1,
                        0,
                        vscode.LanguageModelChatMessage.User([
                            new vscode.LanguageModelToolResultPart('trimmed-call', [
                                new vscode.LanguageModelTextPart('retained historical result')
                            ])
                        ])
                    );
                }
                fixture.failFastCapture(false);
                const result = await fixture.begin(independent, 1, {
                    session: variant === 'SDK compaction' ? false : undefined
                }).result;
                assert.equal(fixture.text(result), 'mock HTTP response');
                assert.equal(
                    fixture.estimates[1].requestKind,
                    variant === 'unclassified' ? 'unclassified'
                    : variant === 'title' ? 'chat-title'
                    : 'summarization'
                );
                assert.equal(fixture.pool.diagnostics().connections, 1);
                if (variant === 'SDK compaction') {
                    assert.equal(fixture.estimates[1].sessionId, fixture.estimates[0].sessionId);
                }
                fixture.failFastCapture();
                const nextHistory =
                    variant === 'SDK compaction' ?
                        [
                            history[0],
                            vscode.LanguageModelChatMessage.User(`Adopted summary: ${fixture.text(result)}`),
                            vscode.LanguageModelChatMessage.User('next')
                        ]
                    :   [
                            ...history,
                            vscode.LanguageModelChatMessage.Assistant(fixture.replay(first)),
                            vscode.LanguageModelChatMessage.User('next')
                        ];
                const next = await fixture.begin(nextHistory, 2, {
                    session: variant === 'SDK compaction' ? false : undefined
                }).result;
                assert.equal(fixture.text(next), 'mock response');
                if (variant === 'SDK compaction') {
                    assert.equal(fixture.estimates[2].sessionId, fixture.estimates[0].sessionId);
                    const continued = await fixture.begin(
                        [
                            ...nextHistory,
                            vscode.LanguageModelChatMessage.Assistant(fixture.replay(next)),
                            vscode.LanguageModelChatMessage.User('continue after compaction')
                        ],
                        3,
                        { session: false }
                    ).result;
                    assert.equal(fixture.text(continued), 'mock response');
                    assert.equal(fixture.estimates[3].sessionId, fixture.estimates[0].sessionId);
                }
                const observed = await fixture.mock.snapshot();
                assert.equal(observed.handshakes, 1);
                assert.equal(observed.full, variant === 'SDK compaction' ? 2 : 1);
                assert.equal(observed.delta, 1);
                assert.equal(observed.received, variant === 'SDK compaction' ? 3 : 2);
                assert.equal(observed.httpAccepted, 1);
                assert.equal(fixture.counters().http, 1);
                assert.equal(fixture.counters().captures, 1);
                assert.equal(
                    fixture.updates.filter(update => update.status === 'completed').length,
                    variant === 'SDK compaction' ? 4 : 3
                );
                const entries = await fixture.close();
                assert.equal(entries.length, 1);
                assert.ok(entries[0].request.postData);
                const body: { parallel_tool_calls?: boolean; previous_response_id?: string; useWebSocket?: boolean } =
                    JSON.parse(entries[0].request.postData.text);
                assert.equal(body.parallel_tool_calls, true);
                assert.equal(body.previous_response_id, undefined);
                assert.equal(body.useWebSocket, undefined);
            } finally {
                await fixture.dispose();
            }
        });
    }

    test('WS-LOOP-13: public auxiliary notifications preserve output usage and WS reuse', async () => {
        const fixture = await createLiveResponsesFixture('auxiliary-events', { delta: true });
        try {
            fixture.failFastCapture();
            const history = fixture.history('first');
            const first = await fixture.begin(history, 1).result;
            assert.equal(fixture.text(first), 'mock response');
            const next = await fixture.begin(
                [
                    ...history,
                    vscode.LanguageModelChatMessage.Assistant(fixture.replay(first)),
                    vscode.LanguageModelChatMessage.User('next')
                ],
                2
            ).result;
            assert.equal(fixture.text(next), 'mock response');
            fixture.assertNoMarkers(first);
            fixture.assertNoMarkers(next);
            const snapshot = await fixture.mock.snapshot();
            assert.equal(snapshot.handshakes, 1);
            assert.equal(snapshot.received, 2);
            assert.equal(snapshot.accepted, 2);
            assert.equal(snapshot.full, 1);
            assert.equal(snapshot.delta, 1);
            assert.equal(snapshot.sent, 26);
            assert.equal(snapshot.httpAccepted, 0);
            assert.equal(fixture.estimates.length, 2);
            assert.equal(fixture.updates.length, 2);
            assert.equal(new Set(fixture.updates.map(update => update.requestId)).size, 2);
            for (const update of fixture.updates) {
                assert.equal(update.status, 'completed');
                assert.deepEqual(update.rawUsage, { input_tokens: 2, output_tokens: 1, total_tokens: 3 });
            }
            assert.equal(fixture.counters().http, 0);
            assert.equal(fixture.counters().captures, 0);
            assert.equal((await fixture.close()).length, 0);
        } finally {
            await fixture.dispose();
        }
    });

    test('WS-LOOP-19: public orphan tool results fail before dispatch', async () => {
        const fixture = await createLiveResponsesFixture('text');
        try {
            const request = fixture.begin(
                [
                    ...fixture.history('first'),
                    vscode.LanguageModelChatMessage.User([
                        new vscode.LanguageModelToolResultPart('missing-call', [
                            new vscode.LanguageModelTextPart('result')
                        ])
                    ])
                ],
                1
            );
            await assert.rejects(request.result, /context|history|replay/i);
            const snapshot = await fixture.mock.snapshot();
            assert.equal(snapshot.handshakes, 0);
            assert.equal(snapshot.accepted + snapshot.httpAccepted, 0);
            assert.equal(fixture.provider.grants, 0);
            assert.equal(fixture.estimates.length, 0);
            await fixture.close();
        } finally {
            await fixture.dispose();
        }
    });

    for (const invalid of ['duplicate-call', 'duplicate-result'] as const) {
        test(`WS-LOOP-19: public invalid tool history ${invalid} fails before dispatch`, async () => {
            const fixture = await createLiveResponsesFixture('text');
            try {
                const toolCall = vscode.LanguageModelChatMessage.Assistant([
                    new vscode.LanguageModelToolCallPart('call', 'lookup', { key: 'A' })
                ]);
                const toolResult = vscode.LanguageModelChatMessage.User([
                    new vscode.LanguageModelToolResultPart('call', [new vscode.LanguageModelTextPart('result')])
                ]);
                const request = fixture.begin(
                    [
                        ...fixture.history('first'),
                        toolCall,
                        ...(invalid === 'duplicate-call' ? [toolCall] : [toolResult, toolResult])
                    ],
                    1
                );
                await assert.rejects(request.result, /context|history|replay/i);
                const snapshot = await fixture.mock.snapshot();
                assert.equal(snapshot.handshakes + snapshot.accepted + snapshot.httpAccepted, 0);
                assert.equal(fixture.provider.grants, 0);
                assert.equal(fixture.estimates.length, 0);
                await fixture.close();
            } finally {
                await fixture.dispose();
            }
        });
    }

    for (const delta of [false, true]) {
        test(`WS-LOOP-04: public SDK custom wrapper preserves raw inputs, delta=${delta}`, async () => {
            const fixture = await createLiveResponsesFixture(delta ? 'custom-wrapped-delta' : 'custom-wrapped-full', {
                delta
            });
            try {
                const history = fixture.history('first');
                const expectedInputs = [
                    '',
                    'not JSON',
                    'first\nsecond\r\nthird',
                    '"quote" \\path\tend',
                    '\u4e2d\u6587 \ud83d\ude80'
                ];
                for (const [index, input] of expectedInputs.entries()) {
                    const parts = await fixture.begin(history, index + 1).result;
                    const calls = parts.filter(part => part instanceof vscode.LanguageModelToolCallPart);
                    assert.equal(calls.length, 1);
                    assert.equal(calls[0].name, 'raw');
                    assert.deepEqual(calls[0].input, { input });
                    fixture.assertNoMarkers(parts);
                    history.push(
                        vscode.LanguageModelChatMessage.Assistant(fixture.replay(parts)),
                        vscode.LanguageModelChatMessage.User([
                            new vscode.LanguageModelToolResultPart(calls[0].callId, [
                                new vscode.LanguageModelTextPart(`result-${index}`)
                            ])
                        ])
                    );
                }
                assert.equal(fixture.text(await fixture.begin(history, 6).result), 'mock response');
                const snapshot = await fixture.mock.snapshot();
                assert.equal(snapshot.contextChecks, 6);
                assert.equal(snapshot.contextErrors, 0);
                assert.equal(snapshot.handshakes, 1);
                assert.equal(snapshot.full, delta ? 1 : 6);
                assert.equal(snapshot.delta, delta ? 5 : 0);
                assert.equal(snapshot.httpAccepted, 0);
                assert.equal((await fixture.close()).length, 0);
            } finally {
                await fixture.dispose();
            }
        });
    }

    for (const replay of [
        'thinking-parts',
        'copilot-chat',
        'thinking-stripped',
        'thinking-omitted',
        'include-disabled'
    ] as const) {
        test(`WS-LOOP-19: public encrypted reasoning continuation ${replay}`, async () => {
            const fixture = await createLiveResponsesFixture(
                replay === 'thinking-omitted' ? 'reasoning-omitted' : 'reasoning-replay',
                { delta: true }
            );
            try {
                fixture.configure({
                    extraBody: {
                        store: false,
                        include: replay === 'include-disabled' ? [] : ['reasoning.encrypted_content']
                    }
                });
                const history = fixture.history('first');
                const completeReplay = replay === 'thinking-parts' || replay === 'copilot-chat';
                const session = completeReplay ? false : 'live-e2e-session';
                if (replay === 'copilot-chat') {
                    history[0] = new vscode.LanguageModelChatMessage(
                        vscode.LanguageModelChatMessageRole.System,
                        COPILOT_CHAT_MAIN
                    );
                } else if (session === false) {
                    history[0].content.push(new vscode.LanguageModelTextPart('\n' + SDK_SESSION_CONTEXT));
                }
                const parts = await fixture.begin(history, 1, { session }).result;
                assert.ok(parts.some(part => part instanceof vscode.LanguageModelThinkingPart));
                assert.equal(fixture.text(parts), 'before tool');
                if (replay !== 'copilot-chat') {
                    fixture.assertNoMarkers(parts);
                }
                const tool = parts.find(part => part instanceof vscode.LanguageModelToolCallPart);
                assert.ok(tool);
                assert.deepEqual(tool.input, { limit: 2, key: 'A' });
                const replayed = [
                    ...fixture.replay(parts),
                    ...(replay === 'thinking-stripped' || replay === 'thinking-omitted' || replay === 'copilot-chat' ?
                        []
                    :   parts.filter(part => part instanceof vscode.LanguageModelThinkingPart))
                ] as Parameters<typeof vscode.LanguageModelChatMessage.Assistant>[0];
                const secondHistory = [
                    ...history,
                    vscode.LanguageModelChatMessage.Assistant(replayed),
                    vscode.LanguageModelChatMessage.User([
                        new vscode.LanguageModelToolResultPart(tool.callId, [
                            new vscode.LanguageModelTextPart('result-A')
                        ])
                    ])
                ];
                const request = fixture.begin(secondHistory, 2, { session });
                if (replay === 'thinking-stripped') {
                    await assert.rejects(
                        request.result,
                        (error: unknown) =>
                            error instanceof Error &&
                            'code' in error &&
                            error.code === 'mock_reasoning_context_mismatch'
                    );
                    const rejected = await fixture.mock.snapshot();
                    assert.equal(rejected.contextChecks, 1);
                    assert.equal(rejected.contextErrors, 1);
                    assert.equal(rejected.received, 2);
                    assert.equal(rejected.delta, 0);
                    assert.equal(rejected.httpAccepted, 0);
                    await fixture.close();
                    return;
                }
                const output = await request.result;
                assert.equal(fixture.text(output), 'mock response');
                if (completeReplay) {
                    const third = await fixture.begin(
                        [
                            ...secondHistory,
                            vscode.LanguageModelChatMessage.Assistant(fixture.replay(output)),
                            vscode.LanguageModelChatMessage.User('next')
                        ],
                        3,
                        { session }
                    ).result;
                    assert.equal(fixture.text(third), 'mock response');
                }
                if (replay === 'copilot-chat') {
                    assert.deepEqual(
                        fixture.estimates.map(record => record.requestClassification?.requestOrigin),
                        ['copilot-chat', 'copilot-chat', 'copilot-chat']
                    );
                    assert.deepEqual(
                        fixture.estimates.map(record => record.sessionRecoverySource),
                        ['new-uuid', 'stateful-marker', 'stateful-marker']
                    );
                }
                const snapshot = await fixture.mock.snapshot();
                assert.equal(snapshot.contextChecks, completeReplay ? 3 : 2);
                assert.equal(snapshot.contextErrors, 0);
                assert.equal(snapshot.full, completeReplay ? 1 : 2);
                assert.equal(snapshot.delta, completeReplay ? 2 : 0);
                assert.deepEqual(snapshot.wireInputItems, completeReplay ? [1, 1, 1] : [1, 4]);
                assert.equal(snapshot.handshakes, 1);
                assert.equal(snapshot.httpAccepted, 0);
                assert.equal((await fixture.close()).length, 0);
            } finally {
                await fixture.dispose();
            }
        });
    }

    for (const terminalOutput of ['empty', 'reasoning'] as const) {
        test(`WS-LOOP-19: Copilot Chat ${terminalOutput} terminal omits replayed text and five parallel calls`, async () => {
            const fixture = await createLiveResponsesFixture(
                terminalOutput === 'empty' ? 'parallel-done-empty' : 'parallel-done-reasoning',
                { delta: true }
            );
            fixture.failFastCapture();
            try {
                fixture.configure({ extraBody: { store: false, include: ['reasoning.encrypted_content'] } });
                const history = [
                    new vscode.LanguageModelChatMessage(vscode.LanguageModelChatMessageRole.System, COPILOT_CHAT_MAIN),
                    vscode.LanguageModelChatMessage.User('first')
                ];
                const first = await fixture.begin(history, 1, { session: false }).result;
                assert.equal(fixture.text(first), 'before tools');
                const calls = first.filter(part => part instanceof vscode.LanguageModelToolCallPart);
                assert.equal(calls.length, 5);
                assert.deepEqual(
                    calls.map(part => part.input),
                    ['A', 'B', 'C', 'D', 'E'].map(key => ({ limit: 2, key }))
                );
                history.push(vscode.LanguageModelChatMessage.Assistant(fixture.replay(first)));
                history.push(
                    vscode.LanguageModelChatMessage.User(
                        calls.map(
                            call =>
                                new vscode.LanguageModelToolResultPart(call.callId, [
                                    new vscode.LanguageModelTextPart(`result-${call.callId.slice('call-'.length)}`)
                                ])
                        )
                    )
                );
                const second = await fixture.begin(history, 2, { session: false }).result;
                assert.equal(fixture.text(second), 'mock response');
                history.push(vscode.LanguageModelChatMessage.Assistant(fixture.replay(second)));
                history.push(vscode.LanguageModelChatMessage.User('next'));
                const third = await fixture.begin(history, 3, { session: false }).result;
                assert.equal(fixture.text(third), 'mock response');
                assert.deepEqual(
                    fixture.estimates.map(record => record.sessionRecoverySource),
                    ['new-uuid', 'stateful-marker', 'stateful-marker']
                );
                assert.deepEqual(
                    fixture.estimates.map(record => record.requestClassification?.requestOrigin),
                    ['copilot-chat', 'copilot-chat', 'copilot-chat']
                );
                const observed = await fixture.mock.snapshot();
                assert.equal(observed.handshakes, 1);
                assert.equal(observed.contextChecks, 3);
                assert.equal(observed.contextErrors, 0);
                assert.equal(observed.full, 1);
                assert.equal(observed.delta, 2);
                assert.deepEqual(observed.wireInputItems, [1, 5, 1]);
                assert.equal(observed.httpAccepted, 0);
                assert.equal(fixture.updates.filter(update => update.status === 'completed').length, 3);
                assert.equal(fixture.counters().http, 0);
                assert.equal(fixture.counters().captures, 0);
                assert.equal((await fixture.close()).length, 0);
            } finally {
                await fixture.dispose();
            }
        });
    }

    for (const enabled of [undefined, false]) {
        test(`WS-LOOP-01: public HTTP default useWebSocket=${String(enabled)}`, async () => {
            const fixture = await createLiveResponsesFixture('text');
            try {
                const provider = fixture.makeProvider(enabled);
                const parts = await fixture.begin(fixture.history('HTTP baseline'), 1, { provider }).result;
                assert.equal(fixture.text(parts), 'mock HTTP response');
                assert.equal((await fixture.mock.snapshot()).handshakes, 0);
                assert.equal((await fixture.mock.snapshot()).httpAccepted, 1);
                assert.equal((await fixture.close()).length, 1);
            } finally {
                await fixture.dispose();
            }
        });
    }

    test('WS-LOOP-11: public cancellation during real credential lookup sends nothing', async () => {
        const fixture = await createLiveResponsesFixture('text');
        const original = ApiKeyManager.getApiKeyForRequest;
        let entered!: () => void;
        let release!: () => void;
        const waiting = new Promise<void>(resolve => {
            entered = resolve;
        });
        const barrier = new Promise<void>(resolve => {
            release = resolve;
        });
        ApiKeyManager.getApiKeyForRequest = async (...args) => {
            entered();
            await barrier;
            return original.apply(ApiKeyManager, args);
        };
        try {
            const request = fixture.begin(fixture.history('credential wait'), 1);
            await waiting;
            request.cancel();
            release();
            await assert.rejects(request.result, error => error instanceof vscode.CancellationError);
            const observed = await fixture.mock.snapshot();
            assert.equal(observed.handshakes + observed.accepted + observed.httpAccepted, 0);
            assert.equal(fixture.updates.filter(update => update.status === 'cancelled').length, 1);
            await fixture.close();
        } finally {
            release();
            ApiKeyManager.getApiKeyForRequest = original;
            await fixture.dispose();
        }
    });

    test('WS-LOOP-11: public cancellation during CONNECT destroys only the pending connection', async () => {
        const fixture = await createLiveResponsesFixture('text', {
            network: { proxy: 'stall' },
            proxy: 'configured',
            productionRouting: true
        });
        try {
            const request = fixture.begin(fixture.history('handshake wait'), 1);
            await fixture.mock.waitFor({ connects: 1 }).catch(async () => {
                throw new Error(
                    JSON.stringify({ snapshot: await fixture.mock.snapshot(), counters: fixture.counters() })
                );
            });
            request.cancel();
            await assert.rejects(request.result, error => error instanceof vscode.CancellationError);
            assert.equal((await fixture.mock.snapshot()).accepted, 0);
            assert.equal(fixture.counters().http, 0);
            assert.equal(fixture.updates.filter(update => update.status === 'cancelled').length, 1);
            await fixture.close();
        } finally {
            await fixture.dispose();
        }
    });

    test('WS-LOOP-11: public progress cancellation before terminal cannot commit', async () => {
        const fixture = await createLiveResponsesFixture('text', { delta: true });
        try {
            const request: ReturnType<typeof fixture.begin> = fixture.begin(fixture.history('first'), 1, {
                report: part => {
                    if (part instanceof vscode.LanguageModelTextPart) {
                        request.cancel();
                    }
                }
            });
            await assert.rejects(request.result, error => error instanceof vscode.CancellationError);
            assert.equal(fixture.updates.filter(update => update.status === 'cancelled').length, 1);
            await fixture.begin(fixture.history('new request'), 2).result;
            const observed = await fixture.mock.snapshot();
            assert.equal(observed.full, 2);
            assert.equal(observed.delta, 0);
            await fixture.close();
        } finally {
            await fixture.dispose();
        }
    });

    test('WS-LOOP-11: public late cancellation after commit cannot close the next turn', async () => {
        const fixture = await createLiveResponsesFixture('text', { delta: true });
        try {
            const history = fixture.history('first');
            const first = fixture.begin(history, 1);
            const output = await first.result;
            const next = fixture.begin(
                [
                    ...history,
                    vscode.LanguageModelChatMessage.Assistant(fixture.replay(output)),
                    vscode.LanguageModelChatMessage.User('next')
                ],
                2
            );
            first.cancel();
            assert.equal(fixture.text(await next.result), 'mock response');
            const observed = await fixture.mock.snapshot();
            assert.equal(observed.handshakes, 1);
            assert.equal(observed.delta, 1);
            assert.equal(fixture.updates.filter(update => update.status === 'completed').length, 2);
            await fixture.close();
        } finally {
            await fixture.dispose();
        }
    });

    for (const turn of [undefined, 'invalid-turn'] as const) {
        test(`WS-LOOP-17: public turn=${String(turn)} is not a connection identity`, async () => {
            const fixture = await createLiveResponsesFixture('text', { delta: true });
            try {
                const history = fixture.history('first');
                const first = await fixture.begin(history, 1).result;
                await fixture.begin(
                    [
                        ...history,
                        vscode.LanguageModelChatMessage.Assistant(fixture.replay(first)),
                        vscode.LanguageModelChatMessage.User('next')
                    ],
                    turn
                ).result;
                const observed = await fixture.mock.snapshot();
                assert.equal(observed.handshakes, 1);
                assert.equal(observed.delta, 1);
                await fixture.close();
            } finally {
                await fixture.dispose();
            }
        });
    }

    test('WS-LOOP-17: Copilot Chat new session and marker share the first connection', async () => {
        const fixture = await createLiveResponsesFixture('text', { delta: true, useInstructions: false });
        fixture.failFastCapture();
        try {
            const history = [
                new vscode.LanguageModelChatMessage(vscode.LanguageModelChatMessageRole.System, COPILOT_CHAT_MAIN),
                vscode.LanguageModelChatMessage.User('first')
            ];
            for (const turn of [1, 2, 3]) {
                const parts = await fixture.begin(history, turn, { session: false }).result;
                assert.equal(fixture.text(parts), 'mock response');
                history.push(vscode.LanguageModelChatMessage.Assistant(fixture.replay(parts)));
                history.push(vscode.LanguageModelChatMessage.User(`next-${turn}`));
            }
            assert.deepEqual(
                fixture.estimates.map(record => record.requestClassification?.requestOrigin),
                ['copilot-chat', 'copilot-chat', 'copilot-chat']
            );
            assert.deepEqual(
                fixture.estimates.map(record => record.sessionRecoverySource),
                ['new-uuid', 'stateful-marker', 'stateful-marker']
            );
            assert.equal(new Set(fixture.estimates.map(record => record.sessionId)).size, 1);
            const observed = await fixture.mock.snapshot();
            assert.equal(observed.handshakes, 1);
            assert.equal(observed.full, 1);
            assert.equal(observed.delta, 2);
            assert.deepEqual(observed.wireInputItems, [2, 1, 1]);
            assert.equal(fixture.updates.filter(update => update.status === 'completed').length, 3);
            assert.equal(fixture.counters().http, 0);
            assert.equal(fixture.counters().captures, 0);
            assert.equal((await fixture.close()).length, 0);
        } finally {
            await fixture.dispose();
        }
    });

    test('WS-LOOP-17: SDK session context reuses first connection without conversation metadata', async () => {
        const fixture = await createLiveResponsesFixture('text', { delta: true });
        fixture.failFastCapture();
        try {
            const history = fixture.history('first');
            history[0].content.push(
                new vscode.LanguageModelTextPart(
                    '\n' +
                        SDK_SESSION_CONTEXT.replace(
                            '11111111-1111-4111-8111-111111111111',
                            '22222222-2222-4222-8222-222222222222'
                        )
                )
            );
            for (const turn of [1, 2, 3]) {
                const parts = await fixture.begin(history, turn, { session: false }).result;
                assert.equal(fixture.text(parts), 'mock response');
                history.push(vscode.LanguageModelChatMessage.Assistant(fixture.replay(parts)));
                history.push(vscode.LanguageModelChatMessage.User(`next-${turn}`));
            }
            const observed = await fixture.mock.snapshot();
            assert.equal(observed.handshakes, 1);
            assert.equal(observed.full, 1);
            assert.equal(observed.delta, 2);
            assert.deepEqual(observed.wireInputItems, [1, 1, 1]);
            assert.equal(new Set(fixture.estimates.map(record => record.sessionId)).size, 1);
            assert.equal(fixture.updates.length, 3);
            assert.equal(fixture.counters().http, 0);
            assert.equal(fixture.counters().captures, 0);
            assert.equal((await fixture.close()).length, 0);
        } finally {
            await fixture.dispose();
        }
    });

    for (const conflict of [false, true]) {
        test(
            conflict ?
                'WS-LOOP-17: conflicting explicit SDK sessions remain ambiguous after metadata loss'
            :   'WS-LOOP-17: distinct explicit SDK sessions survive metadata loss independently',
            async () => {
                const fixture = await createLiveResponsesFixture('text', { delta: true });
                fixture.failFastCapture();
                try {
                    const sessions = [randomUUID(), randomUUID()];
                    const contexts = [randomUUID(), randomUUID()];
                    const histories = contexts.map((contextId, index) => {
                        const history = fixture.history(`first-${index}`);
                        history[0].content.push(
                            new vscode.LanguageModelTextPart(
                                '\n' +
                                    SDK_SESSION_CONTEXT.replace(
                                        '11111111-1111-4111-8111-111111111111',
                                        conflict ? contexts[0] : contextId
                                    )
                            )
                        );
                        return history;
                    });
                    for (const [index, historyIndex] of [0, 1, 0, 1].entries()) {
                        const history = histories[historyIndex];
                        const parts = await fixture.begin(history, index + 1, {
                            session: index < 2 ? sessions[historyIndex] : false
                        }).result;
                        assert.equal(fixture.text(parts), 'mock response');
                        fixture.assertNoMarkers(parts);
                        history.push(vscode.LanguageModelChatMessage.Assistant(fixture.replay(parts)));
                        history.push(vscode.LanguageModelChatMessage.User('next'));
                    }
                    const resolved = fixture.estimates.map(record => record.sessionId);
                    assert.deepEqual(resolved.slice(0, 2), sessions);
                    if (conflict) {
                        assert.equal(new Set(resolved).size, 4);
                    } else {
                        assert.deepEqual(resolved.slice(2), sessions);
                    }
                    const observed = await fixture.mock.snapshot();
                    assert.equal(observed.handshakes, conflict ? 4 : 2);
                    assert.equal(observed.full, conflict ? 4 : 2);
                    assert.equal(observed.delta, conflict ? 0 : 2);
                    assert.equal(observed.httpAccepted, 0);
                    assert.equal(fixture.updates.length, 4);
                    assert.equal((await fixture.close()).length, 0);
                } finally {
                    await fixture.dispose();
                }
            }
        );
    }

    for (const origin of ['copilot-sdk', 'copilot-chat'] as const) {
        test(
            origin === 'copilot-sdk' ?
                'WS-LOOP-17: distinct SDK contexts keep independent first connections and checkpoints'
            :   'WS-LOOP-17: distinct Copilot Chat markers keep independent first connections and checkpoints',
            async () => {
                const fixture = await createLiveResponsesFixture('text', { delta: true });
                fixture.failFastCapture();
                try {
                    const histories = [
                        '44444444-4444-4444-8444-444444444444',
                        '55555555-5555-4555-8555-555555555555'
                    ].map(id => {
                        const history = fixture.history(`first-${id}`);
                        if (origin === 'copilot-chat') {
                            history[0] = new vscode.LanguageModelChatMessage(
                                vscode.LanguageModelChatMessageRole.System,
                                COPILOT_CHAT_MAIN
                            );
                        } else {
                            history[0].content.push(
                                new vscode.LanguageModelTextPart(
                                    '\n' + SDK_SESSION_CONTEXT.replace('11111111-1111-4111-8111-111111111111', id)
                                )
                            );
                        }
                        return history;
                    });
                    for (const [turn, historyIndex] of [0, 1, 0].entries()) {
                        const history = histories[historyIndex];
                        const parts = await fixture.begin(history, turn + 1, { session: false }).result;
                        assert.equal(fixture.text(parts), 'mock response');
                        history.push(vscode.LanguageModelChatMessage.Assistant(fixture.replay(parts)));
                        history.push(vscode.LanguageModelChatMessage.User('next'));
                    }
                    const observed = await fixture.mock.snapshot();
                    assert.equal(observed.handshakes, 2);
                    assert.equal(observed.full, 2);
                    assert.equal(observed.delta, 1);
                    assert.deepEqual(observed.wireInputItems, [1, 1, 1]);
                    assert.equal(new Set(fixture.estimates.map(record => record.sessionId)).size, 2);
                    assert.equal(fixture.estimates[0].sessionId, fixture.estimates[2].sessionId);
                    assert.deepEqual(
                        fixture.estimates.map(record => record.requestClassification?.requestOrigin),
                        [origin, origin, origin]
                    );
                    if (origin === 'copilot-chat') {
                        assert.deepEqual(
                            fixture.estimates.map(record => record.sessionRecoverySource),
                            ['new-uuid', 'new-uuid', 'stateful-marker']
                        );
                    }
                    assert.equal(fixture.counters().http, 0);
                    assert.equal(fixture.counters().captures, 0);
                    assert.equal((await fixture.close()).length, 0);
                } finally {
                    await fixture.dispose();
                }
            }
        );
    }

    for (const variant of ['missing-session', 'subagent-without-branch'] as const) {
        test(`WS-LOOP-07: public weak identity ${variant} uses isolated WS full`, async () => {
            const fixture = await createLiveResponsesFixture('text');
            try {
                const history =
                    variant === 'missing-session' ?
                        fixture.history('first')
                    :   [
                            new vscode.LanguageModelChatMessage(
                                vscode.LanguageModelChatMessageRole.System,
                                SDK_EXPLORE_SUBAGENT
                            ),
                            vscode.LanguageModelChatMessage.User('first')
                        ];
                for (const turn of [1, 2]) {
                    const parts = await fixture.begin(history, turn, {
                        session: variant === 'missing-session' ? false : 'same-session'
                    }).result;
                    assert.equal(fixture.text(parts), 'mock response');
                }
                const observed = await fixture.mock.snapshot();
                assert.equal(observed.handshakes, 2);
                assert.equal(observed.full, 2);
                assert.equal(observed.delta, 0);
                assert.equal(observed.httpAccepted, 0);
                assert.deepEqual(observed.wireInputItems, [1, 1]);
                assert.equal(fixture.counters().http, 0);
                assert.equal((await fixture.close()).length, 0);
            } finally {
                await fixture.dispose();
            }
        });
    }

    for (const variant of ['success', 'reject', 'cancel', 'close', 'retry'] as const) {
        test(`WS-LOOP-14: HAR ${variant} records no WS capture or entry`, async () => {
            const fixture = await createLiveResponsesFixture(
                variant === 'reject' || variant === 'retry' ? 'reject-upgrade'
                : variant === 'cancel' ? 'paused'
                : variant === 'close' ? 'completed-close'
                : 'text',
                { retryEnabled: variant === 'retry' }
            );
            try {
                fixture.failFastCapture();
                const request = fixture.begin(fixture.history('HAR boundary'), 1);
                if (variant === 'reject' || variant === 'retry') {
                    await assert.rejects(request.result);
                } else if (variant === 'cancel') {
                    await fixture.mock.waitFor({ accepted: 1, pendingResponses: 1 });
                    request.cancel();
                    await assert.rejects(request.result, error => error instanceof vscode.CancellationError);
                } else {
                    await request.result;
                }
                assert.equal(fixture.counters().captures, 0);
                assert.equal(fixture.counters().http, 0);
                const entries = await fixture.close();
                assert.equal(entries.length, 0);
            } finally {
                await fixture.dispose();
            }
        });
    }

    for (const [manual, withReminder] of [
        [false, false],
        [true, false],
        [false, true],
        [true, true]
    ]) {
        test(`WS-LOOP-18: Copilot Chat ${manual ? 'manual ' : ''}HTTP compaction resumes the same session through a long wrapped summary${withReminder ? ' and reminder instructions' : ''}`, async () => {
            const summary =
                `Summary for ${randomUUID()}: ` +
                'Retain current task decisions and verification results. '.repeat(220);
            const responseText =
                manual ?
                    `Completed response ${randomUUID()}: ` + 'verified main response '.repeat(20)
                :   'mock response';
            const summaryResponse =
                manual ? `<analysis>${'a'.repeat(12434)}</analysis>\n<summary>\n${summary}\n</summary>` : summary;
            const fixture = await createLiveResponsesFixture('text', {
                delta: true,
                useInstructions: false,
                httpResponseText: summaryResponse,
                responseText
            });
            try {
                const system = new vscode.LanguageModelChatMessage(
                    vscode.LanguageModelChatMessageRole.System,
                    COPILOT_CHAT_MAIN
                );
                const history = [system, vscode.LanguageModelChatMessage.User('first')];
                fixture.failFastCapture();
                const first = await fixture.begin(history, manual ? undefined : 8, { session: false }).result;
                fixture.failFastCapture(false);
                const compacted = await fixture.begin(
                    manual ?
                        [
                            new vscode.LanguageModelChatMessage(
                                vscode.LanguageModelChatMessageRole.System,
                                'Your task is to create a comprehensive, detailed summary of the entire conversation'
                            ),
                            history[1],
                            vscode.LanguageModelChatMessage.Assistant(fixture.text(first)),
                            vscode.LanguageModelChatMessage.User('Summarize the conversation history so far.')
                        ]
                    :   [
                            ...history,
                            vscode.LanguageModelChatMessage.Assistant(fixture.replay(first)),
                            vscode.LanguageModelChatMessage.User(
                                [
                                    'The conversation has grown too large for the context window and must be compacted now.',
                                    'Your task is to create a comprehensive, detailed summary of the entire conversation.',
                                    'IMPORTANT: Output your summary wrapped in <summary> and </summary> tags.',
                                    'Do NOT call any tools. Your ONLY task right now is to produce a comprehensive summary of the conversation so far.'
                                ].join('\n')
                            )
                        ],
                    manual ? undefined : 8,
                    { session: false }
                ).result;
                assert.equal(fixture.text(compacted), summaryResponse);
                fixture.failFastCapture();
                const summaryMessage =
                    `<conversation-summary>\n${summary}\n</conversation-summary>` +
                    (withReminder ?
                        '\n<reminderInstructions>Keep current tool execution requirements.</reminderInstructions>'
                    :   '');
                const resumedHistory = [
                    system,
                    vscode.LanguageModelChatMessage.User(summaryMessage),
                    vscode.LanguageModelChatMessage.User('continue after compaction')
                ];
                const resumed = await fixture.begin(resumedHistory, undefined, { session: false }).result;
                const next = await fixture.begin(
                    [
                        ...resumedHistory,
                        vscode.LanguageModelChatMessage.Assistant(fixture.replay(resumed)),
                        vscode.LanguageModelChatMessage.User('next')
                    ],
                    undefined,
                    { session: false }
                ).result;
                assert.equal(fixture.text(next), responseText);
                assert.deepEqual(
                    fixture.estimates.map(record => record.requestClassification?.requestOrigin),
                    ['copilot-chat', 'copilot-chat', 'copilot-chat', 'copilot-chat']
                );
                assert.deepEqual(
                    fixture.estimates.map(record => record.requestKind),
                    ['main-agent', 'summarization', 'main-agent', 'main-agent']
                );
                assert.deepEqual(
                    fixture.estimates.map(record => record.sessionRecoverySource),
                    [
                        'new-uuid',
                        manual ? 'history-bridge' : 'stateful-marker',
                        'summary-bridge-embedded',
                        'stateful-marker'
                    ]
                );
                assert.equal(new Set(fixture.estimates.map(record => record.sessionId)).size, 1);
                const observed = await fixture.mock.snapshot();
                assert.equal(observed.handshakes, 1);
                assert.equal(observed.full, 2);
                assert.equal(observed.delta, 1);
                assert.equal(observed.received, 3);
                assert.equal(observed.httpAccepted, 1);
                assert.deepEqual(observed.wireInputItems, [2, 3, 1]);
                assert.equal(fixture.updates.filter(update => update.status === 'completed').length, 4);
                assert.equal(fixture.counters().http, 1);
                assert.equal(fixture.counters().captures, 1);
                assert.equal((await fixture.close()).length, 1);
            } finally {
                await fixture.dispose();
            }
        });
    }

    for (const quotation of [false, true]) {
        test(`WS-LOOP-18: pending Chat compaction cannot capture ${quotation ? 'a quoted summary' : 'a new conversation'}`, async () => {
            const summary = `Summary for ${randomUUID()}: ` + 'Retain original decisions and results. '.repeat(12);
            const fixture = await createLiveResponsesFixture('text', {
                delta: true,
                useInstructions: false,
                httpResponseText: summary
            });
            try {
                const system = new vscode.LanguageModelChatMessage(
                    vscode.LanguageModelChatMessageRole.System,
                    COPILOT_CHAT_MAIN
                );
                const turn = quotation ? 200 : 100;
                const history = [system, vscode.LanguageModelChatMessage.User('original conversation')];
                const first = await fixture.begin(history, turn, { session: false }).result;
                await fixture.begin(
                    [
                        ...history,
                        vscode.LanguageModelChatMessage.Assistant(fixture.replay(first)),
                        vscode.LanguageModelChatMessage.User(
                            [
                                'The conversation has grown too large for the context window and must be compacted now.',
                                'Your task is to create a comprehensive, detailed summary of the entire conversation.',
                                'IMPORTANT: Output your summary wrapped in <summary> and </summary> tags.',
                                'Do NOT call any tools. Your ONLY task right now is to produce a comprehensive summary of the conversation so far.'
                            ].join('\n')
                        )
                    ],
                    turn,
                    { session: false }
                ).result;
                fixture.failFastCapture();
                await fixture.begin(
                    [
                        system,
                        vscode.LanguageModelChatMessage.User(
                            quotation ?
                                `Review this example without continuing its conversation:\n${summary}`
                            :   'A new unrelated conversation.'
                        )
                    ],
                    turn,
                    { session: false }
                ).result;
                assert.equal(fixture.estimates[2].sessionRecoverySource, 'new-uuid');
                assert.notEqual(fixture.estimates[2].sessionId, fixture.estimates[0].sessionId);
                await fixture.begin(
                    [
                        system,
                        vscode.LanguageModelChatMessage.User(`<conversation-summary>${summary}</conversation-summary>`)
                    ],
                    undefined,
                    { session: false }
                ).result;
                assert.equal(fixture.estimates[3].sessionId, fixture.estimates[0].sessionId);
                assert.equal(fixture.estimates[3].sessionRecoverySource, 'summary-bridge-embedded');
                const observed = await fixture.mock.snapshot();
                assert.equal(observed.handshakes, 2);
                assert.equal(observed.received, 3);
                assert.equal(observed.httpAccepted, 1);
                assert.equal((await fixture.close()).length, 1);
            } finally {
                await fixture.dispose();
            }
        });
    }

    test('WS-LOOP-18: same provider mode switch and failed summary rollback rebuild full', async () => {
        const fixture = await createLiveResponsesFixture('text', { delta: true });
        const original = StreamReporter.prototype.flushAll;
        try {
            let history = fixture.history('first');
            const first = await fixture.begin(history, 1).result;
            history = [
                ...history,
                vscode.LanguageModelChatMessage.Assistant(fixture.replay(first)),
                vscode.LanguageModelChatMessage.User('next')
            ];
            fixture.configure({ useWebSocket: false });
            assert.equal(fixture.text(await fixture.begin(history, 2).result), 'mock HTTP response');
            fixture.configure({ useWebSocket: true });
            const restored = await fixture.begin(history, 3).result;
            history = [
                ...history,
                vscode.LanguageModelChatMessage.Assistant(fixture.replay(restored)),
                vscode.LanguageModelChatMessage.User('rollback context')
            ];
            StreamReporter.prototype.flushAll = function (...args) {
                const result = original.apply(this, args);
                if (args[2]) {
                    throw new Error('summary rebuild failed after terminal');
                }
                return result;
            };
            await assert.rejects(fixture.begin(fixture.history('adopted summary'), 4).result);
            StreamReporter.prototype.flushAll = original;
            const rollback = await fixture.begin(history, 5).result;
            await fixture.begin(
                [
                    ...history,
                    vscode.LanguageModelChatMessage.Assistant(fixture.replay(rollback)),
                    vscode.LanguageModelChatMessage.User('after rollback')
                ],
                6
            ).result;
            const observed = await fixture.mock.snapshot();
            assert.equal(observed.full, 4);
            assert.equal(observed.delta, 1);
            assert.equal(observed.httpAccepted, 1);
            assert.equal(observed.handshakes, 3);
            assert.equal(fixture.updates.length, 6);
            assert.equal(fixture.updates.filter(update => update.status === 'failed').length, 1);
            assert.equal((await fixture.close()).length, 1);
        } finally {
            StreamReporter.prototype.flushAll = original;
            await fixture.dispose();
        }
    });

    for (const outcome of ['failed', 'cancelled'] as const) {
        test(`WS-LOOP-18: ${outcome} Chat output cannot seed manual compaction history`, async () => {
            const responseText =
                `Incomplete ${randomUUID()}: ` + 'This response did not finish successfully. '.repeat(12);
            const fixture = await createLiveResponsesFixture('text', {
                delta: true,
                responseText,
                useInstructions: false
            });
            try {
                const first = fixture.begin(
                    [
                        new vscode.LanguageModelChatMessage(
                            vscode.LanguageModelChatMessageRole.System,
                            COPILOT_CHAT_MAIN
                        ),
                        vscode.LanguageModelChatMessage.User('first')
                    ],
                    undefined,
                    {
                        session: false,
                        report: part => {
                            if (part instanceof vscode.LanguageModelTextPart) {
                                if (outcome === 'cancelled') {
                                    first.cancel();
                                } else {
                                    throw new Error('consumer rejected assistant output');
                                }
                            }
                        }
                    }
                );
                await assert.rejects(first.result);
                assert.equal(fixture.text(first.parts), responseText);
                await fixture.begin(
                    [
                        new vscode.LanguageModelChatMessage(
                            vscode.LanguageModelChatMessageRole.System,
                            'Your task is to create a comprehensive, detailed summary of the entire conversation'
                        ),
                        vscode.LanguageModelChatMessage.Assistant(fixture.text(first.parts)),
                        vscode.LanguageModelChatMessage.User('Summarize the conversation history so far.')
                    ],
                    undefined,
                    { session: false }
                ).result;
                assert.equal(fixture.estimates[1].requestKind, 'summarization');
                assert.equal(fixture.estimates[1].sessionRecoverySource, 'new-uuid');
                assert.notEqual(fixture.estimates[1].sessionId, fixture.estimates[0].sessionId);
                assert.equal((await fixture.mock.snapshot()).httpAccepted, 1);
                assert.equal((await fixture.close()).length, 1);
            } finally {
                await fixture.dispose();
            }
        });
    }

    for (const variant of ['allowed', 'disabled', 'zero-budget', 'already-accepted'] as const) {
        test(`WS-LOOP-10: public old response rejection WS full retry ${variant}`, async () => {
            const fixture = await createLiveResponsesFixture(
                variant === 'already-accepted' ? 'reject-previous-after-created' : 'reject-previous',
                { delta: true, retryEnabled: variant !== 'disabled', retryAttempts: variant === 'zero-budget' ? 0 : 1 }
            );
            try {
                const history = fixture.history('first');
                const output = await fixture.begin(history, 1).result;
                const request = fixture.begin(
                    [
                        ...history,
                        vscode.LanguageModelChatMessage.Assistant(fixture.replay(output)),
                        vscode.LanguageModelChatMessage.User('next')
                    ],
                    2
                );
                if (variant === 'allowed') {
                    assert.equal(fixture.text(await request.result), 'mock response');
                } else {
                    await assert.rejects(request.result);
                }
                const observed = await fixture.mock.snapshot();
                assert.equal(observed.received, variant === 'allowed' ? 3 : 2);
                assert.equal(observed.accepted, variant === 'allowed' ? 2 : 1);
                assert.equal(observed.handshakes, variant === 'allowed' ? 2 : 1);
                assert.equal(observed.httpAccepted, 0);
                assert.equal(observed.full, variant === 'allowed' ? 2 : 1);
                assert.deepEqual(observed.wireInputItems, variant === 'allowed' ? [1, 3] : [1]);
                assert.equal(observed.contextChecks, variant === 'allowed' ? 1 : 0);
                assert.equal(observed.contextErrors, 0);
                assert.equal(fixture.updates.length, 2);
                assert.equal(fixture.updates[1].status, variant === 'allowed' ? 'completed' : 'failed');
                assert.equal(fixture.provider.grants, variant === 'allowed' ? 3 : 2);
                assert.equal(fixture.counters().http, 0);
                assert.equal((await fixture.close()).length, 0);
            } finally {
                await fixture.dispose();
            }
        });
    }

    test('WS-LOOP-10: enabled retry cannot exceed an already exhausted shared budget', async () => {
        const fixture = await createLiveResponsesFixture('reject-upgrade-exhausted');
        try {
            await assert.rejects(fixture.begin(fixture.history('exhausted budget'), 1).result);
            const observed = await fixture.mock.snapshot();
            assert.equal(observed.handshakes, 2);
            assert.equal(observed.accepted, 0);
            assert.equal(observed.httpAccepted, 0);
            assert.equal(fixture.provider.grants, 2);
            assert.equal(fixture.updates.length, 1);
            assert.equal(fixture.updates[0].status, 'failed');
            assert.equal((await fixture.close()).length, 0);
        } finally {
            await fixture.dispose();
        }
    });

    test('WS-LOOP-06: public credential A B A automatically revokes old connections', async () => {
        const fixture = await createLiveResponsesFixture('text', { delta: true });
        try {
            let history = fixture.history('first');
            for (const [index, alternate] of [false, true, false].entries()) {
                await fixture.credential(alternate);
                const parts = await fixture.begin(history, index + 1).result;
                history = [
                    ...history,
                    vscode.LanguageModelChatMessage.Assistant(fixture.replay(parts)),
                    vscode.LanguageModelChatMessage.User('next')
                ];
            }
            const observed = await fixture.mock.snapshot();
            assert.equal(observed.handshakes, 3);
            assert.equal(observed.full, 3);
            assert.equal(observed.delta, 0);
            assert.equal((await fixture.close()).length, 0);
        } finally {
            await fixture.dispose();
        }
    });

    for (const change of ['configuration', 'credential-notification'] as const) {
        test(`WS-LOOP-06: public ${change} A B A without an intermediate request revokes state`, async () => {
            const fixture = await createLiveResponsesFixture('text', { delta: true });
            try {
                const history = fixture.history('first');
                const output = await fixture.begin(history, 1).result;
                if (change === 'configuration') {
                    fixture.configure({ endpoint: '/alternate' });
                    fixture.configure({ endpoint: '/responses' });
                } else {
                    await fixture.credential(true);
                    fixture.provider.invalidateAndNotify();
                    await fixture.credential(false);
                    fixture.provider.invalidateAndNotify();
                }
                await fixture.begin(
                    [
                        ...history,
                        vscode.LanguageModelChatMessage.Assistant(fixture.replay(output)),
                        vscode.LanguageModelChatMessage.User('next')
                    ],
                    2
                ).result;
                const observed = await fixture.mock.snapshot();
                assert.equal(observed.handshakes, 2);
                assert.equal(observed.full, 2);
                assert.equal(observed.delta, 0);
                assert.equal((await fixture.close()).length, 0);
            } finally {
                await fixture.dispose();
            }
        });
    }

    for (const route of ['endpoint', 'model', 'proxy'] as const) {
        test(`WS-LOOP-06: public overlapping ${route} change retires the old generation`, async () => {
            const fixture = await createLiveResponsesFixture('paused', {
                delta: true,
                network: { proxy: 'forward' },
                productionRouting: true
            });
            try {
                const history = fixture.history('first');
                const first = fixture.begin(history, 1);
                await fixture.mock.waitFor({ accepted: 1, pendingResponses: 1 });
                fixture.configure(
                    route === 'endpoint' ? { endpoint: '/alternate' }
                    : route === 'model' ? { model: 'mock-alternate' }
                    : { proxy: fixture.mock.proxyUrl }
                );
                const second = fixture.begin(fixture.history('other route'), 2);
                await fixture.mock.waitFor({ accepted: 2, pendingResponses: 2 });
                await fixture.mock.releasePending();
                const output = await first.result;
                await second.result;
                fixture.configure(
                    route === 'endpoint' ? { endpoint: '/responses' }
                    : route === 'model' ? { model: undefined }
                    : { proxy: 'noproxy' }
                );
                const third = fixture.begin(
                    [
                        ...history,
                        vscode.LanguageModelChatMessage.Assistant(fixture.replay(output)),
                        vscode.LanguageModelChatMessage.User('back to original')
                    ],
                    3
                );
                await fixture.mock.waitFor({ accepted: 3, pendingResponses: 1 });
                await fixture.mock.releasePending();
                await third.result;
                const observed = await fixture.mock.snapshot();
                assert.equal(observed.handshakes, 3);
                assert.equal(observed.full, 3);
                assert.equal(observed.delta, 0);
                assert.equal(observed.httpAccepted, 0);
                assert.equal((await fixture.close()).length, 0);
            } finally {
                await fixture.dispose();
            }
        });
    }

    for (const delta of [false, true]) {
        test(`WS-LOOP-04: public parallel tools preserve complete context, delta=${delta}`, async () => {
            const fixture = await createLiveResponsesFixture('parallel-tools', { delta });
            try {
                const history = fixture.history('first');
                const output = await fixture.begin(history, 1).result;
                const calls = output.filter(part => part instanceof vscode.LanguageModelToolCallPart);
                assert.deepEqual(
                    calls.map(part => ({ id: part.callId, input: part.input })),
                    [
                        { id: 'call-A', input: { key: 'A' } },
                        { id: 'call-B', input: { key: 'B' } }
                    ]
                );
                const next = [
                    ...history,
                    vscode.LanguageModelChatMessage.Assistant(fixture.replay(output)),
                    vscode.LanguageModelChatMessage.User(
                        calls.map(
                            (part, index) =>
                                new vscode.LanguageModelToolResultPart(part.callId, [
                                    new vscode.LanguageModelTextPart(`result-${['A', 'B'][index]}`)
                                ])
                        )
                    )
                ];
                assert.equal(fixture.text(await fixture.begin(next, 1).result), 'mock response');
                const observed = await fixture.mock.snapshot();
                assert.equal(observed.contextChecks, 2);
                assert.equal(observed.contextErrors, 0);
                assert.equal(observed.handshakes, 1);
                assert.equal(observed.delta, delta ? 1 : 0);
                assert.deepEqual(observed.wireInputItems, delta ? [1, 2] : [1, 5]);
                assert.equal((await fixture.close()).length, 0);
            } finally {
                await fixture.dispose();
            }
        });
    }

    for (const boundary of ['flush-failure', 'cancel-before-commit'] as const) {
        test(`WS-LOOP-08: public terminal ${boundary} cannot publish checkpoint`, async () => {
            const fixture = await createLiveResponsesFixture('text', { delta: true });
            fixture.configure({ tokenPricing: { inputPrice: 1, outputPrice: 2 } });
            const originalFlush = StreamReporter.prototype.flushAll;
            const originalConsume = OpenAIResponsesStreamProcessor.prototype.consume;
            let terminalReached = false;
            let cancel = () => {};
            try {
                if (boundary === 'flush-failure') {
                    StreamReporter.prototype.flushAll = function (...args) {
                        const result = originalFlush.apply(this, args);
                        if (args[2]) {
                            terminalReached = true;
                            throw new Error('injected terminal flush failure');
                        }
                        return result;
                    };
                } else {
                    OpenAIResponsesStreamProcessor.prototype.consume = async function (...args) {
                        await originalConsume.apply(this, args);
                        assert.equal(this.isResponseFinalized(), true);
                        terminalReached = true;
                        cancel();
                    };
                }
                const history = fixture.history('first');
                const request = fixture.begin(history, 1);
                cancel = request.cancel;
                await assert.rejects(request.result);
                assert.equal(terminalReached, true);
                assert.equal(fixture.updates.length, 1);
                assert.equal(fixture.updates[0].status, boundary === 'flush-failure' ? 'failed' : 'cancelled');
                assert.deepEqual(fixture.updates[0].rawUsage, {
                    input_tokens: 2,
                    output_tokens: 1,
                    total_tokens: 3
                });
                assert.equal(fixture.updates[0].estimatedCost, 4 / 1_000_000);
                assert.ok(fixture.updates[0].costBreakdown);
                StreamReporter.prototype.flushAll = originalFlush;
                OpenAIResponsesStreamProcessor.prototype.consume = originalConsume;
                const next = [
                    ...history,
                    vscode.LanguageModelChatMessage.Assistant(fixture.replay(request.parts)),
                    vscode.LanguageModelChatMessage.User('next')
                ];
                await fixture.begin(next, 2).result;
                const observed = await fixture.mock.snapshot();
                assert.equal(observed.full, 2);
                assert.equal(observed.delta, 0);
                assert.equal(observed.handshakes, 2);
                assert.equal((await fixture.close()).length, 0);
            } finally {
                StreamReporter.prototype.flushAll = originalFlush;
                OpenAIResponsesStreamProcessor.prototype.consume = originalConsume;
                await fixture.dispose();
            }
        });
    }

    test('WS-LOOP-16: distinct known usage survives terminal failure and later unknown usage', async () => {
        const fixture = await createLiveResponsesFixture('usage-sequence');
        const original = StreamReporter.prototype.flushAll;
        try {
            await fixture.begin(fixture.history('first'), 1).result;
            StreamReporter.prototype.flushAll = function (...args) {
                const result = original.apply(this, args);
                if (args[2]) {
                    throw new Error('injected failure after known usage');
                }
                return result;
            };
            await assert.rejects(fixture.begin(fixture.history('second'), 2).result);
            StreamReporter.prototype.flushAll = original;
            await assert.rejects(fixture.begin(fixture.history('third'), 3).result);
            assert.deepEqual(
                fixture.updates.map(update => ({ status: update.status, usage: update.rawUsage })),
                [
                    { status: 'completed', usage: { input_tokens: 11, output_tokens: 3, total_tokens: 14 } },
                    { status: 'failed', usage: { input_tokens: 22, output_tokens: 6, total_tokens: 28 } },
                    { status: 'failed', usage: undefined }
                ]
            );
            assert.equal(new Set(fixture.updates.map(update => update.requestId)).size, 3);
            assert.equal((await fixture.mock.snapshot()).received, 3);
            assert.equal(fixture.provider.grants, 3);
            assert.equal((await fixture.close()).length, 0);
        } finally {
            StreamReporter.prototype.flushAll = original;
            await fixture.dispose();
        }
    });

    test('WS-LOOP-16: upstream cancellation preserves usage and cost without replay', async () => {
        const fixture = await createLiveResponsesFixture('cancelled', { delta: true });
        fixture.configure({ tokenPricing: { inputPrice: 1, outputPrice: 2 } });
        try {
            await assert.rejects(fixture.begin(fixture.history('first'), 1).result);
            assert.equal(fixture.estimates.length, 1);
            assert.equal(fixture.updates.length, 1);
            assert.equal(fixture.updates[0].requestId, 'live-request-1');
            assert.equal(fixture.updates[0].status, 'failed');
            assert.deepEqual(fixture.updates[0].rawUsage, {
                input_tokens: 2,
                output_tokens: 1,
                total_tokens: 3
            });
            assert.equal(fixture.updates[0].estimatedCost, 4 / 1_000_000);
            assert.ok(fixture.updates[0].costBreakdown);
            assert.equal(fixture.provider.grants, 1);
            const observed = await fixture.mock.snapshot();
            assert.equal(observed.received, 1);
            assert.equal(observed.accepted, 1);
            assert.equal(observed.handshakes, 1);
            assert.equal(observed.httpAccepted, 0);
            assert.equal(fixture.counters().http, 0);
            assert.equal((await fixture.close()).length, 0);
        } finally {
            await fixture.dispose();
        }
    });

    test('WS-LOOP-09: public accepted request closes before first frame without replay', async () => {
        const fixture = await createLiveResponsesFixture('accepted-close');
        try {
            const request = fixture.begin(fixture.history('accepted without a response frame'), 1);
            await assert.rejects(request.result);
            const observed = await fixture.mock.snapshot();
            assert.equal(observed.accepted, 1);
            assert.equal(observed.received, 1);
            assert.equal(observed.sent, 0);
            assert.equal(observed.handshakes, 1);
            assert.equal(observed.httpAccepted, 0);
            assert.equal(fixture.counters().http, 0);
            assert.equal(fixture.provider.grants, 1);
            assert.equal(fixture.estimates.length, 1);
            assert.equal(fixture.updates.length, 1);
            assert.equal(fixture.updates[0].status, 'failed');
            assert.equal(fixture.updates[0].rawUsage, undefined);
            assert.equal(request.parts.length, 0);
            assert.equal((await fixture.close()).length, 0);
        } finally {
            await fixture.dispose();
        }
    });

    test('WS-LOOP-16: WS handshake retries finalize one failed logical request', async () => {
        const fixture = await createLiveResponsesFixture('reject-upgrade');
        try {
            const request = fixture.begin(fixture.history('one logical request'), 1);
            await assert.rejects(request.result);
            fixture.assertNoMarkers(request.parts);
            assert.equal(fixture.provider.grants, 2);
            assert.equal(fixture.estimates.length, 1);
            assert.equal(fixture.updates.length, 1);
            assert.equal(fixture.updates[0].status, 'failed');
            assert.equal(fixture.updates[0].rawUsage, undefined);
            assert.equal(fixture.updates[0].requestId, 'live-request-1');
            const observed = await fixture.mock.snapshot();
            assert.equal(observed.handshakes, 2);
            assert.equal(observed.accepted, 0);
            assert.equal(observed.httpAccepted, 0);
            assert.equal(fixture.counters().http, 0);
            assert.equal((await fixture.close()).length, 0);
        } finally {
            await fixture.dispose();
        }
    });
});
