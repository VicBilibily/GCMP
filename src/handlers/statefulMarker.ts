/*---------------------------------------------------------------------------------------------
 *  模型消息中的 Stateful Marker 处理器
 *  参考: Microsoft vscode-copilot-chat src/platform/endpoint/common/statefulMarkerContainer.tsx
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { CustomDataPartMimeTypes } from './types';

export interface IStatefulMarkerContainer {
    type: typeof CustomDataPartMimeTypes.StatefulMarker;
    value: StatefulMarkerWithModel;
}

const StatefulMarkerExtension = 'vicanent.gcmp';
type StatefulMarkerExtension = 'vicanent.gcmp';
export interface StatefulMarkerContainer {
    extension: StatefulMarkerExtension;
    provider: string;
    modelId: string;
    sdkMode: 'openai' | 'openai-responses' | 'anthropic' | 'gemini';
    /** 会话ID，标识会话上下文 */
    sessionId: string;
    /** 响应ID，模型返回响应标识 */
    responseId: string;
    /** 记录过期时间，单位毫秒(豆包专用) */
    expireAt?: number;
}

export interface StatefulMarkerWithModel {
    /** 这个值不可靠，不代表实际使用的模型ID */
    modelId: string;
    /** 实际传递保存的 marker */
    marker: StatefulMarkerContainer;
}

export function encodeStatefulMarker(modelId: string, marker: Omit<StatefulMarkerContainer, 'extension'>): Uint8Array {
    // MARK: copilot 内部始终会自动处理 modelId, 这里无论传递什么 modelId 都会被重置
    //       我们只需要确保 marker 的数据传递即可

    return new TextEncoder().encode(modelId + '\\' + JSON.stringify({ ...marker, extension: StatefulMarkerExtension }));
}

export function decodeStatefulMarker(data: Uint8Array): StatefulMarkerWithModel {
    const decoded = new TextDecoder().decode(data);
    // MARK: 这里获取到的 modelId 始终为 copilot 内部重置后的值
    const [modelId, markerStr] = decoded.split('\\');
    return { modelId, marker: JSON.parse(markerStr) };
}

/** Gets stateful markers from the messages, from the most to least recent */
export function* getAllStatefulMarkersAndIndicies(messages: readonly vscode.LanguageModelChatMessage[]) {
    for (let idx = messages.length - 1; idx >= 0; idx--) {
        const message = messages[idx];
        if (message.role === vscode.LanguageModelChatMessageRole.Assistant) {
            for (const part of message.content) {
                if (
                    part instanceof vscode.LanguageModelDataPart &&
                    part.mimeType === CustomDataPartMimeTypes.StatefulMarker
                ) {
                    const statefulMarker = decodeStatefulMarker(part.data);
                    if (statefulMarker) {
                        yield { statefulMarker: statefulMarker, index: idx };
                    }
                }
            }
        }
    }
    return undefined;
}

export function getStatefulMarkerAndIndex(
    modelId: string,
    sdkType: StatefulMarkerContainer['sdkMode'],
    messages: readonly vscode.LanguageModelChatMessage[]
): { statefulMarker: StatefulMarkerContainer; index: number } | undefined {
    for (const statefulMarker of getAllStatefulMarkersAndIndicies(messages)) {
        const marker = statefulMarker.statefulMarker?.marker;
        if (marker?.extension === StatefulMarkerExtension && marker?.sessionId) {
            if (marker?.sdkMode === sdkType && marker?.modelId === modelId) {
                return { statefulMarker: marker, index: statefulMarker.index };
            }
        }
    }
    return undefined;
}
