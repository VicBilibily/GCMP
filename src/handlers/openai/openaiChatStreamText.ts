import type { ExtendedDelta } from '../openaiHandler';

interface ChatStreamChoice {
    delta?: ExtendedDelta;
    message?: { content?: string };
}

interface TextReporter {
    reportText(content: string): void;
}

export function reportChatCompletionText(choice: ChatStreamChoice, reporter: TextReporter): void {
    const deltaContent = choice.delta?.content;
    if (deltaContent && typeof deltaContent === 'string') {
        reporter.reportText(deltaContent);
    } else if (typeof choice.message?.content === 'string' && choice.message.content.length > 0) {
        reporter.reportText(choice.message.content);
    }
}