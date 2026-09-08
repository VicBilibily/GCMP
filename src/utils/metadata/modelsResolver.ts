/*---------------------------------------------------------------------------------------------
 *  模型清单远程更新（纯逻辑层）
 *  清单解析/semver 新鲜度比较/模型白名单清洗/文本哈希 + 内存快照
 *  不依赖 vscode，可供 node:test 单测；宿主层见 remoteModelsService
 *--------------------------------------------------------------------------------------------*/

import { createHash } from 'node:crypto';
import { Buffer } from 'node:buffer';
import type { ModelConfig } from '../../types/sharedTypes';
import { normalizeTokenPricing } from '../pricing/pricingTierResolver';

/** 模型清单（configs/index.json）中的单个提供商条目 */
export interface ModelsManifestEntry {
    id: string;
    /** provider 文件原文文本的 sha256 前 12 位 */
    contentHash: string;
}

/** 模型清单载荷 */
export interface ModelsManifest {
    schemaVersion: 1;
    gcmpVersion: string;
    providers: ModelsManifestEntry[];
}

/** sanitizeProviderModels 的清洗结果与审计信息 */
export interface SanitizedProviderModels {
    models: ModelConfig[];
    /** 因必填字段非法被整体丢弃的模型数 */
    droppedModels: number;
    /** 出现的禁止字段名（已剥离，仅用于日志） */
    strippedFields: string[];
}

const SUPPORTED_SCHEMA_VERSION = 1;
const MAX_MANIFEST_PROVIDERS = 128;
const MAX_PROVIDER_MODELS = 512;

/** provider 文件原文文本哈希（与 website 清单生成器同一规则） */
export function hashModelsText(text: string): string {
    return createHash('sha256').update(text).digest('hex').slice(0, 12);
}

function asRecord(value: unknown): Record<string, unknown> {
    return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : {};
}

/** 解析模型清单文本；JSON 非法/schemaVersion 不支持/gcmpVersion 缺失时整体拒绝 */
export function parseModelsManifest(text: string): ModelsManifest | undefined {
    let raw: unknown;
    try {
        raw = JSON.parse(text);
    } catch {
        return undefined;
    }
    const root = asRecord(raw);
    if (root.schemaVersion !== SUPPORTED_SCHEMA_VERSION) {
        return undefined;
    }
    const gcmpVersion =
        typeof root.gcmpVersion === 'string' && root.gcmpVersion.trim() ? root.gcmpVersion.trim() : undefined;
    if (!gcmpVersion) {
        return undefined;
    }
    if (!Array.isArray(root.providers) || root.providers.length > MAX_MANIFEST_PROVIDERS) {
        return undefined;
    }
    const providers: ModelsManifestEntry[] = [];
    const providerIds = new Set<string>();
    for (const item of root.providers) {
        const entry = asRecord(item);
        const id = typeof entry.id === 'string' && /^[a-z0-9-]+$/.test(entry.id) ? entry.id : undefined;
        const contentHash =
            typeof entry.contentHash === 'string' && /^[0-9a-f]{12}$/.test(entry.contentHash) ?
                entry.contentHash
            :   undefined;
        if (!id || !contentHash || providerIds.has(id)) {
            return undefined;
        }
        providerIds.add(id);
        providers.push({ id, contentHash });
    }
    return { schemaVersion: SUPPORTED_SCHEMA_VERSION, gcmpVersion, providers };
}

interface ParsedVersion {
    nums: [number, number, number];
    /** 预发布标识符（空数组 = 正式版） */
    pre: string[];
}

function parseVersion(value: string): ParsedVersion | undefined {
    const match = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/.exec(value.trim());
    if (!match) {
        return undefined;
    }
    return {
        nums: [Number(match[1]), Number(match[2]), Number(match[3])],
        pre: match[4] ? match[4].split('.') : []
    };
}

/**
 * semver 比较（含预发布规则：同数值时正式版 > 预发布版，如 0.27.15 > 0.27.15-p1）
 * 返回负数/0/正数；无法解析时返回 undefined
 */
export function compareGcmpVersions(a: string, b: string): number | undefined {
    const va = parseVersion(a);
    const vb = parseVersion(b);
    if (!va || !vb) {
        return undefined;
    }
    for (let i = 0; i < 3; i++) {
        if (va.nums[i] !== vb.nums[i]) {
            return va.nums[i] - vb.nums[i];
        }
    }
    if (va.pre.length === 0 && vb.pre.length === 0) {
        return 0;
    }
    if (va.pre.length === 0) {
        return 1;
    }
    if (vb.pre.length === 0) {
        return -1;
    }
    const len = Math.max(va.pre.length, vb.pre.length);
    for (let i = 0; i < len; i++) {
        const pa = va.pre[i];
        const pb = vb.pre[i];
        if (pa === undefined) {
            return -1;
        }
        if (pb === undefined) {
            return 1;
        }
        const na = /^\d+$/.test(pa) ? Number(pa) : undefined;
        const nb = /^\d+$/.test(pb) ? Number(pb) : undefined;
        if (na !== undefined && nb !== undefined) {
            if (na !== nb) {
                return na - nb;
            }
        } else if (na !== undefined) {
            return -1;
        } else if (nb !== undefined) {
            return 1;
        } else if (pa !== pb) {
            return pa < pb ? -1 : 1;
        }
    }
    return 0;
}

/** 新鲜度门槛：仅当清单版本 ≥ 扩展版本才允许应用远程模型；无法解析视为不新鲜 */
export function isRemoteManifestFresh(manifestVersion: string, extensionVersion: string): boolean {
    const compared = compareGcmpVersions(manifestVersion, extensionVersion);
    return compared !== undefined && compared >= 0;
}

const SDK_MODES = new Set(['anthropic', 'openai', 'openai-sse', 'openai-responses']);
const THINKING_VALUES = new Set(['disabled', 'enabled', 'auto', 'adaptive']);
const THINKING_FORMATS = new Set(['boolean', 'boolean-none', 'object', 'object-none', 'effort-none', 'effort-only']);
const REASONING_FORMATS = new Set(['flat', 'nested']);
const REASONING_EFFORTS = new Set(['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']);
const CACHE_TTLS = new Set(['5m', '1h']);
const LIMIT_KEYS = new Set(['rpm', 'rps', 'tpm', 'parallel']);

/** 凭证/流量重定向风险字段，禁止远程下发（出现即剥离并审计） */
const FORBIDDEN_MODEL_FIELDS = new Set(['baseUrl', 'endpoint', 'modelsEndpoint', 'proxy', 'apiKeyTemplate']);
/** 目的地/密钥槽位字段：远程值一律不取，仅从内置同 id 模型继承（变体模型路由依赖这些字段） */
const INHERIT_ONLY_FIELDS = ['baseUrl', 'endpoint', 'proxy', 'provider'] as const;
const PROTO_POLLUTION_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

const HEADER_KEY_PATTERN = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/;
const SENSITIVE_HEADER_KEY_PATTERN = /^(authorization|proxy-authorization|cookie|set-cookie|host)$/i;
const PRINTABLE_ASCII_PATTERN = /^[ -~]*$/;
const MODEL_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:@+\-/]*$/;

function asCleanString(value: unknown, maxLength: number): string | undefined {
    if (typeof value !== 'string') {
        return undefined;
    }
    const trimmed = value.trim();
    if (!trimmed || trimmed.length > maxLength) {
        return undefined;
    }
    return hasControlChars(trimmed) ? undefined : trimmed;
}

function collectTrustedModelValues(
    models: readonly ModelConfig[],
    field: 'baseUrl' | 'endpoint' | 'provider'
): Set<string> {
    return new Set(
        models
            .map(model => model[field])
            .filter((value): value is string => typeof value === 'string' && value.length > 0)
    );
}

// eslint-disable-next-line no-control-regex
const CONTROL_CHARS_PATTERN = /[\x00-\x1f\x7f]/;

function hasControlChars(value: string): boolean {
    return CONTROL_CHARS_PATTERN.test(value);
}

function asTokenCount(value: unknown, max: number): number | undefined {
    return typeof value === 'number' && Number.isInteger(value) && value > 0 && value <= max ? value : undefined;
}

function asStringArray(value: unknown, allowed: Set<string>, maxItems: number): string[] | undefined {
    if (!Array.isArray(value)) {
        return undefined;
    }
    const items = value.filter((item): item is string => typeof item === 'string' && allowed.has(item));
    return items.length > 0 && items.length <= maxItems ? [...new Set(items)] : undefined;
}

function asCustomHeader(value: unknown): Record<string, string> | undefined {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
        return undefined;
    }
    const result: Record<string, string> = {};
    for (const [key, headerValue] of Object.entries(value)) {
        if (PROTO_POLLUTION_KEYS.has(key) || SENSITIVE_HEADER_KEY_PATTERN.test(key) || !HEADER_KEY_PATTERN.test(key)) {
            continue;
        }
        if (
            typeof headerValue !== 'string' ||
            headerValue.length > 1024 ||
            !PRINTABLE_ASCII_PATTERN.test(headerValue)
        ) {
            continue;
        }
        result[key] = headerValue;
    }
    return Object.keys(result).length > 0 ? result : undefined;
}

/** 深度受限的 JSON 值清洗：剥离原型污染键；深度超限抛错由调用方整字段丢弃（fail-closed，不做静默截断） */
class JsonDepthExceededError extends Error {}

function sanitizeJsonValue(value: unknown, depth: number): unknown {
    if (depth > 8) {
        throw new JsonDepthExceededError();
    }
    if (value === null || typeof value === 'string' || typeof value === 'boolean') {
        return value;
    }
    if (typeof value === 'number') {
        return Number.isFinite(value) ? value : undefined;
    }
    if (Array.isArray(value)) {
        const items: unknown[] = [];
        for (const item of value) {
            const cleaned = sanitizeJsonValue(item, depth + 1);
            if (cleaned !== undefined) {
                items.push(cleaned);
            }
        }
        return items;
    }
    if (typeof value === 'object') {
        const result: Record<string, unknown> = {};
        for (const [key, item] of Object.entries(value)) {
            if (PROTO_POLLUTION_KEYS.has(key)) {
                continue;
            }
            const cleaned = sanitizeJsonValue(item, depth + 1);
            if (cleaned !== undefined) {
                result[key] = cleaned;
            }
        }
        return result;
    }
    return undefined;
}

function asBoundedJsonObject(value: unknown, maxBytes: number): Record<string, unknown> | undefined {
    let cleaned: unknown;
    try {
        cleaned = sanitizeJsonValue(value, 1);
    } catch {
        return undefined;
    }
    if (typeof cleaned !== 'object' || cleaned === null || Array.isArray(cleaned)) {
        return undefined;
    }
    try {
        return Buffer.byteLength(JSON.stringify(cleaned), 'utf8') <= maxBytes ?
                (cleaned as Record<string, unknown>)
            :   undefined;
    } catch {
        return undefined;
    }
}

function asWebSearchTool(value: unknown): ModelConfig['webSearchTool'] | undefined {
    if (typeof value === 'boolean') {
        return value;
    }
    if (typeof value !== 'object' || value === null) {
        return undefined;
    }
    const input = asRecord(value);
    const config: NonNullable<Exclude<ModelConfig['webSearchTool'], boolean>> = {};
    const maxUses =
        (
            typeof input.maxUses === 'number' &&
            Number.isInteger(input.maxUses) &&
            input.maxUses >= 1 &&
            input.maxUses <= 100
        ) ?
            input.maxUses
        :   undefined;
    if (maxUses !== undefined) {
        config.maxUses = maxUses;
    }
    for (const key of ['allowedDomains', 'blockedDomains'] as const) {
        const cleaned =
            Array.isArray(input[key]) ?
                input[key]
                    .filter((d): d is string => typeof d === 'string' && d.length <= 253 && !hasControlChars(d))
                    .slice(0, 100)
            :   undefined;
        if (cleaned && cleaned.length > 0) {
            config[key] = cleaned;
        }
    }
    if (typeof input.userLocation === 'object' && input.userLocation !== null) {
        const location = asRecord(input.userLocation);
        const cleanedLocation: Record<string, string> = {};
        for (const key of ['city', 'region', 'country', 'timezone'] as const) {
            const item = asCleanString(location[key], 128);
            if (item) {
                cleanedLocation[key] = item;
            }
        }
        if (Object.keys(cleanedLocation).length > 0) {
            config.userLocation = cleanedLocation;
        }
    }
    return Object.keys(config).length > 0 ? config : undefined;
}

function asNativeTools(value: unknown): ModelConfig['nativeTools'] | undefined {
    if (!Array.isArray(value) || value.length === 0 || value.length > 8) {
        return undefined;
    }
    const tools: NonNullable<ModelConfig['nativeTools']> = [];
    for (const item of value) {
        const record = asBoundedJsonObject(item, 4096);
        const type = record ? asCleanString(record.type, 64) : undefined;
        if (record && type) {
            tools.push({ ...record, type });
        }
    }
    return tools.length > 0 ? tools : undefined;
}

function asRateLimit(value: unknown): ModelConfig['limit'] | undefined {
    if (typeof value !== 'object' || value === null) {
        return undefined;
    }
    const input = asRecord(value);
    const limit: NonNullable<ModelConfig['limit']> = {};
    for (const [key, item] of Object.entries(input)) {
        if (!LIMIT_KEYS.has(key)) {
            continue;
        }
        const num = typeof item === 'number' && Number.isInteger(item) && item > 0 && item <= 1e9 ? item : undefined;
        if (num !== undefined) {
            (limit as Record<string, number>)[key] = num;
        }
    }
    return Object.keys(limit).length > 0 ? limit : undefined;
}

/**
 * 清洗 provider 文件载荷：只取 models 数组，按白名单逐字段校验
 * 禁止字段剥离并计入审计；必填字段（id/name/maxInputTokens/maxOutputTokens）非法的模型整体丢弃
 * 载荷结构非法（非对象或 models 非数组）或全部模型被丢弃时返回 undefined，避免空列表清空 provider
 * 清洗完成后与内置模型合并：同 id 用远端定义，内置剩余项作为回退（无内置时退化为纯替换）
 * @param builtinModels 内置模型（用于按 id 继承目的地/密钥槽位字段：baseUrl/endpoint/modelsEndpoint/proxy/provider）
 */
export function sanitizeProviderModels(
    payload: unknown,
    builtinModels?: readonly ModelConfig[]
): SanitizedProviderModels | undefined {
    const root = asRecord(payload);
    if (!Array.isArray(root.models) || root.models.length > MAX_PROVIDER_MODELS) {
        return undefined;
    }
    const builtinById = new Map((builtinModels ?? []).map(model => [model.id, model]));
    const trustedBaseUrls = collectTrustedModelValues(builtinModels ?? [], 'baseUrl');
    const trustedEndpoints = collectTrustedModelValues(builtinModels ?? [], 'endpoint');
    const trustedProviders = collectTrustedModelValues(builtinModels ?? [], 'provider');
    const remoteModelsById = new Map<string, ModelConfig>();
    const stripped = new Set<string>();
    let droppedModels = 0;

    for (const item of root.models) {
        const input = asRecord(item);
        for (const key of Object.keys(input)) {
            if (FORBIDDEN_MODEL_FIELDS.has(key) || PROTO_POLLUTION_KEYS.has(key) || key === 'provider') {
                stripped.add(key);
            }
        }
        const id =
            typeof input.id === 'string' && input.id.length <= 128 && MODEL_ID_PATTERN.test(input.id) ?
                input.id
            :   undefined;
        const name = asCleanString(input.name, 128);
        const maxInputTokens = asTokenCount(input.maxInputTokens, 10_000_000);
        const maxOutputTokens = asTokenCount(input.maxOutputTokens, 1_000_000);
        if (!id || !name || maxInputTokens === undefined || maxOutputTokens === undefined) {
            droppedModels++;
            continue;
        }

        const model: ModelConfig = {
            id,
            name,
            tooltip: asCleanString(input.tooltip, 512) ?? '',
            maxInputTokens,
            maxOutputTokens,
            capabilities: {
                toolCalling: asRecord(input.capabilities).toolCalling === true,
                imageInput: asRecord(input.capabilities).imageInput === true
            }
        };

        const remoteBaseUrl = asCleanString(input.baseUrl, 2048);
        if (remoteBaseUrl && trustedBaseUrls.has(remoteBaseUrl)) {
            model.baseUrl = remoteBaseUrl;
        }
        const remoteEndpoint = asCleanString(input.endpoint, 2048);
        if (remoteEndpoint && trustedEndpoints.has(remoteEndpoint)) {
            model.endpoint = remoteEndpoint;
        }
        const remoteProvider = asCleanString(input.provider, 128);
        if (remoteProvider && trustedProviders.has(remoteProvider)) {
            model.provider = remoteProvider;
        }

        const version = asCleanString(input.version, 64);
        if (version) {
            model.version = version;
        }
        if (typeof input.sdkMode === 'string' && SDK_MODES.has(input.sdkMode)) {
            model.sdkMode = input.sdkMode as ModelConfig['sdkMode'];
        }
        const modelName = asCleanString(input.model, 128);
        if (modelName) {
            model.model = modelName;
        }
        const family = asCleanString(input.family, 64);
        if (family) {
            model.family = family;
        }
        const thinking = asStringArray(input.thinking, THINKING_VALUES, 4);
        if (thinking) {
            model.thinking = thinking as ModelConfig['thinking'];
        }
        if (typeof input.thinkingFormat === 'string' && THINKING_FORMATS.has(input.thinkingFormat)) {
            model.thinkingFormat = input.thinkingFormat as ModelConfig['thinkingFormat'];
        }
        if (typeof input.reasoningFormat === 'string' && REASONING_FORMATS.has(input.reasoningFormat)) {
            model.reasoningFormat = input.reasoningFormat as ModelConfig['reasoningFormat'];
        }
        const reasoningEffort = asStringArray(input.reasoningEffort, REASONING_EFFORTS, 7);
        if (reasoningEffort) {
            model.reasoningEffort = reasoningEffort as ModelConfig['reasoningEffort'];
        }
        if (typeof input.reasoningDefault === 'string' && REASONING_EFFORTS.has(input.reasoningDefault)) {
            if (!model.reasoningEffort || (model.reasoningEffort as string[]).includes(input.reasoningDefault)) {
                model.reasoningDefault = input.reasoningDefault as ModelConfig['reasoningDefault'];
            }
        }
        if (Array.isArray(input.contextSize)) {
            const sizes = input.contextSize.filter(
                (size): size is number =>
                    typeof size === 'number' && Number.isInteger(size) && size > 0 && size <= 10_000_000
            );
            if (sizes.length > 0) {
                model.contextSize = sizes;
            }
        }
        if (Array.isArray(input.serviceTier)) {
            const tiers = input.serviceTier
                .map(tier => asCleanString(tier, 64))
                .filter((tier): tier is string => tier !== undefined);
            if (tiers.length > 0) {
                model.serviceTier = [...new Set(tiers)];
            }
        }
        const pricing = normalizeTokenPricing(input.tokenPricing as ModelConfig['tokenPricing']);
        if (pricing) {
            model.tokenPricing = pricing;
        }
        const limit = asRateLimit(input.limit);
        if (limit) {
            model.limit = limit;
        }
        const customHeader = asCustomHeader(input.customHeader);
        if (customHeader) {
            model.customHeader = customHeader;
        }
        const extraBody = asBoundedJsonObject(input.extraBody, 8192);
        if (extraBody) {
            model.extraBody = extraBody;
        }
        if (typeof input.useInstructions === 'boolean') {
            model.useInstructions = input.useInstructions;
        }
        if (typeof input.cacheTtl === 'string' && CACHE_TTLS.has(input.cacheTtl)) {
            model.cacheTtl = input.cacheTtl as ModelConfig['cacheTtl'];
        }
        const webSearchTool = asWebSearchTool(input.webSearchTool);
        if (webSearchTool !== undefined) {
            model.webSearchTool = webSearchTool;
        }
        const nativeTools = asNativeTools(input.nativeTools);
        if (nativeTools) {
            model.nativeTools = nativeTools;
        }

        // 目的地/密钥槽位字段仅从内置同 id 模型继承；无内置对应（全新模型）则保持剥离
        const builtinModel = builtinById.get(id);
        if (builtinModel) {
            for (const key of INHERIT_ONLY_FIELDS) {
                const inheritedValue = builtinModel[key];
                if (inheritedValue !== undefined) {
                    model[key] = inheritedValue;
                }
            }
        }

        remoteModelsById.set(model.id, model);
    }

    if (remoteModelsById.size === 0 && root.models.length > 0) {
        return undefined;
    }
    // 合并去重：远端定义优先，内置中未出现的模型作为回退项（待下次插件更新移除）
    const models = [...remoteModelsById.values()];
    for (const builtin of builtinById.values()) {
        if (!remoteModelsById.has(builtin.id)) {
            models.push(builtin);
        }
    }
    return { models, droppedModels, strippedFields: [...stripped].sort() };
}

/** 当前生效的远程模型快照（providerKey → 清洗后模型列表；由宿主层写入） */
const remoteModelsSnapshot = new Map<string, ModelConfig[]>();

/** 宿主层写入/清除某 provider 的远程模型快照；undefined 表示移除（回退内置） */
export function setRemoteProviderModels(providerKey: string, models: ModelConfig[] | undefined): void {
    if (models) {
        remoteModelsSnapshot.set(providerKey, models);
    } else {
        remoteModelsSnapshot.delete(providerKey);
    }
}

/** 读取远程模型覆盖层（供 ConfigManager.getConfigProvider 合并；不暴露可变引用） */
export function getRemoteModelsOverlay(): ReadonlyMap<string, readonly ModelConfig[]> {
    return remoteModelsSnapshot;
}
