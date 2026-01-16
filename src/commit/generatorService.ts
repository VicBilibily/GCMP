/*---------------------------------------------------------------------------------------------
 *  提交消息生成服务
 *  通过 VS Code Language Model API 调用模型生成提交消息
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import {
    CommitMessage,
    ProgressReporter,
    ModelNotFoundError,
    EmptyCommitMessageError,
    UserCancelledError
} from './types';
import { PromptService } from './promptService';
import type { GitDiffParts, GitDiffSection } from './gitService';
import { CompatibleModelManager, ConfigManager, Logger } from '../utils';

function throwIfCancelled(token: vscode.CancellationToken): void {
    if (token.isCancellationRequested) {
        throw new vscode.CancellationError();
    }
}

/**
 * 提交消息生成服务类
 * 通过 VS Code Language Model API 调用语言模型生成提交消息
 */
export class GeneratorService {
    private static readonly MAX_CONTEXT_CHARS_PER_MESSAGE = 14000;
    /**
     * 获取 Commit 可用提供商列表（providerKey + 展示名 + vendor）。
     * 逻辑参照 JsonSchemaProvider#getCommitModelSchema：
     * - 内置提供商（provider）+ providerOverrides 合并
     * - compatible 提供商（可包含用户自定义模型）
     */
    static async getAvailableCommitProviders(): Promise<
        Array<{ providerKey: string; displayName: string; vendor: string }>
    > {
        const providerConfigs = ConfigManager.getConfigProvider();
        const results: Array<{ providerKey: string; displayName: string; vendor: string }> = [];

        for (const [providerKey, originalConfig] of Object.entries(providerConfigs)) {
            results.push({
                providerKey,
                displayName: originalConfig.displayName || providerKey,
                vendor: `gcmp.${providerKey}`
            });
        }

        // compatible 提供商（providerKey = compatible）
        if (!results.some(p => p.providerKey === 'compatible')) {
            results.push({
                providerKey: 'compatible',
                displayName: 'OpenAI / Anthropic Compatible',
                vendor: 'gcmp.compatible'
            });
        }

        return results;
    }

    /**
     * 获取某个提供商下的可用模型列表（用于 UI 下拉）。
     * - 内置提供商（provider）：使用 applyProviderOverrides 后的 effectiveConfig.models
     * - compatible: 使用 CompatibleModelManager.getModels()
     */
    static async getAvailableCommitModelsForProvider(
        providerKey: string
    ): Promise<Array<{ id: string; name: string }>> {
        const key = (providerKey || '').trim();
        if (!key) {
            return [];
        }

        if (key === 'compatible') {
            return CompatibleModelManager.getModels()
                .map(m => ({ id: m.id, name: m.name || m.id }))
                .filter(m => Boolean(m.id));
        }

        const providerConfigs = ConfigManager.getConfigProvider();
        const originalConfig = providerConfigs[key];
        if (!originalConfig) {
            return [];
        }

        const effectiveConfig = ConfigManager.applyProviderOverrides(key, originalConfig);
        return (effectiveConfig.models ?? []).map(m => ({ id: m.id, name: m.name || m.id })).filter(m => Boolean(m.id));
    }

    /**
     * 生成提交消息（分段 diff）：
     * staged/tracked/untracked 每个文件一条 User message。
     */
    static async generateCommitMessages(
        diffParts: GitDiffParts,
        blameAnalysis: string,
        progress: ProgressReporter,
        token: vscode.CancellationToken
    ): Promise<CommitMessage> {
        // 1) 选择模型
        progress.report({ message: '正在选择模型...', increment: 8 });
        const model = await this.selectModel();
        throwIfCancelled(token);

        // 2) 组装 diff 上下文（每个文件一个 message）
        progress.report({ message: '正在提取关键变更片段...', increment: 10 });
        const messages: vscode.LanguageModelChatMessage[] = [];

        messages.push(...this.buildPerFileAttachmentMessages(diffParts.staged, 'staged'));
        messages.push(...this.buildPerFileAttachmentMessages(diffParts.tracked, 'tracked'));
        messages.push(...this.buildPerFileAttachmentMessages(diffParts.untracked, 'untracked'));

        const historyContext = (blameAnalysis ?? '').trim();
        if (historyContext) {
            messages.push(
                vscode.LanguageModelChatMessage.User(
                    `Attachment: recent commits for changed files (for context)\n\n${historyContext}`
                )
            );
        }

        const finalPrompt = PromptService.generateCommitPrompt();

        const diffNoticeParts: string[] = [];
        if (diffParts.staged.diff.length > 0) {
            diffNoticeParts.push('Staged diff excerpts have been provided in previous messages. Please use them.');
        }
        if (diffParts.tracked.diff.length > 0) {
            diffNoticeParts.push('Tracked diff excerpts have been provided in previous messages. Please use them.');
        }
        if (diffParts.untracked.diff.length > 0) {
            diffNoticeParts.push(
                'Untracked new file excerpts have been provided in previous messages. Please use them.'
            );
        }
        if (diffNoticeParts.length === 0) {
            diffNoticeParts.push('No diff excerpts were provided.');
        }

        messages.push(
            vscode.LanguageModelChatMessage.User(
                `${diffNoticeParts.join('\n')}` +
                    `${historyContext ? '\nHistory context has also been provided in a previous message. Please use it.' : ''}` +
                    `\n\n${finalPrompt}`
            )
        );

        // 3) 生成最终提交消息
        progress.report({ message: `正在使用 ${model.name} 生成提交消息...`, increment: 20 });
        const message = await this.callModelWithMessages(model, messages, progress, token);

        // 4) 后处理
        progress.report({ message: '正在处理结果...', increment: 10 });
        const cleanedMessage = PromptService.normalizeCommitMessage(message);

        // 5) 验证消息
        if (!cleanedMessage.trim()) {
            throw new EmptyCommitMessageError();
        }

        return {
            message: cleanedMessage,
            model: model.name
        };
    }

    private static buildPerFileAttachmentMessages(
        section: GitDiffSection,
        label: string
    ): vscode.LanguageModelChatMessage[] {
        const messages: vscode.LanguageModelChatMessage[] = [];

        const total = Math.max(section.diff.length, section.uri.length);
        for (let i = 0; i < total; i++) {
            const fileUri = section.uri[i];
            const diffText = section.diff[i] ?? '';

            if (!diffText.trim()) {
                continue;
            }

            const fileLine = fileUri ? `File: ${fileUri.fsPath}` : 'File: (unknown)';

            // Guardrail: ensure a single message doesn't exceed our context chunk budget.
            const overhead = 600;
            const maxExcerpt = Math.max(0, this.MAX_CONTEXT_CHARS_PER_MESSAGE - overhead);
            let excerpt = diffText;
            if (excerpt.length > maxExcerpt) {
                excerpt = excerpt.slice(0, maxExcerpt) + '\n... [message truncated]';
            }

            const text = [
                `Attachment ${i + 1}/${total}: diff excerpt (${label})`,
                fileLine,
                '```diff',
                excerpt,
                '```'
            ].join('\n');

            messages.push(vscode.LanguageModelChatMessage.User(text));
        }

        return messages;
    }

    /**
     * 选择语言模型
     */
    private static async selectModel(): Promise<vscode.LanguageModelChat> {
        const resolveConfiguredModel = async (
            selection: { provider?: string; model?: string } | undefined
        ): Promise<vscode.LanguageModelChat | null> => {
            const provider = (selection?.provider ?? '').trim();
            const modelId = (selection?.model ?? '').trim();
            if (!provider || !modelId) {
                return null;
            }

            try {
                const candidates = await vscode.lm.selectChatModels({
                    id: modelId,
                    vendor: `gcmp.${provider}`
                });
                return candidates?.[0] ?? null;
            } catch {
                // 查询失败视为模型不可用
                return null;
            }
        };

        // 1) 优先使用已配置且可用的模型
        const configuredSelection = ConfigManager.getCommitConfig().model;
        const configuredModel = await resolveConfiguredModel(configuredSelection);
        if (configuredModel) {
            Logger.trace(`[GeneratorService] 使用配置的模型: ${configuredModel.name}`);
            return configuredModel;
        }

        // 2) 未配置模型或配置无效：弹出模型选择向导，并在成功选择后重试
        const before = JSON.stringify(configuredSelection ?? {});
        await vscode.commands.executeCommand('gcmp.commit.selectModel');

        const afterSelection = ConfigManager.getCommitConfig().model;
        const after = JSON.stringify(afterSelection ?? {});
        if (after === before) {
            // 用户未更新配置（通常表示取消/关闭了向导）
            throw new UserCancelledError();
        }

        const selectedModel = await resolveConfiguredModel(afterSelection);
        if (selectedModel) {
            Logger.trace(`[GeneratorService] 使用用户选择的模型: ${selectedModel.name}`);
            return selectedModel;
        }

        const providerKey =
            (afterSelection?.provider ?? configuredSelection?.provider ?? '(未指定)').trim() || '(未指定)';
        const modelId = (afterSelection?.model ?? configuredSelection?.model ?? '(未指定)').trim() || '(未指定)';
        throw new ModelNotFoundError(
            `配置的模型 "${providerKey}:${modelId}" 不可用或未启用。` +
                '请运行“GCMP: 选择 Commit 模型”重新选择，或检查对应提供商模型是否已启用。'
        );
    }

    /**
     * 调用语言模型
     */
    private static async callModelWithMessages(
        model: vscode.LanguageModelChat,
        messages: vscode.LanguageModelChatMessage[],
        progress: ProgressReporter,
        token: vscode.CancellationToken
    ): Promise<string> {
        try {
            // 发送请求
            const response = await model.sendRequest(messages, {}, token);

            // 收集响应
            let result = '';
            for await (const chunk of response.text) {
                if (token.isCancellationRequested) {
                    throw new vscode.CancellationError();
                }
                result += chunk;
                // 更新进度
                if (result.length % 100 === 0) {
                    progress.report({ message: `正在生成... (${result.length} 字符)`, increment: 1 });
                }
            }

            Logger.trace(`[GeneratorService] 模型响应长度: ${result.length} 字符`);
            return result;
        } catch (error) {
            Logger.error('[GeneratorService] 模型调用失败:', error);

            // 检查是否是用户取消
            if (error instanceof vscode.CancellationError) {
                throw error;
            }

            // 检查是否是权限问题
            if (error instanceof Error && error.message.includes('access')) {
                throw new Error('无法访问语言模型。请确保您有权限使用该模型，或者尝试选择其他模型。');
            }

            throw new Error(`生成提交消息失败: ${error instanceof Error ? error.message : String(error)}`);
        }
    }
}
