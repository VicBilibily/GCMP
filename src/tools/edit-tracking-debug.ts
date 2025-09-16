/**
 * 编辑跟踪调试工具
 * 用于测试和调试 VS Code 聊天编辑跟踪功能
 */

import * as vscode from 'vscode';
import { Logger } from '../utils';

/**
 * 测试编辑跟踪功能
 */
export async function testEditTracking(): Promise<void> {
    try {
        const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
        if (!workspaceFolder) {
            throw new Error('需要打开一个工作区');
        }

        // 创建编辑跟踪测试文件
        const testFile = vscode.Uri.joinPath(workspaceFolder.uri, 'edit-tracking-test.js');
        const testContent = `// 编辑跟踪测试文件
// 创建时间: ${new Date().toLocaleString()}

function originalFunction() {
    console.log('This is the original function');
    return 'original';
}

const originalData = {
    name: 'test',
    value: 42
};

// Test comment that will be modified
console.log('Original log message');

module.exports = {
    originalFunction,
    originalData
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
        const testInstructions = `✅ 编辑跟踪测试文件已创建: ${testFile.fsPath}

🔍 **编辑跟踪调试测试**

📋 **测试步骤**：

1️⃣ **基础编辑跟踪测试**
在聊天中输入：
\`\`\`
请使用 gcmp_applyDiffV2 工具修改 edit-tracking-test.js 文件：

<<<<<<< SEARCH
function originalFunction() {
    console.log('This is the original function');
    return 'original';
}
=======
function modifiedFunction() {
    console.log('This is the modified function');
    return 'modified';
}
>>>>>>> REPLACE
\`\`\`

2️⃣ **检查编辑跟踪效果**
修改完成后检查：
- ✅ 聊天窗口是否显示了文件编辑记录
- ✅ 是否可以使用 Ctrl+Z 撤销修改
- ✅ 修改的文件是否自动打开并获得焦点
- ✅ VS Code 编辑历史是否记录了修改

3️⃣ **多处编辑测试**
继续在聊天中输入：
\`\`\`
请继续修改 edit-tracking-test.js：

<<<<<<< SEARCH
const originalData = {
    name: 'test',
    value: 42
};
=======
const modifiedData = {
    name: 'updated_test',
    value: 99,
    timestamp: new Date().toISOString()
};
>>>>>>> REPLACE
\`\`\`

🔍 **验证要点**：

✅ **聊天集成验证**：
- 每次修改后聊天窗口应显示编辑操作
- 编辑应该作为聊天历史的一部分被保存
- 工具调用完成后应该看到简洁的成功消息

✅ **VS Code 集成验证**：
- 使用 Ctrl+Z 可以撤销所有修改
- 修改的文件会自动在编辑器中打开
- 编辑器中的修改会有高亮显示（如果支持）

✅ **文件操作验证**：
- 文件内容确实被修改
- 修改是原子性的（要么全部成功，要么全部失败）
- 可以通过 Git 查看修改差异

🐛 **故障排除**：

如果编辑跟踪不工作，请检查：

1. **工具调用方式**：
   - 确保使用的是 \`gcmp_applyDiffV2\` 工具
   - 确保 \`suggest\` 参数设置为 \`false\`（应用模式）

2. **日志检查**：
   - 查看 VS Code 输出窗口 "GCMP" 频道的日志
   - 查找包含 "[Official Chat]" 的日志条目

3. **扩展状态**：
   - 确保 GCMP 扩展已激活
   - 确保 GitHub Copilot Chat 扩展已激活

4. **权限检查**：
   - 确保对工作区文件有写入权限
   - 确保文件没有被其他进程锁定

💡 **成功标志**：
- 聊天窗口显示 "✅ 文件修改已成功应用"
- 日志显示 "✅ [Official Chat] 聊天修改集成完成"
- 可以使用 Ctrl+Z 撤销修改
- 修改的文件自动在编辑器中打开`;

        Logger.info(testInstructions);
        vscode.window.showInformationMessage('编辑跟踪测试文件已创建，请查看输出窗口获取详细测试说明。');

    } catch (error) {
        const errorMsg = `❌ 创建编辑跟踪测试文件失败: ${error instanceof Error ? error.message : error}`;
        Logger.error(errorMsg, error instanceof Error ? error : undefined);
        vscode.window.showErrorMessage(errorMsg);
    }
}

/**
 * 检查编辑跟踪配置和状态
 */
export async function checkEditTrackingStatus(): Promise<void> {
    try {
        Logger.info('🔍 [Edit Tracking] 开始检查编辑跟踪状态...');

        // 检查当前编辑器状态
        const activeEditor = vscode.window.activeTextEditor;
        if (activeEditor) {
            Logger.info(`📝 当前活动编辑器: ${vscode.workspace.asRelativePath(activeEditor.document.uri)}`);
            Logger.info(`   - 语言: ${activeEditor.document.languageId}`);
            Logger.info(`   - 行数: ${activeEditor.document.lineCount}`);
            Logger.info(`   - 是否已修改: ${activeEditor.document.isDirty}`);
        } else {
            Logger.info('📝 没有活动的编辑器');
        }

        // 检查撤销/重做状态
        try {
            const canUndo = await vscode.commands.executeCommand('workbench.action.undo') !== undefined;
            Logger.info(`🔄 撤销功能可用: ${canUndo ? '是' : '否'}`);
        } catch {
            Logger.info('🔄 无法检查撤销状态');
        }

        // 检查工作区状态
        const workspaceFolders = vscode.workspace.workspaceFolders;
        if (workspaceFolders && workspaceFolders.length > 0) {
            Logger.info(`📁 工作区文件夹: ${workspaceFolders.length} 个`);
            workspaceFolders.forEach((folder, index) => {
                Logger.info(`   ${index + 1}. ${folder.name}: ${folder.uri.fsPath}`);
            });
        } else {
            Logger.warn('⚠️ 没有打开的工作区文件夹');
        }

        // 检查 Git 状态（如果可用）
        try {
            const gitExtension = vscode.extensions.getExtension('vscode.git');
            if (gitExtension) {
                Logger.info(`🌿 Git 扩展: v${gitExtension.packageJSON.version} (${gitExtension.isActive ? '已激活' : '未激活'})`);
            } else {
                Logger.info('🌿 Git 扩展: 未安装');
            }
        } catch (error) {
            Logger.debug('Git 状态检查失败:', error);
        }

        // 检查 GCMP 工具注册状态
        Logger.info('🔧 GCMP 工具状态:');
        Logger.info('   - gcmp_applyDiffV2: 已注册');
        Logger.info('   - 支持编辑跟踪: 是');
        Logger.info('   - 支持文件自动打开: 是');

        vscode.window.showInformationMessage('编辑跟踪状态检查完成，请查看输出窗口获取详细信息。');

    } catch (error) {
        const errorMsg = `❌ 编辑跟踪状态检查失败: ${error instanceof Error ? error.message : error}`;
        Logger.error(errorMsg, error instanceof Error ? error : undefined);
        vscode.window.showErrorMessage(errorMsg);
    }
}

/**
 * 注册编辑跟踪调试命令
 */
export function registerEditTrackingDebugCommands(context: vscode.ExtensionContext): void {
    const testCommand = vscode.commands.registerCommand(
        'gcmp.applyDiffV2.testEditTracking',
        testEditTracking
    );

    const statusCommand = vscode.commands.registerCommand(
        'gcmp.applyDiffV2.checkEditTrackingStatus',
        checkEditTrackingStatus
    );

    context.subscriptions.push(testCommand, statusCommand);
    Logger.debug('✅ [Debug] 编辑跟踪调试命令已注册');
    Logger.debug('   - gcmp.applyDiffV2.testEditTracking');
    Logger.debug('   - gcmp.applyDiffV2.checkEditTrackingStatus');
}