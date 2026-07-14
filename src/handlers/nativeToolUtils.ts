import type { NativeToolConfig, WebSearchToolConfig } from '../types/sharedTypes';

export function mergeNativeToolConfigs(
    nativeTools?: readonly NativeToolConfig[],
    webSearchTool?: boolean | WebSearchToolConfig
): NativeToolConfig[] {
    const merged: NativeToolConfig[] = [];
    const indexByType = new Map<string, number>();

    if (Array.isArray(nativeTools)) {
        for (const nativeTool of nativeTools) {
            if (!nativeTool?.type) {
                continue;
            }

            const existingIndex = indexByType.get(nativeTool.type);
            if (existingIndex === undefined) {
                indexByType.set(nativeTool.type, merged.length);
                merged.push(nativeTool);
            } else {
                merged[existingIndex] = nativeTool;
            }
        }
    }

    if (webSearchTool && !indexByType.has('web_search')) {
        merged.push({
            type: 'web_search',
            ...(typeof webSearchTool === 'object' && webSearchTool !== null ? webSearchTool : {})
        });
    }

    return merged;
}
