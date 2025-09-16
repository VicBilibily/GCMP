/*---------------------------------------------------------------------------------------------
 *  聊天 Diff 集成
 *  整合不同的聊天编辑模式
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { Logger } from '../utils';
import { ChatExtendedDiffHandler, activateChatExtendedDiffHandler } from './chat-extended-diff-handler';

/**
 * 聊天 Diff 集成管理器
 */
export class ChatDiffIntegration {
    private extendedHandler: ChatExtendedDiffHandler | undefined;

    /**
     * 激活聊天 Diff 功能
     */
    activate(context: vscode.ExtensionContext): void {
        Logger.info('🎭 [Chat Diff Integration] 开始激活聊天编辑功能...');

        try {
            // 激活 ChatExtendedRequestHandler 模式
            this.extendedHandler = activateChatExtendedDiffHandler(context);
            Logger.info('✅ [Chat Diff Integration] ChatExtendedRequestHandler 模式已激活');

            // 注册相关命令
            this.registerCommands(context);

            Logger.info('🎉 [Chat Diff Integration] 聊天编辑功能激活完成');

        } catch (error) {
            Logger.error('❌ [Chat Diff Integration] 激活失败', error instanceof Error ? error : undefined);
        }
    }

    /**
     * 注册相关命令
     */
    private registerCommands(context: vscode.ExtensionContext): void {
        // 帮助命令
        const helpCommand = vscode.commands.registerCommand('gcmp.diffHelp', () => {
            vscode.window.showInformationMessage(
                '使用 @gcmp.diffExtended 开始聊天编辑。支持 SEARCH/REPLACE 格式的 diff。',
                '了解更多'
            ).then(selection => {
                if (selection === '了解更多') {
                    vscode.env.openExternal(vscode.Uri.parse('https://github.com/VicBilibily/GCMP'));
                }
            });
        });

        // 应用所有建议命令
        const applyAllCommand = vscode.commands.registerCommand('gcmp.applyAllSuggestions', async () => {
            // 这里可以实现应用所有当前建议的逻辑
            vscode.window.showInformationMessage('应用所有建议功能将在后续版本中实现');
        });

        context.subscriptions.push(helpCommand, applyAllCommand);
    }

    /**
     * 释放资源
     */
    dispose(): void {
        if (this.extendedHandler) {
            this.extendedHandler.dispose();
            Logger.info('🎭 [Chat Diff Integration] 资源已释放');
        }
    }
}

/**
 * 激活聊天 Diff 集成
 */
export function activateChatDiffIntegration(context: vscode.ExtensionContext): ChatDiffIntegration {
    const integration = new ChatDiffIntegration();
    integration.activate(context);
    return integration;
}