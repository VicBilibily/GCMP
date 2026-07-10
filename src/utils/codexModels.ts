import { ModelConfig } from '../types/sharedTypes';

/** 认可的 reasoningEffort 可选值集合，用于校验远端数据合法性 */
const reasoningEfforts = new Set<NonNullable<ModelConfig['reasoningEffort']>[number]>([
    'none',
    'minimal',
    'low',
    'medium',
    'high',
    'xhigh',
    'max'
]);

/**
 * Codex 远端 API 返回的模型数据结构
 * 对应 /backend-api/codex/models 响应中的单个模型对象
 */
interface CodexRemoteModel {
    /** 模型标识符（如 gpt-5.4） */
    slug: string;
    /** 模型展示名称 */
    displayName?: string;
    /** 模型描述 */
    description?: string;
    /** 上下文窗口大小 */
    contextWindow?: number;
    /** 模型支持的输入模态（如 image、text） */
    inputModalities?: string[];
    /** 支持的推理深度级别列表 */
    reasoningEffort: NonNullable<ModelConfig['reasoningEffort']>;
    /** 默认推理深度 */
    reasoningDefault?: ModelConfig['reasoningDefault'];
    /** 服务等级选项（如 default、priority） */
    serviceTier?: string[];
    /** 排序优先级（数值越小越靠前） */
    priority: number;
}

/**
 * 将未知类型安全转换为 Record<string, unknown>
 * 用于安全访问远端 API 返回的未结构化数据
 */
function asRecord(value: unknown): Record<string, unknown> | undefined {
    return typeof value === 'object' && value !== null && !Array.isArray(value) ?
            (value as Record<string, unknown>)
        :   undefined;
}

/**
 * 提取非空字符串，过滤掉空值和纯空白字符串
 */
function nonEmptyString(value: unknown): string | undefined {
    return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

/**
 * 将未知值转换为字符串数组，自动过滤空值
 */
function stringArray(value: unknown): string[] {
    if (!Array.isArray(value)) {
        return [];
    }
    return value.map(nonEmptyString).filter((item): item is string => Boolean(item));
}

/**
 * 解析远端 API 的 supported_reasoning_levels 字段
 * 每个 level 是形如 { effort: 'medium' } 的对象，提取其中的 effort 值并去重
 */
function parseReasoningEfforts(value: unknown): NonNullable<ModelConfig['reasoningEffort']> {
    if (!Array.isArray(value)) {
        return [];
    }

    const efforts: NonNullable<ModelConfig['reasoningEffort']> = [];
    for (const item of value) {
        const effort = nonEmptyString(asRecord(item)?.effort) as NonNullable<ModelConfig['reasoningEffort']>[number];
        if (effort && reasoningEfforts.has(effort) && !efforts.includes(effort)) {
            efforts.push(effort);
        }
    }
    return efforts;
}

/**
 * 解析远端 API 返回的单个模型对象
 * 仅当 visibility === 'list' 且 supported_in_api === true 时视为可用模型
 */
function parseRemoteModel(value: unknown): CodexRemoteModel | undefined {
    const record = asRecord(value);
    const slug = nonEmptyString(record?.slug);
    if (!record || !slug || record.visibility !== 'list' || record.supported_in_api !== true) {
        return undefined;
    }

    const reasoningEffort = parseReasoningEfforts(record.supported_reasoning_levels);
    const defaultReasoning = nonEmptyString(record.default_reasoning_level) as ModelConfig['reasoningDefault'];
    const serviceTiers =
        Array.isArray(record.service_tiers) ?
            record.service_tiers
                .map(item => nonEmptyString(asRecord(item)?.slug) ?? nonEmptyString(asRecord(item)?.name))
                .filter((item): item is string => Boolean(item))
        :   [];
    const contextWindow =
        (
            typeof record.context_window === 'number' &&
            Number.isFinite(record.context_window) &&
            record.context_window > 0
        ) ?
            Math.floor(record.context_window)
        :   undefined;

    return {
        slug,
        displayName: nonEmptyString(record.display_name),
        description: nonEmptyString(record.description),
        contextWindow,
        inputModalities: Array.isArray(record.input_modalities) ? stringArray(record.input_modalities) : undefined,
        reasoningEffort,
        reasoningDefault: defaultReasoning && reasoningEffort.includes(defaultReasoning) ? defaultReasoning : undefined,
        serviceTier: serviceTiers.length > 0 ? serviceTiers : undefined,
        priority:
            typeof record.priority === 'number' && Number.isFinite(record.priority) ? record.priority : Number.MAX_VALUE
    };
}

/**
 * 从候选值列表中选取第一个在 efforts 中的值作为默认推理深度
 * 均不匹配时回退到 'medium' 或 efforts 的第一个值
 */
function resolveReasoningDefault(
    efforts: NonNullable<ModelConfig['reasoningEffort']>,
    ...candidates: Array<ModelConfig['reasoningDefault']>
): ModelConfig['reasoningDefault'] {
    for (const candidate of candidates) {
        if (candidate && efforts.includes(candidate)) {
            return candidate;
        }
    }
    return efforts.includes('medium') ? 'medium' : efforts[0];
}

/**
 * 根据远端模型数据创建完整的 ModelConfig 对象
 * 仅在本地无对应预置模型时使用，确保远端正交的模型也能正常显示
 */
function createDefaultModel(remote: CodexRemoteModel): ModelConfig {
    const reasoningDefault = resolveReasoningDefault(remote.reasoningEffort, remote.reasoningDefault);
    const extraBody: Record<string, unknown> = {
        store: false,
        tool_choice: 'auto'
    };
    if (reasoningDefault) {
        extraBody.reasoning = {
            effort: reasoningDefault,
            summary: 'auto'
        };
    }
    return {
        id: remote.slug,
        name: `${remote.displayName ?? remote.slug} (ChatGPT)`,
        tooltip: remote.description ?? `ChatGPT Codex model ${remote.slug}`,
        sdkMode: 'openai-responses',
        maxInputTokens: remote.contextWindow ?? 272000,
        maxOutputTokens: 128000,
        useInstructions: true,
        reasoningEffort: remote.reasoningEffort.length > 0 ? remote.reasoningEffort : undefined,
        reasoningDefault,
        serviceTier: remote.serviceTier,
        capabilities: {
            toolCalling: true,
            imageInput: remote.inputModalities?.includes('image') ?? false
        },
        extraBody
    };
}

/**
 * 解析 Codex 后端 /backend-api/codex/models 接口响应，返回可用模型列表
 *
 * 处理规则：
 * 1. 仅保留远端标记为可见（visibility=list）且支持 API（supported_in_api=true）的模型
 * 2. 本地已预置的模型使用完整本地配置，远端数据仅控制显现
 * 3. 远端独有的模型通过 createDefaultModel 自动创建
 * 4. 模型按远端 priority 排序（优先），同 priority 按原始索引排序
 * 5. 重复 slug 的模型仅保留第一条
 */
export function parseCodexModelsResponse(payload: unknown, staticModels: ModelConfig[]): ModelConfig[] {
    const root = asRecord(payload);
    if (!Array.isArray(root?.models)) {
        return [];
    }

    // 建立本地预置模型的 slug→配置 映射，用于快速匹配
    const staticById = new Map(staticModels.map(model => [model.id, model]));
    const seen = new Set<string>();
    const result: ModelConfig[] = [];

    root.models
        // 第一步：逐个解析远端模型，过滤掉不可见的
        .map((value, index) => ({ model: parseRemoteModel(value), index }))
        .filter((item): item is { model: CodexRemoteModel; index: number } => Boolean(item.model))
        // 第二步：按 priority 排序，同 priority 保留 API 返回顺序
        .sort((a, b) => a.model.priority - b.model.priority || a.index - b.index)
        // 第三步：去重并组装最终列表
        .forEach(({ model: remote }) => {
            if (seen.has(remote.slug)) {
                return;
            }
            seen.add(remote.slug);

            const existing = staticById.get(remote.slug);
            if (existing) {
                // 本地预置模型 — 保持完整本地配置，远端只控制显隐
                result.push(existing);
            } else {
                // 远端独有模型 — 根据远端数据创建默认配置
                result.push(createDefaultModel(remote));
            }
        });

    return result;
}
