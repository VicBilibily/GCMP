/**
 * 聊天修改集成测试工具
 * 用于验证 gcmp_applyDiffV2 工具的聊天历史集成功能
 */

import * as vscode from 'vscode';
import { Logger } from '../utils';

/**
 * 测试聊天修改集成功能
 */
export async function testChatIntegration(): Promise<void> {
    try {
        const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
        if (!workspaceFolder) {
            throw new Error('需要打开一个工作区');
        }

        // 创建测试文件
        const testFile = vscode.Uri.joinPath(workspaceFolder.uri, 'chat-integration-test.js');
        const originalContent = `// 聊天修改集成测试文件
function greet(name) {
    console.log('Hello, ' + name + '!');
}

function farewell(name) {
    console.log('Goodbye, ' + name + '!');
}

// 调用函数
greet('World');
farewell('World');`;

        // 写入测试文件
        const workspaceEdit = new vscode.WorkspaceEdit();
        workspaceEdit.createFile(testFile, { overwrite: true });
        workspaceEdit.insert(testFile, new vscode.Position(0, 0), originalContent);
        await vscode.workspace.applyEdit(workspaceEdit);

        // 打开测试文件
        const document = await vscode.workspace.openTextDocument(testFile);
        await vscode.window.showTextDocument(document);

        // 显示测试说明
        const testMessage = `✅ 聊天集成测试文件已创建: ${testFile.fsPath}

📋 测试步骤:
1. 在聊天窗口中使用 gcmp_applyDiffV2 工具修改此文件
2. 检查修改是否出现在聊天历史中
3. 验证编辑操作是否可以撤销/重做
4. 确认文件修改被正确跟踪

💡 建议测试 diff:
\`\`\`
<<<<<<< SEARCH
function greet(name) {
    console.log('Hello, ' + name + '!');
}
=======
function greet(name) {
    console.log(\`Hello, \${name}!\`);
}
>>>>>>> REPLACE
\`\`\`

🔍 预期结果:
- 聊天窗口显示应用的修改差异
- VS Code 编辑器显示修改高亮
- 可以使用 Ctrl+Z 撤销修改
- 文件修改历史被正确记录`;

        vscode.window.showInformationMessage('聊天集成测试文件已准备就绪，请查看输出窗口获取详细说明。');
        Logger.info(testMessage);

        // 可选：尝试获取聊天相关的API信息
        try {
            const chatExtension = vscode.extensions.getExtension('GitHub.copilot-chat');
            if (chatExtension) {
                Logger.info(`📡 检测到 GitHub Copilot Chat 扩展: v${chatExtension.packageJSON.version}`);
            } else {
                Logger.warn('⚠️ 未检测到 GitHub Copilot Chat 扩展');
            }
        } catch (error) {
            Logger.debug('聊天扩展检测失败:', error);
        }

    } catch (error) {
        const errorMsg = `❌ 聊天集成测试失败: ${error instanceof Error ? error.message : error}`;
        Logger.error(errorMsg, error instanceof Error ? error : undefined);
        vscode.window.showErrorMessage(errorMsg);
    }
}

/**
 * 分析聊天集成状态
 */
export async function analyzeChatIntegrationStatus(): Promise<void> {
    try {
        Logger.info('🔍 [Chat Integration] 开始分析聊天集成状态...');

        // 检查可用的语言模型
        try {
            const models = await vscode.lm.selectChatModels();
            Logger.info(`🤖 可用语言模型数量: ${models.length}`);
            models.forEach((model, index) => {
                Logger.info(`   ${index + 1}. ${model.name} (family: ${model.family})`);
            });
        } catch (error) {
            Logger.warn('无法获取语言模型列表:', error);
        }

        // 检查工具注册状态
        try {
            // 这里我们无法直接访问已注册的工具，但可以记录预期状态
            Logger.info('🔧 预期注册的工具:');
            Logger.info('   - gcmp_applyDiffV2 (Apply Diff V2)');
            Logger.info('   - gcmp_zhipuSearch (智谱搜索)');
        } catch (error) {
            Logger.warn('工具状态检查失败:', error);
        }

        // 检查扩展状态
        const gcmpExtension = vscode.extensions.getExtension('your-publisher.gcmp');
        if (gcmpExtension) {
            Logger.info(`✅ GCMP 扩展状态: ${gcmpExtension.isActive ? '已激活' : '未激活'}`);
        }

        // 检查聊天相关扩展
        const chatExtensions = [
            'GitHub.copilot-chat',
            'GitHub.copilot',
            'ms-vscode.vscode-chat'
        ];

        for (const extId of chatExtensions) {
            const ext = vscode.extensions.getExtension(extId);
            if (ext) {
                Logger.info(`✅ 检测到扩展: ${extId} v${ext.packageJSON.version} (${ext.isActive ? '已激活' : '未激活'})`);
            } else {
                Logger.info(`❌ 未检测到扩展: ${extId}`);
            }
        }

        vscode.window.showInformationMessage('聊天集成状态分析完成，请查看输出窗口获取详细信息。');

    } catch (error) {
        const errorMsg = `❌ 聊天集成状态分析失败: ${error instanceof Error ? error.message : error}`;
        Logger.error(errorMsg, error instanceof Error ? error : undefined);
        vscode.window.showErrorMessage(errorMsg);
    }
}

/**
 * 注册聊天集成测试命令
 */
export function registerChatIntegrationTestCommands(context: vscode.ExtensionContext): void {
    const testCommand = vscode.commands.registerCommand(
        'gcmp.applyDiffV2.testChatIntegration',
        testChatIntegration
    );

    const analyzeCommand = vscode.commands.registerCommand(
        'gcmp.applyDiffV2.analyzeChatStatus',
        analyzeChatIntegrationStatus
    );

    context.subscriptions.push(testCommand, analyzeCommand);
    Logger.debug('✅ [Demo] 聊天集成测试命令已注册');
    Logger.debug('   - gcmp.applyDiffV2.testChatIntegration');
    Logger.debug('   - gcmp.applyDiffV2.analyzeChatStatus');
}