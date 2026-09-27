/*---------------------------------------------------------------------------------------------
 *  Gemini Converter
 *  将 VS Code LLM 接口结构转换为 Gemini HTTP（GenerateContent）请求结构
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import type { GeminiContent, GeminiPart, GeminiTool } from './geminiType';
import { CustomDataPartMimeTypes } from './types';
import { sanitizeToolSchema } from '../utils/text/schemaSanitizer';
import {
    decodeStatefulMarker,
    type GeminiToolCallMarker,
    type GeminiThoughtSignatureMarker,
    type StatefulMarkerContainer
} from './statefulMarker';
import { t } from '../utils/runtime/l10n';

interface GeminiMarkerIdentity {
    provider: string;
    modelId: string;
    requestIdentity: string;
}

interface GeminiToolCallReference {
    localCallId: string;
    upstreamCallId?: string;
    name: string;
}

function getThinkingSignature(part: vscode.LanguageModelThinkingPart): string {
    const meta = (part as unknown as { metadata?: { signature?: unknown } }).metadata;
    const sig = meta && typeof meta.signature === 'string' ? meta.signature : '';
    return sig || '';
}

/**
 * 将 VS Code 的 tools（LanguageModelChatTool）转换为 Gemini `tools.functionDeclarations`。
 *
 * 关键点：
 * - VS Code tool 的 `inputSchema` 是标准 JSON Schema，应通过 `parametersJsonSchema` 发送。
 * - 对缺少 schema 的工具，提供一个最小可用的 object schema。
 */
export function convertToolsToGemini(tools?: readonly vscode.LanguageModelChatTool[]): GeminiTool[] {
    // 用途：把 VS Code 提供的 tool schema（JSON Schema）转换成 Gemini functionDeclarations。
    if (!tools || tools.length === 0) {
        return [];
    }

    return [
        {
            functionDeclarations: tools.map(t => {
                if (!t.inputSchema || typeof t.inputSchema !== 'object') {
                    return {
                        name: t.name,
                        description: t.description,
                        parametersJsonSchema: {
                            type: 'object',
                            properties: {}
                        }
                    };
                }
                // FunctionDeclaration 的参数根节点必须是 object。
                const schema = t.inputSchema as Record<string, unknown>;
                const target =
                    schema.type === 'array' && schema.items && typeof schema.items === 'object' ?
                        (schema.items as Record<string, unknown>)
                    :   schema;
                return {
                    name: t.name,
                    description: t.description,
                    parametersJsonSchema: sanitizeToolSchema(target)
                };
            })
        }
    ];
}

export function convertMessagesToGemini(
    messages: readonly vscode.LanguageModelChatMessage[],
    options: { allowMedia?: boolean; provider?: string; modelId?: string; requestIdentity?: string } = {}
): {
    contents: GeminiContent[];
    systemInstruction: string;
} {
    // 用途：将 VS Code 的 chat message 列表转换为 Gemini 的 contents + systemInstruction。
    // 关键点：Gemini 的 tool response 需要作为单独的 user turn 且顺序与 functionCall 对齐。
    const contents: GeminiContent[] = [];
    let systemInstruction = '';
    const allowMedia = options.allowMedia === true;
    const markerIdentity =
        options.provider && options.modelId && options.requestIdentity ?
            { provider: options.provider, modelId: options.modelId, requestIdentity: options.requestIdentity }
        :   undefined;
    const inputMessages = markerIdentity ? sanitizeGeminiHistory(messages, markerIdentity) : messages;

    const toolCallByLocalId = new Map<string, GeminiToolCallReference>();
    const pushContent = (role: GeminiContent['role'], parts: GeminiPart[]): void => {
        if (parts.length === 0) {
            return;
        }
        const previous = contents[contents.length - 1];
        if (previous?.role === role) {
            previous.parts.push(...parts);
            return;
        }
        contents.push({ role, parts });
    };

    const collectText = (m: vscode.LanguageModelChatMessage): string => {
        // 用途：将一个 message 中的文本/（可选）thinking 汇总成纯文本。
        const parts: string[] = [];
        for (const p of m.content ?? []) {
            if (p instanceof vscode.LanguageModelTextPart) {
                parts.push(p.value);
            } else if (p instanceof vscode.LanguageModelThinkingPart) {
                const v = Array.isArray(p.value) ? p.value.join('') : p.value;
                if (v) {
                    parts.push(v);
                }
            }
        }
        return parts.join('');
    };

    const extract = (m: vscode.LanguageModelChatMessage) => {
        // 用途：拆分 message 内容为 text / 媒体数据 / toolCalls / toolResults 方便后续组装。
        const textParts: string[] = [];
        const imageParts: vscode.LanguageModelDataPart[] = [];
        const thinkingParts: Array<{ text: string; signature?: string }> = [];
        const toolCalls: Array<{ callId: string; name: string; args: Record<string, unknown> }> = [];
        const toolResults: Array<{ callId: string; outputText: string; dataParts: vscode.LanguageModelDataPart[] }> =
            [];

        for (const part of m.content ?? []) {
            if (part instanceof vscode.LanguageModelTextPart) {
                textParts.push(part.value);
            } else if (part instanceof vscode.LanguageModelDataPart && isInlineDataPart(part.mimeType, allowMedia)) {
                imageParts.push(part);
            } else if (part instanceof vscode.LanguageModelThinkingPart) {
                const v = Array.isArray(part.value) ? part.value.join('') : part.value;
                const signature = getThinkingSignature(part) || undefined;
                thinkingParts.push({ text: v || '', signature });
            } else if (part instanceof vscode.LanguageModelToolCallPart) {
                // 关键说明：Gemini functionResponse 需要 name，因此后续需要 callId -> name 的映射。
                const callId = part.callId || '';
                const args =
                    part.input && typeof part.input === 'object' ? (part.input as Record<string, unknown>) : {};
                toolCalls.push({ callId, name: part.name, args });
            } else if (part instanceof vscode.LanguageModelToolResultPart) {
                const callId = part.callId ?? '';
                const outputText = collectToolResultText(part);
                const dataParts = (part.content ?? []).filter(
                    (p): p is vscode.LanguageModelDataPart =>
                        p instanceof vscode.LanguageModelDataPart && isInlineDataPart(p.mimeType, allowMedia)
                );
                toolResults.push({ callId, outputText, dataParts });
            }
        }

        return {
            text: textParts.join(''),
            imageParts,
            thinkingParts,
            toolCalls,
            toolResults
        };
    };

    const isToolResultOnly = (extracted: ReturnType<typeof extract>): boolean => {
        // 用途：识别“只包含 tool result”的 message，便于合并为一个 user turn。
        return Boolean(
            extracted.toolResults.length > 0 &&
            !extracted.text &&
            extracted.imageParts.length === 0 &&
            extracted.toolCalls.length === 0
        );
    };

    const toolResultToFunctionResponsePart = (
        callId: string,
        outputText: string,
        dataParts: readonly vscode.LanguageModelDataPart[]
    ): GeminiPart | null => {
        // 用途：将 VS Code tool result 转换为 Gemini functionResponse part。
        // 关键说明：优先把 output 解析为 JSON 对象；失败时以 `{ output: string }` 兜底；
        // 媒体数据通过官方 FunctionResponse.parts 通道回传。
        if (!callId) {
            return null;
        }
        const call = toolCallByLocalId.get(callId);
        if (!call) {
            return null;
        }
        const parsed = tryParseJSONResponse(outputText);
        const responseValue: Record<string, unknown> = parsed.ok ? parsed.value : { result: outputText };
        const parts =
            dataParts.length > 0 ?
                dataParts.map(p => ({
                    inlineData: { mimeType: p.mimeType, data: Buffer.from(p.data).toString('base64') }
                }))
            :   undefined;
        return {
            functionResponse: {
                ...(call.upstreamCallId ? { id: call.upstreamCallId } : {}),
                name: call.name,
                response: responseValue,
                ...(parts ? { parts } : {})
            }
        };
    };

    const appendFollowingToolResults = (
        startIndex: number,
        callOrder: readonly GeminiToolCallReference[],
        embeddedResults: ReturnType<typeof extract>['toolResults']
    ): number => {
        const responsesByLocalId = new Map<string, GeminiPart>();
        const toolResults = [...embeddedResults];
        let nextIndex = startIndex + 1;
        while (callOrder.length > 0 && nextIndex < inputMessages.length) {
            const next = extract(inputMessages[nextIndex]);
            if (!isToolResultOnly(next)) {
                break;
            }
            toolResults.push(...next.toolResults);
            nextIndex++;
        }
        for (const result of toolResults) {
            const responsePart = toolResultToFunctionResponsePart(result.callId, result.outputText, result.dataParts);
            if (!responsePart) {
                continue;
            }
            if (responsesByLocalId.has(result.callId)) {
                throw new Error(
                    t(
                        'Gemini function responses must not contain duplicate call IDs',
                        'Gemini 工具结果不能包含重复的调用 ID'
                    )
                );
            }
            responsesByLocalId.set(result.callId, responsePart);
        }

        if (responsesByLocalId.size === 0) {
            return startIndex;
        }

        const orderedResponses =
            callOrder.length > 0 ?
                callOrder.flatMap(call => {
                    const response = responsesByLocalId.get(call.localCallId);
                    return response ? [response] : [];
                })
            :   [...responsesByLocalId.values()];
        if (orderedResponses.length > 0) {
            pushContent('user', orderedResponses);
        }
        return nextIndex - 1;
    };

    for (let i = 0; i < inputMessages.length; i++) {
        const m = inputMessages[i];
        const role = mapRole(m.role);
        const extracted = extract(m);

        // 用途：汇总系统消息为 systemInstruction（多段 system message 拼接）。
        if (role === 'system') {
            const sysText = collectText(m);
            if (sysText.trim()) {
                systemInstruction = systemInstruction ? `${systemInstruction}\n${sysText}` : sysText;
            }
            continue;
        }

        // 用途：合并连续的 tool results 为单个 user turn（Gemini 要求）。
        if (isToolResultOnly(extracted)) {
            // 关键说明：Gemini tool 响应必须作为 user role，一次性提交多条 functionResponse。
            const respParts: GeminiPart[] = [];
            let j = i;
            while (j < inputMessages.length) {
                const ex2 = extract(inputMessages[j]);
                if (!isToolResultOnly(ex2)) {
                    break;
                }
                for (const tr of ex2.toolResults) {
                    const part = toolResultToFunctionResponsePart(tr.callId, tr.outputText, tr.dataParts);
                    if (part) {
                        respParts.push(part);
                    }
                }
                j++;
            }
            if (respParts.length > 0) {
                pushContent('user', respParts);
            }
            i = j - 1;
            continue;
        }

        // 用途：普通 user 消息（文本 + 图片）转换为 Gemini user contents。
        if (role === 'user') {
            const parts: GeminiPart[] = [];
            for (const part of m.content ?? []) {
                if (part instanceof vscode.LanguageModelTextPart) {
                    if (part.value !== '') {
                        parts.push({ text: part.value });
                    }
                } else if (
                    part instanceof vscode.LanguageModelDataPart &&
                    isInlineDataPart(part.mimeType, allowMedia)
                ) {
                    parts.push({
                        inlineData: { mimeType: part.mimeType, data: Buffer.from(part.data).toString('base64') }
                    });
                } else if (part instanceof vscode.LanguageModelToolResultPart) {
                    const responsePart = toolResultToFunctionResponsePart(
                        part.callId ?? '',
                        collectToolResultText(part),
                        (part.content ?? []).filter(
                            (item): item is vscode.LanguageModelDataPart =>
                                item instanceof vscode.LanguageModelDataPart &&
                                isInlineDataPart(item.mimeType, allowMedia)
                        )
                    );
                    if (responsePart) {
                        parts.push(responsePart);
                    }
                }
            }
            if (parts.length > 0) {
                pushContent('user', parts);
            }
            continue;
        }

        const parts: GeminiPart[] = [];
        let pendingThinkingSignature: string | undefined;
        const marker = getGeminiMarker(m.content ?? [], markerIdentity);
        if (marker?.geminiContents && marker.geminiContents.length > 0) {
            const callOrder: GeminiToolCallReference[] = [];
            let rawCallIndex = 0;
            for (const content of marker.geminiContents) {
                for (const part of content.parts) {
                    const call = part.functionCall;
                    if (call?.name) {
                        const savedCall = marker.geminiToolCalls?.[rawCallIndex++];
                        const reference =
                            savedCall && savedCall.name === call.name && savedCall.upstreamCallId === call.id ?
                                savedCall
                            : call.id ? { localCallId: call.id, upstreamCallId: call.id, name: call.name }
                            : undefined;
                        if (reference) {
                            toolCallByLocalId.set(reference.localCallId, reference);
                            callOrder.push(reference);
                        }
                    }
                }
                contents.push(content);
            }
            i = appendFollowingToolResults(i, callOrder, extracted.toolResults);
            continue;
        }
        const allowSignatureRestore = markerIdentity === undefined || marker !== undefined;
        const markerSignatures = marker?.geminiThoughtSignatures ?? [];
        const signaturesByCallId = new Map<string, string>();
        const signaturesByName = new Map<string, string>();
        const textSignaturesByIndex = new Map<number, GeminiThoughtSignatureMarker>();
        const thoughtSignaturesByIndex = new Map<number, GeminiThoughtSignatureMarker>();
        const ambiguousNames = new Set<string>();
        const consumedMarkerSignatures = new Set<GeminiThoughtSignatureMarker>();
        const savedCallsByLocalId = new Map(
            (marker?.geminiToolCalls ?? []).map(call => [call.localCallId, call] as const)
        );
        for (const item of markerSignatures) {
            if (item.callId) {
                signaturesByCallId.set(item.callId, item.signature);
            }
            if (item.partKind === 'text' && item.partIndex !== undefined) {
                textSignaturesByIndex.set(item.partIndex, item);
            } else if (item.partKind === 'thought' && item.partIndex !== undefined) {
                thoughtSignaturesByIndex.set(item.partIndex, item);
            }
            if (!item.callId || !item.name || ambiguousNames.has(item.name)) {
                continue;
            }
            if (signaturesByName.has(item.name)) {
                signaturesByName.delete(item.name);
                ambiguousNames.add(item.name);
            } else {
                signaturesByName.set(item.name, item.signature);
            }
        }
        const callOrder: GeminiToolCallReference[] = [];
        const emittedSignatures = new Set<string>();
        let textPartIndex = 0;
        let thoughtPartIndex = 0;
        for (const part of m.content ?? []) {
            if (part instanceof vscode.LanguageModelTextPart) {
                if (part.value !== '') {
                    const markerSignature = textSignaturesByIndex.get(textPartIndex);
                    if (markerSignature) {
                        consumedMarkerSignatures.add(markerSignature);
                    }
                    const signature = pendingThinkingSignature || markerSignature?.signature;
                    parts.push({ text: part.value, ...(signature ? { thoughtSignature: signature } : {}) });
                    if (signature) {
                        emittedSignatures.add(signature);
                    }
                    pendingThinkingSignature = undefined;
                    textPartIndex++;
                }
            } else if (part instanceof vscode.LanguageModelThinkingPart) {
                const text = Array.isArray(part.value) ? part.value.join('') : part.value;
                const visibleSignature = allowSignatureRestore ? getThinkingSignature(part) || undefined : undefined;
                if (text !== '') {
                    const markerSignature = thoughtSignaturesByIndex.get(thoughtPartIndex);
                    if (markerSignature) {
                        consumedMarkerSignatures.add(markerSignature);
                    }
                    const signature = visibleSignature || pendingThinkingSignature || markerSignature?.signature;
                    parts.push({ thought: true, text, ...(signature ? { thoughtSignature: signature } : {}) });
                    if (signature) {
                        emittedSignatures.add(signature);
                    }
                    pendingThinkingSignature = undefined;
                    thoughtPartIndex++;
                } else if (visibleSignature) {
                    pendingThinkingSignature = visibleSignature;
                }
            } else if (part instanceof vscode.LanguageModelToolCallPart) {
                const localCallId = part.callId || `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
                const savedCall = savedCallsByLocalId.get(localCallId);
                const upstreamCallId = savedCall ? savedCall.upstreamCallId : localCallId;
                const args =
                    part.input && typeof part.input === 'object' ? (part.input as Record<string, unknown>) : {};
                const signature =
                    pendingThinkingSignature || signaturesByCallId.get(localCallId) || signaturesByName.get(part.name);
                const reference = { localCallId, upstreamCallId, name: part.name };
                toolCallByLocalId.set(localCallId, reference);
                callOrder.push(reference);
                parts.push({
                    functionCall: { ...(upstreamCallId ? { id: upstreamCallId } : {}), name: part.name, args },
                    ...(signature ? { thoughtSignature: signature } : {})
                });
                if (signature) {
                    emittedSignatures.add(signature);
                }
                pendingThinkingSignature = undefined;
            }
        }

        if (pendingThinkingSignature) {
            parts.push({ thoughtSignature: pendingThinkingSignature });
            emittedSignatures.add(pendingThinkingSignature);
        }
        for (const markerSignature of markerSignatures) {
            if (
                markerSignature.partKind &&
                !consumedMarkerSignatures.has(markerSignature) &&
                !emittedSignatures.has(markerSignature.signature)
            ) {
                parts.push({ thoughtSignature: markerSignature.signature });
                emittedSignatures.add(markerSignature.signature);
            }
        }

        if (parts.length > 0) {
            pushContent('model', parts);
        }

        i = appendFollowingToolResults(i, callOrder, extracted.toolResults);
    }

    validateGeminiFunctionResponses(contents);
    return { contents, systemInstruction };
}

function validateGeminiFunctionResponses(contents: readonly GeminiContent[]): void {
    for (let index = 0; index < contents.length; index++) {
        const content = contents[index];
        if (content.role !== 'model') {
            continue;
        }
        const calls = content.parts.flatMap(part => (part.functionCall ? [part.functionCall] : []));
        if (calls.length === 0) {
            continue;
        }

        const next = contents[index + 1];
        const responses =
            next?.role === 'user' ?
                next.parts.flatMap(part => (part.functionResponse ? [part.functionResponse] : []))
            :   [];
        if (responses.length !== calls.length) {
            throw new Error(
                t(
                    'Gemini function responses must exactly match the preceding function calls',
                    'Gemini 工具结果必须与前一轮工具调用完整匹配'
                )
            );
        }

        const callsById = new Map<string, (typeof calls)[number]>();
        const callsWithoutId: (typeof calls)[number][] = [];
        for (const call of calls) {
            if (!call.id) {
                callsWithoutId.push(call);
                continue;
            }
            if (callsById.has(call.id)) {
                throw new Error(t('Gemini function call IDs must be unique', 'Gemini 工具调用 ID 必须唯一'));
            }
            callsById.set(call.id, call);
        }

        const responseIds = new Set<string>();
        const responsesWithoutId: (typeof responses)[number][] = [];
        for (const response of responses) {
            if (!response.id) {
                responsesWithoutId.push(response);
                continue;
            }
            const call = callsById.get(response.id);
            if (!call || responseIds.has(response.id) || call.name !== response.name) {
                throw new Error(
                    t(
                        'Gemini function response IDs and names must match the preceding function calls',
                        'Gemini 工具结果的 ID 和名称必须与前一轮工具调用匹配'
                    )
                );
            }
            responseIds.add(response.id);
        }
        if (responsesWithoutId.length !== callsWithoutId.length) {
            throw new Error(
                t(
                    'Gemini function responses without IDs must match the preceding function calls by position',
                    '无 ID 的 Gemini 工具结果必须按顺序与前一轮工具调用匹配'
                )
            );
        }
        for (let i = 0; i < callsWithoutId.length; i++) {
            if (callsWithoutId[i].name !== responsesWithoutId[i].name) {
                throw new Error(
                    t(
                        'Gemini function response names must match the preceding function calls',
                        'Gemini 工具结果名称必须与前一轮工具调用匹配'
                    )
                );
            }
        }
    }
}

/**
 * 将 VS Code 的 role enum 转为语义角色。
 * 注意：Gemini contents 的 role 实际使用的是 'user' | 'model'；此处保留 'assistant' 供上层映射。
 */
function mapRole(role: number): 'user' | 'assistant' | 'system' {
    switch (role) {
        case vscode.LanguageModelChatMessageRole.User:
            return 'user';
        case vscode.LanguageModelChatMessageRole.Assistant:
            return 'assistant';
        case vscode.LanguageModelChatMessageRole.System:
            return 'system';
        default:
            return 'user';
    }
}

const internalDataPartMimeTypes: readonly string[] = Object.values(CustomDataPartMimeTypes);

/** 可作为 inlineData 回传的 DataPart：能力关闭或属于 GCMP 内部标记时排除。 */
function isInlineDataPart(mimeType: string | undefined, allowMedia: boolean): boolean {
    if (!allowMedia || !mimeType) {
        return false;
    }
    return !internalDataPartMimeTypes.includes(mimeType);
}

function getGeminiMarker(
    content: readonly vscode.LanguageModelChatMessage['content'][number][],
    identity: GeminiMarkerIdentity | undefined
): StatefulMarkerContainer | undefined {
    for (const part of content) {
        if (
            !(part instanceof vscode.LanguageModelDataPart) ||
            part.mimeType !== CustomDataPartMimeTypes.StatefulMarker
        ) {
            continue;
        }
        const marker = decodeStatefulMarker(part.data)?.marker;
        if (marker?.sdkMode !== 'gemini') {
            continue;
        }
        if (
            identity &&
            (marker.provider !== identity.provider ||
                marker.modelId !== identity.modelId ||
                marker.geminiRequestIdentity !== identity.requestIdentity)
        ) {
            continue;
        }
        return {
            ...marker,
            geminiThoughtSignatures: normalizeGeminiThoughtSignatures(marker.geminiThoughtSignatures),
            geminiContents: normalizeGeminiContents(marker.geminiContents),
            geminiToolCalls: normalizeGeminiToolCalls(marker.geminiToolCalls)
        };
    }
    return undefined;
}

function sanitizeGeminiHistory(
    messages: readonly vscode.LanguageModelChatMessage[],
    identity: GeminiMarkerIdentity
): readonly vscode.LanguageModelChatMessage[] {
    const droppedCallIds = new Set<string>();
    const sanitized = messages.map(message => {
        if (message.role !== vscode.LanguageModelChatMessageRole.Assistant) {
            return message;
        }
        if (getGeminiMarker(message.content ?? [], identity)) {
            return message;
        }

        const toolCalls = (message.content ?? []).filter(
            (part): part is vscode.LanguageModelToolCallPart => part instanceof vscode.LanguageModelToolCallPart
        );
        if (toolCalls.length > 0) {
            for (const toolCall of toolCalls) {
                if (toolCall.callId) {
                    droppedCallIds.add(toolCall.callId);
                }
            }
            return undefined;
        }

        const portableContent = (message.content ?? []).filter(
            (part): part is vscode.LanguageModelTextPart =>
                part instanceof vscode.LanguageModelTextPart && part.value.length > 0
        );
        return portableContent.length > 0 ? { ...message, content: portableContent } : undefined;
    });

    return sanitized.flatMap(message => {
        if (!message) {
            return [];
        }
        if (message.role !== vscode.LanguageModelChatMessageRole.User || droppedCallIds.size === 0) {
            return [message];
        }
        const content = (message.content ?? []).filter(
            part => !(part instanceof vscode.LanguageModelToolResultPart) || !droppedCallIds.has(part.callId ?? '')
        );
        return content.length > 0 ? [{ ...message, content }] : [];
    });
}

function normalizeGeminiContents(value: unknown): GeminiContent[] | undefined {
    if (!Array.isArray(value)) {
        return undefined;
    }
    const contents: GeminiContent[] = [];
    for (const item of value) {
        if (!item || typeof item !== 'object') {
            continue;
        }
        const candidate = item as Partial<GeminiContent>;
        if ((candidate.role !== 'model' && candidate.role !== 'user') || !Array.isArray(candidate.parts)) {
            continue;
        }
        const parts = candidate.parts.filter(
            (part): part is GeminiPart => Boolean(part) && typeof part === 'object' && !Array.isArray(part)
        );
        if (parts.length > 0) {
            contents.push({ role: candidate.role, parts });
        }
    }
    return contents.length > 0 ? contents : undefined;
}

function normalizeGeminiThoughtSignatures(value: unknown): GeminiThoughtSignatureMarker[] | undefined {
    if (!Array.isArray(value)) {
        return undefined;
    }
    const signatures: GeminiThoughtSignatureMarker[] = [];
    for (const item of value) {
        if (!item || typeof item !== 'object') {
            continue;
        }
        const candidate = item as GeminiThoughtSignatureMarker;
        if (typeof candidate.signature !== 'string' || !candidate.signature) {
            continue;
        }
        const partKind =
            candidate.partKind === 'text' || candidate.partKind === 'thought' || candidate.partKind === 'standalone' ?
                candidate.partKind
            :   undefined;
        const partIndex =
            (
                typeof candidate.partIndex === 'number' &&
                Number.isInteger(candidate.partIndex) &&
                candidate.partIndex >= 0
            ) ?
                candidate.partIndex
            :   undefined;
        signatures.push({
            ...(typeof candidate.callId === 'string' && candidate.callId ? { callId: candidate.callId } : {}),
            ...(typeof candidate.name === 'string' && candidate.name ? { name: candidate.name } : {}),
            ...(partKind ? { partKind } : {}),
            ...(partIndex !== undefined ? { partIndex } : {}),
            signature: candidate.signature
        });
    }
    return signatures.length > 0 ? signatures : undefined;
}

function normalizeGeminiToolCalls(value: unknown): GeminiToolCallMarker[] | undefined {
    if (!Array.isArray(value)) {
        return undefined;
    }
    const calls: GeminiToolCallMarker[] = [];
    for (const item of value) {
        if (!item || typeof item !== 'object') {
            continue;
        }
        const candidate = item as GeminiToolCallMarker;
        if (
            typeof candidate.localCallId !== 'string' ||
            !candidate.localCallId ||
            typeof candidate.name !== 'string' ||
            !candidate.name
        ) {
            continue;
        }
        calls.push({
            localCallId: candidate.localCallId,
            ...(typeof candidate.upstreamCallId === 'string' && candidate.upstreamCallId ?
                { upstreamCallId: candidate.upstreamCallId }
            :   {}),
            name: candidate.name
        });
    }
    return calls.length > 0 ? calls : undefined;
}

/**
 * 将 tool result 的 content 汇总为字符串。
 *
 * 仅保留文本语义内容；DataPart 媒体数据经 functionResponse.parts 通道回传，
 * 其他扩展内部元数据（cache_control / stateful_marker / thinking 等）一律跳过。
 */
function collectToolResultText(part: vscode.LanguageModelToolResultPart): string {
    if (!part.content || part.content.length === 0) {
        return '';
    }
    const texts: string[] = [];
    for (const item of part.content) {
        if (item instanceof vscode.LanguageModelTextPart) {
            texts.push(item.value);
        }
        // DataPart 与其他非文本 part 统一跳过，由调用方另行处理媒体数据
    }
    return texts.join('');
}

/** 将 JSON 数组或标量包装为 Gemini FunctionResponse 所需的对象。 */
function tryParseJSONResponse(text: string): { ok: true; value: Record<string, unknown> } | { ok: false } {
    const v = (text || '').trim();
    if (!v) {
        return { ok: false };
    }
    try {
        const parsed = JSON.parse(v);
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
            return { ok: true, value: parsed as Record<string, unknown> };
        }
        return { ok: true, value: { result: parsed } };
    } catch {
        return { ok: false };
    }
}
