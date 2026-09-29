import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import test from 'node:test';

const require = createRequire(import.meta.url);
const NodeModule = require('node:module') as {
    prototype: { require: (id: string) => unknown };
};

test('CLI auth command stores the local runtime key', async t => {
    let selected: { label: string; cliType: string } | undefined;
    let credentials: { access_token?: string } | null = null;
    const storedKeys: Array<{ provider: string; apiKey: string }> = [];
    const messages: string[] = [];
    let command: (() => Promise<void>) | undefined;

    const originalRequire = NodeModule.prototype.require;
    NodeModule.prototype.require = function (id: string): unknown {
        if (id === 'vscode') {
            return {
                commands: {
                    registerCommand: (_command: string, callback: () => Promise<void>) => {
                        command = callback;
                        return { dispose: (): void => undefined };
                    }
                },
                window: {
                    showQuickPick: async () => selected,
                    showInformationMessage: (message: string) => messages.push(message),
                    showErrorMessage: (message: string) => messages.push(message)
                }
            };
        }
        if (/cliAuthFactory(?:\.ts)?$/.test(id)) {
            return {
                CliAuthFactory: {
                    getSupportedCliTypes: () => [{ id: 'codex', name: 'Codex' }],
                    ensureAuthenticated: async () => credentials
                }
            };
        }
        if (/apiKeyManager(?:\.ts)?$/.test(id)) {
            return {
                ApiKeyManager: {
                    setApiKey: async (provider: string, apiKey: string) => {
                        storedKeys.push({ provider, apiKey });
                    }
                }
            };
        }
        if (/(?:^|\/)l10n(?:\.ts)?$/.test(id)) {
            return { t: (english: string) => english };
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
    assert.ok(command);

    await t.test('stores access token before reporting success', async () => {
        selected = { label: 'Codex', cliType: 'codex' };
        credentials = { access_token: 'oauth-token' };

        await command!();

        assert.deepEqual(storedKeys, [{ provider: 'codex', apiKey: 'oauth-token' }]);
        assert.match(messages.at(-1) ?? '', /authenticated successfully/);
    });

    await t.test('does not report credentials without an access token as success', async () => {
        storedKeys.length = 0;
        messages.length = 0;
        credentials = {};

        await command!();

        assert.deepEqual(storedKeys, []);
        assert.match(messages.at(-1) ?? '', /authentication failed/);
    });
});
