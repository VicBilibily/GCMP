/*---------------------------------------------------------------------------------------------
 *  Apply Diff 工具
 *  基于设计方案实现的增量精准编辑工具
 * 
 *  使用场景：
 *  - 用户明确要求修改特定文件内容
 *  - 需要对代码进行局部调整或bug修复  
 *  - 添加新功能或修改现有功能的实现
 *  - 用户提供了具体的修改要求和目标文件
 * 
 *  使用原则：
 *  1. 必须先读取目标文件内容确认当前状态
 *  2. 确保SEARCH内容与文件实际内容完全匹配
 *  3. 行号必须准确（从1开始计数）
 *  4. 对于重要修改建议先使用preview模式
 *  5. 支持单个diff中包含多个SEARCH/REPLACE块
 * 
 *  格式示例：
 *  <<<<<<< SEARCH
 *  :start_line:5
 *  :end_line:7
 *  -------
 *  function oldFunction() {
 *    return 'old';
 *  }
 *  =======
 *  function newFunction() {
 *    return 'new';
 *  }
 *  >>>>>>> REPLACE
 * 
 *  简化格式（无---分隔符）：
 *  <<<<<<< SEARCH
 *  :start_line:5
 *  :end_line:7
 *  =======
 *  function newFunction() {
 *    return 'new';
 *  }
 *  >>>>>>> REPLACE
 * 
 *  插入操作（在文件开头）：
 *  <<<<<<< SEARCH
 *  :start_line:1
 *  :end_line:0
 *  =======
 *  新增的内容
 *  >>>>>>> REPLACE
 * 
 *  多块修改示例：
 *  <<<<<<< SEARCH
 *  :start_line:1
 *  :end_line:1
 *  -------
 *  const version = '1.0.0';
 *  =======
 *  const version = '1.1.0';
 *  >>>>>>> REPLACE
 *  <<<<<<< SEARCH
 *  :start_line:10
 *  :end_line:12
 *  -------
 *  // TODO: implement feature
 *  function placeholder() {
 *  }
 *  =======
 *  // Feature implemented
 *  function realFeature() {
 *    return 'implemented';
 *  }
 *  >>>>>>> REPLACE
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import { Logger } from '../utils';

/**
 * Diff块接口
 */
export interface DiffBlock {
    startLine: number;
    endLine: number;
    searchLines: string[];
    replaceLines: string[];
}

/**
 * 可修改的Diff块接口（用于智能匹配时更新行号）
 */
interface MutableDiffBlock extends DiffBlock {
    startLine: number;
    endLine: number;
}

/**
 * Apply Diff 请求参数
 */
export interface ApplyDiffRequest {
    /** 目标文件路径 */
    path: string;
    /** diff内容字符串 */
    diff: string;
    /** 是否预览模式（不实际应用修改） */
    preview?: boolean;
}

/**
 * Apply Diff 响应
 */
export interface ApplyDiffResponse {
    success: boolean;
    message: string;
    blocksApplied: number;
    preview?: string;
    originalContent?: string;
    modifiedContent?: string;
}

/**
 * Apply Diff 工具类
 */
export class ApplyDiffTool {
    private backupMap = new Map<string, string>();
    private documentChangeDisposables = new Map<string, vscode.Disposable>();
    private isApplyingDiff = false;
    private isDisposed = false;

    constructor() {
        this.setupChangeTracking();
    }

    /**
     * 设置VS Code变更跟踪集成
     */
    private setupChangeTracking(): void {
        // 监听文档变更事件
        const disposable = vscode.workspace.onDidChangeTextDocument((event) => {
            if (this.isApplyingDiff) {
                Logger.debug(`📝 [Apply Diff] 检测到diff应用引起的文档变更: ${event.document.uri.fsPath}`);
                // 这里可以添加特定的变更处理逻辑
                this.handleDiffDocumentChange(event);
            }
        });

        // 保存全局监听器
        this.documentChangeDisposables.set('global', disposable);
    }

    /**
     * 处理diff引起的文档变更
     */
    private handleDiffDocumentChange(event: vscode.TextDocumentChangeEvent): void {
        const document = event.document;
        Logger.debug(`🔄 [Apply Diff] 文档变更详情: ${document.uri.fsPath}, 版本: ${document.version}, 变更数: ${event.contentChanges.length}`);

        // 记录变更的详细信息
        event.contentChanges.forEach((change, index) => {
            Logger.debug(`📝 [Apply Diff] 变更 ${index + 1}: 范围 [${change.range.start.line},${change.range.start.character}]-[${change.range.end.line},${change.range.end.character}], 长度: ${change.rangeLength}, 新文本长度: ${change.text.length}`);
        });

        // 可以在这里添加变更元数据处理
        // 注意：TextDocumentDetailedChangeReason是proposed API
        if ('detailedReason' in event && event.detailedReason) {
            const reason = event.detailedReason as { source?: string; metadata?: unknown };
            Logger.debug(`📋 [Apply Diff] 变更原因: source=${reason.source}, metadata=${JSON.stringify(reason.metadata)}`);

            // 验证这是我们的变更
            if (reason.source === 'gcmp-apply-diff') {
                Logger.debug('✅ [Apply Diff] 确认变更来自GCMP扩展');
            }
        }

        // 记录变更统计信息
        const addedLines = event.contentChanges.reduce((acc, change) => {
            const addedLineCount = change.text.split('\n').length - 1;
            return acc + addedLineCount;
        }, 0);

        const removedLines = event.contentChanges.reduce((acc, change) => {
            const removedLineCount = change.range.end.line - change.range.start.line;
            return acc + removedLineCount;
        }, 0);

        Logger.debug(`📊 [Apply Diff] 变更统计: +${addedLines}行, -${removedLines}行`);
    }    /**
     * 计算文档SHA1哈希（用于版本检查）
     */
    private computeDocumentSHA1(content: string): string {
        return crypto.createHash('sha1').update(content, 'utf8').digest('hex');
    }

    /**
     * 检查文档版本是否匹配
     */
    private async checkDocumentVersion(filePath: string, expectedContent?: string): Promise<boolean> {
        try {
            const document = await vscode.workspace.openTextDocument(vscode.Uri.file(this.resolveFilePath(filePath)));

            if (expectedContent) {
                const currentSHA1 = this.computeDocumentSHA1(document.getText());
                const expectedSHA1 = this.computeDocumentSHA1(expectedContent);

                if (currentSHA1 !== expectedSHA1) {
                    Logger.warn(`⚠️ [Apply Diff] 文档版本不匹配: ${filePath}`);
                    Logger.debug(`  当前SHA1: ${currentSHA1}`);
                    Logger.debug(`  期望SHA1: ${expectedSHA1}`);

                    // 询问用户是否继续，添加超时处理
                    try {
                        const result = await Promise.race([
                            vscode.window.showWarningMessage(
                                `文件 ${path.basename(filePath)} 已被修改，是否仍要应用diff？`,
                                { modal: false }, // 改为非模态以避免卡住
                                '继续应用',
                                '取消'
                            ),
                            new Promise<undefined>((_, reject) =>
                                setTimeout(() => reject(new Error('用户确认超时')), 10000)
                            )
                        ]);

                        return result === '继续应用';
                    } catch {
                        Logger.warn('⚠️ [Apply Diff] 用户确认超时，默认取消操作');
                        return false;
                    }
                }
            }

            return true;
        } catch (error) {
            Logger.warn(`⚠️ [Apply Diff] 检查文档版本失败: ${error instanceof Error ? error.message : '未知错误'}`);
            return true; // 默认允许继续
        }
    }    /**
     * 使用VS Code的编辑器API应用变更（支持撤销/重做）
     */
    private async applyChangesWithVSCodeAPI(filePath: string, edits: vscode.TextEdit[]): Promise<boolean> {
        try {
            const document = await vscode.workspace.openTextDocument(vscode.Uri.file(this.resolveFilePath(filePath)));

            // 尝试获取活动编辑器
            const activeEditor = vscode.window.visibleTextEditors.find(
                editor => editor.document.uri.toString() === document.uri.toString()
            );

            if (activeEditor) {
                // 如果有活动编辑器，使用编辑器的编辑操作（支持撤销/重做）
                Logger.debug(`📝 [Apply Diff] 使用活动编辑器API应用变更: ${filePath}`);

                // 创建变更原因元数据
                const changeReason = {
                    source: 'gcmp-apply-diff',
                    metadata: {
                        tool: 'applyDiff',
                        extension: 'gcmp',
                        timestamp: new Date().toISOString(),
                        blocksCount: edits.length
                    }
                };

                Logger.debug(`🏷️ [Apply Diff] 设置变更元数据: ${JSON.stringify(changeReason)}`);

                this.isApplyingDiff = true;
                try {
                    // 使用编辑器的edit方法，这会自动添加到撤销栈
                    const success = await activeEditor.edit((editBuilder) => {
                        edits.forEach(edit => {
                            editBuilder.replace(edit.range, edit.newText);
                        });
                    }, {
                        undoStopBefore: true,  // 在编辑前创建撤销点
                        undoStopAfter: true    // 在编辑后创建撤销点
                    });

                    if (success) {
                        Logger.debug(`✅ [Apply Diff] 成功通过编辑器API应用变更: ${filePath}`);

                        // 保存文档
                        await document.save();
                        return true;
                    } else {
                        Logger.error(`❌ [Apply Diff] 编辑器API应用变更失败: ${filePath}`);
                        return false;
                    }
                } finally {
                    this.isApplyingDiff = false;
                }
            } else {
                // 如果没有活动编辑器，使用WorkspaceEdit
                Logger.debug(`📝 [Apply Diff] 使用WorkspaceEdit API应用变更: ${filePath}`);

                const workspaceEdit = new vscode.WorkspaceEdit();

                // 为每个编辑操作添加元数据
                edits.forEach(edit => {
                    workspaceEdit.replace(document.uri, edit.range, edit.newText);
                });

                // 创建变更原因元数据
                const changeReason = {
                    source: 'gcmp-apply-diff',
                    metadata: {
                        tool: 'applyDiff',
                        extension: 'gcmp',
                        timestamp: new Date().toISOString(),
                        blocksCount: edits.length
                    }
                };

                Logger.debug(`🏷️ [Apply Diff] 设置变更元数据: ${JSON.stringify(changeReason)}`);

                // 应用编辑
                this.isApplyingDiff = true;
                try {
                    const success = await vscode.workspace.applyEdit(workspaceEdit);

                    if (success) {
                        Logger.debug(`✅ [Apply Diff] 成功通过WorkspaceEdit API应用变更: ${filePath}`);

                        // 保存文档
                        await document.save();
                        return true;
                    } else {
                        Logger.error(`❌ [Apply Diff] WorkspaceEdit API应用变更失败: ${filePath}`);
                        return false;
                    }
                } finally {
                    this.isApplyingDiff = false;
                }
            }
        } catch (error) {
            this.isApplyingDiff = false;
            Logger.error(`❌ [Apply Diff] VS Code API操作异常: ${error instanceof Error ? error.message : '未知错误'}`);
            return false;
        }
    }    /**
     * 将diff块转换为VS Code TextEdit数组
     */
    private convertDiffBlocksToTextEdits(fileLines: string[], diffBlocks: DiffBlock[]): vscode.TextEdit[] {
        const edits: vscode.TextEdit[] = [];

        // 按行号排序（从前往后应用，因为VS Code会自动处理偏移）
        const sortedBlocks = [...diffBlocks].sort((a, b) => a.startLine - b.startLine);

        for (const block of sortedBlocks) {
            const startPosition = new vscode.Position(Math.max(0, block.startLine - 1), 0);

            if (block.searchLines.length === 0 || block.endLine === 0) {
                // 插入操作
                const insertText = block.replaceLines.join('\n') + (block.replaceLines.length > 0 ? '\n' : '');
                edits.push(new vscode.TextEdit(
                    new vscode.Range(startPosition, startPosition),
                    insertText
                ));
            } else {
                // 替换操作
                const endPosition = new vscode.Position(block.endLine - 1, fileLines[block.endLine - 1]?.length || 0);
                const replaceText = block.replaceLines.join('\n');
                edits.push(new vscode.TextEdit(
                    new vscode.Range(startPosition, endPosition),
                    replaceText
                ));
            }
        }

        return edits;
    }

    /**
     * 添加文档监听器（用于特定文件的变更跟踪）
     */
    private addDocumentWatcher(filePath: string): void {
        const uri = vscode.Uri.file(this.resolveFilePath(filePath));

        const disposable = vscode.workspace.onDidChangeTextDocument((event) => {
            if (event.document.uri.toString() === uri.toString() && !this.isApplyingDiff) {
                Logger.debug(`📝 [Apply Diff] 监控的文档发生变更: ${filePath}`);
            }
        });

        // 清理旧的监听器
        const oldDisposable = this.documentChangeDisposables.get(filePath);
        if (oldDisposable) {
            oldDisposable.dispose();
        }

        this.documentChangeDisposables.set(filePath, disposable);
    }

    /**
     * 清理文档监听器
     */
    private cleanupDocumentWatcher(filePath: string): void {
        const disposable = this.documentChangeDisposables.get(filePath);
        if (disposable) {
            disposable.dispose();
            this.documentChangeDisposables.delete(filePath);
        }
    }

    /**
     * 销毁所有监听器
     */
    dispose(): void {
        if (this.isDisposed) {
            return;
        }

        this.isDisposed = true;

        for (const [, disposable] of this.documentChangeDisposables) {
            disposable.dispose();
        }
        this.documentChangeDisposables.clear();

        // 清理备份
        this.backupMap.clear();

        Logger.debug('🧹 [Apply Diff] 工具资源已清理');
    }

    /**
     * 解析diff字符串为diff块数组
     */
    parseDiff(diffContent: string): DiffBlock[] {
        const blocks: DiffBlock[] = [];

        try {
            // 参数验证
            if (!diffContent || typeof diffContent !== 'string') {
                Logger.error('❌ [Apply Diff] diff内容无效或为空');
                return [];
            }

            const lines = diffContent.split('\n');
            Logger.debug(`🔍 [Apply Diff] 开始解析diff内容，总行数: ${lines.length}`);
            Logger.debug(`📄 [Apply Diff] diff内容:\n${diffContent}`);

            let i = 0;
            while (i < lines.length) {
                const line = lines[i].trim();

                // 查找 <<<<<<< SEARCH 标记
                if (line === '<<<<<<< SEARCH') {
                    Logger.debug(`🎯 [Apply Diff] 找到SEARCH标记，行号: ${i + 1}`);
                    try {
                        const result = this.parseDiffBlock(lines, i);
                        if (result) {
                            blocks.push(result);
                            Logger.debug(`✅ [Apply Diff] 成功解析第${blocks.length}个diff块`);
                            i = result.endIndex;
                        } else {
                            Logger.warn(`⚠️ [Apply Diff] 解析diff块失败，行号: ${i + 1}`);
                            // 尝试找到下一个SEARCH或跳过当前行
                            const nextSearchIndex = this.findNextSearchBlock(lines, i + 1);
                            i = nextSearchIndex > 0 ? nextSearchIndex : i + 1;
                        }
                    } catch (blockError) {
                        Logger.error(`❌ [Apply Diff] 解析第${blocks.length + 1}个diff块时发生错误: ${blockError instanceof Error ? blockError.message : '未知错误'}`);
                        // 尝试继续解析下一个块
                        const nextSearchIndex = this.findNextSearchBlock(lines, i + 1);
                        i = nextSearchIndex > 0 ? nextSearchIndex : i + 1;
                    }
                } else {
                    i++;
                }
            }

            Logger.info(`📊 [Apply Diff] 解析完成，共找到 ${blocks.length} 个有效diff块`);
            return blocks;

        } catch (error) {
            Logger.error('❌ [Apply Diff] parseDiff方法执行失败', error instanceof Error ? error : undefined);
            Logger.debug(`📄 [Apply Diff] 导致错误的diff内容:\n${diffContent}`);
            return [];
        }
    }

    /**
     * 查找下一个SEARCH块的位置
     */
    private findNextSearchBlock(lines: string[], startIndex: number): number {
        for (let i = startIndex; i < lines.length; i++) {
            if (lines[i].trim() === '<<<<<<< SEARCH') {
                return i;
            }
        }
        return -1;
    }

    /**
     * 解析单个diff块
     */
    private parseDiffBlock(lines: string[], startIndex: number): (DiffBlock & { endIndex: number }) | null {
        try {
            let i = startIndex + 1;
            let startLine = -1;
            let endLine = -1;
            const searchLines: string[] = [];
            const replaceLines: string[] = [];
            let foundReplaceSeparator = false;

            Logger.debug(`🔍 [Apply Diff] 开始解析diff块，起始行: ${startIndex + 1}`);

            // 第一阶段：查找行号信息和可选的分隔符
            while (i < lines.length) {
                const line = lines[i];
                const trimmedLine = line.trim();

                if (trimmedLine.startsWith(':start_line:')) {
                    const lineNumStr = trimmedLine.replace(':start_line:', '');
                    startLine = parseInt(lineNumStr);
                    if (isNaN(startLine)) {
                        Logger.warn(`⚠️ [Apply Diff] 无效的起始行号: ${lineNumStr}`);
                        return null;
                    }
                    Logger.debug(`📍 [Apply Diff] 找到起始行号: ${startLine}`);
                    i++;
                } else if (trimmedLine.startsWith(':end_line:')) {
                    const lineNumStr = trimmedLine.replace(':end_line:', '');
                    endLine = parseInt(lineNumStr);
                    if (isNaN(endLine)) {
                        Logger.warn(`⚠️ [Apply Diff] 无效的结束行号: ${lineNumStr}`);
                        return null;
                    }
                    Logger.debug(`📍 [Apply Diff] 找到结束行号: ${endLine}`);
                    i++;
                } else if (trimmedLine.startsWith('-------')) {
                    Logger.debug(`🔗 [Apply Diff] 找到可选分隔符，行号: ${i + 1}`);
                    i++;
                    break; // 找到分隔符后进入SEARCH内容解析阶段
                } else if (trimmedLine.startsWith('=======')) {
                    // 直接遇到 ======= 表示没有 ------- 分隔符和SEARCH内容，直接进入REPLACE阶段
                    foundReplaceSeparator = true;
                    Logger.debug(`🔗 [Apply Diff] 直接找到替换分隔符（无SEARCH内容），行号: ${i + 1}`);
                    i++;
                    break;
                } else if (trimmedLine === '' || trimmedLine.length === 0) {
                    // 跳过空行
                    i++;
                } else {
                    // 遇到非特殊标记的内容，可能是SEARCH内容开始了（没有---分隔符的情况）
                    Logger.debug(`ℹ️ [Apply Diff] 遇到内容行，可能是SEARCH开始: "${trimmedLine}"`);
                    break;
                }
            }

            // 第二阶段：解析SEARCH内容（如果还没有找到 ======= 分隔符）
            if (!foundReplaceSeparator) {
                Logger.debug(`ℹ️ [Apply Diff] 开始解析SEARCH内容，当前行号: ${i + 1}`);
                while (i < lines.length) {
                    const line = lines[i];
                    const trimmedLine = line.trim();

                    if (trimmedLine.startsWith('=======')) {
                        foundReplaceSeparator = true;
                        Logger.debug(`🔗 [Apply Diff] 找到替换分隔符，行号: ${i + 1}`);
                        i++;
                        break;
                    }

                    // 收集SEARCH内容（不包括行号标记）
                    if (!trimmedLine.startsWith(':start_line:') && !trimmedLine.startsWith(':end_line:')) {
                        searchLines.push(line);
                        Logger.debug(`📝 [Apply Diff] SEARCH内容: "${line}"`);
                    }
                    i++;
                }
            }

            if (!foundReplaceSeparator) {
                Logger.warn('⚠️ [Apply Diff] 未找到 ======= 分隔符');
                return null;
            }

            // 第三阶段：解析REPLACE内容
            Logger.debug(`ℹ️ [Apply Diff] 开始解析REPLACE内容，当前行号: ${i + 1}`);
            while (i < lines.length) {
                const line = lines[i];
                const trimmedLine = line.trim();

                if (trimmedLine.startsWith('>>>>>>> REPLACE')) {
                    Logger.debug(`🔗 [Apply Diff] 找到结束标记，行号: ${i + 1}`);
                    i++; // 移动到下一行
                    break;
                }

                replaceLines.push(line);
                Logger.debug(`📝 [Apply Diff] REPLACE内容: "${line}"`);
                i++;
            }

            // 检查是否找到了结束标记
            if (i > lines.length || !lines[i - 1]?.trim().startsWith('>>>>>>> REPLACE')) {
                Logger.warn('⚠️ [Apply Diff] diff块格式不正确，缺少结束标记');
                return null;
            }

            // 如果没有明确的行号，尝试从内容推断或使用智能匹配
            if (startLine === -1 || endLine === -1) {
                Logger.debug('ℹ️ [Apply Diff] diff块缺少行号信息，将使用智能内容匹配模式');
                // 对于添加到文件开头的情况，使用特殊处理
                if (searchLines.length === 0 && replaceLines.length > 0) {
                    // 这是一个插入操作，在文件开头插入内容
                    startLine = 1;
                    endLine = 0; // 表示在第1行之前插入
                    Logger.debug('🆕 [Apply Diff] 检测到插入操作，目标位置：文件开头');
                } else {
                    // 常规内容匹配
                    startLine = 1;
                    endLine = Math.max(1, searchLines.length);
                }
            }

            // 验证解析结果 - 对于插入操作，searchLines可以为空
            if (searchLines.length === 0 && replaceLines.length === 0) {
                Logger.warn('⚠️ [Apply Diff] SEARCH和REPLACE内容都为空');
                return null;
            }

            Logger.debug(`🔍 [Apply Diff] 解析diff块完成: 行${startLine}-${endLine}, 搜索${searchLines.length}行, 替换${replaceLines.length}行`);
            Logger.debug(`📄 [Apply Diff] 搜索内容预览: ${searchLines.slice(0, 3).join('\\n')}${searchLines.length > 3 ? '...' : ''}`);

            return {
                startLine,
                endLine,
                searchLines,
                replaceLines,
                endIndex: i
            };

        } catch (error) {
            Logger.error(`❌ [Apply Diff] parseDiffBlock执行失败，起始行: ${startIndex + 1}`, error instanceof Error ? error : undefined);
            return null;
        }
    }    /**
     * 读取文件内容
     */
    private readFileContent(filePath: string): string[] {
        try {
            const absolutePath = this.resolveFilePath(filePath);
            const content = fs.readFileSync(absolutePath, 'utf8');
            return content.split('\n');
        } catch (error) {
            throw new Error(`读取文件失败: ${error instanceof Error ? error.message : '未知错误'}`);
        }
    }

    /**
     * 写入文件内容
     */
    private writeFileContent(filePath: string, lines: string[]): void {
        try {
            const absolutePath = this.resolveFilePath(filePath);
            const content = lines.join('\n');
            fs.writeFileSync(absolutePath, content, 'utf8');
        } catch (error) {
            throw new Error(`写入文件失败: ${error instanceof Error ? error.message : '未知错误'}`);
        }
    }

    /**
     * 解析文件路径为绝对路径
     */
    private resolveFilePath(filePath: string): string {
        if (path.isAbsolute(filePath)) {
            return filePath;
        }

        // 如果是相对路径，基于工作区根目录解析
        const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
        if (!workspaceFolder) {
            throw new Error('无法解析相对路径：未找到工作区');
        }

        return path.join(workspaceFolder.uri.fsPath, filePath);
    }

    /**
     * 验证搜索内容是否匹配
     */
    private validateSearchMatch(fileLines: string[], block: DiffBlock): boolean {
        // 特殊处理：如果searchLines为空，这是一个插入操作
        if (block.searchLines.length === 0) {
            Logger.debug('✅ [Apply Diff] 检测到插入操作，跳过内容匹配验证');
            return true;
        }

        // 如果没有明确的行号，尝试在整个文件中搜索匹配的内容
        if (block.startLine === 1 && block.endLine === block.searchLines.length) {
            Logger.debug('🔍 [Apply Diff] 尝试智能内容匹配模式');
            const match = this.findContentMatch(fileLines, block.searchLines);
            if (match) {
                // 更新block的行号（通过类型断言）
                const mutableBlock = block as MutableDiffBlock;
                mutableBlock.startLine = match.startLine;
                mutableBlock.endLine = match.endLine;
                Logger.debug(`✅ [Apply Diff] 智能匹配成功: 行${block.startLine}-${block.endLine}`);
                return true;
            }
        }

        const startIdx = block.startLine - 1; // 转换为0-based索引
        const endIdx = block.endLine - 1;

        // 对于插入操作，允许endIdx为-1（表示在第1行之前插入）
        if (block.searchLines.length === 0 && block.endLine === 0) {
            Logger.debug('✅ [Apply Diff] 文件开头插入操作验证通过');
            return true;
        }

        if (startIdx < 0 || endIdx >= fileLines.length || startIdx > endIdx) {
            Logger.debug(`❌ [Apply Diff] 行号范围无效: ${block.startLine}-${block.endLine}, 文件总行数: ${fileLines.length}`);
            return false;
        }

        const fileSection = fileLines.slice(startIdx, endIdx + 1);

        if (fileSection.length !== block.searchLines.length) {
            Logger.debug(`❌ [Apply Diff] 行数不匹配: 文件${fileSection.length}行 vs diff${block.searchLines.length}行`);
            return false;
        }

        // 逐行比较（更宽松的匹配策略）
        for (let i = 0; i < fileSection.length; i++) {
            const fileLine = fileSection[i];
            const searchLine = block.searchLines[i];

            // 尝试多种匹配策略
            const matches =
                fileLine === searchLine ||                           // 完全匹配
                fileLine.trim() === searchLine.trim() ||             // 忽略前后空格
                fileLine.replace(/\s+/g, ' ').trim() ===
                searchLine.replace(/\s+/g, ' ').trim();              // 规范化空白字符

            if (!matches) {
                Logger.debug(`❌ [Apply Diff] 第${i + 1}行不匹配:`);
                Logger.debug(`  文件行: "${fileLine}"`);
                Logger.debug(`  搜索行: "${searchLine}"`);
                return false;
            }
        }

        Logger.debug(`✅ [Apply Diff] 内容匹配成功: 行${block.startLine}-${block.endLine}`);
        return true;
    }

    /**
     * 在文件中查找匹配的内容块
     */
    private findContentMatch(fileLines: string[], searchLines: string[]): { startLine: number; endLine: number } | null {
        if (searchLines.length === 0) {
            return null;
        }

        // 在文件中搜索匹配的内容
        for (let i = 0; i <= fileLines.length - searchLines.length; i++) {
            let allMatch = true;

            for (let j = 0; j < searchLines.length; j++) {
                const fileLine = fileLines[i + j];
                const searchLine = searchLines[j];

                // 使用相同的匹配策略
                const matches =
                    fileLine === searchLine ||
                    fileLine.trim() === searchLine.trim() ||
                    fileLine.replace(/\s+/g, ' ').trim() === searchLine.replace(/\s+/g, ' ').trim();

                if (!matches) {
                    allMatch = false;
                    break;
                }
            }

            if (allMatch) {
                Logger.debug(`🎯 [Apply Diff] 找到内容匹配: 行${i + 1}-${i + searchLines.length}`);
                return {
                    startLine: i + 1,
                    endLine: i + searchLines.length
                };
            }
        }

        Logger.debug('❌ [Apply Diff] 未找到匹配的内容块');
        return null;
    }

    /**
     * 应用单个diff块
     */
    private applyDiffBlock(fileLines: string[], block: DiffBlock): string[] {
        const startIdx = block.startLine - 1;
        const endIdx = block.endLine - 1;

        // 创建新的文件行数组
        const newLines = [...fileLines];

        // 特殊处理：插入操作（searchLines为空或endLine为0）
        if (block.searchLines.length === 0 || block.endLine === 0) {
            if (block.endLine === 0) {
                // 在文件开头插入
                Logger.debug(`🆕 [Apply Diff] 在文件开头插入 ${block.replaceLines.length} 行`);
                newLines.splice(0, 0, ...block.replaceLines);
            } else {
                // 在指定位置插入
                Logger.debug(`🆕 [Apply Diff] 在第 ${block.startLine} 行插入 ${block.replaceLines.length} 行`);
                newLines.splice(startIdx, 0, ...block.replaceLines);
            }
        } else {
            // 常规替换操作
            Logger.debug(`🔄 [Apply Diff] 替换第 ${block.startLine}-${block.endLine} 行`);
            newLines.splice(startIdx, endIdx - startIdx + 1, ...block.replaceLines);
        }

        return newLines;
    }

    /**
     * 创建文件备份
     */
    private createBackup(filePath: string, content: string): void {
        this.backupMap.set(filePath, content);
        Logger.debug(`📄 [Apply Diff] 已创建文件备份: ${filePath}`);
    }

    /**
     * 恢复文件备份
     */
    private restoreBackup(filePath: string): void {
        const backup = this.backupMap.get(filePath);
        if (backup) {
            const lines = backup.split('\n');
            this.writeFileContent(filePath, lines);
            this.backupMap.delete(filePath);
            Logger.info(`🔄 [Apply Diff] 已恢复文件备份: ${filePath}`);
        }
    }

    /**
     * 生成diff预览
     */
    private generatePreview(original: string, modified: string): string {
        const originalLines = original.split('\n');
        const modifiedLines = modified.split('\n');

        let preview = '--- 原始内容\n+++ 修改后内容\n';

        const maxLines = Math.max(originalLines.length, modifiedLines.length);
        for (let i = 0; i < maxLines; i++) {
            const originalLine = i < originalLines.length ? originalLines[i] : '';
            const modifiedLine = i < modifiedLines.length ? modifiedLines[i] : '';

            if (originalLine !== modifiedLine) {
                if (originalLine) {
                    preview += `- ${originalLine}\n`;
                }
                if (modifiedLine) {
                    preview += `+ ${modifiedLine}\n`;
                }
            } else {
                preview += `  ${originalLine}\n`;
            }
        }

        return preview;
    }

    /**
     * 应用diff
     */
    async applyDiff(request: ApplyDiffRequest): Promise<ApplyDiffResponse> {
        // 检查工具是否已被释放
        if (this.isDisposed) {
            Logger.warn('⚠️ [Apply Diff] 工具已被释放，无法执行操作');
            return {
                success: false,
                message: '工具已被释放，无法执行操作',
                blocksApplied: 0
            };
        }

        // 检查是否有其他diff操作正在进行
        if (this.isApplyingDiff) {
            Logger.warn('⚠️ [Apply Diff] 已有diff操作正在进行中，请稍后重试');
            return {
                success: false,
                message: '已有diff操作正在进行中，请稍后重试',
                blocksApplied: 0
            };
        }

        Logger.info(`🔧 [Apply Diff] 开始应用diff到文件: ${request.path}`);

        try {
            // 解析diff内容
            const diffBlocks = this.parseDiff(request.diff);
            if (diffBlocks.length === 0) {
                Logger.error('❌ [Apply Diff] 未找到有效的diff块');
                Logger.debug(`📄 [Apply Diff] 原始diff内容:\n${request.diff}`);
                throw new Error('未找到有效的diff块');
            }

            Logger.info(`📊 [Apply Diff] 解析到 ${diffBlocks.length} 个diff块`);

            // 读取原始文件内容
            const originalLines = this.readFileContent(request.path);
            const originalContent = originalLines.join('\n');

            Logger.debug(`📖 [Apply Diff] 文件总行数: ${originalLines.length}`);

            // 添加文档监听器
            this.addDocumentWatcher(request.path);

            // 检查文档版本（防止在已修改文件上应用过期diff）
            const versionMatch = await this.checkDocumentVersion(request.path, originalContent);
            if (!versionMatch) {
                return {
                    success: false,
                    message: '用户取消了应用diff（文档版本不匹配）',
                    blocksApplied: 0
                };
            }

            // 创建备份
            this.createBackup(request.path, originalContent);

            let currentLines = [...originalLines];
            let appliedBlocks = 0;

            // 按行号排序（从后往前应用，避免行号偏移）
            const sortedBlocks = [...diffBlocks].sort((a, b) => b.startLine - a.startLine);

            // 验证所有diff块的内容匹配
            for (const block of sortedBlocks) {
                Logger.debug(`� [Apply Diff] 验证第${appliedBlocks + 1}个diff块: 行${block.startLine}-${block.endLine}`);

                if (!this.validateSearchMatch(currentLines, block)) {
                    const errorMsg = `第${appliedBlocks + 1}个diff块内容不匹配，行号范围: ${block.startLine}-${block.endLine}`;
                    Logger.error(`❌ [Apply Diff] ${errorMsg}`);

                    // 输出详细的调试信息
                    const startIdx = block.startLine - 1;
                    const endIdx = Math.min(block.endLine - 1, currentLines.length - 1);
                    if (startIdx >= 0 && startIdx < currentLines.length) {
                        const fileSection = currentLines.slice(startIdx, endIdx + 1);
                        Logger.debug('📄 [Apply Diff] 文件中的实际内容:');
                        fileSection.forEach((line, idx) => {
                            Logger.debug(`  ${startIdx + idx + 1}: "${line}"`);
                        });
                        Logger.debug('🔍 [Apply Diff] diff中期望的内容:');
                        block.searchLines.forEach((line) => {
                            Logger.debug(`  期望: "${line}"`);
                        });
                    }

                    throw new Error(errorMsg);
                }
            }

            // 如果是预览模式，生成预览后返回
            if (request.preview) {
                // 模拟应用所有diff块生成预览
                let previewLines = [...originalLines];
                for (const block of sortedBlocks) {
                    previewLines = this.applyDiffBlock(previewLines, block);
                }
                const modifiedContent = previewLines.join('\n');
                const preview = this.generatePreview(originalContent, modifiedContent);

                return {
                    success: true,
                    message: `预览模式：将应用 ${diffBlocks.length} 个diff块`,
                    blocksApplied: diffBlocks.length,
                    preview,
                    originalContent,
                    modifiedContent
                };
            }

            // 工具直接执行，无需用户确认（已接入VS Code历史修改机制）
            Logger.debug('� [Apply Diff] 直接执行diff应用（支持撤销/重做）');            // 尝试使用VS Code API应用变更（如果可能）
            const useVSCodeAPI = vscode.workspace.workspaceFolders &&
                this.resolveFilePath(request.path).startsWith(vscode.workspace.workspaceFolders[0].uri.fsPath);

            if (useVSCodeAPI) {
                Logger.debug('📝 [Apply Diff] 使用VS Code API应用变更');

                // 转换为VS Code TextEdit格式（需要使用原始行数组作为基准）
                const textEdits = this.convertDiffBlocksToTextEdits(originalLines, diffBlocks);

                const success = await this.applyChangesWithVSCodeAPI(request.path, textEdits);

                if (success) {
                    // 读取应用后的内容
                    const finalLines = this.readFileContent(request.path);
                    const modifiedContent = finalLines.join('\n');

                    this.backupMap.delete(request.path); // 清理备份

                    Logger.info(`✅ [Apply Diff] 成功通过VS Code API应用 ${diffBlocks.length} 个diff块到文件: ${request.path}`);

                    return {
                        success: true,
                        message: `成功应用 ${diffBlocks.length} 个diff块（通过VS Code API）`,
                        blocksApplied: diffBlocks.length,
                        originalContent,
                        modifiedContent
                    };
                } else {
                    // 如果VS Code API失败，回退到文件系统方法
                    Logger.warn('⚠️ [Apply Diff] VS Code API失败，回退到文件系统方法');
                }
            }

            // 回退到传统的文件系统方法
            Logger.debug('📁 [Apply Diff] 使用文件系统方法应用变更');

            // 逐个应用diff块
            for (const block of sortedBlocks) {
                currentLines = this.applyDiffBlock(currentLines, block);
                appliedBlocks++;
                Logger.debug(`✅ [Apply Diff] 已应用第${appliedBlocks}个diff块`);
            }

            const modifiedContent = currentLines.join('\n');

            // 写入修改后的内容
            this.writeFileContent(request.path, currentLines);
            this.backupMap.delete(request.path); // 清理备份

            Logger.info(`✅ [Apply Diff] 成功应用 ${appliedBlocks} 个diff块到文件: ${request.path}`);

            return {
                success: true,
                message: `成功应用 ${appliedBlocks} 个diff块`,
                blocksApplied: appliedBlocks,
                originalContent,
                modifiedContent
            };

        } catch (error) {
            // 发生错误时恢复备份
            this.restoreBackup(request.path);

            const errorMessage = error instanceof Error ? error.message : '未知错误';
            Logger.error('❌ [Apply Diff] 应用diff失败', error instanceof Error ? error : undefined);

            return {
                success: false,
                message: `应用diff失败: ${errorMessage}`,
                blocksApplied: 0
            };
        } finally {
            // 清理文档监听器
            this.cleanupDocumentWatcher(request.path);
        }
    }

    /**
     * 工具调用处理器
     */
    async invoke(request: vscode.LanguageModelToolInvocationOptions<ApplyDiffRequest>): Promise<vscode.LanguageModelToolResult> {
        const invocationId = Math.random().toString(36).substr(2, 9);
        Logger.info(`🚀 [工具调用 ${invocationId}] Apply Diff工具被调用: ${JSON.stringify(request.input)}`);

        try {
            const params = request.input as ApplyDiffRequest;

            // 参数验证和友好错误提示
            if (!params.path) {
                throw new Error('缺少必需参数: path\n\n使用示例：\n"path": "src/components/Button.vue"');
            }
            if (!params.diff) {
                throw new Error('缺少必需参数: diff\n\n使用示例格式：\n<<<<<<< SEARCH\n:start_line:1\n:end_line:1\n-------\n原始内容\n=======\n新内容\n>>>>>>> REPLACE');
            }

            // 格式验证
            if (!params.diff.includes('<<<<<<< SEARCH') || !params.diff.includes('>>>>>>> REPLACE')) {
                throw new Error('diff格式不正确，必须包含 SEARCH 和 REPLACE 标记\n\n正确格式：\n<<<<<<< SEARCH\n:start_line:行号\n:end_line:行号\n-------\n要替换的原始内容\n=======\n替换后的新内容\n>>>>>>> REPLACE');
            }

            // 增强格式检查
            const searchCount = (params.diff.match(/<<<<<<< SEARCH/g) || []).length;
            const replaceCount = (params.diff.match(/>>>>>>> REPLACE/g) || []).length;
            if (searchCount !== replaceCount) {
                throw new Error(`diff格式错误：SEARCH标记数量(${searchCount})与REPLACE标记数量(${replaceCount})不匹配\n\n请确保每个 <<<<<<< SEARCH 都有对应的 >>>>>>> REPLACE`);
            }

            Logger.debug(`📋 [工具调用 ${invocationId}] 参数验证通过，开始执行diff应用`);

            const result = await this.applyDiff(params);

            let responseText = result.message;
            if (result.preview) {
                responseText += '\n\n📋 预览修改内容：\n```diff\n' + result.preview + '\n```';
                responseText += '\n\n💡 如需应用修改，请将 preview 参数设为 false 重新调用。';
            }

            if (result.success && result.blocksApplied > 0) {
                responseText += `\n\n✅ 成功应用了 ${result.blocksApplied} 个修改块`;
                if (result.originalContent && result.modifiedContent) {
                    responseText += '\n📁 文件已自动备份，如有问题可以回滚。';
                }
            }

            Logger.info(`✅ [工具调用 ${invocationId}] Apply Diff工具调用成功`);

            return new vscode.LanguageModelToolResult([
                new vscode.LanguageModelTextPart(responseText)
            ]);

        } catch (error) {
            const errorMessage = error instanceof Error ? error.message : '未知错误';
            Logger.error(`❌ [工具调用 ${invocationId}] Apply Diff工具调用失败: ${errorMessage}`, error instanceof Error ? error : undefined);

            // 提供更友好的错误信息和使用指导
            let helpText = '';
            if (errorMessage.includes('未找到有效的diff块')) {
                helpText = '\n\n💡 使用建议：\n1. 确保使用正确的 SEARCH/REPLACE 格式\n2. 检查所有标记是否配对：<<<<<<< SEARCH ... >>>>>>> REPLACE\n3. 确保包含行号信息：:start_line: 和 :end_line:\n4. 检查是否有缺失的分隔符：------- 和 =======';
            } else if (errorMessage.includes('内容不匹配')) {
                helpText = '\n\n💡 内容匹配失败的常见原因：\n1. 行号不正确或超出文件范围\n2. 原始内容与文件实际内容不符\n3. 空格、缩进或换行符不匹配\n4. 文件可能已被其他操作修改\n\n🔧 建议解决方案：\n- 先读取目标文件确认当前内容\n- 使用 preview: true 预览修改\n- 确保SEARCH内容与文件内容完全一致';
            } else if (errorMessage.includes('格式错误') || errorMessage.includes('格式不正确')) {
                helpText = '\n\n💡 格式问题解决方案：\n1. 检查是否有未配对的标记\n2. 确保使用正确的标记名称\n3. 验证分隔符的拼写和位置\n4. 每个diff块必须完整包含所有必需元素';
            } else if (errorMessage.includes('工具已被释放') || errorMessage.includes('正在进行中')) {
                helpText = '\n\n💡 工具状态问题：\n- 请稍等片刻后重试\n- 如果问题持续，请重新加载VS Code窗口';
            }

            throw new vscode.LanguageModelError(
                `Apply Diff失败: ${errorMessage}${helpText}`
            );
        }
    }
}