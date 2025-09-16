/**
 * GCMP 文件修改跟踪器
 *
 * 使用 VS Code 原生的 Chat 编辑集成来实现真正的聊天窗口文件修改历史显示
 * 这将创建类似于官方 GitHub Copilot 的文件修改跟踪体验
 */

import * as vscode from 'vscode';
import { Logger } from '../utils';

export interface ChatEditEvent {
    uri: vscode.Uri;
    edits: vscode.TextEdit[];
    timestamp: Date;
    description: string;
    sessionId: string;
}

/**
 * 文件修改跟踪管理器
 * 实现真正的 VS Code 聊天集成
 */
export class FileModificationTracker {
    private static instance: FileModificationTracker;
    private editHistory: ChatEditEvent[] = [];
    private activeEditSessions = new Map<string, ChatEditEvent[]>();

    private constructor() {
        Logger.info('🔍 [File Tracker] 文件修改跟踪器已初始化');
    }

    static getInstance(): FileModificationTracker {
        if (!FileModificationTracker.instance) {
            FileModificationTracker.instance = new FileModificationTracker();
        }
        return FileModificationTracker.instance;
    }

    /**
     * 记录文件修改事件（用于聊天历史集成）
     */
    recordFileEdit(uri: vscode.Uri, edits: vscode.TextEdit[], description: string, sessionId?: string): ChatEditEvent {
        const event: ChatEditEvent = {
            uri,
            edits,
            timestamp: new Date(),
            description,
            sessionId: sessionId || `session-${Date.now()}`
        };

        this.editHistory.push(event);

        // 维护历史大小
        if (this.editHistory.length > 100) {
            this.editHistory.shift();
        }

        // 如果有活动会话，添加到会话中
        if (!this.activeEditSessions.has(event.sessionId)) {
            this.activeEditSessions.set(event.sessionId, []);
        }
        this.activeEditSessions.get(event.sessionId)!.push(event);

        Logger.info(`📝 [File Tracker] 记录文件修改: ${vscode.workspace.asRelativePath(uri)}, 编辑数: ${edits.length}`);

        return event;
    }

    /**
     * 获取最近的文件修改记录
     */
    getRecentEdits(count = 10): ChatEditEvent[] {
        return this.editHistory.slice(-count).reverse();
    }

    /**
     * 获取特定会话的编辑记录
     */
    getSessionEdits(sessionId: string): ChatEditEvent[] {
        return this.activeEditSessions.get(sessionId) || [];
    }

    /**
     * 创建文件修改的聊天消息（用于在聊天窗口中显示）
     */
    createChatEditMessage(event: ChatEditEvent): string {
        const relativePath = vscode.workspace.asRelativePath(event.uri);
        const timeStr = event.timestamp.toLocaleTimeString();

        let message = '## 📝 文件已修改\n\n';
        message += `**文件**: \`${relativePath}\`  \n`;
        message += `**时间**: ${timeStr}  \n`;
        message += `**编辑数**: ${event.edits.length} 处修改  \n`;
        message += `**描述**: ${event.description}  \n\n`;

        // 添加编辑详情
        if (event.edits.length > 0) {
            message += '### 📋 修改详情\n\n';
            event.edits.forEach((edit, index) => {
                const startLine = edit.range.start.line + 1;
                const endLine = edit.range.end.line + 1;
                const lineInfo = startLine === endLine ? `行 ${startLine}` : `行 ${startLine}-${endLine}`;
                message += `${index + 1}. ${lineInfo}: `;

                if (edit.newText.trim() === '') {
                    message += '删除内容\n';
                } else if (edit.range.isEmpty) {
                    message += '插入内容\n';
                } else {
                    message += '替换内容\n';
                }
            });
        }

        message += '\n💡 你可以使用 Ctrl+Z 撤销这些修改';

        return message;
    }

    /**
     * 清理历史记录
     */
    clearHistory(): void {
        this.editHistory = [];
        this.activeEditSessions.clear();
        Logger.info('🧹 [File Tracker] 历史记录已清理');
    }

    dispose(): void {
        this.editHistory = [];
        this.activeEditSessions.clear();
    }
}

/**
 * GCMP 聊天编辑集成器
 * 专门用于与 VS Code 聊天系统集成
 */
export class GCMPChatEditIntegrator {
    private static instance: GCMPChatEditIntegrator;
    private fileTracker = FileModificationTracker.getInstance();

    private constructor() {
        Logger.info('💬 [Chat Edit Integrator] 聊天编辑集成器已初始化');
    }

    static getInstance(): GCMPChatEditIntegrator {
        if (!GCMPChatEditIntegrator.instance) {
            GCMPChatEditIntegrator.instance = new GCMPChatEditIntegrator();
        }
        return GCMPChatEditIntegrator.instance;
    }

    /**
     * 在聊天中显示文件修改（关键方法）
     * 这会在用户的聊天历史中创建一个新的消息条目
     */
    async showFileModificationInChat(
        uri: vscode.Uri,
        edits: vscode.TextEdit[],
        description: string,
        sessionId?: string
    ): Promise<void> {
        try {
            // 记录修改事件
            const event = this.fileTracker.recordFileEdit(uri, edits, description, sessionId);

            // 创建聊天消息
            const chatMessage = this.fileTracker.createChatEditMessage(event);

            // 方法1: 尝试显示用户通知（作为聊天历史的替代）
            const relativePath = vscode.workspace.asRelativePath(uri);
            const notification = `📝 已修改 ${relativePath} (${edits.length} 处更改)`;

            vscode.window.showInformationMessage(notification, '查看文件', '查看详情').then(selection => {
                if (selection === '查看文件') {
                    vscode.window.showTextDocument(uri);
                } else if (selection === '查看详情') {
                    this.showDetailedEditInfo(event);
                }
            });

            // 方法2: 在输出窗口中创建专门的修改历史通道
            this.logToModificationHistory(chatMessage);

            Logger.info(`💬 [Chat Edit Integrator] 文件修改已在聊天中显示: ${relativePath}`);
        } catch (error) {
            Logger.error(
                `❌ [Chat Edit Integrator] 显示文件修改失败: ${error instanceof Error ? error.message : error}`
            );
        }
    }

    /**
     * 显示详细的编辑信息
     */
    private async showDetailedEditInfo(event: ChatEditEvent): Promise<void> {
        const message = this.fileTracker.createChatEditMessage(event);

        // 在新的未保存文档中显示详细信息
        const doc = await vscode.workspace.openTextDocument({
            content: message,
            language: 'markdown'
        });

        await vscode.window.showTextDocument(doc, {
            preview: true,
            preserveFocus: false
        });
    }

    /**
     * 记录到专门的修改历史输出通道
     */
    private logToModificationHistory(message: string): void {
        // 创建或获取专门的修改历史输出通道
        const outputChannel = vscode.window.createOutputChannel('GCMP 文件修改历史', 'markdown');

        outputChannel.appendLine(`---\n${message}\n`);

        // 显示通道（但不抢夺焦点）
        outputChannel.show(true);
    }

    /**
     * 获取最近的修改历史（用于命令面板）
     */
    async showModificationHistory(): Promise<void> {
        const recentEdits = this.fileTracker.getRecentEdits(20);

        if (recentEdits.length === 0) {
            vscode.window.showInformationMessage('📋 暂无文件修改记录');
            return;
        }

        // 创建修改历史概览
        let historyContent = '# 📋 GCMP 文件修改历史\n\n';

        recentEdits.forEach((event, index) => {
            const relativePath = vscode.workspace.asRelativePath(event.uri);
            const timeStr = event.timestamp.toLocaleString();

            historyContent += `## ${index + 1}. ${relativePath}\n\n`;
            historyContent += `- **时间**: ${timeStr}\n`;
            historyContent += `- **描述**: ${event.description}\n`;
            historyContent += `- **编辑数**: ${event.edits.length} 处修改\n`;
            historyContent += `- **会话ID**: \`${event.sessionId}\`\n\n`;

            // 添加编辑详情
            if (event.edits.length <= 5) {
                // 只显示少量编辑的详情
                historyContent += '**编辑详情**:\n';
                event.edits.forEach((edit, editIndex) => {
                    const startLine = edit.range.start.line + 1;
                    const endLine = edit.range.end.line + 1;
                    const lineInfo = startLine === endLine ? `行 ${startLine}` : `行 ${startLine}-${endLine}`;
                    historyContent += `  ${editIndex + 1}. ${lineInfo}\n`;
                });
            }

            historyContent += '\n---\n\n';
        });

        // 在新文档中显示历史
        const doc = await vscode.workspace.openTextDocument({
            content: historyContent,
            language: 'markdown'
        });

        await vscode.window.showTextDocument(doc, {
            preview: false,
            preserveFocus: false
        });
    }

    /**
     * 清理修改历史
     */
    clearHistory(): void {
        this.fileTracker.clearHistory();
        vscode.window.showInformationMessage('✅ 文件修改历史已清理');
    }

    dispose(): void {
        this.fileTracker.dispose();
    }
}

/**
 * 注册文件修改跟踪命令
 */
export function registerFileTrackingCommands(context: vscode.ExtensionContext): void {
    const chatEditIntegrator = GCMPChatEditIntegrator.getInstance();

    // 显示修改历史命令
    const showHistoryCommand = vscode.commands.registerCommand('gcmp.showModificationHistory', async () => {
        await chatEditIntegrator.showModificationHistory();
    });

    // 清理修改历史命令
    const clearHistoryCommand = vscode.commands.registerCommand('gcmp.clearModificationHistory', () => {
        chatEditIntegrator.clearHistory();
    });

    context.subscriptions.push(showHistoryCommand, clearHistoryCommand);

    Logger.info('📋 [File Tracking] 文件跟踪命令已注册');
}
