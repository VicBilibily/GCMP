/** 远端模型列表响应的边界校验与归一化辅助。 */
import { REASONING_EFFORTS, type ReasoningEffort, type RemoteModelMetadata } from '../types';

export function asRecord(value: unknown, label: string): Record<string, unknown> {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
        throw new Error(`${label} 必须是对象`);
    }
    return value as Record<string, unknown>;
}

export function parseModelList(raw: unknown, label: string): Record<string, unknown>[] {
    const root = asRecord(raw, `${label} 响应`);
    if (!Array.isArray(root.data)) {
        throw new Error(`${label} 响应缺少 data 数组`);
    }
    if (root.data.length === 0) {
        throw new Error(`${label} 返回空模型列表，判定为接口异常`);
    }
    const items = root.data.map((item, index) => asRecord(item, `${label} 模型[${index}]`));
    const seen = new Set<string>();
    for (const item of items) {
        if (typeof item.id !== 'string' || !item.id) {
            throw new Error(`${label} 存在缺失 id 的模型`);
        }
        if (seen.has(item.id)) {
            throw new Error(`${label} 存在重复模型 id "${item.id}"`);
        }
        seen.add(item.id);
    }
    return items;
}

export function optionalString(value: unknown): string | undefined {
    return typeof value === 'string' && value ? value : undefined;
}

export function optionalPositiveInt(value: unknown, label: string): number | undefined {
    if (value === undefined || value === null) {
        return undefined;
    }
    if (typeof value !== 'number' || !Number.isSafeInteger(value) || value <= 0) {
        throw new Error(`${label} 必须是正整数`);
    }
    return value;
}

export function optionalPrice(value: unknown, label: string): number | undefined {
    if (value === undefined || value === null) {
        return undefined;
    }
    if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
        throw new Error(`${label} 必须是非负有限数值`);
    }
    return value;
}

export function optionalBoolean(value: unknown): boolean | undefined {
    return typeof value === 'boolean' ? value : undefined;
}

export function parseReasoning(value: unknown, label: string): RemoteModelMetadata['reasoning'] {
    if (value === undefined || value === null) {
        return undefined;
    }
    const reasoning = asRecord(value, label);
    if (!Array.isArray(reasoning.effort_levels)) {
        return undefined;
    }
    const efforts: ReasoningEffort[] = [];
    for (const level of reasoning.effort_levels) {
        const entry = asRecord(level, `${label}.effort_levels[]`);
        const raw = entry.value;
        if (typeof raw !== 'string' || !(REASONING_EFFORTS as readonly string[]).includes(raw)) {
            throw new Error(`${label} 包含不支持的推理档位 "${String(raw)}"`);
        }
        efforts.push(raw as ReasoningEffort);
    }
    const defaultEffort = reasoning.default_effort_level;
    if (defaultEffort !== undefined && defaultEffort !== null) {
        if (typeof defaultEffort !== 'string' || !efforts.includes(defaultEffort as ReasoningEffort)) {
            throw new Error(`${label} 默认推理档位不在档位列表中`);
        }
        return { efforts, defaultEffort: defaultEffort as ReasoningEffort };
    }
    return { efforts };
}

export function parsePricing(value: unknown, label: string): RemoteModelMetadata['pricing'] {
    if (value === undefined || value === null) {
        return undefined;
    }
    const pricing = asRecord(value, label);
    const input = optionalPrice(pricing.input, `${label}.input`);
    const output = optionalPrice(pricing.output, `${label}.output`);
    if (input === undefined || output === undefined) {
        return undefined;
    }
    // 接口字段 cache_hit 对应读取价、cache_create 对应写入价
    return {
        input,
        output,
        cacheRead: optionalPrice(pricing.cache_hit, `${label}.cache_hit`),
        cacheWrite: optionalPrice(pricing.cache_create, `${label}.cache_create`)
    };
}
