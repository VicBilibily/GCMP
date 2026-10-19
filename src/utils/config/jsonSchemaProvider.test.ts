import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { before, test } from 'node:test';
import type { ValidateFunction } from 'ajv';
import type { JSONSchema7 } from 'json-schema';
import type { ProviderConfig } from '../../types/sharedTypes';

const require = createRequire(import.meta.url);
const NodeModule = require('node:module') as { prototype: { require(id: string): unknown } };
const Ajv = require('ajv') as new (options: { strict: boolean; validateFormats: boolean }) => {
    compile(schema: JSONSchema7): ValidateFunction;
};
const provider: ProviderConfig = {
    displayName: 'Schema fixture',
    baseUrl: 'https://example.test',
    apiKeyTemplate: '${APIKEY}',
    models: [
        { id: 'responses-model', sdkMode: 'openai-responses' },
        { id: 'openai-model', sdkMode: 'openai' },
        { id: 'anthropic-model', sdkMode: 'anthropic' },
        { id: 'default-model' }
    ].map(model => ({
        name: model.id,
        tooltip: model.id,
        maxInputTokens: 1024,
        maxOutputTokens: 512,
        capabilities: { toolCalling: true, imageInput: false },
        ...model
    })) as ProviderConfig['models']
};
let validate: ValidateFunction;

before(async () => {
    const originalRequire = NodeModule.prototype.require;
    NodeModule.prototype.require = function (id: string): unknown {
        if (id === 'vscode') {
            return { Uri: { parse: () => ({}) }, env: { language: 'en' } };
        }
        if (id.endsWith('/configManager')) {
            return {
                ConfigManager: {
                    getConfigProvider: () => ({
                        fixture: provider,
                        nonresponses: {
                            ...provider,
                            models: provider.models?.filter(model => model.sdkMode !== 'openai-responses')
                        }
                    }),
                    getProviderOverrides: () => ({}),
                    applyProviderOverrides: (_providerKey: string, config: ProviderConfig) => config
                }
            };
        }
        if (id.endsWith('/compatibleModelManager')) {
            return { CompatibleModelManager: { getModels: () => [] } };
        }
        if (id.endsWith('/knownProviders')) {
            return { KnownProviders: {} };
        }
        if (id.endsWith('/logger')) {
            return { Logger: { debug() {}, info() {}, warn() {}, error() {} } };
        }
        if (id.endsWith('/l10n')) {
            return { t: (english: string) => english };
        }
        return originalRequire.call(this, id);
    };
    try {
        const { JsonSchemaProvider } = await import('./jsonSchemaProvider');
        validate = new Ajv({ strict: false, validateFormats: false }).compile(JsonSchemaProvider.getSettingsSchema());
    } finally {
        NodeModule.prototype.require = originalRequire;
    }
});

const cases = [
    { name: 'inherited Responses enabled', id: 'responses-model', useWebSocket: true, expected: true },
    { name: 'inherited Responses disabled', id: 'responses-model', useWebSocket: false, expected: true },
    { name: 'option omitted', id: 'responses-model', expected: true },
    {
        name: 'explicit Responses enabled',
        id: 'responses-model',
        sdkMode: 'openai-responses',
        useWebSocket: true,
        expected: true
    },
    { name: 'switch to OpenAI', id: 'responses-model', sdkMode: 'openai', useWebSocket: true, expected: false },
    { name: 'switch to Anthropic', id: 'responses-model', sdkMode: 'anthropic', useWebSocket: true, expected: false },
    { name: 'switch to Gemini', id: 'responses-model', sdkMode: 'gemini-sse', useWebSocket: true, expected: false },
    {
        name: 'disabled flag outside Responses',
        id: 'responses-model',
        sdkMode: 'openai',
        useWebSocket: false,
        expected: false
    },
    { name: 'inherited OpenAI', id: 'openai-model', useWebSocket: true, expected: false },
    { name: 'inherited Anthropic', id: 'anthropic-model', useWebSocket: true, expected: false },
    { name: 'default mode', id: 'default-model', useWebSocket: true, expected: false },
    {
        name: 'switch to Responses',
        id: 'openai-model',
        sdkMode: 'openai-responses',
        useWebSocket: true,
        expected: true
    },
    { name: 'unknown model without mode', id: 'new-model', useWebSocket: true, expected: false },
    {
        name: 'unknown model with Responses',
        id: 'new-model',
        sdkMode: 'openai-responses',
        useWebSocket: true,
        expected: true
    },
    { name: 'string flag', id: 'responses-model', useWebSocket: 'true', expected: false },
    { name: 'null flag', id: 'responses-model', useWebSocket: null, expected: false },
    { name: 'empty model ID', id: '', useWebSocket: true, expected: false },
    { name: 'missing model ID', sdkMode: 'openai-responses', useWebSocket: true, expected: false }
] as const;

for (const { name, expected, ...model } of cases) {
    test(`WS-LOOP-01: provider Schema WebSocket ${name}`, () => {
        assert.equal(
            validate({ 'gcmp.providerOverrides': { fixture: { models: [model] } } }),
            expected,
            JSON.stringify(validate.errors)
        );
    });
}

for (const sdkMode of [undefined, 'openai-responses']) {
    test(`WS-LOOP-01: provider Schema without Responses defaults mode=${sdkMode}`, () => {
        const model = { id: 'new-model', useWebSocket: true, ...(sdkMode ? { sdkMode } : {}) };
        assert.equal(
            validate({ 'gcmp.providerOverrides': { nonresponses: { models: [model] } } }),
            sdkMode === 'openai-responses',
            JSON.stringify(validate.errors)
        );
    });
}
