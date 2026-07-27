import { canonicalizeJsonString, sortObjectKeysRecursively } from './openaiChatRequestPreprocessor';

interface OpenAIResponsesInputLikeItem {
    type?: unknown;
    id?: unknown;
    arguments?: unknown;
}

interface OpenAIResponsesToolLike {
    type?: unknown;
    parameters?: unknown;
}

function shouldStripOptionalId(item: OpenAIResponsesInputLikeItem): boolean {
    return item.type === 'message' || item.type === 'function_call' || item.type === 'function_call_output';
}

/**
 * 对 Responses API 输入项做稳定化预处理：
 * - `message` / `function_call` / `function_call_output` 的 `id` 为可选字段，去掉可避免历史重放时的无意义漂移
 * - `function_call.arguments` 若为 JSON 字符串，则转成稳定键序，避免同语义对象因键序不同造成请求漂移
 * - `reasoning` 项保留服务端返回的原始 `id`（若存在），不在这里剥离
 * - `function` 工具的 `parameters` 递归按键排序，保持 schema 序列化稳定
 */
export function preprocessOpenAIResponsesInputItems(
    items: OpenAIResponsesInputLikeItem[],
    tools?: OpenAIResponsesToolLike[]
): void {
    for (const item of items) {
        if (shouldStripOptionalId(item) && 'id' in item) {
            delete item.id;
        }

        if (item.type === 'function_call' && typeof item.arguments === 'string') {
            item.arguments = canonicalizeJsonString(item.arguments);
        }
    }

    for (const tool of tools || []) {
        if (tool.type === 'function' && tool.parameters && typeof tool.parameters === 'object') {
            tool.parameters = sortObjectKeysRecursively(tool.parameters);
        }
    }
}
