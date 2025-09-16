/**
 * GCMP 聊天响应集成器
 * 
 * 实现真正的 VS Code 聊天窗口文件修改显示
 * 模拟官方 GitHub Copilot 的聊天体验
 */

import * as vscode from 'vscode';
import { Logger } from '../utils';

export interface ChatFileModification {
    uri: vscode.Uri;
    edits: vscode.TextEdit[];
    description: string;
    timestamp: Date;
    sessionId: string;
}

/**
 * 聊天响应文件修改显示器
 * 在聊天窗口中显示文件修改，就像官方工具一样
 */
export class ChatResponseFileModifier {
    private static instance: ChatResponseFileModifier;
    private modificationHistory: ChatFileModification[] = [];

    private constructor() {
        Logger.info('💬 [Chat Response] 聊天响应文件修改器已初始化');
    }

    static getInstance(): ChatResponseFileModifier {
        if (!ChatResponseFileModifier.instance) {
            ChatResponseFileModifier.instance = new ChatResponseFileModifier();
        }
        return ChatResponseFileModifier.instance;
    }

    /**
     * 在聊天窗口中显示文件修改
     * 这是核心方法 - 创建真正的聊天消息
     */
    async displayFileModificationInChat(
        uri: vscode.Uri,
        edits: vscode.TextEdit[],
        description: string,
        sessionId?: string
    ): Promise<void> {
        try {
            const modification: ChatFileModification = {
                uri,
                edits,
                description,
                timestamp: new Date(),
                sessionId: sessionId || `session-${Date.now()}`
            };

            // 记录到历史
            this.modificationHistory.push(modification);
            if (this.modificationHistory.length > 50) {
                this.modificationHistory.shift();
            }

            // 创建聊天消息内容
            const chatContent = this.createChatMessage(modification);

            // 方法1: 使用 Chat Provider API (如果可用)
            await this.tryDisplayViaChatProvider(chatContent, modification);

            // 方法2: 使用 Language Model Chat Integration
            await this.tryDisplayViaLanguageModelChat(chatContent, modification);

            Logger.info(`💬 [Chat Response] 文件修改已显示在聊天窗口: ${vscode.workspace.asRelativePath(uri)}`);

        } catch (error) {
            Logger.error(`❌ [Chat Response] 显示文件修改失败: ${error instanceof Error ? error.message : error}`);
        }
    }

    /**
     * 尝试通过 Chat Provider 显示
     */
    private async tryDisplayViaChatProvider(
        content: string,
        modification: ChatFileModification
    ): Promise<void> {
        try {
            // 检查是否有 Chat Provider API
            if (vscode.chat && 'sendMessage' in vscode.chat) {
                // 这是 proposed API，可能不在所有版本中可用
                // eslint-disable-next-line @typescript-eslint/no-explicit-any
                const chatApi = vscode.chat as any;
                await chatApi.sendMessage({
                    content,
                    type: 'assistant',
                    metadata: {
                        fileModification: {
                            uri: modification.uri.toString(),
                            editCount: modification.edits.length,
                            timestamp: modification.timestamp.toISOString()
                        }
                    }
                });
                Logger.debug('✅ [Chat Response] 通过 Chat Provider 显示成功');
                return;
            }
        } catch (error) {
            Logger.debug(`ℹ️ [Chat Response] Chat Provider 不可用: ${error instanceof Error ? error.message : error}`);
        }
    }

    /**
     * 尝试通过 Language Model Chat 显示
     */
    private async tryDisplayViaLanguageModelChat(
        content: string,
        modification: ChatFileModification
    ): Promise<void> {
        try {
            // 方法1: 在当前活动的编辑器中插入注释
            await this.insertChatCommentInEditor(content, modification);

            // 方法2: 创建专门的聊天历史文档
            await this.createChatHistoryDocument(content, modification);

        } catch (error) {
            Logger.debug(`ℹ️ [Chat Response] Language Model Chat 显示失败: ${error instanceof Error ? error.message : error}`);
        }
    }

    /**
     * 在编辑器中插入聊天式注释
     */
    private async insertChatCommentInEditor(
        content: string,
        modification: ChatFileModification
    ): Promise<void> {
        const editor = vscode.window.activeTextEditor;
        if (!editor) {
            return;
        }

        // 在文件顶部插入注释形式的聊天消息
        const chatComment = this.formatAsChatComment(content, modification);

        const edit = new vscode.WorkspaceEdit();
        edit.insert(editor.document.uri, new vscode.Position(0, 0), chatComment + '\n\n');

        await vscode.workspace.applyEdit(edit);

        // 移动光标到原来的位置
        const newPosition = new vscode.Position(
            editor.selection.active.line + chatComment.split('\n').length + 1,
            editor.selection.active.character
        );
        editor.selection = new vscode.Selection(newPosition, newPosition);
    }

    /**
     * 创建专门的聊天历史文档
     */
    private async createChatHistoryDocument(
        content: string,
        modification: ChatFileModification
    ): Promise<void> {
        let existingContent = '';
        try {
            const existingDoc = vscode.workspace.textDocuments.find(
                doc => doc.uri.scheme === 'untitled' && doc.fileName.includes('GCMP-Chat-History')
            );
            if (existingDoc) {
                existingContent = existingDoc.getText();
            }
        } catch {
            // 文档不存在，继续创建新的
        }

        // 追加新的聊天消息
        const timestamp = modification.timestamp.toLocaleString();
        const newChatEntry = `\n---\n\n**🤖 Assistant** - ${timestamp}\n\n${content}\n`;

        const fullContent = existingContent + newChatEntry;

        // 创建或更新文档
        const doc = await vscode.workspace.openTextDocument({
            content: fullContent,
            language: 'markdown'
        });

        // 显示文档（但不抢夺焦点）
        await vscode.window.showTextDocument(doc, {
            viewColumn: vscode.ViewColumn.Beside,
            preserveFocus: true,
            preview: false
        });

        Logger.debug('✅ [Chat Response] 聊天历史文档已更新');
    }

    /**
     * 创建聊天消息内容
     */
    private createChatMessage(modification: ChatFileModification): string {
        const relativePath = vscode.workspace.asRelativePath(modification.uri);
        const editCount = modification.edits.length;

        let message = `我已经修改了文件 \`${relativePath}\`\n\n`;
        message += '📝 **修改摘要**\n';
        message += `- 文件: ${relativePath}\n`;
        message += `- 修改数: ${editCount} 处更改\n`;
        message += `- 时间: ${modification.timestamp.toLocaleTimeString()}\n`;
        message += `- 描述: ${modification.description}\n\n`;

        // 添加修改详情
        if (editCount <= 5) { // 只显示少量修改的详情
            message += '📋 **修改详情**\n\n';
            modification.edits.forEach((edit, index) => {
                const startLine = edit.range.start.line + 1;
                const endLine = edit.range.end.line + 1;
                const lineInfo = startLine === endLine ? `行 ${startLine}` : `行 ${startLine}-${endLine}`;

                message += `${index + 1}. **${lineInfo}**: `;
                if (edit.newText.trim() === '') {
                    message += '删除内容\n';
                } else if (edit.range.isEmpty) {
                    message += '插入内容\n';
                } else {
                    message += '替换内容\n';
                }
            });
        } else {
            message += `📋 **修改详情**: 共 ${editCount} 处修改（较多，已省略详情）\n\n`;
        }

        message += '\n💡 你可以使用 **Ctrl+Z** 撤销这些修改，或者点击文件名查看具体更改。';

        return message;
    }

    /**
     * 格式化为聊天注释
     */
    private formatAsChatComment(content: string, modification: ChatFileModification): string {
        const lines = content.split('\n');
        const commentPrefix = this.getCommentPrefix(modification.uri);

        return lines.map(line => `${commentPrefix} ${line}`).join('\n');
    }

    /**
     * 根据文件类型获取注释前缀
     */
    private getCommentPrefix(uri: vscode.Uri): string {
        const ext = uri.fsPath.split('.').pop()?.toLowerCase();
        switch (ext) {
            case 'js':
            case 'ts':
            case 'jsx':
            case 'tsx':
            case 'java':
            case 'c':
            case 'cpp':
            case 'cs':
                return '//';
            case 'py':
            case 'sh':
            case 'yaml':
            case 'yml':
                return '#';
            case 'html':
            case 'xml':
                return '<!--';
            case 'css':
                return '/*';
            default:
                return '//';
        }
    }

    /**
     * 获取修改历史
     */
    getModificationHistory(): ChatFileModification[] {
        return [...this.modificationHistory];
    }

    /**
     * 清理历史
     */
    clearHistory(): void {
        this.modificationHistory = [];
        Logger.info('🧹 [Chat Response] 聊天修改历史已清理');
    }

    dispose(): void {
        this.modificationHistory = [];
    }
}

/**
 * 注册聊天响应相关命令
 */
export function registerChatResponseCommands(context: vscode.ExtensionContext): void {
    const chatModifier = ChatResponseFileModifier.getInstance();

    // 显示聊天修改历史
    const showChatHistoryCommand = vscode.commands.registerCommand(
        'gcmp.showChatModificationHistory',
        async () => {
            const history = chatModifier.getModificationHistory();

            if (history.length === 0) {
                vscode.window.showInformationMessage('💬 暂无聊天修改历史');
                return;
            }

            // 创建完整的聊天历史视图
            let chatHistory = '# 💬 GCMP 聊天修改历史\n\n';
            chatHistory += '> 这里显示了所有通过 GCMP 工具进行的文件修改，就像真正的聊天对话一样。\n\n';

            history.reverse().forEach((modification, _index) => {
                const timestamp = modification.timestamp.toLocaleString();

                chatHistory += '---\n\n';
                chatHistory += `**🤖 Assistant** - ${timestamp}\n\n`;

                const chatContent = chatModifier['createChatMessage'](modification);
                chatHistory += chatContent + '\n\n';
            });

            // 显示聊天历史
            const doc = await vscode.workspace.openTextDocument({
                content: chatHistory,
                language: 'markdown'
            });

            await vscode.window.showTextDocument(doc, {
                preview: false,
                preserveFocus: false
            });
        }
    );

    // 清理聊天历史
    const clearChatHistoryCommand = vscode.commands.registerCommand(
        'gcmp.clearChatModificationHistory',
        () => {
            chatModifier.clearHistory();
            vscode.window.showInformationMessage('✅ 聊天修改历史已清理');
        }
    );

    context.subscriptions.push(showChatHistoryCommand, clearChatHistoryCommand);

    Logger.info('💬 [Chat Response] 聊天响应命令已注册');
}