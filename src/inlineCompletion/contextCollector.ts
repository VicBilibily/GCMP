import * as vscode from 'vscode';
import { Logger } from '../utils/logger';

/**
 * 上下文类型枚举
 */
export enum ContextType {
    /** 当前文件内容 */
    CURRENT_FILE = 'current_file',
    /** 符号定义 */
    SYMBOLS = 'symbols',
    /** 类型定义 */
    TYPE_DEFINITIONS = 'type_definitions',
    /** 引用 */
    REFERENCES = 'references',
    /** 导入语句 */
    IMPORTS = 'imports',
    /** 相关文件 */
    RELATED_FILES = 'related_files'
}

/**
 * 上下文片段
 */
export interface ContextSnippet {
    /** 上下文类型 */
    type: ContextType;
    /** 上下文内容 */
    content: string;
    /** 来源文件 */
    source?: string;
    /** 权重（0-1） */
    weight: number;
    /** 行号范围 */
    lineRange?: { start: number; end: number };
}

/**
 * 上下文收集选项
 */
export interface ContextCollectionOptions {
    /** 是否收集符号信息 */
    includeSymbols?: boolean;
    /** 是否收集类型定义 */
    includeTypeDefinitions?: boolean;
    /** 是否收集引用 */
    includeReferences?: boolean;
    /** 是否收集导入语句 */
    includeImports?: boolean;
    /** 是否收集相关文件 */
    includeRelatedFiles?: boolean;
    /** 最大上下文行数 */
    maxContextLines?: number;
    /** 最大相关文件数 */
    maxRelatedFiles?: number;
    /** 超时时间（毫秒） */
    timeout?: number;
}

/**
 * 上下文收集器
 * 负责从 LSP 和文件系统收集代码上下文信息
 */
export class ContextCollector {
    private defaultOptions: Required<ContextCollectionOptions> = {
        includeSymbols: true,
        includeTypeDefinitions: true,
        includeReferences: false,
        includeImports: true,
        includeRelatedFiles: false,
        maxContextLines: 100,
        maxRelatedFiles: 3,
        timeout: 1000
    };

    /**
     * 收集上下文信息
     * @param document 当前文档
     * @param position 光标位置
     * @param options 收集选项
     * @returns 上下文片段数组
     */
    async collectContext(
        document: vscode.TextDocument,
        position: vscode.Position,
        options?: Partial<ContextCollectionOptions>
    ): Promise<ContextSnippet[]> {
        const opts = { ...this.defaultOptions, ...options };
        const snippets: ContextSnippet[] = [];
        const startTime = Date.now();

        try {
            // 创建超时控制
            const timeoutPromise = new Promise<never>((_, reject) => {
                setTimeout(() => reject(new Error('Context collection timeout')), opts.timeout);
            });

            // 并行收集各种上下文信息
            const contextPromises: Promise<void>[] = [];

            // 1. 收集当前文件上下文（基础）
            contextPromises.push(
                this.collectCurrentFileContext(document, position, opts, snippets)
            );

            // 2. 收集导入语句
            if (opts.includeImports) {
                contextPromises.push(
                    this.collectImports(document, snippets).catch(err => {
                        Logger.debug('收集导入语句失败:', err);
                    })
                );
            }

            // 3. 收集符号信息
            if (opts.includeSymbols) {
                contextPromises.push(
                    this.collectSymbols(document, position, snippets).catch(err => {
                        Logger.debug('收集符号信息失败:', err);
                    })
                );
            }

            // 4. 收集类型定义
            if (opts.includeTypeDefinitions) {
                contextPromises.push(
                    this.collectTypeDefinitions(document, position, snippets).catch(err => {
                        Logger.debug('收集类型定义失败:', err);
                    })
                );
            }

            // 5. 收集引用（可选，较慢）
            if (opts.includeReferences) {
                contextPromises.push(
                    this.collectReferences(document, position, snippets, opts.maxContextLines).catch(err => {
                        Logger.debug('收集引用失败:', err);
                    })
                );
            }

            // 6. 收集相关文件（可选，较慢）
            if (opts.includeRelatedFiles) {
                contextPromises.push(
                    this.collectRelatedFiles(document, snippets, opts.maxRelatedFiles).catch(err => {
                        Logger.debug('收集相关文件失败:', err);
                    })
                );
            }

            // 等待所有上下文收集完成或超时
            await Promise.race([
                Promise.all(contextPromises),
                timeoutPromise
            ]);

            const duration = Date.now() - startTime;
            Logger.debug(`上下文收集完成，耗时 ${duration}ms，共收集 ${snippets.length} 个片段`);

        } catch (error) {
            if (error instanceof Error && error.message === 'Context collection timeout') {
                Logger.warn('上下文收集超时，使用已收集的部分上下文');
            } else {
                Logger.error('上下文收集出错:', error);
            }
        }

        // 按权重排序
        return snippets.sort((a, b) => b.weight - a.weight);
    }

    /**
     * 收集当前文件上下文
     */
    private async collectCurrentFileContext(
        document: vscode.TextDocument,
        position: vscode.Position,
        options: Required<ContextCollectionOptions>,
        snippets: ContextSnippet[]
    ): Promise<void> {
        const maxLines = options.maxContextLines;
        const startLine = Math.max(0, position.line - Math.floor(maxLines * 0.7));
        const endLine = Math.min(document.lineCount - 1, position.line + Math.floor(maxLines * 0.3));

        const lines: string[] = [];
        for (let i = startLine; i <= endLine; i++) {
            lines.push(document.lineAt(i).text);
        }

        snippets.push({
            type: ContextType.CURRENT_FILE,
            content: lines.join('\n'),
            source: document.fileName,
            weight: 1.0, // 当前文件权重最高
            lineRange: { start: startLine, end: endLine }
        });
    }

    /**
     * 收集导入语句
     */
    private async collectImports(
        document: vscode.TextDocument,
        snippets: ContextSnippet[]
    ): Promise<void> {
        const imports: string[] = [];
        const importPatterns = [
            /^import\s+.*?from\s+['"].*?['"]/,  // ES6 import
            /^import\s+['"].*?['"]/,             // import statement
            /^const\s+.*?=\s+require\(['"].*?['"]\)/,  // CommonJS require
            /^from\s+.*?import\s+/,              // Python import
            /^using\s+.*?;/,                     // C# using
            /^#include\s+[<"].*?[>"]/            // C/C++ include
        ];

        for (let i = 0; i < Math.min(50, document.lineCount); i++) {
            const line = document.lineAt(i).text.trim();
            if (importPatterns.some(pattern => pattern.test(line))) {
                imports.push(line);
            }
        }

        if (imports.length > 0) {
            snippets.push({
                type: ContextType.IMPORTS,
                content: imports.join('\n'),
                source: document.fileName,
                weight: 0.8
            });
        }
    }

    /**
     * 收集光标位置的符号信息
     */
    private async collectSymbols(
        document: vscode.TextDocument,
        position: vscode.Position,
        snippets: ContextSnippet[]
    ): Promise<void> {
        try {
            // 获取当前位置的符号
            const wordRange = document.getWordRangeAtPosition(position);
            if (!wordRange) {
                return;
            }

            // 获取符号定义
            const definitions = await vscode.commands.executeCommand<vscode.Location[]>(
                'vscode.executeDefinitionProvider',
                document.uri,
                position
            );

            if (definitions && definitions.length > 0) {
                for (const def of definitions.slice(0, 3)) { // 最多取3个定义
                    const defDoc = await vscode.workspace.openTextDocument(def.uri);
                    const defRange = def.range;

                    // 扩展上下文范围（前后各5行）
                    const startLine = Math.max(0, defRange.start.line - 5);
                    const endLine = Math.min(defDoc.lineCount - 1, defRange.end.line + 5);

                    const lines: string[] = [];
                    for (let i = startLine; i <= endLine; i++) {
                        lines.push(defDoc.lineAt(i).text);
                    }

                    snippets.push({
                        type: ContextType.SYMBOLS,
                        content: lines.join('\n'),
                        source: def.uri.fsPath,
                        weight: 0.7,
                        lineRange: { start: startLine, end: endLine }
                    });
                }
            }
        } catch (error) {
            Logger.debug('收集符号定义时出错:', error);
        }
    }

    /**
     * 收集类型定义
     */
    private async collectTypeDefinitions(
        document: vscode.TextDocument,
        position: vscode.Position,
        snippets: ContextSnippet[]
    ): Promise<void> {
        try {
            const typeDefinitions = await vscode.commands.executeCommand<vscode.Location[]>(
                'vscode.executeTypeDefinitionProvider',
                document.uri,
                position
            );

            if (typeDefinitions && typeDefinitions.length > 0) {
                for (const typeDef of typeDefinitions.slice(0, 2)) { // 最多取2个类型定义
                    const typeDoc = await vscode.workspace.openTextDocument(typeDef.uri);
                    const typeRange = typeDef.range;

                    // 扩展上下文范围
                    const startLine = Math.max(0, typeRange.start.line - 3);
                    const endLine = Math.min(typeDoc.lineCount - 1, typeRange.end.line + 10);

                    const lines: string[] = [];
                    for (let i = startLine; i <= endLine; i++) {
                        lines.push(typeDoc.lineAt(i).text);
                    }

                    snippets.push({
                        type: ContextType.TYPE_DEFINITIONS,
                        content: lines.join('\n'),
                        source: typeDef.uri.fsPath,
                        weight: 0.6,
                        lineRange: { start: startLine, end: endLine }
                    });
                }
            }
        } catch (error) {
            Logger.debug('收集类型定义时出错:', error);
        }
    }

    /**
     * 收集引用（较慢，可选）
     */
    private async collectReferences(
        document: vscode.TextDocument,
        position: vscode.Position,
        snippets: ContextSnippet[],
        _maxLines: number
    ): Promise<void> {
        try {
            const references = await vscode.commands.executeCommand<vscode.Location[]>(
                'vscode.executeReferenceProvider',
                document.uri,
                position
            );

            if (references && references.length > 1) { // 排除自身
                // 只取前几个引用
                const limitedRefs = references.slice(0, 5);
                const refContents: string[] = [];

                for (const ref of limitedRefs) {
                    const refDoc = await vscode.workspace.openTextDocument(ref.uri);
                    const line = refDoc.lineAt(ref.range.start.line).text;
                    refContents.push(line);
                }

                if (refContents.length > 0) {
                    snippets.push({
                        type: ContextType.REFERENCES,
                        content: refContents.join('\n'),
                        weight: 0.4
                    });
                }
            }
        } catch (error) {
            Logger.debug('收集引用时出错:', error);
        }
    }

    /**
     * 收集相关文件（较慢，可选）
     */
    private async collectRelatedFiles(
        document: vscode.TextDocument,
        snippets: ContextSnippet[],
        maxFiles: number
    ): Promise<void> {
        try {
            // 简单策略：查找同目录下的相关文件
            const currentDir = vscode.Uri.joinPath(document.uri, '..');
            const files = await vscode.workspace.fs.readDirectory(currentDir);

            const relatedFiles = files
                .filter(([name, type]) =>
                    type === vscode.FileType.File &&
                    name !== document.uri.fsPath.split(/[/\\]/).pop() &&
                    (name.endsWith('.ts') || name.endsWith('.js') ||
                        name.endsWith('.tsx') || name.endsWith('.jsx'))
                )
                .slice(0, maxFiles);

            for (const [name] of relatedFiles) {
                const fileUri = vscode.Uri.joinPath(currentDir, name);
                const fileDoc = await vscode.workspace.openTextDocument(fileUri);

                // 只取文件的前30行作为预览
                const lines: string[] = [];
                for (let i = 0; i < Math.min(30, fileDoc.lineCount); i++) {
                    lines.push(fileDoc.lineAt(i).text);
                }

                snippets.push({
                    type: ContextType.RELATED_FILES,
                    content: lines.join('\n'),
                    source: fileUri.fsPath,
                    weight: 0.3
                });
            }
        } catch (error) {
            Logger.debug('收集相关文件时出错:', error);
        }
    }

    /**
     * 格式化上下文片段为字符串
     * @param snippets 上下文片段数组
     * @param maxLength 最大长度（字符数）
     * @returns 格式化后的上下文字符串
     */
    formatContext(snippets: ContextSnippet[], maxLength = 8000): string {
        let result = '';
        let currentLength = 0;

        for (const snippet of snippets) {
            if (currentLength >= maxLength) {
                break;
            }

            let header = '';
            switch (snippet.type) {
                case ContextType.CURRENT_FILE:
                    header = '# 当前文件上下文';
                    break;
                case ContextType.IMPORTS:
                    header = '# 导入语句';
                    break;
                case ContextType.SYMBOLS:
                    header = `# 符号定义${snippet.source ? ` (${this.getFileName(snippet.source)})` : ''}`;
                    break;
                case ContextType.TYPE_DEFINITIONS:
                    header = `# 类型定义${snippet.source ? ` (${this.getFileName(snippet.source)})` : ''}`;
                    break;
                case ContextType.REFERENCES:
                    header = '# 引用';
                    break;
                case ContextType.RELATED_FILES:
                    header = `# 相关文件${snippet.source ? ` (${this.getFileName(snippet.source)})` : ''}`;
                    break;
            }

            const section = `${header}\n${snippet.content}\n\n`;
            const remainingLength = maxLength - currentLength;

            if (section.length <= remainingLength) {
                result += section;
                currentLength += section.length;
            } else {
                // 截断内容以适应剩余长度
                const truncatedContent = snippet.content.substring(0, remainingLength - header.length - 10);
                result += `${header}\n${truncatedContent}...\n\n`;
                break;
            }
        }

        return result.trim();
    }

    /**
     * 从完整路径提取文件名
     */
    private getFileName(path: string): string {
        return path.split(/[/\\]/).pop() || path;
    }
}
