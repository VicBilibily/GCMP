import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { runInNewContext } from 'node:vm';
import { transformSync } from 'esbuild';

type SettingKey =
    | 'chat.utilityModel'
    | 'chat.utilitySmallModel'
    | 'chat.byokUtilityModelDefault'
    | 'chat.editor.localAgent.enabled'
    | 'chat.defaultToCopilotHarness'
    | 'chat.editor.preferCopilotHarness';
type SettingValue = string | boolean | number | null | undefined;
type Settings = Partial<Record<SettingKey, SettingValue>>;

interface HarnessOptions {
    version?: string;
    language?: string;
    defaults?: Settings;
    global?: Settings;
    workspace?: Settings;
    selection?: number;
    failure?: 'read' | 'prompt' | 'update' | 'command';
    beforeChoice?: (global: Settings) => void;
    unavailable?: SettingKey[];
    choose?: (buttons: readonly string[]) => Promise<number | undefined>;
}

const localSettings = [
    ['chat.editor.localAgent.enabled', true],
    ['chat.defaultToCopilotHarness', false],
    ['chat.editor.preferCopilotHarness', false]
] as const;

function createHarness(kind: 'utility' | 'local' | 'startup', options: HarnessOptions = {}) {
    const defaults: Settings = {
        'chat.byokUtilityModelDefault': 'none',
        ...Object.fromEntries(localSettings),
        ...options.defaults
    };
    const global: Settings = { ...options.global };
    const workspace: Settings = { ...options.workspace };
    const messages: Array<{ text: string; buttons: string[] }> = [];
    const updates: Array<{ key: SettingKey; value: SettingValue; target: number }> = [];
    const commands: string[] = [];
    const warnings: unknown[][] = [];
    const vscode = {
        version: options.version ?? '1.138.0',
        ConfigurationTarget: { Global: 1 },
        workspace: {
            getConfiguration: () => {
                if (options.failure === 'read') {
                    throw new Error('read failed');
                }
                const snapshot = { ...defaults, ...global, ...workspace };
                return {
                    get: (key: SettingKey) => snapshot[key],
                    inspect: (key: SettingKey) =>
                        options.unavailable?.includes(key) ?
                            undefined
                        :   {
                                defaultValue: defaults[key],
                                globalValue: global[key],
                                workspaceValue: workspace[key]
                            },
                    update: async (key: SettingKey, value: SettingValue, target: number) => {
                        if (options.failure === 'update') {
                            throw new Error('update failed');
                        }
                        updates.push({ key, value, target });
                        global[key] = value;
                    }
                };
            }
        },
        window: {
            showInformationMessage: async (text: string, ...buttons: string[]) => {
                if (options.failure === 'prompt') {
                    throw new Error('prompt failed');
                }
                messages.push({ text, buttons });
                if (!buttons.length) {
                    return undefined;
                }
                options.beforeChoice?.(global);
                const selection = options.choose ? await options.choose(buttons) : options.selection;
                return selection === undefined ? undefined : buttons[selection];
            }
        },
        commands: {
            executeCommand: async (command: string) => {
                if (options.failure === 'command') {
                    throw new Error('command failed');
                }
                commands.push(command);
            }
        }
    };
    const module: { exports: Record<string, () => Promise<void>> } = { exports: {} };
    const filename = 'startupWizard.ts';
    const source =
        readFileSync(new URL(filename, import.meta.url), 'utf8') +
        (kind === 'startup' ? '' : (
            '\nexport { runStartupUtilityModelWizardIfNeeded, runStartupLocalAgentWizardIfNeeded };'
        ));
    runInNewContext(
        transformSync(source, { loader: 'ts', format: 'cjs', target: 'es2022' }).code,
        {
            module,
            exports: module.exports,
            require: (id: string): unknown => {
                if (id === 'vscode') {
                    return vscode;
                }
                if (id === '../utils/runtime/logger') {
                    return { Logger: { warn: (...args: unknown[]) => warnings.push(args) } };
                }
                if (id === '../utils/runtime/l10n') {
                    return {
                        t: (english: string, chinese: string, ...args: unknown[]) => {
                            let text = options.language === 'zh-cn' ? chinese : english;
                            args.forEach((value, index) => {
                                text = text.split(`{${index}}`).join(String(value));
                            });
                            return text;
                        }
                    };
                }
                throw new Error(`Unexpected dependency: ${id}`);
            }
        },
        { filename, timeout: 1000 }
    );
    const entryPoint = {
        utility: 'runStartupUtilityModelWizardIfNeeded',
        local: 'runStartupLocalAgentWizardIfNeeded',
        startup: 'runStartupWizardIfNeeded'
    }[kind];
    const run = module.exports[entryPoint];
    assert.equal(typeof run, 'function');
    return { run, messages, updates, commands, warnings, global, workspace, exportNames: Object.keys(module.exports) };
}

test('activation schedules one startup wizard after registering auxiliary preferences', () => {
    const source = readFileSync(new URL('../extension.ts', import.meta.url), 'utf8');
    const registration = source.indexOf('registerAuxiliaryModelSettingsCommands(context);');
    const call = source.indexOf('void runStartupWizardIfNeeded();');
    assert.ok(registration >= 0 && call > registration);
    assert.doesNotMatch(source, /await runStartupWizardIfNeeded\(/);
    assert.doesNotMatch(source, /startupUtilityModelWizard|startupLocalAgentWizard/);
});

test('startup wizard exposes one entry point and skips already configured preferences', async () => {
    const harness = createHarness('startup', {
        global: { 'chat.byokUtilityModelDefault': 'mainAgent', 'chat.editor.preferCopilotHarness': true }
    });
    assert.deepEqual(harness.exportNames, ['runStartupWizardIfNeeded']);
    await harness.run();
    assert.deepEqual(harness.messages, []);
    assert.deepEqual(harness.updates, []);
});

test('startup wizard waits for the utility choice before prompting for Local Agent', async () => {
    const decision: { resolve?: (selection: number) => void } = {};
    const utilityChoice = new Promise<number>(resolve => {
        decision.resolve = resolve;
    });
    const harness = createHarness('startup', {
        choose: buttons => (buttons.includes('Follow Main Agent') ? utilityChoice : Promise.resolve(0))
    });
    const pending = harness.run();
    assert.equal(harness.messages.length, 1);
    assert.ok(harness.messages[0].buttons.includes('Follow Main Agent'));
    assert.deepEqual(harness.updates, []);
    assert.ok(decision.resolve);
    decision.resolve(1);
    await pending;
    assert.equal(harness.messages.length, 4);
    assert.ok(harness.messages[2].buttons.includes('Use Local Agent (Recommended)'));
    assert.deepEqual(harness.updates, [
        { key: 'chat.byokUtilityModelDefault', value: 'mainAgent', target: 1 },
        ...localSettings.map(([key, value]) => ({ key, value, target: 1 }))
    ]);
});

test('startup wizard continues to Local Agent after a utility settings failure', async () => {
    const harness = createHarness('startup', {
        failure: 'update',
        choose: async buttons => (buttons.includes('Follow Main Agent') ? 1 : 0)
    });
    await assert.doesNotReject(harness.run());
    assert.equal(harness.messages.length, 2);
    assert.equal(harness.warnings.length, 2);
    assert.match(String(harness.warnings[0][0]), /StartupUtilityGuide/);
    assert.match(String(harness.warnings[1][0]), /StartupLocalAgentGuide/);
    assert.deepEqual(harness.updates, []);
});

test('startup wizard still checks Local Agent when utility settings are unavailable', async () => {
    const harness = createHarness('startup', {
        unavailable: ['chat.utilityModel'],
        selection: 0
    });
    await harness.run();
    assert.equal(harness.messages.length, 2);
    assert.deepEqual(
        harness.updates,
        localSettings.map(([key, value]) => ({ key, value, target: 1 }))
    );
});

for (const [version, shouldPrompt] of [
    ['1.127.9', false],
    ['1.128.0', true],
    ['1.128.0-insider', true],
    ['1.138.0', true],
    ['2.0.0', true]
] as const) {
    test(`utility guide version gate: ${version}`, async () => {
        const harness = createHarness('utility', {
            version,
            global: { 'chat.byokUtilityModelDefault': 'none' }
        });
        await harness.run();
        assert.equal(harness.messages.length, shouldPrompt ? 1 : 0);
        assert.deepEqual(harness.updates, []);
        if (shouldPrompt) {
            assert.ok(harness.messages[0].text.includes(version));
        }
    });
}

test('manifest does not override utility or chat mode defaults owned by other extensions', () => {
    const manifest = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8')) as {
        contributes: { configurationDefaults?: Settings };
    };
    for (const key of ['chat.byokUtilityModelDefault', ...localSettings.map(([key]) => key)]) {
        assert.equal(Object.hasOwn(manifest.contributes.configurationDefaults ?? {}, key), false, key);
    }
});

test('utility guide prompts for a fresh profile without writing a fallback automatically', async () => {
    const harness = createHarness('utility');
    await harness.run();
    assert.equal(harness.messages.length, 1);
    assert.deepEqual(harness.updates, []);
});

test('utility guide skips an explicitly configured mainAgent fallback', async () => {
    const harness = createHarness('utility', { global: { 'chat.byokUtilityModelDefault': 'mainAgent' } });
    await harness.run();
    assert.deepEqual(harness.messages, []);
    assert.deepEqual(harness.updates, []);
});

for (const key of ['chat.utilityModel', 'chat.utilitySmallModel', 'chat.byokUtilityModelDefault'] as const) {
    test(`utility guide skips when ${key} is not registered`, async () => {
        const harness = createHarness('utility', { unavailable: [key], selection: 1 });
        await harness.run();
        assert.deepEqual(harness.messages, []);
        assert.deepEqual(harness.updates, []);
    });
}

test('utility guide skips two explicitly configured models', async () => {
    const harness = createHarness('utility', {
        global: {
            'chat.byokUtilityModelDefault': 'none',
            'chat.utilityModel': 'gcmp/provider/model',
            'chat.utilitySmallModel': 'gcmp/provider/small'
        }
    });
    await harness.run();
    assert.deepEqual(harness.messages, []);
});

for (const key of ['chat.utilityModel', 'chat.utilitySmallModel'] as const) {
    for (const value of [undefined, '', '   ', false, 42, null]) {
        test(`utility guide prompts for ${key}=${String(value)} when fallback is disabled`, async () => {
            const harness = createHarness('utility', {
                global: {
                    'chat.byokUtilityModelDefault': 'none',
                    'chat.utilityModel': 'configured',
                    'chat.utilitySmallModel': 'configured',
                    [key]: value
                }
            });
            await harness.run();
            assert.equal(harness.messages.length, 1);
            assert.deepEqual(harness.updates, []);
        });
    }
}

for (const language of ['en', 'zh-cn']) {
    test(`utility guide opens manual settings without writing (${language})`, async () => {
        const harness = createHarness('utility', {
            language,
            global: { 'chat.byokUtilityModelDefault': 'none' },
            selection: 0
        });
        await harness.run();
        assert.deepEqual(harness.commands, ['gcmp.modelSettings.wizard']);
        assert.deepEqual(harness.updates, []);
        assert.match(harness.messages[0].buttons[0], /Recommended|推荐/);
    });

    test(`utility guide follows the main agent only after confirmation (${language})`, async () => {
        const harness = createHarness('utility', {
            language,
            global: { 'chat.byokUtilityModelDefault': 'none' },
            selection: 1
        });
        await harness.run();
        assert.deepEqual(harness.updates, [{ key: 'chat.byokUtilityModelDefault', value: 'mainAgent', target: 1 }]);
        assert.equal(harness.messages.length, 2);
        assert.deepEqual(harness.commands, []);
    });
}

test('Local Agent guide prompts for unset global preferences even when host defaults already match', async () => {
    const harness = createHarness('local');
    await harness.run();
    assert.equal(harness.messages.length, 1);
    assert.deepEqual(harness.updates, []);
});

test('Local Agent guide prompts for incompatible host defaults and writes only after confirmation', async () => {
    const defaults = Object.fromEntries(localSettings.map(([key, value]) => [key, !value]));
    const dismissed = createHarness('local', { defaults });
    await dismissed.run();
    assert.equal(dismissed.messages.length, 1);
    assert.deepEqual(dismissed.updates, []);
    const confirmed = createHarness('local', { defaults, selection: 0 });
    await confirmed.run();
    assert.deepEqual(
        confirmed.updates,
        localSettings.map(([key, value]) => ({ key, value, target: 1 }))
    );
});

test('Local Agent guide skips unregistered settings without attempting to write them', async () => {
    const harness = createHarness('local', {
        global: { 'chat.editor.preferCopilotHarness': true },
        unavailable: localSettings.map(([key]) => key),
        selection: 0
    });
    await harness.run();
    assert.deepEqual(harness.messages, []);
    assert.deepEqual(harness.updates, []);
});

test('Local Agent guide does not treat a registered setting with no default as configured', async () => {
    const harness = createHarness('local', {
        defaults: { 'chat.editor.localAgent.enabled': undefined },
        selection: 0
    });
    await harness.run();
    assert.deepEqual(
        harness.updates,
        localSettings.map(([key, value]) => ({ key, value, target: 1 }))
    );
});

for (const [key, expected] of localSettings) {
    for (const value of [false, true]) {
        test(`Local Agent guide respects explicit global ${key}=${value}`, async () => {
            const global = { [key]: value };
            const harness = createHarness('local', { global, selection: 0 });
            await harness.run();
            assert.deepEqual(harness.messages, []);
            assert.deepEqual(harness.updates, []);
            assert.deepEqual(harness.global, global);
        });
    }

    test(`Local Agent guide does not treat workspace ${key} as an explicit global preference`, async () => {
        const workspace = { [key]: !expected };
        const harness = createHarness('local', { workspace, selection: 0 });
        await harness.run();
        assert.equal(harness.messages.length, 2);
        assert.deepEqual(
            harness.updates,
            localSettings.map(([key, value]) => ({ key, value, target: 1 }))
        );
        assert.deepEqual(harness.workspace, workspace);
        await harness.run();
        assert.equal(harness.messages.length, 2);
        assert.equal(harness.updates.length, localSettings.length);
    });
}

for (const language of ['en', 'zh-cn']) {
    test(`Local Agent confirmation updates all three global settings and preserves workspace (${language})`, async () => {
        const workspace = Object.fromEntries(localSettings.map(([key, value]) => [key, !value]));
        const harness = createHarness('local', { language, workspace, selection: 0 });
        await harness.run();
        assert.deepEqual(
            harness.updates,
            localSettings.map(([key, value]) => ({ key, value, target: 1 }))
        );
        assert.deepEqual(harness.workspace, workspace);
        assert.match(harness.messages[0].text, /switching to the default Local Agent|切换到默认的 Local Agent/);
        assert.match(harness.messages[1].text, /Existing chats|现有会话/);
        for (const message of harness.messages) {
            assert.doesNotMatch(message.text, /workspace|工作区/i);
        }
    });
}

test('Local Agent dismissal leaves all preferences unchanged', async () => {
    const harness = createHarness('local');
    await harness.run();
    assert.equal(harness.messages.length, 1);
    assert.deepEqual(harness.global, {});
    assert.deepEqual(harness.updates, []);
    assert.deepEqual(harness.commands, []);
});

test('Local Agent manual action opens auxiliary preferences without writing', async () => {
    const harness = createHarness('local', {
        selection: 1
    });
    await harness.run();
    assert.deepEqual(harness.commands, ['gcmp.modelSettings.wizard']);
    assert.deepEqual(harness.updates, []);
});

test('Local Agent confirmation preserves explicit preferences set while the prompt was open', async () => {
    const harness = createHarness('local', {
        selection: 0,
        beforeChoice: global => {
            global['chat.editor.preferCopilotHarness'] = false;
            global['chat.editor.localAgent.enabled'] = false;
        }
    });
    await harness.run();
    assert.deepEqual(harness.updates, []);
    assert.deepEqual(harness.global, {
        'chat.editor.preferCopilotHarness': false,
        'chat.editor.localAgent.enabled': false
    });
    assert.equal(harness.messages.length, 1);
});

for (const kind of ['utility', 'local'] as const) {
    for (const failure of ['read', 'prompt', 'update', 'command'] as const) {
        test(`${kind} guide catches ${failure} errors without rejecting activation`, async () => {
            const autoChoice = kind === 'utility' ? 1 : 0;
            const manualChoice = kind === 'utility' ? 0 : 1;
            const harness = createHarness(kind, {
                failure,
                global: { 'chat.byokUtilityModelDefault': 'none' },
                selection: failure === 'command' ? manualChoice : autoChoice
            });
            await assert.doesNotReject(harness.run());
            assert.equal(harness.warnings.length, 1);
            assert.ok(harness.warnings[0][0]?.toString().includes(kind === 'utility' ? 'Utility' : 'LocalAgent'));
            assert.ok(harness.messages.length <= 1);
        });
    }
}
