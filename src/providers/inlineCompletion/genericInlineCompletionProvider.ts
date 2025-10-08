/*---------------------------------------------------------------------------------------------
 *  通用内联补全提供者
 *  支持多个模型供应商的内联代码补全
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { Logger, ApiKeyManager } from '../../utils';
import { CompletionContext, CompletionResponse, InlineCompletionConfig, ICompletionProvider } from './types';
import { SmartTriggerDetector } from './smartTrigger';
import { ContextBuilder } from './contextBuilder';
import { CompletionOptimizer } from './completionOptimizer';

/**
 * 通用内联补全提供者
 */
export class GenericInlineCompletionProvider implements vscode.InlineCompletionItemProvider {
    private readonly smartTrigger: SmartTriggerDetector;
    private lastRequestTime = 0;
    private abortController: AbortController | null = null;
    private completionCache = new Map<string, vscode.InlineCompletionItem[]>();

    constructor(
        private readonly completionProvider: ICompletionProvider,
        private readonly config: InlineCompletionConfig
    ) {
        this.smartTrigger = SmartTriggerDetector.getInstance();
        Logger.info(`通用内联补全提供者已初始化，提供商: ${completionProvider.getProviderId()}`);

        // 设置文档变化监听器
        vscode.workspace.onDidChangeTextDocument((e) => {
            const operation = this.smartTrigger.detectEditOperation(e.document, e.contentChanges);
            this.smartTrigger.updateEditOperation(e.document, operation);
        });
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
            // 检查是否启用
            if (!this.config.enabled) {
                return null;
            }

            // 检查是否有API密钥
            const hasApiKey = await ApiKeyManager.hasValidApiKey(this.config.provider);
            if (!hasApiKey) {
                Logger.trace(`未找到 ${this.config.provider} API密钥，跳过内联补全`);
                return null;
            }

            // 智能触发检查
            if (this.config.enableSmartTrigger) {
                const triggerCheck = this.smartTrigger.shouldTriggerCompletion(document, position);
                if (!triggerCheck.shouldTrigger) {
                    Logger.trace(`智能触发检查拒绝: ${triggerCheck.reason}`);
                    return null;
                }

                // 等待防抖时间
                await new Promise(resolve => setTimeout(resolve, triggerCheck.debounceTime));
            }

            // 检查取消令牌
            if (token.isCancellationRequested) {
                return null;
            }

            // 频率限制
            const now = Date.now();
            if (now - this.lastRequestTime < this.config.minRequestInterval) {
                Logger.trace('请求过于频繁，跳过');
                return null;
            }
            this.lastRequestTime = now;

            // 构建上下文
            const completionContext = ContextBuilder.buildContext(document, position, this.config.contextLines);

            // 生成缓存键
            const cacheKey = this.generateCacheKey(completionContext);
            if (this.completionCache.has(cacheKey)) {
                Logger.trace('使用缓存的补全结果');
                return this.completionCache.get(cacheKey)!;
            }

            // 取消之前的请求
            if (this.abortController) {
                this.abortController.abort();
            }
            this.abortController = new AbortController();

            Logger.trace(`正在为 ${document.languageId} 文件生成内联补全...`);

            // 请求补全
            const startTime = Date.now();
            const response = await this.completionProvider.requestCompletion(
                completionContext,
                this.config,
                token
            );

            if (!response || !response.text || token.isCancellationRequested) {
                return null;
            }

            // 优化补全内容
            const optimizedText = CompletionOptimizer.cleanCompletion(
                response.text,
                completionContext.prefix,
                completionContext.suffix
            );

            if (!optimizedText) {
                Logger.trace('优化后补全为空，跳过');
                return null;
            }

            // 验证语法
            if (!CompletionOptimizer.validateSyntax(optimizedText, completionContext.prefix)) {
                Logger.trace('补全内容未通过语法验证');
                return null;
            }

            // 创建补全项
            const items = this.createCompletionItems(
                optimizedText,
                position,
                document,
                completionContext,
                response
            );

            // 缓存结果
            this.completionCache.clear();
            this.completionCache.set(cacheKey, items);

            // 记录指标
            const responseTime = Date.now() - startTime;
            Logger.trace(`生成了 ${items.length} 个内联补全建议 (耗时: ${responseTime}ms)`);
            this.smartTrigger.recordCompletionMetrics(document, responseTime, false);

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
     * 创建补全项
     */
    private createCompletionItems(
        completion: string,
        position: vscode.Position,
        document: vscode.TextDocument,
        context: CompletionContext,
        response: CompletionResponse
    ): vscode.InlineCompletionItem[] {
        const items: vscode.InlineCompletionItem[] = [];

        // 确定补全范围
        let range: vscode.Range;

        if (response.range) {
            // 使用API指定的范围（范围替换）
            const startPos = new vscode.Position(response.range.startLine, response.range.startColumn);
            const endPos = new vscode.Position(response.range.endLine, response.range.endColumn);
            range = new vscode.Range(startPos, endPos);
            Logger.trace(`使用范围替换: ${response.range.startLine}:${response.range.startColumn} -> ${response.range.endLine}:${response.range.endColumn}`);
        } else {
            // 默认插入模式
            range = new vscode.Range(position, position);
        }

        // 创建主补全项
        const item = new vscode.InlineCompletionItem(completion, range);
        items.push(item);

        // 对于多行补全，提供首行作为备选项
        if (completion.includes('\n')) {
            const firstLine = completion.split('\n')[0].trim();
            if (firstLine && firstLine !== completion.trim()) {
                const alternativeItem = new vscode.InlineCompletionItem(firstLine, range);
                items.push(alternativeItem);
            }
        }

        return items;
    }

    /**
     * 生成缓存键
     */
    private generateCacheKey(context: CompletionContext): string {
        const prefixHash = context.prefix.slice(-100);
        return `${context.documentUri}-${context.position.line}-${context.position.character}-${prefixHash}`;
    }

    /**
     * 处理补全被接受的事件
     */
    handleDidAcceptCompletionItem?(_item: vscode.InlineCompletionItem): void {
        Logger.trace('内联补全已被接受');
    }

    /**
     * 清理资源
     */
    dispose(): void {
        if (this.abortController) {
            this.abortController.abort();
        }
        this.completionCache.clear();
        Logger.info('通用内联补全提供者已释放');
    }
}
