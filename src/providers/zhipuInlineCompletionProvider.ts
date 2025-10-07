/*---------------------------------------------------------------------------------------------
 *  智谱AI内联代码补全提供者
 *  使用 GLM-4.5-air 模型提供智能代码补全建议
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { ApiKeyManager, Logger, OpenAIHandler } from '../utils';
import OpenAI from 'openai';

/**
 * 智谱AI内联代码补全提供者
 */
export class ZhipuInlineCompletionProvider implements vscode.InlineCompletionItemProvider {
    private static readonly PROVIDER_KEY = 'zhipu';
    private static readonly MODEL_ID = 'glm-4.5-air';
    private static readonly BASE_URL = 'https://open.bigmodel.cn/api/coding/paas/v4';

    private readonly debounceDelay: number;
    private lastRequestTime: number = 0;
    private lastCompletionCache: Map<string, vscode.InlineCompletionItem[]> = new Map();

    constructor(debounceDelay: number = 500) {
        this.debounceDelay = debounceDelay;
        Logger.info(`智谱AI内联补全提供者已初始化，使用模型: ${ZhipuInlineCompletionProvider.MODEL_ID}`);
    }

    /**
     * 创建并激活智谱AI内联补全提供者
     */
    static createAndActivate(context: vscode.ExtensionContext): vscode.Disposable | null {
        try {
            const config = vscode.workspace.getConfiguration('gcmp');
            const debounceDelay = config.get<number>('inlineCompletion.debounceDelay', 500);
            const provider = new ZhipuInlineCompletionProvider(debounceDelay);
            const documentSelector: vscode.DocumentSelector = [{ scheme: 'file' }];
            const disposable = vscode.languages.registerInlineCompletionItemProvider(
                documentSelector,
                provider,
                {
                    displayName: '智谱AI代码补全',
                    debounceDelayMs: debounceDelay,
                    yieldTo: ['github.copilot']  // 如果 GitHub Copilot 可用，优先使用它
                }
            );
            Logger.info('智谱AI内联补全提供者注册成功');
            return disposable;
        } catch (error) {
            Logger.error('注册智谱AI内联补全提供者失败:', error instanceof Error ? error : undefined);
            return null;
        }
    }

    /**
     * 提供内联补全项
     */
    async provideInlineCompletionItems(
        document: vscode.TextDocument,
        position: vscode.Position,
        context: vscode.InlineCompletionContext,
        token: vscode.CancellationToken
    ): Promise<vscode.InlineCompletionItem[] | vscode.InlineCompletionList | null> {
        try {
            // 检查是否有API密钥
            const hasApiKey = await ApiKeyManager.hasValidApiKey(ZhipuInlineCompletionProvider.PROVIDER_KEY);
            if (!hasApiKey) {
                Logger.trace('未找到智谱AI API密钥，跳过内联补全');
                return null;
            }

            // 防抖处理
            const now = Date.now();
            if (now - this.lastRequestTime < this.debounceDelay) {
                Logger.trace('请求过于频繁，跳过内联补全');
                return null;
            }
            this.lastRequestTime = now;

            // 检查取消令牌
            if (token.isCancellationRequested) {
                return null;
            }

            // 获取配置
            const config = vscode.workspace.getConfiguration('gcmp.inlineCompletion');
            const maxLines = config.get<number>('contextLines', 50);
            const maxCompletionLength = config.get<number>('maxCompletionLength', 500);

            // 构建上下文
            const { prefix, suffix, currentLine } = this.buildContext(document, position, maxLines);

            // 检查是否应该触发补全（两层判断：快速检查 + 深入注释/字符串检测）
            if (!await this.shouldTriggerCompletion(document, currentLine, position, context)) {
                Logger.trace('不满足触发条件，跳过内联补全');
                return null;
            }

            // 生成缓存键
            const cacheKey = this.generateCacheKey(document, position, prefix);

            // 检查缓存
            if (this.lastCompletionCache.has(cacheKey)) {
                Logger.trace('使用缓存的补全结果');
                return this.lastCompletionCache.get(cacheKey)!;
            }

            Logger.trace(`正在为 ${document.languageId} 文件生成内联补全...`);

            // 构建提示词（使用增强的上下文信息）
            const { imports, currentScope, documentationComments } = this.buildContext(document, position, maxLines);
            const prompt = this.buildPrompt(
                document.languageId,
                prefix,
                suffix,
                currentLine,
                { imports, currentScope, documentationComments }
            );

            // 调用AI模型
            const completion = await this.generateCompletion(prompt, maxCompletionLength, token, prefix, suffix);

            if (!completion || token.isCancellationRequested) {
                return null;
            }

            // 创建补全项（传递当前行用于去重）
            const items = this.createCompletionItems(completion, position, document, currentLine);

            // 缓存结果
            this.lastCompletionCache.clear(); // 只保留最新的缓存
            this.lastCompletionCache.set(cacheKey, items);

            Logger.trace(`生成了 ${items.length} 个内联补全建议`);

            return {
                items,
                enableForwardStability: true
            };
        } catch (error) {
            if (error instanceof vscode.CancellationError) {
                Logger.trace('内联补全请求被取消');
            } else {
                Logger.error('生成内联补全时出错:', error instanceof Error ? error : undefined);
            }
            return null;
        }
    }

    /**
     * 构建上下文（增强版：包含 imports、作用域、文档注释等）
     */
    private buildContext(
        document: vscode.TextDocument,
        position: vscode.Position,
        maxLines: number
    ): {
        prefix: string;
        suffix: string;
        currentLine: string;
        imports: string;
        currentScope: string;
        documentationComments: string;
    } {
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

        // 提取 imports/require 语句（文件开头）
        const imports = this.extractImports(document);

        // 提取当前作用域（函数/类签名）
        const currentScope = this.extractCurrentScope(document, position);

        // 提取相关的文档注释
        const documentationComments = this.extractDocumentation(document, position);

        return { prefix, suffix, currentLine, imports, currentScope, documentationComments };
    }

    /**
     * 提取文件开头的 import/require 语句
     */
    private extractImports(document: vscode.TextDocument): string {
        const maxImportLines = 30; // 检查前30行
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
            // Go imports (stop at package declaration)
            else if (languageId === 'go' && line.startsWith('import')) {
                imports.push(line);
            }
            // 如果遇到非导入/注释的实质性代码，停止
            else if (line && !line.startsWith('//') && !line.startsWith('/*') && !line.startsWith('*')) {
                // 非空且非注释的行出现后，imports 应该结束了
                if (imports.length > 0) break;
            }
        }

        return imports.length > 0 ? imports.join('\n') : '';
    }

    /**
     * 提取当前作用域（函数/类/方法签名）
     */
    private extractCurrentScope(document: vscode.TextDocument, position: vscode.Position): string {
        const scopes: string[] = [];
        let braceCount = 0;
        let currentFunctionSignature = '';

        // 向上扫描，找出包含当前位置的函数/类定义
        for (let i = position.line; i >= Math.max(0, position.line - 50); i--) {
            const line = document.lineAt(i).text;
            const trimmedLine = line.trim();

            // 匹配函数/方法/类定义（多语言支持）
            const patterns = [
                /^(export\s+)?(async\s+)?(function|const|let|var)\s+\w+\s*[=:]?\s*\(.*\)/,  // JS/TS 函数
                /^(public|private|protected|static|async)*\s*\w+\s*\(.*\)\s*[:{]/,          // 方法
                /^(export\s+)?(class|interface|type)\s+\w+/,                                    // 类/接口
                /^def\s+\w+\s*\(/,                                                              // Python 函数
                /^class\s+\w+/,                                                                  // Python 类
            ];

            for (const pattern of patterns) {
                if (pattern.test(trimmedLine)) {
                    currentFunctionSignature = trimmedLine;
                    break;
                }
            }

            // 追踪花括号层级（判断是否在函数体内）
            braceCount += (line.match(/{/g) || []).length;
            braceCount -= (line.match(/}/g) || []).length;

            if (currentFunctionSignature && braceCount === 0 && i < position.line) {
                scopes.push(currentFunctionSignature);
                break;
            }
        }

        return scopes.join('\n');
    }

    /**
     * 提取相关的文档注释（JSDoc、docstring 等）
     */
    private extractDocumentation(document: vscode.TextDocument, position: vscode.Position): string {
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
                if (line.includes('*/')) break;
            }
            // 行注释
            else if (line.startsWith('//') || line.startsWith('#')) {
                docs.unshift(line);
            }
            // Python docstring
            else if (line.startsWith('"""') || line.startsWith("'''")) {
                docs.unshift(line);
                if (line.endsWith('"""') || line.endsWith("'''")) break;
            }
            // 遇到代码行，停止
            else if (line && !inBlockComment) {
                break;
            }
        }

        return docs.length > 0 ? docs.join('\n') : '';
    }

    /**
     * 判断是否应该触发补全（类似 GitHub Copilot 的宽松策略）
     * 返回 Promise<boolean> 以便将来扩展为异步（例如查询 semantic tokens）
     */
    private async shouldTriggerCompletion(
        document: vscode.TextDocument,
        currentLine: string,
        position: vscode.Position,
        context: vscode.InlineCompletionContext
    ): Promise<boolean> {
        // 1) 如果是显式触发（用户按下触发命令），总是允许
        const triggerKind = (context as any)?.triggerKind;
        if (triggerKind !== undefined) {
            // 假设 2 表示显式（Invoke），0/1 为自动
            if (triggerKind === 2) {
                Logger.trace('[触发检测] 显式触发，允许补全');
                return true;
            }
        }

        // 2) 分析当前行内容
        const before = currentLine.substring(0, position.character);
        const trimmedBefore = before.replace(/\s+$/, '');

        // 3) 空白行场景 - 采用宽松策略（类似 Copilot）
        if (!trimmedBefore || trimmedBefore.length === 0) {
            // 3a. 检测是否在空块内部
            const isInEmptyBlock = this.isInsideEmptyBlock(document, position);
            if (isInEmptyBlock) {
                Logger.trace('[触发检测] 检测到光标在空块内部，允许触发补全');
                return true;
            }

            // 3b. 检测上一行是否为注释（GitHub Copilot 的重要特性）
            if (position.line > 0) {
                const prevLine = document.lineAt(position.line - 1).text.trim();
                if (this.isCommentLine(prevLine, document.languageId)) {
                    Logger.trace('[触发检测] 检测到上一行是注释，允许触发补全');
                    return true;
                }
            }

            // 3c. 检测是否在有意义的代码上下文中（函数内、类内等）
            const hasCodeContext = this.hasMeaningfulCodeContext(document, position);
            if (hasCodeContext) {
                Logger.trace('[触发检测] 检测到在有意义的代码上下文中，允许触发补全');
                return true;
            }

            // 其他空白行情况 - 拒绝触发
            Logger.trace('[触发检测] 空白行且无有效上下文，拒绝触发');
            return false;
        }

        // 4) 有字符的情况 - 检查触发字符
        const lastChar = trimmedBefore[trimmedBefore.length - 1];

        // 常见触发字符（扩展列表以匹配 Copilot）
        const wordChar = /[A-Za-z0-9_$]/;  // 添加 $ 支持 jQuery/变量名
        const triggerChars = ['.', '(', '[', '{', '"', '\'', '`', ':', '<', '=', ',', ';', '/', '>', '|', '&', '+', '-', '*'];

        if (wordChar.test(lastChar) || triggerChars.includes(lastChar)) {
            return true;
        }

        // 5) 默认情况：如果在代码上下文中，也尝试触发（宽松策略）
        const hasCodeContext = this.hasMeaningfulCodeContext(document, position);
        if (hasCodeContext) {
            Logger.trace('[触发检测] 在代码上下文中，允许触发补全');
            return true;
        }

        Logger.trace('[触发检测] 不满足任何触发条件，拒绝触发');
        return false;
    }

    /**
     * 判断一行是否为注释行
     */
    private isCommentLine(line: string, languageId: string): boolean {
        if (!line) return false;

        // JavaScript/TypeScript/Java/C/C++/C#/Go 等
        if (line.startsWith('//') || line.startsWith('/*') || line.startsWith('*')) {
            return true;
        }

        // Python/Ruby/Shell
        if ((languageId === 'python' || languageId === 'ruby' || languageId === 'shell') && line.startsWith('#')) {
            return true;
        }

        // HTML/XML
        if (line.startsWith('<!--')) {
            return true;
        }

        // CSS
        if (line.startsWith('/*')) {
            return true;
        }

        return false;
    }

    /**
     * 判断当前位置是否在有意义的代码上下文中
     * （函数内、类内、块内等，而不是文件顶层）
     */
    private hasMeaningfulCodeContext(document: vscode.TextDocument, position: vscode.Position): boolean {
        // 向上扫描，查找是否在函数/类/块内部
        let braceDepth = 0;
        let parenDepth = 0;
        let foundDefinition = false;

        // 从当前位置向上扫描最多30行
        for (let i = position.line; i >= Math.max(0, position.line - 30); i--) {
            const line = document.lineAt(i).text;

            // 统计花括号和圆括号（简单统计，不考虑字符串内的）
            for (const char of line) {
                if (char === '{') braceDepth++;
                if (char === '}') braceDepth--;
                if (char === '(') parenDepth++;
                if (char === ')') parenDepth--;
            }

            const trimmedLine = line.trim();

            // 检查是否是函数/类/控制结构定义
            const definitionPatterns = [
                /^(export\s+)?(async\s+)?(function|const|let|var|class|interface)\s+/,
                /^(public|private|protected|static)\s+/,
                /^def\s+/,  // Python
                /^(if|for|while|switch|try)\s*[\(\{]/,
                /^\w+\s*\([^)]*\)\s*[{:]/,  // 方法定义
            ];

            if (definitionPatterns.some(pattern => pattern.test(trimmedLine))) {
                foundDefinition = true;
                break;
            }

            // 如果花括号深度大于0，说明在块内部
            if (braceDepth > 0) {
                return true;
            }
        }

        // 如果找到了定义且在其后面，认为有上下文
        if (foundDefinition) {
            return true;
        }

        // 检查缩进：如果当前行有缩进，可能在块内部（Python等）
        const currentLineText = document.lineAt(position.line).text;
        const leadingSpaces = currentLineText.match(/^\s*/)?.[0].length || 0;
        if (leadingSpaces >= 2) {
            // 有缩进，可能在块内部
            return true;
        }

        return false;
    }

    /**
     * 判断光标是否在空块内部（函数体、if块、循环等）
     */
    private isInsideEmptyBlock(document: vscode.TextDocument, position: vscode.Position): boolean {
        const currentLine = document.lineAt(position.line).text;

        // 当前行必须是空白行或只有缩进
        if (currentLine.trim().length > 0) {
            return false;
        }

        // 检查上一行
        if (position.line > 0) {
            const prevLine = document.lineAt(position.line - 1).text.trim();

            // 上一行以块开始符号结尾（支持多语言）
            const blockStartPatterns = [
                /\{\s*$/,           // JavaScript/TypeScript/Java/C/C++/C#/Go: {
                /:\s*$/,            // Python: :
                /\bdo\s*$/i,        // do-while: do
                /\bthen\s*$/i,      // Lua/Shell: then
                /\bbegin\s*$/i,     // Ruby: begin
            ];

            const startsBlock = blockStartPatterns.some(pattern => pattern.test(prevLine));

            if (startsBlock) {
                // 进一步检查：下一行是否是块结束符号
                if (position.line < document.lineCount - 1) {
                    const nextLine = document.lineAt(position.line + 1).text.trim();

                    const blockEndPatterns = [
                        /^\}/,          // }
                        /^\)/,          // )
                        /^\]/,          // ]
                        /^else\b/i,     // else
                        /^elif\b/i,     // elif
                        /^except\b/i,   // except
                        /^finally\b/i,  // finally
                        /^catch\b/i,    // catch
                        /^end\b/i,      // end (Ruby/Lua)
                    ];

                    const endsBlock = blockEndPatterns.some(pattern => pattern.test(nextLine));

                    if (endsBlock) {
                        Logger.trace('[空块检测] 检测到上一行开启块，下一行结束块，当前在空块内部');
                        return true;
                    }
                }

                // 即使下一行不是结束符，只要上一行开启了块，也认为是块内部
                // 这样可以支持用户在块开始后立即开始输入
                Logger.trace('[空块检测] 检测到上一行开启块，当前可能在块内部');
                return true;
            }
        }

        // 额外检查：当前位置是否在函数/方法/类定义之后
        // 向上查找最近的函数/类定义
        for (let i = position.line - 1; i >= Math.max(0, position.line - 10); i--) {
            const line = document.lineAt(i).text;
            const trimmedLine = line.trim();

            // 如果遇到了非空行但不是注释，检查是否是函数/类定义
            if (trimmedLine && !trimmedLine.startsWith('//') && !trimmedLine.startsWith('#') && !trimmedLine.startsWith('/*')) {
                // 函数/方法/类定义模式（多语言）
                const definitionPatterns = [
                    /^(export\s+)?(async\s+)?(function|const|let|var)\s+\w+.*\{\s*$/,  // JS/TS 函数
                    /^(public|private|protected|static|async)*\s*\w+\s*\([^)]*\)\s*\{\s*$/,  // 方法
                    /^(export\s+)?(class|interface)\s+\w+.*\{\s*$/,                    // 类
                    /^def\s+\w+\s*\([^)]*\)\s*:\s*$/,                                   // Python 函数
                    /^class\s+\w+.*:\s*$/,                                               // Python 类
                    /^if\s*\([^)]*\)\s*\{\s*$/,                                         // if 语句
                    /^for\s*\([^)]*\)\s*\{\s*$/,                                        // for 循环
                    /^while\s*\([^)]*\)\s*\{\s*$/,                                      // while 循环
                ];

                const isDefinition = definitionPatterns.some(pattern => pattern.test(trimmedLine));

                if (isDefinition) {
                    Logger.trace('[空块检测] 检测到上方有函数/类/控制块定义，当前在块内部');
                    return true;
                }

                // 如果遇到了其他代码行，停止向上查找
                break;
            }
        }

        return false;
    }

    /**
     * 构建提示词（增强版：利用 imports、作用域、文档注释）
     */
    private buildPrompt(
        languageId: string,
        prefix: string,
        suffix: string,
        currentLine: string,
        contextInfo: { imports: string; currentScope: string; documentationComments: string }
    ): string {
        // 获取语言特定的语法提示
        const syntaxHints = this.getLanguageSyntaxHints(languageId);

        // 构建增强的上下文部分
        let enhancedContext = '';

        if (contextInfo.imports) {
            enhancedContext += `\n文件依赖导入：\n${contextInfo.imports}\n`;
        }

        if (contextInfo.currentScope) {
            enhancedContext += `\n当前作用域：\n${contextInfo.currentScope}\n`;
        }

        if (contextInfo.documentationComments) {
            enhancedContext += `\n相关文档注释：\n${contextInfo.documentationComments}\n`;
        }

        // 分析 suffix 中的闭合符号，用于提示 AI
        let suffixHint = '';
        if (suffix.trim()) {
            const firstSuffixChar = suffix.trimStart()[0];
            if (firstSuffixChar === ')' || firstSuffixChar === ']' || firstSuffixChar === '}') {
                suffixHint = `\n9. 重要：光标后紧跟闭合符号 "${firstSuffixChar}"，你的补全内容不应包含这个符号，也不应在此符号前添加分号`;
            }
        }

        return `你是一个专业的${languageId}代码补全助手。
请根据上下文为光标位置生成代码补全建议。补全可以是多行的，但必须确保语法100%正确。

核心规则（必须严格遵守）：
1. 只返回<CURSOR>位置之后需要补全的新代码
2. 不要重复<CURSOR>之前已经存在的代码
3. 不要重复<CURSOR>之后已经存在的代码（包括闭合括号、分号等）
4. 不要包含任何解释、注释或代码块标记
5. 直接输出补全的代码内容
6. 确保括号、引号、花括号等符号成对匹配
7. 保持正确的语法结构和缩进
8. 补全内容必须能够直接插入到<CURSOR>位置
9. 参考文件依赖、当前作用域和文档注释来理解意图
10. 特别注意：如果光标后有闭合括号，不要在补全中添加分号，因为分号应该在括号外
${syntaxHints}${suffixHint}
${enhancedContext}
当前代码上下文：
\`\`\`${languageId}
${prefix}<CURSOR>${suffix}
\`\`\`

请为 <CURSOR> 位置生成语法正确的补全建议：`;
    }

    /**
     * 获取语言特定的语法提示
     */
    private getLanguageSyntaxHints(languageId: string): string {
        const hints: Record<string, string> = {
            'javascript': '8. 注意 JavaScript 语法：正确使用分号、箭头函数、模板字符串',
            'typescript': '8. 注意 TypeScript 语法：正确使用类型注解、接口、泛型',
            'python': '8. 注意 Python 语法：正确使用缩进（4空格）、冒号、括号',
            'java': '8. 注意 Java 语法：正确使用分号、花括号、类型声明',
            'cpp': '8. 注意 C++ 语法：正确使用分号、命名空间、指针和引用',
            'csharp': '8. 注意 C# 语法：正确使用分号、花括号、LINQ 表达式',
            'go': '8. 注意 Go 语法：不使用分号、正确处理错误返回值',
            'rust': '8. 注意 Rust 语法：正确使用分号、所有权、生命周期标记',
        };
        return hints[languageId] || '8. 严格遵守该语言的语法规范';
    }

    /**
     * 生成补全
     */
    private async generateCompletion(
        prompt: string,
        maxLength: number,
        token: vscode.CancellationToken,
        prefix: string,
        suffix: string = ''
    ): Promise<string | null> {
        try {
            const apiKey = await ApiKeyManager.getApiKey(ZhipuInlineCompletionProvider.PROVIDER_KEY);
            if (!apiKey) {
                return null;
            }

            // 获取温度配置，内联补全使用极低的温度以确保语法正确
            const config = vscode.workspace.getConfiguration('gcmp.inlineCompletion');
            const temperature = config.get<number>('temperature', 0.1);

            // 使用 OpenAI SDK 直接调用
            const client = new OpenAI({
                apiKey: apiKey,
                baseURL: ZhipuInlineCompletionProvider.BASE_URL
            });

            let fullCompletion = '';

            // 关闭 stream 和 thinking 模式以提高响应速度
            // 使用类型断言来支持智谱AI特定的 thinking 参数
            const response = await client.chat.completions.create({
                model: ZhipuInlineCompletionProvider.MODEL_ID,
                messages: [
                    {
                        role: 'system',
                        content: '你是一个专业的代码补全助手，专注于根据上下文生成准确、简洁的代码补全建议。'
                    },
                    {
                        role: 'user',
                        content: prompt
                    }
                ],
                max_tokens: maxLength,
                temperature: temperature,
                top_p: 1,
                stream: false,
                // 关闭思维链以提高响应速度
                thinking: {
                    type: 'disabled'
                }
            } as any);

            // 检查取消令牌
            if (token.isCancellationRequested) {
                throw new vscode.CancellationError();
            }

            fullCompletion = response.choices[0]?.message?.content || '';

            // 清理补全内容（传递 suffix 用于智能清理）
            const cleaned = this.cleanCompletion(fullCompletion, prefix, suffix);

            // 验证语法正确性
            if (!this.validateSyntax(cleaned, prefix)) {
                Logger.trace('[语法验证] 补全内容未通过语法验证，已拒绝');
                return null;
            }

            return cleaned;
        } catch (error) {
            if (error instanceof vscode.CancellationError) {
                throw error;
            }
            Logger.error('生成补全时出错:', error instanceof Error ? error : undefined);
            return null;
        }
    }

    /**
     * 清理补全结果，移除重复代码
     */
    private cleanCompletion(completion: string, prefix: string, suffix: string = ''): string {
        // 移除可能的代码块标记
        let cleaned = completion.trim();

        // 移除开头的代码块标记
        cleaned = cleaned.replace(/^```[\w]*\n?/, '');

        // 移除结尾的代码块标记
        cleaned = cleaned.replace(/\n?```$/, '');

        // 移除可能的前缀文本（如 "补全："、"建议："等）
        cleaned = cleaned.replace(/^(补全|建议|代码|completion|suggestion)[:：]\s*/i, '');

        // 移除<CURSOR>标记（如果AI返回了）
        cleaned = cleaned.replace(/<CURSOR>/g, '');

        // 获取光标前最后一行的内容（用于检测重复）
        const prefixLines = prefix.split('\n');
        const lastPrefixLine = prefixLines[prefixLines.length - 1] || '';

        // === 增强的去重算法 ===

        // 1. 逐字符匹配找出最长公共后缀（光标前）和前缀（补全开始）
        const prefixEnd = lastPrefixLine.trimEnd();
        const cleanedStart = cleaned.trimStart();

        // 找出光标前代码与补全内容的最长重叠部分
        let maxOverlap = 0;
        const maxCheckLength = Math.min(prefixEnd.length, cleanedStart.length, 100); // 限制检查长度

        for (let i = 1; i <= maxCheckLength; i++) {
            const prefixSuffix = prefixEnd.slice(-i);
            const cleanedPrefix = cleanedStart.slice(0, i);

            if (prefixSuffix === cleanedPrefix) {
                maxOverlap = i;
            }
        }

        if (maxOverlap > 0) {
            cleaned = cleanedStart.slice(maxOverlap).trimStart();
            Logger.trace(`[去重] 移除重复字符（${maxOverlap}字符）: "${prefixEnd.slice(-maxOverlap)}"`);
        } else {
            cleaned = cleanedStart;
        }

        // 2. 处理关键字重复（function, class, const, let, var, async, export 等）
        const keywords = [
            'function', 'class', 'const', 'let', 'var', 'async', 'await',
            'export', 'import', 'return', 'if', 'else', 'for', 'while',
            'def', 'public', 'private', 'protected', 'static'
        ];

        for (const keyword of keywords) {
            // 检查光标前是否有这个关键字
            const keywordPattern = new RegExp(`\\b${keyword}\\s+\\w*$`, 'i');
            if (keywordPattern.test(prefixEnd)) {
                // 检查补全是否以相同关键字开始
                const cleanedKeywordPattern = new RegExp(`^${keyword}\\b`, 'i');
                if (cleanedKeywordPattern.test(cleaned)) {
                    // 提取关键字后的部分
                    const match = cleaned.match(new RegExp(`^${keyword}\\s+(.*)$`, 'i'));
                    if (match) {
                        cleaned = match[1];
                        Logger.trace(`[去重] 移除重复关键字: "${keyword}"`);
                    }
                }
            }
        }

        // 3. 词级去重 - 检查最后1-5个词的组合
        const words = prefixEnd.split(/\s+/).filter(w => w.length > 0);
        for (let wordCount = Math.min(5, words.length); wordCount >= 1; wordCount--) {
            const lastWords = words.slice(-wordCount).join(' ');
            if (lastWords && cleaned.startsWith(lastWords)) {
                cleaned = cleaned.substring(lastWords.length).trimStart();
                Logger.trace(`[去重] 移除重复词组（${wordCount}词）: "${lastWords}"`);
                break; // 找到最长匹配后退出
            }
        }

        // 4. 特殊情况：处理方法名/函数名重复
        // 例如：光标前是 "function add"，补全不应该再包含 "add"
        const methodPattern = /\b(function|def|public|private|protected|static)\s+(\w+)\s*$/i;
        const prefixMatch = prefixEnd.match(methodPattern);
        if (prefixMatch) {
            const methodName = prefixMatch[2];
            // 如果补全以方法名开始，移除它
            if (cleaned.startsWith(methodName)) {
                cleaned = cleaned.substring(methodName.length).trimStart();
                Logger.trace(`[去重] 移除重复方法名: "${methodName}"`);
            }
        }

        // 5. 去除开头的重复标点符号（如果光标前已经有）
        const lastChar = prefixEnd.slice(-1);
        if (lastChar && /[{(\[\.,;:]/.test(lastChar) && cleaned.startsWith(lastChar)) {
            cleaned = cleaned.substring(1).trimStart();
            Logger.trace(`[去重] 移除重复标点: "${lastChar}"`);
        }

        // 6. 方法链调用去重
        // 检测类似 .toString().toString() 或 .map().map() 的重复方法链
        // 从光标前提取最后一个方法调用
        const lastMethodMatch = prefixEnd.match(/\.(\w+)\(([^)]*)\)\s*$/);
        if (lastMethodMatch) {
            const lastMethodName = lastMethodMatch[1]; // 例如 "toString"
            const lastMethodArgs = lastMethodMatch[2]; // 方法参数
            Logger.trace(`[去重] 第6层: 检测到前缀末尾的方法调用: .${lastMethodName}(${lastMethodArgs})`);

            // 检查补全内容开头是否重复了相同的方法调用
            // 使用更灵活的匹配：方法名相同即可，参数可以不同
            const duplicateMethodPattern = new RegExp(`^\\.${lastMethodName}\\s*\\([^)]*\\)`);
            const duplicateMatch = cleaned.match(duplicateMethodPattern);

            if (duplicateMatch) {
                Logger.trace(`[去重] 第6层: 删除重复的方法链调用: ${duplicateMatch[0]}`);
                cleaned = cleaned.slice(duplicateMatch[0].length).trimStart();
            }
        }

        // 额外检查：补全内容本身是否有连续重复的方法调用
        // 例如补全内容是 ".toString().toString()" 或 ".map(x => x).map(x => x)"
        const selfDuplicatePattern = /^(\.\w+\([^)]*\))\1/;
        const selfDuplicateMatch = cleaned.match(selfDuplicatePattern);
        if (selfDuplicateMatch) {
            const duplicatedChain = selfDuplicateMatch[1];
            Logger.trace(`[去重] 第6层: 检测到补全内容内部的重复方法链: ${duplicatedChain}`);
            cleaned = cleaned.slice(duplicatedChain.length).trimStart();
        }

        // 7. 处理 suffix 中的闭合符号（关键修复：防止重复闭合括号和错位分号）
        if (suffix.trim()) {
            const firstSuffixChar = suffix.trimStart()[0];
            const closingChars: Record<string, string> = { ')': ')', ']': ']', '}': '}' };

            if (firstSuffixChar in closingChars) {
                Logger.trace(`[去重] 第7层: 检测到 suffix 以闭合符号开始: "${firstSuffixChar}"`);

                // 移除补全内容末尾的重复闭合符号
                let trimmedCleaned = cleaned.trimEnd();
                if (trimmedCleaned.endsWith(firstSuffixChar)) {
                    Logger.trace(`[去重] 第7层: 移除补全末尾的重复闭合符号: "${firstSuffixChar}"`);
                    trimmedCleaned = trimmedCleaned.slice(0, -1).trimEnd();
                }

                // 关键修复：移除分号在闭合括号前的情况
                // 例如 "text";) 应该变成 "text"
                if (firstSuffixChar === ')' && trimmedCleaned.endsWith(';')) {
                    Logger.trace('[去重] 第7层: 移除括号前的错位分号');
                    trimmedCleaned = trimmedCleaned.slice(0, -1).trimEnd();
                }

                // 同样处理 );) 的情况（重复的闭合括号加分号）
                const redundantPattern = new RegExp(`\\${firstSuffixChar};?$`);
                if (redundantPattern.test(trimmedCleaned)) {
                    trimmedCleaned = trimmedCleaned.replace(redundantPattern, '').trimEnd();
                    Logger.trace('[去重] 第7层: 移除冗余的闭合符号组合');
                }

                cleaned = trimmedCleaned;
            }
        }

        const result = cleaned.trim();

        // 日志：如果去重后结果为空，记录原始补全内容
        if (!result && completion.trim()) {
            Logger.trace(`[去重警告] 去重后为空，原始补全: "${completion.trim().substring(0, 50)}..."`);
        }

        return result;
    }

    /**
     * 验证补全内容的语法正确性
     */
    private validateSyntax(completion: string, prefix: string): boolean {
        if (!completion.trim()) {
            return false;
        }

        // 1. 检查括号匹配
        const brackets = { '(': ')', '[': ']', '{': '}' };
        const stack: string[] = [];
        const openBrackets = new Set(['(', '[', '{']);
        const closeBrackets = new Set([')', ']', '}']);
        const bracketPairs: Record<string, string> = { ')': '(', ']': '[', '}': '{' };

        // 合并前缀和补全内容进行整体检查
        const combined = prefix + completion;
        let inString = false;
        let stringChar = '';
        let escaped = false;

        for (let i = 0; i < combined.length; i++) {
            const char = combined[i];

            // 处理转义字符
            if (escaped) {
                escaped = false;
                continue;
            }
            if (char === '\\') {
                escaped = true;
                continue;
            }

            // 处理字符串
            if (char === '"' || char === "'" || char === '`') {
                if (!inString) {
                    inString = true;
                    stringChar = char;
                } else if (char === stringChar) {
                    inString = false;
                    stringChar = '';
                }
                continue;
            }

            // 在字符串内部，跳过括号检查
            if (inString) {
                continue;
            }

            // 检查括号
            if (openBrackets.has(char)) {
                stack.push(char);
            } else if (closeBrackets.has(char)) {
                const expectedOpen = bracketPairs[char];
                if (stack.length === 0 || stack.pop() !== expectedOpen) {
                    Logger.trace(`[语法验证] 括号不匹配: 发现 '${char}' 但栈状态异常`);
                    return false;
                }
            }
        }

        // 2. 检查引号匹配（只检查补全部分新增的引号）
        const quoteCount: Record<string, number> = { '"': 0, "'": 0, '`': 0 };
        let lastWasEscape = false;

        for (const char of completion) {
            if (lastWasEscape) {
                lastWasEscape = false;
                continue;
            }
            if (char === '\\') {
                lastWasEscape = true;
                continue;
            }
            if (char in quoteCount) {
                quoteCount[char]++;
            }
        }

        // 引号必须成对或为0（可能在前缀中已经开始）
        for (const [quote, count] of Object.entries(quoteCount)) {
            if (count % 2 !== 0) {
                // 检查前缀中是否有未闭合的引号
                const prefixQuoteCount = (prefix.match(new RegExp(`\\${quote}`, 'g')) || []).length;
                const totalCount = prefixQuoteCount + count;
                if (totalCount % 2 !== 0) {
                    Logger.trace(`[语法验证] 引号不匹配: ${quote} 在补全中出现 ${count} 次`);
                    return false;
                }
            }
        }

        // 3. 检查是否有明显的语法错误模式
        const invalidPatterns = [
            /\)\s*\(/,  // )( - 两个括号之间没有操作符
            /\]\s*\[/,  // ][ - 两个方括号之间没有操作符
            /\}\s*\{/,  // }{ - 两个花括号之间没有操作符（某些情况除外）
            /\.\s*\./,  // .. - 连续的点（除了...）
            /;;+/,      // 连续多个分号
            /,,+/,      // 连续多个逗号
        ];

        for (const pattern of invalidPatterns) {
            if (pattern.test(completion)) {
                // 排除特殊情况
                if (pattern.source === '\\.\\s*\\.' && completion.includes('...')) {
                    continue; // 允许扩展运算符
                }
                Logger.trace(`[语法验证] 检测到可疑语法模式: ${pattern.source}`);
                return false;
            }
        }

        // 4. 检查是否以不完整的表达式结尾（针对单行补全）
        if (!completion.includes('\n')) {
            const trimmed = completion.trimEnd();
            const lastChar = trimmed.slice(-1);

            // 单行补全不应以某些符号结尾（除非是特定语境）
            const suspiciousEndings = ['+', '-', '*', '/', '&', '|', '^', '&&', '||'];
            if (suspiciousEndings.some(op => trimmed.endsWith(op))) {
                Logger.trace(`[语法验证] 单行补全以操作符结尾: ${lastChar}`);
                return false;
            }
        }

        // 5. 检查分号在括号前的情况 —— 宽松处理：尝试修复或放行
        // 例如 "text";) 或 "text";] 这种情况，早期版本会直接拒绝，
        // 导致大量有效建议被丢弃。这里改为尝试移除分号后重新验证括号匹配，
        // 若能通过则接受该补全，否则继续后续检查但不立即拒绝，以降低误判率。
        const semicolonBeforeClosing = /;\s*[\)\]\}]/;
        if (semicolonBeforeClosing.test(completion)) {
            Logger.trace('[语法验证] 检测到分号在闭合括号前，尝试宽松处理');

            // 尝试移除分号并重新验证括号匹配
            const completionNormalized = completion.replace(/;\s*([\)\]\}])/g, '$1');
            const combinedNormalized = prefix + completionNormalized;

            // 简单的括号匹配验证（忽略字符串内内容和转义）
            const stackCheck = (() => {
                const stack: string[] = [];
                const openBrackets = new Set(['(', '[', '{']);
                const bracketPairs: Record<string, string> = { ')': '(', ']': '[', '}': '{' };
                let inString = false;
                let stringChar = '';
                let escaped = false;

                for (let i = 0; i < combinedNormalized.length; i++) {
                    const ch = combinedNormalized[i];
                    if (escaped) { escaped = false; continue; }
                    if (ch === '\\') { escaped = true; continue; }
                    if (ch === '"' || ch === "'" || ch === '`') {
                        if (!inString) { inString = true; stringChar = ch; }
                        else if (ch === stringChar) { inString = false; stringChar = ''; }
                        continue;
                    }
                    if (inString) continue;
                    if (openBrackets.has(ch)) stack.push(ch);
                    else if (ch in bracketPairs) {
                        const expected = bracketPairs[ch as keyof typeof bracketPairs];
                        if (stack.length === 0 || stack.pop() !== expected) return false;
                    }
                }
                return stack.length === 0;
            })();

            if (stackCheck) {
                Logger.trace('[语法验证] 去除括号前分号后括号匹配通过，接受补全');
                // 通过此项检查，不返回 false，从而允许后续流程接受该补全
            } else {
                Logger.trace('[语法验证] 去除括号前分号后仍不匹配，继续后续检查（不立即拒绝）');
            }
        }

        // 6. 检查是否以 ");" 结尾（通常表示重复了闭合括号）
        if (/[\)\]\}];$/.test(completion.trim())) {
            Logger.trace('[语法验证] 补全以闭合括号+分号结尾，可能是重复闭合');
            // 这种情况在某些场景下是合法的（如对象字面量），所以只记录不拒绝
        }

        Logger.trace('[语法验证] 补全内容通过语法验证');
        return true;
    }

    /**
     * 创建补全项
     */
    private createCompletionItems(
        completion: string,
        position: vscode.Position,
        document: vscode.TextDocument,
        currentLine: string
    ): vscode.InlineCompletionItem[] {
        const items: vscode.InlineCompletionItem[] = [];

        if (!completion) {
            return items;
        }

        // 额外检查：确保补全不是完全重复当前行光标后的内容
        const textAfterCursor = currentLine.substring(position.character);
        if (textAfterCursor.trim() && completion.trim() === textAfterCursor.trim()) {
            Logger.trace('补全内容与光标后代码完全重复，跳过');
            return items;
        }

        // 智能判断是否需要整行替换
        const shouldReplace = this.shouldReplaceToLineEnd(completion, textAfterCursor, document.languageId);

        let range: vscode.Range;
        if (shouldReplace) {
            // 替换从光标到行尾的内容
            const lineEnd = new vscode.Position(position.line, currentLine.length);
            range = new vscode.Range(position, lineEnd);
            Logger.trace(`[整行替换] 补全将替换光标后内容: "${textAfterCursor}"`);
        } else {
            // 只在光标位置插入
            range = new vscode.Range(position, position);
        }

        // 创建主要补全项
        const insertText = completion;
        const item = new vscode.InlineCompletionItem(insertText, range);

        // 设置补全项的元数据
        (item as any).completeBracketPairs = true; // 自动补全括号

        items.push(item);

        // 对于多行补全，提供首行作为备选项
        if (completion.includes('\n')) {
            const firstLine = completion.split('\n')[0].trim();
            if (firstLine && firstLine !== completion.trim()) {
                // 首行备选项也使用相同的替换策略
                const alternativeItem = new vscode.InlineCompletionItem(firstLine, range);
                (alternativeItem as any).completeBracketPairs = true;
                items.push(alternativeItem);
            }
        }

        return items;
    }

    /**
     * 判断是否应该替换到行尾
     * 当补全内容是完整语句且光标后有冲突内容时，返回 true
     */
    private shouldReplaceToLineEnd(
        completion: string,
        textAfterCursor: string,
        languageId: string
    ): boolean {
        // 如果光标后没有内容，不需要替换
        if (!textAfterCursor.trim()) {
            return false;
        }

        // 获取补全的首行（处理多行补全）
        const completionFirstLine = completion.split('\n')[0];

        // 场景1: 补全内容以语句结束符结尾（分号、闭合括号等）
        // 表示这是一个完整的语句，应该替换光标后的旧内容
        const statementEnders = [';', ')', '}', ']'];
        const endsWithStatementEnder = statementEnders.some(ender =>
            completionFirstLine.trimEnd().endsWith(ender)
        );

        if (endsWithStatementEnder) {
            // 检查光标后的内容是否也包含这些结束符（避免重复）
            const hasConflictingEnder = statementEnders.some(ender =>
                textAfterCursor.includes(ender)
            );

            if (hasConflictingEnder) {
                Logger.trace('[整行替换] 检测到完整语句且光标后有冲突的结束符');
                return true;
            }
        }

        // 场景2: 补全内容包含完整的括号对，而光标后有未配对的括号
        // 例如：补全 `log("test")` 但光标后还有旧的 `test)`
        const completionHasClosingParen = completionFirstLine.includes(')');
        const afterCursorHasClosingParen = textAfterCursor.includes(')');

        if (completionHasClosingParen && afterCursorHasClosingParen) {
            // 检查是否会导致括号不匹配
            const openParens = (completionFirstLine.match(/\(/g) || []).length;
            const closeParens = (completionFirstLine.match(/\)/g) || []).length;

            // 如果补全内容括号已经配对，说明是完整表达式
            if (openParens === closeParens) {
                Logger.trace('[整行替换] 检测到完整表达式且光标后有多余的闭合括号');
                return true;
            }
        }

        // 场景3: 补全内容是完整的字符串字面量，光标后有旧的参数
        // 例如：补全 `"Hello World"` 但光标后还有 `test`
        const stringLiteralPattern = /^["'`].*["'`]$/;
        if (stringLiteralPattern.test(completionFirstLine.trim())) {
            // 检查光标后是否有非空白的旧内容（可能是要被替换的旧参数）
            const afterTrimmed = textAfterCursor.trim();
            if (afterTrimmed && !afterTrimmed.startsWith(')') && !afterTrimmed.startsWith(',')) {
                Logger.trace('[整行替换] 检测到完整字符串字面量且光标后有旧内容');
                return true;
            }
        }

        // 场景4: Python 等语言的完整语句（以冒号结尾）
        if (languageId === 'python' && completionFirstLine.trimEnd().endsWith(':')) {
            if (textAfterCursor.trim()) {
                Logger.trace('[整行替换] 检测到 Python 完整语句（以冒号结尾）');
                return true;
            }
        }

        // 场景5: 补全内容明显比光标后内容更完整
        // 使用长度和复杂度作为启发式判断
        if (completionFirstLine.length > textAfterCursor.length * 1.5) {
            // 补全内容明显更长，且包含关键语法元素
            const hasKeyElements = /[({\["'`]/.test(completionFirstLine);
            if (hasKeyElements) {
                Logger.trace('[整行替换] 补全内容明显更完整（长度和复杂度判断）');
                return true;
            }
        }

        // 默认不替换，只插入
        return false;
    }

    /**
     * 生成缓存键
     */
    private generateCacheKey(
        document: vscode.TextDocument,
        position: vscode.Position,
        prefix: string
    ): string {
        // 使用文档URI、位置和前缀的哈希作为缓存键
        const prefixHash = prefix.slice(-100); // 只使用最后100个字符
        return `${document.uri.toString()}-${position.line}-${position.character}-${prefixHash}`;
    }

    /**
     * 处理补全项显示事件
     */
    handleDidShowCompletionItem?(
        completionItem: vscode.InlineCompletionItem,
        updatedInsertText: string
    ): void {
        Logger.trace('内联补全项已显示');
    }

    /**
     * 处理生命周期结束事件
     */
    handleEndOfLifetime?(
        completionItem: vscode.InlineCompletionItem,
        reason: vscode.InlineCompletionEndOfLifeReason
    ): void {
        const reasonText =
            reason.kind === vscode.InlineCompletionEndOfLifeReasonKind.Accepted ? '已接受' :
                reason.kind === vscode.InlineCompletionEndOfLifeReasonKind.Rejected ? '已拒绝' :
                    '已忽略';
        Logger.trace(`内联补全项生命周期结束: ${reasonText}`);
    }

    /**
     * 清理资源
     */
    dispose(): void {
        this.lastCompletionCache.clear();
        Logger.info('智谱AI内联补全提供者已释放');
    }
}
