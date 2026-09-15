/** Hyper 模型列表适配器：接口提供完整元数据。 */
import type { RemoteModelMetadata } from '../types';
import {
    asRecord,
    optionalBoolean,
    optionalPositiveInt,
    optionalString,
    parseModelList,
    parsePricing,
    parseReasoning
} from './validate';

export function parseHyperModels(raw: unknown): RemoteModelMetadata[] {
    return parseModelList(raw, 'Hyper').map(item => {
        const metadata: RemoteModelMetadata = { id: item.id as string };
        const displayName = optionalString(item.display_name);
        if (displayName !== undefined) {
            metadata.displayName = displayName;
        }
        const contextWindow = optionalPositiveInt(item.context_window, `Hyper ${metadata.id}.context_window`);
        if (contextWindow !== undefined) {
            metadata.contextWindow = contextWindow;
        }
        const maxOutputTokens = optionalPositiveInt(item.max_output_tokens, `Hyper ${metadata.id}.max_output_tokens`);
        if (maxOutputTokens !== undefined) {
            metadata.maxOutputTokens = maxOutputTokens;
        }
        const capabilities = item.capabilities;
        if (capabilities !== undefined && capabilities !== null) {
            const vision = optionalBoolean(asRecord(capabilities, `Hyper ${metadata.id}.capabilities`).vision);
            if (vision !== undefined) {
                metadata.capabilities = { imageInput: vision };
            }
        }
        const reasoning = parseReasoning(item.reasoning, `Hyper ${metadata.id}.reasoning`);
        if (reasoning !== undefined) {
            metadata.reasoning = reasoning;
        }
        const pricing = parsePricing(item.pricing, `Hyper ${metadata.id}.pricing`);
        if (pricing !== undefined) {
            metadata.pricing = pricing;
        }
        return metadata;
    });
}
