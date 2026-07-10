import { ModelConfig } from '../types/sharedTypes';

const reasoningEfforts = new Set<NonNullable<ModelConfig['reasoningEffort']>[number]>([
    'none',
    'minimal',
    'low',
    'medium',
    'high',
    'xhigh',
    'max'
]);

interface CodexRemoteModel {
    slug: string;
    displayName?: string;
    description?: string;
    contextWindow?: number;
    inputModalities?: string[];
    reasoningEffort: NonNullable<ModelConfig['reasoningEffort']>;
    reasoningDefault?: ModelConfig['reasoningDefault'];
    serviceTier?: string[];
    priority: number;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
    return typeof value === 'object' && value !== null && !Array.isArray(value) ?
            (value as Record<string, unknown>)
        :   undefined;
}

function nonEmptyString(value: unknown): string | undefined {
    return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function stringArray(value: unknown): string[] {
    if (!Array.isArray(value)) {
        return [];
    }
    return value.map(nonEmptyString).filter((item): item is string => Boolean(item));
}

function parseReasoningEfforts(value: unknown): NonNullable<ModelConfig['reasoningEffort']> {
    if (!Array.isArray(value)) {
        return [];
    }

    const efforts: NonNullable<ModelConfig['reasoningEffort']> = [];
    for (const item of value) {
        const effort = nonEmptyString(asRecord(item)?.effort) as NonNullable<
            ModelConfig['reasoningEffort']
        >[number];
        if (effort && reasoningEfforts.has(effort) && !efforts.includes(effort)) {
            efforts.push(effort);
        }
    }
    return efforts;
}

function parseRemoteModel(value: unknown): CodexRemoteModel | undefined {
    const record = asRecord(value);
    const slug = nonEmptyString(record?.slug);
    if (!record || !slug || record.visibility !== 'list' || record.supported_in_api !== true) {
        return undefined;
    }

    const reasoningEffort = parseReasoningEfforts(record.supported_reasoning_levels);
    const defaultReasoning = nonEmptyString(record.default_reasoning_level) as ModelConfig['reasoningDefault'];
    const serviceTiers = Array.isArray(record.service_tiers) ?
        record.service_tiers
            .map(item => nonEmptyString(asRecord(item)?.slug) ?? nonEmptyString(asRecord(item)?.name))
            .filter((item): item is string => Boolean(item))
        :   [];
    const contextWindow =
        typeof record.context_window === 'number' && Number.isFinite(record.context_window) && record.context_window > 0 ?
            Math.floor(record.context_window)
        :   undefined;

    return {
        slug,
        displayName: nonEmptyString(record.display_name),
        description: nonEmptyString(record.description),
        contextWindow,
        inputModalities: Array.isArray(record.input_modalities) ? stringArray(record.input_modalities) : undefined,
        reasoningEffort,
        reasoningDefault:
            defaultReasoning && reasoningEffort.includes(defaultReasoning) ? defaultReasoning : undefined,
        serviceTier: serviceTiers.length > 0 ? serviceTiers : undefined,
        priority:
            typeof record.priority === 'number' && Number.isFinite(record.priority) ? record.priority : Number.MAX_VALUE
    };
}

function getConfiguredReasoningEffort(model: ModelConfig): ModelConfig['reasoningDefault'] {
    return nonEmptyString(asRecord(model.extraBody?.reasoning)?.effort) as ModelConfig['reasoningDefault'];
}

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

function withReasoningEffort(
    extraBody: ModelConfig['extraBody'],
    effort: ModelConfig['reasoningDefault']
): ModelConfig['extraBody'] {
    if (!effort) {
        return extraBody;
    }

    return {
        ...extraBody,
        reasoning: {
            ...asRecord(extraBody?.reasoning),
            effort
        }
    };
}

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

export function parseCodexModelsResponse(payload: unknown, staticModels: ModelConfig[]): ModelConfig[] {
    const root = asRecord(payload);
    if (!Array.isArray(root?.models)) {
        return [];
    }

    const staticById = new Map(staticModels.map(model => [model.id, model]));
    const seen = new Set<string>();
    return root.models
        .map((value, index) => ({ model: parseRemoteModel(value), index }))
        .filter((item): item is { model: CodexRemoteModel; index: number } => Boolean(item.model))
        .sort((a, b) => a.model.priority - b.model.priority || a.index - b.index)
        .filter(({ model }) => {
            if (seen.has(model.slug)) {
                return false;
            }
            seen.add(model.slug);
            return true;
        })
        .map(({ model: remote }) => {
            const base = staticById.get(remote.slug) ?? createDefaultModel(remote);
            const reasoningEffort =
                remote.reasoningEffort.length > 0 ? remote.reasoningEffort : base.reasoningEffort;
            const reasoningDefault =
                reasoningEffort && reasoningEffort.length > 0 ?
                    resolveReasoningDefault(
                        reasoningEffort,
                        remote.reasoningDefault,
                        base.reasoningDefault,
                        getConfiguredReasoningEffort(base)
                    )
                :   undefined;
            return {
                ...base,
                id: remote.slug,
                name: remote.displayName ? `${remote.displayName} (ChatGPT)` : base.name,
                tooltip: remote.description ?? base.tooltip,
                maxInputTokens: remote.contextWindow ?? base.maxInputTokens,
                capabilities: {
                    ...base.capabilities,
                    imageInput: remote.inputModalities?.includes('image') ?? base.capabilities.imageInput
                },
                reasoningEffort,
                reasoningDefault,
                serviceTier: remote.serviceTier ?? base.serviceTier,
                extraBody: withReasoningEffort(base.extraBody, reasoningDefault)
            };
        });
}