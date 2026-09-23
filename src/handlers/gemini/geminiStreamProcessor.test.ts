import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
    GeminiStreamCancelledError,
    handleGeminiChunk,
    processGeminiJsonResponse,
    processGeminiStream,
    type GeminiStreamSink
} from './geminiStreamProcessor';

function createRecordingSink() {
    const events: { type: string; payload?: unknown }[] = [];
    const sink: GeminiStreamSink = {
        bufferThinking: (text: string) => events.push({ type: 'thinking', payload: text }),
        reportText: (text: string) => events.push({ type: 'text', payload: text }),
        accumulateToolCall: (index: number, id: string | undefined, name: string | undefined, args: string | undefined) =>
            events.push({ type: 'toolCall', payload: { index, id, name, args } }),
        flushToolCalls: (choiceIndex?: number) => events.push({ type: 'flushTools', payload: choiceIndex }),
        discardToolCalls: (choiceIndex?: number) => events.push({ type: 'discardTools', payload: choiceIndex }),
        setResponseId: (id: string) => events.push({ type: 'responseId', payload: id }),
        heartbeat: () => events.push({ type: 'heartbeat' }),
        markStreamStarted: (time: number) => events.push({ type: 'streamStarted', payload: time })
    };
    return { sink, events };
}

function streamFromString(text: string): ReadableStream<Uint8Array> {
    const encoder = new TextEncoder();
    return new ReadableStream<Uint8Array>({
        start(controller) {
            controller.enqueue(encoder.encode(text));
            controller.close();
        }
    });
}

describe('handleGeminiChunk', () => {
    it('普通文本 part 走 reportText', () => {
        const { sink, events } = createRecordingSink();
        const result = handleGeminiChunk(
            { candidates: [{ content: { role: 'model', parts: [{ text: 'Hello' }] } }] },
            sink
        );
        assert.equal(result.hasContent, true);
        assert.deepEqual(events.filter(e => e.type === 'text'), [{ type: 'text', payload: 'Hello' }]);
    });

    it('thought: true 的 part 走 bufferThinking', () => {
        const { sink, events } = createRecordingSink();
        handleGeminiChunk(
            { candidates: [{ content: { role: 'model', parts: [{ text: 'Let me think', thought: true }] } }] },
            sink
        );
        assert.deepEqual(events.filter(e => e.type === 'thinking'), [{ type: 'thinking', payload: 'Let me think' }]);
    });

    it('functionCall 完整累积并立即 flush（无 content_block_stop 语义）', () => {
        const { sink, events } = createRecordingSink();
        handleGeminiChunk(
            {
                candidates: [
                    {
                        content: {
                            role: 'model',
                            parts: [{ functionCall: { name: 'get_weather', args: { city: 'SZ' }, id: 'fc-1' } }]
                        }
                    }
                ]
            },
            sink
        );
        const toolCall = events.find(e => e.type === 'toolCall');
        const payload = toolCall?.payload as { index?: number; id?: string; name?: string; args?: string };
        assert.equal(payload.id, 'fc-1');
        assert.equal(payload.name, 'get_weather');
        assert.equal(payload.args, JSON.stringify({ city: 'SZ' }));
        assert.ok(events.some(e => e.type === 'flushTools'));
    });

    it('同名并行调用的签名按 functionCall.id 键控（仅带签名的 part 有签名）', () => {
        const { sink, events } = createRecordingSink();
        const toolSignatures: { key: string; signature: string }[] = [];
        sink.bufferToolCallSignature = (key: string, signature: string) => {
            toolSignatures.push({ key, signature });
        };
        handleGeminiChunk(
            {
                candidates: [
                    {
                        content: {
                            role: 'model',
                            parts: [
                                {
                                    functionCall: { name: 'get_weather', args: { city: 'SZ' }, id: 'fc-1' },
                                    thoughtSignature: 'sig-only-on-first'
                                },
                                { functionCall: { name: 'get_weather', args: { city: 'BJ' }, id: 'fc-2' } }
                            ]
                        }
                    }
                ]
            },
            sink
        );
        // 只有一个签名，且按 id 键控而非函数名（同名调用不共享签名）
        assert.deepEqual(toolSignatures, [{ key: 'fc-1', signature: 'sig-only-on-first' }]);
        const calls = events.filter(e => e.type === 'toolCall').map(e => e.payload as { id?: string });
        assert.deepEqual(
            calls.map(c => c.id),
            ['fc-1', 'fc-2']
        );
    });

    it('functionCall 无 id 时签名按函数名键控', () => {
        const { sink } = createRecordingSink();
        const toolSignatures: { key: string; signature: string }[] = [];
        sink.bufferToolCallSignature = (key: string, signature: string) => {
            toolSignatures.push({ key, signature });
        };
        handleGeminiChunk(
            {
                candidates: [
                    {
                        content: {
                            role: 'model',
                            parts: [
                                {
                                    functionCall: { name: 'get_weather', args: { city: 'SZ' } },
                                    thoughtSignature: 'fc-sig-1'
                                }
                            ]
                        }
                    }
                ]
            },
            sink
        );
        assert.deepEqual(toolSignatures, [{ key: 'get_weather', signature: 'fc-sig-1' }]);
    });

    it('finishReason STOP flush 工具调用', () => {
        const { sink, events } = createRecordingSink();
        handleGeminiChunk({ candidates: [{ finishReason: 'STOP' }] }, sink);
        assert.deepEqual(events.filter(e => e.type === 'flushTools'), [{ type: 'flushTools', payload: 0 }]);
    });

    it('finishReason MAX_TOKENS / SAFETY 丢弃工具调用', () => {
        for (const finishReason of ['MAX_TOKENS', 'SAFETY', 'RECITATION']) {
            const { sink, events } = createRecordingSink();
            handleGeminiChunk({ candidates: [{ finishReason }] }, sink);
            assert.deepEqual(events.filter(e => e.type === 'discardTools'), [
                { type: 'discardTools', payload: 0 }
            ], finishReason);
        }
    });

    it('usageMetadata 透传', () => {
        const { sink } = createRecordingSink();
        const result = handleGeminiChunk(
            { candidates: [{ finishReason: 'STOP' }], usageMetadata: { promptTokenCount: 1, totalTokenCount: 2 } },
            sink
        );
        assert.deepEqual(result.usage, { promptTokenCount: 1, totalTokenCount: 2 });
    });

    it('responseId 设置到 sink', () => {
        const { sink, events } = createRecordingSink();
        handleGeminiChunk({ responseId: 'resp-1', candidates: [] }, sink);
        assert.deepEqual(events.filter(e => e.type === 'responseId'), [{ type: 'responseId', payload: 'resp-1' }]);
    });

    it('thoughtSignature part 走 bufferSignature', () => {
        const { sink, events } = createRecordingSink();
        const signatures: string[] = [];
        sink.bufferSignature = sig => {
            signatures.push(sig);
            events.push({ type: 'signature', payload: sig });
        };
        handleGeminiChunk(
            {
                candidates: [
                    { content: { role: 'model', parts: [{ thoughtSignature: 'sig-1' }] }, finishReason: 'STOP' }
                ]
            },
            sink
        );
        assert.deepEqual(signatures, ['sig-1']);
    });

    it('text 与 thoughtSignature 同 part 时签名与文本都处理', () => {
        const { sink, events } = createRecordingSink();
        const signatures: string[] = [];
        sink.bufferSignature = sig => signatures.push(sig);
        handleGeminiChunk(
            {
                candidates: [
                    {
                        content: {
                            role: 'model',
                            parts: [{ text: 'Hello', thoughtSignature: 'sig-1' }]
                        },
                        finishReason: 'STOP'
                    }
                ]
            },
            sink
        );
        assert.deepEqual(signatures, ['sig-1']);
        assert.deepEqual(events.filter(e => e.type === 'text').map(e => e.payload), ['Hello']);
    });

    it('functionCall 上的 thoughtSignature 走 bufferToolCallSignature（不进思考签名缓冲）', () => {
        const { sink, events } = createRecordingSink();
        const toolSignatures: { name: string; signature: string }[] = [];
        let thinkingSignatureCount = 0;
        sink.bufferToolCallSignature = (name: string, signature: string) => {
            toolSignatures.push({ name, signature });
            events.push({ type: 'toolSignature', payload: { name, signature } });
        };
        sink.bufferSignature = () => {
            thinkingSignatureCount++;
        };
        handleGeminiChunk(
            {
                candidates: [
                    {
                        content: {
                            role: 'model',
                            parts: [
                                {
                                    functionCall: { name: 'get_weather', args: { city: 'SZ' } },
                                    thoughtSignature: 'fc-sig-1'
                                }
                            ]
                        }
                    }
                ]
            },
            sink
        );
        assert.deepEqual(toolSignatures, [{ name: 'get_weather', signature: 'fc-sig-1' }]);
        assert.equal(thinkingSignatureCount, 0);
    });

    it('并行工具调用（同帧多个 functionCall）分配唯一索引，参数不互相拼接', () => {
        const { sink, events } = createRecordingSink();
        handleGeminiChunk(
            {
                candidates: [
                    {
                        content: {
                            role: 'model',
                            parts: [
                                { functionCall: { name: 'get_weather', args: { city: 'SZ' } } },
                                { functionCall: { name: 'get_time', args: { zone: 'UTC' } } }
                            ]
                        }
                    }
                ]
            },
            sink
        );
        const calls = events.filter(e => e.type === 'toolCall').map(e => e.payload as { index: number; name: string; args: string });
        assert.equal(calls.length, 2);
        assert.deepEqual(
            calls.map(c => c.index),
            [0, 1]
        );
        assert.equal(calls[0].name, 'get_weather');
        assert.equal(calls[0].args, JSON.stringify({ city: 'SZ' }));
        assert.equal(calls[1].name, 'get_time');
        assert.equal(calls[1].args, JSON.stringify({ zone: 'UTC' }));
    });

    it('并行工具调用（跨帧 functionCall）共享 state，后续调用不被丢弃', async () => {
        const { sink, events } = createRecordingSink();
        const sse = [
            'data: {"candidates":[{"content":{"role":"model","parts":[{"functionCall":{"name":"get_weather","args":{"city":"SZ"}}}]}}]}',
            '',
            'data: {"candidates":[{"content":{"role":"model","parts":[{"functionCall":{"name":"get_time","args":{"zone":"UTC"}}}]}}]}',
            '',
            'data: {"candidates":[{"finishReason":"STOP"}]}',
            ''
        ].join('\n');

        await processGeminiStream(streamFromString(sse), sink, () => false);

        const calls = events.filter(e => e.type === 'toolCall').map(e => e.payload as { index: number; name: string });
        assert.equal(calls.length, 2);
        assert.deepEqual(
            calls.map(c => `${c.index}:${c.name}`),
            ['0:get_weather', '1:get_time']
        );
    });

    it('chunk.error 抛出错误', () => {
        const { sink } = createRecordingSink();
        assert.throws(
            () => handleGeminiChunk({ error: { message: 'boom', code: 500 } }, sink),
            /boom/
        );
    });
});

describe('processGeminiStream', () => {
    const neverCancelled = () => false;

    it('解析多帧 SSE 并聚合 usage', async () => {
        const { sink, events } = createRecordingSink();
        const sse = [
            'data: {"candidates":[{"content":{"role":"model","parts":[{"text":"Let me think","thought":true}]}}]}',
            '',
            'data: {"candidates":[{"content":{"role":"model","parts":[{"text":"Hi"}]}}]}',
            '',
            'data: {"candidates":[{"finishReason":"STOP"}],"usageMetadata":{"promptTokenCount":5,"candidatesTokenCount":3,"totalTokenCount":8}}',
            ''
        ].join('\n');

        const result = await processGeminiStream(streamFromString(sse), sink, neverCancelled);

        assert.equal(result.chunkCount, 3);
        assert.deepEqual(result.usage, { promptTokenCount: 5, candidatesTokenCount: 3, totalTokenCount: 8 });
        assert.notEqual(result.streamStartTime, undefined);

        const thinking = events.filter(e => e.type === 'thinking').map(e => e.payload);
        const texts = events.filter(e => e.type === 'text').map(e => e.payload);
        assert.deepEqual(thinking, ['Let me think']);
        assert.deepEqual(texts, ['Hi']);
        // 首个有效 chunk 固定首流时间
        assert.ok(events.some(e => e.type === 'streamStarted'));
    });

    it('支持 data: 后无空格的帧', async () => {
        const { sink, events } = createRecordingSink();
        const sse = 'data:{"candidates":[{"content":{"role":"model","parts":[{"text":"A"}]}}]}\n';
        await processGeminiStream(streamFromString(sse), sink, neverCancelled);
        assert.deepEqual(events.filter(e => e.type === 'text').map(e => e.payload), ['A']);
    });

    it('处理末尾无换行的最后一帧', async () => {
        const { sink, events } = createRecordingSink();
        const sse = 'data: {"candidates":[{"content":{"role":"model","parts":[{"text":"A"}]}}]}\n\ndata: {"candidates":[{"content":{"role":"model","parts":[{"text":"B"}]}}]}';
        const result = await processGeminiStream(streamFromString(sse), sink, neverCancelled);
        assert.equal(result.chunkCount, 2);
        assert.deepEqual(events.filter(e => e.type === 'text').map(e => e.payload), ['A', 'B']);
    });

    it('忽略非 JSON 行与空行', async () => {
        const { sink } = createRecordingSink();
        const sse = ': keepalive\n\ndata: not-json\n\ndata: {"candidates":[{"content":{"role":"model","parts":[{"text":"A"}]}}]}\n';
        const result = await processGeminiStream(streamFromString(sse), sink, neverCancelled);
        assert.equal(result.chunkCount, 1);
    });

    it('取消时抛出 GeminiStreamCancelledError', async () => {
        const { sink } = createRecordingSink();
        let calls = 0;
        const sse = 'data: {"candidates":[{"content":{"role":"model","parts":[{"text":"A"}]}}]}\n';
        await assert.rejects(
            processGeminiStream(streamFromString(sse), sink, () => ++calls > 0),
            GeminiStreamCancelledError
        );
    });
});

describe('processGeminiJsonResponse', () => {
    it('解析完整 JSON 响应', () => {
        const { sink, events } = createRecordingSink();
        const body = JSON.stringify({
            candidates: [
                {
                    content: { role: 'model', parts: [{ text: 'answer' }] },
                    finishReason: 'STOP'
                }
            ],
            usageMetadata: { promptTokenCount: 2, candidatesTokenCount: 1, totalTokenCount: 3 }
        });
        const result = processGeminiJsonResponse(body, sink);
        assert.equal(result.chunkCount, 1);
        assert.equal(result.usage?.totalTokenCount, 3);
        assert.deepEqual(events.filter(e => e.type === 'text').map(e => e.payload), ['answer']);
    });
});
