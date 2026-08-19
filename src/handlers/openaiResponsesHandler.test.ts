import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import test from 'node:test';

const require = createRequire(import.meta.url);
const NodeModule = require('node:module') as {
    prototype: {
        require: (id: string) => unknown;
    };
};

const loggerInfoCalls: string[] = [];
const updateActualTokensCalls: Array<Record<string, unknown>> = [];
const consumedStreams: unknown[] = [];

class MockStreamReporter {
    constructor(_options: unknown) {}

    reportUsage(_usage?: unknown, _costNanoAiu?: unknown): void {}

    getMetricStreamStartTime(): number | undefined {
        return undefined;
    }

    finishMetrics(): void {}
}

class MockOpenAIResponsesMessageConverter {
    constructor(_handler: unknown, _displayName: string) {}
}

class MockOpenAIResponsesRequestBuilder {
    constructor(_displayName: string, _messageConverter: unknown, _providerKey: string) {}

    build(): { requestBody: Record<string, unknown> } {
        return { requestBody: { model: 'test-model', input: [] } };
    }
}

class MockOpenAIResponsesStreamProcessor {
    constructor(_options: unknown) {}

    attach(): void {}

    async consume(stream: unknown): Promise<void> {
        consumedStreams.push(stream);
    }

    getFinalUsage(): { total_tokens: number } {
        return { total_tokens: 12 };
    }

    getFinishReason(): string {
        return 'length';
    }

    getStreamStartTime(): number {
        return 100;
    }

    getStreamEndTime(): number {
        return 200;
    }
}

let openAIResponsesHandlerModulePromise:
    | Promise<{
          OpenAIResponsesHandler: typeof import('./openaiResponsesHandler').OpenAIResponsesHandler;
      }>
    | undefined;

async function getOpenAIResponsesHandlerModule() {
    if (openAIResponsesHandlerModulePromise) {
        return openAIResponsesHandlerModulePromise;
    }

    const originalRequire = NodeModule.prototype.require;
    NodeModule.prototype.require = function (id: string): unknown {
        if (id === 'vscode') {
            return {
                env: { language: 'en' },
                CancellationError: class CancellationError extends Error {},
                LanguageModelError: class LanguageModelError extends Error {}
            };
        }
        if (id === './streamReporter') {
            return { StreamReporter: MockStreamReporter };
        }
        if (id === './openai/openaiResponsesMessageConverter') {
            return { OpenAIResponsesMessageConverter: MockOpenAIResponsesMessageConverter };
        }
        if (id === './openai/openaiResponsesRequestBuilder') {
            return { OpenAIResponsesRequestBuilder: MockOpenAIResponsesRequestBuilder };
        }
        if (id === './openai/openaiResponsesStreamProcessor') {
            return { OpenAIResponsesStreamProcessor: MockOpenAIResponsesStreamProcessor };
        }
        if (id === '../usages/usagesManager') {
            return {
                TokenUsagesManager: {
                    instance: {
                        updateActualTokens(params: Record<string, unknown>) {
                            updateActualTokensCalls.push(params);
                        }
                    }
                }
            };
        }
        if (id === '../utils/runtime/logger') {
            return {
                Logger: {
                    info(message: string) {
                        loggerInfoCalls.push(message);
                    },
                    debug() {},
                    error() {},
                    warn() {}
                }
            };
        }
        if (id === '../utils/text/cancellationError') {
            return { isCancellationError: () => false };
        }
        if (id === '../utils/text/formatUtils') {
            return { createOpenCodeHeaders: () => ({}) };
        }
        if (id === '../cli/auth/cliAuthFactory') {
            return { CliAuthFactory: { getInstance: () => undefined } };
        }
        if (id === '../cli/auth/codexCliAuth') {
            return { CodexCliAuth: class CodexCliAuth {} };
        }
        if (id === './liveMetrics') {
            return { emitLiveMetrics() {} };
        }
        if (id === './openaiHandler') {
            return { OpenAIHandler: class OpenAIHandler {} };
        }
        return originalRequire.call(this, id);
    };

    openAIResponsesHandlerModulePromise = import('./openaiResponsesHandler').finally(() => {
        NodeModule.prototype.require = originalRequire;
    });

    return openAIResponsesHandlerModulePromise;
}

test('handleResponsesRequest：透传 length finishReason 到完成链路', async () => {
    loggerInfoCalls.length = 0;
    updateActualTokensCalls.length = 0;
    consumedStreams.length = 0;

    const { OpenAIResponsesHandler } = await getOpenAIResponsesHandlerModule();
    const fakeStream = { tag: 'responses-stream' };
    const client = {
        _options: { defaultHeaders: {} as Record<string, string> },
        responses: {
            async create(_body: unknown, _options: unknown) {
                return fakeStream;
            }
        }
    };
    const handler = new OpenAIResponsesHandler(
        {
            provider: 'openai',
            providerConfig: { displayName: 'Test Provider' }
        } as never,
        {
            async createOpenAIClient() {
                return client;
            }
        } as never
    );

    await handler.handleResponsesRequest(
        { id: 'model-id', name: 'test-model' } as never,
        {} as never,
        [] as never,
        { modelConfiguration: {} } as never,
        { report() {} } as never,
        'request-1',
        'session-1',
        {
            isCancellationRequested: false,
            onCancellationRequested() {
                return { dispose() {} };
            }
        } as never,
        123
    );

    assert.deepEqual(consumedStreams, [fakeStream]);
    assert.equal(client._options.defaultHeaders.conversation_id, 'session-1');
    assert.equal(client._options.defaultHeaders.session_id, 'session-1');
    assert.equal(updateActualTokensCalls.length, 1);
    assert.deepEqual(
        {
            ...updateActualTokensCalls[0],
            requestMetricStartTime: undefined
        },
        {
            requestId: 'request-1',
            sessionId: 'session-1',
            rawUsage: { total_tokens: 12 },
            status: 'completed',
            requestMetricStartTime: undefined,
            wasThrottled: false,
            streamStartTime: 100,
            streamEndTime: 200,
            estimatedCost: undefined,
            costBreakdown: undefined
        }
    );
    assert.equal(typeof updateActualTokensCalls[0]?.requestMetricStartTime, 'number');
    assert.ok(loggerInfoCalls.includes('📊 test-model Responses API request completed with finish reason: length'));
});
