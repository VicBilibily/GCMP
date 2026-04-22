import * as vscode from 'vscode';

export interface VisionBridgeDefinition {
    toolName: string;
    label: string;
}

export const visionBridgeDefinitions = {
    minimax: {
        toolName: 'minimax_vision',
        label: 'MiniMax 图片桥接'
    }
    // zhipu 智谱AI的模型不认模拟调用的工具，目前仅限MiniMax桥接
} as const satisfies Record<string, VisionBridgeDefinition>;

export interface VisionBridgeBuildResult {
    messages: Array<vscode.LanguageModelChatMessage>;
    resultParts: vscode.LanguageModelTextPart[];
}

export function createVisionBridgeToolCallId(toolName: string): string {
    return `${toolName}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

export function buildVisionBridgeToolResultParts(imageDescriptions: string[]): vscode.LanguageModelTextPart[] {
    const parts: vscode.LanguageModelTextPart[] = [
        new vscode.LanguageModelTextPart(`共识别 ${imageDescriptions.length} 张图片。`),
        new vscode.LanguageModelTextPart('图片分析结果：')
    ];

    imageDescriptions.forEach((description, index) => {
        parts.push(new vscode.LanguageModelTextPart(`${index + 1}. ${description}`));
    });

    return parts;
}

export function buildVisionBridgeMessages(options: {
    messages: Array<vscode.LanguageModelChatMessage>;
    lastUserMessageIndex: number;
    callId: string;
    toolName: string;
    questionText: string;
    imageDescriptions: string[];
}): VisionBridgeBuildResult {
    const resultParts = buildVisionBridgeToolResultParts(options.imageDescriptions);
    const bridgedUserQuestionMessage = vscode.LanguageModelChatMessage.User([
        new vscode.LanguageModelTextPart(options.questionText)
    ]);
    const assistantToolCallMessage = vscode.LanguageModelChatMessage.Assistant([
        new vscode.LanguageModelToolCallPart(options.callId, options.toolName, {
            imageCount: options.imageDescriptions.length,
            question: options.questionText
        })
    ]);
    const toolResultMessage = vscode.LanguageModelChatMessage.User([
        new vscode.LanguageModelToolResultPart(options.callId, resultParts)
    ]);

    return {
        messages: [
            ...options.messages.slice(0, options.lastUserMessageIndex),
            bridgedUserQuestionMessage,
            assistantToolCallMessage,
            toolResultMessage,
            ...options.messages.slice(options.lastUserMessageIndex + 1)
        ],
        resultParts
    };
}
