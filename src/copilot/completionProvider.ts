/*---------------------------------------------------------------------------------------------
 *  NESInlineCompletionProvider - NES 内联代码补全提供商
 *
 *  基于 @vscode/chat-lib 库实现
 *  使用 NES (Next Edit Suggest) 提供内联编辑建议
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { createNESProvider, INESProvider, INESResult } from '@vscode/chat-lib';
import { CancellationToken } from '@vscode/chat-lib/dist/src/_internal/util/vs/base/common/cancellation';

import { Logger } from '../utils';
import { NESCompletionConfig, FimProviderConfig } from './types';
import { WorkspaceAdapter } from './workspaceAdapter';
import { Fetcher } from './fetcher';
import { AuthenticationService } from './auth';
import { TelemetrySender } from './telemetry';
import { LogTarget } from './logTarget';

/**
 * NES 内联补全提供商
 * 基于 @vscode/chat-lib 的 NES (Next Edit Suggest) 提供商
 */
export class JointInlineCompletionProvider implements vscode.InlineCompletionItemProvider, vscode.Disposable {
    private readonly disposables: vscode.Disposable[] = [];

    // ========================================================================
    // 事件支持
    // ========================================================================
    private readonly onDidChangeEmitter = new vscode.EventEmitter<void>();
    readonly onDidChange = this.onDidChangeEmitter.event;

    // ========================================================================
    // NES 相关属性
    // ========================================================================
    private nesEnabled = true;
    private nesProvider: INESProvider<INESResult> | null = null;
    private nesWorkspaceAdapter: WorkspaceAdapter | null = null;
    private nesInitialized = false;
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
    private readonly nesDefaultConfig: NESCompletionConfig = {
        enabled: true,
        debounceMs: 500, // 更新为 500ms 防抖延迟
        timeoutMs: 5000,
        maxConcurrent: 1
    };

    // ========================================================================
    // 提供商配置
    // ========================================================================
    private nesProviderConfig: FimProviderConfig;

    constructor(private readonly context: vscode.ExtensionContext) {
        // 注册 emitter 的清理
        this.disposables.push(this.onDidChangeEmitter);

        // NES 提供商配置
        this.nesProviderConfig = {
            id: 'GLM',
            name: 'GLM-4.6',
            providerKey: 'siliconflow',
            baseUrl: 'https://api.siliconflow.cn/v1',
            requestPath: 'chat/completions',
            requestModel: 'zai-org/GLM-4.6',
            supportsSuffix: true,
            maxTokens: 4096
        };
    }

    // ========================================================================
    // 激活与初始化
    // ========================================================================

    activate(): void {
        Logger.trace('[JointInlineCompletionProvider.activate] 激活开始');

        try {
            // 初始化 NES 提供商
            this.initializeNesProvider()
                .then(() => Logger.trace('[JointInlineCompletionProvider] NES 提供商初始化成功'))
                .catch((error: unknown) => Logger.error('[JointInlineCompletionProvider] NES 初始化失败:', error));

            // 注册自己为提供商
            const provider = vscode.languages.registerInlineCompletionItemProvider({ pattern: '**/*' }, this);
            this.disposables.push(provider);

            // 注册命令
            this.registerCommands();

            // 监听配置变化
            this.disposables.push(
                vscode.workspace.onDidChangeConfiguration(e => {
                    if (e.affectsConfiguration('gcmp.nesCompletion')) {
                        this.updateNesConfig();
                    }
                })
            );

            Logger.info('✅ [JointInlineCompletionProvider] NES 提供商已激活');
        } catch (error) {
            Logger.error('[JointInlineCompletionProvider.activate] 激活失败:', error);
            throw error;
        }
    }

    /**
     * 初始化 NES 提供商 (基于 @vscode/chat-lib)
     */
    private async initializeNesProvider(): Promise<void> {
        this.nesWorkspaceAdapter = new WorkspaceAdapter();
        this.disposables.push(this.nesWorkspaceAdapter);

        this.nesProvider = createNESProvider({
            workspace: this.nesWorkspaceAdapter.getWorkspace(),
            fetcher: new Fetcher(this.nesProviderConfig),
            copilotTokenManager: new AuthenticationService(),
            telemetrySender: new TelemetrySender(),
            logTarget: new LogTarget(),
            waitForTreatmentVariables: false
        });

        this.nesInitialized = true;
    }

    // ========================================================================
    // 配置管理
    // ========================================================================

    private getNesConfig(): NESCompletionConfig {
        const config = vscode.workspace.getConfiguration('gcmp.nesCompletion');
        return {
            enabled: config.get('enabled', this.nesDefaultConfig.enabled),
            debounceMs: config.get('debounceMs', this.nesDefaultConfig.debounceMs),
            timeoutMs: config.get('timeoutMs', this.nesDefaultConfig.timeoutMs),
            maxConcurrent: config.get('maxConcurrent', this.nesDefaultConfig.maxConcurrent)
        };
    }

    private updateNesConfig(): void {
        const config = this.getNesConfig();
        this.nesEnabled = config.enabled;
        Logger.trace(`[JointInlineCompletionProvider] NES 配置已更新: enabled=${this.nesEnabled}`);
    }

    // ========================================================================
    // 命令注册
    // ========================================================================

    private registerCommands(): void {
        // NES 命令
        this.disposables.push(
            vscode.commands.registerCommand('gcmp.nesCompletion.enable', async () => {
                await vscode.workspace
                    .getConfiguration('gcmp.nesCompletion')
                    .update('enabled', true, vscode.ConfigurationTarget.Global);
                vscode.window.showInformationMessage('✅ NES 补全已启用');
                Logger.info('[JointInlineCompletionProvider] NES 补全已启用');
            })
        );

        this.disposables.push(
            vscode.commands.registerCommand('gcmp.nesCompletion.disable', async () => {
                await vscode.workspace
                    .getConfiguration('gcmp.nesCompletion')
                    .update('enabled', false, vscode.ConfigurationTarget.Global);
                vscode.window.showInformationMessage('❌ NES 补全已禁用');
                Logger.info('[JointInlineCompletionProvider] NES 补全已禁用');
            })
        );

        this.disposables.push(
            vscode.commands.registerCommand('gcmp.nesCompletion.toggle', async () => {
                const config = this.getNesConfig();
                const newState = !config.enabled;
                await vscode.workspace
                    .getConfiguration('gcmp.nesCompletion')
                    .update('enabled', newState, vscode.ConfigurationTarget.Global);
                vscode.window.showInformationMessage(`NES 补全 ${newState ? '已启用' : '已禁用'}`);
                Logger.info(`[JointInlineCompletionProvider] NES 补全 ${newState ? '已启用' : '已禁用'}`);
            })
        );

        Logger.trace('[JointInlineCompletionProvider.registerCommands] 已注册 3 个 NES 命令');
    }

    // ========================================================================
    // 主入口：NES 补全
    // ========================================================================

    async provideInlineCompletionItems(
        document: vscode.TextDocument,
        position: vscode.Position,
        context: vscode.InlineCompletionContext,
        token: vscode.CancellationToken
    ): Promise<vscode.InlineCompletionItem[] | vscode.InlineCompletionList | undefined> {
        const { triggerKind } = context as { triggerKind: vscode.InlineCompletionTriggerKind };

        // 记录触发类型和文件信息
        const triggerDesc = triggerKind === vscode.InlineCompletionTriggerKind.Invoke ? '手动' : '自动';
        Logger.trace(`[JointInlineCompletionProvider] NES 补全请求 (${triggerDesc}触发) - ${document.fileName}`);

        // 获取 NES 配置
        const nesConfig = this.getNesConfig();

        if (!nesConfig.enabled) {
            Logger.trace('[JointInlineCompletionProvider] NES 补全已禁用');
            return undefined;
        }

        // 手动触发时立即执行，不使用防抖
        if (triggerKind === vscode.InlineCompletionTriggerKind.Invoke) {
            Logger.trace('[JointInlineCompletionProvider] 手动触发，立即执行 NES 请求');
            return this.executeNesRequest(document, position, token, nesConfig);
        }

        const n = 1;
        if (n + n == 2) {
            // 禁止自动补全
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
                Logger.trace('[JointInlineCompletionProvider] 取消之前的 NES 请求（防抖）');
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
                    Logger.trace('[JointInlineCompletionProvider] 防抖定时器触发，但无待处理请求');
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
                    Logger.trace('[JointInlineCompletionProvider] 防抖定时器触发，执行 NES 请求');
                    const result = await this.executeNesRequest(
                        this.pendingDebounceRequest.document,
                        this.pendingDebounceRequest.position,
                        nesCts.token,
                        nesConfig
                    );
                    resolve(result);
                } catch (error) {
                    Logger.error('[JointInlineCompletionProvider] 防抖请求执行失败:', error);
                    resolve(undefined);
                } finally {
                    // 清理资源
                    tokenDisposable.dispose();
                    nesCts.dispose();
                    this.pendingDebounceRequest = null;
                }
            }, nesConfig.debounceMs);
        });
    }

    // ========================================================================
    // NES 核心实现
    // ========================================================================

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
            Logger.trace(`[JointInlineCompletionProvider] 同步文档到 NES 工作区: ${document.uri.toString()}`);
            this.nesWorkspaceAdapter!.syncDocument(document);

            // 给予文档同步一个短暂的机会完成（防抖周期通常是 300ms，但我们不能等那么久）
            // 所以我们同步调用，确保文档立即添加到工作区
            Logger.trace(`[JointInlineCompletionProvider] 文档同步完成，文档长度: ${document.getText().length}`);

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
            Logger.trace(`[JointInlineCompletionProvider] NES 请求完成，耗时: ${elapsed}ms`);

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

            Logger.trace(
                `[JointInlineCompletionProvider] 返回 NES 建议: range=${range.start}-${range.endExclusive}, ` +
                    `newText.length=${newText.length}, elapsed=${elapsed}ms`
            );

            // 通知 VS Code 有新的补全可用，触发刷新
            this.triggerChange();

            return new vscode.InlineCompletionList([completionItem]);
        } catch (error) {
            const elapsed = Date.now() - startTime;

            if (error instanceof Error && error.message.includes('超时')) {
                Logger.warn(`[JointInlineCompletionProvider] ${error.message}`);
                return undefined;
            }

            if (error instanceof Error && error.name === 'AbortError') {
                return undefined;
            }

            Logger.error(`[JointInlineCompletionProvider] NES 请求异常 (${elapsed}ms):`, error);
            return undefined;
        } finally {
            this.nesPendingRequestCount--;
            this.nesCurrentAbortController = null;
        }
    }

    // ========================================================================
    // 竞争结果处理
    // ========================================================================

    private async _returnCompletionsOrOtherwiseNES(
        completionsP: Promise<vscode.InlineCompletionList | undefined> | undefined,
        nesP: Promise<vscode.InlineCompletionList | undefined> | undefined,
        tokens: { completionsCts: vscode.CancellationTokenSource; nesCts: vscode.CancellationTokenSource }
    ): Promise<vscode.InlineCompletionList | undefined> {
        // NES 直接返回
        const nesR = nesP ? await nesP : undefined;
        if (nesR && nesR.items.length > 0) {
            Logger.info('[JointInlineCompletionProvider] 返回 NES 结果');
            Logger.trace(`  - NES 建议数: ${nesR.items.length}`);
            tokens.completionsCts.cancel();
            return nesR;
        }

        Logger.warn('[JointInlineCompletionProvider] NES 无结果');
        return undefined;
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
                .catch((e: unknown) => {
                    disposable.dispose();
                    reject(e);
                });
        });
    }

    // ========================================================================
    // 生命周期管理方法说明 (未定稿方法 - 仅说明，不实现)
    // ========================================================================
    //
    // ⚠️  重要说明：以下方法是 VS Code InlineCompletionItemProvider 接口的未定稿扩展方法。
    // 这些方法在 vscode.d.ts 中标记为 optional，表示其规范和行为仍在 Microsoft 和社区讨论中。
    //
    // 当前状态:
    // - 这些方法不属于 InlineCompletionItemProvider 的稳定 API
    // - 插件不应该直接依赖这些方法的存在或行为
    // - 未来可能会有改动或删除
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

    /**
     * 触发 onDidChange 事件，通知 VS Code 更新补全
     */
    private triggerChange(): void {
        Logger.trace('[JointInlineCompletionProvider.triggerChange] 触发 onDidChange 事件');
        this.onDidChangeEmitter.fire();
    }

    // ========================================================================
    // 资源清理
    // ========================================================================

    dispose(): void {
        Logger.trace('[JointInlineCompletionProvider.dispose] 开始释放资源');

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

        Logger.info('🧹 [JointInlineCompletionProvider] 已释放所有资源');
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
