import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import test from 'node:test';

import { CustomDataPartMimeTypes } from '../types';
import { IMAGE_UNAVAILABLE_PLACEHOLDER, UNSUPPORTED_IMAGE_PLACEHOLDER } from '../imagePlaceholder';

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
          openAIImages: typeof import('./shared/images').openAIImages;
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
        if (id.endsWith('/utils/runtime/logger')) {
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

    converterModulePromise = import('./openaiResponsesMessageConverter')
        .then(async converter => ({
            ...converter,
            ...(await import('./shared/images'))
        }))
        .finally(() => {
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
    const payload = encodeStatefulMarkerForTest('gpt-5.4', { extension: 'vicanent.gcmp', ...marker });
    return { data: payload, mimeType: CustomDataPartMimeTypes.StatefulMarker };
}

const handlerStub = {
    isImageMimeType: () => false,
    createDataUrl: () => ''
} as never;

const toolImageHandler = {
    isImageMimeType: (mimeType: string) => mimeType.toLowerCase().trim().startsWith('image/'),
    createDataUrl: (part: { data: Uint8Array; mimeType: string }) =>
        `data:${part.mimeType};base64,${Buffer.from(part.data).toString('base64')}`
};

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

test('历史中重复 callId 被唯一化且 function_call_output 成对改写', async () => {
    const { OpenAIResponsesMessageConverter } = await getConverterModule();
    const converter = new OpenAIResponsesMessageConverter(handlerStub, 'Test');

    const result = converter.convertMessagesToOpenAIResponses(
        [
            {
                role: vscodeMock.LanguageModelChatMessageRole.Assistant,
                content: [{ callId: 'apply_patch:31', name: 'apply_patch', input: { a: 1 } }]
            },
            {
                role: vscodeMock.LanguageModelChatMessageRole.User,
                content: [{ callId: 'apply_patch:31', content: [{ value: 'done' }] }]
            },
            {
                role: vscodeMock.LanguageModelChatMessageRole.Assistant,
                content: [{ callId: 'apply_patch:31', name: 'apply_patch', input: { a: 2 } }]
            },
            {
                role: vscodeMock.LanguageModelChatMessageRole.User,
                content: [{ callId: 'apply_patch:31', content: [{ value: 'done' }] }]
            }
        ] as never,
        undefined,
        { provider: 'openai', modelId: 'gpt-5.4' }
    );

    assert.deepEqual(result.messages, [
        {
            type: 'function_call',
            call_id: 'apply_patch:31',
            name: 'apply_patch',
            arguments: '{"a":1}',
            status: 'completed'
        },
        {
            type: 'function_call_output',
            call_id: 'apply_patch:31',
            output: 'done',
            status: 'completed'
        },
        {
            type: 'function_call',
            call_id: 'apply_patch:31__gcmpDup2',
            name: 'apply_patch',
            arguments: '{"a":2}',
            status: 'completed'
        },
        {
            type: 'function_call_output',
            call_id: 'apply_patch:31__gcmpDup2',
            output: 'done',
            status: 'completed'
        }
    ]);

    const callIds = result.messages
        .filter(item => (item as { type?: string }).type === 'function_call')
        .map(item => (item as { call_id: string }).call_id);
    assert.equal(new Set(callIds).size, callIds.length);
});

test('工具结果图片在并行工具输出配对后作为关联 user 图片回传', async () => {
    const { OpenAIResponsesMessageConverter } = await getConverterModule();
    const imageBytes = Uint8Array.from([137, 80, 78, 71]);
    const imageUrl = `data:image/png;base64,${Buffer.from(imageBytes).toString('base64')}`;
    const converter = new OpenAIResponsesMessageConverter(
        {
            isImageMimeType: (mimeType: string) => mimeType === 'image/png',
            createDataUrl: (part: { data: Uint8Array; mimeType: string }) =>
                `data:${part.mimeType};base64,${Buffer.from(part.data).toString('base64')}`
        } as never,
        'Test'
    );

    const result = converter.convertMessagesToOpenAIResponses(
        [
            {
                role: vscodeMock.LanguageModelChatMessageRole.Assistant,
                content: [
                    { callId: 'view-1', name: 'capture', input: {} },
                    { callId: 'view-2', name: 'capture', input: {} }
                ]
            },
            {
                role: vscodeMock.LanguageModelChatMessageRole.User,
                content: [
                    {
                        callId: 'view-1',
                        content: [
                            { value: 'Screenshot follows' },
                            { data: imageBytes, mimeType: 'image/png' },
                            { value: 'End of screenshot' }
                        ]
                    }
                ]
            },
            {
                role: vscodeMock.LanguageModelChatMessageRole.User,
                content: [
                    {
                        callId: 'view-2',
                        content: [
                            { data: Uint8Array.from([1, 2, 3]), mimeType: 'application/x-internal' },
                            { value: 'second result' }
                        ]
                    }
                ]
            }
        ] as never,
        { capabilities: { imageInput: true } } as never,
        { provider: 'openai', modelId: 'gpt-5.4' }
    );

    assert.deepEqual(result.messages, [
        {
            type: 'function_call',
            call_id: 'view-1',
            name: 'capture',
            arguments: '{}',
            status: 'completed'
        },
        {
            type: 'function_call',
            call_id: 'view-2',
            name: 'capture',
            arguments: '{}',
            status: 'completed'
        },
        {
            type: 'function_call_output',
            call_id: 'view-1',
            output: 'Screenshot follows\n[Image]\nEnd of screenshot',
            status: 'completed'
        },
        {
            type: 'function_call_output',
            call_id: 'view-2',
            output: 'second result',
            status: 'completed'
        },
        {
            type: 'message',
            role: 'user',
            status: 'completed',
            content: [
                { type: 'input_text', text: 'Images associated with tool call "view-1":' },
                { type: 'input_image', image_url: imageUrl, detail: 'auto' }
            ]
        }
    ]);
});

test('非视觉 Responses 模型明确说明工具图片未投递', async () => {
    const { OpenAIResponsesMessageConverter } = await getConverterModule();
    const converter = new OpenAIResponsesMessageConverter(
        {
            isImageMimeType: (mimeType: string) => mimeType === 'image/png',
            createDataUrl: () => 'data:image/png;base64,'
        } as never,
        'Test'
    );

    const result = converter.convertMessagesToOpenAIResponses(
        [
            {
                role: vscodeMock.LanguageModelChatMessageRole.Assistant,
                content: [{ callId: 'view-1', name: 'capture', input: {} }]
            },
            {
                role: vscodeMock.LanguageModelChatMessageRole.User,
                content: [{ callId: 'view-1', content: [{ data: Uint8Array.from([1]), mimeType: 'image/png' }] }]
            }
        ] as never,
        { capabilities: { imageInput: false } } as never,
        { provider: 'openai', modelId: 'text-only' }
    );

    assert.deepEqual(result.messages, [
        {
            type: 'function_call',
            call_id: 'view-1',
            name: 'capture',
            arguments: '{}',
            status: 'completed'
        },
        {
            type: 'function_call_output',
            call_id: 'view-1',
            output: IMAGE_UNAVAILABLE_PLACEHOLDER,
            status: 'completed'
        }
    ]);
});

for (const [mimeType, imageInput] of [
    ['image/svg+xml', true],
    ['image/bmp', true],
    ['image/avif', true],
    [' IMAGE/HEIC ', true],
    ['image/avif', false],
    [' IMAGE/HEIC ', false]
] as const) {
    test(`Responses 工具结果中的 ${mimeType} 明确说明未投递: vision=${imageInput}`, async () => {
        const { OpenAIResponsesMessageConverter, openAIImages } = await getConverterModule();
        const converter = new OpenAIResponsesMessageConverter(openAIImages, 'Test');
        const result = converter.convertMessagesToOpenAIResponses(
            [
                {
                    role: vscodeMock.LanguageModelChatMessageRole.Assistant,
                    content: [{ callId: 'view-1', name: 'capture', input: {} }]
                },
                {
                    role: vscodeMock.LanguageModelChatMessageRole.User,
                    content: [
                        {
                            callId: 'view-1',
                            content: [{ value: 'before' }, { data: Uint8Array.from([1]), mimeType }, { value: 'after' }]
                        }
                    ]
                }
            ] as never,
            { capabilities: { imageInput } } as never,
            { provider: 'openai', modelId: 'vision' }
        );

        assert.equal(result.messages.length, 2);
        assert.deepEqual(result.messages[1], {
            type: 'function_call_output',
            call_id: 'view-1',
            output: `before\n${imageInput ? UNSUPPORTED_IMAGE_PLACEHOLDER : IMAGE_UNAVAILABLE_PLACEHOLDER}\nafter`,
            status: 'completed'
        });
    });
}

for (const [inputMime, outputMime] of [
    ['image/png', 'image/png'],
    ['image/jpeg', 'image/jpeg'],
    ['image/gif', 'image/gif'],
    ['image/webp', 'image/webp'],
    ['image/jpg', 'image/jpeg'],
    [' IMAGE/PNG ', 'image/png']
] as const) {
    test(`Responses 工具图片 ${inputMime} 使用规范 MIME ${outputMime}`, async () => {
        const { OpenAIResponsesMessageConverter } = await getConverterModule();
        const converter = new OpenAIResponsesMessageConverter(toolImageHandler, 'Test');
        const imagePart = { data: Uint8Array.from([1]), mimeType: inputMime };
        const result = converter.convertMessagesToOpenAIResponses(
            [
                {
                    role: vscodeMock.LanguageModelChatMessageRole.Assistant,
                    content: [{ callId: 'view-1', name: 'capture', input: {} }]
                },
                {
                    role: vscodeMock.LanguageModelChatMessageRole.User,
                    content: [{ callId: 'view-1', content: [imagePart] }]
                }
            ] as never,
            { capabilities: { imageInput: true } } as never,
            { provider: 'openai', modelId: 'vision' }
        );

        assert.deepEqual(result.messages[2], {
            type: 'message',
            role: 'user',
            status: 'completed',
            content: [
                { type: 'input_text', text: 'Images associated with tool call "view-1":' },
                { type: 'input_image', image_url: `data:${outputMime};base64,AQ==`, detail: 'auto' }
            ]
        });
        assert.equal(imagePart.mimeType, inputMime);
    });
}

for (const parallel of [false, true]) {
    test(`Responses 重复 call ID 的不同图片正确配对（并行=${parallel}）`, async () => {
        const { OpenAIResponsesMessageConverter } = await getConverterModule();
        const converter = new OpenAIResponsesMessageConverter(toolImageHandler, 'Test');
        const calls = [
            { callId: 'view-1', name: 'capture', input: { index: 1 } },
            { callId: 'view-1', name: 'capture', input: { index: 2 } }
        ];
        const outputs = [
            { callId: 'view-1', content: [{ data: Uint8Array.from([1]), mimeType: 'image/png' }] },
            { callId: 'view-1', content: [{ data: Uint8Array.from([2]), mimeType: 'image/webp' }] }
        ];
        const history =
            parallel ?
                [
                    { role: vscodeMock.LanguageModelChatMessageRole.Assistant, content: calls },
                    { role: vscodeMock.LanguageModelChatMessageRole.User, content: outputs }
                ]
            :   calls.flatMap((toolCall, index) => [
                    { role: vscodeMock.LanguageModelChatMessageRole.Assistant, content: [toolCall] },
                    { role: vscodeMock.LanguageModelChatMessageRole.User, content: [outputs[index]] }
                ]);
        const result = converter.convertMessagesToOpenAIResponses(
            history as never,
            { capabilities: { imageInput: true } } as never,
            { provider: 'openai', modelId: 'vision' }
        );

        assert.deepEqual(
            result.messages.filter(item => item.type === 'function_call_output').map(item => item.call_id),
            ['view-1', 'view-1__gcmpDup2']
        );
        assert.deepEqual(
            result.messages.filter(item => item.type === 'message'),
            [
                {
                    type: 'message',
                    role: 'user',
                    status: 'completed',
                    content: [
                        { type: 'input_text', text: 'Images associated with tool call "view-1":' },
                        { type: 'input_image', image_url: 'data:image/png;base64,AQ==', detail: 'auto' }
                    ]
                },
                {
                    type: 'message',
                    role: 'user',
                    status: 'completed',
                    content: [
                        { type: 'input_text', text: 'Images associated with tool call "view-1__gcmpDup2":' },
                        { type: 'input_image', image_url: 'data:image/webp;base64,Ag==', detail: 'auto' }
                    ]
                }
            ]
        );
    });
}

test('Responses 空工具图片明确说明无法投递且不产生图片消息', async () => {
    const { OpenAIResponsesMessageConverter } = await getConverterModule();
    const converter = new OpenAIResponsesMessageConverter(toolImageHandler, 'Test');
    const result = converter.convertMessagesToOpenAIResponses(
        [
            {
                role: vscodeMock.LanguageModelChatMessageRole.Assistant,
                content: [{ callId: 'empty', name: 'view_image', input: {} }]
            },
            {
                role: vscodeMock.LanguageModelChatMessageRole.User,
                content: [{ callId: 'empty', content: [{ data: new Uint8Array(), mimeType: 'image/png' }] }]
            }
        ] as never,
        { capabilities: { imageInput: true } } as never,
        { provider: 'openai', modelId: 'vision' }
    );
    assert.equal(result.messages.length, 2);
    assert.deepEqual(result.messages[1], {
        type: 'function_call_output',
        call_id: 'empty',
        output: UNSUPPORTED_IMAGE_PLACEHOLDER,
        status: 'completed'
    });
});
