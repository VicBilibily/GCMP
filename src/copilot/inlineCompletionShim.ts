/*---------------------------------------------------------------------------------------------
 *  InlineCompletionShim - 轻量级内联补全代理
 *
 *  职责：
 *  - 提供开关检测和防抖处理
 *  - 延迟加载完整的 copilot 模块（@vscode/chat-lib）
 *  - 在首次触发补全时才加载重型依赖，优化扩展启动时间
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { t } from '../utils/l10n';
import { getCompletionLogger } from './singletons';

// ========================================================================
// 类型定义
// ========================================================================

/**
 * 完整 InlineCompletionProvider 的接口定义
 * 用于延迟加载后的类型推断
 */
interface IInlineCompletionProvider extends vscode.InlineCompletionItemProvider, vscode.Disposable {
    onDidChange: vscode.Event<void>;
    activate(): void;
}

/**
 * copilot 模块导出类型
 */
interface CopilotModule {
    InlineCompletionProvider: new (context: vscode.ExtensionContext) => IInlineCompletionProvider;
}

/**
 * 轻量级内联补全代理
 * 实现延迟加载策略，在首次触发补全时才加载完整的 copilot 模块
 */
export class InlineCompletionShim implements vscode.InlineCompletionItemProvider, vscode.Disposable {
    private readonly disposables: vscode.Disposable[] = [];

    private readonly onDidChangeEmitter = new vscode.EventEmitter<void>();
    readonly onDidChange = this.onDidChangeEmitter.event;

    // 完整的 InlineCompletionProvider 实例（延迟加载）
    private _realProvider: IInlineCompletionProvider | null = null;
    private _loadingPromise: Promise<IInlineCompletionProvider | null> | null = null;

    constructor(private readonly context: vscode.ExtensionContext) {
        this.disposables.push(this.onDidChangeEmitter);
        // WorkspaceAdapter 延迟加载，避免在 extension.js 中引入 chat-lib 依赖
    }

    // ========================================================================
    // 配置检测
    // ========================================================================

    /**
     * 检查 FIM 是否启用
     */
    private isFIMEnabled(): boolean {
        const config = vscode.workspace.getConfiguration('gcmp.fimCompletion');
        return config.get<boolean>('enabled', false);
    }

    /**
     * 检查 NES 是否启用
     */
    private isNESEnabled(): boolean {
        const config = vscode.workspace.getConfiguration('gcmp.nesCompletion');
        return config.get<boolean>('enabled', false);
    }

    // ========================================================================
    // 延迟加载
    // ========================================================================

    /**
     * 延迟加载完整的 copilot 模块
     */
    private async loadRealProvider(): Promise<IInlineCompletionProvider | null> {
        if (this._realProvider) {
            return this._realProvider;
        }

        // 避免重复加载
        if (this._loadingPromise) {
            return this._loadingPromise;
        }

        this._loadingPromise = (async () => {
            try {
                const CompletionLogger = getCompletionLogger();
                const startTime = Date.now();
                CompletionLogger.trace('[InlineCompletionShim] Loading copilot module...');

                // 动态加载 copilot 模块（使用 require，因为打包为 CommonJS）
                // 使用相对于当前目录的路径，避免打包后的路径问题
                // eslint-disable-next-line @typescript-eslint/no-require-imports
                const copilotModule: CopilotModule = require('../dist/copilot.bundle.js');
                const { InlineCompletionProvider } = copilotModule;

                // 创建并激活真实的 provider
                this._realProvider = new InlineCompletionProvider(this.context);
                this._realProvider.activate();

                // 转发 onDidChange 事件
                const forwardDisposable = this._realProvider.onDidChange(() => {
                    this.onDidChangeEmitter.fire();
                });
                this.disposables.push(forwardDisposable);

                const loadTime = Date.now() - startTime;
                CompletionLogger.info(`[InlineCompletionShim] Copilot module loaded (elapsed: ${loadTime}ms)`);

                return this._realProvider;
            } catch (error) {
                const CompletionLogger = getCompletionLogger();
                CompletionLogger.error('[InlineCompletionShim] Failed to load copilot module:', error);
                this._loadingPromise = null;
                return null;
            }
        })();

        return this._loadingPromise;
    }

    // ========================================================================
    // 激活与初始化
    // ========================================================================

    activate(): void {
        const CompletionLogger = getCompletionLogger();
        CompletionLogger.trace('[InlineCompletionShim] Activating lightweight agent (lazy load mode)');

        try {
            // 注册内联建议提供
            const provider = vscode.languages.registerInlineCompletionItemProvider({ pattern: '**/*' }, this);
            this.disposables.push(provider);

            // 注册命令（这些命令不依赖 chat-lib，直接在 shim 中处理）
            this.disposables.push(
                vscode.commands.registerCommand('gcmp.nesCompletion.toggleManual', async () => {
                    const CompletionLogger = getCompletionLogger();
                    const config = vscode.workspace.getConfiguration('gcmp.nesCompletion');
                    const currentState = config.get('manualOnly', false);
                    const newState = !currentState;
                    await vscode.workspace
                        .getConfiguration('gcmp.nesCompletion')
                        .update('manualOnly', newState, vscode.ConfigurationTarget.Global);
                    const modeText = newState ? t('Manual trigger', '手动触发') : t('Automatic trigger', '自动触发');
                    vscode.window.showInformationMessage(
                        t(
                            'GCMP: Next code edit suggestion mode: {0}',
                            'GCMP: 下一个代码编辑建议触发模式：{0}',
                            modeText
                        )
                    );
                    CompletionLogger.info(
                        `[InlineCompletionShim] NES manual trigger mode ${newState ? 'enabled' : 'disabled'}`
                    );
                })
            );

            CompletionLogger.info('[InlineCompletionShim] ✅ Activated (using lazy load strategy)');
        } catch (error) {
            CompletionLogger.error('[InlineCompletionShim] Activation failed:', error);
            throw error;
        }
    }

    // ========================================================================
    // InlineCompletionItemProvider 实现
    // ========================================================================

    async provideInlineCompletionItems(
        document: vscode.TextDocument,
        position: vscode.Position,
        context: vscode.InlineCompletionContext,
        token: vscode.CancellationToken
    ): Promise<vscode.InlineCompletionItem[] | vscode.InlineCompletionList | undefined> {
        // 开关检测：如果 FIM 和 NES 都未启用，直接返回
        if (!this.isFIMEnabled() && !this.isNESEnabled()) {
            return undefined;
        }

        // 编辑器失焦时不做任何请求
        if (vscode.window.activeTextEditor?.document !== document) {
            return undefined;
        }

        // 加载真实的 provider 并委托给它
        // shim 层不进行防抖，防抖逻辑由真实的 InlineCompletionProvider 处理
        const realProvider = await this.loadRealProvider();
        if (realProvider && !token.isCancellationRequested) {
            try {
                const result = await realProvider.provideInlineCompletionItems(document, position, context, token);
                return result ?? undefined;
            } catch (error) {
                const CompletionLogger = getCompletionLogger();
                CompletionLogger.error('[InlineCompletionShim] Completion request failed:', error);
                return undefined;
            }
        }
        return undefined;
    }

    // ========================================================================
    // 资源清理
    // ========================================================================

    dispose(): void {
        const CompletionLogger = getCompletionLogger();
        CompletionLogger.trace('[InlineCompletionShim] Starting resource cleanup');

        // 释放真实的 provider
        if (this._realProvider) {
            this._realProvider.dispose();
            this._realProvider = null;
        }

        // 清理所有 disposables
        this.disposables.forEach(d => {
            try {
                d.dispose();
            } catch (error) {
                const CompletionLogger = getCompletionLogger();
                CompletionLogger.warn('[InlineCompletionShim] Error during resource cleanup:', error);
            }
        });
        this.disposables.length = 0;

        CompletionLogger.info('🧹 [InlineCompletionShim] All resources released');
    }

    /**
     * 创建并激活 Shim
     */
    static createAndActivate(context: vscode.ExtensionContext): {
        provider: InlineCompletionShim;
        disposables: vscode.Disposable[];
    } {
        const provider = new InlineCompletionShim(context);
        provider.activate();
        return { provider, disposables: provider.disposables };
    }
}
