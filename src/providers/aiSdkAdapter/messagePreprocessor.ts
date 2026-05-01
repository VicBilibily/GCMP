/*---------------------------------------------------------------------------------------------
 *  消息预处理器
 *  在发送到 AI SDK 之前对消息进行格式调整
 *--------------------------------------------------------------------------------------------*/

import type { CoreMessage } from 'ai';

function toRecord(value: unknown): Record<string, unknown> {
    return value !== null && typeof value === 'object' ? (value as Record<string, unknown>) : {};
}

/**
 * 将多轮对话中的 reasoning 内容附加到 openai-compatible 格式的 providerOptions 中
 *
 * openai-compatible SDK 在多轮对话时需要将 reasoning 内容作为
 * providerOptions.openaiCompatible.reasoning_content 传回，
 * 否则模型会丢失前几轮的思考上下文。
 */
export function attachOpenAICompatibleReasoningContent(messages: CoreMessage[]): {
    messages: CoreMessage[];
    attachedReasoningCount: number;
    attachedReasoningChars: number;
} {
    let attachedReasoningCount = 0;
    let attachedReasoningChars = 0;

    return {
        messages: messages.map(message => {
            if (message.role !== 'assistant' || typeof message.content === 'string') {
                return message;
            }

            const reasoningContent = message.content
                .flatMap(part => (part.type === 'reasoning' && part.text.length > 0 ? [part.text] : []))
                .join('');

            if (reasoningContent.length === 0) {
                return message;
            }

            attachedReasoningCount += 1;
            attachedReasoningChars += reasoningContent.length;

            const providerOptions = toRecord(message.providerOptions);
            const openAICompatibleOptions = toRecord(providerOptions.openaiCompatible);

            return {
                ...message,
                providerOptions: {
                    ...providerOptions,
                    openaiCompatible: {
                        ...openAICompatibleOptions,
                        reasoning_content: reasoningContent
                    }
                }
            };
        }),
        attachedReasoningCount,
        attachedReasoningChars
    };
}
