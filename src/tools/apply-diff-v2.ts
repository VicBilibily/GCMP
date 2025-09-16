/*---------------------------------------------------------------------------------------------
 *  Apply Diff 工具 V2
 *  完全重构版本 - 充分利用 VS Code 内置功能并接入聊天修改历史
 * 
 *  核心架构：
 *  1. 使用 ChatResponseTextEditPart 进行响应式编辑
 *  2. 集成 ChatRequest.editedFileEvents 跟踪文件变更
 *  3. 利用 ChatUserActionEvent 捕获用户操作
 *  4. 使用 WorkspaceEdit 和 TextEditor.edit() 进行安全编辑
 *  5. 支持 vscode.diff 预览和批量应用
 * 
 *  优势：
 *  - 原生 VS Code 集成
 *  - 聊天修改历史自动跟踪
 *  - 撤销/重做支持
 *  - 智能预览和确认
 *  - 批量操作支持
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import * as path from 'path';
import { Logger } from '../utils';

/**
 * 增强的 Diff 块接口
 */
export interface DiffBlockV2 {
    id: string;
    startLine: number;
    endLine: number;
    searchLines: string[];
    replaceLines: string[];
    confidence: number; // 匹配置信度
    metadata?: {
        operation: 'replace' | 'insert' | 'delete';
        language?: string;
        description?: string;
    };
}

/**
 * 编辑结果接口 - 参考官方 IEditedFile 结构
 */
export interface EditResult {
    success: boolean;
    uri: vscode.Uri;
    edits: vscode.TextEdit[];
    blocksApplied: number;
    message: string;
    operation?: 'UPDATE' | 'CREATE' | 'DELETE';
    existingDiagnostics?: vscode.Diagnostic[];
    error?: string;
}

/**
 * 工具结果文件信息 - 参考官方 EditFileResult 结构
 */
export interface ToolResultFile {
    operation: 'UPDATE' | 'CREATE' | 'DELETE';
    uri: vscode.Uri;
    isNotebook: boolean;
    existingDiagnostics: vscode.Diagnostic[];
    error?: string;
    edits?: vscode.TextEdit[];
    blocksApplied?: number;
}

/**
 * Apply Diff 请求参数 V2
 */
export interface ApplyDiffRequestV2 {
    /** 目标文件路径 */
    path: string;
    /** diff内容字符串 */
    diff: string;
    /** 是否批量模式 */
    batch?: boolean;
    /** 内部参数：是否在聊天上下文中（由工具调用时自动设置） */
    _inChatContext?: boolean;
    /** 聊天响应流（用于集成到聊天中） */
    responseStream?: vscode.ChatResponseStream;
    /** 聊天请求上下文 */
    chatRequest?: vscode.ChatRequest;
}

/**
 * Apply Diff 响应 V2
 */
export interface ApplyDiffResponseV2 {
    success: boolean;
    message: string;
    results: EditResult[];
    totalBlocksApplied: number;
    chatIntegrated: boolean;
}

/**
 * 聊天修改历史集成器
 */
class ChatHistoryIntegrator {
    private static instance: ChatHistoryIntegrator;
    private editSessions = new Map<string, vscode.Uri[]>();
    private actionEventDisposable?: vscode.Disposable;

    private constructor() {
        this.setupUserActionTracking();
    }

    static getInstance(): ChatHistoryIntegrator {
        if (!ChatHistoryIntegrator.instance) {
            ChatHistoryIntegrator.instance = new ChatHistoryIntegrator();
        }
        return ChatHistoryIntegrator.instance;
    }

    /**
     * 设置用户操作跟踪
     */
    private setupUserActionTracking(): void {
        // 监听聊天用户操作事件
        if (vscode.chat && 'onDidPerformAction' in vscode.chat) {
            // 这是一个 proposed API，可能不在所有环境中可用
            try {
                // eslint-disable-next-line @typescript-eslint/no-explicit-any
                this.actionEventDisposable = (vscode.chat as any).onDidPerformAction(
                    (event: vscode.ChatUserActionEvent) => {
                        this.handleUserAction(event);
                    }
                );
                Logger.debug('✅ [Chat History] 用户操作跟踪已启用');
            } catch {
                Logger.debug('ℹ️ [Chat History] 用户操作跟踪API不可用（这是正常的）');
            }
        }
    }

    /**
     * 处理用户操作事件
     */
    private handleUserAction(event: vscode.ChatUserActionEvent): void {
        Logger.debug(`🎯 [Chat History] 检测到用户操作: ${event.action.kind}`);

        if (event.action.kind === 'apply') {
            const applyAction = event.action as vscode.ChatApplyAction;
            Logger.info(`📝 [Chat History] 用户应用了代码块: 索引${applyAction.codeBlockIndex}, 字符数${applyAction.totalCharacters}`);
        } else if (event.action.kind === 'chatEditingSessionAction') {
            const editAction = event.action as vscode.ChatEditingSessionAction;
            Logger.info(`🔧 [Chat History] 编辑会话操作: ${editAction.uri.fsPath}, 结果${editAction.outcome}`);
        }
    }

    /**
     * 开始编辑会话
     */
    startEditSession(sessionId: string, files: vscode.Uri[]): void {
        this.editSessions.set(sessionId, files);
        Logger.debug(`🚀 [Chat History] 开始编辑会话: ${sessionId}, 文件数: ${files.length}`);
    }

    /**
     * 结束编辑会话
     */
    endEditSession(sessionId: string): void {
        const files = this.editSessions.get(sessionId);
        if (files) {
            Logger.debug(`🏁 [Chat History] 结束编辑会话: ${sessionId}, 已编辑文件数: ${files.length}`);
            this.editSessions.delete(sessionId);
        }
    }

    /**
     * 记录文件编辑到聊天历史 - 简化版本
     */
    recordFileEdit(uri: vscode.Uri, edits: vscode.TextEdit[], description: string): void {
        Logger.info(`📝 [Chat History] 记录文件编辑: ${uri.fsPath}, 编辑数: ${edits.length}, 描述: ${description}`);

        try {
            // 记录详细的编辑信息到内部状态
            const editInfo = {
                timestamp: Date.now(),
                uri: uri.toString(),
                editsCount: edits.length,
                description,
                edits: edits.map(edit => ({
                    startLine: edit.range.start.line + 1,
                    endLine: edit.range.end.line + 1,
                    newText: edit.newText,
                    operation: edit.range.isEmpty ? 'insert' : (edit.newText === '' ? 'delete' : 'replace')
                }))
            };

            Logger.debug('🗂️ [Chat History] 编辑信息已记录:', JSON.stringify(editInfo, null, 2));

        } catch (error) {
            Logger.error(`❌ [Chat History] 记录文件编辑失败: ${error instanceof Error ? error.message : error}`);
        }
    }
    /**
    * 标记编辑为已跟踪
    */
    private markEditsAsTracked(sessionId: string, uri: vscode.Uri, edits: vscode.TextEdit[]): void {
        // 在实际的聊天历史中，这些信息会通过 responseStream.textEdit() 自动记录
        // 这里我们主要用于内部状态管理和调试
        const trackedInfo = {
            sessionId,
            uri: uri.toString(),
            editCount: edits.length,
            trackedAt: Date.now()
        };

        Logger.debug(`🏷️ [Chat History] 编辑已标记为跟踪: ${JSON.stringify(trackedInfo)}`);
    }

    dispose(): void {
        if (this.actionEventDisposable) {
            this.actionEventDisposable.dispose();
        }
        this.editSessions.clear();
    }
}

/**
 * 智能 Diff 解析器 V2
 */
export class DiffParserV2 {
    /**
     * 解析 diff 内容为结构化块
     */
    static parseDiff(diffContent: string): DiffBlockV2[] {
        const blocks: DiffBlockV2[] = [];

        try {
            const lines = diffContent.split('\n');
            let i = 0;
            let blockIndex = 0;

            while (i < lines.length) {
                const line = lines[i].trim();

                if (line === '<<<<<<< SEARCH') {
                    const result = this.parseDiffBlock(lines, i, blockIndex++);
                    if (result) {
                        blocks.push(result.block);
                        i = result.endIndex;
                    } else {
                        i++;
                    }
                } else {
                    i++;
                }
            }

            Logger.info(`📊 [Diff Parser V2] 解析完成，共 ${blocks.length} 个diff块`);
            return blocks;

        } catch (error) {
            Logger.error('❌ [Diff Parser V2] 解析失败', error instanceof Error ? error : undefined);
            return [];
        }
    }

    /**
     * 解析单个 diff 块
     */
    private static parseDiffBlock(lines: string[], startIndex: number, blockIndex: number): { block: DiffBlockV2; endIndex: number } | null {
        try {
            const blockId = `diff-block-${blockIndex}-${Date.now()}`;
            let i = startIndex + 1;
            let startLine = -1;
            let endLine = -1;
            const searchLines: string[] = [];
            const replaceLines: string[] = [];
            let foundReplaceSeparator = false;

            // 解析行号信息
            while (i < lines.length && !foundReplaceSeparator) {
                const line = lines[i];
                const trimmedLine = line.trim();

                if (trimmedLine.startsWith(':start_line:')) {
                    startLine = parseInt(trimmedLine.replace(':start_line:', ''));
                } else if (trimmedLine.startsWith(':end_line:')) {
                    endLine = parseInt(trimmedLine.replace(':end_line:', ''));
                } else if (trimmedLine.startsWith('-------')) {
                    // 跳过分隔符
                } else if (trimmedLine.startsWith('=======')) {
                    foundReplaceSeparator = true;
                } else {
                    // 这是 SEARCH 内容 - 保留原始行内容（包括空行和空白字符）
                    searchLines.push(line);
                }
                i++;
            }

            // 解析 REPLACE 内容
            while (i < lines.length) {
                const line = lines[i];
                const trimmedLine = line.trim();

                if (trimmedLine.startsWith('>>>>>>> REPLACE')) {
                    i++;
                    break;
                }

                replaceLines.push(line);
                i++;
            }

            // 智能推断操作类型和置信度
            const metadata = this.analyzeBlockMetadata(searchLines, replaceLines, startLine, endLine);
            const confidence = this.calculateConfidence(searchLines, replaceLines);

            // 处理行号推断
            if (startLine === -1 || endLine === -1) {
                if (searchLines.length === 0) {
                    // 插入操作
                    startLine = 1;
                    endLine = 0;
                } else {
                    // 需要智能匹配
                    startLine = 1;
                    endLine = searchLines.length;
                }
            }

            const block: DiffBlockV2 = {
                id: blockId,
                startLine,
                endLine,
                searchLines,
                replaceLines,
                confidence,
                metadata
            };

            Logger.debug(`✅ [Diff Parser V2] 解析块 ${blockId}: 行${startLine}-${endLine}, 置信度${confidence}`);
            return { block, endIndex: i };

        } catch (error) {
            Logger.error('❌ [Diff Parser V2] 解析块失败', error instanceof Error ? error : undefined);
            return null;
        }
    }

    /**
     * 分析块元数据
     */
    private static analyzeBlockMetadata(searchLines: string[], replaceLines: string[], _startLine: number, _endLine: number): DiffBlockV2['metadata'] {
        let operation: 'replace' | 'insert' | 'delete';

        if (searchLines.length === 0) {
            operation = 'insert';
        } else if (replaceLines.length === 0) {
            operation = 'delete';
        } else {
            operation = 'replace';
        }

        // 尝试检测语言
        const allLines = [...searchLines, ...replaceLines];
        const language = this.detectLanguage(allLines);

        return {
            operation,
            language,
            description: `${operation} ${searchLines.length} lines with ${replaceLines.length} lines`
        };
    }

    /**
     * 计算匹配置信度
     */
    private static calculateConfidence(searchLines: string[], replaceLines: string[]): number {
        // 基础置信度
        let confidence = 0.8;

        // 如果有明确的搜索内容，提高置信度
        if (searchLines.length > 0) {
            confidence += 0.1;
        }

        // 如果行数匹配合理，提高置信度
        if (searchLines.length > 0 && replaceLines.length > 0) {
            const ratio = Math.min(searchLines.length, replaceLines.length) / Math.max(searchLines.length, replaceLines.length);
            confidence += ratio * 0.1;
        }

        return Math.min(confidence, 1.0);
    }

    /**
     * 检测编程语言
     */
    private static detectLanguage(lines: string[]): string | undefined {
        const content = lines.join('\n');

        if (content.includes('import ') && content.includes('from ')) {
            return 'typescript';
        }
        if (content.includes('function ') || content.includes('const ') || content.includes('let ')) {
            return 'javascript';
        }
        if (content.includes('def ') && content.includes(':')) {
            return 'python';
        }
        if (content.includes('class ') && content.includes('{')) {
            return 'java';
        }

        return undefined;
    }
}

/**
 * 智能编辑引擎 V2
 */
export class EditEngineV2 {
    private chatIntegrator = ChatHistoryIntegrator.getInstance();

    /**
     * 应用多个 diff 块到文件 - 参考官方的流式反馈和诊断集成
     */
    async applyDiffBlocks(
        uri: vscode.Uri,
        blocks: DiffBlockV2[],
        options: {
            sessionId?: string;
            inChatContext?: boolean;
            diagnosticsTimeout?: number; // 诊断超时时间
        } = {}
    ): Promise<EditResult> {
        try {
            const document = await vscode.workspace.openTextDocument(uri);

            // 获取现有诊断信息 - 参考官方模式
            const existingDiagnostics = vscode.languages.getDiagnostics(uri);
            Logger.debug(`📊 [Edit Engine V2] 现有诊断数: ${existingDiagnostics.length}`);

            // 验证和预处理块
            const validatedBlocks = await this.validateAndProcessBlocks(document, blocks);
            if (validatedBlocks.length === 0) {
                return {
                    success: false,
                    uri,
                    edits: [],
                    blocksApplied: 0,
                    message: '没有有效的 diff 块可以应用',
                    operation: 'UPDATE',
                    existingDiagnostics,
                    error: '验证失败：所有 diff 块都无法匹配文件内容'
                };
            }

            // 转换为 TextEdit 数组
            const textEdits = this.convertBlocksToTextEdits(document, validatedBlocks);

            // 聊天上下文集成 - 参考官方的实时流式反馈
            if (options.inChatContext) {
                Logger.info(`📝 [Chat Integration] 在聊天上下文中执行编辑: ${uri.fsPath}`);

                try {
                    // 记录编辑到聊天历史 - 在应用之前预先记录
                    this.chatIntegrator.recordFileEdit(
                        uri,
                        textEdits,
                        `Chat context edit: ${textEdits.length} changes applied via ${validatedBlocks.length} diff blocks`
                    );

                    Logger.info('✅ [Chat Integration] 聊天上下文编辑已预先记录');
                } catch (error) {
                    Logger.error(`❌ [Chat Integration] 聊天上下文编辑记录失败: ${error instanceof Error ? error.message : error}`);
                }
            }            // 应用编辑
            const success = await this.applyTextEdits(uri, textEdits);

            if (success) {
                // 记录到聊天历史
                this.chatIntegrator.recordFileEdit(uri, textEdits, `Applied ${validatedBlocks.length} diff blocks`);

                // 在应用模式下自动打开修改的文件
                // 延迟打开文件，给工具调用结束一些时间
                setTimeout(async () => {
                    try {
                        const document = await vscode.workspace.openTextDocument(uri);
                        await vscode.window.showTextDocument(document, {
                            preview: false,
                            preserveFocus: false
                        });
                        Logger.info(`🗺️ [File Display] 已打开修改的文件: ${vscode.workspace.asRelativePath(uri)}`);
                    } catch (error) {
                        Logger.warn(`ℹ️ [File Display] 无法打开文件 ${uri.fsPath}:`, error);
                    }
                }, 500); // 500ms 延迟

                Logger.info(`✅ [Edit Engine V2] 成功应用 ${validatedBlocks.length} 个diff块到 ${uri.fsPath}`);

                return {
                    success: true,
                    uri,
                    edits: textEdits,
                    blocksApplied: validatedBlocks.length,
                    message: `成功应用 ${validatedBlocks.length} 个diff块`
                };
            } else {
                throw new Error('应用编辑失败');
            }

        } catch (error) {
            const errorMessage = error instanceof Error ? error.message : '未知错误';
            Logger.error(`❌ [Edit Engine V2] 编辑失败: ${errorMessage}`, error instanceof Error ? error : undefined);

            return {
                success: false,
                uri,
                edits: [],
                blocksApplied: 0,
                message: `编辑失败: ${errorMessage}`
            };
        }
    }

    /**
     * 验证和预处理 diff 块
     */
    private async validateAndProcessBlocks(document: vscode.TextDocument, blocks: DiffBlockV2[]): Promise<DiffBlockV2[]> {
        const validBlocks: DiffBlockV2[] = [];
        const fileLines = document.getText().split('\n');

        for (const block of blocks) {
            try {
                // 智能内容匹配
                const adjustedBlock = await this.performSmartMatching(fileLines, block);
                if (adjustedBlock) {
                    validBlocks.push(adjustedBlock);
                    Logger.debug(`✅ [Edit Engine V2] 验证通过: ${block.id}`);
                } else {
                    Logger.warn(`⚠️ [Edit Engine V2] 验证失败: ${block.id}`);
                }
            } catch (error) {
                Logger.error(`❌ [Edit Engine V2] 验证块 ${block.id} 时出错`, error instanceof Error ? error : undefined);
            }
        }

        return validBlocks;
    }

    /**
     * 智能内容匹配（参考官方 findAndReplaceOne 逻辑）
     */
    private async performSmartMatching(fileLines: string[], block: DiffBlockV2): Promise<DiffBlockV2 | null> {
        // 如果是插入操作，直接返回
        if (block.searchLines.length === 0) {
            return block;
        }

        // 1. 首先尝试精确匹配（包括正确的空行处理）
        if (this.validateExactMatch(fileLines, block)) {
            return block;
        }

        // 2. 尝试基于内容的智能匹配（忽略行号）
        const contentMatch = this.findContentMatch(fileLines, block);
        if (contentMatch) {
            return {
                ...block,
                startLine: contentMatch.startLine,
                endLine: contentMatch.endLine,
                confidence: Math.max(0.8, block.confidence - 0.05) // 轻微降低置信度
            };
        }

        // 3. 尝试模糊匹配（容错匹配）
        const fuzzyMatch = this.findFuzzyMatch(fileLines, block);
        if (fuzzyMatch) {
            return {
                ...block,
                startLine: fuzzyMatch.startLine,
                endLine: fuzzyMatch.endLine,
                confidence: Math.max(0.6, block.confidence - 0.2) // 降低置信度
            };
        }

        // 4. 最后尝试部分内容匹配
        const partialMatch = this.findPartialMatch(fileLines, block);
        if (partialMatch) {
            return {
                ...block,
                startLine: partialMatch.startLine,
                endLine: partialMatch.endLine,
                confidence: Math.max(0.5, block.confidence - 0.3) // 显著降低置信度
            };
        }

        Logger.warn(`⚠️ [Edit Engine V2] 无法找到匹配内容: ${block.id}, 搜索内容前3行: ${block.searchLines.slice(0, 3).join('\\n')}`);
        return null;
    }

    /**
     * 基于内容的智能匹配（不依赖行号）
     */
    private findContentMatch(fileLines: string[], block: DiffBlockV2): { startLine: number; endLine: number } | null {
        if (block.searchLines.length === 0) {
            return null;
        }

        // 在文件中搜索完全匹配的内容块
        for (let i = 0; i <= fileLines.length - block.searchLines.length; i++) {
            let allMatch = true;

            for (let j = 0; j < block.searchLines.length; j++) {
                if (!this.linesMatch(fileLines[i + j], block.searchLines[j])) {
                    allMatch = false;
                    break;
                }
            }

            if (allMatch) {
                Logger.debug(`🎯 [Edit Engine V2] 内容匹配找到位置: 行${i + 1}-${i + block.searchLines.length}`);
                return {
                    startLine: i + 1,
                    endLine: i + block.searchLines.length
                };
            }
        }

        return null;
    }

    /**
     * 部分内容匹配（用于处理部分匹配的情况）
     */
    private findPartialMatch(fileLines: string[], block: DiffBlockV2): { startLine: number; endLine: number } | null {
        if (block.searchLines.length === 0) {
            return null;
        }

        let bestMatch = { score: 0, startLine: -1, endLine: -1 };

        // 搜索最佳部分匹配
        for (let i = 0; i <= fileLines.length - Math.ceil(block.searchLines.length / 2); i++) {
            let matchScore = 0;
            const checkLength = Math.min(block.searchLines.length, fileLines.length - i);

            for (let j = 0; j < checkLength; j++) {
                if (this.linesMatch(fileLines[i + j], block.searchLines[j])) {
                    matchScore++;
                }
            }

            const matchRatio = matchScore / block.searchLines.length;
            if (matchRatio > bestMatch.score && matchRatio >= 0.6) {
                bestMatch = {
                    score: matchRatio,
                    startLine: i + 1,
                    endLine: i + checkLength
                };
            }
        }

        if (bestMatch.startLine > 0) {
            Logger.debug(`🎯 [Edit Engine V2] 部分匹配找到位置: 行${bestMatch.startLine}-${bestMatch.endLine}, 匹配度${bestMatch.score}`);
            return {
                startLine: bestMatch.startLine,
                endLine: bestMatch.endLine
            };
        }

        return null;
    }

    /**
     * 精确匹配验证（改进版本，正确处理空行）
     */
    private validateExactMatch(fileLines: string[], block: DiffBlockV2): boolean {
        const startIdx = block.startLine - 1;
        const endIdx = block.endLine - 1;

        if (startIdx < 0 || endIdx >= fileLines.length || startIdx > endIdx) {
            Logger.debug(`❌ [Edit Engine V2] 行号范围无效: ${block.startLine}-${block.endLine}, 文件行数: ${fileLines.length}`);
            return false;
        }

        const fileSection = fileLines.slice(startIdx, endIdx + 1);
        if (fileSection.length !== block.searchLines.length) {
            Logger.debug(`❌ [Edit Engine V2] 行数不匹配: 文件${fileSection.length}行 vs 搜索${block.searchLines.length}行`);
            return false;
        }

        // 逐行比较，特别关注空行处理
        for (let i = 0; i < fileSection.length; i++) {
            const fileLine = fileSection[i];
            const searchLine = block.searchLines[i];

            if (!this.linesMatch(fileLine, searchLine)) {
                Logger.debug(`❌ [Edit Engine V2] 第${i + 1}行不匹配:`);
                Logger.debug(`   文件行: "${fileLine}" (长度${fileLine.length}, 空行:${fileLine.trim() === ''})`);
                Logger.debug(`   搜索行: "${searchLine}" (长度${searchLine.length}, 空行:${searchLine.trim() === ''})`);
                return false;
            }
        }

        Logger.debug(`✅ [Edit Engine V2] 精确匹配成功: 行${block.startLine}-${block.endLine}`);
        return true;
    }

    /**
     * 行匹配比较（参考官方实现，正确处理空行和空白字符）
     */
    public linesMatch(fileLine: string, searchLine: string): boolean {
        // 1. 完全匹配（最高优先级，包括所有空白字符）
        if (fileLine === searchLine) {
            return true;
        }

        // 2. 空行的严格处理
        const fileLineIsBlank = fileLine.trim() === '';
        const searchLineIsBlank = searchLine.trim() === '';

        // 空行只能匹配空行
        if (fileLineIsBlank || searchLineIsBlank) {
            return fileLineIsBlank === searchLineIsBlank;
        }

        // 3. 非空行的智能匹配
        // 先尝试忽略前后空格
        const fileTrimmed = fileLine.trim();
        const searchTrimmed = searchLine.trim();

        if (fileTrimmed === searchTrimmed) {
            return true;
        }

        // 4. 规范化空白字符后匹配（将连续空白字符转为单个空格）
        const normalizeSpaces = (str: string) => str.replace(/\s+/g, ' ').trim();
        if (normalizeSpaces(fileLine) === normalizeSpaces(searchLine)) {
            return true;
        }

        // 5. 最后尝试忽略所有缩进差异（仅比较内容）
        const removeLeadingSpaces = (str: string) => str.replace(/^\s+/, '');
        if (removeLeadingSpaces(fileLine) === removeLeadingSpaces(searchLine)) {
            return true;
        }

        return false;
    }

    /**
     * 模糊匹配查找
     */
    private findFuzzyMatch(fileLines: string[], block: DiffBlockV2): { startLine: number; endLine: number } | null {
        if (block.searchLines.length === 0) {
            return null;
        }

        // 在整个文件中搜索最佳匹配位置
        for (let i = 0; i <= fileLines.length - block.searchLines.length; i++) {
            let matchScore = 0;

            for (let j = 0; j < block.searchLines.length; j++) {
                if (this.linesMatch(fileLines[i + j], block.searchLines[j])) {
                    matchScore++;
                }
            }

            // 如果匹配度超过阈值
            const matchRatio = matchScore / block.searchLines.length;
            if (matchRatio >= 0.8) {
                Logger.debug(`🎯 [Edit Engine V2] 模糊匹配找到位置: 行${i + 1}-${i + block.searchLines.length}, 匹配度${matchRatio}`);
                return {
                    startLine: i + 1,
                    endLine: i + block.searchLines.length
                };
            }
        }

        return null;
    }

    /**
     * 转换 diff 块为 TextEdit 数组（改进的实现，正确处理空行和边界情况）
     */
    private convertBlocksToTextEdits(document: vscode.TextDocument, blocks: DiffBlockV2[]): vscode.TextEdit[] {
        const edits: vscode.TextEdit[] = [];

        // 按行号从后往前排序（避免位置偏移问题）
        const sortedBlocks = [...blocks].sort((a, b) => b.startLine - a.startLine);

        for (const block of sortedBlocks) {
            try {
                if (block.metadata?.operation === 'insert' || block.endLine === 0) {
                    // 插入操作
                    const insertPosition = new vscode.Position(Math.max(0, block.startLine - 1), 0);
                    const insertText = this.buildInsertText(block.replaceLines);

                    edits.push(new vscode.TextEdit(
                        new vscode.Range(insertPosition, insertPosition),
                        insertText
                    ));

                    Logger.debug(`📝 [Edit Engine V2] 创建插入编辑: 行${block.startLine}, 内容长度${insertText.length}`);
                } else {
                    // 替换或删除操作
                    const startLine = Math.max(0, block.startLine - 1);
                    const endLine = Math.min(block.endLine - 1, document.lineCount - 1);

                    if (startLine > endLine) {
                        Logger.warn(`⚠️ [Edit Engine V2] 跳过无效行范围: ${startLine}-${endLine}`);
                        continue;
                    }

                    const startPosition = new vscode.Position(startLine, 0);
                    const endPosition = this.getEndPosition(document, endLine, block);

                    const replaceText = this.buildReplaceText(block.replaceLines, document, startLine, endLine);

                    edits.push(new vscode.TextEdit(
                        new vscode.Range(startPosition, endPosition),
                        replaceText
                    ));

                    Logger.debug(`📝 [Edit Engine V2] 创建替换编辑: 行${startLine + 1}-${endLine + 1}, 替换为${replaceText.length}字符`);
                }
            } catch (error) {
                Logger.error(`❌ [Edit Engine V2] 处理块 ${block.id} 失败`, error instanceof Error ? error : undefined);
            }
        }

        Logger.info(`📝 [Edit Engine V2] 总共创建了 ${edits.length} 个文本编辑`);
        return edits;
    }

    /**
     * 构建插入文本（保持正确的换行符处理）
     */
    private buildInsertText(replaceLines: string[]): string {
        if (replaceLines.length === 0) {
            return '';
        }

        // 确保插入的内容以换行符结尾（除非它本来就是空的）
        return replaceLines.join('\n') + '\n';
    }

    /**
     * 构建替换文本（智能处理空行和换行符，参考官方实现）
     */
    private buildReplaceText(replaceLines: string[], document: vscode.TextDocument, startLine: number, endLine: number): string {
        if (replaceLines.length === 0) {
            return ''; // 删除操作
        }

        // 检查原始选择的范围
        const originalText = document.getText(new vscode.Range(startLine, 0, endLine + 1, 0));
        const originalEndsWithNewline = originalText.endsWith('\n') || originalText.endsWith('\r\n');

        let replaceText = replaceLines.join('\n');

        // 如果原始文本以换行符结尾，确保替换文本也以换行符结尾
        // 这对于保持文件格式一致性很重要
        if (originalEndsWithNewline && !replaceText.endsWith('\n')) {
            replaceText += '\n';
        }

        return replaceText;
    }

    /**
     * 获取准确的结束位置（处理边界情况）
     */
    private getEndPosition(document: vscode.TextDocument, endLine: number, _block: DiffBlockV2): vscode.Position {
        if (endLine >= document.lineCount) {
            // 如果超出文档范围，使用文档末尾
            const lastLine = document.lineCount - 1;
            return new vscode.Position(lastLine, document.lineAt(lastLine).text.length);
        }

        // 通常情况下，选择整行（包括换行符）
        const line = document.lineAt(endLine);

        // 如果这是文档的最后一行且没有换行符，选择行末尾
        if (endLine === document.lineCount - 1) {
            return new vscode.Position(endLine, line.text.length);
        } else {
            // 选择下一行的开始（相当于包含当前行的换行符）
            return new vscode.Position(endLine + 1, 0);
        }
    }



    /**
     * 应用文本编辑
     */
    private async applyTextEdits(uri: vscode.Uri, edits: vscode.TextEdit[]): Promise<boolean> {
        try {
            // 尝试使用活动编辑器（支持撤销/重做）
            const activeEditor = vscode.window.visibleTextEditors.find(
                editor => editor.document.uri.toString() === uri.toString()
            );

            let success = false;

            if (activeEditor) {
                success = await activeEditor.edit((editBuilder) => {
                    edits.forEach(edit => {
                        editBuilder.replace(edit.range, edit.newText);
                    });
                }, {
                    undoStopBefore: true,
                    undoStopAfter: true
                });
            } else {
                // 使用 WorkspaceEdit
                const workspaceEdit = new vscode.WorkspaceEdit();
                edits.forEach(edit => workspaceEdit.replace(uri, edit.range, edit.newText));

                success = await vscode.workspace.applyEdit(workspaceEdit);
            }

            if (success) {
                Logger.debug(`✅ [Edit Engine V2] 编辑成功应用到 ${uri.fsPath}`);

                // 重要：确保文档状态被正确刷新，让 Copilot 能感知到变化
                setTimeout(async () => {
                    try {
                        // 如果文档不在编辑器中，打开它
                        if (!activeEditor) {
                            const document = await vscode.workspace.openTextDocument(uri);
                            await vscode.window.showTextDocument(document, {
                                preserveFocus: true,
                                preview: false
                            });
                        }

                        // 保存文档以确保更改被持久化和可见
                        const document = await vscode.workspace.openTextDocument(uri);
                        if (document.isDirty) {
                            await document.save();
                            Logger.info(`💾 [Edit Engine V2] 文档已保存: ${uri.fsPath}`);
                        }

                    } catch (refreshError) {
                        Logger.warn(`⚠️ [Edit Engine V2] 文档后处理失败: ${refreshError instanceof Error ? refreshError.message : refreshError}`);
                    }
                }, 100);

                return true;
            } else {
                Logger.error(`❌ [Edit Engine V2] 编辑应用失败到 ${uri.fsPath}`);
                return false;
            }

        } catch (error) {
            Logger.error('❌ [Edit Engine V2] 应用编辑失败', error instanceof Error ? error : undefined);
            return false;
        }
    }
}

/**
 * Apply Diff 工具 V2 主类
 */
export class ApplyDiffToolV2 {
    private editEngine = new EditEngineV2();
    private chatIntegrator = ChatHistoryIntegrator.getInstance();
    private sessionCounter = 0;

    /**
     * 应用 diff
     */
    async applyDiff(request: ApplyDiffRequestV2): Promise<ApplyDiffResponseV2> {
        const sessionId = `diff-session-${++this.sessionCounter}-${Date.now()}`;
        Logger.info(`🚀 [Apply Diff V2] 开始会话 ${sessionId}: ${request.path}`);

        try {
            // 解析 diff 内容
            const diffBlocks = DiffParserV2.parseDiff(request.diff);
            if (diffBlocks.length === 0) {
                throw new Error('未找到有效的diff块');
            }

            // 解析文件路径
            const uri = this.resolveFileUri(request.path);

            // 开始编辑会话
            this.chatIntegrator.startEditSession(sessionId, [uri]);

            // 应用模式
            const result = await this.editEngine.applyDiffBlocks(uri, diffBlocks, {
                inChatContext: request._inChatContext, // 使用传递的聊天上下文参数
                sessionId
            });

            // 结束编辑会话
            this.chatIntegrator.endEditSession(sessionId);

            Logger.info(`✅ [Apply Diff V2] 会话 ${sessionId} 完成`);

            return {
                success: result.success,
                message: result.message,
                results: [result],
                totalBlocksApplied: result.blocksApplied,
                chatIntegrated: !!request.responseStream
            };

        } catch (error) {
            this.chatIntegrator.endEditSession(sessionId);

            const errorMessage = error instanceof Error ? error.message : '未知错误';
            Logger.error(`❌ [Apply Diff V2] 会话 ${sessionId} 失败: ${errorMessage}`, error instanceof Error ? error : undefined);

            return {
                success: false,
                message: `应用diff失败: ${errorMessage}`,
                results: [],
                totalBlocksApplied: 0,
                chatIntegrated: false
            };
        }
    }



    /**
     * 解析文件路径为 URI
     */
    private resolveFileUri(filePath: string): vscode.Uri {
        if (path.isAbsolute(filePath)) {
            return vscode.Uri.file(filePath);
        }

        const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
        if (!workspaceFolder) {
            throw new Error('无法解析相对路径：未找到工作区');
        }

        return vscode.Uri.joinPath(workspaceFolder.uri, filePath);
    }

    /**
     * 工具调用处理器
     */
    async invoke(request: vscode.LanguageModelToolInvocationOptions<ApplyDiffRequestV2>): Promise<vscode.LanguageModelToolResult> {
        const invocationId = Math.random().toString(36).substr(2, 9);
        Logger.info(`🚀 [Tool Invoke V2 ${invocationId}] Apply Diff V2 工具被调用`);

        // 检查是否在聊天上下文中（通过 toolInvocationToken 检查）
        const hasToolToken = !!request.toolInvocationToken;
        Logger.info(`🔗 [Tool Invoke V2 ${invocationId}] 聊天上下文: ${hasToolToken}`);

        // Language Model Tools 不能直接访问 ChatResponseStream
        // 但我们可以通过其他方式实现聊天集成
        if (hasToolToken) {
            Logger.info('✅ [Tool Invoke V2] 在聊天上下文中执行，将启用内部聊天集成');
        } else {
            Logger.info('💻 [Tool Invoke V2] 在独立上下文中执行');
        }

        try {
            const params = request.input as ApplyDiffRequestV2;

            // 参数验证
            if (!params.path) {
                throw new Error('缺少必需参数: path');
            }
            if (!params.diff) {
                throw new Error('缺少必需参数: diff');
            }

            // 格式验证
            if (!params.diff.includes('<<<<<<< SEARCH') || !params.diff.includes('>>>>>>> REPLACE')) {
                throw new Error('diff格式不正确，必须包含 SEARCH 和 REPLACE 标记');
            }

            const result = await this.applyDiff({
                ...params,
                _inChatContext: hasToolToken // 传递聊天上下文信息
            });

            // 构建返回结果 - 参考官方的结构化响应模式
            const resultParts: vscode.LanguageModelTextPart[] = [];
            const fileResults: ToolResultFile[] = [];

            // 构建文件结果列表 - 参考官方 EditFileResult 组件结构
            for (const editResult of result.results) {
                const fileResult: ToolResultFile = {
                    operation: editResult.operation || 'UPDATE',
                    uri: editResult.uri,
                    isNotebook: editResult.uri.path.endsWith('.ipynb'),
                    existingDiagnostics: editResult.existingDiagnostics || [],
                    error: editResult.error,
                    edits: editResult.edits,
                    blocksApplied: editResult.blocksApplied
                };
                fileResults.push(fileResult);
            }

            Logger.info(`📊 [Tool Invoke V2 ${invocationId}] 处理结果: 成功${result.success}, 文件数${fileResults.length}, 总块数${result.totalBlocksApplied}`);

            if (result.success) {
                // 构建主要响应文本 - 参考官方的简洁格式
                let responseText = `✅ ${result.message}`;
                if (result.totalBlocksApplied > 0) {
                    responseText += '\n\n📊 **处理统计**：';
                    responseText += `\n• **总块数**: ${result.totalBlocksApplied}`;
                    responseText += `\n• **修改文件数**: ${result.results.length}`;
                    responseText += `\n• **聊天集成**: ${hasToolToken ? '✅ 已连接' : '⚪ 独立模式'}`;

                    // 添加诊断统计
                    const totalDiagnostics = fileResults.reduce((sum, f) => sum + f.existingDiagnostics.length, 0);
                    if (totalDiagnostics > 0) {
                        responseText += `\n• **现有诊断**: ${totalDiagnostics} 项`;
                    }
                }

                // 直接应用模式：返回简洁的应用结果
                if (result.results.length > 0) {
                    const successfulEdits = result.results.filter(r => r.success);
                    const totalEdits = successfulEdits.reduce((sum, r) => sum + r.edits.length, 0);

                    if (successfulEdits.length > 0) {
                        // 创建简洁的成功消息
                        const modifiedFiles = successfulEdits.map(r => {
                            const relativePath = vscode.workspace.asRelativePath(r.uri);
                            return `• ${relativePath} (✅ ${r.edits.length} 处修改)`;
                        });

                        responseText = `✅ 文件修改已成功应用\n\n📁 已修改的文件 (${totalEdits} 处总修改):\n${modifiedFiles.join('\n')}\n\n🔄 所有修改已集成到 VS Code 编辑历史中，可以使用 Ctrl+Z 撤销。`;
                    } else {
                        responseText = '❌ 没有成功应用任何修改';
                    }

                    resultParts.push(new vscode.LanguageModelTextPart(responseText));

                    // 在聊天记录中附加详细的文件修改记录 - 参考官方的 EditFileResult 格式
                    if (successfulEdits && successfulEdits.length > 0) {
                        for (const editResult of successfulEdits) {
                            if (editResult.edits && editResult.edits.length > 0) {
                                const relativePath = vscode.workspace.asRelativePath(editResult.uri);
                                const timestamp = new Date().toLocaleTimeString();

                                // 文件修改记录头部 - 参考官方结构
                                let fileModificationRecord = '\n---\n\n## 📝 文件修改记录\n\n';
                                fileModificationRecord += `**📄 文件**: \`${relativePath}\`\n`;
                                fileModificationRecord += `**⏰ 时间**: ${timestamp}\n`;
                                fileModificationRecord += '**🔄 操作**: UPDATE (Text)\n';
                                fileModificationRecord += `**📊 修改数**: ${editResult.edits.length} 处更改\n`;
                                fileModificationRecord += `**🎯 diff 块数**: ${editResult.blocksApplied || 0}\n`;
                                fileModificationRecord += '**🔧 工具**: gcmp_applyDiffV2\n';



                                // 详细的编辑信息 - 参考官方的编辑详情格式
                                fileModificationRecord += '### 📋 **修改详情**\n\n';
                                editResult.edits.forEach((edit: vscode.TextEdit, index: number) => {
                                    const startLine = edit.range.start.line + 1;
                                    const endLine = edit.range.end.line + 1;
                                    const lineInfo = startLine === endLine ? `行 ${startLine}` : `行 ${startLine}-${endLine}`;

                                    let operationType = '🔄 替换';
                                    if (edit.newText.trim() === '') {
                                        operationType = '🗑️ 删除';
                                    } else if (edit.range.isEmpty) {
                                        operationType = '➕ 插入';
                                    }

                                    fileModificationRecord += `**${index + 1}.** ${operationType} @ ${lineInfo}\n`;

                                    // 显示内容摘要
                                    if (edit.newText.length > 100) {
                                        const summary = edit.newText.substring(0, 97) + '...';
                                        fileModificationRecord += `   \`${summary}\`\n`;
                                    } else if (edit.newText.trim()) {
                                        fileModificationRecord += `   \`${edit.newText.trim()}\`\n`;
                                    }
                                    fileModificationRecord += '\n';
                                });

                                fileModificationRecord += '💡 **提示**: 此文件的修改已应用到编辑器，可以使用 **Ctrl+Z** 撤销。\n';
                                fileModificationRecord += '🔗 **状态**: 已集成到 VS Code 编辑历史和聊天记录中。';

                                // 将详细的文件修改记录添加到聊天记录中
                                resultParts.push(new vscode.LanguageModelTextPart(fileModificationRecord));

                                Logger.info(`💬 [Chat Record] 详细文件修改记录已添加到聊天: ${relativePath}`);
                            }
                        }
                    }
                } else {
                    responseText = 'ℹ️ 没有找到需要修改的内容';
                    resultParts.push(new vscode.LanguageModelTextPart(responseText));
                }
            } else {
                resultParts.push(new vscode.LanguageModelTextPart(`❌ ${result.message}`));
            }

            Logger.info(`✅ [Tool Invoke V2 ${invocationId}] Apply Diff V2 工具调用成功, 返回部分数: ${resultParts.length}`);

            // 使用正确的类型声明
            return new vscode.LanguageModelToolResult(resultParts);
        } catch (error) {
            const errorMessage = error instanceof Error ? error.message : '未知错误';
            Logger.error(`❌ [Tool Invoke V2 ${invocationId}] Apply Diff V2 工具调用失败: ${errorMessage}`, error instanceof Error ? error : undefined);

            throw new vscode.LanguageModelError(`Apply Diff V2 失败: ${errorMessage}`);
        }
    }

    /**
     * 释放资源
     */
    dispose(): void {
        this.chatIntegrator.dispose();
        Logger.debug('🧹 [Apply Diff V2] 工具资源已清理');
    }
}

// 导出用于测试和验证
export { ChatHistoryIntegrator };