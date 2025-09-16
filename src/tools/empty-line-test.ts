/**
 * 空行处理测试工具
 * 用于验证 gcmp_applyDiffV2 工具的空行处理能力
 */

import * as vscode from 'vscode';
import { Logger } from '../utils';
import { DiffParserV2, EditEngineV2 } from './apply-diff-v2';

/**
 * 测试空行匹配功能
 */
export async function testEmptyLineMatching(): Promise<void> {
    let allMatch = false;
    try {
        const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
        if (!workspaceFolder) {
            throw new Error('需要打开一个工作区');
        }

        // 创建测试文件
        const testFile = vscode.Uri.joinPath(workspaceFolder.uri, 'empty-line-test.js');
        const testContent = `function test() {
    console.log('Line 1');

    console.log('Line 3');


    console.log('Line 6');
}`;

        // 写入测试文件
        const workspaceEdit = new vscode.WorkspaceEdit();
        workspaceEdit.createFile(testFile, { overwrite: true });
        workspaceEdit.insert(testFile, new vscode.Position(0, 0), testContent);
        await vscode.workspace.applyEdit(workspaceEdit);

        // 测试 diff 解析
        const testDiff = `<<<<<<< SEARCH
:start_line:2
:end_line:4
    console.log('Line 1');

    console.log('Line 3');
=======
    console.log('Line 1 - Modified');

    console.log('Line 3 - Modified');
>>>>>>> REPLACE`;

        const blocks = DiffParserV2.parseDiff(testDiff);
        Logger.info(`🧪 [Empty Line Test] 解析到 ${blocks.length} 个 diff 块`);

        if (blocks.length > 0) {
            const block = blocks[0];
            Logger.info(`🧪 [Empty Line Test] 块详情: 行${block.startLine}-${block.endLine}`);
            Logger.info(`🧪 [Empty Line Test] 搜索行数: ${block.searchLines.length}`);
            block.searchLines.forEach((line: string, index: number) => {
                Logger.info(`🧪 [Empty Line Test] 搜索行${index + 1}: "${line}" (长度:${line.length}, 空行:${line.trim() === ''})`);
            });

            // 测试匹配
            const editEngine = new EditEngineV2();
            const document = await vscode.workspace.openTextDocument(testFile);
            const fileLines = document.getText().split('\n');

            Logger.info(`🧪 [Empty Line Test] 文件行数: ${fileLines.length}`);
            fileLines.forEach((line: string, index: number) => {
                Logger.info(`🧪 [Empty Line Test] 文件行${index + 1}: "${line}" (长度:${line.length}, 空行:${line.trim() === ''})`);
            });

            // 验证匹配逻辑
            const startIdx = block.startLine - 1;
            const endIdx = block.endLine - 1;
            const fileSection = fileLines.slice(startIdx, endIdx + 1);

            Logger.info('🧪 [Empty Line Test] 开始匹配验证...');
            allMatch = true;
            for (let i = 0; i < Math.min(fileSection.length, block.searchLines.length); i++) {
                const fileLine = fileSection[i];
                const searchLine = block.searchLines[i];
                const matches = editEngine.linesMatch(fileLine, searchLine);
                Logger.info(`🧪 [Empty Line Test] 行${i + 1} 匹配: ${matches ? '✅' : '❌'}`);
                Logger.info(`🧪 [Empty Line Test]   文件: "${fileLine}"`);
                Logger.info(`🧪 [Empty Line Test]   搜索: "${searchLine}"`);
                if (!matches) {
                    allMatch = false;
                }
            }

            Logger.info(`🧪 [Empty Line Test] 总体匹配结果: ${allMatch ? '✅ 成功' : '❌ 失败'}`);
        }

        // 显示结果
        const result = allMatch ? '✅ 空行处理测试通过' : '❌ 空行处理测试失败';
        vscode.window.showInformationMessage(result);

        // 打开测试文件
        const document = await vscode.workspace.openTextDocument(testFile);
        await vscode.window.showTextDocument(document);

    } catch (error) {
        const errorMsg = `❌ 空行测试失败: ${error instanceof Error ? error.message : error}`;
        Logger.error(errorMsg, error instanceof Error ? error : undefined);
        vscode.window.showErrorMessage(errorMsg);
    }
}

/**
 * 注册空行测试命令
 */
export function registerEmptyLineTestCommand(context: vscode.ExtensionContext): void {
    const testCommand = vscode.commands.registerCommand(
        'gcmp.applyDiffV2.testEmptyLines',
        testEmptyLineMatching
    );

    context.subscriptions.push(testCommand);
    Logger.debug('✅ [Demo] 空行测试命令已注册: gcmp.applyDiffV2.testEmptyLines');
}