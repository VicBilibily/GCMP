import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import test from 'node:test';
import { Stream } from 'openai/core/streaming';

const require = createRequire(import.meta.url);
const nodeModule = require('node:module') as { prototype: { require(id: string): unknown } };
const originalRequire = nodeModule.prototype.require;
nodeModule.prototype.require = function (id: string): unknown {
    return id === 'vscode' ? {} : originalRequire.call(this, id);
};
const modules = Promise.all([
    import('./openaiResponsesStreamProcessor'),
    import('./transport/responsePreprocessor')
]).finally(() => {
    nodeModule.prototype.require = originalRequire;
});

const message = (text: string) => ({
    id: 'msg',
    type: 'message',
    role: 'assistant',
    status: 'completed',
    content: [{ type: 'output_text', text, annotations: [] }]
});
const delta = (text: string) => ({
    type: 'response.output_text.delta',
    item_id: 'msg',
    output_index: 0,
    content_index: 0,
    delta: text
});
const completed = (text: string) => ({ type: 'response.completed', response: { id: 'resp', output: [message(text)] } });

async function consume(events: unknown[], output: string[] = []) {
    const [{ OpenAIResponsesStreamProcessor }] = await modules;
    const processor = new OpenAIResponsesStreamProcessor({
        modelName: 'test',
        displayName: 'test',
        sessionId: 'test',
        token: { isCancellationRequested: false } as never,
        abortController: new AbortController(),
        streamReporter: {
            heartbeat() {},
            markStreamStarted() {},
            flushAll() {
                return true;
            },
            reportText(text: string) {
                output.push(text);
            },
            get hasContent() {
                return output.length > 0;
            }
        } as never
    });
    processor.attach();
    await processor.consume(
        (async function* () {
            yield* events;
        })() as never
    );
    return output.join('');
}

for (const ending of ['', '\n', '\n\n']) {
    test(`integrity: EOF delimiter ${JSON.stringify(ending)}`, async () => {
        const [, { OpenAIResponsePreprocessor }] = await modules;
        const raw = `data: ${JSON.stringify(completed('answer'))}${ending}`;
        const response = await new OpenAIResponsePreprocessor(() => 'test').preprocessSSEResponse(
            new Response(raw, { headers: { 'content-type': 'text/event-stream' } })
        );
        const events = [];
        for await (const event of Stream.fromSSEResponse(response, new AbortController())) events.push(event);
        assert.equal(events.length, 1);
    });
}
test('integrity: incomplete JSON is rejected', async () => {
    const [, { OpenAIResponsePreprocessor }] = await modules;
    const response = await new OpenAIResponsePreprocessor(() => 'test').preprocessSSEResponse(
        new Response('data: {"type":', { headers: { 'content-type': 'text/event-stream' } })
    );
    await assert.rejects(async () => {
        const events = [];
        for await (const event of Stream.fromSSEResponse(response, new AbortController())) events.push(event);
        return events;
    }, SyntaxError);
});
for (const newline of ['\n', '\r\n', '\r']) {
    test(`integrity: bytewise UTF-8 and ${JSON.stringify(newline)} framing`, async () => {
        const [, { OpenAIResponsePreprocessor }] = await modules;
        const text = '\u4f60\u597d\ud83c\udf0d';
        const raw = `data: ${JSON.stringify(delta(text.slice(0, 1)))}${newline}${newline}data: ${JSON.stringify(completed(text))}`;
        const bytes = new TextEncoder().encode(raw);
        let offset = 0;
        const body = new ReadableStream<Uint8Array>({
            pull(controller) {
                if (offset < bytes.length) controller.enqueue(bytes.slice(offset, ++offset));
                else controller.close();
            }
        });
        const response = await new OpenAIResponsePreprocessor(() => 'test').preprocessSSEResponse(
            new Response(body, { headers: { 'content-type': 'text/event-stream' } })
        );
        const events = [];
        for await (const event of Stream.fromSSEResponse(response, new AbortController())) events.push(event);
        assert.equal(await consume(events), text);
    });
}
test('integrity: EOF without terminal rejects partial output', async () => {
    await assert.rejects(consume([delta('part')]), /terminal/i);
});
for (const source of ['text', 'item', 'completed']) {
    test(`integrity: ${source} repairs suffix once`, async () => {
        const snapshot =
            source === 'text' ?
                {
                    type: 'response.output_text.done',
                    item_id: 'msg',
                    output_index: 0,
                    content_index: 0,
                    text: 'partial answer'
                }
            :   { type: 'response.output_item.done', output_index: 0, item: message('partial answer') };
        assert.equal(
            await consume([
                delta('partial'),
                ...(source === 'completed' ? [] : [snapshot]),
                completed('partial answer')
            ]),
            'partial answer'
        );
    });
}
test('integrity: contradictory snapshot rejects', async () => {
    await assert.rejects(consume([delta('wrong'), completed('answer')]), /text.*mismatch/i);
});
test('integrity: completed-only text is delivered', async () => {
    assert.equal(await consume([completed('answer')]), 'answer');
});
test('integrity: empty delta cannot suppress final text', async () => {
    assert.equal(await consume([delta(''), completed('answer')]), 'answer');
});
test('integrity: content part snapshot repairs suffix', async () => {
    assert.equal(
        await consume([
            delta('an'),
            {
                type: 'response.content_part.done',
                item_id: 'msg',
                output_index: 0,
                content_index: 0,
                part: { type: 'output_text', text: 'answer' }
            },
            completed('answer')
        ]),
        'answer'
    );
});
test('integrity: multiple content parts remain independent', async () => {
    const item = message('first');
    item.content.push({ type: 'output_text', text: 'second', annotations: [] });
    assert.equal(
        await consume([
            delta('first'),
            { ...delta('sec'), content_index: 1 },
            {
                type: 'response.completed',
                response: { id: 'resp', output: [item] }
            }
        ]),
        'firstsecond'
    );
});
test('integrity: late suffix cannot be appended after another part', async () => {
    const item = message('first complete');
    item.content.push({ type: 'output_text', text: 'second', annotations: [] });
    await assert.rejects(
        consume([
            delta('first'),
            { ...delta('second'), content_index: 1 },
            {
                type: 'response.completed',
                response: { id: 'resp', output: [item] }
            }
        ]),
        /text.*mismatch/i
    );
});
test('integrity: different messages remain separated', async () => {
    assert.equal(
        await consume([
            delta('first'),
            {
                type: 'response.completed',
                response: { id: 'resp', output: [message('first'), { ...message('second'), id: 'msg2' }] }
            }
        ]),
        'first\n\nsecond'
    );
});
test('integrity: changed message identity is rejected', async () => {
    await assert.rejects(
        consume([
            delta('part'),
            {
                type: 'response.completed',
                response: { id: 'resp', output: [{ ...message('partial'), id: 'other' }] }
            }
        ]),
        /identity mismatch/i
    );
});

test('integrity: binding an index migrates every content part', async () => {
    const item = message('first');
    item.content.push({ type: 'output_text', text: 'second', annotations: [] });
    assert.equal(
        await consume([
            { ...delta('first'), output_index: undefined },
            { ...delta('sec'), output_index: undefined, content_index: 1 },
            { type: 'response.output_item.added', output_index: 0, item: { ...item, content: [] } },
            { type: 'response.output_text.done', item_id: 'msg', content_index: 1, text: 'second' },
            { type: 'response.completed', response: { id: 'resp', output: [item] } }
        ]),
        'firstsecond'
    );
});

test('integrity: unindexed delta uses known position to reject an earlier snapshot', async () => {
    const second = { ...message('second'), id: 'msg2' };
    await assert.rejects(
        consume([
            { type: 'response.output_item.added', output_index: 0, item: { ...message(''), content: [] } },
            { type: 'response.output_item.added', output_index: 1, item: { ...second, content: [] } },
            { ...delta('second'), item_id: 'msg2', output_index: undefined },
            { type: 'response.completed', response: { id: 'resp', output: [message('first'), second] } }
        ]),
        /out-of-order content/i
    );
});

test('integrity: unindexed deltas use known indices for paragraph separation', async () => {
    const second = { ...message('second'), id: 'msg2' };
    assert.equal(
        await consume([
            { type: 'response.output_item.added', output_index: 0, item: { ...message(''), content: [] } },
            { ...delta('first'), output_index: undefined },
            { type: 'response.output_item.added', output_index: 1, item: { ...second, content: [] } },
            { ...delta('second'), item_id: 'msg2', output_index: undefined },
            { type: 'response.completed', response: { id: 'resp', output: [message('first'), second] } }
        ]),
        'first\n\nsecond'
    );
});

test('integrity: migrated last part prevents appending an earlier missing part', async () => {
    const item = message('first');
    item.content.push({ type: 'output_text', text: 'second', annotations: [] });
    await assert.rejects(
        consume([
            { ...delta('second'), output_index: undefined, content_index: 1 },
            { type: 'response.output_item.added', output_index: 0, item: { ...item, content: [] } },
            { type: 'response.completed', response: { id: 'resp', output: [item] } }
        ]),
        /out-of-order content/i
    );
});

test('integrity: migrated message still separates the following message', async () => {
    const second = { ...message('second'), id: 'msg2' };
    assert.equal(
        await consume([
            { ...delta('first'), output_index: undefined },
            { type: 'response.output_item.added', output_index: 0, item: { ...message(''), content: [] } },
            { type: 'response.completed', response: { id: 'resp', output: [message('first'), second] } }
        ]),
        'first\n\nsecond'
    );
});

test('integrity: terminal binds later streamed message before filling earlier missing message', async () => {
    const output: string[] = [];
    const second = { ...message('second'), id: 'msg2' };
    await assert.rejects(
        consume(
            [
                { ...delta('second'), item_id: 'msg2', output_index: undefined },
                { type: 'response.completed', response: { id: 'resp', output: [message('first'), second] } }
            ],
            output
        ),
        /out-of-order content/i
    );
    assert.equal(output.join(''), 'second');
});

test('integrity: terminal-only binding permits suffix after an empty earlier message', async () => {
    const second = { ...message('second complete'), id: 'msg2' };
    assert.equal(
        await consume([
            { ...delta('second'), item_id: 'msg2', output_index: undefined },
            { type: 'response.completed', response: { id: 'resp', output: [message(''), second] } }
        ]),
        'second complete'
    );
});

test('integrity: terminal-only binding preserves separator before a new later message', async () => {
    const second = { ...message('second'), id: 'msg2' };
    assert.equal(
        await consume([
            { ...delta('first'), output_index: undefined },
            { type: 'response.completed', response: { id: 'resp', output: [message('first'), second] } }
        ]),
        'first\n\nsecond'
    );
});

for (const stage of ['done', 'delta']) {
    test(`integrity: compact terminal retains known message index after ${stage}`, async () => {
        const item = message('complete answer');
        assert.equal(
            await consume([
                { type: 'response.output_item.added', output_index: 0, item: { type: 'reasoning', id: 'reasoning' } },
                stage === 'done' ?
                    { type: 'response.output_item.done', output_index: 1, item }
                :   { ...delta('complete'), output_index: 1 },
                completed('complete answer')
            ]),
            'complete answer'
        );
    });
}

test('integrity: compact terminal cannot rebind later message to earlier message index', async () => {
    const second = { ...message('second complete'), id: 'msg2' };
    assert.equal(
        await consume([
            delta('first'),
            { ...delta('second'), item_id: 'msg2', output_index: 2 },
            { type: 'response.completed', response: { id: 'resp', output: [second] } }
        ]),
        'first\n\nsecond complete'
    );
});

test('integrity: repeated known message in compact terminal is rejected', async () => {
    const item = message('answer');
    await assert.rejects(
        consume([
            { ...delta('answer'), output_index: 2 },
            { type: 'response.completed', response: { id: 'resp', output: [item, item] } }
        ]),
        /identity mismatch/i
    );
});

test('integrity: unknown terminal message cannot claim a known message index', async () => {
    await assert.rejects(
        consume([
            { ...delta('answer'), output_index: 1 },
            {
                type: 'response.completed',
                response: { id: 'resp', output: [message('answer'), { ...message('foreign'), id: 'foreign' }] }
            }
        ]),
        /identity mismatch/i
    );
});
