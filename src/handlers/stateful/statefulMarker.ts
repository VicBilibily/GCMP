/*---------------------------------------------------------------------------------------------
 *  模型消息中的 Stateful Marker 处理器
 *  参考: Microsoft vscode-copilot-chat src/platform/endpoint/common/statefulMarkerContainer.tsx
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { CustomDataPartMimeTypes, isStatefulMarkerMimeType } from '../types';
import {
    decodeGCMPStatefulMarkerPayload,
    describeStatefulMarkerPayload,
    encodeStatefulMarkerPayload,
    type StatefulMarkerPayloadDiagnostic
} from './statefulMarkerCodec';
import type { GeminiContent } from '../gemini/geminiType';
import type { AgentRole } from '../classification/requestClassification';

// 当前 console.warn 确保该模块在 node:test 环境中也能独立运行

export interface IStatefulMarkerContainer {
    type: typeof CustomDataPartMimeTypes.StatefulMarker;
    value: StatefulMarkerWithModel;
}

export type GeminiSignedPartKind = 'text' | 'thought' | 'standalone';

export interface GeminiThoughtSignatureMarker {
    signature: string;
    callId?: string;
    name?: string;
    partKind?: GeminiSignedPartKind;
    partIndex?: number;
}

export interface GeminiToolCallMarker {
    localCallId: string;
    upstreamCallId?: string;
    name: string;
}

const StatefulMarkerExtension = 'vicanent.gcmp';
type StatefulMarkerExtension = 'vicanent.gcmp';
export interface StatefulMarkerContainer {
    extension: StatefulMarkerExtension;
    provider: string;
    modelId: string;
    sdkMode: 'openai' | 'openai-responses' | 'anthropic' | 'gemini';
    statefulCredentialId?: string;
    /** 会话ID，标识会话上下文 */
    sessionId: string;
    /** 子代理会话ID，用于负载均衡粘滞与用量归属 */
    subSessionId?: string;
    continuity?: {
        version: 1;
        scope: 'chain' | 'subagent';
        agentRole: AgentRole;
    };
    balanceAffinity?: {
        slot: string;
        balanceKey: string;
        credentialId: string;
    };
    /** 响应ID，模型返回响应标识 */
    responseId: string;
    /** 需要跨轮次稳定回传的完整思考内容 */
    completeThinking?: string;
    /** 需要跨轮次稳定回传的完整签名内容（signature_delta 累积） */
    completeSignature?: string;
    /**
     * 当前 assistant 轮次的加密推理内容（按模型格式原样持久化，供历史 ThinkingPart 被剥离时恢复）
     * - openai-responses：encryptedReasoning[].encryptedContent + 原始 reasoningId
     * - anthropic：encryptedThinkingData[]（redacted_thinking 的 data，按原顺序保留多个块）
     */
    encryptedReasoning?: Array<{ encryptedContent: string; reasoningId?: string }>;
    /** anthropic redacted_thinking 的加密 data 列表（按原顺序） */
    encryptedThinkingData?: string[];
    /** Gemini thoughtSignature，工具调用按 callId、其他 Part 按类型与序号持久化 */
    geminiThoughtSignatures?: GeminiThoughtSignatureMarker[];
    /** Gemini 原始模型响应，保留多轮请求要求的 Part 顺序与签名位置 */
    geminiContents?: GeminiContent[];
    /** Gemini 实际请求端点与 wire model 的不可逆身份摘要 */
    geminiRequestIdentity?: string;
    /** VS Code 本地 callId 与 Gemini 上游 callId 的对应关系 */
    geminiToolCalls?: GeminiToolCallMarker[];
    /** 当前 assistant 轮次是否发生过工具调用 */
    hasToolCalls?: boolean;
    /** 跨轮次持久化的 API 实际 usage（归一化格式），供下轮增量 token 预估 */
    usage?: MarkerUsage;
}

/** 归一化的跨轮次 usage 数据 */
export interface MarkerUsage {
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
}

export interface StatefulMarkerWithModel {
    modelId: string;
    /** 实际传递保存的 marker */
    marker: StatefulMarkerContainer;
}

export function encodeStatefulMarker(modelId: string, marker: Omit<StatefulMarkerContainer, 'extension'>): Uint8Array {
    return encodeStatefulMarkerPayload(modelId, { ...marker, extension: StatefulMarkerExtension });
}

export function decodeStatefulMarker(data: Uint8Array): StatefulMarkerWithModel | undefined {
    return decodeGCMPStatefulMarkerPayload(data);
}

interface StatefulMarkerDiagnostic extends StatefulMarkerPayloadDiagnostic {
    messageIndex: number;
    partIndex: number;
    role: 'assistant' | 'system' | 'user' | 'unknown';
    nativeDataPart: boolean;
}

export function getStatefulMarkerDiagnostics(
    messages: readonly vscode.LanguageModelChatMessage[],
    modelId: string
): {
    dataPartCount: number;
    otherDataPartCount: number;
    markerCount: number;
    assistantMarkerCount: number;
    validMarkerCount: number;
    scanTruncated: boolean;
    scanFailed: boolean;
    markers: StatefulMarkerDiagnostic[];
} {
    const result = {
        dataPartCount: 0,
        otherDataPartCount: 0,
        markerCount: 0,
        assistantMarkerCount: 0,
        validMarkerCount: 0,
        scanTruncated: false,
        scanFailed: false,
        markers: [] as StatefulMarkerDiagnostic[]
    };
    let scannedParts = 0;
    try {
        result.scanTruncated = messages.length > 4096;
        scan: for (
            let messageIndex = messages.length - 1;
            messageIndex >= Math.max(0, messages.length - 4096);
            messageIndex--
        ) {
            const message = messages[messageIndex];
            const role =
                message.role === vscode.LanguageModelChatMessageRole.Assistant ? 'assistant'
                : message.role === vscode.LanguageModelChatMessageRole.System ? 'system'
                : message.role === vscode.LanguageModelChatMessageRole.User ? 'user'
                : 'unknown';
            for (let partIndex = message.content.length - 1; partIndex >= 0; partIndex--) {
                if (scannedParts++ >= 16384) {
                    result.scanTruncated = true;
                    break scan;
                }
                const part = message.content[partIndex];
                if (typeof part !== 'object' || part === null || !('mimeType' in part)) {
                    continue;
                }
                result.dataPartCount++;
                if (!isStatefulMarkerMimeType(part.mimeType)) {
                    result.otherDataPartCount++;
                    continue;
                }
                const diagnostic = describeStatefulMarkerPayload('data' in part ? part.data : undefined, modelId);
                result.markerCount++;
                if (role === 'assistant') {
                    result.assistantMarkerCount++;
                }
                if (diagnostic.decodeStatus === 'valid') {
                    result.validMarkerCount++;
                }
                result.markers.push({
                    ...diagnostic,
                    messageIndex,
                    partIndex,
                    role,
                    nativeDataPart: part instanceof vscode.LanguageModelDataPart
                });
                if (result.markerCount === 16) {
                    result.scanTruncated ||= messageIndex > 0 || partIndex > 0;
                    break scan;
                }
            }
        }
    } catch {
        result.scanFailed = true;
    }
    return result;
}

/** Gets stateful markers from the messages, from the most to least recent */
export function* getAllStatefulMarkersAndIndicies(messages: readonly vscode.LanguageModelChatMessage[]) {
    for (let idx = messages.length - 1; idx >= 0; idx--) {
        const message = messages[idx];
        if (message.role === vscode.LanguageModelChatMessageRole.Assistant) {
            for (let partIdx = message.content.length - 1; partIdx >= 0; partIdx--) {
                const part = message.content[partIdx];
                if (part instanceof vscode.LanguageModelDataPart && isStatefulMarkerMimeType(part.mimeType)) {
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
