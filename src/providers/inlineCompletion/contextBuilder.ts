/*---------------------------------------------------------------------------------------------
 *  上下文构建器
 *  提取和构建补全所需的上下文信息
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { CompletionContext } from './types';

/**
 * 上下文构建器
 */
export class ContextBuilder {
    /**
     * 构建补全上下文
     */
    static buildContext(
        document: vscode.TextDocument,
        position: vscode.Position,
        maxLines = 50
    ): CompletionContext {
        const startLine = Math.max(0, position.line - maxLines);
        const endLine = Math.min(document.lineCount - 1, position.line + maxLines);

        // 获取前缀（光标前的代码）
        const prefixRange = new vscode.Range(startLine, 0, position.line, position.character);
        const prefix = document.getText(prefixRange);

        // 获取后缀（光标后的代码）
        const suffixRange = new vscode.Range(
            position.line,
            position.character,
            endLine,
            document.lineAt(endLine).text.length
        );
        const suffix = document.getText(suffixRange);

        // 获取当前行
        const currentLine = document.lineAt(position.line).text;
        const textBeforeCursor = currentLine.substring(0, position.character);
        const textAfterCursor = currentLine.substring(position.character);

        // 提取额外上下文信息
        const imports = this.extractImports(document);
        const currentScope = this.extractCurrentScope(document, position);
        const documentation = this.extractDocumentation(document, position);

        return {
            prefix,
            suffix,
            currentLine,
            textBeforeCursor,
            textAfterCursor,
            imports,
            currentScope,
            documentation,
            languageId: document.languageId,
            documentUri: document.uri.toString(),
            position
        };
    }

    /**
     * 提取文件开头的 import/require 语句
     */
    private static extractImports(document: vscode.TextDocument): string {
        const maxImportLines = 30;
        const imports: string[] = [];
        const languageId = document.languageId;

        for (let i = 0; i < Math.min(maxImportLines, document.lineCount); i++) {
            const line = document.lineAt(i).text.trim();

            // JavaScript/TypeScript imports
            if (/^(import|export)\s+/i.test(line) || /^(const|let|var)\s+.*=\s*require\(/.test(line)) {
                imports.push(line);
            }
            // Python imports
            else if (languageId === 'python' && /^(import|from)\s+/.test(line)) {
                imports.push(line);
            }
            // Java/C# imports
            else if (/^(using|import)\s+/.test(line)) {
                imports.push(line);
            }
            // Go imports
            else if (languageId === 'go' && line.startsWith('import')) {
                imports.push(line);
            }
            // 如果遇到非导入/注释的实质性代码，停止
            else if (line && !line.startsWith('//') && !line.startsWith('/*') && !line.startsWith('*')) {
                if (imports.length > 0) {
                    break;
                }
            }
        }

        return imports.length > 0 ? imports.join('\n') : '';
    }

    /**
     * 提取当前作用域（函数/类/方法签名）
     */
    private static extractCurrentScope(document: vscode.TextDocument, position: vscode.Position): string {
        const scopes: string[] = [];
        let braceCount = 0;

        // 向上扫描，找出包含当前位置的函数/类定义
        for (let i = position.line; i >= Math.max(0, position.line - 50); i--) {
            const line = document.lineAt(i).text;
            const trimmedLine = line.trim();

            // 匹配函数/方法/类定义（多语言支持）
            const patterns = [
                /^(export\s+)?(async\s+)?(function|const|let|var)\s+\w+\s*[=:]?\s*\(.*\)/,
                /^(public|private|protected|static|async)*\s*\w+\s*\(.*\)\s*[:{]/,
                /^(export\s+)?(class|interface|type)\s+\w+/,
                /^def\s+\w+\s*\(/,
                /^class\s+\w+/
            ];

            for (const pattern of patterns) {
                if (pattern.test(trimmedLine)) {
                    scopes.push(trimmedLine);
                    break;
                }
            }

            // 追踪花括号层级
            braceCount += (line.match(/{/g) || []).length;
            braceCount -= (line.match(/}/g) || []).length;

            if (scopes.length > 0 && braceCount === 0 && i < position.line) {
                break;
            }
        }

        return scopes.join('\n');
    }

    /**
     * 提取相关的文档注释（JSDoc、docstring 等）
     */
    private static extractDocumentation(document: vscode.TextDocument, position: vscode.Position): string {
        const docs: string[] = [];
        let inBlockComment = false;

        // 向上扫描，找最近的文档注释
        for (let i = position.line - 1; i >= Math.max(0, position.line - 10); i--) {
            const line = document.lineAt(i).text.trim();

            // JSDoc/块注释结束
            if (line.startsWith('/**') || line.startsWith('/*')) {
                inBlockComment = true;
                docs.unshift(line);
            }
            // 块注释内容
            else if (inBlockComment && (line.startsWith('*') || line.includes('*/'))) {
                docs.unshift(line);
                if (line.includes('*/')) {
                    break;
                }
            }
            // 行注释
            else if (line.startsWith('//') || line.startsWith('#')) {
                docs.unshift(line);
            }
            // Python docstring
            else if (line.startsWith('"""') || line.startsWith('\'\'\'')) {
                docs.unshift(line);
                if (line.endsWith('"""') || line.endsWith('\'\'\'')) {
                    break;
                }
            }
            // 遇到代码行，停止
            else if (line && !inBlockComment) {
                break;
            }
        }

        return docs.length > 0 ? docs.join('\n') : '';
    }

    /**
     * 构建提示词
     */
    static buildPrompt(context: CompletionContext, config: { maxCompletionLength: number }): string {
        const { prefix, suffix, languageId, imports, currentScope, documentation } = context;

        // 语言特定的语法提示
        const syntaxHints = this.getLanguageSyntaxHints(languageId);

        // 构建增强的上下文部分
        let enhancedContext = '';

        if (imports) {
            enhancedContext += `\n文件依赖导入：\n${imports}\n`;
        }

        if (currentScope) {
            enhancedContext += `\n当前作用域：\n${currentScope}\n`;
        }

        if (documentation) {
            enhancedContext += `\n相关文档注释：\n${documentation}\n`;
        }

        // 分析 suffix 中的闭合符号
        let suffixHint = '';
        if (suffix.trim()) {
            const firstSuffixChar = suffix.trimStart()[0];
            if (firstSuffixChar === ')' || firstSuffixChar === ']' || firstSuffixChar === '}') {
                suffixHint = `\n重要：光标后紧跟闭合符号 "${firstSuffixChar}"，你的补全内容不应包含这个符号`;
            }
        }

        return `你是一个专业的${languageId}代码补全助手。
请根据上下文为光标位置生成代码补全建议。

核心规则：
1. 只返回<CURSOR>位置之后需要补全的新代码
2. 不要重复<CURSOR>之前已经存在的代码
3. 不要重复<CURSOR>之后已经存在的代码
4. 不要包含任何解释、注释或代码块标记
5. 直接输出补全的代码内容
6. 确保语法正确，括号、引号等符号成对匹配
7. 保持正确的缩进
${syntaxHints}${suffixHint}
${enhancedContext}

当前代码上下文：
\`\`\`${languageId}
${prefix}<CURSOR>${suffix}
\`\`\`

请为 <CURSOR> 位置生成语法正确的补全建议（最大长度：${config.maxCompletionLength}字符）：`;
    }

    /**
     * 获取语言特定的语法提示
     */
    private static getLanguageSyntaxHints(languageId: string): string {
        const hints: Record<string, string> = {
            'javascript': '8. 注意 JavaScript 语法：正确使用分号、箭头函数、模板字符串',
            'typescript': '8. 注意 TypeScript 语法：正确使用类型注解、接口、泛型',
            'python': '8. 注意 Python 语法：正确使用缩进（4空格）、冒号、括号',
            'java': '8. 注意 Java 语法：正确使用分号、花括号、类型声明',
            'cpp': '8. 注意 C++ 语法：正确使用分号、命名空间、指针和引用',
            'csharp': '8. 注意 C# 语法：正确使用分号、花括号、LINQ 表达式',
            'go': '8. 注意 Go 语法：不使用分号、正确处理错误返回值',
            'rust': '8. 注意 Rust 语法：正确使用分号、所有权、生命周期标记'
        };
        return hints[languageId] || '8. 严格遵守该语言的语法规范';
    }
}
