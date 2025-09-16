/*---------------------------------------------------------------------------------------------
 *  聊天扩展 Diff 处理器
 *  使用 ChatExtendedRequestHandler 实现 ChatResponseTextEditPart 编辑建议
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { Logger } from '../utils';
import { DiffParser, EditEngine } from './diff-engine';

/**
 * 聊天扩展 Diff 请求处理器
 * 支持 ChatResponseTextEditPart 编辑建议
 */
export class ChatExtendedDiffHandler {
    private editEngine = new EditEngine();
    private participant: vscode.ChatParticipant | undefined;

    /**
     * 注册聊天扩展处理器
     */
    register(context: vscode.ExtensionContext): void {
        // 使用 ChatExtendedRequestHandler
        const handler: vscode.ChatExtendedRequestHandler = async (
            request: vscode.ChatRequest,
            context: vscode.ChatContext,
            response: vscode.ChatResponseStream,
            token: vscode.CancellationToken
        ) => {
            return this.handleExtendedChatRequest(request, context, response, token);
        };

        // 创建聊天参与者并使用扩展处理器
        this.participant = vscode.chat.createChatParticipant('gcmp.diffExtended', handler);

        this.participant.iconPath = new vscode.ThemeIcon('diff');
        this.participant.followupProvider = {
            provideFollowups: this.provideFollowups.bind(this)
        };

        context.subscriptions.push(this.participant);
        Logger.info('🔧 [Chat Extended Diff] 聊天扩展 Diff 处理器已注册');
    }

    /**
     * 处理扩展聊天请求
     */
    private async handleExtendedChatRequest(
        request: vscode.ChatRequest,
        context: vscode.ChatContext,
        response: vscode.ChatResponseStream,
        token: vscode.CancellationToken
    ): Promise<vscode.ChatResult> {
        Logger.info(`🔧 [Chat Extended Diff] 收到扩展聊天请求: ${request.prompt}`);

        try {
            // 解析请求内容
            const parsed = await this.parseExtendedRequest(request, context);
            if (!parsed) {
                response.markdown(`❌ 无法解析请求。请提供文件路径和修改内容。\n\n**示例**:\n` +
                    `- 修改文件 \`src/example.ts\`，添加新的函数\n` +
                    `- 或者直接提供 SEARCH/REPLACE 格式的 diff`);
                return { metadata: { command: 'help' } };
            }

            const { filePath, diffContent, description } = parsed;

            // 显示正在处理的信息
            response.progress(`正在处理文件 ${filePath}...`);

            // 解析 diff 内容
            const diffBlocks = DiffParser.parseDiff(diffContent);
            if (diffBlocks.length === 0) {
                response.markdown('❌ 未找到有效的 diff 块。请检查格式或提供更具体的修改说明。');
                return { metadata: { command: 'error', reason: 'no_diff_blocks' } };
            }

            // 解析文件路径
            const uri = this.resolveFileUri(filePath);

            try {
                // 验证文件存在并获取文档
                const document = await vscode.workspace.openTextDocument(uri);
                response.progress(`验证 diff 块...`);

                // 验证并处理 diff 块
                const validatedBlocks = await this.editEngine.validateAndProcessBlocks(document, diffBlocks);

                if (validatedBlocks.length === 0) {
                    response.markdown(`❌ 没有有效的 diff 块可以应用到文件 \`${filePath}\`。\n\n` +
                        `可能的原因：\n` +
                        `- 搜索内容与文件内容不匹配\n` +
                        `- 行号不正确\n` +
                        `- 文件内容已发生变化`);
                    return { metadata: { command: 'error', reason: 'no_valid_blocks' } };
                }

                // 生成 TextEdit 数组
                const textEdits = this.editEngine.convertBlocksToTextEdits(document, validatedBlocks);

                if (textEdits.length === 0) {
                    response.markdown('❌ 无法生成有效的编辑操作。');
                    return { metadata: { command: 'error', reason: 'no_text_edits' } };
                }

                // 显示编辑摘要
                response.markdown(`## 📝 文件修改建议\n\n`);
                response.markdown(`**文件**: \`${vscode.workspace.asRelativePath(uri)}\`\n`);
                response.markdown(`**修改数量**: ${validatedBlocks.length} 个\n`);
                if (description) {
                    response.markdown(`**描述**: ${description}\n`);
                }
                response.markdown(`\n---\n\n`);

                // 关键：推送 ChatResponseTextEditPart 到响应流
                Logger.info(`🔧 [Chat Extended Diff] 推送 ${textEdits.length} 个编辑建议`);

                for (let i = 0; i < textEdits.length; i++) {
                    const edit = textEdits[i];
                    const block = validatedBlocks[i];

                    // 可以为每个编辑添加描述
                    response.markdown(`### 修改 ${i + 1}/${textEdits.length}\n`);
                    response.markdown(`**位置**: 行 ${edit.range.start.line + 1}-${edit.range.end.line + 1}\n`);
                    response.markdown(`**操作**: ${block.metadata?.operation || 'replace'}\n\n`);

                    // 推送编辑建议
                    response.push(new vscode.ChatResponseTextEditPart(uri, [edit]));
                }

                response.markdown(`\n💡 **使用说明**:\n` +
                    `- 点击上方的编辑建议可以预览更改\n` +
                    `- 选择"Accept"应用修改，"Reject"拒绝修改\n` +
                    `- 所有修改都会集成到 VS Code 的撤销历史中\n`);

                Logger.info(`✅ [Chat Extended Diff] 成功推送 ${textEdits.length} 个编辑建议`);

                return {
                    metadata: {
                        command: 'diff_suggestions',
                        fileUri: uri.toString(),
                        editsCount: textEdits.length,
                        description: description || 'diff modifications'
                    }
                };

            } catch (fileError) {
                response.markdown(`❌ 无法访问文件: \`${filePath}\`\n\n` +
                    `错误信息: ${fileError instanceof Error ? fileError.message : '未知错误'}`);
                return { metadata: { command: 'error', reason: 'file_access_failed' } };
            }

        } catch (error) {
            const errorMessage = error instanceof Error ? error.message : '未知错误';
            Logger.error(`❌ [Chat Extended Diff] 处理扩展聊天请求失败: ${errorMessage}`, error instanceof Error ? error : undefined);

            response.markdown(`❌ 处理请求失败: ${errorMessage}\n\n` +
                `请检查您的输入格式或文件路径是否正确。`);
            return { metadata: { command: 'error', reason: 'processing_failed' } };
        }
    }

    /**
     * 解析扩展请求内容
     */
    private async parseExtendedRequest(
        request: vscode.ChatRequest,
        context: vscode.ChatContext
    ): Promise<{ filePath: string; diffContent: string; description?: string } | null> {
        const prompt = request.prompt.trim();

        // 方法1: 检查是否包含完整的 SEARCH/REPLACE 格式
        if (prompt.includes('<<<<<<< SEARCH') && prompt.includes('>>>>>>> REPLACE')) {
            // 尝试从提示中提取文件路径
            const lines = prompt.split('\n');
            let filePath = '';
            let diffStartIndex = -1;

            for (let i = 0; i < lines.length; i++) {
                const line = lines[i].trim();

                // 查找文件路径提示
                if (line.includes('.') && (line.includes('/') || line.includes('\\'))) {
                    // 简单的文件路径检测
                    const pathMatch = line.match(/([^\s]+\.[a-zA-Z]{1,4})/);
                    if (pathMatch) {
                        filePath = pathMatch[1];
                    }
                }

                if (line === '<<<<<<< SEARCH') {
                    diffStartIndex = i;
                    break;
                }
            }

            if (diffStartIndex !== -1) {
                const diffContent = lines.slice(diffStartIndex).join('\n');
                return {
                    filePath: filePath || 'unknown.ts', // 默认文件名
                    diffContent,
                    description: lines.slice(0, diffStartIndex).join(' ').trim()
                };
            }
        }

        // 方法2: 检查是否是自然语言描述，需要转换为 diff
        // 这里可以集成 AI 来生成 diff，但现在先返回 null
        const filePathMatch = prompt.match(/文件[：:\s]+([^\s,，]+\.[a-zA-Z]{1,4})/);
        if (filePathMatch) {
            // 如果提到了文件但没有具体的 diff，提示用户提供更多信息
            return null;
        }

        return null;
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

    /**
     * 提供后续建议
     */
    private async provideFollowups(
        result: vscode.ChatResult,
        context: vscode.ChatContext,
        token: vscode.CancellationToken
    ): Promise<vscode.ChatFollowup[]> {
        const followups: vscode.ChatFollowup[] = [];

        if (result.metadata?.command === 'diff_suggestions') {
            followups.push({
                prompt: '应用所有建议的修改',
                label: '🚀 应用所有修改',
                command: 'gcmp.applyAllSuggestions'
            });

            followups.push({
                prompt: '查看修改的文件',
                label: '📂 打开文件',
                command: 'vscode.open'
            });

            followups.push({
                prompt: '撤销这些修改',
                label: '↩️ 撤销修改',
                command: 'undo'
            });
        } else if (result.metadata?.command === 'error') {
            followups.push({
                prompt: '查看帮助信息',
                label: '❓ 获取帮助',
                command: 'gcmp.diffHelp'
            });
        }

        return followups;
    }

    /**
     * 释放资源
     */
    dispose(): void {
        if (this.participant) {
            this.participant.dispose();
            Logger.info('🔧 [Chat Extended Diff] 扩展处理器已释放');
        }
    }
}

/**
 * 激活聊天扩展 Diff 处理器
 */
export function activateChatExtendedDiffHandler(context: vscode.ExtensionContext): ChatExtendedDiffHandler {
    const handler = new ChatExtendedDiffHandler();
    handler.register(context);
    return handler;
}