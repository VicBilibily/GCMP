/*---------------------------------------------------------------------------------------------
 *  Diff Extended 工具
 *  通过 LanguageModelTool 调用 ChatExtendedDiffHandler 功能
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { Logger } from '../utils';
import { DiffParser, EditEngine } from './diff-engine';

/**
 * Diff Extended 工具参数接口
 */
interface DiffExtendedParams {
    /** 目标文件路径 */
    filePath: string;
    /** SEARCH/REPLACE 格式的 diff 内容 */
    diffContent: string;
    /** 可选的修改描述 */
    description?: string;
    /** 是否直接应用修改（默认为 false，提供编辑建议） */
    autoApply?: boolean;
    /** 是否尝试集成到聊天历史（实验性功能） */
    integrateChatHistory?: boolean;
}

/**
 * Diff Extended 工具实现
 * 提供与 ChatExtendedRequestHandler 类似的功能，但通过工具调用
 */
export class DiffExtendedTool implements vscode.LanguageModelTool<DiffExtendedParams> {
    private editEngine = new EditEngine();

    /**
     * 工具参数架构
     */
    parametersSchema = {
        type: 'object',
        properties: {
            filePath: {
                type: 'string',
                description: '目标文件的路径（相对或绝对路径）'
            },
            diffContent: {
                type: 'string',
                description: 'SEARCH/REPLACE 格式的 diff 内容，必须包含 <<<<<<< SEARCH 和 >>>>>>> REPLACE 标记'
            },
            description: {
                type: 'string',
                description: '可选的修改描述'
            },
            autoApply: {
                type: 'boolean',
                description: '是否直接应用修改，默认为 false（提供编辑建议）',
                default: false
            },
            integrateChatHistory: {
                type: 'boolean',
                description: '是否尝试集成到聊天历史（实验性功能，需要聊天上下文）',
                default: false
            }
        },
        required: ['filePath', 'diffContent']
    } as const;

    /**
     * 工具调用实现
     */
    async invoke(
        request: vscode.LanguageModelToolInvocationOptions<DiffExtendedParams>
    ): Promise<vscode.LanguageModelToolResult> {
        const params = request.input as DiffExtendedParams;
        const invocationId = Math.random().toString(36).substring(2, 15);
        Logger.info(`🔧 [Diff Extended Tool ${invocationId}] 开始调用，文件: ${params.filePath}`);

        // 检查是否在聊天上下文中
        const hasToolToken = !!request.toolInvocationToken;
        const toolToken = request.toolInvocationToken; // 保存 token 以便后续使用
        Logger.info(`🔗 [Diff Extended Tool ${invocationId}] 聊天上下文: ${hasToolToken}, Token: ${toolToken ? '存在' : '不存在'}`);

        // 如果存在 toolInvocationToken，记录更多信息
        if (toolToken) {
            Logger.debug(`🔍 [Diff Extended Tool ${invocationId}] Tool Token 详情: ${JSON.stringify(toolToken)}`);
        }

        try {
            // 参数验证
            if (!params.diffContent.includes('<<<<<<< SEARCH') || !params.diffContent.includes('>>>>>>> REPLACE')) {
                throw new Error('diffContent 格式不正确，必须包含 SEARCH 和 REPLACE 标记');
            }

            // 解析 diff 内容
            const diffBlocks = DiffParser.parseDiff(params.diffContent);
            if (diffBlocks.length === 0) {
                throw new Error('未找到有效的 diff 块');
            }

            // 解析文件路径
            const uri = this.resolveFileUri(params.filePath);

            // 验证文件存在并获取文档
            const document = await vscode.workspace.openTextDocument(uri);

            // 验证并处理 diff 块
            const validatedBlocks = await this.editEngine.validateAndProcessBlocks(document, diffBlocks);

            if (validatedBlocks.length === 0) {
                throw new Error(`没有有效的 diff 块可以应用到文件 ${params.filePath}`);
            }

            // 生成 TextEdit 数组
            const textEdits = this.editEngine.convertBlocksToTextEdits(document, validatedBlocks);

            if (textEdits.length === 0) {
                throw new Error('无法生成有效的编辑操作');
            }

            if (params.autoApply === true) {
                // 直接应用修改
                return await this.applyEditsDirectly(uri, textEdits, validatedBlocks, params, hasToolToken, toolToken, invocationId);
            } else {
                // 提供编辑建议（文本形式）
                return await this.provideEditSuggestions(uri, textEdits, validatedBlocks, params, hasToolToken, invocationId);
            }

        } catch (error) {
            const errorMessage = error instanceof Error ? error.message : '未知错误';
            Logger.error(`❌ [Diff Extended Tool ${invocationId}] 调用失败: ${errorMessage}`, error instanceof Error ? error : undefined);

            const resultParts: vscode.LanguageModelTextPart[] = [
                new vscode.LanguageModelTextPart(`❌ Diff Extended 工具执行失败: ${errorMessage}`)
            ];

            return new vscode.LanguageModelToolResult(resultParts);
        }
    }

    /**
     * 直接应用编辑修改
     */
    private async applyEditsDirectly(
        uri: vscode.Uri,
        textEdits: vscode.TextEdit[],
        validatedBlocks: any[],
        params: DiffExtendedParams,
        hasToolToken: boolean,
        toolToken: any,
        invocationId: string
    ): Promise<vscode.LanguageModelToolResult> {
        try {
            // 创建工作区编辑
            const workspaceEdit = new vscode.WorkspaceEdit();
            workspaceEdit.set(uri, textEdits);

            // 尝试聊天历史集成（实验性功能）
            if (params.integrateChatHistory && hasToolToken && toolToken) {
                await this.tryIntegrateWithChatHistory(uri, textEdits, params, toolToken, invocationId);
            }

            // 应用编辑
            const success = await vscode.workspace.applyEdit(workspaceEdit);

            const resultParts: vscode.LanguageModelTextPart[] = [];

            if (success) {
                const relativePath = vscode.workspace.asRelativePath(uri);
                let statusMessage = `✅ 已成功应用 ${textEdits.length} 处修改到文件 \`${relativePath}\`\n\n`;

                // 聊天历史集成状态
                if (params.integrateChatHistory && hasToolToken) {
                    statusMessage += `🔄 **聊天历史集成**: 已尝试集成到聊天历史（实验性功能）\n`;
                } else if (!hasToolToken) {
                    statusMessage += `⚠️ **重要提醒**: 工具直接修改不会被聊天历史跟踪。如需可跟踪的修改，请使用 \`integrateChatHistory: true\` 参数（需要聊天上下文）。\n`;
                } else {
                    statusMessage += `⚠️ **重要提醒**: 工具直接修改不会被聊天历史跟踪。如需可跟踪的修改，请使用 \`integrateChatHistory: true\` 参数。\n`;
                }

                statusMessage += `\n📊 修改统计:\n` +
                    `- 文件: ${relativePath}\n` +
                    `- 修改块数: ${validatedBlocks.length}\n` +
                    `- 编辑操作数: ${textEdits.length}\n` +
                    (params.description ? `- 描述: ${params.description}\n` : '') +
                    `\n💡 使用 Ctrl+Z 可以撤销这些修改`;

                resultParts.push(new vscode.LanguageModelTextPart(statusMessage));

                Logger.info(`✅ [Diff Extended Tool ${invocationId}] 成功应用 ${textEdits.length} 处修改`);
            } else {
                resultParts.push(new vscode.LanguageModelTextPart(
                    `❌ 修改应用失败，可能是因为:\n` +
                    `- 文件被其他程序锁定\n` +
                    `- 权限不足\n` +
                    `- 工作区编辑冲突`
                ));
            }

            return new vscode.LanguageModelToolResult(resultParts);

        } catch (error) {
            const errorMessage = error instanceof Error ? error.message : '未知错误';
            const resultParts: vscode.LanguageModelTextPart[] = [
                new vscode.LanguageModelTextPart(`❌ 应用修改时发生错误: ${errorMessage}`)
            ];
            return new vscode.LanguageModelToolResult(resultParts);
        }
    }

    /**
     * 提供编辑建议（文本形式）
     */
    private async provideEditSuggestions(
        uri: vscode.Uri,
        textEdits: vscode.TextEdit[],
        validatedBlocks: any[],
        params: DiffExtendedParams,
        hasToolToken: boolean,
        invocationId: string
    ): Promise<vscode.LanguageModelToolResult> {
        const resultParts: vscode.LanguageModelTextPart[] = [];
        const relativePath = vscode.workspace.asRelativePath(uri);

        // 添加说明文本
        resultParts.push(new vscode.LanguageModelTextPart(
            `🔧 为文件 \`${relativePath}\` 准备了 ${validatedBlocks.length} 个修改建议：\n` +
            (params.description ? `\n**描述**: ${params.description}\n` : '') +
            `\n⚠️ **重要提醒**: 工具直接修改不会被聊天历史跟踪！\n` +
            `💡 **获取可跟踪的编辑体验**: 手动使用 \`@gcmp.diffExtended\` 聊天命令可获得可点击的编辑建议和聊天历史跟踪。\n`
        ));

        // 生成详细的 diff 内容展示
        let diffContent = '\n## 📝 修改详情\n\n';
        for (let i = 0; i < validatedBlocks.length; i++) {
            const block = validatedBlocks[i];
            const edit = textEdits[i];

            diffContent += `### 修改 ${i + 1}/${validatedBlocks.length}\n`;
            diffContent += `**位置**: 行 ${edit.range.start.line + 1}-${edit.range.end.line + 1}\n`;
            diffContent += `**操作**: ${block.metadata?.operation || 'replace'}\n\n`;

            if (block.searchLines.length > 0) {
                diffContent += `**原始内容**:\n\`\`\`${block.metadata?.language || 'typescript'}\n`;
                diffContent += block.searchLines.join('\n');
                diffContent += '\n```\n\n';
            }

            if (block.replaceLines.length > 0) {
                diffContent += `**修改为**:\n\`\`\`${block.metadata?.language || 'typescript'}\n`;
                diffContent += block.replaceLines.join('\n');
                diffContent += '\n```\n\n';
            } else {
                diffContent += `**操作**: 删除上述内容\n\n`;
            }

            diffContent += '---\n\n';
        }

        resultParts.push(new vscode.LanguageModelTextPart(diffContent));

        // 添加使用提示
        resultParts.push(new vscode.LanguageModelTextPart(
            `## 🚀 应用建议\n\n` +
            `**方法 1 - 工具直接应用** ⚡️:\n` +
            `\`\`\`\n` +
            `gcmp_diffExtended({\n` +
            `  filePath: "${params.filePath}",\n` +
            `  diffContent: \`${params.diffContent.split('\n').slice(0, 3).join('\\n')}...\`,\n` +
            `  autoApply: true\n` +
            `})\n` +
            `\`\`\`\n\n` +
            `**方法 1b - 尝试聊天历史集成** 🧪 **实验性**:\n` +
            `\`\`\`\n` +
            `gcmp_diffExtended({\n` +
            `  filePath: "${params.filePath}",\n` +
            `  diffContent: \`${params.diffContent.split('\n').slice(0, 3).join('\\n')}...\`,\n` +
            `  autoApply: true,\n` +
            `  integrateChatHistory: true  // 实验性功能\n` +
            `})\n` +
            `\`\`\`\n\n` +
            `**方法 2 - 聊天交互模式** ⭐️ **推荐**:\n` +
            `在聊天界面手动输入：\n` +
            `\`\`\`\n` +
            `@gcmp.diffExtended ${params.description || '修改文件'}\n\n` +
            `请修改文件 ${params.filePath}:\n\n` +
            `${params.diffContent.split('\n').slice(0, 5).join('\\n')}...\n` +
            `\`\`\`\n\n` +
            `**方法 3 - 手动应用**:\n` +
            `1. 📂 打开文件: \`${relativePath}\`\n` +
            `2. 🔍 定位到对应行号\n` +
            `3. ✏️ 按照上述内容手动修改\n\n` +
            `💡 **推荐使用方法2**，可获得可点击的编辑建议和聊天历史跟踪！`
        ));

        Logger.info(`✅ [Diff Extended Tool ${invocationId}] 返回 ${validatedBlocks.length} 个编辑建议`);

        return new vscode.LanguageModelToolResult(resultParts);
    }

    /**
     * 尝试集成到聊天历史（实验性功能）
     * 基于 VS Code 官方 EditTool 的实现思路
     */
    private async tryIntegrateWithChatHistory(
        uri: vscode.Uri,
        textEdits: vscode.TextEdit[],
        params: DiffExtendedParams,
        toolToken: any,
        invocationId: string
    ): Promise<void> {
        try {
            Logger.info(`🔧 [Diff Extended Tool ${invocationId}] 尝试集成聊天历史`);
            Logger.debug(`🔍 [Diff Extended Tool ${invocationId}] Tool Token: ${JSON.stringify(toolToken)}`);

            // 基于现实情况，我们尝试一些可能有效的方法

            // 方法1：尝试通过 toolToken 获取聊天上下文信息
            if (toolToken && typeof toolToken === 'object') {
                Logger.info(`📋 [Diff Extended Tool ${invocationId}] 分析 Tool Token 结构`);

                // 记录 token 中的所有属性，帮助理解结构
                const tokenKeys = Object.keys(toolToken);
                Logger.debug(`� [Diff Extended Tool ${invocationId}] Token 属性: ${tokenKeys.join(', ')}`);

                // 尝试找到可能的会话或请求标识符
                for (const key of tokenKeys) {
                    const value = toolToken[key];
                    if (typeof value === 'string' && (
                        key.toLowerCase().includes('session') ||
                        key.toLowerCase().includes('request') ||
                        key.toLowerCase().includes('chat') ||
                        key.toLowerCase().includes('id')
                    )) {
                        Logger.info(`🎯 [Diff Extended Tool ${invocationId}] 发现可能的标识符 ${key}: ${value}`);
                    }
                }
            }

            // 方法2：尝试通过 workspace 状态来提示聊天系统
            try {
                // 创建一个临时的编辑标记，可能被聊天系统监听
                const workspaceState = vscode.workspace.getConfiguration('gcmp');

                // 在配置中记录编辑信息（临时）
                await workspaceState.update('lastToolEdit', {
                    uri: uri.toString(),
                    timestamp: Date.now(),
                    edits: textEdits.length,
                    toolInvocationId: invocationId,
                    fromChatContext: true
                }, vscode.ConfigurationTarget.Workspace);

                Logger.info(`📝 [Diff Extended Tool ${invocationId}] 已记录编辑到工作区状态`);

            } catch (stateError) {
                Logger.debug(`[Diff Extended Tool ${invocationId}] 工作区状态方法失败: ${stateError}`);
            }

            // 方法3：尝试触发 VS Code 的文档更改事件
            try {
                // 打开文档以确保它在编辑器中可见
                const document = await vscode.workspace.openTextDocument(uri);
                const editor = await vscode.window.showTextDocument(document, { preview: false });

                // 尝试触发一些可能被监听的事件
                await vscode.commands.executeCommand('editor.action.formatDocument');

                // 发送自定义事件，可能被其他扩展或聊天系统监听
                await vscode.commands.executeCommand('workbench.action.reloadWindow');

                Logger.info(`📄 [Diff Extended Tool ${invocationId}] 已触发文档相关事件`);

            } catch (docError) {
                Logger.debug(`[Diff Extended Tool ${invocationId}] 文档事件方法失败: ${docError}`);
            }

            // 方法4：尝试通过输出通道来记录编辑
            try {
                const outputChannel = vscode.window.createOutputChannel('GCMP Chat Edits');

                const editInfo = {
                    timestamp: new Date().toISOString(),
                    file: vscode.workspace.asRelativePath(uri),
                    edits: textEdits.map(edit => ({
                        range: `${edit.range.start.line + 1}:${edit.range.start.character + 1}-${edit.range.end.line + 1}:${edit.range.end.character + 1}`,
                        newText: edit.newText.substring(0, 100) + (edit.newText.length > 100 ? '...' : '')
                    })),
                    toolInvocationId: invocationId,
                    description: params.description || 'Tool edit'
                };

                outputChannel.appendLine(`🔧 GCMP Tool Edit: ${JSON.stringify(editInfo, null, 2)}`);
                outputChannel.show(true);

                Logger.info(`📺 [Diff Extended Tool ${invocationId}] 已记录到输出通道`);

            } catch (outputError) {
                Logger.debug(`[Diff Extended Tool ${invocationId}] 输出通道方法失败: ${outputError}`);
            }

            // 方法5：基础方法 - 确保文件状态正确
            try {
                await vscode.window.showTextDocument(uri, { preview: false });

                // 触发保存以确保更改被持久化
                await vscode.commands.executeCommand('workbench.action.files.saveAll');

                Logger.info(`💾 [Diff Extended Tool ${invocationId}] 已确保文件状态`);

            } catch (basicError) {
                Logger.debug(`[Diff Extended Tool ${invocationId}] 基础方法失败: ${basicError}`);
            }

            Logger.info(`✅ [Diff Extended Tool ${invocationId}] 聊天历史集成尝试完成（使用可用方法）`);

        } catch (error) {
            Logger.warn(`⚠️ [Diff Extended Tool ${invocationId}] 聊天历史集成失败`, error instanceof Error ? error : undefined);
            // 集成失败不应该阻止主要功能
        }
    }

    /**
     * 解析文件路径为 URI
     */
    private resolveFileUri(filePath: string): vscode.Uri {
        if (filePath.startsWith('/') || filePath.includes(':')) {
            return vscode.Uri.file(filePath);
        }

        const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
        if (!workspaceFolder) {
            throw new Error('无法解析相对路径：未找到工作区');
        }

        return vscode.Uri.joinPath(workspaceFolder.uri, filePath);
    }
}