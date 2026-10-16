import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import test from 'node:test';
import type * as vscode from 'vscode';
import { encodeStatefulMarkerPayload } from '../../handlers/stateful/statefulMarkerCodec';
import { CustomDataPartMimeTypes } from '../../handlers/types';

class MockDataPart {
    constructor(
        public data: Uint8Array,
        public mimeType: string
    ) {}
}

test('local SDK usage supplies an approximate baseline without injecting a marker', async () => {
    const { TokenCounter, PromptAnalyzer } = await getModules();
    const counted: Array<string | vscode.LanguageModelChatMessage> = [];
    const counter = Object.create(TokenCounter.prototype) as InstanceType<typeof TokenCounter>;
    Object.assign(counter, {
        countTokens: async (
            _model: vscode.LanguageModelChatInformation,
            input: string | vscode.LanguageModelChatMessage
        ) => {
            counted.push(input);
            return 10;
        }
    });
    const originalGetInstance = TokenCounter.getInstance;
    TokenCounter.getInstance = () => counter;
    try {
        const messages = [
            { role: 0, content: [{ value: 'system' }] },
            { role: 1, content: [{ value: 'old task' }] },
            { role: 2, content: [{ value: 'answer' }] },
            { role: 1, content: [{ value: 'next' }] }
        ] as vscode.LanguageModelChatMessage[];
        const before = JSON.stringify(messages);
        const result = await PromptAnalyzer.analyzePromptParts(
            'provider',
            { id: 'model' } as vscode.LanguageModelChatInformation,
            messages,
            undefined,
            undefined,
            { usage: { prompt_tokens: 1000, completion_tokens: 20, total_tokens: 1020 }, messageCount: 2 }
        );
        assert.deepEqual(result, { context: 1020, requestIncrement: 20 });
        assert.deepEqual(counted, [messages[2], messages[3]]);
        assert.equal(JSON.stringify(messages), before);
        for (const reference of [
            { usage: { prompt_tokens: Infinity, completion_tokens: 20, total_tokens: 1020 }, messageCount: 2 },
            { usage: { prompt_tokens: 0, completion_tokens: 20, total_tokens: 20 }, messageCount: 2 },
            ...[-1, 0, 1.5, 5].map(messageCount => ({
                usage: { prompt_tokens: 1000, completion_tokens: 20, total_tokens: 1020 },
                messageCount
            }))
        ]) {
            const fallback = await PromptAnalyzer.analyzePromptParts(
                'provider',
                { id: 'model' } as vscode.LanguageModelChatInformation,
                messages,
                undefined,
                undefined,
                reference
            );
            assert.deepEqual(fallback, { context: 68 });
        }
    } finally {
        TokenCounter.getInstance = originalGetInstance;
    }
});

class MockThinkingPart {}

const require = createRequire(import.meta.url);
const NodeModule = require('node:module') as { prototype: { require: (id: string) => unknown } };
let modulesPromise:
    | Promise<{
          TokenCounter: typeof import('./tokenCounter').TokenCounter;
          PromptAnalyzer: typeof import('./promptAnalyzer').PromptAnalyzer;
      }>
    | undefined;

function getModules() {
    if (!modulesPromise) {
        const originalRequire = NodeModule.prototype.require;
        NodeModule.prototype.require = function (id: string): unknown {
            if (id === 'vscode') {
                return {
                    LanguageModelChatMessageRole: { System: 0, User: 1, Assistant: 2 },
                    LanguageModelThinkingPart: MockThinkingPart,
                    LanguageModelDataPart: MockDataPart
                };
            }
            if (id === '../runtime/logger') {
                return { Logger: { debug() {}, trace() {}, warn() {} } };
            }
            if (id === '../runtime/l10n') {
                return { t: (english: string) => english };
            }
            return originalRequire.call(this, id);
        };
        modulesPromise = Promise.all([import('./tokenCounter'), import('./promptAnalyzer')])
            .then(([counter, analyzer]) => ({ ...counter, ...analyzer }))
            .finally(() => {
                NodeModule.prototype.require = originalRequire;
            });
    }
    return modulesPromise;
}

const payload = encodeStatefulMarkerPayload('model', {
    extension: 'vicanent.gcmp',
    provider: 'provider',
    modelId: 'model',
    sdkMode: 'openai',
    sessionId: 'session',
    responseId: '',
    usage: { prompt_tokens: 1000, completion_tokens: 20, total_tokens: 1020 },
    completeThinking: 'thinking'.repeat(1000)
});

for (const mimeType of [CustomDataPartMimeTypes.StatefulMarker, CustomDataPartMimeTypes.SdkContinuity]) {
    test(`${mimeType} payload is excluded from token counting`, async () => {
        const { TokenCounter } = await getModules();
        const counter = Object.create(TokenCounter.prototype) as InstanceType<typeof TokenCounter>;
        Object.assign(counter, { getTextTokenLength: (text: string) => text.length });
        assert.equal(await counter.countMessageObjectTokens({ mimeType, data: payload }), 0);
        assert.ok(
            (await counter.countMessageObjectTokens({ mimeType: 'application/octet-stream', data: payload })) > 0
        );
    });

    test(`${mimeType} usage supplies the incremental baseline without recounting old history`, async () => {
        const { TokenCounter, PromptAnalyzer } = await getModules();
        const counted: Array<string | vscode.LanguageModelChatMessage> = [];
        const counter = Object.create(TokenCounter.prototype) as InstanceType<typeof TokenCounter>;
        Object.assign(counter, {
            countTokens: async (
                _model: vscode.LanguageModelChatInformation,
                input: string | vscode.LanguageModelChatMessage
            ) => {
                counted.push(input);
                return 10;
            }
        });
        const originalGetInstance = TokenCounter.getInstance;
        TokenCounter.getInstance = () => counter;
        try {
            const messages = [
                { role: 0, content: [{ value: 'system' }] },
                { role: 1, content: [{ value: 'old task' }] },
                { role: 2, content: [new MockDataPart(payload, mimeType), { value: 'answer' }] },
                { role: 1, content: [{ value: 'next' }] }
            ] as unknown as vscode.LanguageModelChatMessage[];
            const result = await PromptAnalyzer.analyzePromptParts(
                'provider',
                { id: 'model' } as vscode.LanguageModelChatInformation,
                messages,
                undefined,
                undefined,
                { usage: { prompt_tokens: 9000, completion_tokens: 20, total_tokens: 9020 }, messageCount: 1 }
            );
            assert.deepEqual(result, { context: 1020, requestIncrement: 20 });
            assert.deepEqual(counted, [messages[2], messages[3]]);
        } finally {
            TokenCounter.getInstance = originalGetInstance;
        }
    });
}
