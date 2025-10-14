import * as vscode from 'vscode';
import { Logger } from '../utils/logger';
import { getInlineCompletionConfig, INLINE_COMPLETION_CONFIG } from './configuration';
import { requestInlineCompletion } from './zhipuService';
import { ContextCollector } from './contextCollector';

/**
 * 防抖管理器
 * 用于控制补全请求的触发频率
 */
class DebounceManager {
    private timer: NodeJS.Timeout | null = null;
    private lastRequestTime = 0;
    private debounceDelay: number;
    private pendingResolve: ((value: boolean) => void) | null = null;

    constructor(debounceDelay: number = INLINE_COMPLETION_CONFIG.debounceDelay) {
        this.debounceDelay = debounceDelay;
    }

    /**
     * 检查是否应该触发补全请求
     * @param _document 文档
     * @param _position 位置
     * @returns Promise<boolean> 是否应该触发请求
     */
    shouldTrigger(_document: vscode.TextDocument, _position: vscode.Position): Promise<boolean> {
        return new Promise<boolean>((resolve) => {
            const now = Date.now();
            const timeSinceLastRequest = now - this.lastRequestTime;

            // 如果距离上次请求时间小于防抖延迟，则取消之前的请求
            if (this.timer) {
                clearTimeout(this.timer);
                this.timer = null;
                Logger.trace('取消之前的补全请求');
            }

            // 如果有等待中的解析器，拒绝它
            if (this.pendingResolve) {
                this.pendingResolve(false);
                this.pendingResolve = null;
            }

            // 如果距离上次请求时间大于防抖延迟，立即触发
            if (timeSinceLastRequest >= this.debounceDelay) {
                this.lastRequestTime = now;
                resolve(true);
                return;
            }

            // 否则设置定时器，延迟触发
            this.pendingResolve = resolve;
            this.timer = setTimeout(() => {
                this.lastRequestTime = Date.now();
                this.timer = null;
                if (this.pendingResolve) {
                    this.pendingResolve(true);
                    this.pendingResolve = null;
                }
            }, this.debounceDelay - timeSinceLastRequest);
        });
    }

    /**
     * 取消所有待处理的请求
     */
    cancel(): void {
        if (this.timer) {
            clearTimeout(this.timer);
            this.timer = null;
        }
        if (this.pendingResolve) {
            this.pendingResolve(false);
            this.pendingResolve = null;
        }
    }

    /**
     * 更新防抖延迟
     */
    updateDelay(delay: number): void {
        this.debounceDelay = delay;
    }
}

/**
 * 智能代码补全提供器
 * 使用智谱 GLM-4.5-Air 模型提供内联代码补全建议
 */
export class InlineCompletionProvider implements vscode.InlineCompletionItemProvider {
    private readonly _disposables: vscode.Disposable[] = [];
    private debounceManager: DebounceManager;
    private contextCollector: ContextCollector;

    constructor() {
        Logger.info('初始化内联代码补全提供器');
        this.debounceManager = new DebounceManager();
        this.contextCollector = new ContextCollector();
    }

    /**
     * 提供内联补全建议
     * @param document 当前文档
     * @param position 光标位置
     * @param context 补全上下文
     * @param token 取消令牌
     */
    async provideInlineCompletionItems(
        document: vscode.TextDocument,
        position: vscode.Position,
        context: vscode.InlineCompletionContext,
        token: vscode.CancellationToken
    ): Promise<vscode.InlineCompletionItem[] | vscode.InlineCompletionList | undefined> {
        try {
            const config = getInlineCompletionConfig();

            // 检查是否启用
            if (!config.enabled) {
                Logger.debug('内联代码补全功能已禁用');
                return undefined;
            }

            // 检查取消令牌
            if (token.isCancellationRequested) {
                Logger.trace('补全请求已取消');
                return undefined;
            }

            // 获取当前行文本和前缀
            const lineText = document.lineAt(position.line).text;
            const prefix = lineText.substring(0, position.character).trim();

            // 如果前缀太短，不进行补全
            if (prefix.length < INLINE_COMPLETION_CONFIG.minPrefixLength) {
                Logger.trace(`前缀长度不足: ${prefix.length} < ${INLINE_COMPLETION_CONFIG.minPrefixLength}`);
                return undefined;
            }

            // 使用防抖管理器检查是否应该触发请求
            const shouldTrigger = await this.debounceManager.shouldTrigger(document, position);
            if (!shouldTrigger) {
                Logger.trace('防抖延迟，跳过此次补全请求');
                return undefined;
            }

            Logger.trace(`请求代码补全, 位置: ${position.line}:${position.character}, 前缀: "${prefix}"`);

            // 使用上下文收集器收集智能上下文
            const contextSnippets = await this.contextCollector.collectContext(
                document,
                position,
                {
                    includeSymbols: true,
                    includeTypeDefinitions: true,
                    includeReferences: false, // 引用收集较慢，默认关闭
                    includeImports: true,
                    includeRelatedFiles: false, // 相关文件收集较慢，默认关闭
                    maxContextLines: INLINE_COMPLETION_CONFIG.maxContextLines,
                    timeout: 800 // 800ms 超时
                }
            );

            // 格式化上下文为字符串
            const contextCode = this.contextCollector.formatContext(contextSnippets, 6000);

            Logger.trace(`收集到 ${contextSnippets.length} 个上下文片段`);

            // 调用智谱 API 获取补全建议
            const completionText = await requestInlineCompletion({
                document,
                position,
                context: contextCode,
                prefix,
                language: document.languageId,
                token
            });

            // 检查补全结果是否有效
            if (!completionText || !completionText.trim() || token.isCancellationRequested) {
                return undefined;
            }

            Logger.debug(`收到补全建议: "${completionText}"`);

            // 获取当前行的后缀（光标后的内容）
            const suffix = lineText.substring(position.character);

            // 智能处理补全范围
            const completionRange = this.calculateCompletionRange(
                document,
                position,
                completionText,
                suffix
            );

            // 创建补全项
            const completionItem: vscode.InlineCompletionItem = {
                insertText: completionText,
                range: completionRange,
                // 可选: 添加过滤文本以提高匹配准确度
                filterText: completionText
            };

            Logger.trace(`补全范围: [${completionRange.start.line}:${completionRange.start.character} - ${completionRange.end.line}:${completionRange.end.character}]`);

            return {
                items: [completionItem]
            };

        } catch (error) {
            Logger.error('提供内联补全时出错:', error);
            return undefined;
        }
    }

    /**
     * 计算补全范围
     * 根据补全内容和当前行的后缀，智能决定是插入还是替换
     * @param document 文档
     * @param position 光标位置
     * @param completionText 补全文本
     * @param suffix 当前行光标后的内容
     * @returns 补全范围
     */
    private calculateCompletionRange(
        document: vscode.TextDocument,
        position: vscode.Position,
        completionText: string,
        suffix: string
    ): vscode.Range {
        const lines = completionText.split('\n');
        const isMultiLine = lines.length > 1;

        // 如果是多行补全，需要替换整行或多行
        if (isMultiLine) {
            Logger.trace('多行补全，计算替换范围');
            return this.calculateMultiLineRange(document, position, lines, suffix);
        }

        // 单行补全：检查是否需要替换后缀
        if (suffix.trim()) {
            Logger.trace(`光标后有内容: "${suffix}"`);

            // 检查补全内容是否与后缀有重叠或冲突
            const shouldReplaceSuffix = this.shouldReplaceSuffix(completionText, suffix);

            if (shouldReplaceSuffix) {
                // 替换到行尾
                const lineEndPosition = new vscode.Position(position.line, document.lineAt(position.line).text.length);
                Logger.trace('替换光标后的内容');
                return new vscode.Range(position, lineEndPosition);
            }
        }

        // 默认：在光标位置插入
        return new vscode.Range(position, position);
    }

    /**
     * 计算多行补全的范围
     * @param document 文档
     * @param position 光标位置
     * @param lines 补全的行数组
     * @param suffix 当前行的后缀
     * @returns 补全范围
     */
    private calculateMultiLineRange(
        document: vscode.TextDocument,
        position: vscode.Position,
        lines: string[],
        suffix: string
    ): vscode.Range {
        // 如果光标不在行尾，替换到行尾
        if (suffix.trim()) {
            const currentLineEnd = new vscode.Position(position.line, document.lineAt(position.line).text.length);

            // 检查是否需要替换多行
            const shouldReplaceMultipleLines = this.shouldReplaceMultipleLines(document, position, lines);

            if (shouldReplaceMultipleLines) {
                // 计算需要替换的行数
                const endLine = Math.min(position.line + lines.length - 1, document.lineCount - 1);
                const endLineText = document.lineAt(endLine).text;
                const endPosition = new vscode.Position(endLine, endLineText.length);
                Logger.trace(`多行替换: 从 ${position.line} 到 ${endLine}`);
                return new vscode.Range(position, endPosition);
            }

            // 只替换当前行到行尾
            return new vscode.Range(position, currentLineEnd);
        }

        // 光标在行尾，直接插入
        return new vscode.Range(position, position);
    }

    /**
     * 判断是否应该替换后缀
     * @param completionText 补全文本
     * @param suffix 后缀文本
     * @returns 是否应该替换
     */
    private shouldReplaceSuffix(completionText: string, suffix: string): boolean {
        const trimmedSuffix = suffix.trim();
        const trimmedCompletion = completionText.trim();

        // 如果后缀为空，不需要替换
        if (!trimmedSuffix) {
            return false;
        }

        // 情况1：补全内容已经包含了后缀的内容
        if (trimmedCompletion.includes(trimmedSuffix)) {
            return true;
        }

        // 情况2：补全内容与后缀有冲突（例如都是闭合括号）
        const conflictPatterns = [
            /[)\]}]/,  // 闭合括号
            /[;,]/,     // 分号、逗号
            /['"`]/     // 引号
        ];

        for (const pattern of conflictPatterns) {
            if (pattern.test(trimmedCompletion) && pattern.test(trimmedSuffix)) {
                return true;
            }
        }

        // 情况3：补全是完整的语句，而后缀只是部分内容
        if (this.isCompleteStatement(trimmedCompletion) && !this.isCompleteStatement(trimmedSuffix)) {
            return true;
        }

        return false;
    }

    /**
     * 判断是否应该替换多行
     * @param document 文档
     * @param position 光标位置
     * @param lines 补全的行
     * @returns 是否应该替换多行
     */
    private shouldReplaceMultipleLines(
        document: vscode.TextDocument,
        position: vscode.Position,
        lines: string[]
    ): boolean {
        // 如果补全内容超过3行，可能是一个代码块
        if (lines.length >= 3) {
            // 检查后续行是否是空行或缩进不匹配
            for (let i = 1; i < Math.min(lines.length, 5); i++) {
                const nextLineIndex = position.line + i;
                if (nextLineIndex >= document.lineCount) {
                    break;
                }

                const nextLine = document.lineAt(nextLineIndex).text;
                // 如果后续行是空行或只有空白，可以替换
                if (!nextLine.trim()) {
                    continue;
                }

                // 如果后续行的缩进不匹配，不替换多行
                const currentIndent = this.getIndentation(document.lineAt(position.line).text);
                const nextIndent = this.getIndentation(nextLine);
                if (nextIndent <= currentIndent) {
                    return false;
                }
            }

            // 可以替换多行
            return true;
        }

        return false;
    }

    /**
     * 判断是否是完整的语句
     * @param text 文本
     * @returns 是否是完整语句
     */
    private isCompleteStatement(text: string): boolean {
        // 简单判断：是否以分号、闭合括号等结尾
        return /[;}\])]\s*$/.test(text);
    }

    /**
     * 获取文本的缩进级别
     * @param text 文本
     * @returns 缩进字符数
     */
    private getIndentation(text: string): number {
        const match = text.match(/^(\s*)/);
        return match ? match[1].length : 0;
    }

    /**
     * 当补全项被显示时调用
     */
    handleDidShowCompletionItem?(_completionItem: vscode.InlineCompletionItem): void {
        Logger.trace('补全建议已显示');
    }

    /**
     * 获取简单的上下文代码（备用方法）
     * @param document 文档
     * @param position 位置
     * @param maxLines 最大行数
     * @deprecated 使用 ContextCollector 代替
     */
    private getContextCode(
        document: vscode.TextDocument,
        position: vscode.Position,
        maxLines: number
    ): string {
        const startLine = Math.max(0, position.line - maxLines);
        const endLine = Math.min(document.lineCount - 1, position.line + Math.floor(maxLines / 4));

        const contextLines: string[] = [];
        for (let i = startLine; i <= endLine; i++) {
            contextLines.push(document.lineAt(i).text);
        }

        return contextLines.join('\n');
    }

    /**
     * 释放资源
     */
    dispose(): void {
        Logger.debug('销毁内联代码补全提供器');
        this._disposables.forEach(d => d.dispose());
    }
}

/**
 * 注册内联补全提供器
 * @param context 扩展上下文
 */
export function registerInlineCompletionProvider(context: vscode.ExtensionContext): vscode.Disposable {
    Logger.info('正在注册内联代码补全提供器...');

    const provider = new InlineCompletionProvider();

    // 注册提供器，支持所有文件类型
    const disposable = vscode.languages.registerInlineCompletionItemProvider(
        { pattern: '**' },  // 匹配所有文件
        provider
    );

    // 添加到订阅列表
    context.subscriptions.push(disposable, provider);

    Logger.info('✅ 内联代码补全提供器注册成功');

    return disposable;
}
