/** OpenCode Zen / Go 模型列表适配器：接口仅提供 ID 清单。 */
import type { RemoteModelMetadata } from '../types';
import { parseModelList } from './validate';

export function parseOpenAiModelList(raw: unknown, label: string): RemoteModelMetadata[] {
    return parseModelList(raw, label).map(item => ({ id: item.id as string }));
}
