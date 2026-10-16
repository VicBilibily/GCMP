import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import test from 'node:test';

import { CustomDataPartMimeTypes } from '../types';

const require = createRequire(import.meta.url);
const NodeModule = require('node:module') as {
    prototype: {
        require: (id: string) => unknown;
    };
};

let vscodeMock!: {
    LanguageModelChatMessageRole: { Assistant: string; System: string; User: string };
    LanguageModelThinkingPart: new (
        value: string | string[],
        id?: string,
        metadata?: Record<string, unknown>
    ) => unknown;
    LanguageModelTextPart: new (value: string) => unknown;
    LanguageModelToolCallPart: new (...args: unknown[]) => unknown;
    LanguageModelToolResultPart: new (...args: unknown[]) => unknown;
};

function encodeStatefulMarkerForTest(marker: Record<string, unknown>): Uint8Array {
    return new TextEncoder().encode(
        `claude-haiku-4.5\\json:${Buffer.from(
            JSON.stringify({
                extension: 'vicanent.gcmp',
                provider: 'anthropic',
                modelId: 'claude-haiku-4.5',
                sessionId: 'session',
                responseId: 'response',
                sdkMode: 'anthropic',
                ...marker
            }),
            'utf-8'
        ).toString('base64url')}`
    );
}

let converterModulePromise:
    | Promise<{
          apiMessageToAnthropicMessage: typeof import('./anthropicConverter').apiMessageToAnthropicMessage;
      }>
    | undefined;

async function getConverterModule() {
    if (converterModulePromise) {
        return converterModulePromise;
    }

    vscodeMock = {
        LanguageModelChatMessageRole: {
            Assistant: 'assistant',
            System: 'system',
            User: 'user'
        },
        LanguageModelThinkingPart: class {
            constructor(
                public value: string | string[],
                public id?: string,
                public metadata?: Record<string, unknown>
            ) {}
        },
        LanguageModelTextPart: class {
            constructor(public value: string) {}
        },
        LanguageModelToolCallPart: class {},
        LanguageModelToolResultPart: class {}
    };

    const originalRequire = NodeModule.prototype.require;
    NodeModule.prototype.require = function (id: string): unknown {
        if (id === 'vscode') {
            return vscodeMock;
        }
        if (id === '../../utils/runtime/logger' || id === '../utils/runtime/logger') {
            return {
                Logger: {
                    trace() {},
                    debug() {},
                    info() {},
                    warn() {},
                    error() {}
                }
            };
        }
        return originalRequire.call(this, id);
    };

    converterModulePromise = import('./anthropicConverter').finally(() => {
        NodeModule.prototype.require = originalRequire;
    });

    return converterModulePromise;
}

function makeModelConfig(model = 'claude-haiku-4.5') {
    return { id: `${model}-go`, provider: 'opencode', model } as never;
}

function getAssistantContent(result: { messages: { role: string; content: unknown }[] }): { type: string }[] {
    const assistant = result.messages.find(message => message.role === 'assistant');
    return assistant?.content as { type: string }[];
}

test('空 thinking 块不下发，避免上游 400（each thinking block must contain non-whitespace thinking）', async () => {
    const { apiMessageToAnthropicMessage } = await getConverterModule();
    const messages = [
        { role: 'user', content: [new vscodeMock.LanguageModelTextPart('hi')] },
        {
            role: 'assistant',
            content: [
                // value 空白且无 _completeThinking：旧实现 fallback 成单个空格，会被上游 400
                new vscodeMock.LanguageModelThinkingPart('', undefined, { signature: 'sig' }),
                new vscodeMock.LanguageModelTextPart('answer')
            ]
        }
    ];
    const result = apiMessageToAnthropicMessage(makeModelConfig(), messages as never);
    const blocks = getAssistantContent(result);
    assert.ok(!blocks.some(block => block.type === 'thinking'));
    assert.ok(blocks.some(block => block.type === 'text'));
});

test('空白 _completeThinking 与空白分片同样不下发', async () => {
    const { apiMessageToAnthropicMessage } = await getConverterModule();
    const messages = [
        {
            role: 'assistant',
            content: [
                new vscodeMock.LanguageModelThinkingPart(['   ', '  '], undefined, {
                    _completeThinking: '   ',
                    signature: 'sig'
                }),
                new vscodeMock.LanguageModelTextPart('answer')
            ]
        }
    ];
    const result = apiMessageToAnthropicMessage(makeModelConfig(), messages as never);
    assert.ok(!getAssistantContent(result).some(block => block.type === 'thinking'));
});

test('非空 thinking 块原样保留', async () => {
    const { apiMessageToAnthropicMessage } = await getConverterModule();
    const messages = [
        {
            role: 'assistant',
            content: [
                new vscodeMock.LanguageModelThinkingPart('', undefined, {
                    _completeThinking: '真实思考内容',
                    signature: 'sig'
                }),
                new vscodeMock.LanguageModelTextPart('answer')
            ]
        }
    ];
    const result = apiMessageToAnthropicMessage(makeModelConfig(), messages as never);
    const blocks = getAssistantContent(result);
    assert.deepEqual(blocks[0], { type: 'thinking', thinking: '真实思考内容', signature: 'sig' });
});

test('marker 恢复的空白 thinking 不下发；占位模型（DeepSeek V4）仍注入占位块', async () => {
    const { apiMessageToAnthropicMessage } = await getConverterModule();

    // marker 中 completeThinking 为全空白：不下发
    const blankMarkerMessages = [
        {
            role: 'assistant',
            content: [
                {
                    data: encodeStatefulMarkerForTest({ completeThinking: '   ', completeSignature: 'sig' }),
                    mimeType: CustomDataPartMimeTypes.StatefulMarker
                },
                new vscodeMock.LanguageModelTextPart('answer')
            ]
        }
    ];
    const blankResult = apiMessageToAnthropicMessage(makeModelConfig(), blankMarkerMessages as never);
    assert.ok(!getAssistantContent(blankResult).some(block => block.type === 'thinking'));

    // marker 中 completeThinking 非空白：恢复下发
    const realMarkerMessages = [
        {
            role: 'assistant',
            content: [
                {
                    data: encodeStatefulMarkerForTest({ completeThinking: 'marker 思考', completeSignature: 'sig' }),
                    mimeType: CustomDataPartMimeTypes.StatefulMarker
                },
                new vscodeMock.LanguageModelTextPart('answer')
            ]
        }
    ];
    const realResult = apiMessageToAnthropicMessage(makeModelConfig(), realMarkerMessages as never);
    assert.deepEqual(getAssistantContent(realResult)[0], {
        type: 'thinking',
        thinking: 'marker 思考',
        signature: 'sig'
    });

    // DeepSeek V4 兼容端点要求字段存在：占位块保持原有空白占位行为
    const placeholderMessages = [
        {
            role: 'assistant',
            content: [
                {
                    data: encodeStatefulMarkerForTest({ completeThinking: '' }),
                    mimeType: CustomDataPartMimeTypes.StatefulMarker
                },
                new vscodeMock.LanguageModelTextPart('answer')
            ]
        }
    ];
    const placeholderResult = apiMessageToAnthropicMessage(
        makeModelConfig('deepseek-v4-flash'),
        placeholderMessages as never
    );
    assert.deepEqual(getAssistantContent(placeholderResult)[0], {
        type: 'thinking',
        thinking: ' ',
        signature: ''
    });
});
