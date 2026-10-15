import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { runInNewContext } from 'node:vm';
import * as vscode from 'vscode';
import { AuxiliaryModelSettingsPanel } from '../../src/ui/auxiliaryModelSettings';
import type {
    AuxiliaryProviderData,
    FormValues,
    HostMessage,
    WebViewMessage
} from '../../src/ui/auxiliaryModelSettings/types';

const preferenceKey = 'chat.editor.preferCopilotHarness';
const defaultHarnessKey = 'chat.defaultToCopilotHarness';
const preferenceKeys = [preferenceKey, defaultHarnessKey];
const localAgentKey = 'chat.editor.localAgent.enabled';
const modeKeys = [...preferenceKeys, localAgentKey];
const modelKeys = [
    'gcmp.commit.model',
    'gcmp.vision.model',
    'chat.utilityModel',
    'chat.utilitySmallModel',
    'inlineChat.defaultModel',
    'chat.planAgent.defaultModel',
    'chat.exploreAgent.defaultModel',
    'github.copilot.chat.askAgent.model',
    'github.copilot.chat.implementAgent.model',
    'github.copilot.chat.exploreAgent.model'
];

interface PanelHarness {
    panel: { webview: { postMessage(message: HostMessage): void } };
    getProviders(): Promise<AuxiliaryProviderData[]>;
    handleMessage(message: WebViewMessage): Promise<void>;
    confirmAgentOverwriteIfNeeded(): Promise<boolean>;
    getWebviewContent(webview: Pick<vscode.Webview, 'cspSource'>): string;
}

function formValues(preferCopilotHarness: boolean) {
    return { preferCopilotHarness, commit: null, vision: null, utility: null, utilitySmall: null, agent: null };
}

function createPanel(): { panel: PanelHarness; messages: HostMessage[] } {
    const extension = vscode.extensions.getExtension('vicanent.gcmp');
    assert.ok(extension);
    const context = { extensionPath: extension.extensionPath, subscriptions: [] } as unknown as vscode.ExtensionContext;
    const panel = new AuxiliaryModelSettingsPanel(context) as unknown as PanelHarness;
    const messages: HostMessage[] = [];
    panel.panel = {
        webview: { postMessage: message => messages.push(JSON.parse(JSON.stringify(message)) as HostMessage) }
    };
    panel.getProviders = async () => [];
    return { panel, messages };
}

class PreferenceElement {
    readonly children: PreferenceElement[] = [];
    readonly dataset: Record<string, string> = {};
    readonly attributes = new Map<string, string>();
    readonly listeners = new Map<string, () => void>();
    id = '';
    className = '';
    textContent = '';
    innerHTML = '';

    constructor(readonly tagName: string) {}

    appendChild(child: PreferenceElement): void {
        this.children.push(child);
    }

    setAttribute(key: string, value: string): void {
        this.attributes.set(key, value);
    }

    addEventListener(type: string, listener: () => void): void {
        this.listeners.set(type, listener);
    }
}

function mountPreferenceWebview(initial: Extract<HostMessage, { command: 'init' }>, language: string) {
    const extension = vscode.extensions.getExtension('vicanent.gcmp');
    assert.ok(extension);
    const root = new PreferenceElement('div');
    const elements: PreferenceElement[] = [];
    const messages: WebViewMessage[] = [];
    let receiveMessage: ((event: { data: HostMessage }) => void) | undefined;
    runInNewContext(
        readFileSync(join(extension.extensionPath, 'dist', 'ui', 'auxiliaryModelSettings.js'), 'utf8'),
        {
            window: {
                vscode: {
                    postMessage: (message: WebViewMessage) =>
                        messages.push(JSON.parse(JSON.stringify(message)) as WebViewMessage)
                },
                addEventListener: (_type: string, listener: (event: { data: HostMessage }) => void) => {
                    receiveMessage = listener;
                }
            },
            document: {
                documentElement: { lang: language },
                head: new PreferenceElement('head'),
                getElementById: () => root,
                createElement: (tagName: string) => {
                    const element = new PreferenceElement(tagName);
                    elements.push(element);
                    return element;
                },
                addEventListener: () => {}
            }
        },
        { timeout: 1000 }
    );
    assert.ok(receiveMessage);
    receiveMessage({ data: initial });
    const modeSwitch = elements.find(element => element.attributes.get('role') === 'switch');
    const localLabel = elements.find(element => element.textContent === 'Local Agent');
    const harnessLabel = elements.find(element => element.textContent === 'Copilot Harness');
    const description = elements.find(element => element.id === 'harness-preference-description');
    const save = elements.find(element => element.className.split(' ').includes('ams-button-primary'));
    assert.ok(modeSwitch);
    assert.ok(localLabel);
    assert.ok(harnessLabel);
    assert.ok(description);
    assert.ok(save);
    assert.equal(
        elements.some(element => element.tagName === 'input'),
        false
    );
    assert.equal(
        modeSwitch.attributes.get('aria-label'),
        language === 'zh-cn' ? '使用 Copilot Harness' : 'Use Copilot Harness'
    );
    return {
        elements,
        modeSwitch,
        localLabel,
        harnessLabel,
        description,
        submit(useHarness: boolean): Extract<WebViewMessage, { command: 'save' }> {
            if (modeSwitch.attributes.get('aria-checked') !== String(useHarness)) {
                modeSwitch.listeners.get('click')?.();
            }
            assert.equal(modeSwitch.attributes.get('aria-checked'), String(useHarness));
            assert.equal(harnessLabel.className.includes('is-active'), useHarness);
            assert.equal(localLabel.className.includes('is-active'), !useHarness);
            save.listeners.get('click')?.();
            const message = messages.at(-1);
            assert.ok(message?.command === 'save');
            return message;
        }
    };
}

suite('auxiliary preferences', () => {
    const originals = new Map<string, { globalValue: unknown; workspaceValue: unknown }>();

    suiteSetup(() => {
        const config = vscode.workspace.getConfiguration();
        for (const key of [...modeKeys, ...modelKeys]) {
            const value = config.inspect(key);
            originals.set(key, { globalValue: value?.globalValue, workspaceValue: value?.workspaceValue });
        }
    });

    setup(async () => {
        const config = vscode.workspace.getConfiguration();
        for (const key of [...modeKeys, ...modelKeys]) {
            if (config.inspect(key)?.globalValue !== undefined) {
                await config.update(key, undefined, vscode.ConfigurationTarget.Global);
            }
        }
        for (const key of modeKeys) {
            if (config.inspect(key)?.workspaceValue !== undefined) {
                await config.update(key, undefined, vscode.ConfigurationTarget.Workspace);
            }
        }
    });

    suiteTeardown(async () => {
        const config = vscode.workspace.getConfiguration();
        for (const [key, value] of originals) {
            await config.update(key, value.globalValue, vscode.ConfigurationTarget.Global);
        }
        for (const key of modeKeys) {
            await config.update(key, originals.get(key)?.workspaceValue, vscode.ConfigurationTarget.Workspace);
        }
    });

    test('uses host defaults without writing explicit user or workspace settings', () => {
        const config = vscode.workspace.getConfiguration();
        for (const key of preferenceKeys) {
            const value = config.inspect<boolean>(key);
            assert.equal(config.get(key), value?.defaultValue);
            assert.equal(value?.globalValue, undefined);
            assert.equal(value?.workspaceValue, undefined);
        }
    });

    for (const [globalValue, workspaceValue] of [
        [undefined, undefined],
        [false, undefined],
        [true, undefined],
        [undefined, false],
        [undefined, true],
        [true, false],
        [false, true]
    ] as const) {
        test(`initial preference uses global=${globalValue} and ignores workspace=${workspaceValue}`, async () => {
            const config = vscode.workspace.getConfiguration();
            await config.update(preferenceKey, globalValue, vscode.ConfigurationTarget.Global);
            await config.update(preferenceKey, workspaceValue, vscode.ConfigurationTarget.Workspace);
            const { panel, messages } = createPanel();
            await panel.handleMessage({ command: 'getInitialData' });
            const message = messages.at(-1);
            assert.ok(message?.command === 'init');
            assert.ok('preferCopilotHarness' in message.initialValues);
            assert.equal(
                message.initialValues.preferCopilotHarness,
                globalValue ?? config.inspect<boolean>(preferenceKey)?.defaultValue ?? false
            );
            assert.equal(config.inspect(preferenceKey)?.globalValue, globalValue);
            assert.equal(config.inspect(preferenceKey)?.workspaceValue, workspaceValue);
        });
    }

    for (const value of [true, false]) {
        test(`saves both linked preferences as ${value}`, async () => {
            const config = vscode.workspace.getConfiguration();
            for (const key of preferenceKeys) {
                await config.update(key, !value, vscode.ConfigurationTarget.Global);
            }
            const { panel, messages } = createPanel();
            await panel.handleMessage({ command: 'save', values: formValues(value) });
            assert.deepEqual(messages.at(-1), { command: 'saved', success: true });
            const current = vscode.workspace.getConfiguration();
            for (const key of preferenceKeys) {
                assert.equal(current.inspect(key)?.globalValue, value);
                assert.equal(current.get(key), value);
            }
        });
    }

    test('saving models preserves matching host defaults and aligns differing linked defaults', async () => {
        const config = vscode.workspace.getConfiguration();
        const selected = config.inspect<boolean>(preferenceKey)?.defaultValue ?? false;
        const { panel, messages } = createPanel();
        await panel.handleMessage({ command: 'save', values: formValues(selected) });
        assert.deepEqual(messages.at(-1), { command: 'saved', success: true });
        const current = vscode.workspace.getConfiguration();
        for (const key of preferenceKeys) {
            assert.equal(
                current.inspect(key)?.globalValue,
                (config.inspect<boolean>(key)?.defaultValue ?? false) === selected ? undefined : selected
            );
            assert.equal(current.inspect(key)?.workspaceValue, undefined);
        }
    });

    test('saving the host preference preserves workspace overrides and matching defaults', async () => {
        const config = vscode.workspace.getConfiguration();
        const selected = config.inspect<boolean>(preferenceKey)?.defaultValue ?? false;
        for (const key of preferenceKeys) {
            await config.update(key, !selected, vscode.ConfigurationTarget.Workspace);
        }
        const { panel, messages } = createPanel();
        await panel.handleMessage({ command: 'save', values: formValues(selected) });
        assert.deepEqual(messages.at(-1), { command: 'saved', success: true });
        const current = vscode.workspace.getConfiguration();
        for (const key of preferenceKeys) {
            assert.equal(
                current.inspect(key)?.globalValue,
                (config.inspect<boolean>(key)?.defaultValue ?? false) === selected ? undefined : selected
            );
            assert.equal(current.inspect(key)?.workspaceValue, !selected);
        }
    });

    test('choosing Local Agent enables it globally without changing its workspace override', async () => {
        const config = vscode.workspace.getConfiguration();
        await config.update(localAgentKey, false, vscode.ConfigurationTarget.Global);
        await config.update(localAgentKey, false, vscode.ConfigurationTarget.Workspace);
        const { panel, messages } = createPanel();
        await panel.handleMessage({ command: 'save', values: formValues(false) });
        assert.deepEqual(messages.at(-1), { command: 'saved', success: true });
        const current = vscode.workspace.getConfiguration();
        assert.equal(current.inspect(localAgentKey)?.globalValue, true);
        assert.equal(current.inspect(localAgentKey)?.workspaceValue, false);
        for (const key of preferenceKeys) {
            const preference = current.inspect<boolean>(key);
            assert.equal(preference?.globalValue ?? preference?.defaultValue ?? false, false);
        }
    });

    test('choosing Copilot Harness does not disable or enable Local Agent', async () => {
        const config = vscode.workspace.getConfiguration();
        await config.update(localAgentKey, false, vscode.ConfigurationTarget.Global);
        const { panel, messages } = createPanel();
        await panel.handleMessage({ command: 'save', values: formValues(true) });
        assert.deepEqual(messages.at(-1), { command: 'saved', success: true });
        assert.equal(vscode.workspace.getConfiguration().inspect(localAgentKey)?.globalValue, false);
    });

    test('extension activation schedules the unified startup wizard without blocking', () => {
        const extension = vscode.extensions.getExtension('vicanent.gcmp');
        assert.ok(extension);
        const source = readFileSync(join(extension.extensionPath, 'src', 'extension.ts'), 'utf8');
        assert.match(source, /void runStartupWizardIfNeeded\(\)/);
        assert.doesNotMatch(source, /startupUtilityModelWizard|startupLocalAgentWizard/);
    });

    for (const language of ['zh-cn', 'en']) {
        test(`${language} keeps utility model selectors without the legacy setup warning`, async () => {
            const { panel, messages } = createPanel();
            await panel.handleMessage({ command: 'getInitialData' });
            const initial = messages.at(-1);
            assert.ok(initial?.command === 'init');
            const webview = mountPreferenceWebview(initial, language);
            assert.equal(
                webview.elements.some(element => element.className.split(' ').includes('ams-warning-box')),
                false
            );
            assert.equal(
                webview.elements.some(element => element.textContent.includes('No utility model is configured')),
                false
            );
            for (const key of ['utility', 'utilitySmall']) {
                const row = webview.elements.find(element => element.dataset.key === key);
                assert.ok(row);
                assert.ok(row.children.some(element => element.className === 'ams-row-controls'));
            }
        });

        test(`${language} explains mode preferences and compatibility without a version notice`, async () => {
            const { panel, messages } = createPanel();
            await panel.handleMessage({ command: 'getInitialData' });
            const initial = messages.at(-1);
            assert.ok(initial?.command === 'init');
            const webview = mountPreferenceWebview(initial, language);
            assert.doesNotMatch(webview.description.textContent, /1\.140/);
            assert.match(webview.description.textContent, language === 'zh-cn' ? /使用偏好/ : /preferences/);
            assert.match(
                webview.description.textContent,
                language === 'zh-cn' ? /Local Agent.*兼容性更好/ : /Local Agent.*better compatibility/
            );
            assert.match(
                webview.description.textContent,
                language === 'zh-cn' ? /Copilot Harness.*兼容性问题/ : /Copilot Harness.*compatibility issues/
            );
        });

        for (const original of [undefined, false, true]) {
            for (const useHarness of [false, true]) {
                test(`${language} mode switch round trip: setting=${original}, harness=${useHarness}`, async () => {
                    await vscode.workspace
                        .getConfiguration()
                        .update(preferenceKey, original, vscode.ConfigurationTarget.Global);
                    const { panel, messages } = createPanel();
                    await panel.handleMessage({ command: 'getInitialData' });
                    const initial = messages.at(-1);
                    assert.ok(initial?.command === 'init');
                    const webview = mountPreferenceWebview(initial, language);
                    const nativePreference = vscode.workspace
                        .getConfiguration()
                        .inspect<boolean>(preferenceKey)?.defaultValue;
                    const nativeDefault = vscode.workspace
                        .getConfiguration()
                        .inspect<boolean>(defaultHarnessKey)?.defaultValue;
                    const initialPreference = original ?? nativePreference ?? false;
                    assert.equal(webview.modeSwitch.attributes.get('aria-checked'), String(initialPreference));
                    assert.equal(webview.harnessLabel.className.includes('is-active'), initialPreference);
                    assert.equal(webview.localLabel.className.includes('is-active'), !initialPreference);
                    const submitted = webview.submit(useHarness);
                    assert.equal(submitted.values.preferCopilotHarness, useHarness);
                    await panel.handleMessage(submitted);
                    assert.deepEqual(messages.at(-1), { command: 'saved', success: true });
                    const current = vscode.workspace.getConfiguration();
                    assert.equal(current.get(preferenceKey), useHarness);
                    assert.equal(
                        current.inspect(preferenceKey)?.globalValue,
                        original === undefined && (nativePreference ?? false) === useHarness ? undefined : useHarness
                    );
                    assert.equal(current.inspect(preferenceKey)?.workspaceValue, undefined);
                    assert.equal(current.get(defaultHarnessKey), useHarness);
                    assert.equal(
                        current.inspect(defaultHarnessKey)?.globalValue,
                        (nativeDefault ?? false) === useHarness ? undefined : useHarness
                    );
                    assert.equal(current.inspect(defaultHarnessKey)?.workspaceValue, undefined);
                });
            }
        }
    }

    for (const useHarness of [false, true]) {
        for (const [preferenceInWorkspace, defaultInWorkspace] of [
            [false, false],
            [false, true],
            [true, false],
            [true, true]
        ] as const) {
            test(`repairs global default=${!useHarness} with unchanged preference=${useHarness}, ignoring workspace=${preferenceInWorkspace}/${defaultInWorkspace}`, async () => {
                const config = vscode.workspace.getConfiguration();
                await config.update(preferenceKey, useHarness, vscode.ConfigurationTarget.Global);
                await config.update(defaultHarnessKey, !useHarness, vscode.ConfigurationTarget.Global);
                if (preferenceInWorkspace) {
                    await config.update(preferenceKey, !useHarness, vscode.ConfigurationTarget.Workspace);
                }
                if (defaultInWorkspace) {
                    await config.update(defaultHarnessKey, useHarness, vscode.ConfigurationTarget.Workspace);
                }
                const { panel, messages } = createPanel();
                await panel.handleMessage({ command: 'save', values: formValues(useHarness) });
                assert.deepEqual(messages.at(-1), { command: 'saved', success: true });
                const current = vscode.workspace.getConfiguration();
                assert.equal(current.inspect(preferenceKey)?.globalValue, useHarness);
                assert.equal(current.inspect(defaultHarnessKey)?.globalValue, useHarness);
                assert.equal(
                    current.inspect(preferenceKey)?.workspaceValue,
                    preferenceInWorkspace ? !useHarness : undefined
                );
                assert.equal(
                    current.inspect(defaultHarnessKey)?.workspaceValue,
                    defaultInWorkspace ? useHarness : undefined
                );
            });
        }
    }

    for (const value of [false, true]) {
        test(`saving unchanged global preference ${value} preserves workspace overrides`, async () => {
            const config = vscode.workspace.getConfiguration();
            for (const key of preferenceKeys) {
                await config.update(key, value, vscode.ConfigurationTarget.Global);
                await config.update(key, !value, vscode.ConfigurationTarget.Workspace);
            }
            const { panel, messages } = createPanel();
            await panel.handleMessage({ command: 'getInitialData' });
            const initial = messages.at(-1);
            assert.ok(initial?.command === 'init');
            assert.equal(initial.initialValues.preferCopilotHarness, value);
            await panel.handleMessage({ command: 'save', values: formValues(value) });
            assert.deepEqual(messages.at(-1), { command: 'saved', success: true });
            const current = vscode.workspace.getConfiguration();
            for (const key of preferenceKeys) {
                assert.equal(current.inspect(key)?.workspaceValue, !value);
                assert.equal(current.inspect(key)?.globalValue, value);
            }
        });
    }

    test('changing global preferences saves both even when workspace overrides already match', async () => {
        const config = vscode.workspace.getConfiguration();
        for (const key of preferenceKeys) {
            await config.update(key, false, vscode.ConfigurationTarget.Global);
            await config.update(key, true, vscode.ConfigurationTarget.Workspace);
        }
        const { panel, messages } = createPanel();
        await panel.handleMessage({ command: 'save', values: formValues(true) });
        assert.deepEqual(messages.at(-1), { command: 'saved', success: true });
        const current = vscode.workspace.getConfiguration();
        for (const key of preferenceKeys) {
            assert.equal(current.inspect(key)?.workspaceValue, true);
            assert.equal(current.inspect(key)?.globalValue, true);
        }
    });

    test('cancelling agent overwrite leaves the preference untouched', async () => {
        const config = vscode.workspace.getConfiguration();
        await config.update(preferenceKey, false, vscode.ConfigurationTarget.Global);
        await config.update(defaultHarnessKey, false, vscode.ConfigurationTarget.Global);
        const { panel, messages } = createPanel();
        panel.confirmAgentOverwriteIfNeeded = async () => false;
        await panel.handleMessage({ command: 'save', values: formValues(true) });
        assert.deepEqual(messages.at(-1), { command: 'savedPartial', skippedAgent: true });
        assert.equal(config.inspect(preferenceKey)?.globalValue, false);
        assert.equal(config.inspect(defaultHarnessKey)?.globalValue, false);
    });

    test('cancelling agent overwrite does not enable Local Agent', async () => {
        const config = vscode.workspace.getConfiguration();
        await config.update(localAgentKey, false, vscode.ConfigurationTarget.Global);
        const { panel, messages } = createPanel();
        panel.confirmAgentOverwriteIfNeeded = async () => false;
        await panel.handleMessage({ command: 'save', values: formValues(false) });
        assert.deepEqual(messages.at(-1), { command: 'savedPartial', skippedAgent: true });
        assert.equal(vscode.workspace.getConfiguration().inspect(localAgentKey)?.globalValue, false);
    });

    for (const value of ['false', undefined]) {
        test(`rejects non-boolean preference ${String(value)} before writing settings`, async () => {
            const config = vscode.workspace.getConfiguration();
            const commit = { provider: 'zhipu', model: 'keep-existing' };
            await config.update('gcmp.commit.model', commit, vscode.ConfigurationTarget.Global);
            await config.update(defaultHarnessKey, true, vscode.ConfigurationTarget.Global);
            const { panel, messages } = createPanel();
            const values = { ...formValues(true), preferCopilotHarness: value } as unknown as FormValues;
            await panel.handleMessage({ command: 'save', values });
            assert.equal(messages.at(-1)?.command, 'saveError');
            assert.deepEqual(config.inspect('gcmp.commit.model')?.globalValue, commit);
            assert.equal(config.inspect(preferenceKey)?.globalValue, undefined);
            assert.equal(config.inspect(defaultHarnessKey)?.globalValue, true);
        });
    }

    test('page and command titles use auxiliary preferences in both languages', () => {
        const extension = vscode.extensions.getExtension('vicanent.gcmp');
        assert.ok(extension);
        const { panel } = createPanel();
        assert.match(panel.getWebviewContent({ cspSource: 'test-source' }), /<title>Auxiliary Preferences<\/title>/);
        for (const [file, expected] of [
            ['package.nls.json', 'Set Auxiliary Preferences'],
            ['package.nls.zh-cn.json', '设置辅助偏好']
        ]) {
            const messages = JSON.parse(readFileSync(join(extension.extensionPath, file), 'utf8')) as Record<
                string,
                string
            >;
            assert.equal(messages['command.modelSettings.wizard'], expected);
        }
    });
});
