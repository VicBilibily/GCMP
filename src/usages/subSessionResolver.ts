/*---------------------------------------------------------------------------------------------
 *  子会话（sub-session）解析器
 *  无 vscode 依赖；旧 Copilot Chat 保留哈希身份，其他来源无子代理连续性时使用随机身份。
 *--------------------------------------------------------------------------------------------*/

import * as crypto from 'node:crypto';
import { decodeGCMPStatefulMarkerPayload } from '../handlers/stateful/statefulMarkerCodec';
import { CustomDataPartMimeTypes } from '../handlers/types';
import type { RequestOrigin } from '../handlers/classification/requestClassification';

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
    parentSessionStable: boolean,
    requestOrigin: RequestOrigin = 'copilot-chat'
): string | undefined {
    if (requestKind !== 'search-subagent' && requestKind !== 'execution-subagent' && requestKind !== 'subagent') {
        return undefined;
    }
    const legacy = requestOrigin === 'copilot-chat';
    const fromMarker = readSubSessionIdFromMarkers(messages, parentSessionId, legacy);
    if (fromMarker) {
        return fromMarker;
    }
    if (!legacy) {
        return SUB_SESSION_ID_PREFIX + crypto.randomUUID().replace(/-/g, '');
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
    parentSessionId: string,
    legacy: boolean
): string | undefined {
    for (let idx = messages.length - 1; idx >= 0; idx -= 1) {
        const message = messages[idx];
        if (!message || message.role !== ROLE_ASSISTANT || !Array.isArray(message.content)) {
            continue;
        }
        for (let partIdx = message.content.length - 1; partIdx >= 0; partIdx--) {
            const part = message.content[partIdx];
            const candidate = part as { mimeType?: unknown; data?: unknown } | null;
            if (
                candidate?.mimeType !== CustomDataPartMimeTypes.StatefulMarker ||
                !(candidate.data instanceof Uint8Array)
            ) {
                continue;
            }
            const decoded = decodeGCMPStatefulMarkerPayload(candidate.data);
            const marker = decoded?.marker;
            if (!marker || marker.sessionId !== parentSessionId) {
                continue;
            }
            if (!legacy && (marker.continuity?.scope !== 'subagent' || marker.continuity.agentRole !== 'subagent')) {
                return undefined;
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
        if (!message || message.role !== ROLE_USER || !Array.isArray(message.content)) {
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
