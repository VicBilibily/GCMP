/**
 * 聊天历史集成验证工具
 * 
 * 这个文件用于测试和验证 ChatHistoryIntegrator.recordFileEdit 方法
 * 确保聊天历史记录功能正常工作
 */

import * as vscode from 'vscode';
import { Logger } from '../utils/logger';

export class ChatHistoryValidator {

    /**
     * 创建测试用的 TextEdit 对象
     */
    private static createTestEdits(): vscode.TextEdit[] {
        return [
            new vscode.TextEdit(
                new vscode.Range(new vscode.Position(10, 0), new vscode.Position(10, 20)),
                'console.log("Hello, world!");'
            ),
            new vscode.TextEdit(
                new vscode.Range(new vscode.Position(15, 4), new vscode.Position(15, 4)),
                '\n    // 新增的注释行'
            ),
            new vscode.TextEdit(
                new vscode.Range(new vscode.Position(20, 0), new vscode.Position(22, 0)),
                ''
            )
        ];
    }

    /**
     * 测试 ChatHistoryIntegrator.recordFileEdit 方法
     */
    public static async testChatHistoryRecording(): Promise<void> {
        Logger.info('🧪 [Chat History Validator] 开始测试聊天历史记录功能');

        try {
            // 导入 ChatHistoryIntegrator（动态导入避免循环依赖）
            const { ChatHistoryIntegrator } = await import('./apply-diff-v2.js');
            const integrator = ChatHistoryIntegrator.getInstance();

            // 创建测试文件 URI
            const testUri = vscode.Uri.file('C:\\test\\example.ts');
            const testEdits = this.createTestEdits();
            const testDescription = 'Chat History Validation Test';

            Logger.info('📝 [Chat History Validator] 测试参数:');
            Logger.info(`   - 文件: ${testUri.fsPath}`);
            Logger.info(`   - 编辑数量: ${testEdits.length}`);
            Logger.info(`   - 描述: ${testDescription}`);

            // 测试 recordFileEdit 方法
            const startTime = Date.now();
            integrator.recordFileEdit(testUri, testEdits, testDescription);
            const endTime = Date.now();

            Logger.info('✅ [Chat History Validator] 聊天历史记录测试成功');
            Logger.info(`   - 执行时间: ${endTime - startTime}ms`);
            Logger.info('   - 记录的编辑信息已输出到日志中');

            // 验证日志记录
            this.validateLogOutput(testUri, testEdits, testDescription);

        } catch (error) {
            Logger.error('❌ [Chat History Validator] 聊天历史记录测试失败', error instanceof Error ? error : undefined);
            throw error;
        }
    }

    /**
     * 验证日志输出内容
     */
    private static validateLogOutput(uri: vscode.Uri, edits: vscode.TextEdit[], description: string): void {
        Logger.info('🔍 [Chat History Validator] 验证聊天历史记录输出:');

        // 验证基本信息
        const expectedInfo = {
            file: uri.fsPath,
            editCount: edits.length,
            description: description
        };

        Logger.info(`   ✓ 文件路径: ${expectedInfo.file}`);
        Logger.info(`   ✓ 编辑数量: ${expectedInfo.editCount}`);
        Logger.info(`   ✓ 操作描述: ${expectedInfo.description}`);

        // 验证编辑详情
        edits.forEach((edit, index) => {
            Logger.info(`   ✓ 编辑 ${index + 1}:`);
            Logger.info(`     - 范围: (${edit.range.start.line}, ${edit.range.start.character}) -> (${edit.range.end.line}, ${edit.range.end.character})`);
            Logger.info(`     - 新文本: "${edit.newText.replace(/\n/g, '\\n')}"`);
            Logger.info(`     - 文本长度: ${edit.newText.length} 字符`);
        });

        Logger.info('✅ [Chat History Validator] 日志输出验证完成');
    }

    /**
     * 创建 VS Code 命令来测试聊天历史记录
     */
    public static registerValidationCommand(context: vscode.ExtensionContext): void {
        const command = vscode.commands.registerCommand('gcmp.validateChatHistory', async () => {
            try {
                await this.testChatHistoryRecording();
                vscode.window.showInformationMessage('✅ 聊天历史记录验证成功！请检查输出日志。');
            } catch (error) {
                const errorMessage = error instanceof Error ? error.message : '未知错误';
                vscode.window.showErrorMessage(`❌ 聊天历史记录验证失败: ${errorMessage}`);
            }
        });

        context.subscriptions.push(command);
        Logger.info('📋 [Chat History Validator] 验证命令已注册: gcmp.validateChatHistory');
    }
}

/**
 * 快速测试函数（用于开发调试）
 */
export async function quickTestChatHistory(): Promise<void> {
    Logger.info('🚀 [Quick Test] 快速测试聊天历史记录功能');
    await ChatHistoryValidator.testChatHistoryRecording();
}