/** 纯函数合并：远端元数据 + 作者默认源 + 来源策略 → 变更计划。 */
import type {
    AuthorModelDefaults,
    FieldChange,
    FieldOp,
    ModelDefaultsFile,
    ModelPlanEntry,
    ProviderConfigFile,
    ProviderModelEntry,
    RemoteModelMetadata,
    SourceModelPolicy,
    SourcePlan,
    SourcePolicy,
    TargetEdit
} from './types';
import { TEMPLATES_KEY } from './types';

/** 允许通过 removeFields 显式删除的可选字段。 */
const REMOVABLE_FIELDS = new Set([
    'contextSize',
    'reasoningEffort',
    'reasoningDefault',
    'maxInputTokens',
    'maxOutputTokens',
    'capabilities',
    'tokenPricing',
    'thinking',
    'thinkingFormat',
    'extraBody',
    'serviceTier'
]);

/** 来源策略 defaults 中允许下放到新模型的字段。 */
const SOURCE_DEFAULT_FIELDS = ['sdkMode', 'baseUrl', 'thinkingFormat', 'reasoningFormat'] as const;

export function sourceBaseUrl(endpoint: string): string {
    return endpoint.replace(/\/+$/, '').replace(/\/models$/, '');
}

/** 条目参与来源匹配的归一化 base：anthropic 模式运行时由 SDK 自行拼接 /v1，对齐为 OpenAI 形态。 */
export function effectiveEntryBase(model: ProviderModelEntry, config: ProviderConfigFile): string {
    const rawBase = (model.baseUrl ?? config.baseUrl ?? '').replace(/\/+$/, '');
    return model.sdkMode === 'anthropic' ? rawBase.replace(/\/v1$/, '') + '/v1' : rawBase;
}

export function resolveRef(defaults: ModelDefaultsFile, ref: string): AuthorModelDefaults | undefined {
    const slash = ref.indexOf('/');
    if (slash <= 0) {
        return undefined;
    }
    const author = ref.slice(0, slash);
    if (author.startsWith('$')) {
        return undefined;
    }
    const group = defaults[author];
    if (!group) {
        return undefined;
    }
    const model = ref.slice(slash + 1);
    if (!Object.prototype.hasOwnProperty.call(group, model)) {
        return undefined;
    }
    return resolveEntry(defaults, group, group[model]);
}

/** 解析条目：模板（按顺序叠加） < variantOf 基座 < 条目自身；返回结果不含 template/variantOf 元字段。 */
function resolveEntry(
    defaults: ModelDefaultsFile,
    group: Record<string, AuthorModelDefaults>,
    entry: AuthorModelDefaults
): AuthorModelDefaults | undefined {
    let merged: AuthorModelDefaults = {};
    const templates =
        entry.template === undefined ? []
        : Array.isArray(entry.template) ? entry.template
        : [entry.template];
    for (const templateName of templates) {
        const template = defaults[TEMPLATES_KEY]?.[templateName];
        if (!template || template.template !== undefined || template.variantOf !== undefined) {
            return undefined;
        }
        merged = { ...merged, ...template };
    }
    if (entry.variantOf !== undefined) {
        const base = group[entry.variantOf];
        if (!base || base.variantOf !== undefined) {
            return undefined;
        }
        const resolvedBase = resolveEntry(defaults, group, base);
        if (!resolvedBase) {
            return undefined;
        }
        merged = { ...merged, ...resolvedBase };
    }
    const { template: _template, variantOf: _variantOf, ...own } = entry;
    return { ...merged, ...own };
}

/** 启动时校验默认源：模板引用必须存在且不嵌套，variantOf 必须指向同作者的非变体模型。 */
export function validateModelDefaults(defaults: ModelDefaultsFile): string[] {
    const errors: string[] = [];
    for (const [name, template] of Object.entries(defaults[TEMPLATES_KEY] ?? {})) {
        if (template.template !== undefined || template.variantOf !== undefined) {
            errors.push(`${TEMPLATES_KEY}/${name}: 模板不允许再引用模板或变体`);
        }
    }
    for (const [author, group] of Object.entries(defaults)) {
        if (author.startsWith('$')) {
            if (author !== TEMPLATES_KEY) {
                errors.push(`${author}: 未知的保留顶层键`);
            }
            continue;
        }
        for (const [model, entry] of Object.entries(group)) {
            const templates =
                entry.template === undefined ? []
                : Array.isArray(entry.template) ? entry.template
                : [entry.template];
            for (const templateName of templates) {
                if (!defaults[TEMPLATES_KEY]?.[templateName]) {
                    errors.push(`${author}/${model}: template 指向不存在的模板 "${templateName}"`);
                }
            }
            if (entry.variantOf === undefined) {
                continue;
            }
            const base = group[entry.variantOf];
            if (!base) {
                errors.push(`${author}/${model}: variantOf 指向不存在的模型 "${entry.variantOf}"`);
            } else if (base.variantOf) {
                errors.push(`${author}/${model}: 不允许链式变体（"${entry.variantOf}" 本身也是变体）`);
            }
        }
    }
    return errors;
}

export function planSource(input: {
    sourceId: string;
    policy: SourcePolicy;
    remote: RemoteModelMetadata[];
    config: ProviderConfigFile;
    defaults: ModelDefaultsFile;
}): SourcePlan {
    const { sourceId, policy, remote, config, defaults } = input;
    const plan: SourcePlan = { sourceId, targetPath: policy.target, entries: [], warnings: [], errors: [] };
    const base = sourceBaseUrl(policy.endpoint);
    const excluded = new Set(policy.excludedModelIds ?? []);
    const excludedPrefixes = policy.excludedModelIdPrefixes ?? [];
    // 以 $ 结尾表示精确匹配（避免 "glm-5" 误伤 "glm-5.3"）
    const prefixExcluded = (id: string): boolean =>
        excludedPrefixes.some(pattern =>
            pattern.endsWith('$') ? id === pattern.slice(0, -1) : id.startsWith(pattern)
        ) || (policy.excludedModelIdSuffixes ?? []).some(suffix => id.endsWith(suffix));
    const matchedExcluded = new Set<string>();
    const extraRegistered = new Set(Object.keys(policy.extra ?? {}));

    const existing = new Map<string, ProviderModelEntry>();
    const groupOrder: string[] = [];
    for (const model of config.models) {
        const effectiveBase = effectiveEntryBase(model, config);
        if (effectiveBase !== base) {
            continue;
        }
        groupOrder.push(model.id);
        const requestId = model.model ?? model.id;
        if (existing.has(requestId)) {
            plan.errors.push(`${sourceId}: 本地存在重复的请求模型 ID "${requestId}"`);
            continue;
        }
        existing.set(requestId, model);
    }

    const remoteIds = new Set(remote.map(item => item.id));
    for (const [requestId, model] of existing) {
        if (!excluded.has(requestId)) {
            continue;
        }
        matchedExcluded.add(requestId);
        plan.entries.push({ action: 'remove', remoteId: requestId, localId: model.id, reason: '排除列表' });
    }
    for (const id of excluded) {
        if (matchedExcluded.has(id)) {
            continue;
        }
        if (remoteIds.has(id)) {
            plan.warnings.push(`排除跳过：${id}（远端仍存在，已按排除配置阻止新增）`);
        } else {
            plan.warnings.push(`排除未命中：${id}（远端与本地均不存在，配置保留以防回流）`);
        }
    }
    for (const [requestId, model] of existing) {
        if (extraRegistered.has(requestId) && !excluded.has(requestId)) {
            plan.entries.push({ action: 'remove', remoteId: requestId, localId: model.id, reason: '迁入仅远端清单' });
        }
    }

    const additions: ModelPlanEntry[] = [];
    for (const item of remote) {
        if (excluded.has(item.id) || extraRegistered.has(item.id)) {
            continue;
        }
        // 前缀/后缀排除仅拦截默认上架，models 手动登记者照常纳入
        if (prefixExcluded(item.id) && !policy.models?.[item.id]) {
            continue;
        }
        const local = existing.get(item.id);
        if (local) {
            plan.entries.push(...planUpdate(sourceId, policy, item, local, plan, defaults));
        } else {
            const added = planAdd(sourceId, policy, item, defaults, config, plan);
            if (added) {
                additions.push(added);
            }
        }
    }
    additions.sort((a, b) => a.localId.localeCompare(b.localId));
    const removedLocalIds = new Set(
        plan.entries.filter(entry => entry.action === 'remove').map(entry => entry.localId)
    );
    plan.entries.push(
        ...placeAdditions(
            groupOrder.filter(id => !removedLocalIds.has(id)),
            additions
        )
    );

    for (const [requestId, model] of existing) {
        if (!remoteIds.has(requestId) && !excluded.has(requestId) && !extraRegistered.has(requestId)) {
            plan.warnings.push(`远端缺失保留：${model.id}（请求 ID ${requestId} 不在远端列表）`);
        }
    }
    return plan;
}

/** 同族聚簇定位：新模型插到同来源组内同族簇中，锚点解析到最近的既有模型。 */
function placeAdditions(groupOrder: string[], additions: ModelPlanEntry[]): ModelPlanEntry[] {
    if (additions.length === 0) {
        return additions;
    }
    const virtualOrder = [...groupOrder];
    const addedIds = new Set<string>();
    for (const addition of additions) {
        virtualOrder.splice(familyInsertIndex(virtualOrder, addition.localId), 0, addition.localId);
        addedIds.add(addition.localId);
    }
    const byId = new Map(additions.map(addition => [addition.localId, addition]));
    const ordered: ModelPlanEntry[] = [];
    for (let index = 0; index < virtualOrder.length; index++) {
        const addition = byId.get(virtualOrder[index]);
        if (!addition) {
            continue;
        }
        const after = virtualOrder
            .slice(0, index)
            .reverse()
            .find(candidate => !addedIds.has(candidate));
        if (after !== undefined) {
            addition.after = after;
        } else {
            addition.before = virtualOrder.slice(index + 1).find(candidate => !addedIds.has(candidate));
        }
        ordered.push(addition);
    }
    return ordered;
}

/** 新 ID 在虚拟序列中的插入下标：族前缀（首个数字及之前）一致的簇内按自然序降序定位；无同族时排到组末。 */
function familyInsertIndex(virtualOrder: string[], newId: string): number {
    const digitIndex = newId.search(/\d/);
    const familyLength = digitIndex === -1 ? newId.length : digitIndex + 1;
    const family: Array<{ id: string; index: number }> = [];
    virtualOrder.forEach((id, index) => {
        if (commonPrefixLength(id, newId) >= familyLength) {
            family.push({ id, index });
        }
    });
    if (family.length === 0) {
        return virtualOrder.length;
    }
    const greater = family.filter(member => member.id.localeCompare(newId, 'en', { numeric: true }) > 0);
    if (greater.length > 0) {
        const predecessor = greater.reduce((min, member) =>
            member.id.localeCompare(min.id, 'en', { numeric: true }) < 0 ? member : min
        );
        return predecessor.index + 1;
    }
    return Math.min(...family.map(member => member.index));
}

function commonPrefixLength(a: string, b: string): number {
    let length = 0;
    while (length < a.length && length < b.length && a[length] === b[length]) {
        length++;
    }
    return length;
}

/** 合并命中的 modelRules（按声明序叠加）与 models 精确登记（最后胜出）：overrides 后者覆盖前者，removeFields 取并集。 */
function resolvePolicyEntry(policy: SourcePolicy, remoteId: string): SourceModelPolicy | undefined {
    const exact = policy.models?.[remoteId];
    const rules = (policy.modelRules ?? []).filter(item =>
        [item.idPrefix, ...(item.idPrefixes ?? [])].some(prefix => prefix !== undefined && remoteId.startsWith(prefix))
    );
    if (rules.length === 0) {
        return exact;
    }
    const overrides: Record<string, unknown> = {};
    const removeFields = new Set<string>();
    let hasOverrides = false;
    for (const layer of [...rules, ...(exact ? [exact] : [])]) {
        if (layer.overrides) {
            hasOverrides = true;
            Object.assign(overrides, layer.overrides);
        }
        for (const field of layer.removeFields ?? []) {
            removeFields.add(field);
        }
    }
    return {
        ...exact,
        overrides: hasOverrides ? overrides : undefined,
        removeFields: removeFields.size > 0 ? [...removeFields] : undefined
    };
}

export function planUpdate(
    sourceId: string,
    policy: SourcePolicy,
    remote: RemoteModelMetadata,
    local: ProviderModelEntry,
    plan: SourcePlan,
    defaults: ModelDefaultsFile
): ModelPlanEntry[] {
    const policyEntry = resolvePolicyEntry(policy, remote.id);
    const target: ProviderModelEntry = { ...local };
    const ops: FieldOp[] = [];
    const changes: FieldChange[] = [];

    const setField = (field: string, value: unknown, origin: FieldChange['origin']) => {
        const from = local[field];
        if (valuesEqual(from, value)) {
            return;
        }
        ops.push({ kind: 'set', field, value });
        changes.push({ field, from, to: value, origin });
        if (value === undefined) {
            delete target[field];
        } else {
            target[field] = value;
        }
    };

    if (remote.pricing) {
        const pricing = buildPricingArray(remote.pricing);
        const existingPricing = local.tokenPricing;
        if (Array.isArray(existingPricing)) {
            if (!valuesEqual(normalizePricingArray(existingPricing), pricing)) {
                setField('tokenPricing', pricing, 'remote');
            }
        } else if (isPlainObject(existingPricing) && Array.isArray(existingPricing.pricing)) {
            if (!valuesEqual(normalizePricingArray(existingPricing.pricing), pricing)) {
                setField('tokenPricing', { ...existingPricing, pricing }, 'remote');
            }
        } else if (existingPricing === undefined) {
            setField('tokenPricing', pricing, 'remote');
        } else {
            plan.warnings.push(`${sourceId}/${local.id}: tokenPricing 结构复杂，跳过价格同步`);
        }
    }

    if (remote.capabilities?.imageInput !== undefined) {
        const currentCaps = isPlainObject(local.capabilities) ? local.capabilities : {};
        if (currentCaps.imageInput !== remote.capabilities.imageInput) {
            setField('capabilities', { ...currentCaps, imageInput: remote.capabilities.imageInput }, 'remote');
        }
    }

    applyWindowClamp(sourceId, remote, local, target, ops, changes, plan);

    // 默认源声明的模型固有字段收口到声明值（未声明的字段不触碰，人工覆盖仍优先）
    const ref = policyEntry?.ref ?? (remote.id.includes('/') ? remote.id : undefined);
    const authorDefaults = ref ? resolveRef(defaults, ref) : undefined;
    if (authorDefaults) {
        for (const field of [
            'sdkMode',
            'reasoningEffort',
            'reasoningDefault',
            'thinking',
            'thinkingFormat',
            'extraBody'
        ] as const) {
            const declared = authorDefaults[field];
            if (declared !== undefined) {
                setField(field, declared, 'author');
            }
        }
    }

    applyManualAdjustments(policyEntry, local, target, ops, changes, plan);
    validateBudget(sourceId, target, remote, plan);

    if (remote.reasoning) {
        const localSorted = Array.isArray(local.reasoningEffort) ? [...local.reasoningEffort].sort().join(',') : '';
        const remoteSorted = [...remote.reasoning.efforts].sort().join(',');
        if (localSorted !== remoteSorted) {
            const localEfforts = Array.isArray(local.reasoningEffort) ? local.reasoningEffort.join(',') : '(未配置)';
            const remoteEfforts = remote.reasoning.efforts.join(',');
            plan.warnings.push(
                `${sourceId}/${local.id}: 远端推理档位 [${remoteEfforts}] 与本地 [${localEfforts}] 不一致，保留本地配置，请人工确认`
            );
        }
    }
    const sanctionedOutput = ruleOutputForWindow(remote.contextWindow);
    if (
        remote.maxOutputTokens !== undefined &&
        typeof local.maxOutputTokens === 'number' &&
        local.maxOutputTokens > remote.maxOutputTokens &&
        (sanctionedOutput === undefined || local.maxOutputTokens > sanctionedOutput)
    ) {
        plan.warnings.push(
            `${sourceId}/${local.id}: 远端输出上限 ${remote.maxOutputTokens} 低于本地预算 ${local.maxOutputTokens}，未自动收紧，请人工确认`
        );
    }

    if (ops.length === 0) {
        return [];
    }
    return [{ action: 'update', remoteId: remote.id, localId: local.id, target, changes }];
}

export function planAdd(
    sourceId: string,
    policy: SourcePolicy,
    remote: RemoteModelMetadata,
    defaults: ModelDefaultsFile,
    config: ProviderConfigFile,
    plan: SourcePlan
): ModelPlanEntry | undefined {
    const policyEntry = resolvePolicyEntry(policy, remote.id);
    const ref = policyEntry?.ref ?? (remote.id.includes('/') ? remote.id : undefined);
    const authorDefaults = ref ? resolveRef(defaults, ref) : undefined;
    if (!authorDefaults) {
        plan.warnings.push(`待配置：${remote.id}（缺少作者默认源映射）`);
        return undefined;
    }

    const problems: string[] = [];
    // 1M 及以上窗口限定到 1M，256K~300K 及以下限定输出 32K
    const window = remote.contextWindow === undefined ? undefined : Math.min(remote.contextWindow, 1000000);
    const sanctionedOutput = ruleOutputForWindow(remote.contextWindow);
    let contextSize = authorDefaults.contextSize ? [...authorDefaults.contextSize] : undefined;
    let maxInput = authorDefaults.maxInputTokens;
    let maxOutput = authorDefaults.maxOutputTokens;

    if ((maxInput === undefined || maxOutput === undefined) && window !== undefined) {
        const derived = deriveBudgetForWindow(remote.contextWindow!);
        if (derived) {
            contextSize = contextSize ?? derived.contextSize;
            maxInput = maxInput ?? derived.maxInputTokens;
            maxOutput = maxOutput ?? derived.maxOutputTokens;
        }
    }
    if (maxInput === undefined || maxOutput === undefined) {
        problems.push('缺少输入/输出预算（默认源未配置且无法按窗口规则推导）');
    }

    if (window !== undefined && contextSize) {
        const filtered = contextSize.filter(tier => tier <= window);
        if (filtered.length === 0) {
            problems.push(`默认档位均超过远端窗口 ${window}`);
        } else {
            contextSize = filtered;
        }
    }
    const effectiveWindow = contextSize && contextSize.length > 0 ? Math.max(...contextSize) : window;
    if (maxOutput !== undefined && sanctionedOutput !== undefined && maxOutput > sanctionedOutput) {
        maxOutput = sanctionedOutput;
    }
    if (maxInput !== undefined && maxOutput !== undefined && effectiveWindow !== undefined) {
        if (maxOutput >= effectiveWindow) {
            problems.push(`输出预算 ${maxOutput} 超出可用窗口 ${effectiveWindow}`);
        } else if (maxInput + maxOutput > effectiveWindow) {
            maxInput = effectiveWindow - maxOutput;
        }
    }
    if (
        sanctionedOutput === undefined &&
        remote.maxOutputTokens !== undefined &&
        maxOutput !== undefined &&
        maxOutput > remote.maxOutputTokens
    ) {
        problems.push(`输出预算 ${maxOutput} 超过远端输出上限 ${remote.maxOutputTokens}`);
    }
    if (contextSize && contextSize.length <= 1) {
        contextSize = undefined;
    }

    const defaultCaps = authorDefaults.capabilities ?? {};
    const capabilities = {
        ...defaultCaps,
        ...(remote.capabilities?.imageInput !== undefined ? { imageInput: remote.capabilities.imageInput } : {})
    };
    if (capabilities.toolCalling === undefined) {
        problems.push('工具调用能力未知（接口未声明且默认源未配置）');
    }

    const sourceDefaults = policy.defaults ?? {};
    const sdkMode = authorDefaults.sdkMode ?? sourceDefaults.sdkMode;
    if (typeof sdkMode !== 'string' || !sdkMode) {
        problems.push('来源策略缺少默认 sdkMode');
    }

    if (problems.length > 0) {
        plan.warnings.push(`待配置：${remote.id}（${problems.join('；')}）`);
        return undefined;
    }

    const localId = policyEntry?.localId ?? `${remote.id}${policy.localIdSuffix ?? ''}`;
    if (config.models.some(model => model.id === localId)) {
        plan.errors.push(`${sourceId}: 新增模型本地 ID "${localId}" 已被占用`);
        return undefined;
    }

    const baseName = authorDefaults.name ?? remote.displayName ?? remote.id;
    const target: ProviderModelEntry = { id: localId };
    target.name = policy.nameSuffix ? `${baseName} ${policy.nameSuffix}` : baseName;
    if (localId !== remote.id) {
        target.model = remote.id;
    }
    if (typeof sourceDefaults.baseUrl === 'string') {
        target.baseUrl = sourceDefaults.baseUrl;
    }
    if (policy.tooltipPrefix) {
        target.tooltip = `${policy.tooltipPrefix} — ${baseName}。`;
    }
    target.sdkMode = sdkMode as string;
    if (contextSize) {
        target.contextSize = contextSize;
    }
    target.maxInputTokens = maxInput;
    target.maxOutputTokens = maxOutput;
    const efforts = authorDefaults.reasoningEffort ?? remote.reasoning?.efforts;
    if (efforts && efforts.length > 0) {
        target.reasoningEffort = [...efforts];
        const defaultEffort = authorDefaults.reasoningDefault ?? remote.reasoning?.defaultEffort;
        if (defaultEffort && efforts.includes(defaultEffort)) {
            target.reasoningDefault = defaultEffort;
        }
    }
    if (authorDefaults.thinking && authorDefaults.thinking.length > 0) {
        target.thinking = [...authorDefaults.thinking];
    }
    if (authorDefaults.thinkingFormat) {
        target.thinkingFormat = authorDefaults.thinkingFormat;
    }
    target.capabilities = capabilities;
    if (remote.pricing) {
        target.tokenPricing = buildPricingArray(remote.pricing);
    }
    if (authorDefaults.extraBody) {
        target.extraBody = authorDefaults.extraBody;
    }

    const ops: FieldOp[] = [];
    const changes: FieldChange[] = [];
    const errorsBefore = plan.errors.length;
    applyManualAdjustments(policyEntry, undefined, target, ops, changes, plan);
    if (ops.length > 0) {
        plan.warnings.push(`${sourceId}/${localId}: 新增模型已应用人工覆盖 ${ops.map(op => op.field).join('、')}`);
    }
    validateBudget(sourceId, target, remote, plan);
    if (plan.errors.length > errorsBefore) {
        return undefined;
    }
    return { action: 'add', remoteId: remote.id, localId, target, changes: [] };
}

/** 远端窗口收紧已有模型的档位与输入预算。 */
function applyWindowClamp(
    sourceId: string,
    remote: RemoteModelMetadata,
    local: ProviderModelEntry,
    target: ProviderModelEntry,
    ops: FieldOp[],
    changes: FieldChange[],
    plan: SourcePlan
): void {
    if (remote.contextWindow === undefined) {
        return;
    }
    const window = Math.min(remote.contextWindow, 1000000);
    let effectiveWindow = window;
    if (Array.isArray(local.contextSize)) {
        const filtered = local.contextSize.filter(tier => tier <= window);
        if (filtered.length === 0) {
            plan.errors.push(`${sourceId}/${local.id}: 所有上下文档位均超过远端窗口 ${window}`);
            return;
        }
        if (filtered.length === 1) {
            ops.push({ kind: 'remove', field: 'contextSize' });
            changes.push({ field: 'contextSize', from: local.contextSize, to: undefined, origin: 'remote' });
            delete target.contextSize;
            effectiveWindow = filtered[0];
        } else if (filtered.length !== local.contextSize.length) {
            ops.push({ kind: 'set', field: 'contextSize', value: filtered });
            changes.push({ field: 'contextSize', from: local.contextSize, to: filtered, origin: 'remote' });
            target.contextSize = filtered;
            effectiveWindow = Math.max(...filtered);
        } else {
            effectiveWindow = Math.max(...local.contextSize);
        }
    }
    const maxInput = target.maxInputTokens;
    const maxOutput = target.maxOutputTokens;
    if (typeof maxInput !== 'number' || typeof maxOutput !== 'number') {
        return;
    }
    if (maxOutput >= effectiveWindow) {
        plan.errors.push(`${sourceId}/${local.id}: 输出预算 ${maxOutput} 超出有效窗口 ${effectiveWindow}`);
        return;
    }
    if (maxInput + maxOutput > effectiveWindow) {
        const nextInput = effectiveWindow - maxOutput;
        ops.push({ kind: 'set', field: 'maxInputTokens', value: nextInput });
        changes.push({ field: 'maxInputTokens', from: maxInput, to: nextInput, origin: 'remote' });
        target.maxInputTokens = nextInput;
    }
}

/** 应用人工登记的删除与覆盖。 */
function applyManualAdjustments(
    policyEntry: SourceModelPolicy | undefined,
    local: ProviderModelEntry | undefined,
    target: ProviderModelEntry,
    ops: FieldOp[],
    changes: FieldChange[],
    plan: SourcePlan
): void {
    if (!policyEntry) {
        return;
    }
    for (const field of policyEntry.removeFields ?? []) {
        if (!REMOVABLE_FIELDS.has(field)) {
            plan.errors.push(`removeFields 不允许删除字段 "${field}"`);
            continue;
        }
        if (policyEntry.overrides && field in policyEntry.overrides) {
            plan.errors.push(`字段 "${field}" 不能同时删除和覆盖`);
            continue;
        }
        if (target[field] !== undefined) {
            // 删除优先于默认源/远端同步，同字段的既有操作被替换
            for (let index = ops.length - 1; index >= 0; index--) {
                if (ops[index].field === field) {
                    ops.splice(index, 1);
                }
            }
            for (let index = changes.length - 1; index >= 0; index--) {
                if (changes[index].field === field) {
                    changes.splice(index, 1);
                }
            }
            // 本地确有该字段才产生删除操作，避免与默认源组合出幻影更新
            if (local?.[field] !== undefined) {
                ops.push({ kind: 'remove', field });
                changes.push({ field, from: local[field], to: undefined, origin: 'override' });
            }
            delete target[field];
        }
    }
    for (const [field, value] of Object.entries(policyEntry.overrides ?? {})) {
        if (field === 'id' || field === 'model') {
            plan.errors.push(`不允许通过 overrides 修改身份字段 "${field}"`);
            continue;
        }
        // 覆盖优先于远端同步，同字段的既有操作被替换
        for (let index = ops.length - 1; index >= 0; index--) {
            if (ops[index].field === field) {
                ops.splice(index, 1);
            }
        }
        for (let index = changes.length - 1; index >= 0; index--) {
            if (changes[index].field === field) {
                changes.splice(index, 1);
            }
        }
        const from = local?.[field];
        if (!valuesEqual(from, value)) {
            ops.push({ kind: 'set', field, value });
            changes.push({ field, from, to: value, origin: 'override' });
        }
        target[field] = value;
    }
}

function validateBudget(
    sourceId: string,
    target: ProviderModelEntry,
    remote: RemoteModelMetadata,
    plan: SourcePlan
): void {
    const maxInput = target.maxInputTokens;
    const maxOutput = target.maxOutputTokens;
    if (typeof maxInput === 'number' && typeof maxOutput === 'number') {
        const tiers = Array.isArray(target.contextSize) ? target.contextSize : undefined;
        const window = tiers && tiers.length > 0 ? Math.max(...tiers) : remote.contextWindow;
        if (window !== undefined && maxInput + maxOutput > window) {
            plan.errors.push(`${sourceId}/${target.id}: 输入输出预算合计 ${maxInput + maxOutput} 超过窗口 ${window}`);
        }
        if (tiers) {
            for (const tier of tiers) {
                if (tier <= maxOutput) {
                    plan.errors.push(`${sourceId}/${target.id}: 上下文档位 ${tier} 无法容纳输出预算 ${maxOutput}`);
                }
            }
        }
    }
    if (
        target.reasoningDefault &&
        Array.isArray(target.reasoningEffort) &&
        !target.reasoningEffort.includes(target.reasoningDefault)
    ) {
        plan.errors.push(`${sourceId}/${target.id}: reasoningDefault 不在 reasoningEffort 列表中`);
    }
}

/** 窗口规则输出预算：1M 及以上 64K，256K~300K 及以下 32K，其余区间不强制。 */
function ruleOutputForWindow(window: number | undefined): number | undefined {
    if (window === undefined) {
        return undefined;
    }
    if (window >= 1000000) {
        return 64000;
    }
    if (window <= 300000) {
        return 32000;
    }
    return undefined;
}

const STANDARD_1M_TIERS = [1000000, 512000, 400000, 256000, 192000];

/** 默认源缺少预算时按窗口规则推导；中间区间不推导。 */
function deriveBudgetForWindow(
    window: number
): { contextSize?: number[]; maxInputTokens: number; maxOutputTokens: number } | undefined {
    if (window >= 1000000) {
        return { contextSize: [...STANDARD_1M_TIERS], maxInputTokens: 936000, maxOutputTokens: 64000 };
    }
    if (window <= 300000 && window > 32000) {
        return { maxInputTokens: window - 32000, maxOutputTokens: 32000 };
    }
    return undefined;
}

function buildPricingArray(pricing: NonNullable<RemoteModelMetadata['pricing']>): number[] {
    const values: Array<number | undefined> = [pricing.input, pricing.output, pricing.cacheRead, pricing.cacheWrite];
    let end = values.length;
    while (end > 2 && (values[end - 1] === undefined || values[end - 1] === 0)) {
        end--;
    }
    return values.slice(0, end).map(value => normalizeNumber(value ?? 0));
}

/** 归一化既有价格数组：统一小数精度并去除无意义的尾部零值，避免等价价格产生伪差异。 */
function normalizePricingArray(values: unknown[]): number[] {
    const numbers = values.map(value => (typeof value === 'number' ? normalizeNumber(value) : NaN));
    if (numbers.some(value => Number.isNaN(value))) {
        return numbers;
    }
    let end = numbers.length;
    while (end > 2 && numbers[end - 1] === 0) {
        end--;
    }
    return numbers.slice(0, end);
}

export function normalizeNumber(value: number): number {
    if (Number.isInteger(value)) {
        return value;
    }
    return Number(value.toFixed(10));
}

export function valuesEqual(a: unknown, b: unknown): boolean {
    if (a === b) {
        return true;
    }
    if (Array.isArray(a) && Array.isArray(b)) {
        return a.length === b.length && a.every((item, index) => valuesEqual(item, b[index]));
    }
    if (isPlainObject(a) && isPlainObject(b)) {
        const keysA = Object.keys(a);
        const keysB = Object.keys(b);
        return keysA.length === keysB.length && keysA.every(key => valuesEqual(a[key], b[key]));
    }
    return false;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** 汇总各来源计划为每个目标文件的写入操作。 */
export function buildTargetEdits(
    plans: SourcePlan[],
    configs: Map<string, ProviderConfigFile>
): Map<string, TargetEdit> {
    const edits = new Map<string, TargetEdit>();
    for (const plan of plans) {
        let edit = edits.get(plan.targetPath);
        if (!edit) {
            edit = { updates: [], removals: [], additions: [] };
            edits.set(plan.targetPath, edit);
        }
        const config = configs.get(plan.targetPath);
        for (const entry of plan.entries) {
            if (entry.action === 'remove') {
                edit.removals.push(entry.localId);
            } else if (entry.action === 'add' && entry.target) {
                edit.additions.push({ entry: entry.target, after: entry.after, before: entry.before });
            } else if (entry.action === 'update' && entry.target && config) {
                const local = config.models.find(model => model.id === entry.localId);
                if (local) {
                    edit.updates.push({ localId: entry.localId, ops: diffOps(local, entry.target) });
                }
            }
        }
    }
    return edits;
}

export function diffOps(local: ProviderModelEntry, target: ProviderModelEntry): FieldOp[] {
    const ops: FieldOp[] = [];
    const keys = new Set([...Object.keys(local), ...Object.keys(target)]);
    for (const key of keys) {
        const from = local[key];
        const to = target[key];
        if (to === undefined && from !== undefined) {
            ops.push({ kind: 'remove', field: key });
        } else if (!valuesEqual(from, to)) {
            ops.push({ kind: 'set', field: key, value: to });
        }
    }
    return ops;
}
