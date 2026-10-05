/** models.dev 目录适配器：按 policy.modelsDevProvider 读取指定提供商的完整元数据。 */
import { REASONING_EFFORTS, type ReasoningEffort, type RemoteModelMetadata, type SourcePolicy } from '../types';
import { asRecord, optionalPositiveInt, optionalPrice, optionalString } from './validate';

export function parseModelsDevProviderModels(raw: unknown, label: string, policy: SourcePolicy): RemoteModelMetadata[] {
    const providerKey = policy.modelsDevProvider;
    if (typeof providerKey !== 'string' || providerKey.trim().length === 0) {
        throw new Error(`${label}: models-dev 适配器缺少 modelsDevProvider`);
    }
    const root = asRecord(raw, `${label} 响应`);
    const provider = asRecord(root[providerKey], `${label} 提供商 ${providerKey}`);
    const models = provider.models;
    if (typeof models !== 'object' || models === null || Array.isArray(models)) {
        throw new Error(`${label} 提供商 ${providerKey} 缺少 models 对象`);
    }
    const entries = Object.entries(models as Record<string, unknown>);
    if (entries.length === 0) {
        throw new Error(`${label} 提供商 ${providerKey} 返回空模型列表，判定为接口异常`);
    }
    return entries.map(([id, value]) => toMetadata(id, asRecord(value, `${label} ${id}`), label));
}

function toMetadata(id: string, model: Record<string, unknown>, label: string): RemoteModelMetadata {
    const metadata: RemoteModelMetadata = { id };
    const displayName = optionalString(model.name);
    if (displayName !== undefined && displayName !== id) {
        metadata.displayName = displayName;
    }
    const limit = optionalRecord(model.limit, `${label} ${id}.limit`);
    const contextWindow = optionalPositiveInt(limit?.context, `${label} ${id}.limit.context`);
    if (contextWindow !== undefined) {
        metadata.contextWindow = contextWindow;
    }
    const maxOutputTokens = optionalPositiveInt(limit?.output, `${label} ${id}.limit.output`);
    if (maxOutputTokens !== undefined) {
        metadata.maxOutputTokens = maxOutputTokens;
    }
    const inputModalities = optionalRecord(model.modalities, `${label} ${id}.modalities`)?.input;
    if (Array.isArray(inputModalities)) {
        metadata.capabilities = { imageInput: inputModalities.includes('image') };
    }
    const reasoning = parseReasoning(model.reasoning_options, `${label} ${id}.reasoning_options`);
    if (reasoning !== undefined) {
        metadata.reasoning = reasoning;
    }
    const pricing = parsePricing(model.cost, `${label} ${id}.cost`);
    if (pricing !== undefined) {
        metadata.pricing = pricing;
    }
    return metadata;
}

function optionalRecord(value: unknown, label: string): Record<string, unknown> | undefined {
    return value === undefined || value === null ? undefined : asRecord(value, label);
}

/** 仅消费 type=effort 的档位；空档位（如仅声明 reasoning=true）视为未声明。 */
function parseReasoning(value: unknown, label: string): RemoteModelMetadata['reasoning'] {
    if (!Array.isArray(value)) {
        return undefined;
    }
    const efforts: ReasoningEffort[] = [];
    for (const entry of value) {
        const option = asRecord(entry, `${label}[]`);
        if (option.type !== 'effort' || !Array.isArray(option.values)) {
            continue;
        }
        for (const raw of option.values) {
            if (typeof raw !== 'string' || !(REASONING_EFFORTS as readonly string[]).includes(raw)) {
                throw new Error(`${label} 包含不支持的推理档位 "${String(raw)}"`);
            }
            if (!efforts.includes(raw as ReasoningEffort)) {
                efforts.push(raw as ReasoningEffort);
            }
        }
    }
    return efforts.length > 0 ? { efforts } : undefined;
}

/** models.dev 的 cost 缺省或仅含部分字段时视为未声明，交由本地配置保留。 */
function parsePricing(value: unknown, label: string): RemoteModelMetadata['pricing'] {
    const cost = optionalRecord(value, label);
    if (!cost) {
        return undefined;
    }
    const input = optionalPrice(cost.input, `${label}.input`);
    const output = optionalPrice(cost.output, `${label}.output`);
    if (input === undefined || output === undefined) {
        return undefined;
    }
    return {
        input,
        output,
        cacheRead: optionalPrice(cost.cache_read, `${label}.cache_read`),
        cacheWrite: optionalPrice(cost.cache_write, `${label}.cache_write`)
    };
}
