import { canonicalizeJsonString, sortObjectKeysRecursively } from './shared/json';

export { canonicalizeJsonString, sortObjectKeysRecursively } from './shared/json';

interface OpenAIChatToolCallLike {
    function?: {
        arguments?: unknown;
    };
}

interface OpenAIChatMessageLike {
    tool_calls?: OpenAIChatToolCallLike[];
}

interface OpenAIChatToolLike {
    function?: {
        parameters?: unknown;
    };
}

/**
 * 对 OpenAI Chat Completions 请求做稳定化预处理：
 * - assistant.tool_calls[].function.arguments 若为 JSON 字符串，则转成稳定键序，避免同语义对象因键序不同造成请求漂移
 * - tools[].function.parameters 递归按键排序，保持 schema 序列化稳定
 */
export function preprocessOpenAIChatRequest(messages: OpenAIChatMessageLike[], tools?: OpenAIChatToolLike[]): void {
    for (const message of messages) {
        if (!Array.isArray(message.tool_calls)) {
            continue;
        }
        for (const toolCall of message.tool_calls) {
            if (typeof toolCall.function?.arguments === 'string') {
                toolCall.function.arguments = canonicalizeJsonString(toolCall.function.arguments);
            }
        }
    }

    for (const tool of tools || []) {
        if (tool.function?.parameters && typeof tool.function.parameters === 'object') {
            tool.function.parameters = sortObjectKeysRecursively(tool.function.parameters);
        }
    }
}
