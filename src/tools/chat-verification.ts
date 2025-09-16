/**
 * 聊天集成验证工具
 * 用于测试 gcmp_applyDiffV2 工具的聊天修改集成是否工作正常
 */

import * as vscode from 'vscode';
import { Logger } from '../utils';

/**
 * 创建聊天集成验证测试文件
 */
export async function createChatIntegrationVerificationFile(): Promise<void> {
    try {
        const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
        if (!workspaceFolder) {
            throw new Error('需要打开一个工作区');
        }

        // 创建验证测试文件
        const testFile = vscode.Uri.joinPath(workspaceFolder.uri, 'chat-integration-verification.js');
        const testContent = `// 聊天修改集成验证文件
// 测试时间: ${new Date().toLocaleString()}

function oldFunction() {
    console.log('这是旧的实现');
    return 'old_result';
}

function anotherOldFunction(param) {
    if (param) {
        console.log('old conditional logic');
    }
    return param + '_old';
}

// 待修改的空行测试区域
function emptyLineTest() {
    console.log('line 1');

    console.log('line 3');


    console.log('line 6');
}

const config = {
    version: '1.0.0',
    environment: 'development'
};

module.exports = {
    oldFunction,
    anotherOldFunction,
    emptyLineTest,
    config
};`;

        // 写入测试文件
        const workspaceEdit = new vscode.WorkspaceEdit();
        workspaceEdit.createFile(testFile, { overwrite: true });
        workspaceEdit.insert(testFile, new vscode.Position(0, 0), testContent);
        await vscode.workspace.applyEdit(workspaceEdit);

        // 打开测试文件
        const document = await vscode.workspace.openTextDocument(testFile);
        await vscode.window.showTextDocument(document);

        // 显示测试说明
        const testInstructions = `✅ 聊天集成验证文件已创建: ${testFile.fsPath}

🧪 聊天修改集成验证步骤：

1️⃣ **基础修改测试**
在聊天中使用以下 diff：
\`\`\`
<<<<<<< SEARCH
function oldFunction() {
    console.log('这是旧的实现');
    return 'old_result';
}
=======
function newFunction() {
    console.log('这是新的实现');
    return 'new_result';
}
>>>>>>> REPLACE
\`\`\`

2️⃣ **空行处理验证**
在聊天中使用以下 diff：
\`\`\`
<<<<<<< SEARCH
function emptyLineTest() {
    console.log('line 1');

    console.log('line 3');


    console.log('line 6');
}
=======
function emptyLineTest() {
    console.log('line 1 - updated');

    console.log('line 3 - updated');


    console.log('line 6 - updated');
}
>>>>>>> REPLACE
\`\`\`

3️⃣ **多行修改测试**
在聊天中使用以下 diff：
\`\`\`
<<<<<<< SEARCH
const config = {
    version: '1.0.0',
    environment: 'development'
};
=======
const config = {
    version: '2.0.0',
    environment: 'production',
    features: ['ai', 'chat', 'editing']
};
>>>>>>> REPLACE
\`\`\`

🔍 **验证要点**：

✅ **聊天历史集成检查**：
- 修改后在聊天窗口中应该看到文件编辑记录
- 修改应该出现在 VS Code 的编辑历史中
- 可以使用 Ctrl+Z 撤销修改

✅ **文件自动打开**：
- 工具调用完成后文件应该自动在编辑器中打开
- 修改的内容应该高亮显示

✅ **工具结果简化**：
- 工具返回的结果应该简洁明了
- 显示修改的文件列表和修改数量

💡 **故障排除**：
如果聊天集成未生效，请检查：
- 是否使用的是 gcmp_applyDiffV2 工具
- 确保 suggest 参数设置为 false（应用模式）
- 查看输出窗口的日志信息`;

        Logger.info(testInstructions);
        vscode.window.showInformationMessage('聊天集成验证文件已创建，请查看输出窗口获取详细测试说明。');

    } catch (error) {
        const errorMsg = `❌ 创建聊天集成验证文件失败: ${error instanceof Error ? error.message : error}`;
        Logger.error(errorMsg, error instanceof Error ? error : undefined);
        vscode.window.showErrorMessage(errorMsg);
    }
}

/**
 * 检查聊天扩展状态和兼容性
 */
export async function checkChatCompatibility(): Promise<void> {
    try {
        Logger.info('🔍 [Chat Compatibility] 开始检查聊天扩展兼容性...');

        // 检查 GitHub Copilot Chat 扩展
        const copilotChatExt = vscode.extensions.getExtension('GitHub.copilot-chat');
        if (copilotChatExt) {
            Logger.info(`✅ GitHub Copilot Chat: v${copilotChatExt.packageJSON.version} (${copilotChatExt.isActive ? '已激活' : '未激活'})`);
        } else {
            Logger.warn('⚠️ 未检测到 GitHub Copilot Chat 扩展');
        }

        // 检查 GitHub Copilot 扩展
        const copilotExt = vscode.extensions.getExtension('GitHub.copilot');
        if (copilotExt) {
            Logger.info(`✅ GitHub Copilot: v${copilotExt.packageJSON.version} (${copilotExt.isActive ? '已激活' : '未激活'})`);
        } else {
            Logger.warn('⚠️ 未检测到 GitHub Copilot 扩展');
        }

        // 检查语言模型可用性
        try {
            const models = await vscode.lm.selectChatModels();
            Logger.info(`🤖 可用语言模型: ${models.length} 个`);
            models.forEach((model, index) => {
                Logger.info(`   ${index + 1}. ${model.name} (family: ${model.family})`);
            });
        } catch (error) {
            Logger.warn('⚠️ 无法获取语言模型列表:', error);
        }

        // 检查当前工作区
        const workspaceFolders = vscode.workspace.workspaceFolders;
        if (workspaceFolders && workspaceFolders.length > 0) {
            Logger.info(`📁 工作区: ${workspaceFolders[0].name} (${workspaceFolders.length} 个文件夹)`);
        } else {
            Logger.warn('⚠️ 没有打开的工作区文件夹');
        }

        // 检查 GCMP 扩展状态
        const gcmpExt = vscode.extensions.getExtension('your-publisher.gcmp');
        Logger.info(`🔧 GCMP 扩展状态: ${gcmpExt ? (gcmpExt.isActive ? '已激活' : '未激活') : '未找到'}`);

        vscode.window.showInformationMessage('聊天兼容性检查完成，请查看输出窗口获取详细信息。');

    } catch (error) {
        const errorMsg = `❌ 聊天兼容性检查失败: ${error instanceof Error ? error.message : error}`;
        Logger.error(errorMsg, error instanceof Error ? error : undefined);
        vscode.window.showErrorMessage(errorMsg);
    }
}

/**
 * 注册聊天集成验证命令
 */
export function registerChatIntegrationVerificationCommands(context: vscode.ExtensionContext): void {
    const createTestCommand = vscode.commands.registerCommand(
        'gcmp.applyDiffV2.createChatVerificationFile',
        createChatIntegrationVerificationFile
    );

    const checkCompatibilityCommand = vscode.commands.registerCommand(
        'gcmp.applyDiffV2.checkChatCompatibility',
        checkChatCompatibility
    );

    context.subscriptions.push(createTestCommand, checkCompatibilityCommand);
    Logger.debug('✅ [Demo] 聊天集成验证命令已注册');
    Logger.debug('   - gcmp.applyDiffV2.createChatVerificationFile');
    Logger.debug('   - gcmp.applyDiffV2.checkChatCompatibility');
}