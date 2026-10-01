/*---------------------------------------------------------------------------------------------
 *  子会话（sub-session）解析器
 *  为搜索/执行子代理请求生成稳定的子会话标识：优先从 GCMP 自己回写的 StatefulMarker 读回，
 *  首轮无标记时按 父会话|类型|任务文本 的确定性哈希生成，并随 marker 在后续轮次往返。
 *  纯函数实现（无 vscode 依赖），供 genericModelProvider 与单元测试直接使用。
 *--------------------------------------------------------------------------------------------*/

import * as crypto from 'node:crypto';
import { decodeStatefulMarkerPayload } from '../handlers/statefulMarkerCodec';
import { CustomDataPartMimeTypes } from '../handlers/types';
import type { StatefulMarkerContainer } from '../handlers/statefulMarker';

// 与 VS Code LanguageModelChatMessageRole 数值保持一致（vscode 枚举在 node:test 下不可用）
const ROLE_USER = 1;
const ROLE_ASSISTANT = 2;

const SUB_SESSION_ID_PREFIX = 'sub_';
const SUB_SESSION_ID_PATTERN = /^sub_[0-9a-f]{32}$/;

export interface SubSessionMessageLike {
    role: number;
    content: ReadonlyArray<unknown>;
}

/**
 * 解析子会话 ID（仅子代理类请求有值）。
 * @param parentSessionStable 父 sessionId 是否来自稳定来源（非 new-uuid 随机值）；
 *                            不稳定时签名降级，避免把随机锚点混入确定性身份。
 */
export function resolveSubSessionId(
    messages: readonly SubSessionMessageLike[],
    parentSessionId: string,
    requestKind: string,
    parentSessionStable: boolean
): string | undefined {
    if (requestKind !== 'search-subagent' && requestKind !== 'execution-subagent') {
        return undefined;
    }
    const fromMarker = readSubSessionIdFromMarkers(messages, parentSessionId);
    if (fromMarker) {
        return fromMarker;
    }
    const taskText = extractFirstUserText(messages);
    if (!taskText) {
        return undefined;
    }
    const anchor = parentSessionStable ? `${parentSessionId}|${requestKind}|${taskText}` : `${requestKind}|${taskText}`;
    return SUB_SESSION_ID_PREFIX + crypto.createHash('sha256').update(anchor).digest('hex').slice(0, 32);
}

function readSubSessionIdFromMarkers(
    messages: readonly SubSessionMessageLike[],
    parentSessionId: string
): string | undefined {
    for (let idx = messages.length - 1; idx >= 0; idx -= 1) {
        const message = messages[idx];
        if (!message || message.role !== ROLE_ASSISTANT) {
            continue;
        }
        for (const part of message.content) {
            const candidate = part as { mimeType?: unknown; data?: unknown } | null;
            if (
                candidate?.mimeType !== CustomDataPartMimeTypes.StatefulMarker ||
                !(candidate.data instanceof Uint8Array)
            ) {
                continue;
            }
            const decoded = decodeStatefulMarkerPayload<StatefulMarkerContainer>(candidate.data);
            const marker = decoded?.marker;
            if (marker?.extension !== 'vicanent.gcmp' || marker.sessionId !== parentSessionId) {
                continue;
            }
            const subSessionId = marker.subSessionId;
            return typeof subSessionId === 'string' && SUB_SESSION_ID_PATTERN.test(subSessionId) ?
                    subSessionId
                :   undefined;
        }
    }
    return undefined;
}

function extractFirstUserText(messages: readonly SubSessionMessageLike[]): string | undefined {
    for (const message of messages) {
        if (message.role !== ROLE_USER) {
            continue;
        }
        let text = '';
        for (const part of message.content) {
            const value = (part as { value?: unknown } | null)?.value;
            if (typeof value === 'string') {
                text += value;
            }
        }
        const normalized = text.replace(/\s+/g, ' ').trim();
        return normalized || undefined;
    }
    return undefined;
}
