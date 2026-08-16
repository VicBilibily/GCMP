import assert from 'node:assert/strict';

import * as vscode from 'vscode';

import { GenericModelProvider } from '../../src/providers/genericModelProvider';
import type { ModelConfig, ProviderConfig } from '../../src/types/sharedTypes';

interface TestHandler {
    handleRequest: (
        model: vscode.LanguageModelChatInformation,
        modelConfig: ModelConfig,
        messages: readonly vscode.LanguageModelChatMessage[],
        options: vscode.ProvideLanguageModelChatResponseOptions,
        progress: vscode.Progress<vscode.LanguageModelResponsePart>,
        requestId: string,
        sessionId: string,
        token: vscode.CancellationToken,
        requestStartTime?: number
    ) => Promise<void>;
}

interface TestProvider {
    anthropicHandler: TestHandler;
    baseProviderConfig: ProviderConfig;
    cachedProviderConfig: ProviderConfig;
    executeModelRequest: (
        model: vscode.LanguageModelChatInformation,
        modelConfig: ModelConfig,
        messages: Array<vscode.LanguageModelChatMessage>,
        options: vscode.ProvideLanguageModelChatResponseOptions,
        progress: vscode.Progress<vscode.LanguageModelResponsePart>,
        requestId: string,
        sessionId: string,
        token: vscode.CancellationToken,
        effectiveProviderKey?: string,
        requestStartTime?: number
    ) => Promise<void>;
    getRequestRetryConfig: () => { enabled: boolean; maxAttempts: number; initialDelayMs: number; maxDelayMs: number };
    openaiCustomHandler: TestHandler;
    openaiHandler: TestHandler;
    openaiResponsesHandler: {
        handleResponsesRequest: (
            model: vscode.LanguageModelChatInformation,
            modelConfig: ModelConfig,
            messages: readonly vscode.LanguageModelChatMessage[],
            options: vscode.ProvideLanguageModelChatResponseOptions,
            progress: vscode.Progress<vscode.LanguageModelTextPart | vscode.LanguageModelToolCallPart>,
            requestId: string,
            sessionId: string,
            token: vscode.CancellationToken,
            requestStartTime?: number
        ) => Promise<void>;
    };
    providerKey: string;
    shouldRetryRequest: () => boolean;
    visionCache?: unknown;
}

function createTestProvider(handler: TestHandler): TestProvider {
    const provider = Object.create(GenericModelProvider.prototype) as unknown as TestProvider;
    const providerConfig = {
        displayName: 'Test Provider',
        models: []
    } as unknown as ProviderConfig;

    provider.providerKey = 'test-provider';
    provider.baseProviderConfig = providerConfig;
    provider.cachedProviderConfig = providerConfig;
    provider.visionCache = undefined;
    provider.openaiHandler = handler;
    provider.openaiCustomHandler = { handleRequest: handler.handleRequest };
    provider.openaiResponsesHandler = {
        handleResponsesRequest: async (
            model,
            modelConfig,
            messages,
            options,
            progress,
            requestId,
            sessionId,
            token,
            requestStartTime
        ) =>
            handler.handleRequest(
                model,
                modelConfig,
                messages,
                options,
                progress as unknown as vscode.Progress<vscode.LanguageModelResponsePart>,
                requestId,
                sessionId,
                token,
                requestStartTime
            )
    };
    provider.anthropicHandler = handler;
    provider.getRequestRetryConfig = () => ({ enabled: true, maxAttempts: 1, initialDelayMs: 0, maxDelayMs: 0 });
    provider.shouldRetryRequest = () => true;

    return provider;
}

const model = {
    id: 'test-model',
    name: 'Test Model'
} as unknown as vscode.LanguageModelChatInformation;

const modelConfig: ModelConfig = {
    id: 'test-model',
    name: 'Test Model',
    tooltip: 'Test Model',
    maxInputTokens: 1024,
    maxOutputTokens: 1024,
    capabilities: {
        toolCalling: false,
        imageInput: true
    },
    sdkMode: 'openai'
};

function createProgress(outputs: string[]): vscode.Progress<vscode.LanguageModelResponsePart> {
    return {
        report(value) {
            if (value instanceof vscode.LanguageModelTextPart) {
                outputs.push(value.value);
            }
        }
    };
}

suite('genericModelProvider retry gating', () => {
    test('does not retry after a streamed response part was emitted', async () => {
        let attempts = 0;
        const provider = createTestProvider({
            async handleRequest(_model, _config, _messages, _options, progress) {
                attempts += 1;
                progress.report(new vscode.LanguageModelTextPart(`attempt-${attempts}`));
                throw new Error('stream dropped after output');
            }
        });
        const outputs: string[] = [];

        await assert.rejects(
            () =>
                provider.executeModelRequest(
                    model,
                    modelConfig,
                    [],
                    {
                        modelOptions: { requestKind: 'main-agent' }
                    } as unknown as vscode.ProvideLanguageModelChatResponseOptions,
                    createProgress(outputs),
                    '',
                    'session-1',
                    new vscode.CancellationTokenSource().token,
                    'test-provider',
                    Date.now()
                ),
            /stream dropped after output/
        );

        assert.equal(attempts, 1);
        assert.deepEqual(outputs, ['attempt-1']);
    });

    test('keeps retrying when the failed attempt emitted nothing', async () => {
        let attempts = 0;
        const provider = createTestProvider({
            async handleRequest(_model, _config, _messages, _options, progress) {
                attempts += 1;
                if (attempts === 1) {
                    throw new Error('temporary network error');
                }
                progress.report(new vscode.LanguageModelTextPart('final-response'));
            }
        });
        const outputs: string[] = [];

        await provider.executeModelRequest(
            model,
            modelConfig,
            [],
            {
                modelOptions: { requestKind: 'main-agent' }
            } as unknown as vscode.ProvideLanguageModelChatResponseOptions,
            createProgress(outputs),
            '',
            'session-2',
            new vscode.CancellationTokenSource().token,
            'test-provider',
            Date.now()
        );

        assert.equal(attempts, 2);
        assert.deepEqual(outputs, ['final-response']);
    });
});
