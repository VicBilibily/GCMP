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
            extraBody: { reasoning: { effort: 'medium' } }
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
            extraBody: { reasoning: { effort: 'medium' } }
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

test('跨 provider 的密文不会回传', async () => {
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
            id: 'gpt-5.4',
            model: 'gpt-5.4',
            provider: 'openai',
            extraBody: { reasoning: { effort: 'medium' } }
        } as never,
        { provider: 'openai', modelId: 'gpt-5.4' }
    );

    assert.deepEqual(result.messages, []);
});
