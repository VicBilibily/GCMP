/*---------------------------------------------------------------------------------------------
 *  Gemini Converter
 *  将 VS Code LLM 接口结构转换为 Gemini HTTP（GenerateContent）请求结构
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import type { GeminiContent, GeminiPart, GeminiTool } from './geminiType';
import { sanitizeToolSchemaForTarget } from '../utils';

function getThinkingSignature(part: vscode.LanguageModelThinkingPart): string {
    const meta = (part as unknown as { metadata?: { signature?: unknown } }).metadata;
    const sig = meta && typeof meta.signature === 'string' ? meta.signature : '';
    return sig || '';
}

/**
 * 将 VS Code 的 tools（LanguageModelChatTool）转换为 Gemini `tools.functionDeclarations`。
 *
 * 关键点：
 * - VS Code tool 的 `inputSchema` 是 JSON Schema，需要转换为 Gemini Schema（type 大写枚举）。
 * - 对缺少 schema 的工具，提供一个最小可用的 OBJECT schema，避免网关拒绝请求。
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
                        parameters: {
                            type: 'OBJECT',
                            properties: {},
                            required: []
                        }
                    };
                }
                return {
                    name: t.name,
                    description: t.description,
                    parameters: sanitizeToolSchemaForTarget(t.inputSchema as Record<string, unknown>, 'gemini')
                };
            })
        }
    ];
}

export function convertMessagesToGemini(messages: readonly vscode.LanguageModelChatMessage[]): {
    contents: GeminiContent[];
    systemInstruction: string;
} {
    // 用途：将 VS Code 的 chat message 列表转换为 Gemini 的 contents + systemInstruction。
    // 关键点：Gemini 的 tool response 需要作为单独的 user turn 且顺序与 functionCall 对齐。
    const contents: GeminiContent[] = [];
    let systemInstruction = '';

    const toolNameByCallId = new Map<string, string>();

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
        // 用途：拆分 message 内容为 text / images / toolCalls / toolResults 方便后续组装。
        const textParts: string[] = [];
        const imageParts: vscode.LanguageModelDataPart[] = [];
        const thinkingParts: Array<{ text: string; signature?: string }> = [];
        const toolCalls: Array<{ callId: string; name: string; args: Record<string, unknown> }> = [];
        const toolResults: Array<{ callId: string; outputText: string }> = [];

        for (const part of m.content ?? []) {
            if (part instanceof vscode.LanguageModelTextPart) {
                textParts.push(part.value);
            } else if (part instanceof vscode.LanguageModelDataPart && isImageMimeType(part.mimeType)) {
                imageParts.push(part);
            } else if (part instanceof vscode.LanguageModelThinkingPart) {
                const v = Array.isArray(part.value) ? part.value.join('') : part.value;
                const signature = getThinkingSignature(part) || undefined;
                thinkingParts.push({ text: v || '', signature });
            } else if (part instanceof vscode.LanguageModelToolCallPart) {
                // 关键说明：Gemini functionResponse 需要 name，因此后续需要 callId -> name 的映射。
                const callId = part.callId || `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
                const args =
                    part.input && typeof part.input === 'object' ? (part.input as Record<string, unknown>) : {};
                toolCalls.push({ callId, name: part.name, args });
            } else if (part instanceof vscode.LanguageModelToolResultPart) {
                const callId = part.callId ?? '';
                const outputText = collectToolResultText(part);
                toolResults.push({ callId, outputText });
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

    const toolResultToFunctionResponsePart = (callId: string, outputText: string): GeminiPart | null => {
        // 用途：将 VS Code tool result 转换为 Gemini functionResponse part。
        // 关键说明：优先把 output 解析为 JSON 对象；失败时以 `{ output: string }` 兜底。
        if (!callId) {
            return null;
        }
        const name = toolNameByCallId.get(callId);
        if (!name) {
            return null;
        }
        const parsed = tryParseJSONObject(outputText);
        const responseValue: Record<string, unknown> = parsed.ok ? parsed.value : { output: outputText };
        return { functionResponse: { name, response: responseValue } };
    };

    for (let i = 0; i < messages.length; i++) {
        const m = messages[i];
        const role = mapRole(m.role);
        const extracted = extract(m);

        // 用途：汇总系统消息为 systemInstruction（多段 system message 拼接）。
        if (role === 'system') {
            const sysText = collectText(m).trim();
            if (sysText) {
                systemInstruction = systemInstruction ? `${systemInstruction}\n${sysText}` : sysText;
            }
            continue;
        }

        // 用途：合并连续的 tool results 为单个 user turn（Gemini 要求）。
        if (isToolResultOnly(extracted)) {
            // 关键说明：Gemini tool 响应必须作为 user role，一次性提交多条 functionResponse。
            const respParts: GeminiPart[] = [];
            let j = i;
            while (j < messages.length) {
                const ex2 = extract(messages[j]);
                if (!isToolResultOnly(ex2)) {
                    break;
                }
                for (const tr of ex2.toolResults) {
                    const part = toolResultToFunctionResponsePart(tr.callId, tr.outputText);
                    if (part) {
                        respParts.push(part);
                    }
                }
                j++;
            }
            if (respParts.length > 0) {
                contents.push({ role: 'user', parts: respParts });
            }
            i = j - 1;
            continue;
        }

        // 用途：普通 user 消息（文本 + 图片）转换为 Gemini user contents。
        if (role === 'user') {
            // 关键说明：这里把文本与图片合并到一个 user turn，保证语义一致。
            const parts: GeminiPart[] = [];
            const t = extracted.text.trim();
            if (t) {
                parts.push({ text: t });
            }
            for (const img of extracted.imageParts) {
                const data = Buffer.from(img.data).toString('base64');
                parts.push({ inlineData: { mimeType: img.mimeType, data } });
            }
            if (parts.length > 0) {
                contents.push({ role: 'user', parts });
            }
            continue;
        }

        // 用途：assistant 消息转换为 Gemini model contents，并将 tool calls 转为 functionCall。
        const parts: GeminiPart[] = [];

        let lastThinkingSignature: string | undefined;
        for (const tp of extracted.thinkingParts) {
            // 保留 signature 供后续 functionCall 关联
            lastThinkingSignature = tp.signature;
            const t = (tp.text || '').trim();
            if (t) {
                parts.push({
                    thought: true,
                    text: t,
                    thoughtSignature: tp.signature,
                    thought_signature: tp.signature
                });
            }
        }

        const assistantText = extracted.text.trim();
        if (assistantText) {
            parts.push({ text: assistantText });
        }

        const callOrder: Array<{ callId: string; name: string }> = [];
        for (const tc of extracted.toolCalls) {
            toolNameByCallId.set(tc.callId, tc.name);
            callOrder.push({ callId: tc.callId, name: tc.name });

            // Gemini CLI/部分网关要求 functionCall 带 thought signature。
            // 优先使用同一条 assistant message 中最近的 thinking signature
            parts.push({
                functionCall: { name: tc.name, args: tc.args },
                thoughtSignature: lastThinkingSignature,
                thought_signature: lastThinkingSignature
            });
        }

        if (parts.length > 0) {
            contents.push({ role: 'model', parts });
        }

        // 用途：确保 tool response 作为单个 user turn，且与 preceding functionCall 顺序一致。
        if (callOrder.length > 0) {
            // 关键说明：按 callOrder 重排 tool response，避免网关因顺序不一致而拒绝。
            const responsesByCallId = new Map<string, GeminiPart>();
            let j = i + 1;
            while (j < messages.length) {
                const ex2 = extract(messages[j]);
                if (!isToolResultOnly(ex2)) {
                    break;
                }
                for (const tr of ex2.toolResults) {
                    const part = toolResultToFunctionResponsePart(tr.callId, tr.outputText);
                    if (part) {
                        responsesByCallId.set(tr.callId, part);
                    }
                }
                j++;
            }
            if (responsesByCallId.size > 0) {
                const respParts: GeminiPart[] = [];
                for (const c of callOrder) {
                    const rp = responsesByCallId.get(c.callId);
                    if (rp) {
                        respParts.push(rp);
                    }
                }
                if (respParts.length > 0) {
                    contents.push({ role: 'user', parts: respParts });
                    i = j - 1;
                }
            }
        }
    }

    return { contents, systemInstruction };
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

/** 仅处理图片 DataPart（mimeType 以 image/ 开头） */
function isImageMimeType(mimeType: string | undefined): boolean {
    if (!mimeType) {
        return false;
    }
    return mimeType.startsWith('image/');
}

/**
 * 将 tool result 的 content 汇总为字符串。
 * 关键点：content 可能包含 TextPart 及其他结构体，尽量 JSON.stringify 以保留信息。
 */
function collectToolResultText(part: vscode.LanguageModelToolResultPart): string {
    if (!part.content || part.content.length === 0) {
        return '';
    }
    const texts: string[] = [];
    for (const item of part.content) {
        if (item instanceof vscode.LanguageModelTextPart) {
            texts.push(item.value);
        } else if (item && typeof item === 'object') {
            try {
                texts.push(JSON.stringify(item));
            } catch {
                texts.push(String(item));
            }
        }
    }
    return texts.join('');
}

/**
 * 尝试把字符串解析成 JSON 对象（只接受 object，不接受数组）。
 * 用途：为 Gemini functionResponse 构造结构化 response。
 */
function tryParseJSONObject(text: string): { ok: true; value: Record<string, unknown> } | { ok: false } {
    const v = (text || '').trim();
    if (!v) {
        return { ok: false };
    }
    if (!v.startsWith('{') && !v.startsWith('[')) {
        return { ok: false };
    }
    try {
        const parsed = JSON.parse(v);
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
            return { ok: true, value: parsed as Record<string, unknown> };
        }
        return { ok: false };
    } catch {
        return { ok: false };
    }
}
