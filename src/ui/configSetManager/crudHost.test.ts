import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import test from 'node:test';

const require = createRequire(import.meta.url);
const NodeModule = require('node:module') as {
    prototype: { require: (id: string) => unknown };
};

test('CLI OAuth account changes do not retain a stale runtime API key', async t => {
    let activeCredentialName: string | undefined = 'old';
    let failSetApiKey = false;
    let failDeleteApiKey = false;
    let failAfterCredentialFileDelete = false;
    let activateCredentialAtDelete: string | undefined;
    let activeSelectionGeneration = 0;
    let remainingCredentials = new Set(['old', 'next']);
    let runtimeApiKey: string | undefined = 'old-token';
    let authenticateActiveCredential: () => Promise<{ access_token: string } | null> = async () => ({
        access_token: 'next-token'
    });
    let notifyAuthenticationStarted: (() => void) | undefined;
    const deletedKeys: string[] = [];
    const messages: string[] = [];
    const originalRequire = NodeModule.prototype.require;

    const dependencies: Record<string, unknown> = {
        vscode: {
            Uri: { file: (value: string) => value },
            commands: { executeCommand: async () => undefined },
            window: {
                showErrorMessage: (message: string) => messages.push(message),
                showInformationMessage: (message: string) => messages.push(message),
                showWarningMessage: async (_message: string, _options: unknown, ...items: string[]) => items.at(-1)
            }
        },
        '../../utils/config/apiKeyManager': {
            ApiKeyManager: {
                setApiKey: async (_provider: string, apiKey: string) => {
                    if (failSetApiKey) {
                        throw new Error('secret storage unavailable');
                    }
                    runtimeApiKey = apiKey;
                },
                setApiKeyForActiveCliCredential: async (
                    _provider: string,
                    expectedSelection: { name: string | undefined; generation: number },
                    apiKey: string
                ) => {
                    if (
                        activeCredentialName !== expectedSelection.name ||
                        activeSelectionGeneration !== expectedSelection.generation
                    ) {
                        return false;
                    }
                    if (failSetApiKey) {
                        throw new Error('secret storage unavailable');
                    }
                    runtimeApiKey = apiKey;
                    return true;
                },
                deleteApiKey: async (provider: string) => {
                    deletedKeys.push(provider);
                    if (failDeleteApiKey) {
                        throw new Error('secret storage unavailable');
                    }
                    runtimeApiKey = undefined;
                },
                deleteApiKeyForActiveCliCredential: async (
                    _provider: string,
                    expectedSelection: { name: string | undefined; generation: number }
                ) => {
                    if (
                        activeCredentialName !== expectedSelection.name ||
                        activeSelectionGeneration !== expectedSelection.generation
                    ) {
                        return false;
                    }
                    deletedKeys.push('codex');
                    if (failDeleteApiKey) {
                        throw new Error('secret storage unavailable');
                    }
                    runtimeApiKey = undefined;
                    return true;
                },
                getApiKey: async () => runtimeApiKey
            }
        },
        '../../utils/config/configSetStore': { ConfigSetStore: {} },
        '../../utils/config/balanceWeight': { getBalanceWeight: () => undefined },
        '../../utils/config/configSetCommands': {
            applyConfigSetUnlocked() {},
            applySiteSetting() {},
            applyConfigSet() {},
            deactivateConfigSet() {},
            deactivateConfigSetUnlocked() {},
            enqueueConfigSetMutation: async (action: () => Promise<unknown>) => await action(),
            getSiteOwnerProvider: () => undefined,
            notifySlotProviderChanged() {},
            readCurrentSite() {},
            siteLabel() {}
        },
        '../../cli/auth/cliAuthFactory': {
            CliAuthFactory: {
                listOAuthCredentials: () => [...remainingCredentials].map(name => ({ name, hasAccessToken: true })),
                getCredentialSourceInfo: () => ({ source: 'oauth', name: activeCredentialName }),
                setActiveCredential: async (_provider: string, name: string) => {
                    activeCredentialName = name;
                    activeSelectionGeneration++;
                    return { name, generation: activeSelectionGeneration };
                },
                getActiveCredentialSelection: () => ({
                    name: activeCredentialName,
                    generation: activeSelectionGeneration
                }),
                ensureAuthenticated: async () => {
                    notifyAuthenticationStarted?.();
                    return await authenticateActiveCredential();
                },
                getSupportedCliTypes: () => [{ id: 'codex', name: 'Codex' }],
                getOAuthCredentialDir: () => 'C:/oauth'
            }
        },
        '../../cli/auth/oauthCredentialStore': {
            OAuthCredentialStore: {
                deleteCredentialFileWithStatus: async (_provider: string, name: string) => {
                    if (activateCredentialAtDelete) {
                        activeCredentialName = activateCredentialAtDelete;
                        activeSelectionGeneration++;
                        activateCredentialAtDelete = undefined;
                    }
                    const wasActive = name === activeCredentialName;
                    if (name === activeCredentialName) {
                        activeCredentialName = 'next';
                        activeSelectionGeneration++;
                    }
                    remainingCredentials.delete(name);
                    if (failAfterCredentialFileDelete) {
                        throw Object.assign(new Error('active selection persistence failed after delete'), {
                            credentialDeleted: true,
                            wasActive
                        });
                    }
                    return { deleted: true, wasActive };
                }
            }
        },
        '../../utils/runtime/logger': { Logger: { info() {}, warn() {}, error() {} } },
        '../../utils/runtime/l10n': {
            t: (english: string, _zh?: string, ...args: string[]) =>
                english.replace(/\{(\d+)\}/g, (_match, index: string) => args[Number(index)] ?? _match)
        },
        '../../utils/config/failover/apiKeyFailoverManager': { ApiKeyFailoverManager: {} },
        './stateHost': { collectManagedSlots: () => [] }
    };

    NodeModule.prototype.require = function (id: string): unknown {
        if (Object.hasOwn(dependencies, id)) {
            return dependencies[id];
        }
        return originalRequire.call(this, id);
    };

    let CrudHost: typeof import('./crudHost').CrudHost;
    try {
        ({ CrudHost } = await import('./crudHost'));
    } finally {
        NodeModule.prototype.require = originalRequire;
    }

    const host = new CrudHost({
        post() {},
        refreshCliProviders: async () => undefined
    } as never);

    const reset = (): void => {
        activeCredentialName = 'old';
        activeSelectionGeneration = 0;
        failSetApiKey = true;
        failDeleteApiKey = false;
        failAfterCredentialFileDelete = false;
        activateCredentialAtDelete = undefined;
        remainingCredentials = new Set(['old', 'next']);
        authenticateActiveCredential = async () => ({ access_token: 'next-token' });
        notifyAuthenticationStarted = undefined;
        runtimeApiKey = 'old-token';
        deletedKeys.length = 0;
        messages.length = 0;
    };

    await t.test('failed activation clears the previous account key', async () => {
        reset();

        await host.handleActivateCliCredential('codex', 'next');

        assert.equal(activeCredentialName, 'next');
        assert.equal(runtimeApiKey, undefined);
        assert.deepEqual(deletedKeys, ['codex']);
        assert.match(messages.at(-1) ?? '', /secret storage unavailable/);
    });

    await t.test('failed replacement after deleting the active account clears the previous key', async () => {
        reset();

        await host.handleDeleteCliCredential('codex', 'old');

        assert.equal(activeCredentialName, 'next');
        assert.equal(runtimeApiKey, undefined);
        assert.deepEqual(deletedKeys, ['codex']);
        assert.match(messages.at(-1) ?? '', /secret storage unavailable/);
        assert.match(
            messages.at(-1) ?? '',
            /account was deleted.*follow-up authentication or API key synchronization failed/i
        );
        assert.doesNotMatch(messages.at(-1) ?? '', /selection could not be updated/i);
    });

    await t.test('deletion observes an account activated by another window after the initial snapshot', async () => {
        reset();
        activeCredentialName = 'next';
        activateCredentialAtDelete = 'old';
        failSetApiKey = false;

        await host.handleDeleteCliCredential('codex', 'old');

        assert.equal(remainingCredentials.has('old'), false);
        assert.equal(activeCredentialName, 'next');
        assert.equal(runtimeApiKey, 'next-token');
        assert.deepEqual(deletedKeys, []);
    });

    await t.test('deletion does not overwrite a newer account key after authentication resumes', async () => {
        reset();
        remainingCredentials.add('other');
        failSetApiKey = false;
        let resolveAuthentication!: (credentials: { access_token: string } | null) => void;
        const authenticationStarted = new Promise<void>(resolve => {
            notifyAuthenticationStarted = resolve;
        });
        authenticateActiveCredential = async () =>
            await new Promise(resolve => {
                resolveAuthentication = resolve;
            });

        const deletion = host.handleDeleteCliCredential('codex', 'old');
        await authenticationStarted;
        activeCredentialName = 'other';
        activeSelectionGeneration++;
        runtimeApiKey = 'other-token';
        resolveAuthentication({ access_token: 'next-token' });
        await deletion;

        assert.equal(remainingCredentials.has('old'), false);
        assert.equal(activeCredentialName, 'other');
        assert.equal(runtimeApiKey, 'other-token');
        assert.match(messages.at(-1) ?? '', /active account changed in another window/i);
    });

    await t.test('deletion rejects an old key after the fallback account changes away and back', async () => {
        reset();
        remainingCredentials.add('other');
        failSetApiKey = false;
        let resolveAuthentication!: (credentials: { access_token: string } | null) => void;
        const authenticationStarted = new Promise<void>(resolve => {
            notifyAuthenticationStarted = resolve;
        });
        authenticateActiveCredential = async () =>
            await new Promise(resolve => {
                resolveAuthentication = resolve;
            });

        const deletion = host.handleDeleteCliCredential('codex', 'old');
        await authenticationStarted;
        activeCredentialName = 'other';
        activeSelectionGeneration++;
        activeCredentialName = 'next';
        activeSelectionGeneration++;
        runtimeApiKey = 'next-new-token';
        resolveAuthentication({ access_token: 'next-stale-token' });
        await deletion;

        assert.equal(activeCredentialName, 'next');
        assert.equal(runtimeApiKey, 'next-new-token');
        assert.match(messages.at(-1) ?? '', /active account changed in another window/i);
    });

    await t.test('partial active-account deletion failure clears the previous key', async () => {
        reset();
        failAfterCredentialFileDelete = true;

        await host.handleDeleteCliCredential('codex', 'old');

        assert.equal(remainingCredentials.has('old'), false);
        assert.equal(activeCredentialName, 'next');
        assert.equal(runtimeApiKey, undefined);
        assert.deepEqual(deletedKeys, ['codex']);
        assert.match(messages.at(-1) ?? '', /active selection persistence failed/i);
        assert.match(messages.at(-1) ?? '', /credential file was removed.*delete operation did not fully complete/i);
        assert.doesNotMatch(messages.at(-1) ?? '', /selection could not be updated/i);
    });

    await t.test('failed activation reports when the old key could not be cleared', async () => {
        reset();
        failDeleteApiKey = true;

        await host.handleActivateCliCredential('codex', 'next');

        assert.equal(runtimeApiKey, 'old-token');
        assert.match(messages.at(-1) ?? '', /could not be confirmed.*cleared/i);
        assert.match(messages.at(-1) ?? '', /may still be used/i);
    });
});
