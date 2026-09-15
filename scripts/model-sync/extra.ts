/** remote-extra（仅远端发布）目标的纯函数计划：归属判定 + 条目生成，不写文件。 */
import { diffOps, effectiveEntryBase, planAdd, planUpdate, sourceBaseUrl, valuesEqual } from './merge';
import type {
    ExtraModelPolicy,
    ExtraPlan,
    ModelDefaultsFile,
    ProviderConfigFile,
    ProviderModelEntry,
    RemoteModelMetadata,
    SourcePlan,
    SourcePolicy,
    TargetEdit
} from './types';

/** 与 generate-config-index.mjs / 客户端 modelsResolver 对齐的禁止下发字段。 */
const EXTRA_FORBIDDEN_FIELDS = ['baseUrl', 'endpoint', 'modelsEndpoint', 'proxy', 'apiKeyTemplate', 'provider'];

/** 已生成的下线文案（含 vendor 前缀与分隔句号），用于幂等重写。 */
const SUNSET_SENTENCE_PATTERN = /。[^。\n]+ 计划于 \d{4}-\d{2}-\d{2} 下线该模型。$/;

export function planExtra(input: {
    sourceId: string;
    policy: SourcePolicy;
    remote: RemoteModelMetadata[];
    presetConfig: ProviderConfigFile;
    extraConfig: ProviderConfigFile;
    defaults: ModelDefaultsFile;
    /** YYYY-MM-DD（本地日期）。 */
    today: string;
    extraPath: string;
}): ExtraPlan {
    const { sourceId, policy, remote, presetConfig, extraConfig, defaults, today, extraPath } = input;
    const plan: ExtraPlan = { sourceId, extraPath, entries: [], warnings: [], errors: [] };
    const registrations = Object.entries(policy.extra ?? {});
    if (registrations.length === 0) {
        return plan;
    }

    const excluded = new Set(policy.excludedModelIds ?? []);
    const remoteById = new Map(remote.map(item => [item.id, item]));
    const extraById = new Map(extraConfig.models.map(model => [model.id, model]));
    const base = sourceBaseUrl(policy.endpoint);
    const presetByRequestId = new Map<string, ProviderModelEntry>();
    for (const model of presetConfig.models) {
        const effectiveBase = effectiveEntryBase(model, presetConfig);
        if (effectiveBase !== base) {
            continue;
        }
        presetByRequestId.set(model.model ?? model.id, model);
    }

    const registeredLocalIds = new Set<string>();
    for (const [remoteId, registration] of registrations) {
        const localId = policy.models?.[remoteId]?.localId ?? `${remoteId}${policy.localIdSuffix ?? ''}`;
        registeredLocalIds.add(localId);
        if (excluded.has(remoteId)) {
            plan.errors.push(`${sourceId}/${remoteId}: 同时位于排除列表与 extra 登记，配置冲突`);
            continue;
        }
        const remoteItem = remoteById.get(remoteId);
        if (!remoteItem) {
            plan.warnings.push(`登记陈旧：${remoteId}（已登记 extra 但远端不存在，请人工清理）`);
            continue;
        }
        if (registration.reason === 'sunset') {
            if (registration.sunsetAt === undefined) {
                plan.errors.push(`${sourceId}/${remoteId}: sunset 登记缺少 sunsetAt`);
                continue;
            }
            if (registration.sunsetAt <= today) {
                plan.warnings.push(`应人工删除：${remoteId}（sunsetAt ${registration.sunsetAt} 已到期）`);
                continue;
            }
        } else if (registration.sunsetAt !== undefined) {
            plan.errors.push(`${sourceId}/${remoteId}: online-only 登记不允许 sunsetAt`);
            continue;
        }
        const presetEntry = presetByRequestId.get(remoteId);
        const merged = mergeExtraEntry({
            sourceId,
            policy,
            remoteItem,
            baseEntry: extraById.get(localId) ?? presetEntry,
            defaults,
            extraConfig,
            base,
            plan
        });
        if (!merged) {
            continue;
        }
        if (registration.name !== undefined) {
            merged.name = registration.name;
        }
        applyExtraTooltip(merged, registration, policy);
        stripForbiddenFields(merged, sourceId, plan);
        validateExtraEntry(merged, sourceId, plan);

        const extraEntry = extraById.get(localId);
        if (extraEntry) {
            if (!valuesEqual(extraEntry, merged)) {
                plan.entries.push({ action: 'update', remoteId, localId, target: merged });
            }
        } else {
            plan.entries.push({ action: 'add', remoteId, localId, target: merged });
        }
    }

    for (const model of extraConfig.models) {
        if (!registeredLocalIds.has(model.id)) {
            plan.warnings.push(`未登记：extra 条目 ${model.id} 不在 extra 登记中（保留；如需下线请人工删除）`);
        }
    }
    plan.entries.sort((a, b) => a.localId.localeCompare(b.localId));
    return plan;
}

/** 复用预置合并管道生成 extra 条目：存在本地基线走更新合并，否则走新增构建。 */
function mergeExtraEntry(input: {
    sourceId: string;
    policy: SourcePolicy;
    remoteItem: RemoteModelMetadata;
    baseEntry: ProviderModelEntry | undefined;
    defaults: ModelDefaultsFile;
    extraConfig: ProviderConfigFile;
    base: string;
    plan: ExtraPlan;
}): ProviderModelEntry | undefined {
    const { sourceId, policy, remoteItem, baseEntry, defaults, extraConfig, base, plan } = input;
    const accumulator: SourcePlan = { sourceId, targetPath: plan.extraPath, entries: [], warnings: [], errors: [] };
    let merged: ProviderModelEntry | undefined;
    if (baseEntry) {
        const updates = planUpdate(sourceId, policy, remoteItem, baseEntry, accumulator, defaults);
        merged = updates.length > 0 ? updates[0].target : { ...baseEntry };
    } else {
        const pseudoConfig: ProviderConfigFile = { baseUrl: base, models: extraConfig.models };
        const added = planAdd(sourceId, policy, remoteItem, defaults, pseudoConfig, accumulator);
        merged = added?.target;
    }
    plan.warnings.push(...accumulator.warnings);
    plan.errors.push(...accumulator.errors);
    return merged;
}

function applyExtraTooltip(entry: ProviderModelEntry, registration: ExtraModelPolicy, policy: SourcePolicy): void {
    if (registration.tooltipNote !== undefined) {
        entry.tooltip = registration.tooltipNote;
        return;
    }
    if (registration.sunsetAt === undefined) {
        return;
    }
    const vendor = policy.sunsetVendor ?? policy.tooltipPrefix ?? '';
    const sentence = `${vendor} 计划于 ${registration.sunsetAt} 下线该模型。`;
    const current = typeof entry.tooltip === 'string' ? entry.tooltip : '';
    const stripped = current.replace(SUNSET_SENTENCE_PATTERN, '');
    entry.tooltip = stripped.endsWith('。') ? stripped + sentence : stripped + '。' + sentence;
}

function stripForbiddenFields(entry: ProviderModelEntry, sourceId: string, plan: ExtraPlan): void {
    for (const field of EXTRA_FORBIDDEN_FIELDS) {
        if (entry[field] !== undefined) {
            delete entry[field];
            plan.warnings.push(`${sourceId}/${entry.id}: extra 条目禁止下发字段 "${field}"，已剥离`);
        }
    }
}

/** 与 remote-extra 构建期强校验对齐的必填检查。 */
function validateExtraEntry(entry: ProviderModelEntry, sourceId: string, plan: ExtraPlan): void {
    if (typeof entry.name !== 'string' || !entry.name) {
        plan.errors.push(`${sourceId}/${entry.id}: extra 条目缺少 name`);
    }
    if (typeof entry.maxInputTokens !== 'number' || !(entry.maxInputTokens > 0)) {
        plan.errors.push(`${sourceId}/${entry.id}: extra 条目缺少有效 maxInputTokens`);
    }
    if (typeof entry.maxOutputTokens !== 'number' || !(entry.maxOutputTokens > 0)) {
        plan.errors.push(`${sourceId}/${entry.id}: extra 条目缺少有效 maxOutputTokens`);
    }
}

/** 汇总 extra 计划为写入操作；extra 不做自动移除（过期仅报告，人工删除）。 */
export function buildExtraEdit(plan: ExtraPlan, extraConfig: ProviderConfigFile): TargetEdit {
    const edit: TargetEdit = { updates: [], removals: [], additions: [] };
    for (const entry of plan.entries) {
        if (entry.action === 'add' && entry.target) {
            edit.additions.push({ entry: entry.target });
        } else if (entry.action === 'update' && entry.target) {
            const local = extraConfig.models.find(model => model.id === entry.localId);
            if (local) {
                edit.updates.push({ localId: entry.localId, ops: diffOps(local, entry.target) });
            }
        }
    }
    return edit;
}
