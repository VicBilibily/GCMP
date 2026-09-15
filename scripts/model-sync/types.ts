/** 模型同步脚本的共享类型定义。 */

export type ReasoningEffort = 'none' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max';

export const REASONING_EFFORTS: readonly ReasoningEffort[] = [
    'none',
    'minimal',
    'low',
    'medium',
    'high',
    'xhigh',
    'max'
];

/** 作者默认源中单个模型的本地预设配置。 */
export interface AuthorModelDefaults {
    /** 引用 $templates 中的模板，多个模板按顺序叠加，条目自身字段最优先。 */
    template?: string | string[];
    /** 同作者下的基础模型键；变体仅声明差异字段，禁止链式继承。 */
    variantOf?: string;
    name?: string;
    /** 模型固有的 SDK 模式（如仅支持 Responses 的模型），优先于来源默认 sdkMode。 */
    sdkMode?: string;
    contextSize?: number[];
    maxInputTokens?: number;
    maxOutputTokens?: number;
    reasoningEffort?: ReasoningEffort[];
    reasoningDefault?: ReasoningEffort;
    /** 思考开关选项（如 enabled/disabled），区别于 reasoningEffort 的强度档位。 */
    thinking?: string[];
    thinkingFormat?: string;
    extraBody?: Record<string, unknown>;
    capabilities?: { toolCalling?: boolean; imageInput?: boolean };
}

/** 作者默认源：顶层作者键 → 模型键 → 默认配置；保留键 $templates 存放全局预算模板。 */
export type ModelDefaultsFile = Record<string, Record<string, AuthorModelDefaults>>;

/** 默认源中全局预算模板的保留顶层键。 */
export const TEMPLATES_KEY = '$templates';

/** 来源策略中单个远端模型的显式登记。 */
export interface SourceModelPolicy {
    ref?: string;
    localId?: string;
    removeFields?: string[];
    overrides?: Record<string, unknown>;
}

/** 登记归属 remote-extra（仅远端发布）的模型：sunset 为即将下线迁出预置，online-only 为不入预置（已预置者同轮迁出）。 */
export interface ExtraModelPolicy {
    reason: 'sunset' | 'online-only';
    /** 下线日期 YYYY-MM-DD，仅 sunset 必填；过期后仅报告，不自动移除。 */
    sunsetAt?: string;
    /** 覆盖生成/迁移出的显示名。 */
    name?: string;
    /** 完整覆盖 tooltip；不设时 sunset 条目自动追加下线文案。 */
    tooltipNote?: string;
}

/** 一个远端模型列表接口的同步策略。 */
export interface SourcePolicy {
    adapter: 'hyper' | 'openai-model-list' | 'commandcode';
    endpoint: string;
    target: string;
    nameSuffix?: string;
    tooltipPrefix?: string;
    localIdSuffix?: string;
    excludedModelIds?: string[];
    /** 按 ID 前缀默认跳过新增（仅阻止 onboarding，不移除也不警告既有本地条目）；以 $ 结尾表示精确匹配。 */
    excludedModelIdPrefixes?: string[];
    /** 按 ID 后缀默认跳过新增（语义同前缀排除），如 "-free" 过滤免费模型。 */
    excludedModelIdSuffixes?: string[];
    defaults?: Record<string, unknown>;
    models?: Record<string, SourceModelPolicy>;
    /** 按远端 ID 前缀批量套用的人工调整；idPrefix/idPrefixes 至少其一，多条命中按序叠加，models 精确登记最后胜出。 */
    modelRules?: Array<
        Pick<SourceModelPolicy, 'overrides' | 'removeFields'> & { idPrefix?: string; idPrefixes?: string[] }
    >;
    /** 归属 website/remote-extra/<provider>.json 的模型登记，键为远端模型 ID。 */
    extra?: Record<string, ExtraModelPolicy>;
    /** 下线文案中的供应商自称（如 "Hyper"），缺省回退 tooltipPrefix。 */
    sunsetVendor?: string;
}

export type SourcesFile = Record<string, SourcePolicy>;

/** 适配器归一化后的远端模型元数据；undefined 表示接口未声明。 */
export interface RemoteModelMetadata {
    id: string;
    displayName?: string;
    contextWindow?: number;
    maxOutputTokens?: number;
    capabilities?: { imageInput?: boolean };
    reasoning?: { efforts: ReasoningEffort[]; defaultEffort?: ReasoningEffort };
    pricing?: { input: number; output: number; cacheRead?: number; cacheWrite?: number };
}

/** 供应商配置中的单个模型条目，未识别字段原样保留。 */
export interface ProviderModelEntry {
    id: string;
    name?: string;
    model?: string;
    baseUrl?: string;
    tooltip?: string;
    sdkMode?: string;
    contextSize?: number[];
    maxInputTokens?: number;
    maxOutputTokens?: number;
    reasoningEffort?: ReasoningEffort[];
    reasoningDefault?: ReasoningEffort;
    capabilities?: { toolCalling?: boolean; imageInput?: boolean };
    tokenPricing?: unknown;
    [key: string]: unknown;
}

export interface ProviderConfigFile {
    displayName?: string;
    baseUrl?: string;
    models: ProviderModelEntry[];
    [key: string]: unknown;
}

export type ChangeOrigin = 'remote' | 'author' | 'override' | 'default';

export interface FieldChange {
    field: string;
    from: unknown;
    to: unknown;
    origin: ChangeOrigin;
}

export interface ModelPlanEntry {
    action: 'add' | 'update' | 'remove';
    remoteId: string;
    localId: string;
    target?: ProviderModelEntry;
    changes?: FieldChange[];
    reason?: string;
    /** add 动作的插入锚点：插到该既有模型之后；与 before 二选一。 */
    after?: string;
    /** add 动作的插入锚点：插到该既有模型之前（族内最新时）。 */
    before?: string;
}

export interface SourcePlan {
    sourceId: string;
    targetPath: string;
    entries: ModelPlanEntry[];
    warnings: string[];
    errors: string[];
}

/** remote-extra 目标的写入计划；对应的预置移除动作已并入预置 SourcePlan。 */
export interface ExtraPlan {
    sourceId: string;
    /** remote-extra 文件路径（website/remote-extra/<provider>.json）。 */
    extraPath: string;
    entries: ModelPlanEntry[];
    warnings: string[];
    errors: string[];
}

/** 写入层的字段操作。 */
export type FieldOp = { kind: 'set'; field: string; value: unknown } | { kind: 'remove'; field: string };

export interface TargetEdit {
    updates: Array<{ localId: string; ops: FieldOp[] }>;
    removals: string[];
    /** 新增条目；after/before 为插入锚点（既有模型 id），均缺省时追加到数组末尾。 */
    additions: Array<{ entry: ProviderModelEntry; after?: string; before?: string }>;
}
