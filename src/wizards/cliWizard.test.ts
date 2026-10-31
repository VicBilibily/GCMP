import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { runInNewContext } from 'node:vm';
import { transformSync } from 'esbuild';

interface NativeCredentials {
    access_token?: string;
    refresh_token?: string;
}

function createHarness(nativeCredentials: NativeCredentials | null) {
    let quickPickItems: Array<{ action: string }> = [];
    const vscode = {
        window: {
            showQuickPick: async (items: Array<{ action: string }>) => {
                quickPickItems = items;
                return undefined;
            }
        },
        commands: { executeCommand: async () => undefined }
    };
    const dependencies: Record<string, unknown> = {
        vscode,
        '../utils/runtime/logger': { Logger: { debug: () => undefined, error: () => undefined } },
        '../utils/config/apiKeyManager': { ApiKeyManager: {} },
        '../cli/auth/cliAuthFactory': {
            CliAuthFactory: {
                getCredentialSourceInfo: () => ({ source: 'cli' }),
                listOAuthCredentials: () => [],
                getInstance: () => ({ loadCliNativeCredentials: async () => nativeCredentials }),
                loadCredentials: async () => ({ access_token: 'active-token' }),
                getSupportedCliTypes: () => [{ id: 'codex', name: 'Codex' }]
            }
        },
        '../utils/runtime/l10n': { t: (english: string) => english }
    };
    const module: { exports: Record<string, unknown> } = { exports: {} };
    const runtimeRequire = createRequire(import.meta.url);
    const source = readFileSync(new URL('./cliWizard.ts', import.meta.url), 'utf8');

    runInNewContext(
        transformSync(source, { loader: 'ts', format: 'cjs', target: 'es2022' }).code,
        {
            module,
            exports: module.exports,
            require: (id: string): unknown => dependencies[id] ?? runtimeRequire(id)
        },
        { filename: 'cliWizard.ts', timeout: 1000 }
    );

    const wizard = module.exports.CliWizard as {
        startWizard: (provider: string, displayName: string) => Promise<void>;
    };
    return {
        showMenu: () => wizard.startWizard('codex', 'Codex'),
        actions: () => quickPickItems.map(item => item.action)
    };
}

test('CLI wizard only offers import when an access token is available', async t => {
    await t.test('hides import for refresh-token-only credentials', async () => {
        const harness = createHarness({ refresh_token: 'refresh-token' });
        await harness.showMenu();
        assert.equal(harness.actions().includes('import'), false);
    });

    await t.test('keeps import for credentials with an access token', async () => {
        const harness = createHarness({ access_token: 'access-token', refresh_token: 'refresh-token' });
        await harness.showMenu();
        assert.equal(harness.actions().includes('import'), true);
    });
});
