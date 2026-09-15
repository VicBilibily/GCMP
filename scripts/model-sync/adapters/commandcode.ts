/** CommandCode 模型列表适配器：接口提供 ID、名称与上下文长度。 */
import type { RemoteModelMetadata } from '../types';
import { optionalPositiveInt, optionalString, parseModelList } from './validate';

export function parseCommandCodeModels(raw: unknown): RemoteModelMetadata[] {
    return parseModelList(raw, 'CommandCode').map(item => {
        const metadata: RemoteModelMetadata = { id: item.id as string };
        const displayName = optionalString(item.name);
        if (displayName !== undefined) {
            metadata.displayName = displayName;
        }
        const contextWindow = optionalPositiveInt(item.context_length, `CommandCode ${metadata.id}.context_length`);
        if (contextWindow !== undefined) {
            metadata.contextWindow = contextWindow;
        }
        return metadata;
    });
}
