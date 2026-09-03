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
    LanguageModelDataPart: new (data: Uint8Array, mimeType: string) => unknown;
    LanguageModelTextPart: new (value: string) => unknown;
};

function encodeStatefulMarkerForTest(modelId: string, marker: Record<string, unknown>): Uint8Array {
    return new TextEncoder().encode(
        `${modelId}\\json:${Buffer.from(JSON.stringify(marker), 'utf-8').toString('base64url')}`
    );
}

let converterModulePromise:
    | Promise<{
          OpenAIResponsesMessageConverter: typeof import('./openaiResponsesMessageConverter').OpenAIResponsesMessageConverter;
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
        LanguageModelDataPart: class {
            constructor(
                public data: Uint8Array,
                public mimeType: string
            ) {}
        },
        LanguageModelTextPart: class {
            constructor(public value: string) {}
        }
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

    converterModulePromise = import('./openaiResponsesMessageConverter').finally(() => {
        NodeModule.prototype.require = originalRequire;
    });

    return converterModulePromise;
}

function createThinkingPart(
    metadata: Record<string, unknown>
): InstanceType<typeof vscodeMock.LanguageModelThinkingPart> {
    return new vscodeMock.LanguageModelThinkingPart('摘要', undefined, metadata);
}

function createMarkerPart(marker: Record<string, unknown>) {
    const payload = encodeStatefulMarkerForTest('gpt-5.4', marker);
    return { data: payload, mimeType: CustomDataPartMimeTypes.StatefulMarker };
}

const handlerStub = {
    isImageMimeType: () => false,
    createDataUrl: () => ''
} as never;

const gptIncludeEnabled = {
    reasoning: { effort: 'medium' },
    include: ['reasoning.encrypted_content']
};

test('同源 ThinkingPart 密文会回传为 reasoning 项', async () => {
    const { OpenAIResponsesMessageConverter } = await getConverterModule();
    const converter = new OpenAIResponsesMessageConverter(handlerStub, 'Test');

    const result = converter.convertMessagesToOpenAIResponses(
        [
            {
                role: vscodeMock.LanguageModelChatMessageRole.Assistant,
                content: [
                    createThinkingPart({
                        redactedData: 'cipher-text',
                        reasoningId: 'rs_1',
                        provider: 'openai',
                        modelId: 'gpt-5.4'
                    })
                ]
            }
        ] as never,
        {
            id: 'gpt-5.4',
            model: 'gpt-5.4',
            provider: 'openai',
            extraBody: gptIncludeEnabled
        } as never,
        { provider: 'openai', modelId: 'gpt-5.4' }
    );

    assert.deepEqual(result.messages, [
        {
            type: 'reasoning',
            summary: [],
            encrypted_content: 'cipher-text',
            id: 'rs_1'
        }
    ]);
});

test('StatefulMarker 剥离后同 provider 跨模型仍可回传密文', async () => {
    const { OpenAIResponsesMessageConverter } = await getConverterModule();
    const converter = new OpenAIResponsesMessageConverter(handlerStub, 'Test');

    const result = converter.convertMessagesToOpenAIResponses(
        [
            {
                role: vscodeMock.LanguageModelChatMessageRole.Assistant,
                content: [
                    createMarkerPart({
                        sessionId: 's-1',
                        responseId: 'r-1',
                        provider: 'openai',
                        modelId: 'gpt-5.4',
                        sdkMode: 'openai-responses',
                        encryptedReasoning: [{ encryptedContent: 'cipher-marker', reasoningId: 'rs_marker' }]
                    })
                ]
            }
        ] as never,
        {
            id: 'gpt-5.6',
            model: 'gpt-5.6',
            provider: 'openai',
            extraBody: gptIncludeEnabled
        } as never,
        { provider: 'openai', modelId: 'gpt-5.6' }
    );

    assert.deepEqual(result.messages, [
        {
            type: 'reasoning',
            summary: [],
            encrypted_content: 'cipher-marker',
            id: 'rs_marker'
        }
    ]);
});

test('StatefulMarker 缺少 origin 元数据时仍应与同密文 ThinkingPart 合并去重', async () => {
    const { OpenAIResponsesMessageConverter } = await getConverterModule();
    const converter = new OpenAIResponsesMessageConverter(handlerStub, 'Test');

    const result = converter.convertMessagesToOpenAIResponses(
        [
            {
                role: vscodeMock.LanguageModelChatMessageRole.Assistant,
                content: [
                    createThinkingPart({
                        redactedData: 'cipher-text',
                        reasoningId: 'rs_1',
                        provider: 'openai',
                        modelId: 'gpt-5.4'
                    }),
                    createMarkerPart({
                        sessionId: 's-3',
                        responseId: 'r-3',
                        sdkMode: 'openai-responses',
                        encryptedReasoning: [{ encryptedContent: 'cipher-text', reasoningId: 'rs_1' }]
                    })
                ]
            }
        ] as never,
        {
            id: 'gpt-5.6',
            model: 'gpt-5.6',
            provider: 'openai',
            extraBody: gptIncludeEnabled
        } as never,
        { provider: 'openai', modelId: 'gpt-5.6' }
    );

    assert.deepEqual(result.messages, [
        {
            type: 'reasoning',
            summary: [],
            encrypted_content: 'cipher-text',
            id: 'rs_1'
        }
    ]);
});

test('GPT 当前请求不区分 provider', async () => {
    const { OpenAIResponsesMessageConverter } = await getConverterModule();
    const converter = new OpenAIResponsesMessageConverter(handlerStub, 'Test');

    const result = converter.convertMessagesToOpenAIResponses(
        [
            {
                role: vscodeMock.LanguageModelChatMessageRole.Assistant,
                content: [
                    createThinkingPart({
                        redactedData: 'cipher-text',
                        reasoningId: 'rs_1',
                        provider: 'anthropic',
                        modelId: 'claude-sonnet-4-5'
                    })
                ]
            }
        ] as never,
        {
            id: 'gpt-5.6',
            model: 'gpt-5.6',
            provider: 'commandcode',
            extraBody: gptIncludeEnabled
        } as never,
        { provider: 'commandcode', modelId: 'gpt-5.6' }
    );

    assert.deepEqual(result.messages, [
        {
            type: 'reasoning',
            summary: [],
            encrypted_content: 'cipher-text',
            id: 'rs_1'
        }
    ]);
});

test('非 GPT 同 provider 有密文则回传', async () => {
    const { OpenAIResponsesMessageConverter } = await getConverterModule();
    const converter = new OpenAIResponsesMessageConverter(handlerStub, 'Test');

    const result = converter.convertMessagesToOpenAIResponses(
        [
            {
                role: vscodeMock.LanguageModelChatMessageRole.Assistant,
                content: [
                    createThinkingPart({
                        redactedData: 'cipher-text',
                        reasoningId: 'rs_1',
                        provider: 'grok',
                        modelId: 'grok-4.6'
                    })
                ]
            }
        ] as never,
        {
            id: 'grok-4.6',
            model: 'grok-4.6',
            provider: 'grok'
        } as never,
        { provider: 'grok', modelId: 'grok-4.6' }
    );

    assert.deepEqual(result.messages, [
        {
            type: 'reasoning',
            summary: [],
            encrypted_content: 'cipher-text',
            id: 'rs_1'
        }
    ]);
});

test('非 GPT 跨 provider 的密文不会回传', async () => {
    const { OpenAIResponsesMessageConverter } = await getConverterModule();
    const converter = new OpenAIResponsesMessageConverter(handlerStub, 'Test');

    const result = converter.convertMessagesToOpenAIResponses(
        [
            {
                role: vscodeMock.LanguageModelChatMessageRole.Assistant,
                content: [
                    createThinkingPart({
                        redactedData: 'cipher-text',
                        reasoningId: 'rs_1',
                        provider: 'anthropic',
                        modelId: 'claude-sonnet-4-5'
                    }),
                    createMarkerPart({
                        sessionId: 's-2',
                        responseId: 'r-2',
                        provider: 'anthropic',
                        modelId: 'claude-sonnet-4-5',
                        sdkMode: 'openai-responses',
                        encryptedReasoning: [{ encryptedContent: 'cipher-marker', reasoningId: 'rs_marker' }]
                    })
                ]
            }
        ] as never,
        {
            id: 'grok-4.6',
            model: 'grok-4.6',
            provider: 'grok',
            extraBody: gptIncludeEnabled
        } as never,
        { provider: 'grok', modelId: 'grok-4.6' }
    );

    assert.deepEqual(result.messages, []);
});

test('GPT 未启用 include 时不回传密文', async () => {
    const { OpenAIResponsesMessageConverter } = await getConverterModule();
    const converter = new OpenAIResponsesMessageConverter(handlerStub, 'Test');

    const result = converter.convertMessagesToOpenAIResponses(
        [
            {
                role: vscodeMock.LanguageModelChatMessageRole.Assistant,
                content: [
                    createThinkingPart({
                        redactedData: 'cipher-text',
                        reasoningId: 'rs_1',
                        provider: 'openai',
                        modelId: 'gpt-5.4'
                    })
                ]
            }
        ] as never,
        {
            id: 'gpt-5.4',
            model: 'gpt-5.4',
            provider: 'openai',
            extraBody: { reasoning: { effort: 'medium' }, include: null }
        } as never,
        { provider: 'openai', modelId: 'gpt-5.4' }
    );

    assert.deepEqual(result.messages, []);
});
