import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { describe, it } from 'node:test';

import { CustomDataPartMimeTypes, GCMP_SYSTEM_MESSAGE_NAME } from '../types';

const require = createRequire(import.meta.url);
const NodeModule = require('node:module') as {
    prototype: {
        require: (id: string) => unknown;
    };
};

let vscodeMock!: {
    LanguageModelChatMessageRole: { Assistant: string; System: string; User: string };
    LanguageModelThinkingPart: new (value: string | string[], id?: string, metadata?: Record<string, unknown>) => unknown;
    LanguageModelTextPart: new (value: string) => unknown;
    LanguageModelToolCallPart: new (callId: string, name: string, input: unknown) => unknown;
    LanguageModelToolResultPart: new (callId: string, content: unknown[]) => unknown;
};


let converterModulePromise:
    | Promise<{
          convertMessagesToGemini: typeof import('./geminiConverter').convertMessagesToGemini;
          convertToolsToGemini: typeof import('./geminiConverter').convertToolsToGemini;
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
        LanguageModelToolCallPart: class {
            constructor(
                public callId: string,
                public name: string,
                public input: unknown
            ) {}
        },
        LanguageModelToolResultPart: class {
            constructor(
                public callId: string,
                public content: unknown[]
            ) {}
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

    converterModulePromise = import('./geminiConverter').finally(() => {
        NodeModule.prototype.require = originalRequire;
    });

    return converterModulePromise;
}

function modelConfig(overrides: Record<string, unknown> = {}) {
    return {
        id: 'gemini-test',
        name: 'Gemini Test',
        capabilities: { toolCalling: true, imageInput: false },
        ...overrides
    } as never;
}

describe('convertMessagesToGemini', () => {
    it('单条用户文本消息', async () => {
        const { convertMessagesToGemini } = await getConverterModule();
        const result = convertMessagesToGemini(modelConfig(), [
            {
                role: vscodeMock.LanguageModelChatMessageRole.User,
                content: [new vscodeMock.LanguageModelTextPart('hello')]
            } as never
        ]);
        assert.deepEqual(result.contents, [{ role: 'user', parts: [{ text: 'hello' }] }]);
        assert.equal(result.systemInstruction, undefined);
    });

    it('system 角色与 GCMP 命名系统消息合并到 systemInstruction', async () => {
        const { convertMessagesToGemini } = await getConverterModule();
        const result = convertMessagesToGemini(modelConfig(), [
            {
                role: vscodeMock.LanguageModelChatMessageRole.System,
                content: [new vscodeMock.LanguageModelTextPart('sys-A')]
            } as never,
            {
                role: vscodeMock.LanguageModelChatMessageRole.User,
                name: GCMP_SYSTEM_MESSAGE_NAME,
                content: [new vscodeMock.LanguageModelTextPart('sys-B')]
            } as never,
            {
                role: vscodeMock.LanguageModelChatMessageRole.User,
                content: [new vscodeMock.LanguageModelTextPart('user msg')]
            } as never
        ]);
        assert.deepEqual(result.systemInstruction, {
            role: 'system',
            parts: [{ text: 'sys-A' }, { text: 'sys-B' }]
        });
        assert.equal(result.contents.length, 1);
    });

    it('assistant 思考内容转为 thought part', async () => {
        const { convertMessagesToGemini } = await getConverterModule();
        const result = convertMessagesToGemini(modelConfig(), [
            {
                role: vscodeMock.LanguageModelChatMessageRole.User,
                content: [new vscodeMock.LanguageModelTextPart('q')]
            } as never,
            {
                role: vscodeMock.LanguageModelChatMessageRole.Assistant,
                content: [
                    new vscodeMock.LanguageModelThinkingPart('thinking...'),
                    new vscodeMock.LanguageModelTextPart('answer')
                ]
            } as never
        ]);
        assert.deepEqual(result.contents[1], {
            role: 'model',
            parts: [{ text: 'thinking...', thought: true }, { text: 'answer' }]
        });
    });

    it('工具调用与工具结果经 callId 解析为 functionCall / functionResponse', async () => {
        const { convertMessagesToGemini } = await getConverterModule();
        const result = convertMessagesToGemini(modelConfig(), [
            {
                role: vscodeMock.LanguageModelChatMessageRole.User,
                content: [new vscodeMock.LanguageModelTextPart('weather?')]
            } as never,
            {
                role: vscodeMock.LanguageModelChatMessageRole.Assistant,
                content: [new vscodeMock.LanguageModelToolCallPart('call-1', 'get_weather', { city: 'SZ' })]
            } as never,
            {
                role: vscodeMock.LanguageModelChatMessageRole.User,
                content: [
                    new vscodeMock.LanguageModelToolResultPart('call-1', [new vscodeMock.LanguageModelTextPart('sunny')])
                ]
            } as never
        ]);
        assert.deepEqual(result.contents[1], {
            role: 'model',
            parts: [{ functionCall: { name: 'get_weather', args: { city: 'SZ' }, id: 'call-1' } }]
        });
        assert.deepEqual(result.contents[2], {
            role: 'user',
            parts: [
                {
                    functionResponse: {
                        name: 'get_weather',
                        id: 'call-1',
                        response: { name: 'get_weather', content: 'sunny' }
                    }
                }
            ]
        });
    });

    it('连续同角色消息合并', async () => {
        const { convertMessagesToGemini } = await getConverterModule();
        const result = convertMessagesToGemini(modelConfig(), [
            {
                role: vscodeMock.LanguageModelChatMessageRole.User,
                content: [new vscodeMock.LanguageModelTextPart('a')]
            } as never,
            {
                role: vscodeMock.LanguageModelChatMessageRole.User,
                content: [new vscodeMock.LanguageModelTextPart('b')]
            } as never
        ]);
        assert.equal(result.contents.length, 1);
        assert.deepEqual(result.contents[0].parts, [{ text: 'a' }, { text: 'b' }]);
    });

    it('首条为 model 时前置占位 user 消息', async () => {
        const { convertMessagesToGemini } = await getConverterModule();
        const result = convertMessagesToGemini(modelConfig(), [
            {
                role: vscodeMock.LanguageModelChatMessageRole.Assistant,
                content: [new vscodeMock.LanguageModelTextPart('prev')]
            } as never
        ]);
        assert.equal(result.contents[0].role, 'user');
        assert.equal(result.contents[1].role, 'model');
    });

    it('不支持图片时图像降级为占位文本；支持时转为 inlineData', async () => {
        const { convertMessagesToGemini } = await getConverterModule();
        const imagePart = {
            mimeType: 'image/png',
            data: new TextEncoder().encode('png-bytes')
        };

        const noImage = convertMessagesToGemini(modelConfig(), [
            {
                role: vscodeMock.LanguageModelChatMessageRole.User,
                content: [imagePart, new vscodeMock.LanguageModelTextPart('look')]
            } as never
        ]);
        assert.deepEqual(noImage.contents[0].parts, [{ text: '[Image]' }, { text: 'look' }]);

        const withImage = convertMessagesToGemini(modelConfig({ capabilities: { toolCalling: true, imageInput: true } }), [
            {
                role: vscodeMock.LanguageModelChatMessageRole.User,
                content: [imagePart]
            } as never
        ]);
        assert.deepEqual(withImage.contents[0].parts, [
            { inlineData: { mimeType: 'image/png', data: Buffer.from('png-bytes').toString('base64') } }
        ]);
    });

    it('thinking metadata.signature 附加为 thoughtSignature', async () => {
        const { convertMessagesToGemini } = await getConverterModule();
        const result = convertMessagesToGemini(modelConfig(), [
            {
                role: vscodeMock.LanguageModelChatMessageRole.User,
                content: [new vscodeMock.LanguageModelTextPart('q')]
            } as never,
            {
                role: vscodeMock.LanguageModelChatMessageRole.Assistant,
                content: [
                    new vscodeMock.LanguageModelThinkingPart('thinking...', undefined, { signature: 'sig-1' }),
                    new vscodeMock.LanguageModelTextPart('answer')
                ]
            } as never
        ]);
        assert.deepEqual(result.contents[1].parts, [
            { text: 'thinking...', thought: true, thoughtSignature: 'sig-1' },
            { text: 'answer' }
        ]);
    });

    it('StatefulMarker 中的完整思考在 ThinkingPart 被剥离时恢复', async () => {
        const { convertMessagesToGemini } = await getConverterModule();
        const markerPayload = new TextEncoder().encode(
            'gemini-test\\json:' +
                Buffer.from(JSON.stringify({ completeThinking: 'restored thinking' }), 'utf-8').toString('base64url')
        );
        const result = convertMessagesToGemini(modelConfig(), [
            {
                role: vscodeMock.LanguageModelChatMessageRole.User,
                content: [new vscodeMock.LanguageModelTextPart('q')]
            } as never,
            {
                role: vscodeMock.LanguageModelChatMessageRole.Assistant,
                content: [
                    { mimeType: CustomDataPartMimeTypes.StatefulMarker, data: markerPayload },
                    new vscodeMock.LanguageModelTextPart('answer')
                ]
            } as never
        ]);
        assert.deepEqual(result.contents[1].parts, [
            { text: 'restored thinking', thought: true },
            { text: 'answer' }
        ]);
    });

    it('同名并行调用的签名只回传到带签名的那个 functionCall（按 callId 键控）', async () => {
        const { convertMessagesToGemini } = await getConverterModule();
        const markerPayload = new TextEncoder().encode(
            'gemini-test\\json:' +
                Buffer.from(
                    JSON.stringify({ toolCallSignatures: { 'call-1': 'fc-sig-1' } }),
                    'utf-8'
                ).toString('base64url')
        );
        const result = convertMessagesToGemini(modelConfig(), [
            {
                role: vscodeMock.LanguageModelChatMessageRole.User,
                content: [new vscodeMock.LanguageModelTextPart('q')]
            } as never,
            {
                role: vscodeMock.LanguageModelChatMessageRole.Assistant,
                content: [
                    { mimeType: CustomDataPartMimeTypes.StatefulMarker, data: markerPayload },
                    new vscodeMock.LanguageModelToolCallPart('call-1', 'get_weather', { city: 'SZ' }),
                    new vscodeMock.LanguageModelToolCallPart('call-2', 'get_weather', { city: 'BJ' })
                ]
            } as never
        ]);
        assert.deepEqual(result.contents[1].parts, [
            {
                functionCall: { name: 'get_weather', args: { city: 'SZ' }, id: 'call-1' },
                thoughtSignature: 'fc-sig-1'
            },
            { functionCall: { name: 'get_weather', args: { city: 'BJ' }, id: 'call-2' } }
        ]);
    });
});

describe('convertToolsToGemini', () => {
    it('转换工具定义为 functionDeclarations', async () => {
        const { convertToolsToGemini } = await getConverterModule();
        const tools = [
            {
                name: 'get_weather',
                description: 'Get weather',
                inputSchema: {
                    type: 'object',
                    properties: { city: { type: 'string' } },
                    required: ['city']
                }
            }
        ];
        const result = convertToolsToGemini(tools as never);
        assert.equal(result.length, 1);
        assert.equal(result[0].functionDeclarations.length, 1);
        const decl = result[0].functionDeclarations[0];
        assert.equal(decl.name, 'get_weather');
        assert.equal(decl.description, 'Get weather');
        assert.equal(decl.parameters.type, 'object');
        assert.deepEqual(decl.parameters.required, ['city']);
    });

    it('空工具列表返回空数组', async () => {
        const { convertToolsToGemini } = await getConverterModule();
        assert.deepEqual(convertToolsToGemini([]), []);
    });
});
