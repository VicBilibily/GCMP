import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { runInNewContext } from 'node:vm';
import { transformSync } from 'esbuild';
import type { FIMCompletionConfig, NESCompletionConfig } from '../types';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..');
const child = resolve(root, 'extensions/gcmp-fim-nes');
const noop = (): void => {};
const logs = { trace: noop, debug: noop, info: noop, warn: noop, error: noop };

function load<T>(filename: string, importer: (id: string) => unknown): T {
    const module = { exports: {} };
    const code = transformSync(readFileSync(filename, 'utf8'), {
        loader: 'ts',
        format: 'cjs',
        target: 'es2022'
    }).code;
    runInNewContext(code, { module, exports: module.exports, require: importer, Buffer, console: logs }, { filename });
    return module.exports as T;
}

interface MainConfig {
    getConfig(): Record<string, unknown>;
    getFIMConfig?: () => unknown;
    getNESConfig?: () => unknown;
}

function mainConfigFixture() {
    const reads: string[] = [];
    const dependency = new Proxy(
        {
            Logger: logs,
            configProviders: {},
            sanitizeConfigForLogging: (value: unknown) => value
        },
        { get: (target, key: string) => (key in target ? target[key as keyof typeof target] : noop) }
    );
    const { ConfigManager } = load<{ ConfigManager: MainConfig }>(
        resolve(root, 'src/utils/config/configManager.ts'),
        id =>
            id === 'vscode' ?
                {
                    workspace: {
                        getConfiguration: () => ({
                            get: (key: string, fallback?: unknown) => {
                                reads.push(key);
                                return fallback;
                            }
                        })
                    }
                }
            :   dependency
    );
    return { ConfigManager, reads };
}

test('main configuration neither reads nor caches FIM/NES settings', () => {
    const f = mainConfigFixture();
    const config = f.ConfigManager.getConfig();
    assert.equal('fimCompletion' in config, false);
    assert.equal('nesCompletion' in config, false);
    assert.deepEqual(
        f.reads.filter(key => /^(fimCompletion|nesCompletion)\./.test(key)),
        []
    );
    assert.equal(f.ConfigManager.getConfig(), config);
    assert.ok('dashscope' in config);
    assert.ok('providerOverrides' in config);
});

test('main configuration has no completion-only getters', () => {
    const f = mainConfigFixture();
    assert.equal(f.ConfigManager.getFIMConfig, undefined);
    assert.equal(f.ConfigManager.getNESConfig, undefined);
});

test('main dynamic schema leaves completion properties to the child', () => {
    const dependency = {
        ConfigManager: { getConfigProvider: () => ({}) },
        Logger: logs,
        KnownProviders: {},
        CompatibleModelManager: { getModels: () => [] },
        t: (english: string) => english,
        ANTHROPIC_COMPATIBLE_SERVICE_TIERS: [],
        GEMINI_COMPATIBLE_SERVICE_TIERS: [],
        OPENAI_COMPATIBLE_SERVICE_TIERS: []
    };
    const { JsonSchemaProvider } = load<{
        JsonSchemaProvider: { getSettingsSchema(): { properties: Record<string, unknown> } };
    }>(resolve(root, 'src/utils/config/jsonSchemaProvider.ts'), id =>
        id === 'vscode' ? { Uri: { parse: (value: string) => value } } : dependency
    );
    const schema = JsonSchemaProvider.getSettingsSchema();
    assert.equal('gcmp.fimCompletion.modelConfig' in schema.properties, false);
    assert.equal('gcmp.nesCompletion.modelConfig' in schema.properties, false);
    assert.ok('gcmp.compatibleModels' in schema.properties);
    assert.ok('gcmp.machineOverrides' in schema.properties);
});

test('child manifest declares the same 2000ms debounce upper bound as runtime validation', () => {
    const manifest = JSON.parse(readFileSync(resolve(child, 'package.json'), 'utf8')) as {
        contributes: { configuration: { properties: Record<string, { minimum?: number; maximum?: number }> } };
    };
    for (const mode of ['fim', 'nes']) {
        const setting = manifest.contributes.configuration.properties[`gcmp.${mode}Completion.debounceMs`];
        assert.equal(setting.minimum, 50);
        assert.equal(setting.maximum, 2000);
    }
});

function completionFixture(mode: 'fim' | 'nes') {
    const values = new Map<string, unknown>();
    const reads: string[] = [];
    const warnings: string[] = [];
    const readers = load<{
        getFIMConfig(): FIMCompletionConfig;
        getNESConfig(): NESCompletionConfig;
    }>(resolve(child, 'src/utils/completionConfig.ts'), id => {
        if (id === 'vscode') {
            return {
                workspace: {
                    getConfiguration: (section: string) => {
                        assert.equal(section, 'gcmp');
                        return {
                            get: (key: string, fallback?: unknown) => {
                                reads.push(key);
                                return values.has(key) ? values.get(key) : fallback;
                            }
                        };
                    }
                }
            };
        }
        assert.equal(id, '../gcmpServices');
        return { completionLogger: { warn: (message: string) => warnings.push(message) } };
    });
    return {
        reads,
        warnings,
        set: (key: string, value: unknown) => values.set(`${mode}Completion.${key}`, value),
        read: () => (mode === 'fim' ? readers.getFIMConfig() : readers.getNESConfig())
    };
}

for (const mode of ['fim', 'nes'] as const) {
    test(`${mode} configuration uses existing defaults without injected main services`, () => {
        const f = completionFixture(mode);
        const config = JSON.parse(JSON.stringify(f.read())) as NESCompletionConfig;
        assert.deepEqual(config, {
            enabled: false,
            debounceMs: 500,
            timeoutMs: 5000,
            modelConfig: { provider: '', baseUrl: '', model: '', maxTokens: 200 },
            ...(mode === 'nes' ? { manualOnly: false } : {})
        });
        assert.equal(
            f.reads.every(key => key.startsWith(`${mode}Completion.`)),
            true
        );
        assert.equal(f.warnings.length, 0);
    });

    test(`${mode} configuration reads every existing setting and model field`, () => {
        const f = completionFixture(mode);
        const settings: Record<string, unknown> = {
            enabled: true,
            debounceMs: 1750,
            timeoutMs: 24000,
            'modelConfig.provider': 'review',
            'modelConfig.baseUrl': 'https://example.invalid',
            'modelConfig.proxy': 'noproxy',
            'modelConfig.model': 'model',
            'modelConfig.maxTokens': 1000,
            'modelConfig.extraBody': { temperature: 0, enabled: false, stop: ['a'], nested: { key: 'value' } },
            ...(mode === 'nes' ? { manualOnly: true } : {})
        };
        for (const [key, value] of Object.entries(settings)) {
            f.set(key, value);
        }
        assert.deepEqual(JSON.parse(JSON.stringify(f.read())), {
            enabled: true,
            debounceMs: 1750,
            timeoutMs: 24000,
            modelConfig: {
                provider: 'review',
                baseUrl: 'https://example.invalid',
                proxy: 'noproxy',
                model: 'model',
                maxTokens: 1000,
                extraBody: settings['modelConfig.extraBody']
            },
            ...(mode === 'nes' ? { manualOnly: true } : {})
        });
        assert.deepEqual(
            f.reads.sort(),
            Object.keys(settings)
                .map(key => `${mode}Completion.${key}`)
                .sort()
        );
        assert.equal(f.warnings.length, 0);
    });

    test(`${mode} configuration observes changed settings without a main cache or listener`, () => {
        const f = completionFixture(mode);
        const previous = f.read();
        f.set('enabled', true);
        f.set('debounceMs', 2000);
        f.set('modelConfig.model', 'changed');
        if (mode === 'nes') {
            f.set('manualOnly', true);
        }
        const current = f.read();
        assert.equal(previous.enabled, false);
        assert.equal(previous.modelConfig.model, '');
        assert.equal(current.enabled, true);
        assert.equal(current.debounceMs, 2000);
        assert.equal(current.modelConfig.model, 'changed');
        if (mode === 'nes') {
            assert.equal((current as NESCompletionConfig).manualOnly, true);
        }
    });

    for (const [key, minimum, maximum, fallback, label] of [
        ['debounceMs', 50, 2000, 500, 'debounceMs'],
        ['timeoutMs', 1000, 30000, 5000, 'timeoutMs'],
        ['modelConfig.maxTokens', 50, 16000, 200, 'NES maxTokens']
    ] as const) {
        const numberValue = (config: FIMCompletionConfig) =>
            key === 'modelConfig.maxTokens' ? config.modelConfig.maxTokens : config[key];
        test(`${mode} ${key} keeps inclusive bounds and floors valid decimals`, () => {
            const f = completionFixture(mode);
            for (const value of [minimum, maximum, minimum + 0.75]) {
                f.set(key, value);
                assert.equal(numberValue(f.read()), Math.floor(value), `${key}=${value}`);
            }
            assert.equal(f.warnings.length, 0);
        });
        test(`${mode} ${key} rejects invalid values with the existing fallback and local log`, () => {
            const f = completionFixture(mode);
            const invalid = [NaN, Infinity, -Infinity, minimum - 1, maximum + 0.1, maximum + 1];
            for (const value of invalid) {
                f.set(key, value);
                assert.equal(numberValue(f.read()), fallback, `${key}=${value}`);
                assert.equal(f.warnings.at(-1), `Invalid ${label} value: ${value}; using default ${fallback}`);
            }
            assert.equal(f.warnings.length, invalid.length);
        });
    }
}
