/*---------------------------------------------------------------------------------------------
 *  Apply Diff V2 工具测试和演示
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { ApplyDiffToolV2 } from './apply-diff-v2';
import { Logger } from '../utils';

/**
 * 测试 Apply Diff V2 工具的功能
 */
/**
 * 创建空行处理测试用例
 */
async function createEmptyLineTestCase(): Promise<void> {
    try {
        const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
        if (!workspaceFolder) {
            vscode.window.showErrorMessage('需要打开一个工作区');
            return;
        }

        const testFilePath = vscode.Uri.joinPath(workspaceFolder.uri, 'test-empty-lines.js');

        // 创建包含空行的测试文件
        const testContent = `function testEmptyLines() {
    console.log('Line 1');

    console.log('Line 3');


    console.log('Line 6');
}

// 这个文件包含空行，用于测试空行处理`;

        const workspaceEdit = new vscode.WorkspaceEdit();
        workspaceEdit.createFile(testFilePath, { overwrite: true });
        workspaceEdit.insert(testFilePath, new vscode.Position(0, 0), testContent);

        const success = await vscode.workspace.applyEdit(workspaceEdit);
        if (success) {
            // 打开文件
            const document = await vscode.workspace.openTextDocument(testFilePath);
            await vscode.window.showTextDocument(document);

            vscode.window.showInformationMessage(
                '✅ 空行测试文件已创建。请现在使用 gcmp_applyDiffV2 工具测试空行处理功能。'
            );
        } else {
            vscode.window.showErrorMessage('❌ 创建测试文件失败');
        }

    } catch (error) {
        vscode.window.showErrorMessage(`❌ 创建空行测试失败: ${error instanceof Error ? error.message : error}`);
        Logger.error('创建空行测试失败', error instanceof Error ? error : undefined);
    }
}

export async function activateApplyDiffV2Demo(): Promise<void> {
    Logger.info('🧪 [测试] 开始测试 Apply Diff V2 工具');

    const tool = new ApplyDiffToolV2();

    try {
        // 测试案例 1: 简单的替换操作
        const testDiff1 = `
<<<<<<< SEARCH
:start_line:1
:end_line:1
-------
const version = '1.0.0';
=======
const version = '1.1.0';
>>>>>>> REPLACE`;

        const result1 = await tool.applyDiff({
            path: 'test-file.js',
            diff: testDiff1,
            preview: true
        });

        Logger.info(`📊 [测试] 测试案例 1 结果: ${result1.success ? '成功' : '失败'} - ${result1.message}`);

        // 测试案例 2: 插入操作
        const testDiff2 = `
<<<<<<< SEARCH
:start_line:1
:end_line:0
=======
// 新添加的注释
console.log('Hello World');
>>>>>>> REPLACE`;

        const result2 = await tool.applyDiff({
            path: 'test-file.js',
            diff: testDiff2,
            preview: true
        });

        Logger.info(`📊 [测试] 测试案例 2 结果: ${result2.success ? '成功' : '失败'} - ${result2.message}`);

        // 测试案例 3: 多块操作
        const testDiff3 = `
<<<<<<< SEARCH
:start_line:1
:end_line:1
-------
const version = '1.0.0';
=======
const version = '1.2.0';
>>>>>>> REPLACE
<<<<<<< SEARCH
:start_line:10
:end_line:12
-------
function oldFunction() {
    return 'old';
}
=======
function newFunction() {
    return 'new and improved';
}
>>>>>>> REPLACE`;

        const result3 = await tool.applyDiff({
            path: 'test-file.js',
            diff: testDiff3,
            preview: true
        });

        Logger.info(`📊 [测试] 测试案例 3 结果: ${result3.success ? '成功' : '失败'} - ${result3.message}`);

        Logger.info('✅ [测试] Apply Diff V2 工具测试完成');

    } catch (error) {
        Logger.error('❌ [测试] Apply Diff V2 工具测试失败', error instanceof Error ? error : undefined);
    } finally {
        tool.dispose();
    }
}

/**
 * 创建工具演示命令
 */
export function registerApplyDiffV2Demo(context: vscode.ExtensionContext) {
    const demoCommand = vscode.commands.registerCommand('gcmp.applyDiffV2.demo', async () => {
        try {
            await vscode.window.showInformationMessage(
                '🚀 Apply Diff V2 Demo\n\n' +
                '✨ 新特性:\n' +
                '• 聊天修改历史集成\n' +
                '• 智能内容匹配\n' +
                '• VS Code 原生预览\n' +
                '• 增强的错误处理\n' +
                '• 批量操作支持\n\n' +
                '📝 使用方法:\n' +
                '在聊天中使用 @gcmp_applyDiffV2 工具\n' +
                '提供包含 SEARCH/REPLACE 块的 diff 内容',
                { modal: false }
            );

            // 运行测试演示
            await createEmptyLineTestCase();

        } catch (error) {
            const errorMessage = error instanceof Error ? error.message : '未知错误';
            await vscode.window.showErrorMessage(`演示失败: ${errorMessage}`);
        }
    });

    context.subscriptions.push(demoCommand);
    Logger.info('✅ [命令] Apply Diff V2 演示命令已注册: gcmp.applyDiffV2.demo');
}

/**
 * 创建快速创建测试 diff 的命令
 */
export function registerCreateTestDiff(context: vscode.ExtensionContext) {
    const createTestCommand = vscode.commands.registerCommand('gcmp.applyDiffV2.createTest', async () => {
        try {
            const editor = vscode.window.activeTextEditor;
            if (!editor) {
                await vscode.window.showWarningMessage('请先打开一个文件');
                return;
            }

            const selection = editor.selection;
            const selectedText = editor.document.getText(selection);

            if (!selectedText) {
                await vscode.window.showWarningMessage('请先选择要修改的文本');
                return;
            }

            const startLine = selection.start.line + 1;
            const endLine = selection.end.line + 1;

            // 生成 diff 模板
            const diffTemplate = `
<<<<<<< SEARCH
:start_line:${startLine}
:end_line:${endLine}
-------
${selectedText}
=======
// 在这里输入替换后的内容
${selectedText}
>>>>>>> REPLACE`;

            // 创建新的未命名文档
            const newDoc = await vscode.workspace.openTextDocument({
                content: diffTemplate,
                language: 'diff'
            });

            await vscode.window.showTextDocument(newDoc);

            await vscode.window.showInformationMessage(
                '✅ 已生成 diff 模板\n\n' +
                '💡 使用说明:\n' +
                '1. 编辑 ======= 下方的替换内容\n' +
                '2. 在聊天中使用 @gcmp_applyDiffV2 工具\n' +
                '3. 将此 diff 内容作为参数传递'
            );

        } catch (error) {
            const errorMessage = error instanceof Error ? error.message : '未知错误';
            await vscode.window.showErrorMessage(`创建测试 diff 失败: ${errorMessage}`);
        }
    });

    context.subscriptions.push(createTestCommand);
    Logger.info('✅ [命令] 创建测试 diff 命令已注册: gcmp.applyDiffV2.createTest');
}