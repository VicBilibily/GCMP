import assert from 'node:assert/strict';
import * as vscode from 'vscode';

import { OpenAICustomHandler } from '../../src/handlers/openaiCustomHandler';
import { StreamReporter } from '../../src/handlers/streamReporter';
import { TokenUsagesManager } from '../../src/usages/usagesManager';

interface StreamTestAccess {
    processStream(
        model: { name: string },
        body: ReadableStream<Uint8Array>,
        reporter: StreamReporter,
        requestId: string,
        token: vscode.CancellationToken,
        tokenPricing: undefined
    ): Promise<void>;
}

suite('OpenAI custom SSE lifecycle', () => {
    for (const ending of ['cancel-eof', 'cancel-chunk', 'error-frame', 'reader-error', 'success']) {
        test(`工具缓存完成与异常处理：${ending}`, async () => {
            const calls: vscode.LanguageModelToolCallPart[] = [];
            const source = new vscode.CancellationTokenSource();
            const reporter = new StreamReporter({
                modelName: 'test',
                modelId: 'test',
                provider: 'test',
                sdkMode: 'openai',
                progress: {
                    report(part) {
                        if (part instanceof vscode.LanguageModelToolCallPart) {
                            calls.push(part);
                        }
                    }
                }
            });
            const handler = Object.create(OpenAICustomHandler.prototype) as StreamTestAccess;
            const originalUpdate = TokenUsagesManager.instance.updateActualTokens;
            TokenUsagesManager.instance.updateActualTokens = () => {};
            const encode = (value: unknown) => new TextEncoder().encode(`data: ${JSON.stringify(value)}\n\n`);
            let readCount = 0;
            const body = new ReadableStream<Uint8Array>(
                {
                    pull(controller) {
                        if (readCount++ === 0) {
                            controller.enqueue(
                                encode({
                                    choices: [
                                        {
                                            index: 0,
                                            delta: {
                                                tool_calls: [
                                                    {
                                                        index: 0,
                                                        id: 'c',
                                                        function: { name: 'read_file', arguments: '{"path":"a.ts"}' }
                                                    }
                                                ]
                                            }
                                        }
                                    ]
                                })
                            );
                            return;
                        }
                        assert.equal(calls.length, 0);
                        if (ending.startsWith('cancel-')) {
                            source.cancel();
                        }
                        if (ending === 'reader-error') {
                            controller.error(new Error('reader failed'));
                            return;
                        }
                        if (ending === 'error-frame') {
                            controller.enqueue(encode({ error: { message: 'upstream failed' } }));
                        } else if (ending === 'success' || ending === 'cancel-chunk') {
                            controller.enqueue(new TextEncoder().encode('data: invalid-json\n\n'));
                            controller.enqueue(
                                encode({ choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] })
                            );
                        }
                        controller.close();
                    }
                },
                { highWaterMark: 0 }
            );
            try {
                const result = handler.processStream({ name: 'test' }, body, reporter, 'test', source.token, undefined);
                if (ending === 'success') {
                    await result;
                    assert.deepEqual(
                        calls.map(call => call.input),
                        [{ path: 'a.ts' }]
                    );
                } else {
                    await assert.rejects(result, (error: unknown) => {
                        assert.ok(error instanceof Error);
                        if (ending.startsWith('cancel-')) {
                            assert.ok(error instanceof vscode.CancellationError);
                        } else {
                            assert.equal(error.message, ending === 'error-frame' ? 'upstream failed' : 'reader failed');
                        }
                        return true;
                    });
                    reporter.flushAll(null);
                    assert.deepEqual(calls, []);
                }
                assert.equal(body.locked, false);
            } finally {
                TokenUsagesManager.instance.updateActualTokens = originalUpdate;
                source.dispose();
                reporter.finishMetrics();
            }
        });
    }
});
