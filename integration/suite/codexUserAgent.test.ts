import assert from 'node:assert/strict';

import { CodexProvider } from '../../src/cli/codexProvider';
import { CompatibleProvider } from '../../src/providers/compatibleProvider';
import { CliAuthFactory } from '../../src/cli/auth/cliAuthFactory';
import { CompatibleModelManager, type CompatibleModelConfig } from '../../src/utils/config/compatibleModelManager';
import { ConfigManager } from '../../src/utils/config/configManager';
import { queryCodexUsage } from '../../src/quota/codexQuota';
import {
    getClaudeCodeCliVersion,
    getCodexTuiCliHeader,
    setRemoteCliMetadata
} from '../../src/utils/metadata/metadataResolver';
import type { ProviderConfig } from '../../src/types/sharedTypes';

// 版本断言跟随共享元数据源文件，update:metadata 升级后无需改测试
const escRegExp = (value: string): string => value.replace(/\./g, '\\.');
const claudeCliUaPattern = new RegExp(`^claude-cli/${escRegExp(getClaudeCodeCliVersion())} \\(external, cli\\)$`);

function createModel(overrides: Partial<CompatibleModelConfig> = {}): CompatibleModelConfig {
    return {
        id: 'test-model',
        name: 'Test Model',
        provider: 'custom',
        maxInputTokens: 1024,
        maxOutputTokens: 1024,
        capabilities: {
            toolCalling: false,
            imageInput: false
        },
        sdkMode: 'openai',
        ...overrides
    };
}

suite('Codex User-Agent provider integration', () => {
    test('CodexProvider getter generates and preserves User-Agent', () => {
        const provider = Object.create(CodexProvider.prototype) as CodexProvider;
        const state = provider as unknown as { cachedProviderConfig: ProviderConfig };
        state.cachedProviderConfig = {
            displayName: 'Codex',
            baseUrl: 'https://chatgpt.com/backend-api/codex',
            apiKeyTemplate: 'token',
            customHeader: {
                version: '0.153.2',
                originator: 'codex-tui'
            },
            models: []
        };

        const generated = provider.providerConfig;
        assert.match(
            generated.customHeader?.['User-Agent'] ?? '',
            new RegExp(`^codex-tui/${escRegExp(getCodexTuiCliHeader().version)} `)
        );

        state.cachedProviderConfig.customHeader = {
            version: '0.153.2',
            originator: 'codex-tui',
            'user-agent': 'custom/1.0'
        };
        const explicit = provider.providerConfig;
        assert.equal(explicit.customHeader?.['User-Agent'], 'custom/1.0');
        assert.equal(explicit.customHeader?.['user-agent'], undefined);
    });

    test('CodexProvider getter reflects updated remote metadata', () => {
        const originalGetProviderOverrides = ConfigManager.getProviderOverrides;
        const provider = Object.create(CodexProvider.prototype) as CodexProvider;
        const state = provider as unknown as { cachedProviderConfig: ProviderConfig };
        state.cachedProviderConfig = {
            displayName: 'Codex',
            baseUrl: 'https://chatgpt.com/backend-api/codex',
            apiKeyTemplate: 'token',
            customHeader: {
                version: '0.153.0',
                originator: 'codex-tui'
            },
            models: []
        };

        try {
            ConfigManager.getProviderOverrides = () => ({}) as ReturnType<typeof ConfigManager.getProviderOverrides>;
            setRemoteCliMetadata({ codexTuiVersion: '0.200.0', codexTuiOriginator: 'codex-vscode' });
            const generated = provider.providerConfig;

            assert.equal(generated.customHeader?.version, '0.200.0');
            assert.equal(generated.customHeader?.originator, 'codex-vscode');
            assert.match(generated.customHeader?.['User-Agent'] ?? '', /^codex-vscode\/0\.200\.0 /);
        } finally {
            ConfigManager.getProviderOverrides = originalGetProviderOverrides;
            setRemoteCliMetadata(undefined);
        }
    });

    test('CompatibleProvider fills Codex and Claude headers and preserves explicit headers', () => {
        const originalGetModels = CompatibleModelManager.getModels;
        const originalGetProviderOverrides = ConfigManager.getProviderOverrides;

        try {
            CompatibleModelManager.getModels = () => [
                createModel({ id: 'GPT-5.4', name: 'GPT auto' }),
                createModel({ id: 'custom-gpt', name: 'GPT explicit', customHeader: { 'user-agent': 'custom/1.0' } }),
                createModel({
                    id: 'claude-sonnet',
                    name: 'Claude',
                    sdkMode: 'anthropic',
                    customHeader: { 'X-Test': 'kept' }
                }),
                createModel({ id: 'gpt-anthropic', name: 'GPT Anthropic', sdkMode: 'anthropic' })
            ];
            ConfigManager.getProviderOverrides = () => ({
                custom: {},
                compatible: {},
                codex: {
                    customHeader: {
                        version: '9.9.9',
                        originator: 'codex-test'
                    }
                }
            });

            const provider = Object.create(CompatibleProvider.prototype) as CompatibleProvider;
            const config = provider.getProviderConfig();

            const auto = config.models.find(model => model.id === 'GPT-5.4');
            assert.match(auto?.customHeader?.['User-Agent'] ?? '', /^codex-test\/9\.9\.9 /);
            assert.equal(auto?.customHeader?.originator, 'codex-test');
            assert.equal(auto?.customHeader?.version, '9.9.9');

            const explicit = config.models.find(model => model.id === 'custom-gpt');
            assert.equal(explicit?.customHeader?.['user-agent'], 'custom/1.0');
            assert.equal(explicit?.customHeader?.['User-Agent'], undefined);

            const nonGpt = config.models.find(model => model.id === 'claude-sonnet');
            assert.equal(nonGpt?.customHeader?.['X-Test'], 'kept');
            assert.match(nonGpt?.customHeader?.['User-Agent'] ?? '', claudeCliUaPattern);
            assert.equal(nonGpt?.customHeader?.['X-Stainless-Package-Version'], undefined);

            const anthropic = config.models.find(model => model.id === 'gpt-anthropic');
            assert.equal(anthropic?.customHeader, undefined);
        } finally {
            CompatibleModelManager.getModels = originalGetModels;
            ConfigManager.getProviderOverrides = originalGetProviderOverrides;
        }
    });

    test('Codex usage query sends generated or overridden User-Agent', async () => {
        const originalGetInstance = CliAuthFactory.getInstance;
        const originalEnsureAuthenticated = CliAuthFactory.ensureAuthenticated;
        const originalApplyProviderOverrides = ConfigManager.applyProviderOverrides;
        const originalFetchWithProxy = ConfigManager.fetchWithProxy;
        let overrideUserAgent: string | undefined;
        let requestInit: RequestInit | undefined;

        try {
            const fakeAuth = {
                getAccountId: async () => 'account-1'
            } as unknown as NonNullable<ReturnType<typeof CliAuthFactory.getInstance>>;
            CliAuthFactory.getInstance = (() => fakeAuth) as typeof CliAuthFactory.getInstance;
            CliAuthFactory.ensureAuthenticated = (async () => ({
                access_token: 'access-token',
                refresh_token: '',
                expiry_date: 0
            })) as typeof CliAuthFactory.ensureAuthenticated;
            ConfigManager.applyProviderOverrides = ((_providerKey, config) => ({
                ...config,
                customHeader:
                    overrideUserAgent ?
                        { ...config.customHeader, 'user-agent': overrideUserAgent }
                    :   config.customHeader
            })) as typeof ConfigManager.applyProviderOverrides;
            ConfigManager.fetchWithProxy = (async (_input, init) => {
                requestInit = init;
                return {
                    ok: true,
                    status: 200,
                    text: async () =>
                        JSON.stringify({
                            user_id: 'user-1',
                            account_id: 'account-1',
                            email: 'user@example.com',
                            plan_type: 'plus',
                            rate_limit: {
                                allowed: true,
                                limit_reached: false,
                                primary_window: {
                                    used_percent: 10,
                                    limit_window_seconds: 18000,
                                    reset_after_seconds: 60,
                                    reset_at: 1799000000
                                }
                            }
                        })
                } as Response;
            }) as typeof ConfigManager.fetchWithProxy;

            const generatedResult = await queryCodexUsage();
            assert.equal(generatedResult.success, true);
            const generatedHeaders = requestInit?.headers as Record<string, string>;
            assert.match(
                generatedHeaders['User-Agent'],
                new RegExp(`^codex-tui/${escRegExp(getCodexTuiCliHeader().version)} `)
            );
            assert.equal(generatedHeaders['user-agent'], undefined);
            assert.equal(generatedHeaders['chatgpt-account-id'], 'account-1');

            overrideUserAgent = 'manual/1.0';
            const overriddenResult = await queryCodexUsage();
            assert.equal(overriddenResult.success, true);
            const overriddenHeaders = requestInit?.headers as Record<string, string>;
            assert.equal(overriddenHeaders['User-Agent'], 'manual/1.0');
            assert.equal(overriddenHeaders['user-agent'], undefined);
        } finally {
            CliAuthFactory.getInstance = originalGetInstance;
            CliAuthFactory.ensureAuthenticated = originalEnsureAuthenticated;
            ConfigManager.applyProviderOverrides = originalApplyProviderOverrides;
            ConfigManager.fetchWithProxy = originalFetchWithProxy;
        }
    });
});
