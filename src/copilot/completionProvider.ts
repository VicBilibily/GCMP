/*---------------------------------------------------------------------------------------------
 *  NESInlineCompletionProvider - NES 内联代码补全
 *
 *  基于 @vscode/chat-lib 库实现
 *  使用 NES (Next Edit Suggestions) 提供内联编辑建议
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { createNESProvider, INESProvider, INESResult } from '@vscode/chat-lib';
import { CancellationToken } from '@vscode/chat-lib/dist/src/_internal/util/vs/base/common/cancellation';

import { NESLogger } from '../utils';
import { ConfigManager, NESCompletionConfig } from '../utils/configManager';
import { WorkspaceAdapter } from './workspaceAdapter';
import { Fetcher } from './fetcher';
import { AuthenticationService, TelemetrySender } from './mockImpl';
import { CopilotLogTarget } from './logTarget';

/**
 * NES 内联补全
 * 基于 @vscode/chat-lib 的 NES (Next Edit Suggestions) 内联补全提示
 */
export class InlineCompletionProvider implements vscode.InlineCompletionItemProvider, vscode.Disposable {
    private readonly disposables: vscode.Disposable[] = [];

    // ========================================================================
    // 事件支持
    // ========================================================================
    private readonly onDidChangeEmitter = new vscode.EventEmitter<void>();
    readonly onDidChange = this.onDidChangeEmitter.event;

    // ========================================================================
    // NES 相关属性
    // ========================================================================
    private nesProvider: INESProvider<INESResult> | null = null;
    private nesWorkspaceAdapter: WorkspaceAdapter | null = null;

    private nesPendingRequestCount = 0;
    private nesCurrentAbortController: vscode.CancellationTokenSource | null = null;

    private nesDebounceTimer: ReturnType<typeof setTimeout> | null = null;
    private pendingDebounceRequest: {
        document: vscode.TextDocument;
        position: vscode.Position;
        context: vscode.InlineCompletionContext;
        token: vscode.CancellationToken;
        resolve: (result: vscode.InlineCompletionItem[] | vscode.InlineCompletionList | undefined) => void;
    } | null = null;

    constructor(private readonly context: vscode.ExtensionContext) {
        // 注册 emitter 的清理
        this.disposables.push(this.onDidChangeEmitter);
    }

    // ========================================================================
    // 激活与初始化
    // ========================================================================

    activate(): void {
        NESLogger.trace('[InlineCompletionProvider.activate] 激活开始');

        try {
            // 初始化 NES 提供商
            this.nesWorkspaceAdapter = new WorkspaceAdapter();
            this.disposables.push(this.nesWorkspaceAdapter);

            this.nesProvider = createNESProvider({
                workspace: this.nesWorkspaceAdapter.getWorkspace(),
                fetcher: new Fetcher(),
                copilotTokenManager: new AuthenticationService(),
                telemetrySender: new TelemetrySender(),
                logTarget: new CopilotLogTarget(),
                waitForTreatmentVariables: false
            });

            NESLogger.trace('[InlineCompletionProvider] NES 提供商初始化成功');

            // 注册自己为提供商
            const provider = vscode.languages.registerInlineCompletionItemProvider({ pattern: '**/*' }, this);
            this.disposables.push(provider);

            // 注册命令
            this.disposables.push(
                vscode.commands.registerCommand('gcmp.nesCompletion.enable', async () => {
                    await vscode.workspace
                        .getConfiguration('gcmp.nesCompletion')
                        .update('enabled', true, vscode.ConfigurationTarget.Global);
                    vscode.window.showInformationMessage('GCMP: NES 补全 已启用');
                    NESLogger.info('[InlineCompletionProvider] NES 补全已启用');
                })
            );

            this.disposables.push(
                vscode.commands.registerCommand('gcmp.nesCompletion.disable', async () => {
                    await vscode.workspace
                        .getConfiguration('gcmp.nesCompletion')
                        .update('enabled', false, vscode.ConfigurationTarget.Global);
                    vscode.window.showInformationMessage('GCMP: NES 补全 已禁用');
                    NESLogger.info('[InlineCompletionProvider] NES 补全已禁用');
                })
            );

            this.disposables.push(
                vscode.commands.registerCommand('gcmp.nesCompletion.toggle', async () => {
                    const config = vscode.workspace.getConfiguration('gcmp.nesCompletion');
                    const currentState = config.get('enabled', false);
                    const newState = !currentState;
                    await vscode.workspace
                        .getConfiguration('gcmp.nesCompletion')
                        .update('enabled', newState, vscode.ConfigurationTarget.Global);
                    vscode.window.showInformationMessage(`GCMP: NES 补全 ${newState ? '已启用' : '已禁用'}`);
                    NESLogger.info(`[InlineCompletionProvider] NES 补全 ${newState ? '已启用' : '已禁用'}`);
                })
            );

            this.disposables.push(
                vscode.commands.registerCommand('gcmp.nesCompletion.toggleManual', async () => {
                    const config = vscode.workspace.getConfiguration('gcmp.nesCompletion');
                    const currentState = config.get('manualOnly', false);
                    const newState = !currentState;
                    await vscode.workspace
                        .getConfiguration('gcmp.nesCompletion')
                        .update('manualOnly', newState, vscode.ConfigurationTarget.Global);
                    vscode.window.showInformationMessage(`GCMP: NES 触发模式 ${newState ? '手动触发' : '自动触发'}`);
                    NESLogger.info(`[InlineCompletionProvider] NES 手动触发模式 ${newState ? '已启用' : '已禁用'}`);
                })
            );

            NESLogger.trace('[InlineCompletionProvider.registerCommands] 已注册 4 个 NES 命令');

            NESLogger.info('✅ [InlineCompletionProvider] NES 提供商已激活');
        } catch (error) {
            NESLogger.error('[InlineCompletionProvider.activate] 激活失败:', error);
            throw error;
        }
    }

    async provideInlineCompletionItems(
        document: vscode.TextDocument,
        position: vscode.Position,
        context: vscode.InlineCompletionContext,
        token: vscode.CancellationToken
    ): Promise<vscode.InlineCompletionItem[] | vscode.InlineCompletionList | undefined> {
        const { triggerKind } = context as { triggerKind: vscode.InlineCompletionTriggerKind };

        // 获取 NES 配置
        const nesConfig = ConfigManager.getNESConfig();

        if (!nesConfig.enabled) {
            NESLogger.trace('[InlineCompletionProvider] NES 补全已禁用');
            return undefined;
        }

        // 记录触发类型和文件信息
        const triggerDesc = triggerKind === vscode.InlineCompletionTriggerKind.Invoke ? '手动' : '自动';
        NESLogger.trace(`[InlineCompletionProvider] NES 补全请求 (${triggerDesc}触发) - ${document.fileName}`);

        // 手动触发时立即执行，不使用防抖
        if (triggerKind === vscode.InlineCompletionTriggerKind.Invoke) {
            NESLogger.trace('[InlineCompletionProvider] 手动触发，立即执行 NES 请求');
            return this.executeNesRequest(document, position, token, nesConfig);
        }

        // 检查是否启用手动触发模式
        if (nesConfig.manualOnly) {
            NESLogger.trace('[InlineCompletionProvider] NES 补全仅支持手动触发模式');
            return Promise.resolve(undefined);
        }

        // 防抖机制：返回一个 Promise，将在 500ms 后执行
        return new Promise<vscode.InlineCompletionItem[] | vscode.InlineCompletionList | undefined>(resolve => {
            // 取消之前的防抖定时器
            if (this.nesDebounceTimer) {
                clearTimeout(this.nesDebounceTimer);
                this.nesDebounceTimer = null;
            }

            // 取消之前的请求
            if (this.nesCurrentAbortController) {
                NESLogger.trace('[InlineCompletionProvider] 取消之前的 NES 请求（防抖）');
                this.nesCurrentAbortController.cancel();
                this.nesCurrentAbortController = null;
            }

            // 保存当前请求信息
            this.pendingDebounceRequest = {
                document,
                position,
                context,
                token,
                resolve
            };

            // 设置新的防抖定时器
            this.nesDebounceTimer = setTimeout(async () => {
                // 清除定时器引用
                this.nesDebounceTimer = null;

                // 检查是否还有待处理的请求
                if (!this.pendingDebounceRequest) {
                    NESLogger.trace('[InlineCompletionProvider] 防抖定时器触发，但无待处理请求');
                    resolve(undefined);
                    return;
                }

                // 创建取消控制器
                const nesCts = new vscode.CancellationTokenSource();
                this.nesCurrentAbortController = nesCts;

                // 链接外部 token 取消事件
                const tokenDisposable = token.onCancellationRequested(() => {
                    nesCts.cancel();
                    if (this.nesCurrentAbortController === nesCts) {
                        this.nesCurrentAbortController = null;
                    }
                });

                try {
                    NESLogger.trace('[InlineCompletionProvider] 防抖定时器触发，执行 NES 请求');
                    const result = await this.executeNesRequest(
                        this.pendingDebounceRequest.document,
                        this.pendingDebounceRequest.position,
                        nesCts.token,
                        nesConfig
                    );
                    resolve(result);
                } catch (error) {
                    NESLogger.error('[InlineCompletionProvider] 防抖请求执行失败:', error);
                    resolve(undefined);
                } finally {
                    // 清理资源
                    tokenDisposable.dispose();
                    nesCts.dispose();
                    this.pendingDebounceRequest = null;
                    // 通知可能存在新的可用提示
                    this.onDidChangeEmitter.fire();
                }
            }, nesConfig.debounceMs);
        });
    }

    /**
     * 执行 NES 请求（带超时控制）
     */
    private async executeNesRequest(
        document: vscode.TextDocument,
        _position: vscode.Position,
        token: vscode.CancellationToken,
        config: NESCompletionConfig
    ): Promise<vscode.InlineCompletionList | undefined> {
        this.nesPendingRequestCount++;
        const startTime = Date.now();

        try {
            // 确保文档已同步到工作区（关键：必须在请求前同步）
            NESLogger.trace(`[InlineCompletionProvider] 同步文档到 NES 工作区: ${document.uri.toString()}`);
            this.nesWorkspaceAdapter!.syncDocument(document);

            // 给予文档同步一个短暂的机会完成（防抖周期通常是 300~500ms，但我们不能等那么久）
            // 所以我们同步调用，确保文档立即添加到工作区
            NESLogger.trace(`[InlineCompletionProvider] 文档同步完成，文档长度: ${document.getText().length}`);

            // 创建超时 Promise
            const timeoutPromise = new Promise<null>((_, reject) => {
                setTimeout(() => {
                    reject(new Error(`NES 请求超时 (${config.timeoutMs}ms)`));
                }, config.timeoutMs);
            });

            // 使用 chat-lib NES 提供商获取下一个编辑建议
            const nesPromise = this.nesProvider!.getNextEdit(document.uri, token as unknown as CancellationToken);

            // 竞争：请求 vs 超时
            const nesResult = await Promise.race([nesPromise, timeoutPromise]);

            const elapsed = Date.now() - startTime;
            NESLogger.trace(`[InlineCompletionProvider] NES 请求完成，耗时: ${elapsed}ms`);

            if (!nesResult || !nesResult.result) {
                return undefined;
            }

            // 将 NES 结果转换为 VS Code InlineCompletionItem
            const { newText, range } = nesResult.result;

            if (!newText) {
                return undefined;
            }

            // 将字符偏移转换为 VS Code Position
            const startPos = document.positionAt(range.start);
            const endPos = document.positionAt(range.endExclusive);
            const vscodeRange = new vscode.Range(startPos, endPos);

            const completionItem = new vscode.InlineCompletionItem(newText, vscodeRange);

            // 记录建议已显示
            this.nesProvider!.handleShown(nesResult);

            NESLogger.info(
                `[InlineCompletionProvider] 返回 NES 建议: range=${range.start}-${range.endExclusive}, ` +
                    `newText.length=${newText.length}, elapsed=${elapsed}ms, insertText=\r\n${completionItem?.insertText}`
            );

            return new vscode.InlineCompletionList([completionItem]);
        } catch (error) {
            const elapsed = Date.now() - startTime;

            if (error instanceof Error && error.message.includes('超时')) {
                NESLogger.warn(`[InlineCompletionProvider] ${error.message}`);
                return undefined;
            }

            if (error instanceof Error && error.name === 'AbortError') {
                return undefined;
            }

            NESLogger.error(`[InlineCompletionProvider] NES 请求异常 (${elapsed}ms):`, error);
            return undefined;
        } finally {
            this.nesPendingRequestCount--;
            this.nesCurrentAbortController = null;
            // 延时通知可能存在新的可用提示
            setTimeout(() => this.onDidChangeEmitter.fire(), 200);
        }
    }

    // ========================================================================
    // 生命周期管理方法说明 (未定稿方法 - 仅说明，不实现)
    // ========================================================================
    //
    // 当前状态:
    // - 这些方法不属于 InlineCompletionItemProvider 的稳定 API
    // - 实现这些方法会导致初始化错误，因此仅保留说明文档
    //
    // 未来可能的实现方法:
    //
    // 1. handleDidShowCompletionItem(_completionItem: vscode.InlineCompletionItem): void
    //    - 处理补全项显示时的回调
    //    - 补全项被实际显示给用户时调用
    //    - 用途: 遥测、日志、分析用户交互等
    //
    // 2. handleDidPartiallyAcceptCompletionItem(
    //      _completionItem: vscode.InlineCompletionItem,
    //      acceptedLength: number & vscode.PartialAcceptInfo
    //    ): void
    //    - 处理补全项被部分接受时的回调
    //    - 用户只取前几个字符时调用
    //    - 用途: 追踪用户满意度、优化补全长度等
    //
    // 3. handleEndOfLifetime(
    //      _completionItem: vscode.InlineCompletionItem,
    //      reason: vscode.InlineCompletionEndOfLifeReason
    //    ): void
    //    - 补全项生命周期结束回调
    //    - 原因包括: Accepted | Discarded | Ignored | Autocancelled | Unknown
    //    - 用途: 记录补全被接受/拒绝的原因
    //
    // 4. handleListEndOfLifetime(
    //      list: vscode.InlineCompletionList,
    //      reason: vscode.InlineCompletionsDisposeReason
    //    ): void
    //    - 补全列表生命周期结束回调
    //    - 原因包括: LostRace | NotTaken | TokenCancellation | Unknown
    //    - 用途: 清理、资源释放、最终遥测报告等
    //
    // ========================================================================

    // ========================================================================
    // 资源清理
    // ========================================================================

    dispose(): void {
        NESLogger.trace('[InlineCompletionProvider.dispose] 开始释放资源');

        // 取消挂起的 NES 请求
        if (this.nesCurrentAbortController) {
            this.nesCurrentAbortController.cancel();
            this.nesCurrentAbortController = null;
        }

        // 清除 NES 防抖定时器
        if (this.nesDebounceTimer) {
            clearTimeout(this.nesDebounceTimer);
            this.nesDebounceTimer = null;
        }

        // 清理防抖请求
        if (this.pendingDebounceRequest) {
            this.pendingDebounceRequest.resolve(undefined);
            this.pendingDebounceRequest = null;
        }

        // 释放 NES 提供商
        if (this.nesProvider) {
            this.nesProvider.dispose();
            this.nesProvider = null;
        }

        // 清理所有 disposables (包含 nesWorkspaceAdapter)
        this.disposables.forEach(d => d.dispose());
        this.disposables.length = 0;

        NESLogger.info('🧹 [InlineCompletionProvider] 已释放所有资源');
    }

    static createAndActivate(context: vscode.ExtensionContext): {
        provider: InlineCompletionProvider;
        disposables: vscode.Disposable[];
    } {
        const provider = new InlineCompletionProvider(context);
        provider.activate();
        return { provider, disposables: provider.disposables };
    }
}
