import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import test from 'node:test';

const require = createRequire(import.meta.url);
const NodeModule = require('node:module') as {
    prototype: {
        require: (id: string) => unknown;
    };
};

class MockTextPart {
    constructor(public value: string) {}
}

class MockDataPart {
    constructor(
        public data: Uint8Array,
        public mimeType: string
    ) {}
}

class MockToolCallPart {
    constructor(
        public callId: string,
        public name: string,
        public input: unknown
    ) {}
}

class MockToolResultPart {
    constructor(
        public callId: string,
        public content: unknown
    ) {}
}

class MockThinkingPart {
    constructor(public value: string | string[]) {}
}

const vscodeMock = {
    LanguageModelChatMessageRole: {
        Assistant: 'assistant',
        System: 'system',
        User: 'user'
    },
    LanguageModelDataPart: MockDataPart,
    LanguageModelTextPart: MockTextPart,
    LanguageModelThinkingPart: MockThinkingPart,
    LanguageModelToolCallPart: MockToolCallPart,
    LanguageModelToolResultPart: MockToolResultPart
};

let converterModulePromise:
    | Promise<{
          OpenAIChatMessageConverter: typeof import('./messageConverter').OpenAIChatMessageConverter;
      }>
    | undefined;

async function getConverterModule() {
    if (converterModulePromise) {
        return converterModulePromise;
    }

    const originalRequire = NodeModule.prototype.require;
    NodeModule.prototype.require = function (id: string): unknown {
        if (id === 'vscode') {
            return vscodeMock;
        }
        if (id === '../../../utils/runtime/logger') {
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

    converterModulePromise = import('./messageConverter').finally(() => {
        NodeModule.prototype.require = originalRequire;
    });

    return converterModulePromise;
}

test('工具结果图片在并行工具输出配对后作为关联 user 图片回传', async () => {
    const { OpenAIChatMessageConverter } = await getConverterModule();
    const imageBytes = Uint8Array.from([137, 80, 78, 71]);
    const imageUrl = `data:image/png;base64,${Buffer.from(imageBytes).toString('base64')}`;
    const converter = new OpenAIChatMessageConverter({ provider: 'openai' } as never);

    const result = converter.convertMessagesToOpenAI(
        [
            {
                role: vscodeMock.LanguageModelChatMessageRole.Assistant,
                content: [new MockToolCallPart('view-1', 'capture', {}), new MockToolCallPart('view-2', 'capture', {})]
            },
            {
                role: vscodeMock.LanguageModelChatMessageRole.User,
                content: [
                    new MockToolResultPart('view-1', [
                        new MockTextPart('Screenshot follows'),
                        new MockDataPart(imageBytes, 'image/png'),
                        new MockTextPart('End of screenshot')
                    ])
                ]
            },
            {
                role: vscodeMock.LanguageModelChatMessageRole.User,
                content: [
                    new MockToolResultPart('view-2', [
                        new MockDataPart(Uint8Array.from([1, 2, 3]), 'application/x-internal'),
                        new MockTextPart('second result')
                    ])
                ]
            }
        ] as never,
        { capabilities: { imageInput: true } } as never
    );

    assert.deepEqual(result, [
        {
            role: 'assistant',
            content: null,
            tool_calls: [
                { id: 'view-1', type: 'function', function: { name: 'capture', arguments: '{}' } },
                { id: 'view-2', type: 'function', function: { name: 'capture', arguments: '{}' } }
            ]
        },
        { role: 'tool', content: 'Screenshot follows\n[Image]\nEnd of screenshot', tool_call_id: 'view-1' },
        { role: 'tool', content: 'second result', tool_call_id: 'view-2' },
        {
            role: 'user',
            content: [
                { type: 'text', text: 'Images associated with tool call "view-1":' },
                { type: 'image_url', image_url: { url: imageUrl } }
            ]
        }
    ]);
});

for (const extraKind of ['text', 'image'] as const) {
    for (const parallel of [false, true]) {
        test(`工具结果混合 ${extraKind} 时等待全部应答后发送用户内容（并行=${parallel}）`, async () => {
            const { OpenAIChatMessageConverter } = await getConverterModule();
            const converter = new OpenAIChatMessageConverter({ provider: 'openai' } as never);
            const messages = [
                {
                    role: vscodeMock.LanguageModelChatMessageRole.Assistant,
                    content: [
                        new MockToolCallPart('view-1', 'capture', {}),
                        ...(parallel ? [new MockToolCallPart('view-2', 'capture', {})] : [])
                    ]
                },
                {
                    role: vscodeMock.LanguageModelChatMessageRole.User,
                    content: [
                        new MockToolResultPart('view-1', [new MockDataPart(Uint8Array.from([1]), 'image/png')]),
                        extraKind === 'text' ?
                            new MockTextPart('follow-up')
                        :   new MockDataPart(Uint8Array.from([2]), 'image/png')
                    ]
                },
                ...(parallel ?
                    [
                        {
                            role: vscodeMock.LanguageModelChatMessageRole.User,
                            content: [new MockToolResultPart('view-2', [new MockTextPart('done')])]
                        }
                    ]
                :   [])
            ];
            const snapshot = JSON.stringify(messages);
            const result = converter.convertMessagesToOpenAI(
                messages as never,
                { capabilities: { imageInput: true } } as never
            );
            const toolCount = parallel ? 2 : 1;

            assert.deepEqual(
                result.slice(0, toolCount + 1).map(message => message.role),
                ['assistant', ...Array<string>(toolCount).fill('tool')]
            );
            assert.deepEqual(result[1], { role: 'tool', tool_call_id: 'view-1', content: '[Image]' });
            if (parallel) {
                assert.deepEqual(result[2], { role: 'tool', tool_call_id: 'view-2', content: 'done' });
            }
            assert.deepEqual(result.slice(toolCount + 1), [
                {
                    role: 'user',
                    content:
                        extraKind === 'text' ? 'follow-up' : (
                            [{ type: 'image_url', image_url: { url: 'data:image/png;base64,Ag==' } }]
                        )
                },
                {
                    role: 'user',
                    content: [
                        { type: 'text', text: 'Images associated with tool call "view-1":' },
                        { type: 'image_url', image_url: { url: 'data:image/png;base64,AQ==' } }
                    ]
                }
            ]);
            assert.equal(JSON.stringify(messages), snapshot);
        });
    }
}

for (const imageInput of [false, true]) {
    test(`工具应答之间的普通消息按序延后且不清空配对（视觉=${imageInput}）`, async () => {
        const { OpenAIChatMessageConverter } = await getConverterModule();
        const converter = new OpenAIChatMessageConverter({ provider: 'openai' } as never);
        const result = converter.convertMessagesToOpenAI(
            [
                {
                    role: vscodeMock.LanguageModelChatMessageRole.Assistant,
                    content: [
                        new MockToolCallPart('view-1', 'capture', {}),
                        new MockToolCallPart('view-2', 'capture', {})
                    ]
                },
                {
                    role: vscodeMock.LanguageModelChatMessageRole.User,
                    content: [new MockToolResultPart('view-1', [new MockDataPart(Uint8Array.from([1]), 'image/png')])]
                },
                {
                    role: vscodeMock.LanguageModelChatMessageRole.User,
                    content: [new MockTextPart('first follow-up')]
                },
                {
                    role: vscodeMock.LanguageModelChatMessageRole.User,
                    content: [new MockTextPart('second follow-up')]
                },
                {
                    role: vscodeMock.LanguageModelChatMessageRole.User,
                    content: [new MockToolResultPart('view-2', [new MockTextPart('done')])]
                }
            ] as never,
            { capabilities: { imageInput } } as never
        );

        assert.deepEqual(
            result.slice(0, 3).map(message => message.role),
            ['assistant', 'tool', 'tool']
        );
        assert.deepEqual(result.slice(3), [
            ...(imageInput ?
                [
                    {
                        role: 'user',
                        content: [
                            { type: 'text', text: 'Images associated with tool call "view-1":' },
                            { type: 'image_url', image_url: { url: 'data:image/png;base64,AQ==' } }
                        ]
                    }
                ]
            :   []),
            { role: 'user', content: 'first follow-up' },
            { role: 'user', content: 'second follow-up' }
        ]);
    });
}

test('单消息转换入口先输出所有工具结果再输出混合用户内容', async () => {
    const { OpenAIChatMessageConverter } = await getConverterModule();
    const converter = new OpenAIChatMessageConverter({ provider: 'openai' } as never);
    const result = converter.convertSingleMessage(
        {
            role: vscodeMock.LanguageModelChatMessageRole.User,
            content: [
                new MockTextPart('follow-up'),
                new MockToolResultPart('view-1', [new MockDataPart(Uint8Array.from([1]), 'image/png')]),
                new MockDataPart(Uint8Array.from([2]), 'image/png'),
                new MockToolResultPart('view-2', [new MockTextPart('done')])
            ]
        } as never,
        { capabilities: { imageInput: true } } as never
    );

    assert.deepEqual(result, [
        { role: 'tool', tool_call_id: 'view-1', content: '[Image]' },
        { role: 'tool', tool_call_id: 'view-2', content: 'done' },
        {
            role: 'user',
            content: [
                { type: 'text', text: 'follow-up' },
                { type: 'image_url', image_url: { url: 'data:image/png;base64,Ag==' } }
            ]
        },
        {
            role: 'user',
            content: [
                { type: 'text', text: 'Images associated with tool call "view-1":' },
                { type: 'image_url', image_url: { url: 'data:image/png;base64,AQ==' } }
            ]
        }
    ]);
});

test('连续工具批次分别清空延后消息并保留逆序结果和后续用户消息', async () => {
    const { OpenAIChatMessageConverter } = await getConverterModule();
    const converter = new OpenAIChatMessageConverter({ provider: 'openai' } as never);
    const result = converter.convertMessagesToOpenAI([
        {
            role: vscodeMock.LanguageModelChatMessageRole.Assistant,
            content: [new MockToolCallPart('view-1', 'capture', {}), new MockToolCallPart('view-2', 'capture', {})]
        },
        {
            role: vscodeMock.LanguageModelChatMessageRole.User,
            content: [new MockToolResultPart('view-2', [new MockTextPart('done')]), new MockTextPart('first')]
        },
        {
            role: vscodeMock.LanguageModelChatMessageRole.User,
            content: [new MockToolResultPart('view-1', [new MockTextPart('done')])]
        },
        {
            role: vscodeMock.LanguageModelChatMessageRole.Assistant,
            content: [new MockToolCallPart('view-3', 'capture', {})]
        },
        {
            role: vscodeMock.LanguageModelChatMessageRole.User,
            content: [new MockToolResultPart('view-3', [new MockTextPart('done')]), new MockTextPart('second')]
        },
        {
            role: vscodeMock.LanguageModelChatMessageRole.User,
            content: [new MockTextPart('last')]
        }
    ] as never);

    assert.deepEqual(
        result.map(message => message.role),
        ['assistant', 'tool', 'tool', 'user', 'assistant', 'tool', 'user', 'user']
    );
    assert.deepEqual(
        result.filter(message => message.role === 'tool'),
        [
            { role: 'tool', tool_call_id: 'view-2', content: 'done' },
            { role: 'tool', tool_call_id: 'view-1', content: 'done' },
            { role: 'tool', tool_call_id: 'view-3', content: 'done' }
        ]
    );
    assert.deepEqual(
        result.filter(message => message.role === 'user'),
        [
            { role: 'user', content: 'first' },
            { role: 'user', content: 'second' },
            { role: 'user', content: 'last' }
        ]
    );
});

for (const role of ['User', 'Assistant', 'System'] as const) {
    for (const metadataOnly of [false, true]) {
        test(`${role} ${metadataOnly ? '内部元数据' : '空'}消息不提前发送并行工具图片`, async () => {
            const { OpenAIChatMessageConverter } = await getConverterModule();
            const converter = new OpenAIChatMessageConverter({ provider: 'openai' } as never);
            const result = converter.convertMessagesToOpenAI(
                [
                    {
                        role: vscodeMock.LanguageModelChatMessageRole.Assistant,
                        content: [
                            new MockToolCallPart('view-1', 'capture', {}),
                            new MockToolCallPart('view-2', 'capture', {})
                        ]
                    },
                    {
                        role: vscodeMock.LanguageModelChatMessageRole.User,
                        content: [
                            new MockToolResultPart('view-1', [new MockDataPart(Uint8Array.from([1]), 'image/png')])
                        ]
                    },
                    {
                        role: vscodeMock.LanguageModelChatMessageRole[role],
                        content: metadataOnly ? [new MockDataPart(Uint8Array.from([2]), 'application/x-internal')] : []
                    },
                    {
                        role: vscodeMock.LanguageModelChatMessageRole.User,
                        content: [new MockToolResultPart('view-2', [new MockTextPart('done')])]
                    }
                ] as never,
                { capabilities: { imageInput: true } } as never
            );

            assert.deepEqual(
                result.map(message => message.role),
                ['assistant', 'tool', 'tool', 'user']
            );
            assert.deepEqual(result.slice(1, 3), [
                { role: 'tool', content: '[Image]', tool_call_id: 'view-1' },
                { role: 'tool', content: 'done', tool_call_id: 'view-2' }
            ]);
            assert.deepEqual(result[3], {
                role: 'user',
                content: [
                    { type: 'text', text: 'Images associated with tool call "view-1":' },
                    { type: 'image_url', image_url: { url: 'data:image/png;base64,AQ==' } }
                ]
            });
        });
    }
}

test('不支持图像输入时工具图片继续降级为占位文本', async () => {
    const { OpenAIChatMessageConverter } = await getConverterModule();
    const converter = new OpenAIChatMessageConverter({ provider: 'openai' } as never);

    const result = converter.convertMessagesToOpenAI(
        [
            {
                role: vscodeMock.LanguageModelChatMessageRole.Assistant,
                content: [new MockToolCallPart('view-1', 'capture', {})]
            },
            {
                role: vscodeMock.LanguageModelChatMessageRole.User,
                content: [new MockToolResultPart('view-1', [new MockDataPart(Uint8Array.from([1]), 'image/png')])]
            }
        ] as never,
        { capabilities: { imageInput: false } } as never
    );

    assert.deepEqual(result, [
        {
            role: 'assistant',
            content: null,
            tool_calls: [{ id: 'view-1', type: 'function', function: { name: 'capture', arguments: '{}' } }]
        },
        { role: 'tool', content: '[Image]', tool_call_id: 'view-1' }
    ]);
});

test('顶层用户图片仍按既有 Chat 多模态格式回传', async () => {
    const { OpenAIChatMessageConverter } = await getConverterModule();
    const converter = new OpenAIChatMessageConverter({ provider: 'openai' } as never);

    const result = converter.convertMessagesToOpenAI(
        [
            {
                role: vscodeMock.LanguageModelChatMessageRole.User,
                content: [new MockDataPart(Uint8Array.from([1]), 'image/png')]
            }
        ] as never,
        { capabilities: { imageInput: true } } as never
    );

    assert.deepEqual(result, [
        {
            role: 'user',
            content: [{ type: 'image_url', image_url: { url: 'data:image/png;base64,AQ==' } }]
        }
    ]);
});

for (const mimeType of ['image/svg+xml', 'image/bmp']) {
    test(`Chat 工具结果中的 ${mimeType} 保留占位但不发送图片`, async () => {
        const { OpenAIChatMessageConverter } = await getConverterModule();
        const converter = new OpenAIChatMessageConverter({ provider: 'openai' } as never);
        const result = converter.convertMessagesToOpenAI(
            [
                {
                    role: vscodeMock.LanguageModelChatMessageRole.Assistant,
                    content: [new MockToolCallPart('view-1', 'capture', {})]
                },
                {
                    role: vscodeMock.LanguageModelChatMessageRole.User,
                    content: [
                        new MockToolResultPart('view-1', [
                            new MockTextPart('before'),
                            new MockDataPart(Uint8Array.from([1]), mimeType),
                            new MockTextPart('after')
                        ])
                    ]
                }
            ] as never,
            { capabilities: { imageInput: true } } as never
        );

        assert.deepEqual(
            result.map(message => message.role),
            ['assistant', 'tool']
        );
        assert.deepEqual(result[1], {
            role: 'tool',
            tool_call_id: 'view-1',
            content: 'before\n[Image]\nafter'
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
    test(`Chat 工具图片 ${inputMime} 使用规范 MIME ${outputMime}`, async () => {
        const { OpenAIChatMessageConverter } = await getConverterModule();
        const converter = new OpenAIChatMessageConverter({ provider: 'openai' } as never);
        const imagePart = new MockDataPart(Uint8Array.from([1]), inputMime);
        const result = converter.convertMessagesToOpenAI(
            [
                {
                    role: vscodeMock.LanguageModelChatMessageRole.Assistant,
                    content: [new MockToolCallPart('view-1', 'capture', {})]
                },
                {
                    role: vscodeMock.LanguageModelChatMessageRole.User,
                    content: [new MockToolResultPart('view-1', [imagePart])]
                }
            ] as never,
            { capabilities: { imageInput: true } } as never
        );

        assert.deepEqual(result[2], {
            role: 'user',
            content: [
                { type: 'text', text: 'Images associated with tool call "view-1":' },
                { type: 'image_url', image_url: { url: `data:${outputMime};base64,AQ==` } }
            ]
        });
        assert.equal(imagePart.mimeType, inputMime);
    });
}

test('Chat 混合工具图片仅回传支持格式并保留像素顺序', async () => {
    const { OpenAIChatMessageConverter } = await getConverterModule();
    const converter = new OpenAIChatMessageConverter({ provider: 'openai' } as never);
    const result = converter.convertSingleMessage(
        {
            role: vscodeMock.LanguageModelChatMessageRole.User,
            content: [
                new MockToolResultPart('view-1', [
                    new MockDataPart(Uint8Array.from([1]), 'image/png'),
                    new MockDataPart(Uint8Array.from([2]), 'image/svg+xml'),
                    new MockDataPart(Uint8Array.from([3]), 'image/webp')
                ])
            ]
        } as never,
        { capabilities: { imageInput: true } } as never
    );

    assert.deepEqual(result, [
        { role: 'tool', tool_call_id: 'view-1', content: '[Image]\n[Image]\n[Image]' },
        {
            role: 'user',
            content: [
                { type: 'text', text: 'Images associated with tool call "view-1":' },
                { type: 'image_url', image_url: { url: 'data:image/png;base64,AQ==' } },
                { type: 'image_url', image_url: { url: 'data:image/webp;base64,Aw==' } }
            ]
        }
    ]);
});
