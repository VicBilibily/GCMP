/*---------------------------------------------------------------------------------------------
 *  JointInlineCompletionProvider - 联合内联代码补全提供商
 *
 *  实现 "竞争模式" (Competition Mode):
 *  同时运行 FIM (InlineCompletionProvider) 和 NES (NESProvider)
 *
 *  策略 (基于官方实现):
 *  1. 缓存优先: 如果存在上一次的 NES 建议，优先给 NES 极短时间(10ms)进行快速验证。
 *  2. 快速命中: 如果 NES 快速返回且与缓存一致，直接采用，跳过 FIM。
 *  3. 并发竞争: 否则，同时发起 FIM 和 NES 请求。
 *  4. FIM 优先: 在并发场景下，优先采用 FIM 的结果（除非 NES 先回且与缓存一致），以保证响应速度。
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { InlineCompletionProvider } from './completionProvider';
import { NESProvider } from './nesProvider';
import { Logger } from '../utils/logger';

interface LastNesSuggestion {
    docUri: vscode.Uri;
    docVersionId: number;
    docWithNesEditApplied: string;
}

interface SingularCompletionList extends vscode.InlineCompletionList {
    source: 'FIM' | 'NES';
}

export class JointInlineCompletionProvider implements vscode.InlineCompletionItemProvider, vscode.Disposable {
    private readonly disposables: vscode.Disposable[] = [];
    private inlineCompletionProvider: InlineCompletionProvider;
    private nesProvider: NESProvider;
    private lastNesSuggestion: LastNesSuggestion | null = null;
    private provideInlineCompletionItemsInvocationCount = 0;

    constructor(private readonly context: vscode.ExtensionContext) {
        this.inlineCompletionProvider = new InlineCompletionProvider(context);
        this.nesProvider = new NESProvider(context);
    }

    activate(): void {
        Logger.trace('[JointInlineCompletionProvider.activate] 激活开始');

        // 激活子提供商，但不注册它们
        this.inlineCompletionProvider.activate(false);
        this.nesProvider.activate(false);

        // 注册自己为提供商
        const provider = vscode.languages.registerInlineCompletionItemProvider({ pattern: '**/*' }, this);
        this.disposables.push(provider);

        Logger.info('✅ [JointInlineCompletionProvider] 联合提供商已激活 (官方策略模式)');
    }

    async provideInlineCompletionItems(
        document: vscode.TextDocument,
        position: vscode.Position,
        context: vscode.InlineCompletionContext,
        token: vscode.CancellationToken
    ): Promise<vscode.InlineCompletionItem[] | vscode.InlineCompletionList | undefined> {
        const invocationId = ++this.provideInlineCompletionItemsInvocationCount;
        Logger.trace(`[JointInlineCompletionProvider] 请求 #${invocationId} 开始`);

        const completionsCts = new vscode.CancellationTokenSource();
        const nesCts = new vscode.CancellationTokenSource();

        // 链接外部 token 取消事件
        const tokenDisposable = token.onCancellationRequested(() => {
            completionsCts.cancel();
            nesCts.cancel();
        });

        let saveLastNesSuggestion: LastNesSuggestion | null = null;

        try {
            const documentText = document.getText();
            const docVersionId = document.version;

            // 检查上次建议是否适用于当前文档
            if (this.lastNesSuggestion && this.lastNesSuggestion.docUri.toString() !== document.uri.toString()) {
                Logger.trace('[JointInlineCompletionProvider] 上次 NES 建议不属于当前文档，忽略');
                this.lastNesSuggestion = null;
            }

            const list = await this._provideInlineCompletionItemsRegular(
                document,
                documentText,
                position,
                this.lastNesSuggestion,
                context,
                { coreToken: token, completionsCts, nesCts }
            );

            if (token.isCancellationRequested) {
                return list;
            }

            if (!list || list.source !== 'NES' || list.items.length === 0) {
                return list;
            }

            const firstItem = list.items[0];
            if (!firstItem.range || typeof firstItem.insertText !== 'string') {
                return list;
            }

            // 简单的 applyTextEdit 模拟
            const applied = this.applyTextEdit(document, documentText, firstItem.range, firstItem.insertText);

            saveLastNesSuggestion = {
                docUri: document.uri,
                docVersionId,
                docWithNesEditApplied: applied
            };

            return list;
        } finally {
            tokenDisposable.dispose();

            // 只有当这是最新的一次调用时才保存建议
            if (invocationId === this.provideInlineCompletionItemsInvocationCount) {
                this.lastNesSuggestion = saveLastNesSuggestion;
                if (this.lastNesSuggestion) {
                    Logger.trace(
                        `[JointInlineCompletionProvider] 保存 NES 建议缓存: ${this.lastNesSuggestion.docUri.toString()}`
                    );
                } else {
                    Logger.trace('[JointInlineCompletionProvider] 清除 NES 建议缓存');
                }
            } else {
                Logger.trace('[JointInlineCompletionProvider] 忽略过期的 NES 建议缓存更新');
            }

            completionsCts.dispose();
            nesCts.dispose();
        }
    }

    private async _provideInlineCompletionItemsRegular(
        document: vscode.TextDocument,
        documentText: string,
        position: vscode.Position,
        lastNesSuggestion: LastNesSuggestion | null,
        context: vscode.InlineCompletionContext,
        tokens: {
            coreToken: vscode.CancellationToken;
            completionsCts: vscode.CancellationTokenSource;
            nesCts: vscode.CancellationTokenSource;
        }
    ): Promise<SingularCompletionList | undefined> {
        if (!lastNesSuggestion) {
            Logger.trace('[JointInlineCompletionProvider] 无 NES 缓存，同时请求');
            const completionsP = this._invokeCompletionsProvider(document, position, context, tokens);
            const nesP = this._invokeNESProvider(document, position, context, tokens);
            return this._returnCompletionsOrOtherwiseNES(completionsP, nesP, tokens);
        }

        Logger.trace('[JointInlineCompletionProvider] 有 NES 缓存，尝试快速检查');
        const nesP = this._invokeNESProvider(document, position, context, tokens);

        if (!nesP) {
            Logger.trace('[JointInlineCompletionProvider] NES Provider 不可用');
            const completionsP = this._invokeCompletionsProvider(document, position, context, tokens);
            return this._returnCompletionsOrOtherwiseNES(completionsP, nesP, tokens);
        }

        const NES_CACHE_WAIT_MS = 10;

        // 快速检查 NES
        try {
            Logger.trace(`[JointInlineCompletionProvider] 等待 NES ${NES_CACHE_WAIT_MS}ms`);
            const fastNesResult = await this.raceTimeout(
                this.raceCancellation(nesP, tokens.coreToken),
                NES_CACHE_WAIT_MS
            );

            if (
                fastNesResult &&
                this.doesNesSuggestionAgree(
                    document,
                    documentText,
                    lastNesSuggestion.docWithNesEditApplied,
                    fastNesResult.items[0]
                )
            ) {
                Logger.info('[JointInlineCompletionProvider] NES 缓存命中且一致，直接使用 NES');
                return this.toSingularList(fastNesResult, 'NES');
            }

            if (tokens.coreToken.isCancellationRequested) {
                tokens.completionsCts.cancel();
                tokens.nesCts.cancel();
                return undefined;
            }
        } catch (e) {
            Logger.error('[JointInlineCompletionProvider] NES 快速检查出错:', e);
        }

        Logger.trace('[JointInlineCompletionProvider] NES 未快速返回或不一致，触发 FIM');
        const completionsP = this._invokeCompletionsProvider(document, position, context, tokens);

        // 竞速
        const suggestionsList = await this.raceCancellation(
            Promise.race(
                [
                    completionsP?.then(res => ({ type: 'FIM' as const, res })),
                    nesP?.then(res => ({ type: 'NES' as const, res }))
                ].filter(p => p !== undefined) as Promise<{
                    type: 'FIM' | 'NES';
                    res: vscode.InlineCompletionList | undefined;
                }>[]
            ),
            tokens.coreToken
        );

        if (suggestionsList === undefined) {
            tokens.completionsCts.cancel();
            tokens.nesCts.cancel();
            return undefined;
        }

        // 如果 NES 先回且一致
        if (
            suggestionsList.type === 'NES' &&
            suggestionsList.res &&
            this.doesNesSuggestionAgree(
                document,
                documentText,
                lastNesSuggestion.docWithNesEditApplied,
                suggestionsList.res.items[0]
            )
        ) {
            Logger.info('[JointInlineCompletionProvider] NES 先回且一致，使用 NES');
            return this._returnNES(suggestionsList.res, completionsP, tokens);
        }

        Logger.trace('[JointInlineCompletionProvider] 回退到默认策略 (FIM 优先)');
        return this._returnCompletionsOrOtherwiseNES(completionsP, nesP, tokens);
    }

    private _invokeNESProvider(
        document: vscode.TextDocument,
        position: vscode.Position,
        context: vscode.InlineCompletionContext,
        tokens: { nesCts: vscode.CancellationTokenSource }
    ): Promise<vscode.InlineCompletionList | undefined> | undefined {
        Logger.trace('[JointInlineCompletionProvider] 调用 NES');
        return this.nesProvider
            .provideInlineCompletionItems(document, position, context, tokens.nesCts.token)
            .then(this.normalizeToList)
            .catch(e => {
                Logger.error('[JointInlineCompletionProvider] NES 错误:', e);
                return undefined;
            });
    }

    private _invokeCompletionsProvider(
        document: vscode.TextDocument,
        position: vscode.Position,
        context: vscode.InlineCompletionContext,
        tokens: { completionsCts: vscode.CancellationTokenSource }
    ): Promise<vscode.InlineCompletionList | undefined> | undefined {
        Logger.trace('[JointInlineCompletionProvider] 调用 FIM');
        return this.inlineCompletionProvider
            .provideInlineCompletionItems(document, position, context, tokens.completionsCts.token)
            .then(this.normalizeToList)
            .catch(e => {
                Logger.error('[JointInlineCompletionProvider] FIM 错误:', e);
                return undefined;
            });
    }

    private async _returnCompletionsOrOtherwiseNES(
        completionsP: Promise<vscode.InlineCompletionList | undefined> | undefined,
        nesP: Promise<vscode.InlineCompletionList | undefined> | undefined,
        tokens: { completionsCts: vscode.CancellationTokenSource; nesCts: vscode.CancellationTokenSource }
    ): Promise<SingularCompletionList | undefined> {
        const completionsR = completionsP ? await completionsP : undefined;
        if (completionsR && completionsR.items.length > 0) {
            Logger.info('[JointInlineCompletionProvider] 使用 FIM 结果');
            return this._returnCompletions(completionsR, nesP, tokens);
        }

        const nesR = nesP ? await nesP : undefined;
        if (nesR && nesR.items.length > 0) {
            Logger.info('[JointInlineCompletionProvider] FIM 无结果，使用 NES 结果');
            return this._returnNES(nesR, completionsP, tokens);
        }

        return undefined;
    }

    private _returnCompletions(
        completionsR: vscode.InlineCompletionList,
        nesP: Promise<vscode.InlineCompletionList | undefined> | undefined,
        tokens: { nesCts: vscode.CancellationTokenSource }
    ): SingularCompletionList {
        tokens.nesCts.cancel();
        return this.toSingularList(completionsR, 'FIM');
    }

    private _returnNES(
        nesR: vscode.InlineCompletionList,
        completionsP: Promise<vscode.InlineCompletionList | undefined> | undefined,
        tokens: { completionsCts: vscode.CancellationTokenSource }
    ): SingularCompletionList {
        tokens.completionsCts.cancel();
        return this.toSingularList(nesR, 'NES');
    }

    private doesNesSuggestionAgree(
        document: vscode.TextDocument,
        documentText: string,
        docWithNesEditApplied: string,
        nesEdit: vscode.InlineCompletionItem | undefined
    ): boolean {
        if (!nesEdit || !nesEdit.range || typeof nesEdit.insertText !== 'string') {
            return false;
        }
        const applied = this.applyTextEdit(document, documentText, nesEdit.range, nesEdit.insertText);
        return applied === docWithNesEditApplied;
    }

    private applyTextEdit(
        document: vscode.TextDocument,
        text: string,
        range: vscode.Range,
        insertText: string
    ): string {
        const startOffset = document.offsetAt(range.start);
        const endOffset = document.offsetAt(range.end);
        return text.substring(0, startOffset) + insertText + text.substring(endOffset);
    }

    private normalizeToList(
        result: vscode.InlineCompletionItem[] | vscode.InlineCompletionList | undefined
    ): vscode.InlineCompletionList | undefined {
        if (!result) {
            return undefined;
        }
        if (Array.isArray(result)) {
            return new vscode.InlineCompletionList(result);
        }
        return result;
    }

    private toSingularList(list: vscode.InlineCompletionList, source: 'FIM' | 'NES'): SingularCompletionList {
        const singularList = list as SingularCompletionList;
        singularList.source = source;
        return singularList;
    }

    private raceTimeout<T>(promise: Promise<T>, ms: number): Promise<T | undefined> {
        let timer: NodeJS.Timeout;
        const timeout = new Promise<undefined>(resolve => {
            timer = setTimeout(() => resolve(undefined), ms);
        });
        return Promise.race([
            promise.then(v => {
                clearTimeout(timer);
                return v;
            }),
            timeout
        ]);
    }

    private raceCancellation<T>(
        promise: Promise<T> | undefined,
        token: vscode.CancellationToken
    ): Promise<T | undefined> {
        if (!promise) {
            return Promise.resolve(undefined);
        }
        return new Promise((resolve, reject) => {
            const disposable = token.onCancellationRequested(() => {
                disposable.dispose();
                resolve(undefined);
            });
            promise
                .then(v => {
                    disposable.dispose();
                    resolve(v);
                })
                .catch(e => {
                    disposable.dispose();
                    reject(e);
                });
        });
    }

    dispose(): void {
        this.inlineCompletionProvider.dispose();
        this.nesProvider.dispose();
        this.disposables.forEach(d => d.dispose());
    }

    static createAndActivate(context: vscode.ExtensionContext): {
        provider: JointInlineCompletionProvider;
        disposables: vscode.Disposable[];
    } {
        const provider = new JointInlineCompletionProvider(context);
        provider.activate();
        return { provider, disposables: provider.disposables };
    }
}
