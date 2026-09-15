/** remote-extra 计划的单元测试：归属判定、条目生成、幂等与冲突校验。 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { buildExtraEdit, planExtra } from '../extra';
import { planSource } from '../merge';
import type {
    ExtraModelPolicy,
    ModelDefaultsFile,
    ProviderConfigFile,
    ProviderModelEntry,
    RemoteModelMetadata,
    SourcePolicy
} from '../types';

const TODAY = '2026-09-11';

const basePolicy: SourcePolicy = {
    adapter: 'hyper',
    endpoint: 'https://hyper.example/v1/models',
    target: 'src/providers/config/hyper.json',
    nameSuffix: '(Hyper)',
    tooltipPrefix: 'Charm Hyper',
    sunsetVendor: 'Hyper',
    defaults: { sdkMode: 'openai-sse' }
};

const glm5Preset: ProviderModelEntry = {
    id: 'glm-5',
    name: 'GLM-5 (Hyper)',
    tooltip: 'Charm Hyper — GLM-5。',
    sdkMode: 'openai-sse',
    maxInputTokens: 180000,
    maxOutputTokens: 20000,
    capabilities: { toolCalling: true, imageInput: false },
    tokenPricing: [0.86, 2.784, 0.43]
};

const glm5Remote: RemoteModelMetadata = {
    id: 'glm-5',
    displayName: 'GLM-5',
    contextWindow: 200000,
    maxOutputTokens: 20000,
    capabilities: { imageInput: false },
    pricing: { input: 0.86, output: 2.784, cacheRead: 0.43 }
};

const emptyDefaults: ModelDefaultsFile = {};

function makeExtra(registration: ExtraModelPolicy): Record<string, ExtraModelPolicy> {
    return { 'glm-5': registration };
}

function makePresetConfig(models: ProviderModelEntry[]): ProviderConfigFile {
    return { baseUrl: 'https://hyper.example/v1', models };
}

function plan(overrides: {
    policy?: SourcePolicy;
    remote?: RemoteModelMetadata[];
    presetConfig?: ProviderConfigFile;
    extraConfig?: ProviderConfigFile;
    defaults?: ModelDefaultsFile;
}) {
    return planExtra({
        sourceId: 'hyper',
        policy: overrides.policy ?? { ...basePolicy, extra: makeExtra({ reason: 'sunset', sunsetAt: '2026-09-16' }) },
        remote: overrides.remote ?? [glm5Remote],
        presetConfig: overrides.presetConfig ?? makePresetConfig([]),
        extraConfig: overrides.extraConfig ?? { models: [] },
        defaults: overrides.defaults ?? emptyDefaults,
        today: TODAY,
        extraPath: 'website/remote-extra/hyper.json'
    });
}

test('sunset 迁移：预置条目迁入 extra 并追加下线文案，预置计划同步移除', () => {
    const presetConfig = makePresetConfig([glm5Preset]);
    const extraPlan = plan({ presetConfig });
    assert.equal(extraPlan.errors.length, 0);
    assert.equal(extraPlan.entries.length, 1);
    const entry = extraPlan.entries[0];
    assert.equal(entry.action, 'add');
    assert.equal(entry.localId, 'glm-5');
    assert.equal(entry.target?.tooltip, 'Charm Hyper — GLM-5。Hyper 计划于 2026-09-16 下线该模型。');
    assert.equal(entry.target?.name, 'GLM-5 (Hyper)');
    assert.equal(entry.target?.maxInputTokens, 180000);

    const presetPlan = planSource({
        sourceId: 'hyper',
        policy: { ...basePolicy, extra: makeExtra({ reason: 'sunset', sunsetAt: '2026-09-16' }) },
        remote: [glm5Remote],
        config: presetConfig,
        defaults: emptyDefaults
    });
    assert.deepEqual(
        presetPlan.entries.map(item => `${item.action}:${item.localId}`),
        ['remove:glm-5']
    );
    assert.equal(presetPlan.entries[0].reason, '迁入仅远端清单');
});

test('稳态幂等：extra 条目已含下线文案且元数据一致时不产生变更', () => {
    const migrated: ProviderModelEntry = {
        ...glm5Preset,
        tooltip: 'Charm Hyper — GLM-5。Hyper 计划于 2026-09-16 下线该模型。'
    };
    const extraPlan = plan({ extraConfig: { models: [migrated] } });
    assert.equal(extraPlan.entries.length, 0);
    assert.equal(extraPlan.errors.length, 0);
});

test('sunsetAt 变更时整体替换下线文案句尾', () => {
    const migrated: ProviderModelEntry = {
        ...glm5Preset,
        tooltip: 'Charm Hyper — GLM-5。Hyper 计划于 2026-09-16 下线该模型。'
    };
    const extraPlan = plan({
        policy: { ...basePolicy, extra: makeExtra({ reason: 'sunset', sunsetAt: '2026-09-20' }) },
        extraConfig: { models: [migrated] }
    });
    assert.equal(extraPlan.entries.length, 1);
    assert.equal(extraPlan.entries[0].action, 'update');
    assert.equal(extraPlan.entries[0].target?.tooltip, 'Charm Hyper — GLM-5。Hyper 计划于 2026-09-20 下线该模型。');
});

test('sunsetAt 过期仅报告，不生成也不移除', () => {
    const migrated: ProviderModelEntry = {
        ...glm5Preset,
        tooltip: 'Charm Hyper — GLM-5。Hyper 计划于 2020-01-01 下线该模型。'
    };
    const extraPlan = plan({
        policy: { ...basePolicy, extra: makeExtra({ reason: 'sunset', sunsetAt: '2020-01-01' }) },
        extraConfig: { models: [migrated] }
    });
    assert.equal(extraPlan.entries.length, 0);
    assert.ok(extraPlan.warnings.some(warning => warning.includes('应人工删除：glm-5')));
});

test('登记 extra 但远端不存在 → 报告登记陈旧', () => {
    const extraPlan = plan({ remote: [] });
    assert.equal(extraPlan.entries.length, 0);
    assert.ok(extraPlan.warnings.some(warning => warning.includes('登记陈旧：glm-5')));
});

test('online-only 且预置中存在 → 以预置条目为基线迁入 extra，预置计划同步移除', () => {
    const policy: SourcePolicy = { ...basePolicy, extra: makeExtra({ reason: 'online-only' }) };
    const presetConfig = makePresetConfig([glm5Preset]);
    const extraPlan = plan({ policy, presetConfig });
    assert.equal(extraPlan.errors.length, 0);
    const entry = extraPlan.entries.find(item => item.action === 'add');
    assert.ok(entry);
    // 基线字段保留，且不追加下线文案
    assert.equal(entry.target?.name, 'GLM-5 (Hyper)');
    assert.equal(entry.target?.tooltip, 'Charm Hyper — GLM-5。');
    assert.deepEqual(entry.target?.tokenPricing, [0.86, 2.784, 0.43]);

    const presetPlan = planSource({
        sourceId: 'hyper',
        policy,
        remote: [glm5Remote],
        config: presetConfig,
        defaults: emptyDefaults
    });
    assert.deepEqual(
        presetPlan.entries.map(item => `${item.action}:${item.localId}`),
        ['remove:glm-5']
    );
    assert.equal(presetPlan.entries[0].reason, '迁入仅远端清单');
});

test('online-only 新增：走新增管道并剥离禁止字段', () => {
    const defaults: ModelDefaultsFile = {
        acme: {
            'free-model': {
                name: 'Free-Model',
                maxInputTokens: 224000,
                maxOutputTokens: 32000,
                capabilities: { toolCalling: true, imageInput: false }
            }
        }
    };
    const policy: SourcePolicy = {
        ...basePolicy,
        models: { 'free-model': { ref: 'acme/free-model' } },
        extra: { 'free-model': { reason: 'online-only' } }
    };
    const remote: RemoteModelMetadata = {
        id: 'free-model',
        contextWindow: 262144,
        maxOutputTokens: 32768,
        capabilities: { imageInput: false },
        pricing: { input: 0, output: 0 }
    };
    const extraPlan = planExtra({
        sourceId: 'hyper',
        policy,
        remote: [remote],
        presetConfig: makePresetConfig([]),
        extraConfig: { models: [] },
        defaults,
        today: TODAY,
        extraPath: 'website/remote-extra/hyper.json'
    });
    assert.equal(extraPlan.errors.length, 0);
    assert.equal(extraPlan.entries.length, 1);
    const target = extraPlan.entries[0].target!;
    assert.equal(target.id, 'free-model');
    assert.equal(target.name, 'Free-Model (Hyper)');
    assert.equal(target.tooltip, 'Charm Hyper — Free-Model。');
    assert.equal(target.baseUrl, undefined);
    assert.equal(target.sdkMode, 'openai-sse');
    assert.equal(extraPlan.warnings.filter(w => w.includes('禁止下发字段')).length, 0);
});

test('extra 文件中未登记的条目仅警告保留', () => {
    const orphan: ProviderModelEntry = {
        id: 'hand-maintained',
        name: 'Hand-Maintained',
        maxInputTokens: 1000,
        maxOutputTokens: 100
    };
    const extraPlan = plan({
        presetConfig: makePresetConfig([glm5Preset]),
        extraConfig: { models: [orphan] }
    });
    assert.ok(extraPlan.warnings.some(warning => warning.includes('未登记：extra 条目 hand-maintained')));
});

test('排除列表与 extra 登记冲突 → 错误', () => {
    const extraPlan = plan({
        policy: {
            ...basePolicy,
            excludedModelIds: ['glm-5'],
            extra: makeExtra({ reason: 'sunset', sunsetAt: '2026-09-16' })
        }
    });
    assert.ok(extraPlan.errors.some(error => error.includes('配置冲突')));
});

test('buildExtraEdit 汇总新增与更新为写入操作', () => {
    const local: ProviderModelEntry = {
        id: 'glm-5',
        name: 'GLM-5 (Hyper)',
        maxInputTokens: 180000,
        maxOutputTokens: 20000
    };
    const defaults: ModelDefaultsFile = {
        acme: {
            'free-model': {
                name: 'Free-Model',
                maxInputTokens: 224000,
                maxOutputTokens: 32000,
                capabilities: { toolCalling: true, imageInput: false }
            }
        }
    };
    const extraPlan = plan({
        policy: {
            ...basePolicy,
            extra: {
                'glm-5': { reason: 'online-only' },
                'free-model': { reason: 'online-only' }
            },
            models: { 'free-model': { ref: 'acme/free-model' } }
        },
        remote: [
            glm5Remote,
            {
                id: 'free-model',
                contextWindow: 262144,
                maxOutputTokens: 32768,
                capabilities: { imageInput: false }
            }
        ],
        extraConfig: { models: [local] },
        defaults
    });
    assert.equal(extraPlan.errors.length, 0);
    // glm-5 有 update（补 capabilities/tooltip/pricing）；free-model 走新增（含 defaults）
    const addIds = extraPlan.entries.filter(e => e.action === 'add').map(e => e.localId);
    assert.ok(addIds.includes('free-model'));

    const withUpdate = plan({
        policy: { ...basePolicy, extra: makeExtra({ reason: 'sunset', sunsetAt: '2026-09-16' }) },
        extraConfig: { models: [local] }
    });
    const edit = buildExtraEdit(withUpdate, { models: [local] });
    assert.equal(edit.additions.length, 0);
    assert.equal(edit.updates.length, 1);
    assert.equal(edit.updates[0].localId, 'glm-5');
    assert.ok(edit.updates[0].ops.some(op => op.field === 'tooltip'));
});
