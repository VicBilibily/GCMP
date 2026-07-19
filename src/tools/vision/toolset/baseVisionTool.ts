/**---------------------------------------------------------------------------------------------
 *  视觉工具基类
 *  统一处理文件校验、调用视觉后端和错误包装。
 *  各子工具的系统提示词源自智谱 MCP 视觉工具能力，仅做内嵌适配。
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import * as fs from 'node:fs';
import { Logger } from '../../../utils/runtime/logger';
import { t } from '../../../utils/runtime/l10n';
import { analyzeImagesWithSystem } from '../provider';

export abstract class BaseVisionTool implements vscode.LanguageModelTool<Record<string, unknown>> {
    protected abstract readonly toolName: string;
    protected abstract readonly invocationMessage: [string, string];

    prepareInvocation(
        _options: vscode.LanguageModelToolInvocationPrepareOptions<Record<string, unknown>>,
        _token: vscode.CancellationToken
    ): vscode.ProviderResult<vscode.PreparedToolInvocation> {
        return {
            invocationMessage: t(this.invocationMessage[0], this.invocationMessage[1])
        };
    }

    async invoke(
        options: vscode.LanguageModelToolInvocationOptions<Record<string, unknown>>,
        token: vscode.CancellationToken
    ): Promise<vscode.LanguageModelToolResult> {
        try {
            const filePaths = this.extractFilePaths(options.input);
            for (const filePath of filePaths) {
                if (!filePath || !fs.existsSync(filePath)) {
                    return new vscode.LanguageModelToolResult([
                        new vscode.LanguageModelTextPart(
                            t(
                                'Error: Image file not found or has been cleared from cache.',
                                '错误：图片文件不存在或已从缓存中清除。'
                            )
                        )
                    ]);
                }
            }

            const systemPrompt = this.getSystemPrompt(options.input);
            const userPrompt = this.buildUserPrompt(options.input);
            const result = await analyzeImagesWithSystem(filePaths, systemPrompt, userPrompt || undefined, token);

            Logger.trace(`[${this.toolName}] Image analyzed: ${filePaths.join(', ')}`);

            return new vscode.LanguageModelToolResult([new vscode.LanguageModelTextPart(result.content)]);
        } catch (error) {
            // 用户主动取消（例如关闭模型选择向导）：原样上抛，交由 VS Code 工具机制统一处理
            if (error instanceof vscode.CancellationError) {
                throw error;
            }
            const errMsg = error instanceof Error ? error.message : t('Unknown error', '未知错误');
            Logger.error(`[${this.toolName}] Vision analysis failed: ${errMsg}`);
            return new vscode.LanguageModelToolResult([
                new vscode.LanguageModelTextPart(t('Image analysis failed: {0}', '图片分析失败：{0}', errMsg))
            ]);
        }
    }

    protected abstract getSystemPrompt(input: Record<string, unknown>): string;

    protected extractFilePaths(input: Record<string, unknown>): string[] {
        const filePath = input.filePath;
        if (typeof filePath !== 'string' || !filePath.trim()) {
            throw new Error(t('Missing required parameter: filePath', '缺少必需参数: filePath'));
        }
        return [filePath];
    }

    protected buildUserPrompt(input: Record<string, unknown>): string {
        const prompt = input.prompt;
        if (typeof prompt !== 'string' || !prompt.trim()) {
            throw new Error(t('Missing required parameter: prompt', '缺少必需参数: prompt'));
        }
        return prompt;
    }
}
