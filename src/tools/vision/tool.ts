/*---------------------------------------------------------------------------------------------
 *  gcmp_visionTool 图像识别工具
 *  为不支持原生图像输入的模型提供统一的图片分析能力。
 *  支持配置使用 MiniMax Vision API 或委派给原生多模态模型。
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import * as fs from 'node:fs';
import { Logger } from '../../utils';
import { t } from '../../utils/l10n';
import { analyzeImage } from './provider';

export class VisionTool implements vscode.LanguageModelTool<Record<string, unknown>> {
    prepareInvocation(
        _options: vscode.LanguageModelToolInvocationPrepareOptions<Record<string, unknown>>,
        _token: vscode.CancellationToken
    ): vscode.ProviderResult<vscode.PreparedToolInvocation> {
        return {
            invocationMessage: t('Analyzing image content...', '正在分析图片内容...')
        };
    }

    async invoke(
        options: vscode.LanguageModelToolInvocationOptions<Record<string, unknown>>,
        token: vscode.CancellationToken
    ): Promise<vscode.LanguageModelToolResult> {
        const input = options.input as { filePath?: string; prompt?: string };
        const filePath = input.filePath;

        if (!filePath || !fs.existsSync(filePath)) {
            return new vscode.LanguageModelToolResult([
                new vscode.LanguageModelTextPart('Error: Image file not found or has been cleared from cache.')
            ]);
        }

        try {
            const result = await analyzeImage(filePath, input.prompt, token);

            Logger.trace(`[gcmp_visionTool] Image analyzed: ${filePath}`);

            return new vscode.LanguageModelToolResult([new vscode.LanguageModelTextPart(result.content)]);
        } catch (error) {
            const errMsg = error instanceof Error ? error.message : 'Unknown error';
            Logger.error(`[gcmp_visionTool] Vision analysis failed: ${errMsg}`);
            return new vscode.LanguageModelToolResult([
                new vscode.LanguageModelTextPart(`Image analysis failed: ${errMsg}`)
            ]);
        }
    }
}
