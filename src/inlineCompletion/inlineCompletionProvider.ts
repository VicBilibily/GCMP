import * as vscode from 'vscode';
import { Logger } from '../utils/logger';
import { getInlineCompletionConfig, INLINE_COMPLETION_CONFIG } from './configuration';
import { requestInlineCompletion } from './zhipuService';

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

    constructor() {
        Logger.info('初始化内联代码补全提供器');
        this.debounceManager = new DebounceManager();
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

            // 获取上下文代码
            const contextCode = this.getContextCode(document, position, INLINE_COMPLETION_CONFIG.maxContextLines);

            // 调用智谱 API 获取补全建议
            const completionText = await requestInlineCompletion({
                document,
                position,
                context: contextCode,
                prefix,
                language: document.languageId,
                token
            });

            if (!completionText || token.isCancellationRequested) {
                return undefined;
            }

            Logger.debug(`收到补全建议: "${completionText}"`);

            // 创建补全项
            const completionItem: vscode.InlineCompletionItem = {
                insertText: completionText,
                range: new vscode.Range(position, position),
                // 可选: 添加过滤文本以提高匹配准确度
                filterText: completionText
            };

            return {
                items: [completionItem]
            };

        } catch (error) {
            Logger.error('提供内联补全时出错:', error);
            return undefined;
        }
    }

    /**
     * 当补全项被显示时调用
     */
    handleDidShowCompletionItem?(_completionItem: vscode.InlineCompletionItem): void {
        Logger.trace('补全建议已显示');
    }

    /**
     * 获取上下文代码
     * @param document 文档
     * @param position 位置
     * @param maxLines 最大行数
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
