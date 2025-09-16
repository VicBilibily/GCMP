/*---------------------------------------------------------------------------------------------
 *  Apply Diff Command 和 VSCode 集成
 *  提供命令接口和用户交互功能
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { ApplyDiffTool, ApplyDiffRequest } from './apply-diff';
import { Logger } from '../utils';

/**
 * Apply Diff VSCode 集成管理器
 */
export class ApplyDiffCommands {
    private applyDiffTool: ApplyDiffTool;

    constructor() {
        this.applyDiffTool = new ApplyDiffTool();
    }

    /**
     * 注册所有命令
     */
    registerCommands(context: vscode.ExtensionContext): void {
        // 注册应用diff命令
        const applyDiffCommand = vscode.commands.registerCommand(
            'gcmp.applyDiff',
            this.handleApplyDiffCommand.bind(this)
        );

        // 注册预览diff命令
        const previewDiffCommand = vscode.commands.registerCommand(
            'gcmp.previewDiff',
            this.handlePreviewDiffCommand.bind(this)
        );

        // 注册从剪贴板应用diff命令
        const applyDiffFromClipboardCommand = vscode.commands.registerCommand(
            'gcmp.applyDiffFromClipboard',
            this.handleApplyDiffFromClipboardCommand.bind(this)
        );

        context.subscriptions.push(
            applyDiffCommand,
            previewDiffCommand,
            applyDiffFromClipboardCommand
        );

        Logger.info('✅ [Apply Diff] 已注册VSCode命令');
    }

    /**
     * 处理应用diff命令
     */
    private async handleApplyDiffCommand(): Promise<void> {
        try {
            // 获取文件路径
            const filePath = await this.getTargetFilePath();
            if (!filePath) {
                return;
            }

            // 获取diff内容
            const diffContent = await this.getDiffContent();
            if (!diffContent) {
                return;
            }

            // 创建请求
            const request: ApplyDiffRequest = {
                path: filePath,
                diff: diffContent,
                preview: false
            };

            // 应用diff
            const result = await this.applyDiffTool.applyDiff(request);

            if (result.success) {
                vscode.window.showInformationMessage(
                    `✅ ${result.message}`,
                    '查看文件'
                ).then(action => {
                    if (action === '查看文件') {
                        vscode.commands.executeCommand('vscode.open', vscode.Uri.file(filePath));
                    }
                });
            } else {
                vscode.window.showErrorMessage(`❌ ${result.message}`);
            }

        } catch (error) {
            const errorMessage = error instanceof Error ? error.message : '未知错误';
            vscode.window.showErrorMessage(`应用diff失败: ${errorMessage}`);
            Logger.error('❌ [Apply Diff Command] 处理命令失败', error instanceof Error ? error : undefined);
        }
    }

    /**
     * 处理预览diff命令
     */
    private async handlePreviewDiffCommand(): Promise<void> {
        try {
            // 获取文件路径
            const filePath = await this.getTargetFilePath();
            if (!filePath) {
                return;
            }

            // 获取diff内容
            const diffContent = await this.getDiffContent();
            if (!diffContent) {
                return;
            }

            // 创建预览请求
            const request: ApplyDiffRequest = {
                path: filePath,
                diff: diffContent,
                preview: true
            };

            // 生成预览
            const result = await this.applyDiffTool.applyDiff(request);

            if (result.success && result.preview) {
                await this.showDiffPreview(filePath, result.originalContent || '', result.modifiedContent || '');
            } else {
                vscode.window.showErrorMessage(`❌ ${result.message}`);
            }

        } catch (error) {
            const errorMessage = error instanceof Error ? error.message : '未知错误';
            vscode.window.showErrorMessage(`预览diff失败: ${errorMessage}`);
            Logger.error('❌ [Apply Diff Command] 预览失败', error instanceof Error ? error : undefined);
        }
    }

    /**
     * 处理从剪贴板应用diff命令
     */
    private async handleApplyDiffFromClipboardCommand(): Promise<void> {
        try {
            // 获取文件路径
            const filePath = await this.getTargetFilePath();
            if (!filePath) {
                return;
            }

            // 从剪贴板读取diff内容
            const diffContent = await vscode.env.clipboard.readText();
            if (!diffContent.trim()) {
                vscode.window.showWarningMessage('剪贴板中没有内容');
                return;
            }

            // 创建请求
            const request: ApplyDiffRequest = {
                path: filePath,
                diff: diffContent,
                preview: false
            };

            // 应用diff
            const result = await this.applyDiffTool.applyDiff(request);

            if (result.success) {
                vscode.window.showInformationMessage(
                    `✅ ${result.message}`,
                    '查看文件'
                ).then(action => {
                    if (action === '查看文件') {
                        vscode.commands.executeCommand('vscode.open', vscode.Uri.file(filePath));
                    }
                });
            } else {
                vscode.window.showErrorMessage(`❌ ${result.message}`);
            }

        } catch (error) {
            const errorMessage = error instanceof Error ? error.message : '未知错误';
            vscode.window.showErrorMessage(`从剪贴板应用diff失败: ${errorMessage}`);
            Logger.error('❌ [Apply Diff Command] 从剪贴板应用失败', error instanceof Error ? error : undefined);
        }
    }

    /**
     * 获取目标文件路径
     */
    private async getTargetFilePath(): Promise<string | undefined> {
        // 首先尝试从当前编辑器获取文件路径
        const activeEditor = vscode.window.activeTextEditor;
        if (activeEditor && activeEditor.document.uri.scheme === 'file') {
            const useCurrentFile = await vscode.window.showQuickPick(
                ['使用当前文件', '选择其他文件'],
                { placeHolder: `当前文件: ${activeEditor.document.fileName}` }
            );

            if (useCurrentFile === '使用当前文件') {
                return activeEditor.document.uri.fsPath;
            }
        }

        // 让用户选择文件
        const fileUri = await vscode.window.showOpenDialog({
            canSelectFiles: true,
            canSelectFolders: false,
            canSelectMany: false,
            title: '选择要应用diff的文件'
        });

        return fileUri?.[0]?.fsPath;
    }

    /**
     * 获取diff内容
     */
    private async getDiffContent(): Promise<string | undefined> {
        const diffContent = await vscode.window.showInputBox({
            title: '输入diff内容',
            prompt: '请输入符合格式的diff内容',
            placeHolder: '可以粘贴完整的diff块...',
            value: '',
            ignoreFocusOut: true
        });

        return diffContent?.trim();
    }

    /**
     * 显示diff预览
     */
    private async showDiffPreview(filePath: string, originalContent: string, modifiedContent: string): Promise<void> {
        try {
            // 创建临时文件用于对比
            const originalUri = vscode.Uri.parse(`untitled:${filePath}.original`);
            const modifiedUri = vscode.Uri.parse(`untitled:${filePath}.modified`);

            // 打开原始内容文档
            const originalDoc = await vscode.workspace.openTextDocument(originalUri);
            const originalEditor = await vscode.window.showTextDocument(originalDoc, vscode.ViewColumn.One);
            await originalEditor.edit(editBuilder => {
                editBuilder.insert(new vscode.Position(0, 0), originalContent);
            });

            // 打开修改后内容文档
            const modifiedDoc = await vscode.workspace.openTextDocument(modifiedUri);
            const modifiedEditor = await vscode.window.showTextDocument(modifiedDoc, vscode.ViewColumn.Two);
            await modifiedEditor.edit(editBuilder => {
                editBuilder.insert(new vscode.Position(0, 0), modifiedContent);
            });

            // 执行diff比较
            await vscode.commands.executeCommand(
                'vscode.diff',
                originalUri,
                modifiedUri,
                `Diff Preview: ${filePath}`
            );

            Logger.info('📊 [Apply Diff] 已显示diff预览');

        } catch (error) {
            Logger.error('❌ [Apply Diff] 显示diff预览失败', error instanceof Error ? error : undefined);
            vscode.window.showErrorMessage('显示diff预览失败');
        }
    }

    /**
     * 获取ApplyDiffTool实例（供外部使用）
     */
    getApplyDiffTool(): ApplyDiffTool {
        return this.applyDiffTool;
    }
}