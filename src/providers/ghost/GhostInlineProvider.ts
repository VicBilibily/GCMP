/*---------------------------------------------------------------------------------------------
 *  Ghost Inline Provider - InlineCompletionItemProvider 实现
 *  提供类似 GitHub Copilot 的行内代码补全
 *  使用防抖逻辑避免频繁请求
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { GhostModel } from './GhostModel';
import { GhostPromptBuilder } from './GhostPromptBuilder';
import { Logger } from '../../utils/logger';
import type { GhostConfig, GhostContext } from './types';

/**
 * Ghost 行内补全提供者
 */
export class GhostInlineProvider implements vscode.InlineCompletionItemProvider {
    private model: GhostModel;
    private config: GhostConfig;

    // 请求管理
    private currentRequestId = 0;
    private activeRequestId: number | null = null;
    private debounceTimer: NodeJS.Timeout | undefined;
    private readonly debounceDelay = 800; // 800ms 防抖延迟

    // 位置追踪（避免重复）
    private lastDocumentVersion: number | undefined;
    private lastPosition: vscode.Position | undefined;
    private lastDocumentUri: string | undefined;

    // 统计信息
    private totalCost = 0;
    private lastCost = 0;
    private statusBarItem: vscode.StatusBarItem;

    constructor(context: vscode.ExtensionContext) {
        this.model = new GhostModel();
        this.config = this.loadConfig();

        // 创建状态栏
        this.statusBarItem = vscode.window.createStatusBarItem(
            vscode.StatusBarAlignment.Right,
            100
        );
        this.updateStatusBar();
        if (this.config.showStatusBar) {
            this.statusBarItem.show();
        }

        // 监听配置变化
        context.subscriptions.push(
            vscode.workspace.onDidChangeConfiguration(e => {
                if (e.affectsConfiguration('gcmp.ghost')) {
                    this.config = this.loadConfig();
                    this.model.setModelId(this.config.modelId);
                    this.updateStatusBar();
                    if (this.config.showStatusBar) {
                        this.statusBarItem.show();
                    } else {
                        this.statusBarItem.hide();
                    }
                }
            })
        );

        Logger.info('GhostInlineProvider 已初始化');
    }

    /**
     * 加载配置
     */
    private loadConfig(): GhostConfig {
        const config = vscode.workspace.getConfiguration('gcmp.ghost');
        return {
            modelId: config.get('modelId', 'glm-4.5-air'),
            showStatusBar: config.get('showStatusBar', true)
        };
    }

    /**
     * 更新状态栏
     */
    private updateStatusBar(): void {
        const model = this.model.getModelName();
        const status = this.model.hasValidCredentials() ? '✓' : '✗';

        let text = `$(sparkle) Ghost ${status}`;

        if (this.totalCost > 0) {
            text += ` | ¥${this.totalCost.toFixed(4)}`;
        }

        if (this.lastCost > 0) {
            text += ` (¥${this.lastCost.toFixed(4)})`;
        }

        this.statusBarItem.text = text;
        this.statusBarItem.tooltip = `Ghost AI Code Completion\nModel: ${model}\nTotal Cost: ¥${this.totalCost.toFixed(4)}\nLast Completion: ¥${this.lastCost.toFixed(4)}`;
    }

    /**
     * 智能判断是否应该触发补全
     */
    private shouldTrigger(
        document: vscode.TextDocument,
        position: vscode.Position,
        context: vscode.InlineCompletionContext
    ): boolean {
        // 手动触发总是允许
        if (context.triggerKind === vscode.InlineCompletionTriggerKind.Invoke) {
            Logger.trace('Ghost: 手动触发，允许');
            return true;
        }

        // 检查文档和位置是否变化（更严格的检查）
        const documentUri = document.uri.toString();
        if (this.lastDocumentUri === documentUri &&
            this.lastDocumentVersion === document.version &&
            this.lastPosition?.isEqual(position)) {
            // 完全相同的位置，不重复触发
            return false;
        }

        const currentLine = document.lineAt(position.line);
        const textBeforeCursor = currentLine.text.substring(0, position.character);
        const trimmedBefore = textBeforeCursor.trim();

        // 空行或太短的行不触发
        if (trimmedBefore.length < 3) {
            Logger.trace(`Ghost: 内容太短 (${trimmedBefore.length} 字符)，跳过`);
            return false;
        }

        // 检查是否在单词中间（如果在单词中间，不触发）
        const nextChar = currentLine.text[position.character];
        if (nextChar && /\w/.test(nextChar)) {
            Logger.trace('Ghost: 光标在单词中间，跳过');
            return false;
        }

        // 检查特殊触发字符（高优先级触发）
        const lastChar = textBeforeCursor.slice(-1);
        const triggerChars = ['.', '(', '{', '[', ':', '=', ',', ';'];

        if (triggerChars.includes(lastChar)) {
            Logger.trace(`Ghost: 特殊字符 '${lastChar}' 触发`);
            return true;
        }

        // 检查是否为不完整语句（中优先级触发）
        const analyzer = GhostPromptBuilder.getStrategyManager().getContextAnalyzer();
        if (analyzer.isIncompleteStatement(textBeforeCursor)) {
            Logger.trace('Ghost: 不完整语句触发');
            return true;
        }

        // 空格后的触发需要更智能的判断
        if (lastChar === ' ') {
            // 场景 1：关键字后（如 return, if, for 等）
            const keywords = /\b(return|if|else|for|while|const|let|var|function|async|await|new|throw|case|import|export|extends|implements)\s+$/;
            if (keywords.test(textBeforeCursor)) {
                Logger.trace('Ghost: 关键字后触发');
                return true;
            }

            // 场景 2：块开始后（最重要！函数体、类体等）
            // 匹配: { | 或 { 多个空格 |
            if (/\{\s*$/.test(textBeforeCursor)) {
                Logger.trace('Ghost: 块开始后触发');
                return true;
            }

            // 场景 3：运算符后
            // 匹配: = | + | - | * | / | < | > | ! | && | || | 等
            if (/[=+\-*/<>!&|]\s+$/.test(textBeforeCursor)) {
                Logger.trace('Ghost: 运算符后触发');
                return true;
            }

            // 场景 4：逗号、冒号后（参数列表、对象属性等）
            if (/[,:]\s*$/.test(textBeforeCursor)) {
                Logger.trace('Ghost: 逗号/冒号后触发');
                return true;
            }

            // 场景 5：控制语句的条件后
            // 匹配: if (...) | for (...) | while (...) |
            if (/\b(if|for|while|switch|catch)\s*\([^)]*\)\s*$/.test(textBeforeCursor)) {
                Logger.trace('Ghost: 控制语句条件后触发');
                return true;
            }

            // 场景 6：箭头函数的箭头后
            // 匹配: => |
            if (/=>\s*$/.test(textBeforeCursor)) {
                Logger.trace('Ghost: 箭头函数后触发');
                return true;
            }

            // 其他空格：不触发（避免过于频繁）
            Logger.trace('Ghost: 普通空格，跳过');
            return false;
        }

        // 默认情况：只在行尾触发
        if (position.character === currentLine.text.length) {
            Logger.trace('Ghost: 行尾触发');
            return true;
        }

        Logger.trace('Ghost: 不满足触发条件，跳过');
        return false;
    }

    /**
     * 提供行内补全建议（使用防抖逻辑）
     */
    public async provideInlineCompletionItems(
        document: vscode.TextDocument,
        position: vscode.Position,
        context: vscode.InlineCompletionContext,
        token: vscode.CancellationToken
    ): Promise<vscode.InlineCompletionItem[] | vscode.InlineCompletionList | null> {
        // 生成唯一的请求ID
        const requestId = ++this.currentRequestId;

        // 手动触发：立即处理，不防抖
        if (context.triggerKind === vscode.InlineCompletionTriggerKind.Invoke) {
            Logger.trace(`Ghost: 手动触发 [请求#${requestId}]，立即处理`);
            return this.generateCompletion(document, position, context, token, requestId);
        }

        // 检查模型是否就绪
        if (!this.model.loaded || !this.model.hasValidCredentials()) {
            Logger.trace('Ghost: 模型未就绪');
            return null;
        }

        // 智能判断是否应该触发
        if (!this.shouldTrigger(document, position, context)) {
            return null;
        }

        // 自动触发：使用防抖逻辑
        Logger.trace(`Ghost: 自动触发 [请求#${requestId}]，启动防抖计时器`);

        // 清除之前的定时器
        if (this.debounceTimer) {
            clearTimeout(this.debounceTimer);
            Logger.trace(`Ghost: 清除旧的防抖计时器`);
        }

        // 返回一个 Promise，在防抖延迟后解析
        return new Promise((resolve) => {
            this.debounceTimer = setTimeout(async () => {
                // 检查是否被新请求取代
                if (requestId !== this.currentRequestId) {
                    Logger.trace(`Ghost: 请求#${requestId} 已过期，最新请求是 #${this.currentRequestId}`);
                    resolve(null);
                    return;
                }

                // 检查取消令牌
                if (token.isCancellationRequested) {
                    Logger.trace(`Ghost: 请求#${requestId} 已取消`);
                    resolve(null);
                    return;
                }

                Logger.trace(`Ghost: 防抖完成 [请求#${requestId}]，开始生成补全`);

                // 执行实际的补全生成
                const result = await this.generateCompletion(
                    document,
                    position,
                    context,
                    token,
                    requestId
                );

                resolve(result);
            }, this.debounceDelay);
        });
    }

    /**
     * 生成补全（核心逻辑）
     */
    private async generateCompletion(
        document: vscode.TextDocument,
        position: vscode.Position,
        context: vscode.InlineCompletionContext,
        token: vscode.CancellationToken,
        requestId: number
    ): Promise<vscode.InlineCompletionItem[] | vscode.InlineCompletionList | null> {
        // 检查是否有正在进行的请求
        if (this.activeRequestId !== null) {
            Logger.trace(`Ghost: 已有活跃请求 #${this.activeRequestId}，请求#${requestId} 等待`);
            // 等待当前请求完成
            // 注意：这里简化处理，实际上前一个请求会继续执行
        }

        try {
            this.activeRequestId = requestId;

            // 更新位置追踪
            this.lastDocumentVersion = document.version;
            this.lastDocumentUri = document.uri.toString();
            this.lastPosition = position;

            const ghostContext: GhostContext = {
                document,
                position,
                triggerKind: context.triggerKind
            };

            // 使用策略管理器构建提示词
            const { systemPrompt, userPrompt, strategyName } = GhostPromptBuilder.buildPrompts(ghostContext);

            Logger.trace(`Ghost: 请求#${requestId} 使用策略 [${strategyName}] (${context.triggerKind === vscode.InlineCompletionTriggerKind.Automatic ? 'auto' : 'manual'})`);

            // 生成补全
            const result = await this.model.generateCompletion(
                systemPrompt,
                userPrompt,
                chunk => {
                    if (token.isCancellationRequested) {
                        return;
                    }

                    if (chunk.type === 'usage' && chunk.usage) {
                        this.lastCost = chunk.usage.cost;
                        this.totalCost += chunk.usage.cost;
                        this.updateStatusBar();

                        Logger.info(
                            `Ghost [${strategyName}] 请求#${requestId} 完成: ${chunk.usage.inputTokens} 输入, ` +
                            `${chunk.usage.outputTokens} 输出, ¥${chunk.usage.cost.toFixed(4)}`
                        );
                    }
                }
            );

            if (token.isCancellationRequested || !result.text) {
                Logger.trace(`Ghost: 请求#${requestId} 已取消或无结果`);
                return null;
            }

            // 清理和验证生成的文本
            const completionText = this.postProcessCompletion(result.text, document, position);

            if (!completionText) {
                Logger.trace(`Ghost: 请求#${requestId} 补全文本为空或无效`);
                return null;
            }

            // 创建 InlineCompletionItem
            const item = new vscode.InlineCompletionItem(
                completionText,
                new vscode.Range(position, position)
            );

            Logger.trace(`Ghost: 请求#${requestId} 生成补全 [${strategyName}]，长度 ${completionText.length}`);

            return [item];
        } catch (error) {
            Logger.error(`Ghost: 请求#${requestId} 生成补全失败`, error);
            return null;
        } finally {
            // 清除活跃请求标记
            if (this.activeRequestId === requestId) {
                this.activeRequestId = null;
            }
        }
    }

    /**
     * 后处理补全结果
     */
    private postProcessCompletion(
        text: string,
        document: vscode.TextDocument,
        position: vscode.Position
    ): string | null {
        let completionText = text.trim();

        // 移除 markdown 代码块标记
        completionText = completionText.replace(/^```[\w]*\n?/, '');
        completionText = completionText.replace(/\n?```$/, '');
        completionText = completionText.trim();

        if (!completionText) {
            return null;
        }

        // 移除可能的解释性文本（如果AI添加了注释说明）
        const lines = completionText.split('\n');
        const codeLines = lines.filter(line => {
            const trimmed = line.trim();
            // 过滤掉纯说明性的注释
            if (trimmed.startsWith('//') && /^\/\/\s*(Here|This|The|Note|Explanation)/i.test(trimmed)) {
                return false;
            }
            return true;
        });

        completionText = codeLines.join('\n').trim();

        // 智能移除重复前缀
        completionText = this.removeDuplicatePrefix(completionText, document, position);

        if (!completionText) {
            return null;
        }

        // 确保补全有正确的结束符
        completionText = this.ensureProperTermination(completionText, document, position);

        // 质量检查：补全不应该太短或太长
        if (completionText.length < 1 || completionText.length > 1000) {
            return null;
        }

        // 质量检查：补全应该包含有效字符
        if (!/[a-zA-Z0-9_]/.test(completionText)) {
            return null;
        }

        return completionText;
    }

    /**
     * 确保补全有正确的结束符（如分号）
     */
    private ensureProperTermination(
        text: string,
        document: vscode.TextDocument,
        position: vscode.Position
    ): string {
        // 获取语言ID
        const languageId = document.languageId;

        // 需要分号的语言
        const semicolonLanguages = [
            'javascript', 'typescript', 'javascriptreact', 'typescriptreact',
            'csharp', 'java', 'c', 'cpp', 'go', 'rust', 'swift', 'kotlin'
        ];

        if (!semicolonLanguages.includes(languageId)) {
            return text; // Python, Ruby, YAML 等不需要分号
        }

        // 分析最后一行
        const lines = text.split('\n');
        const lastLine = lines[lines.length - 1];
        const trimmedLastLine = lastLine.trim();

        if (!trimmedLastLine) {
            return text; // 最后一行是空行
        }

        // 已经有结束符的情况（不需要添加）
        if (/[;{},]$/.test(trimmedLastLine)) {
            return text; // 已有分号、花括号或逗号
        }

        // 注释行不需要分号
        if (/^\/\//.test(trimmedLastLine) || /^\/\*/.test(trimmedLastLine) || /\*\/$/.test(trimmedLastLine)) {
            return text;
        }

        // 控制语句后面通常跟块，不需要分号
        // 例如: if (...) { 或 for (...) { 或 class Foo {
        const controlKeywords = /\b(if|else|for|while|switch|try|catch|finally|do|class|interface|enum|function|namespace)\b.*$/;
        if (controlKeywords.test(trimmedLastLine)) {
            return text; // 控制语句，可能后面跟 {
        }

        // 箭头函数如果只有一个表达式，不需要分号（会在外层添加）
        if (/=>\s*[^{]/.test(trimmedLastLine) && !trimmedLastLine.includes('\n')) {
            // 这是单行箭头函数表达式
            // 检查是否是完整的赋值语句
            const currentLine = document.lineAt(position.line).text.substring(0, position.character);
            if (/^\s*(const|let|var|return)\s/.test(currentLine)) {
                return text + ';'; // 是赋值或返回语句，需要分号
            }
        }

        // 检查是否是完整的语句（需要分号）
        // 完整语句的特征：
        // 1. 以标识符、字符串、数字、括号闭合结尾
        // 2. 不是声明开始（如 const、let、var 后面没有赋值）
        const statementPattern = /^(const|let|var|return|throw|break|continue|import|export)\s+.+[^=\s]$/;
        const expressionPattern = /[a-zA-Z0-9_$\])"'`]$/; // 以标识符、括号、引号结尾

        if (statementPattern.test(trimmedLastLine) ||
            (expressionPattern.test(trimmedLastLine) && !/^\s*(const|let|var)\s+\w+\s*$/.test(trimmedLastLine))) {
            // 看起来是完整的语句，添加分号
            Logger.trace('Ghost: 添加缺失的分号到补全末尾');
            return text + ';';
        }

        // 对于赋值语句、函数调用等，也添加分号
        if (/=\s*[^=]/.test(trimmedLastLine) || // 赋值
            /\([^)]*\)$/.test(trimmedLastLine) || // 函数调用
            /\[[^\]]*\]$/.test(trimmedLastLine)) { // 数组访问
            Logger.trace('Ghost: 添加缺失的分号到补全末尾');
            return text + ';';
        }

        // 默认情况：不添加（保守策略）
        return text;
    }

    /**
     * 移除补全文本中的重复前缀
     * 处理 AI 模型可能重复光标前的代码片段
     */
    private removeDuplicatePrefix(
        completionText: string,
        document: vscode.TextDocument,
        position: vscode.Position
    ): string {
        // 获取光标前的上下文
        const currentLine = document.lineAt(position.line).text;
        const textBeforeCursor = currentLine.substring(0, position.character);

        // 获取前几行的内容作为上下文
        const startLine = Math.max(0, position.line - 2);
        const contextLines: string[] = [];
        for (let i = startLine; i < position.line; i++) {
            contextLines.push(document.lineAt(i).text);
        }
        contextLines.push(textBeforeCursor);
        const fullContext = contextLines.join('\n');

        // 策略 1：检查补全是否完全重复当前行前缀（必须是完整的语句或表达式）
        const trimmedBefore = textBeforeCursor.trim();
        if (trimmedBefore.length > 0 && completionText.trim().startsWith(trimmedBefore)) {
            // 只有在匹配完整的语义单元时才移除
            // 例如：完整的函数调用、完整的声明等
            const afterRemoval = completionText.trim().substring(trimmedBefore.length).trim();

            // 验证移除后是否以有效的延续字符开始
            if (afterRemoval.length > 0 && this.isValidContinuation(afterRemoval)) {
                Logger.trace(`Ghost: 移除完全重复的前缀 (${trimmedBefore.length} 字符)`);
                return afterRemoval;
            }
        }

        // 策略 2：检查是否重复了完整的标识符或字面量
        // 匹配最后一个完整的标识符（变量名、函数名等）
        const identifierMatch = textBeforeCursor.match(/\b([a-zA-Z_$][a-zA-Z0-9_$]*)\s*$/);
        if (identifierMatch) {
            const lastIdentifier = identifierMatch[1];
            if (lastIdentifier.length >= 3 && completionText.startsWith(lastIdentifier)) {
                const afterRemoval = completionText.substring(lastIdentifier.length).trimStart();
                // 确保移除后有有效的延续（如括号、点号等）
                if (afterRemoval.length > 0 && /^[.([\[,;:]/.test(afterRemoval)) {
                    Logger.trace(`Ghost: 移除重复的标识符: "${lastIdentifier}"`);
                    return afterRemoval;
                }
            }
        }

        // 策略 3：检查字符串字面量的重复
        // 例如：'keydown' 被重复
        const stringMatch = textBeforeCursor.match(/(['"])([^'"]*)\1\s*$/);
        if (stringMatch) {
            const fullString = stringMatch[0].trim();
            if (completionText.startsWith(fullString)) {
                const afterRemoval = completionText.substring(fullString.length).trimStart();
                if (afterRemoval.length > 0) {
                    Logger.trace(`Ghost: 移除重复的字符串: ${fullString}`);
                    return afterRemoval;
                }
            }
        }

        // 策略 4：检查部分单词重复（最保守）
        // 只处理明显的打字错误，如 "emit" → "mit"
        const lastWord = textBeforeCursor.trim().split(/\s+/).pop() || '';
        if (lastWord.length >= 4) { // 至少 4 个字符的单词才检查
            // 只检查后缀重复，且必须是字母
            for (let i = Math.floor(lastWord.length / 2); i < lastWord.length; i++) {
                const suffix = lastWord.substring(i);
                if (suffix.length >= 2 && /^[a-zA-Z]+$/.test(suffix)) {
                    if (completionText.startsWith(suffix) && /^[a-zA-Z]/.test(completionText)) {
                        // 验证：移除后应该形成有效的单词
                        const remaining = completionText.substring(suffix.length);
                        if (remaining.length > 0 && !/^[a-zA-Z]/.test(remaining)) {
                            Logger.trace(`Ghost: 移除部分重复字符 (${suffix.length} 字符): "${suffix}"`);
                            return remaining.trimStart();
                        }
                    }
                }
            }
        }

        // 策略 5：检查完整表达式的重复（如函数调用）
        // 例如：emit('close') 被完整重复
        const expressionMatch = textBeforeCursor.match(/\b([a-zA-Z_$][a-zA-Z0-9_$]*\([^)]*\))\s*$/);
        if (expressionMatch) {
            const expression = expressionMatch[1];
            if (expression.length >= 5 && completionText.trim().startsWith(expression)) {
                const afterRemoval = completionText.trim().substring(expression.length).trim();
                if (afterRemoval.length > 0) {
                    Logger.trace(`Ghost: 移除重复的表达式: "${expression}"`);
                    return afterRemoval;
                }
            }
        }

        // 没有检测到安全的重复，返回原文本
        return completionText;
    }

    /**
     * 检查移除后的文本是否是有效的延续
     */
    private isValidContinuation(text: string): boolean {
        if (text.length === 0) {
            return false;
        }

        const firstChar = text[0];

        // 有效的延续字符：
        // - 运算符: +, -, *, /, =, <, >, !, &, |
        // - 分隔符: ;, ,, ., :
        // - 括号: (, ), [, ], {, }
        // - 字母数字（新的语句）
        const validStarters = /^[+\-*/%=<>!&|;,.:()\[\]{}a-zA-Z0-9_$]/;

        if (!validStarters.test(firstChar)) {
            return false;
        }

        // 不应该以孤立的语法字符开始（除非后面有内容）
        if (text.length === 1 && /^[{}\[\]]$/.test(firstChar)) {
            return false;
        }

        return true;
    }

    /**
     * 清理资源
     */
    public dispose(): void {
        // 清除防抖计时器
        if (this.debounceTimer) {
            clearTimeout(this.debounceTimer);
        }
        this.statusBarItem.dispose();
        Logger.info('GhostInlineProvider 已销毁');
    }
}
