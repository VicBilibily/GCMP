import assert from 'node:assert/strict';
import test from 'node:test';
import { ResponsesContinuationPlanner } from './responsesContinuationPlanner';
import { preprocessOpenAIResponsesInputItems } from '../openaiResponsesInputPreprocessor';

const user = (text: string) => ({ type: 'message', role: 'user', content: [{ type: 'input_text', text }] });
const assistant = (text: string) => ({
    type: 'message',
    role: 'assistant',
    status: 'completed',
    content: [{ type: 'output_text', text }]
});
const call = { type: 'function_call', call_id: 'tool-a', name: 'lookup', arguments: '{"id":1}', status: 'completed' };
const result = { type: 'function_call_output', call_id: 'tool-a', output: 'answer', status: 'completed' };

const stableParameters = Object.freeze({
    model: 'm',
    instructions: 'stable rules',
    tools: [{ type: 'function', name: 'lookup', parameters: { type: 'object', properties: {} } }],
    store: false,
    parallel_tool_calls: true
});

for (const turn of ['turn-a', 1, 0]) {
    test(`WS-LOOP-03: same turn ${JSON.stringify(turn)} preserves instructions and tools across tool continuations`, () => {
        const planner = new ResponsesContinuationPlanner();
        const firstBody = Object.freeze({ ...stableParameters, input: [user('first')] });
        const first = planner.plan(firstBody, 1, true, turn);
        assert.equal(first.mode, 'full');
        assert.strictEqual(first.body, firstBody);
        assert.equal(
            planner.commit(first, { type: 'response.completed', responseId: 'r1', output: [call] }, true),
            true
        );
        const secondBody = Object.freeze({ ...stableParameters, input: [user('first'), call, result] });
        const second = planner.plan(secondBody, 1, true, turn);
        assert.equal(second.previousResponseId, 'r1');
        assert.equal(second.body.instructions, stableParameters.instructions);
        assert.strictEqual(second.body.tools, stableParameters.tools);
        assert.deepEqual(second.body, { ...stableParameters, input: [result] });
        assert.strictEqual(second.fullBody, secondBody);
        assert.equal(second.fullBody.instructions, stableParameters.instructions);
        assert.strictEqual(second.fullBody.tools, stableParameters.tools);
        const secondCall = { ...call, call_id: 'tool-b' };
        const secondResult = { ...result, call_id: 'tool-b' };
        assert.equal(
            planner.commit(second, { type: 'response.completed', responseId: 'r2', output: [secondCall] }, true),
            true
        );
        const thirdBody = { ...stableParameters, input: [...secondBody.input, secondCall, secondResult] };
        const third = planner.plan(thirdBody, 1, true, turn);
        assert.equal(third.previousResponseId, 'r2');
        assert.deepEqual(third.body.input, [secondResult]);
        assert.equal(third.body.instructions, stableParameters.instructions);
        assert.strictEqual(third.body.tools, stableParameters.tools);
        assert.equal(
            planner.commit(third, { type: 'response.completed', responseId: 'r3', output: [assistant('done')] }, true),
            true
        );
        const next = planner.plan(
            { ...stableParameters, input: [...thirdBody.input, assistant('done'), user('next turn')] },
            1,
            true,
            'turn-next'
        );
        assert.equal(next.mode, 'delta');
        assert.equal(next.previousResponseId, 'r3');
        assert.deepEqual(next.body.input, [user('next turn')]);
        assert.equal(next.body.instructions, stableParameters.instructions);
        assert.strictEqual(next.body.tools, stableParameters.tools);
    });
}

for (const [name, previousTurn, currentTurn] of [
    ['both-missing', undefined, undefined],
    ['previous-missing', undefined, 'turn-a'],
    ['current-missing', 'turn-a', undefined],
    ['different', 'turn-a', 'turn-b'],
    ['different-types', 1, '1'],
    ['empty', '', ''],
    ['blank', ' ', ' '],
    ['infinite', Infinity, Infinity],
    ['nan', NaN, NaN]
] as const) {
    test(`WS-LOOP-03: ${name} turn preserves instructions and tools on delta`, () => {
        const planner = new ResponsesContinuationPlanner();
        const first = planner.plan({ ...stableParameters, input: [user('first')] }, 1, true, previousTurn);
        assert.equal(
            planner.commit(first, { type: 'response.completed', responseId: 'r1', output: [call] }, true),
            true
        );
        const next = planner.plan({ ...stableParameters, input: [user('first'), call, result] }, 1, true, currentTurn);
        assert.equal(next.mode, 'delta');
        assert.equal(next.previousResponseId, 'r1');
        assert.deepEqual(next.body.input, [result]);
        assert.equal(next.body.instructions, stableParameters.instructions);
        assert.strictEqual(next.body.tools, stableParameters.tools);
    });
}

for (const reason of ['generation', 'disabled', 'invalidated', 'prefix', 'instructions', 'tools']) {
    test(`WS-LOOP-03: same turn full request after ${reason} preserves all supplied parameters`, () => {
        const planner = new ResponsesContinuationPlanner();
        const first = planner.plan({ ...stableParameters, input: [user('first')] }, 1, true, 'turn-a');
        assert.equal(
            planner.commit(first, { type: 'response.completed', responseId: 'r1', output: [call] }, true),
            true
        );
        if (reason === 'invalidated') {
            planner.invalidate();
        }
        const body = {
            ...stableParameters,
            instructions: reason === 'instructions' ? 'new rules' : stableParameters.instructions,
            tools: reason === 'tools' ? [] : stableParameters.tools,
            input: [user(reason === 'prefix' ? 'edited' : 'first'), call, result]
        };
        const next = planner.plan(body, reason === 'generation' ? 2 : 1, reason !== 'disabled', 'turn-a');
        assert.equal(next.mode, 'full');
        assert.equal(next.previousResponseId, undefined);
        assert.strictEqual(next.body, body);
        assert.strictEqual(next.fullBody, body);
    });
}

test('WS-LOOP-03: incomplete streamed output cannot commit an input-only checkpoint', () => {
    const planner = new ResponsesContinuationPlanner();
    const first = planner.plan({ model: 'm', input: [user('first')] }, 1, true);
    assert.equal(
        planner.commit(
            first,
            { type: 'response.completed', responseId: 'response_partial', output: [], outputComplete: false },
            true
        ),
        false
    );
    assert.equal(planner.diagnostics().lastCommitReason, 'incomplete-output');
    const input = [user('first'), assistant('before tool'), call, result];
    const next = planner.plan({ model: 'm', input }, 1, true);
    assert.equal(next.mode, 'full');
    assert.equal(next.previousResponseId, undefined);
    assert.deepEqual(next.body.input, input);
});

for (const reason of [
    'no-checkpoint',
    'delta-disabled',
    'generation-changed',
    'semantics-changed',
    'input-truncated',
    'prefix-changed',
    'pending-results',
    'pending-calls',
    'no-new-input',
    'verified-prefix'
]) {
    test(`WS-LOOP-03: continuation diagnostics distinguish ${reason}`, () => {
        const planner = new ResponsesContinuationPlanner();
        const first = planner.plan({ model: 'm', input: [user('first')], instructions: 'private rules' }, 1, true);
        if (reason !== 'no-checkpoint') {
            assert.equal(
                planner.commit(
                    first,
                    {
                        type: 'response.completed',
                        responseId: 'private-response-id',
                        output: reason === 'pending-results' ? [call] : [assistant('done')]
                    },
                    true
                ),
                true
            );
        }
        const input =
            reason === 'input-truncated' ? [user('first')]
            : reason === 'no-new-input' ? [user('first'), assistant('done')]
            : reason === 'pending-results' ? [user('first'), call, user('next')]
            : reason === 'pending-calls' ? [user('first'), assistant('done'), call]
            : [user(reason === 'prefix-changed' ? 'edited' : 'first'), assistant('done'), user('next')];
        const body = {
            model: 'm',
            input,
            instructions: reason === 'semantics-changed' ? 'new rules' : 'private rules'
        };
        const next = planner.plan(body, reason === 'generation-changed' ? 2 : 1, reason !== 'delta-disabled');
        assert.equal(next.reason, reason);
        assert.equal(next.mode, reason === 'verified-prefix' ? 'delta' : 'full');
        assert.deepEqual(next.body.input, reason === 'verified-prefix' ? [user('next')] : input);
        assert.equal(next.previousResponseId, reason === 'verified-prefix' ? 'private-response-id' : undefined);
        assert.equal(next.body.instructions, body.instructions);
    });
}

test('WS-LOOP-03: checkpoint diagnostics report rejection and success without response content', () => {
    const planner = new ResponsesContinuationPlanner();
    const first = planner.plan({ model: 'm', input: [user('private prompt')] }, 1, true);
    assert.equal(
        planner.commit(
            first,
            {
                type: 'response.completed',
                responseId: 'private-response-id',
                output: [{ type: 'compaction', encrypted_content: 'private cipher' }]
            },
            true
        ),
        false
    );
    assert.deepEqual(planner.diagnostics(), {
        contextEpoch: 1,
        checkpointVersion: 2,
        hasCheckpoint: false,
        lastCommitReason: 'unsupported-output'
    });
    const next = planner.plan({ model: 'm', input: [user('private prompt')] }, 1, true);
    assert.equal(
        planner.commit(next, { type: 'response.completed', responseId: 'private-response-id', output: [] }, true),
        true
    );
    assert.deepEqual(planner.diagnostics(), {
        contextEpoch: 1,
        checkpointVersion: 4,
        hasCheckpoint: true,
        lastCommitReason: 'committed'
    });
});

for (const reason of [
    'stale-plan',
    'invalid-input',
    'stale-lease',
    'missing-receipt',
    'incomplete-response',
    'unsupported-input',
    'pending-calls-limit'
]) {
    test(`WS-LOOP-03: checkpoint diagnostics distinguish ${reason}`, () => {
        const planner = new ResponsesContinuationPlanner();
        const first = planner.plan(
            {
                model: 'm',
                input:
                    reason === 'unsupported-input' ?
                        [{ type: 'compaction', encrypted_content: 'private cipher' }]
                    :   [user('private prompt')]
            },
            1,
            true
        );
        if (reason === 'stale-plan') {
            planner.invalidate();
        }
        assert.equal(
            planner.commit(
                reason === 'invalid-input' ? { ...first, fullBody: { model: 'm', input: 'invalid' } } : first,
                reason === 'missing-receipt' ? undefined : (
                    {
                        type: reason === 'incomplete-response' ? 'response.incomplete' : 'response.completed',
                        responseId: 'private-response-id',
                        output: reason === 'pending-calls-limit' ? [{ ...call, call_id: 'x'.repeat(256 * 1024) }] : []
                    }
                ),
                reason !== 'stale-lease'
            ),
            false
        );
        assert.equal(planner.diagnostics().lastCommitReason, reason);
        assert.equal(planner.diagnostics().hasCheckpoint, false);
    });
}

test('WS-LOOP-03: full then verified tool delta then cross-turn text delta', () => {
    const planner = new ResponsesContinuationPlanner();
    const first = planner.plan({ model: 'm', input: [user('first')], store: false }, 1, true);
    assert.equal(first.mode, 'full');
    assert.equal(
        planner.commit(
            first,
            { type: 'response.completed', responseId: 'r1', output: [{ ...call, id: 'server-item' }] },
            true
        ),
        true
    );
    const second = planner.plan({ model: 'm', input: [user('first'), call, result], store: false }, 1, true);
    assert.equal(second.previousResponseId, 'r1');
    assert.deepEqual(second.body.input, [result]);
    assert.equal(
        planner.commit(second, { type: 'response.completed', responseId: 'r2', output: [assistant('done')] }, true),
        true
    );
    const third = planner.plan(
        { model: 'm', input: [user('first'), call, result, assistant('done'), user('next turn')], store: false },
        1,
        true
    );
    assert.equal(third.previousResponseId, 'r2');
    assert.deepEqual(third.body.input, [user('next turn')]);
});

test('WS-LOOP-03: retained encrypted reasoning continues with only new tool results and messages', () => {
    const planner = new ResponsesContinuationPlanner();
    const reasoning = { type: 'reasoning', id: 'rs_one', summary: [], encrypted_content: 'synthetic-cipher' };
    const firstInput = [user('first')];
    const first = planner.plan({ model: 'm', input: firstInput }, 1, true);
    assert.equal(
        planner.commit(
            first,
            {
                type: 'response.completed',
                responseId: 'r1',
                output: [
                    { ...reasoning, summary: [{ type: 'summary_text', text: 'visible summary' }], status: 'completed' },
                    { ...call, id: 'fc_one', arguments: '{ "id": 1 }' }
                ]
            },
            true
        ),
        true
    );
    const secondInput = [...firstInput, reasoning, call, result];
    const second = planner.plan({ model: 'm', input: secondInput }, 1, true);
    assert.equal(second.mode, 'delta');
    assert.equal(second.previousResponseId, 'r1');
    assert.deepEqual(second.body.input, [result]);
    assert.equal(
        planner.commit(second, { type: 'response.completed', responseId: 'r2', output: [assistant('done')] }, true),
        true
    );
    const third = planner.plan({ model: 'm', input: [...secondInput, assistant('done'), user('next')] }, 1, true);
    assert.equal(third.mode, 'delta');
    assert.equal(third.previousResponseId, 'r2');
    assert.deepEqual(third.body.input, [user('next')]);
});

test('WS-LOOP-03: JSON argument roundtrip formatting does not force a full request', () => {
    const planner = new ResponsesContinuationPlanner();
    const first = planner.plan({ model: 'm', input: [user('first')] }, 1, true);
    assert.equal(
        planner.commit(
            first,
            { type: 'response.completed', responseId: 'r1', output: [{ ...call, arguments: '{\n  "id": 1\n}' }] },
            true
        ),
        true
    );
    const next = planner.plan({ model: 'm', input: [user('first'), call, result] }, 1, true);
    assert.equal(next.previousResponseId, 'r1');
    assert.deepEqual(next.body.input, [result]);
});

for (const sample of [
    { name: 'file-range', output: '{"filePath":"synthetic.ts","startLine":1,"endLine":20}' },
    { name: 'nested-object', output: '{"query":{"z":1,"a":2},"mode":"read"}' },
    { name: 'array-objects', output: '{"items":[{"z":1,"a":2},{"z":3,"a":4}]}' },
    { name: 'changed-value', output: '{"query":{"z":1,"a":2}}', replay: '{"query":{"a":2,"z":5}}' },
    {
        name: 'changed-array-order',
        output: '{"items":[{"z":1,"a":2},{"z":3,"a":4}]}',
        replay: '{"items":[{"a":4,"z":3},{"a":2,"z":1}]}'
    }
]) {
    test(`WS-LOOP-03: real argument preprocessing ${sample.name} preserves semantic matching`, () => {
        const planner = new ResponsesContinuationPlanner();
        const reasoning = { type: 'reasoning', id: 'rs_order', summary: [], encrypted_content: 'synthetic-cipher' };
        const first = planner.plan({ model: 'm', input: [user('first')] }, 1, true);
        assert.equal(
            planner.commit(
                first,
                {
                    type: 'response.completed',
                    responseId: 'first-response',
                    output: [reasoning, assistant('before tool'), { ...call, arguments: sample.output }]
                },
                true
            ),
            true
        );
        const input = [
            user('first'),
            reasoning,
            assistant('before tool'),
            { ...call, arguments: sample.replay ?? sample.output },
            result
        ];
        preprocessOpenAIResponsesInputItems(input);
        const next = planner.plan({ model: 'm', input }, 1, true);
        assert.equal(next.mode, sample.replay ? 'full' : 'delta');
        assert.equal(next.previousResponseId, sample.replay ? undefined : 'first-response');
        assert.deepEqual(next.body.input, sample.replay ? input : [result]);
    });
}

test('WS-LOOP-03: assistant text roundtrip trimming preserves the checkpoint', () => {
    const planner = new ResponsesContinuationPlanner();
    const first = planner.plan({ model: 'm', input: [user('first')] }, 1, true);
    planner.commit(first, { type: 'response.completed', responseId: 'r1', output: [assistant(' answer\n')] }, true);
    const next = planner.plan({ model: 'm', input: [user('first'), assistant('answer'), user('next')] }, 1, true);
    assert.equal(next.previousResponseId, 'r1');
    assert.deepEqual(next.body.input, [user('next')]);
});

for (const variant of ['removed', 'cipher-changed', 'id-changed']) {
    test(`WS-LOOP-19: encrypted reasoning ${variant} rebuilds only the supplied history`, () => {
        const planner = new ResponsesContinuationPlanner();
        const reasoning = { type: 'reasoning', id: 'rs_one', summary: [], encrypted_content: 'synthetic-cipher' };
        const first = planner.plan({ model: 'm', input: [user('first')] }, 1, true);
        assert.equal(
            planner.commit(first, { type: 'response.completed', responseId: 'r1', output: [reasoning, call] }, true),
            true
        );
        const currentReasoning =
            variant === 'removed' ? []
            : variant === 'cipher-changed' ? [{ ...reasoning, encrypted_content: 'different-cipher' }]
            : [{ ...reasoning, id: 'rs_changed' }];
        const input = [user('first'), ...currentReasoning, call, result];
        const next = planner.plan({ model: 'm', input }, 1, true);
        assert.equal(next.mode, 'full');
        assert.equal(next.previousResponseId, undefined);
        assert.deepEqual(next.body.input, input);
        assert.equal(planner.diagnostics().hasCheckpoint, false);
    });
}

for (const argumentsJson of ['not-json', 'null', '[]']) {
    test(`WS-LOOP-03: invalid tool arguments ${argumentsJson} cannot publish a checkpoint`, () => {
        const planner = new ResponsesContinuationPlanner();
        const first = planner.plan({ model: 'm', input: [user('first')] }, 1, true);
        assert.equal(
            planner.commit(
                first,
                { type: 'response.completed', responseId: 'r1', output: [{ ...call, arguments: argumentsJson }] },
                true
            ),
            false
        );
        assert.equal(planner.diagnostics().hasCheckpoint, false);
    });
}

test('WS-LOOP-03: changed argument values cannot reuse a normalized checkpoint', () => {
    const planner = new ResponsesContinuationPlanner();
    const first = planner.plan({ model: 'm', input: [user('first')] }, 1, true);
    assert.equal(
        planner.commit(
            first,
            { type: 'response.completed', responseId: 'r1', output: [{ ...call, arguments: '{ "id": 1 }' }] },
            true
        ),
        true
    );
    const input = [user('first'), { ...call, arguments: '{"id":2}' }, result];
    const next = planner.plan({ model: 'm', input }, 1, true);
    assert.equal(next.mode, 'full');
    assert.equal(next.previousResponseId, undefined);
    assert.deepEqual(next.body.input, input);
});

for (const variant of ['edit', 'instructions', 'generation', 'disabled', 'native-state']) {
    test(`WS-LOOP-05: ${variant} never reuses an invalid predecessor`, () => {
        const planner = new ResponsesContinuationPlanner();
        const first = planner.plan({ model: 'm', input: [user('first')], instructions: '' }, 1, true);
        planner.commit(
            first,
            {
                type: 'response.completed',
                responseId: 'r1',
                output:
                    variant === 'native-state' ?
                        [{ type: 'compaction', encrypted_content: 'synthetic' }]
                    :   [assistant('done')]
            },
            true
        );
        const next = planner.plan(
            {
                model: 'm',
                input: [user(variant === 'edit' ? 'edited' : 'first'), assistant('done'), user('next')],
                instructions: variant === 'instructions' ? null : ''
            },
            variant === 'generation' ? 2 : 1,
            variant !== 'disabled'
        );
        assert.equal(next.mode, 'full');
        assert.equal(next.previousResponseId, undefined);
    });
}

test('WS-LOOP-18: adopted summary invalidates old candidate and establishes new epoch', () => {
    const planner = new ResponsesContinuationPlanner();
    const old = planner.plan({ model: 'm', input: [user('old history')] }, 1, true);
    planner.commit(old, { type: 'response.completed', responseId: 'old', output: [assistant('old output')] }, true);
    const compressed = planner.plan({ model: 'm', input: [user('adopted summary')] }, 1, true);
    assert.equal(compressed.mode, 'full');
    assert.deepEqual(compressed.body.input, [user('adopted summary')]);
    assert.equal(compressed.previousResponseId, undefined);
    assert.equal(compressed.contextEpoch, 1);
    assert.equal(planner.commit(old, { type: 'response.completed', responseId: 'late-old', output: [] }, true), false);
    planner.commit(
        compressed,
        { type: 'response.completed', responseId: 'new', output: [assistant('new output')] },
        true
    );
    const next = planner.plan(
        { model: 'm', input: [user('adopted summary'), assistant('new output'), user('next')] },
        1,
        true
    );
    assert.equal(next.previousResponseId, 'new');
});

test('WS-LOOP-08: consumer failure or stale lease cannot publish checkpoint', () => {
    const planner = new ResponsesContinuationPlanner();
    const first = planner.plan({ model: 'm', input: [user('first')] }, 1, true);
    assert.equal(
        planner.commit(first, { type: 'response.completed', responseId: 'r1', output: [assistant('done')] }, false),
        false
    );
    assert.equal(planner.diagnostics().hasCheckpoint, false);
});

test('WS-LOOP-08: incomplete delta invalidates the old predecessor', () => {
    const planner = new ResponsesContinuationPlanner();
    const first = planner.plan({ model: 'm', input: [user('first')] }, 1, true);
    planner.commit(first, { type: 'response.completed', responseId: 'r1', output: [assistant('done')] }, true);
    const second = planner.plan({ model: 'm', input: [user('first'), assistant('done'), user('second')] }, 1, true);
    assert.equal(second.mode, 'delta');
    assert.equal(
        planner.commit(second, { type: 'response.incomplete', responseId: 'r2', output: [assistant('partial')] }, true),
        false
    );
    const third = planner.plan(
        { model: 'm', input: [user('first'), assistant('done'), user('second'), assistant('partial'), user('third')] },
        1,
        true
    );
    assert.equal(third.mode, 'full');
    assert.equal(third.previousResponseId, undefined);
});

test('WS-LOOP-19: native compaction input remains full and cannot establish delta eligibility', () => {
    const planner = new ResponsesContinuationPlanner();
    const state = { type: 'compaction', encrypted_content: 'synthetic' };
    const first = planner.plan({ model: 'm', input: [state, user('first')] }, 1, true);
    assert.equal(
        planner.commit(first, { type: 'response.completed', responseId: 'r1', output: [assistant('done')] }, true),
        false
    );
    const second = planner.plan(
        { model: 'm', input: [state, user('first'), assistant('done'), user('next')] },
        1,
        true
    );
    assert.equal(second.mode, 'full');
    assert.equal(second.previousResponseId, undefined);
});

for (const input of [[result], [call, result, result]]) {
    test(`WS-LOOP-04: invalid tool closure length=${input.length}`, () => {
        const planner = new ResponsesContinuationPlanner();
        assert.throws(() => planner.plan({ model: 'm', input }, 1, true), /MissingReplayContext/);
    });
}

for (const key of ['tools', 'instructions', 'temperature', 'service_tier', 'store', 'include']) {
    test(`WS-LOOP-05: semantic change ${key} rebuilds full context`, () => {
        const planner = new ResponsesContinuationPlanner();
        const first = planner.plan({ model: 'm', input: [user('first')] }, 1, true);
        planner.commit(first, { type: 'response.completed', responseId: 'old', output: [assistant('done')] }, true);
        const input = [user('first'), assistant('done'), user('next')];
        const next = planner.plan(
            { model: 'm', input, [key]: key === 'tools' ? [{ type: 'function', name: 'changed' }] : 'changed' },
            1,
            true
        );
        assert.equal(next.mode, 'full');
        assert.equal(next.previousResponseId, undefined);
        assert.deepEqual(next.body.input, input);
        assert.equal(
            planner.commit(first, { type: 'response.completed', responseId: 'late', output: [] }, true),
            false
        );
    });
}

test('WS-LOOP-04: parallel tool results close every call before delta', () => {
    const planner = new ResponsesContinuationPlanner();
    const secondCall = { ...call, call_id: 'tool-b' };
    const secondResult = { ...result, call_id: 'tool-b', output: 'second answer' };
    const first = planner.plan({ model: 'm', input: [user('first')] }, 1, true);
    assert.equal(
        planner.commit(first, { type: 'response.completed', responseId: 'r1', output: [call, secondCall] }, true),
        true
    );
    const input = [user('first'), call, secondCall, secondResult, result];
    const next = planner.plan({ model: 'm', input }, 1, true);
    assert.equal(next.mode, 'delta');
    assert.deepEqual(next.body.input, [secondResult, result]);
});

for (const variant of ['missing-result', 'duplicate-call', 'wrong-call-id', 'duplicate-result'] as const) {
    test(`WS-LOOP-04: parallel tool closure ${variant} never invents delta state`, () => {
        const planner = new ResponsesContinuationPlanner();
        const other = { ...call, call_id: 'tool-b' };
        const first = planner.plan({ model: 'm', input: [user('first')] }, 1, true);
        planner.commit(first, { type: 'response.completed', responseId: 'r1', output: [call, other] }, true);
        const input = [
            user('first'),
            call,
            other,
            result,
            ...(variant === 'duplicate-call' ? [call]
            : variant === 'duplicate-result' ? [result]
            : variant === 'wrong-call-id' ? [{ ...result, call_id: 'wrong' }]
            : [])
        ];
        if (variant === 'missing-result') {
            const plan = planner.plan({ model: 'm', input }, 1, true);
            assert.equal(plan.mode, 'full');
            assert.deepEqual(plan.body.input, input);
        } else {
            assert.throws(() => planner.plan({ model: 'm', input }, 1, true), /MissingReplayContext/);
        }
    });
}

for (const type of ['custom_tool_call', 'reasoning', 'compaction']) {
    test(`WS-LOOP-19: unsupported native ${type} is preserved in full without delta eligibility`, () => {
        const planner = new ResponsesContinuationPlanner();
        const state = { type, encrypted_content: 'synthetic-state', input: 'synthetic-custom-input' };
        const body = { model: 'm', input: [state, user('first')] };
        const first = planner.plan(body, 1, true);
        assert.deepEqual(first.body, body);
        assert.equal(
            planner.commit(first, { type: 'response.completed', responseId: 'r1', output: [assistant('done')] }, true),
            false
        );
        assert.equal(
            planner.plan({ ...body, input: [...body.input, assistant('done'), user('next')] }, 1, true).mode,
            'full'
        );
        const outputOnly = planner.plan({ model: 'm', input: [user('first')] }, 1, true);
        assert.equal(
            planner.commit(
                outputOnly,
                { type: 'response.completed', responseId: 'opaque-output', output: [state] },
                true
            ),
            false
        );
        assert.equal(planner.diagnostics().hasCheckpoint, false);
    });
}

for (const input of [undefined, null, 'missing context']) {
    test(`WS-LOOP-19: missing full input ${String(input)} is rejected rather than reconstructed`, () => {
        const planner = new ResponsesContinuationPlanner();
        const first = planner.plan({ model: 'm', input: [user('first')] }, 1, true);
        planner.commit(first, { type: 'response.completed', responseId: 'r1', output: [assistant('done')] }, true);
        assert.throws(() => planner.plan({ model: 'm', input }, 1, true), /MissingReplayContext/);
    });
}

for (const variant of ['unadopted', 'rollback', 'disabled', 'failed-rebuild', 'new-generation'] as const) {
    test(`WS-LOOP-18: summary ${variant} respects the context epoch`, () => {
        const planner = new ResponsesContinuationPlanner();
        const originalInput = [user('history')];
        const first = planner.plan({ model: 'm', input: originalInput }, 1, true);
        planner.commit(first, { type: 'response.completed', responseId: 'old', output: [assistant('answer')] }, true);
        const continuation = [user('history'), assistant('answer'), user('next')];
        if (variant === 'unadopted') {
            assert.equal(planner.plan({ model: 'm', input: continuation }, 1, true).previousResponseId, 'old');
            return;
        }
        const summary = planner.plan(
            { model: 'm', input: [user('summary')] },
            variant === 'new-generation' ? 2 : 1,
            variant !== 'disabled'
        );
        assert.equal(summary.mode, 'full');
        assert.equal(
            planner.commit(first, { type: 'response.completed', responseId: 'stale', output: [] }, true),
            false
        );
        if (variant === 'failed-rebuild') {
            assert.equal(planner.commit(summary, undefined, true), false);
        } else {
            assert.equal(
                planner.commit(
                    summary,
                    { type: 'response.completed', responseId: 'summary', output: [assistant('summary answer')] },
                    true
                ),
                true
            );
        }
        const nextInput =
            variant === 'rollback' || variant === 'failed-rebuild' ?
                continuation
            :   [user('summary'), assistant('summary answer'), user('next')];
        const next = planner.plan({ model: 'm', input: nextInput }, variant === 'new-generation' ? 2 : 1, true);
        assert.equal(next.mode, variant === 'rollback' || variant === 'failed-rebuild' ? 'full' : 'delta');
        assert.notEqual(next.previousResponseId, 'old');
    });
}
