/*---------------------------------------------------------------------------------------------
 *  Diff 引擎
 *  核心 diff 解析和编辑功能
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { Logger } from '../utils';

/**
 * 增强的 Diff 块接口
 */
export interface DiffBlock {
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
 * 智能 Diff 解析器
 */
export class DiffParser {
    /**
     * 解析 diff 内容为结构化块
     */
    static parseDiff(diffContent: string): DiffBlock[] {
        const blocks: DiffBlock[] = [];

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

            Logger.info(`📊 [Diff Parser] 解析完成，共 ${blocks.length} 个diff块`);
            return blocks;

        } catch (error) {
            Logger.error('❌ [Diff Parser] 解析失败', error instanceof Error ? error : undefined);
            return [];
        }
    }

    /**
     * 解析单个 diff 块
     */
    private static parseDiffBlock(lines: string[], startIndex: number, blockIndex: number): { block: DiffBlock; endIndex: number } | null {
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

            const block: DiffBlock = {
                id: blockId,
                startLine,
                endLine,
                searchLines,
                replaceLines,
                confidence,
                metadata
            };

            Logger.debug(`✅ [Diff Parser] 解析块 ${blockId}: 行${startLine}-${endLine}, 置信度${confidence}`);
            return { block, endIndex: i };

        } catch (error) {
            Logger.error('❌ [Diff Parser] 解析块失败', error instanceof Error ? error : undefined);
            return null;
        }
    }

    /**
     * 分析块元数据
     */
    private static analyzeBlockMetadata(searchLines: string[], replaceLines: string[], _startLine: number, _endLine: number): DiffBlock['metadata'] {
        let operation: 'replace' | 'insert' | 'delete';

        if (searchLines.length === 0) {
            operation = 'insert';
        } else if (replaceLines.length === 0) {
            operation = 'delete';
        } else {
            operation = 'replace';
        }

        // 简单的语言检测
        const language = this.detectLanguage(searchLines.concat(replaceLines));

        return {
            operation,
            language
        };
    }

    /**
     * 计算置信度
     */
    private static calculateConfidence(searchLines: string[], replaceLines: string[]): number {
        if (searchLines.length === 0 && replaceLines.length > 0) {
            return 0.9; // 插入操作通常比较可靠
        }

        if (searchLines.length > 0 && replaceLines.length === 0) {
            return 0.85; // 删除操作
        }

        if (searchLines.length > 0 && replaceLines.length > 0) {
            // 基于内容相似度计算
            const similarity = this.calculateContentSimilarity(searchLines, replaceLines);
            return Math.max(0.7, similarity);
        }

        return 0.5; // 默认中等置信度
    }

    /**
     * 计算内容相似度
     */
    private static calculateContentSimilarity(searchLines: string[], replaceLines: string[]): number {
        const searchText = searchLines.join(' ').replace(/\s+/g, ' ').trim();
        const replaceText = replaceLines.join(' ').replace(/\s+/g, ' ').trim();

        if (searchText === replaceText) {
            return 0.95;
        }

        // 简单的 Levenshtein 距离近似
        const maxLen = Math.max(searchText.length, replaceText.length);
        if (maxLen === 0) return 1.0;

        const distance = this.levenshteinDistance(searchText, replaceText);
        return Math.max(0.3, 1 - (distance / maxLen));
    }

    /**
     * 计算 Levenshtein 距离
     */
    private static levenshteinDistance(str1: string, str2: string): number {
        const matrix = [];

        for (let i = 0; i <= str2.length; i++) {
            matrix[i] = [i];
        }

        for (let j = 0; j <= str1.length; j++) {
            matrix[0][j] = j;
        }

        for (let i = 1; i <= str2.length; i++) {
            for (let j = 1; j <= str1.length; j++) {
                if (str2.charAt(i - 1) === str1.charAt(j - 1)) {
                    matrix[i][j] = matrix[i - 1][j - 1];
                } else {
                    matrix[i][j] = Math.min(
                        matrix[i - 1][j - 1] + 1,
                        matrix[i][j - 1] + 1,
                        matrix[i - 1][j] + 1
                    );
                }
            }
        }

        return matrix[str2.length][str1.length];
    }

    /**
     * 简单的语言检测
     */
    private static detectLanguage(lines: string[]): string {
        const content = lines.join('\n');

        if (content.includes('function ') || content.includes('const ') || content.includes('interface ')) {
            return 'typescript';
        }
        if (content.includes('def ') || content.includes('import ') && content.includes('from ')) {
            return 'python';
        }
        if (content.includes('public class ') || content.includes('private ')) {
            return 'java';
        }
        if (content.includes('<') && content.includes('>') && content.includes('/')) {
            return 'html';
        }

        return 'plaintext';
    }
}

/**
 * 编辑引擎 - 负责将 diff 块转换为 VS Code 编辑操作
 */
export class EditEngine {
    /**
     * 验证并处理 diff 块
     */
    async validateAndProcessBlocks(document: vscode.TextDocument, blocks: DiffBlock[]): Promise<DiffBlock[]> {
        const validatedBlocks: DiffBlock[] = [];

        for (const block of blocks) {
            try {
                const validatedBlock = await this.validateBlock(document, block);
                if (validatedBlock) {
                    validatedBlocks.push(validatedBlock);
                }
            } catch (error) {
                Logger.error(`❌ [Edit Engine] 验证块 ${block.id} 失败`, error instanceof Error ? error : undefined);
            }
        }

        Logger.info(`✅ [Edit Engine] 验证完成，${validatedBlocks.length}/${blocks.length} 个块有效`);
        return validatedBlocks;
    }

    /**
     * 验证单个块
     */
    private async validateBlock(document: vscode.TextDocument, block: DiffBlock): Promise<DiffBlock | null> {
        if (block.searchLines.length === 0) {
            // 插入操作，不需要验证搜索内容
            return block;
        }

        // 尝试在文档中找到匹配的内容
        const matchResult = this.findBestMatch(document, block.searchLines);

        if (matchResult) {
            // 更新块的行号信息
            return {
                ...block,
                startLine: matchResult.startLine,
                endLine: matchResult.endLine,
                confidence: Math.max(block.confidence, matchResult.confidence)
            };
        }

        Logger.warn(`⚠️ [Edit Engine] 无法在文档中找到匹配内容: ${block.id}`);
        return null;
    }

    /**
     * 在文档中寻找最佳匹配
     */
    private findBestMatch(document: vscode.TextDocument, searchLines: string[]): { startLine: number; endLine: number; confidence: number } | null {
        const searchText = searchLines.join('\n').trim();
        const documentText = document.getText();

        // 精确匹配
        if (documentText.includes(searchText)) {
            const lines = documentText.split('\n');
            for (let i = 0; i <= lines.length - searchLines.length; i++) {
                const candidate = lines.slice(i, i + searchLines.length).join('\n').trim();
                if (candidate === searchText) {
                    return {
                        startLine: i,
                        endLine: i + searchLines.length - 1,
                        confidence: 1.0
                    };
                }
            }
        }

        // 模糊匹配
        return this.fuzzyMatch(document, searchLines);
    }

    /**
     * 模糊匹配
     */
    private fuzzyMatch(document: vscode.TextDocument, searchLines: string[]): { startLine: number; endLine: number; confidence: number } | null {
        const lines = document.getText().split('\n');
        let bestMatch: { startLine: number; endLine: number; confidence: number } | null = null;

        for (let i = 0; i <= lines.length - searchLines.length; i++) {
            const candidate = lines.slice(i, i + searchLines.length);
            const similarity = this.calculateSimilarity(searchLines, candidate);

            if (similarity > 0.7 && (!bestMatch || similarity > bestMatch.confidence)) {
                bestMatch = {
                    startLine: i,
                    endLine: i + searchLines.length - 1,
                    confidence: similarity
                };
            }
        }

        return bestMatch;
    }

    /**
     * 计算相似度
     */
    private calculateSimilarity(lines1: string[], lines2: string[]): number {
        if (lines1.length !== lines2.length) {
            return 0;
        }

        let totalSimilarity = 0;
        for (let i = 0; i < lines1.length; i++) {
            const line1 = lines1[i].trim();
            const line2 = lines2[i].trim();

            if (line1 === line2) {
                totalSimilarity += 1;
            } else {
                // 简化的相似度计算
                const similarity = this.stringSimilarity(line1, line2);
                totalSimilarity += similarity;
            }
        }

        return totalSimilarity / lines1.length;
    }

    /**
     * 字符串相似度
     */
    private stringSimilarity(str1: string, str2: string): number {
        const maxLen = Math.max(str1.length, str2.length);
        if (maxLen === 0) return 1;

        const distance = this.levenshteinDistance(str1, str2);
        return 1 - (distance / maxLen);
    }

    /**
     * Levenshtein 距离计算
     */
    private levenshteinDistance(str1: string, str2: string): number {
        const matrix = [];

        for (let i = 0; i <= str2.length; i++) {
            matrix[i] = [i];
        }

        for (let j = 0; j <= str1.length; j++) {
            matrix[0][j] = j;
        }

        for (let i = 1; i <= str2.length; i++) {
            for (let j = 1; j <= str1.length; j++) {
                if (str2.charAt(i - 1) === str1.charAt(j - 1)) {
                    matrix[i][j] = matrix[i - 1][j - 1];
                } else {
                    matrix[i][j] = Math.min(
                        matrix[i - 1][j - 1] + 1,
                        matrix[i][j - 1] + 1,
                        matrix[i - 1][j] + 1
                    );
                }
            }
        }

        return matrix[str2.length][str1.length];
    }

    /**
     * 将验证的块转换为 TextEdit 数组
     */
    convertBlocksToTextEdits(document: vscode.TextDocument, blocks: DiffBlock[]): vscode.TextEdit[] {
        const edits: vscode.TextEdit[] = [];

        for (const block of blocks) {
            try {
                let edit: vscode.TextEdit;

                if (block.searchLines.length === 0) {
                    // 插入操作
                    const insertPosition = new vscode.Position(block.startLine, 0);
                    const insertText = this.buildInsertText(block.replaceLines);
                    edit = vscode.TextEdit.insert(insertPosition, insertText);
                } else {
                    // 替换或删除操作
                    const startPos = new vscode.Position(block.startLine, 0);
                    const endPos = this.getEndPosition(document, block.endLine, block);
                    const range = new vscode.Range(startPos, endPos);
                    const replaceText = this.buildReplaceText(block.replaceLines, document, block.startLine, block.endLine);
                    edit = vscode.TextEdit.replace(range, replaceText);
                }

                edits.push(edit);
                Logger.debug(`✅ [Edit Engine] 创建编辑操作: ${block.metadata?.operation} 在行 ${block.startLine}-${block.endLine}`);

            } catch (error) {
                Logger.error(`❌ [Edit Engine] 处理块 ${block.id} 失败`, error instanceof Error ? error : undefined);
            }
        }

        Logger.info(`📝 [Edit Engine] 总共创建了 ${edits.length} 个文本编辑`);
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
     * 构建替换文本（智能处理空行和换行符）
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
        if (originalEndsWithNewline && !replaceText.endsWith('\n')) {
            replaceText += '\n';
        }

        return replaceText;
    }

    /**
     * 获取准确的结束位置（处理边界情况）
     */
    private getEndPosition(document: vscode.TextDocument, endLine: number, _block: DiffBlock): vscode.Position {
        if (endLine >= document.lineCount) {
            // 如果超出文档范围，使用文档末尾
            const lastLine = document.lineCount - 1;
            const lastLineLength = document.lineAt(lastLine).text.length;
            return new vscode.Position(lastLine, lastLineLength);
        }

        // 正常情况下，使用行的末尾
        const lineLength = document.lineAt(endLine).text.length;
        return new vscode.Position(endLine, lineLength);
    }
}