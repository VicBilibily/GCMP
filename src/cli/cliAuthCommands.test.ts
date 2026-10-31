import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import test from 'node:test';

const require = createRequire(import.meta.url);
const NodeModule = require('node:module') as {
    prototype: { require: (id: string) => unknown };
};

test('CLI auth command stores the local runtime key', async t => {
    let selected: { label: string; cliType: string } | undefined;
    let pickedQuickItem: unknown;
    let oauthEntries: Array<{ name: string; hasAccessToken: boolean; expiryDate?: number }> = [];
    let credentials: { access_token?: string } | null = null;
    const storedKeys: Array<{ provider: string; apiKey: string }> = [];
    const deletedKeys: string[] = [];
    const messages: string[] = [];
    const commands = new Map<string, (...args: unknown[]) => Promise<void>>();
    // 导入命令迁移流程的协作状态
    const savedOAuthFiles: Array<{ provider: string; name: string; record: unknown }> = [];
    const activeSelections: Array<{ cliType: string; name: string }> = [];
    const callOrder: string[] = [];
    let activeCredentialName: string | undefined;
    let activeSelectionGeneration = 0;
    let nativeRemoved = false;
    let failRemoveNative = false;
    let failSetActive = false;
    let failSetApiKey = false;
    let failDeleteApiKey = false;
    let confirmImport = true;
    let nativeValidationForceRefresh: boolean | undefined;
    let cliNativeCredentials: { access_token?: string; refresh_token?: string } | null = null;
    let validatedNativeCredentials: { access_token?: string; refresh_token?: string } | null = null;

    const fakeAuthInstance = {
        loadCliNativeCredentials: async () => cliNativeCredentials,
        suggestCredentialName: () => 'derived-name',
        toOAuthStoreRecord: (c: { access_token?: string }) => ({ type: 'codex', access_token: c.access_token }),
        removeCliNativeCredential: async () => {
            callOrder.push('removeNative');
            if (failRemoveNative) {
                throw new Error('disk busy');
            }
            nativeRemoved = true;
        },
        getCliNativeCredentialPath: () => '/home/user/.codex/auth.json'
    };

    const originalRequire = NodeModule.prototype.require;
    NodeModule.prototype.require = function (id: string): unknown {
        if (id === 'vscode') {
            return {
                commands: {
                    registerCommand: (name: string, callback: (...args: unknown[]) => Promise<void>) => {
                        commands.set(name, callback);
                        return { dispose: (): void => undefined };
                    }
                },
                window: {
                    showQuickPick: async () => pickedQuickItem ?? selected,
                    showInformationMessage: (message: string) => messages.push(message),
                    showErrorMessage: (message: string) => messages.push(message),
                    showWarningMessage: async (message: string, _options?: unknown, ...items: string[]) => {
                        messages.push(message);
                        return confirmImport ? items[0] : undefined;
                    }
                }
            };
        }
        if (/cliAuthFactory(?:\.ts)?$/.test(id)) {
            return {
                CliAuthFactory: {
                    getSupportedCliTypes: () => [{ id: 'codex', name: 'Codex' }],
                    ensureAuthenticated: async () => credentials,
                    ensureCliNativeAuthenticated: async (_provider: string, forceRefresh?: boolean) => {
                        callOrder.push('validateNative');
                        nativeValidationForceRefresh = forceRefresh;
                        return validatedNativeCredentials;
                    },
                    getInstance: () => fakeAuthInstance,
                    setActiveCredential: async (cliType: string, name: string) => {
                        callOrder.push('setActive');
                        if (failSetActive) {
                            throw new Error('active selection write failed');
                        }
                        activeSelections.push({ cliType, name });
                        activeCredentialName = name;
                        activeSelectionGeneration++;
                        return { name, generation: activeSelectionGeneration };
                    },
                    listOAuthCredentials: () => oauthEntries,
                    getCredentialSourceInfo: () =>
                        activeCredentialName ? { source: 'oauth', name: activeCredentialName } : { source: 'cli' },
                    getActiveCredentialSelection: () => ({
                        name: activeCredentialName,
                        generation: activeSelectionGeneration
                    }),
                    getOAuthCredentialDir: () => '/tmp/oauth'
                }
            };
        }
        if (/oauthCredentialStore(?:\.ts)?$/.test(id)) {
            return {
                OAuthCredentialStore: {
                    isValidCredentialName: () => true,
                    saveCredentialFile: async (provider: string, name: string, record: unknown) => {
                        callOrder.push('save');
                        savedOAuthFiles.push({ provider, name, record });
                        return `/tmp/oauth/${provider}-${name}.json`;
                    },
                    getActiveCredentialSelection: () => ({
                        name: activeCredentialName,
                        generation: activeSelectionGeneration
                    })
                }
            };
        }
        if (/apiKeyManager(?:\.ts)?$/.test(id)) {
            return {
                ApiKeyManager: {
                    setApiKey: async (provider: string, apiKey: string) => {
                        callOrder.push('setApiKey');
                        if (failSetApiKey) {
                            throw new Error('secret storage unavailable');
                        }
                        storedKeys.push({ provider, apiKey });
                    },
                    setApiKeyForActiveCliCredential: async (
                        provider: string,
                        _selection: { name: string | undefined; generation: number },
                        apiKey: string
                    ) => {
                        callOrder.push('setApiKey');
                        if (failSetApiKey) {
                            throw new Error('secret storage unavailable');
                        }
                        storedKeys.push({ provider, apiKey });
                        return true;
                    },
                    deleteApiKey: async (provider: string) => {
                        deletedKeys.push(provider);
                        if (failDeleteApiKey) {
                            throw new Error('secret storage unavailable');
                        }
                    },
                    deleteApiKeyForActiveCliCredential: async (
                        provider: string,
                        _selection: { name: string | undefined; generation: number }
                    ) => {
                        deletedKeys.push(provider);
                        if (failDeleteApiKey) {
                            throw new Error('secret storage unavailable');
                        }
                        return true;
                    }
                }
            };
        }
        if (/(?:^|\/)logger(?:\.ts)?$/.test(id)) {
            return {
                Logger: {
                    info: () => undefined,
                    warn: () => undefined,
                    error: () => undefined,
                    trace: () => undefined,
                    debug: () => undefined
                }
            };
        }
        if (/(?:^|\/)l10n(?:\.ts)?$/.test(id)) {
            return {
                t: (english: string, _zh?: string, ...args: Array<string | number>) =>
                    english.replace(/\{(\d+)\}/g, (_match, index: string) => String(args[Number(index)]))
            };
        }
        return originalRequire.call(this, id);
    };

    let authCommands: typeof import('./cliAuthCommands');
    try {
        authCommands = await import('./cliAuthCommands');
    } finally {
        NodeModule.prototype.require = originalRequire;
    }

    authCommands.registerCliAuthCommands({ subscriptions: [] } as never);
    const command = commands.get('gcmp.cli.auth');
    assert.ok(command);
    assert.ok(commands.has('gcmp.cli.importCredential'));
    assert.ok(commands.has('gcmp.cli.selectCredential'));

    await t.test('stores access token before reporting success', async () => {
        selected = { label: 'Codex', cliType: 'codex' };
        credentials = { access_token: 'oauth-token' };

        await command!();

        assert.deepEqual(storedKeys, [{ provider: 'codex', apiKey: 'oauth-token' }]);
        assert.match(messages.at(-1) ?? '', /authenticated successfully/);
    });

    await t.test('does not report credentials without an access token as success', async () => {
        storedKeys.length = 0;
        deletedKeys.length = 0;
        messages.length = 0;
        oauthEntries = [];
        pickedQuickItem = undefined;
        credentials = {};

        await command!();

        assert.deepEqual(storedKeys, []);
        assert.match(messages.at(-1) ?? '', /authentication failed/);
    });

    const resetImportState = (): void => {
        savedOAuthFiles.length = 0;
        activeSelections.length = 0;
        callOrder.length = 0;
        storedKeys.length = 0;
        deletedKeys.length = 0;
        messages.length = 0;
        oauthEntries = [];
        pickedQuickItem = undefined;
        nativeRemoved = false;
        failRemoveNative = false;
        failSetActive = false;
        failSetApiKey = false;
        failDeleteApiKey = false;
        confirmImport = true;
        activeCredentialName = undefined;
        activeSelectionGeneration = 0;
        nativeValidationForceRefresh = undefined;
        cliNativeCredentials = { access_token: 'cli-token', refresh_token: 'cli-refresh' };
        validatedNativeCredentials = { access_token: 'verified-token', refresh_token: 'verified-refresh' };
        credentials = { access_token: 'oauth-token' };
    };

    await t.test('import command migrates the CLI credential under the derived account name', async () => {
        resetImportState();
        const importCommand = commands.get('gcmp.cli.importCredential');
        assert.ok(importCommand);

        await importCommand('codex');

        // 先验证原生凭证，再保存/激活；最后写运行时 Key 并移除 CLI 侧凭证
        assert.deepEqual(callOrder, ['validateNative', 'save', 'setActive', 'setApiKey', 'removeNative']);
        assert.equal(nativeValidationForceRefresh, true);
        assert.deepEqual(savedOAuthFiles, [
            { provider: 'codex', name: 'derived-name', record: { type: 'codex', access_token: 'verified-token' } }
        ]);
        assert.equal(nativeRemoved, true);
        assert.deepEqual(activeSelections, [{ cliType: 'codex', name: 'derived-name' }]);
        assert.deepEqual(storedKeys, [{ provider: 'codex', apiKey: 'verified-token' }]);
        assert.match(messages.at(-1) ?? '', /imported/);
    });

    await t.test('import command does nothing when the migration is not confirmed', async () => {
        resetImportState();
        confirmImport = false;
        const importCommand = commands.get('gcmp.cli.importCredential');

        await importCommand!('codex');

        assert.deepEqual(callOrder, ['validateNative']);
        assert.deepEqual(savedOAuthFiles, []);
        assert.equal(nativeRemoved, false);
        assert.deepEqual(activeSelections, []);
    });

    await t.test('import command continues with a warning when removing the CLI credential fails', async () => {
        resetImportState();
        failRemoveNative = true;
        const importCommand = commands.get('gcmp.cli.importCredential');

        await importCommand!('codex');

        // 凭证已保存并激活，仅 CLI 侧移除失败：告警附手动删除路径，最终仍报导入成功
        assert.deepEqual(callOrder, ['validateNative', 'save', 'setActive', 'setApiKey', 'removeNative']);
        assert.equal(nativeRemoved, false);
        assert.deepEqual(activeSelections, [{ cliType: 'codex', name: 'derived-name' }]);
        assert.ok(messages.some(message => message.includes('/home/user/.codex/auth.json')));
        assert.match(messages.at(-1) ?? '', /imported/);
    });

    await t.test('import command rejects refresh-token-only credentials before side effects', async () => {
        resetImportState();
        cliNativeCredentials = { refresh_token: 'refresh-only' };
        const importCommand = commands.get('gcmp.cli.importCredential');

        await importCommand!('codex');

        assert.deepEqual(callOrder, []);
        assert.deepEqual(savedOAuthFiles, []);
        assert.equal(nativeRemoved, false);
        assert.deepEqual(activeSelections, []);
        assert.match(messages.at(-1) ?? '', /no access token/i);
    });

    await t.test('import command does not save or activate a credential that fails validation', async () => {
        resetImportState();
        validatedNativeCredentials = null;
        const importCommand = commands.get('gcmp.cli.importCredential');

        await importCommand!('codex');

        assert.deepEqual(callOrder, ['validateNative']);
        assert.deepEqual(savedOAuthFiles, []);
        assert.deepEqual(activeSelections, []);
        assert.equal(nativeRemoved, false);
        assert.deepEqual(storedKeys, []);
        assert.deepEqual(deletedKeys, []);
        assert.match(messages.at(-1) ?? '', /could not be validated/i);
        assert.match(messages.at(-1) ?? '', /original credential was left unchanged/i);
        assert.doesNotMatch(messages.at(-1) ?? '', /imported as/i);
    });

    await t.test('import command keeps the CLI credential when active selection persistence fails', async () => {
        resetImportState();
        failSetActive = true;
        const importCommand = commands.get('gcmp.cli.importCredential');

        await importCommand!('codex');

        assert.deepEqual(callOrder, ['validateNative', 'save', 'setActive']);
        assert.equal(nativeRemoved, false);
        assert.deepEqual(activeSelections, []);
        assert.deepEqual(storedKeys, []);
        assert.ok(messages.some(message => message.includes('/tmp/oauth/codex-derived-name.json')));
        assert.ok(messages.some(message => message.includes('/home/user/.codex/auth.json')));
        assert.match(messages.at(-1) ?? '', /CLI credential was kept/i);
    });

    await t.test(
        'import command reports partial completion and keeps CLI credentials when key sync fails',
        async () => {
            resetImportState();
            failSetApiKey = true;
            storedKeys.push({ provider: 'codex', apiKey: 'previous-token' });
            const importCommand = commands.get('gcmp.cli.importCredential');

            await assert.doesNotReject(() => importCommand!('codex'));

            assert.deepEqual(callOrder, ['validateNative', 'save', 'setActive', 'setApiKey']);
            assert.deepEqual(savedOAuthFiles, [
                { provider: 'codex', name: 'derived-name', record: { type: 'codex', access_token: 'verified-token' } }
            ]);
            assert.deepEqual(activeSelections, [{ cliType: 'codex', name: 'derived-name' }]);
            assert.deepEqual(storedKeys, [{ provider: 'codex', apiKey: 'previous-token' }]);
            assert.deepEqual(deletedKeys, ['codex']);
            assert.equal(nativeRemoved, false);
            const failureMessage = messages.at(-1) ?? '';
            assert.match(failureMessage, /saved.*activated/i);
            assert.match(failureMessage, /API key.*sync/i);
            assert.match(failureMessage, /previous runtime API key was cleared/i);
            assert.match(failureMessage, /CLI credential was kept/i);
            assert.match(failureMessage, /retry.*import/i);
            assert.ok(failureMessage.includes('/tmp/oauth/codex-derived-name.json'));
            assert.ok(failureMessage.includes('/home/user/.codex/auth.json'));
            assert.doesNotMatch(failureMessage, /will need to sign in again/i);

            failSetApiKey = false;
            callOrder.length = 0;
            messages.length = 0;
            await importCommand!('codex');

            assert.deepEqual(callOrder, ['validateNative', 'save', 'setActive', 'setApiKey', 'removeNative']);
            assert.equal(nativeRemoved, true);
            assert.deepEqual(storedKeys.at(-1), { provider: 'codex', apiKey: 'verified-token' });
            assert.match(messages.at(-1) ?? '', /will need to sign in again/i);
        }
    );

    await t.test('select command excludes entries missing access_token', async () => {
        resetImportState();
        oauthEntries = [{ name: 'broken', hasAccessToken: false }];
        const selectCommand = commands.get('gcmp.cli.selectCredential');

        await selectCommand!('codex');

        assert.deepEqual(activeSelections, []);
        assert.deepEqual(storedKeys, []);
        assert.deepEqual(deletedKeys, ['codex']);
        assert.match(messages.at(-1) ?? '', /no usable oauth credential/i);
    });

    await t.test(
        'select command clears prior key and reports error when chosen credential cannot authenticate',
        async () => {
            resetImportState();
            credentials = null;
            oauthEntries = [{ name: 'valid-looking', hasAccessToken: true }];
            pickedQuickItem = { credentialName: 'valid-looking' };
            const selectCommand = commands.get('gcmp.cli.selectCredential');

            await selectCommand!('codex');

            assert.deepEqual(activeSelections, [{ cliType: 'codex', name: 'valid-looking' }]);
            assert.deepEqual(storedKeys, []);
            assert.deepEqual(deletedKeys, ['codex']);
            assert.match(messages.at(-1) ?? '', /could not be authenticated/i);
            assert.doesNotMatch(messages.at(-1) ?? '', /now uses oauth credential/i);
        }
    );

    await t.test('select command clears the prior key when runtime key sync fails', async () => {
        resetImportState();
        failSetApiKey = true;
        storedKeys.push({ provider: 'codex', apiKey: 'previous-token' });
        oauthEntries = [{ name: 'valid-looking', hasAccessToken: true }];
        pickedQuickItem = { credentialName: 'valid-looking' };
        const selectCommand = commands.get('gcmp.cli.selectCredential');

        await assert.doesNotReject(() => selectCommand!('codex'));

        assert.deepEqual(activeSelections, [{ cliType: 'codex', name: 'valid-looking' }]);
        assert.deepEqual(deletedKeys, ['codex']);
        assert.match(messages.at(-1) ?? '', /API key.*sync/i);
        assert.doesNotMatch(messages.at(-1) ?? '', /now uses oauth credential/i);
    });

    await t.test('import command warns when the previous runtime key cannot be cleared', async () => {
        resetImportState();
        failSetApiKey = true;
        failDeleteApiKey = true;
        const importCommand = commands.get('gcmp.cli.importCredential');

        await importCommand!('codex');

        assert.deepEqual(deletedKeys, ['codex']);
        assert.match(messages.at(-1) ?? '', /could not be confirmed.*cleared/i);
        assert.match(messages.at(-1) ?? '', /may still be used/i);
    });
});
