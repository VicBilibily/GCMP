/*---------------------------------------------------------------------------------------------
 *  JointInlineCompletionProvider - 联合内联代码补全提供商
 *
 *  实现 "竞争模式" (Competition Mode):
 *  同时运行 FIM (InlineCompletionProvider) 和 NES (NESProvider)
 *  返回最先返回有效结果的那个。
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { InlineCompletionProvider } from './completionProvider';
import { NESProvider } from './nesProvider';
import { Logger } from '../utils/logger';

export class JointInlineCompletionProvider implements vscode.InlineCompletionItemProvider, vscode.Disposable {
    private readonly disposables: vscode.Disposable[] = [];
    private inlineCompletionProvider: InlineCompletionProvider;
    private nesProvider: NESProvider;

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

        Logger.info('✅ [JointInlineCompletionProvider] 联合提供商已激活 (竞争模式)');
    }

    async provideInlineCompletionItems(
        document: vscode.TextDocument,
        position: vscode.Position,
        context: vscode.InlineCompletionContext,
        token: vscode.CancellationToken
    ): Promise<vscode.InlineCompletionItem[] | vscode.InlineCompletionList | undefined> {
        Logger.trace('[JointInlineCompletionProvider] 开始竞争请求');

        const fimPromise = this.inlineCompletionProvider
            .provideInlineCompletionItems(document, position, context, token)
            .then(result => ({ source: 'FIM', result }));

        const nesPromise = this.nesProvider
            .provideInlineCompletionItems(document, position, context, token)
            .then(result => ({ source: 'NES', result }));

        // 竞争逻辑：
        // 我们想要第一个返回非空结果的提供商。
        // 如果都返回空，则返回 undefined。

        return new Promise(resolve => {
            let completedCount = 0;
            const total = 2;
            let resolved = false;

            const handleResult = (
                source: string,
                result: vscode.InlineCompletionItem[] | vscode.InlineCompletionList | undefined
            ) => {
                if (resolved) return;

                const hasItems = result && (Array.isArray(result) ? result.length > 0 : result.items.length > 0);

                if (hasItems) {
                    Logger.info(`[JointInlineCompletionProvider] ${source} 获胜，补全结果：${JSON.stringify(result)}`);
                    resolved = true;
                    resolve(result);
                } else {
                    completedCount++;
                    if (completedCount === total) {
                        Logger.trace('[JointInlineCompletionProvider] 所有提供商均无结果');
                        resolve(undefined);
                    }
                }
            };

            fimPromise
                .then(({ source, result }) => handleResult(source, result))
                .catch(err => {
                    Logger.error('[JointInlineCompletionProvider] FIM 错误:', err);
                    handleResult('FIM', undefined);
                });

            nesPromise
                .then(({ source, result }) => handleResult(source, result))
                .catch(err => {
                    Logger.error('[JointInlineCompletionProvider] NES 错误:', err);
                    handleResult('NES', undefined);
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
