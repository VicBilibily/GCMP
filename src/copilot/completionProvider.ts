/*---------------------------------------------------------------------------------------------
 *  InlineCompletionProvider - 内联代码补全建议
 *
 *  基于 @vscode/chat-lib 库实现
 *  使用 FIM / NES 提供内联编辑建议
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import {
    createInlineCompletionsProvider,
    createNESProvider,
    IActionItem,
    ICompletionsStatusChangedEvent,
    ICompletionsStatusHandler,
    IInlineCompletionsProvider,
    INESProvider,
    INESResult,
    INotificationSender,
    IURLOpener
} from '@vscode/chat-lib';
import { CancellationToken } from '@vscode/chat-lib/dist/src/_internal/util/vs/base/common/cancellation';

import { CompletionLogger, VersionManager } from '../utils';
import { ConfigManager } from '../utils/configManager';
import { WorkspaceAdapter } from './workspaceAdapter';
import { Fetcher } from './fetcher';
import { AuthenticationService, EndpointProvider, TelemetrySender } from './mockImpl';
import { CopilotLogTarget } from './logTarget';
import { DocumentManager } from './documentManager';
import { MutableObservableWorkspace } from '@vscode/chat-lib/dist/src/_internal/platform/inlineEdits/common/observableWorkspace';
import { CopilotTextDocument } from '@vscode/chat-lib/dist/src/_internal/extension/completions-core/vscode-node/lib/src/textDocument';

// ========================================================================
// 类型定义
// ========================================================================

/** 令牌集合 */
interface CompletionTokens {
    coreToken?: vscode.CancellationToken;
    completionsCts?: vscode.CancellationTokenSource;
    nesCts: vscode.CancellationTokenSource;
}

/**
 * FIM / NES 内联补全
 * 基于 @vscode/chat-lib 的 FIM / NES 内联补全提示
 */
export class InlineCompletionProvider implements vscode.InlineCompletionItemProvider, vscode.Disposable {
    private readonly disposables: vscode.Disposable[] = [];

    private readonly onDidChangeEmitter = new vscode.EventEmitter<void>();
    readonly onDidChange = this.onDidChangeEmitter.event;

    // ========================================================================
    // 补全提供者 (fimProvider 和 nesProvider 使用懒加载)
    // ========================================================================
    private _fimProvider: IInlineCompletionsProvider | null = null;
    private _nesProvider: INESProvider<INESResult> | null = null;
    private nesWorkspaceAdapter: WorkspaceAdapter | null = null;

    // 懒加载辅助变量
    private _fetcher: Fetcher | null = null;
    private _logTarget: CopilotLogTarget | null = null;
    private _authService: AuthenticationService | null = null;
    private _telemetrySender: TelemetrySender | null = null;

    private debounceTimer: ReturnType<typeof setTimeout> | null = null;
    private pendingDebounceRequest: {
        document: vscode.TextDocument;
        position: vscode.Position;
        context: vscode.InlineCompletionContext;
        token: vscode.CancellationToken;
        resolve: (result: vscode.InlineCompletionItem[] | vscode.InlineCompletionList | undefined) => void;
    } | null = null;

    private invocationCount = 0;

    constructor(private readonly context: vscode.ExtensionContext) {
        this.disposables.push(this.onDidChangeEmitter);
    }

    // ========================================================================
    // 懒加载 Getter
    // ========================================================================

    /** 懒加载获取 FIM 提供者 */
    private get fimProvider(): IInlineCompletionsProvider | null {
        if (!this._fimProvider) {
            this.initializeProviders();
        }
        return this._fimProvider;
    }

    /** 懒加载获取 NES 提供者 */
    private get nesProvider(): INESProvider<INESResult> | null {
        if (!this._nesProvider) {
            this.initializeProviders();
        }
        return this._nesProvider;
    }

    /** 初始化提供者（懒加载时调用） */
    private initializeProviders(): void {
        if (this._fimProvider && this._nesProvider) {
            return; // 已初始化
        }

        CompletionLogger.trace('[InlineCompletionProvider] 懒加载初始化 FIM/NES 提供者');

        try {
            // 初始化共享依赖
            this._fetcher = new Fetcher();
            this._logTarget = new CopilotLogTarget();
            this._authService = new AuthenticationService();
            this._telemetrySender = new TelemetrySender();

            // 确保 nesWorkspaceAdapter 已初始化
            if (!this.nesWorkspaceAdapter) {
                this.nesWorkspaceAdapter = new WorkspaceAdapter();
                this.disposables.push(this.nesWorkspaceAdapter);
            }

            // 初始化 FIM 提供者
            this._fimProvider = createInlineCompletionsProvider({
                fetcher: this._fetcher,
                authService: this._authService,
                telemetrySender: this._telemetrySender,
                logTarget: this._logTarget,
                isRunningInTest: false,
                contextProviderMatch: async () => 0,
                statusHandler: new (class implements ICompletionsStatusHandler {
                    didChange(_: ICompletionsStatusChangedEvent) {}
                })(),
                documentManager: new DocumentManager(),
                workspace: new MutableObservableWorkspace(),
                urlOpener: new (class implements IURLOpener {
                    async open(_url: string) {}
                })(),
                editorInfo: { name: 'vscode', version: vscode.version },
                editorPluginInfo: { name: 'gcmp', version: VersionManager.getVersion() },
                relatedPluginInfo: [],
                editorSession: {
                    sessionId: `gcmp-session-${Date.now()}`,
                    machineId: `gcmp-machine-${Math.random().toString(36).substring(7)}`
                },
                notificationSender: new (class implements INotificationSender {
                    async showWarningMessage(_message: string, ..._items: IActionItem[]) {
                        return undefined;
                    }
                })(),
                endpointProvider: new EndpointProvider()
            });

            // 初始化 NES 提供者
            this._nesProvider = createNESProvider({
                workspace: this.nesWorkspaceAdapter.getWorkspace(),
                fetcher: this._fetcher,
                copilotTokenManager: this._authService,
                telemetrySender: this._telemetrySender,
                logTarget: this._logTarget,
                waitForTreatmentVariables: false
            });

            CompletionLogger.info('[InlineCompletionProvider] FIM/NES 提供者懒加载完成');
        } catch (error) {
            CompletionLogger.error('[InlineCompletionProvider] 懒加载初始化提供者失败:', error);
            throw error;
        }
    }

    // ========================================================================
    // 激活与初始化
    // ========================================================================

    activate(): void {
        CompletionLogger.trace('[InlineCompletionProvider.activate] 激活开始');

        try {
            // 注册内联建议提供
            const provider = vscode.languages.registerInlineCompletionItemProvider({ pattern: '**/*' }, this);
            this.disposables.push(provider);

            // 注册命令
            this.disposables.push(
                vscode.commands.registerCommand('gcmp.nesCompletion.toggleManual', async () => {
                    const config = vscode.workspace.getConfiguration('gcmp.nesCompletion');
                    const currentState = config.get('manualOnly', false);
                    const newState = !currentState;
                    await vscode.workspace
                        .getConfiguration('gcmp.nesCompletion')
                        .update('manualOnly', newState, vscode.ConfigurationTarget.Global);
                    vscode.window.showInformationMessage(
                        `GCMP: 下一个代码编辑建议 触发模式：${newState ? '手动触发' : '自动触发'}`
                    );
                    CompletionLogger.info(
                        `[InlineCompletionProvider] NES 手动触发模式 ${newState ? '已启用' : '已禁用'}`
                    );
                })
            );

            CompletionLogger.info('✅ [InlineCompletionProvider] 已激活（使用懒加载）');
        } catch (error) {
            CompletionLogger.error('[InlineCompletionProvider.activate] 激活失败:', error);
            throw error;
        }
    }

    async provideInlineCompletionItems(
        document: vscode.TextDocument,
        position: vscode.Position,
        context: vscode.InlineCompletionContext,
        token: vscode.CancellationToken
    ): Promise<vscode.InlineCompletionItem[] | vscode.InlineCompletionList | undefined> {
        const fimConfig = ConfigManager.getFIMConfig();
        const nesConfig = ConfigManager.getNESConfig();
        if (!fimConfig.enabled && !nesConfig.enabled) {
            CompletionLogger.trace('[InlineCompletionProvider] 补全功能未启用');
            return undefined;
        }

        const { triggerKind } = context as { triggerKind: vscode.InlineCompletionTriggerKind };

        const triggerDesc = triggerKind === vscode.InlineCompletionTriggerKind.Invoke ? '手动' : '自动';
        CompletionLogger.trace(`[InlineCompletionProvider] 补全请求 (${triggerDesc}触发) - ${document.fileName}`);

        // 防抖处理：对自动触发进行防抖，防止频繁请求
        if (triggerKind !== vscode.InlineCompletionTriggerKind.Invoke) {
            return new Promise(resolve => {
                // 清除上一个待处理的防抖请求
                if (this.pendingDebounceRequest) {
                    this.pendingDebounceRequest.resolve(undefined);
                }

                // 清除现有的防抖定时器
                if (this.debounceTimer) {
                    clearTimeout(this.debounceTimer);
                }

                // 保存当前请求信息
                this.pendingDebounceRequest = { document, position, context, token, resolve };

                // 优先使用 FIM 的防抖配置，其次使用 NES 的防抖配置
                const debounceMs = Math.min(fimConfig.debounceMs, nesConfig.debounceMs);

                // 设置防抖延迟
                this.debounceTimer = setTimeout(() => {
                    // 检查是否还是最新请求
                    if (this.pendingDebounceRequest?.token === token) {
                        this.debounceTimer = null;
                        this.pendingDebounceRequest = null;

                        const invocationId = ++this.invocationCount;
                        CompletionLogger.trace(`[InlineCompletionProvider] 请求 #${invocationId} 开始`);

                        const completionsCts = new vscode.CancellationTokenSource();
                        const nesCts = new vscode.CancellationTokenSource();

                        // 链接外部 token 取消事件
                        const tokenDisposable = token.onCancellationRequested(() => {
                            completionsCts.cancel();
                            nesCts.cancel();
                        });

                        this._provideInlineCompletionItems(document, position, {
                            coreToken: token,
                            completionsCts,
                            nesCts
                        })
                            .then(result => {
                                resolve(result);
                            })
                            .catch(() => {
                                resolve(undefined);
                            })
                            .finally(() => {
                                tokenDisposable.dispose();
                                completionsCts.dispose();
                                nesCts.dispose();
                                // 延时通知可能存在新的可用提示
                                setTimeout(() => this.onDidChangeEmitter.fire(), 200);
                            });
                    }
                }, debounceMs);
            });
        }

        // 手动触发的直接进入 NES 下一个编辑建议处理
        const nesCts = new vscode.CancellationTokenSource();
        const tokenDisposable = token.onCancellationRequested(() => {
            nesCts.cancel();
        });
        try {
            const invocationId = ++this.invocationCount;
            CompletionLogger.trace(`[InlineCompletionProvider] 请求 #${invocationId} 开始`);
            // 手动触发直接执行
            return this._invokeNESProvider(document, { nesCts });
        } finally {
            tokenDisposable.dispose();
            nesCts.dispose();

            // 延时通知可能存在新的可用提示
            setTimeout(() => this.onDidChangeEmitter.fire(), 200);
        }
    }

    private async _provideInlineCompletionItems(
        document: vscode.TextDocument,
        position: vscode.Position,
        tokens: CompletionTokens & {
            coreToken: vscode.CancellationToken;
            completionsCts: vscode.CancellationTokenSource;
        }
    ): Promise<vscode.InlineCompletionList | undefined> {
        const fimConfig = ConfigManager.getFIMConfig();
        const nesConfig = ConfigManager.getNESConfig();

        // 情况1：FIM 和 NES 都启用
        if (fimConfig.enabled && nesConfig.enabled) {
            // NES 手动触发模式：仅使用 FIM
            if (nesConfig.manualOnly) {
                CompletionLogger.trace('[InlineCompletionProvider] FIM 和 NES 启用，但 NES 手动触发，使用 FIM');
                return this._invokeFIMProvider(document, position, tokens);
            }

            // NES 自动触发模式：根据光标位置选择
            // 检查光标是否在行尾
            const cursorLine = document.lineAt(position.line).text;
            let lastNonWhitespaceChar = cursorLine.length - 1;
            while (lastNonWhitespaceChar >= 0 && /\s/.test(cursorLine[lastNonWhitespaceChar])) {
                lastNonWhitespaceChar--;
            }
            const isCursorAtEndOfLine = position.character >= lastNonWhitespaceChar + 1;

            if (isCursorAtEndOfLine) {
                CompletionLogger.trace('[InlineCompletionProvider] 光标在行尾，使用 FIM');
                return this._invokeFIMProvider(document, position, tokens);
            } else {
                CompletionLogger.trace('[InlineCompletionProvider] 光标不在行尾，使用 NES');
                const nesResult = await this._invokeNESProvider(document, tokens);
                if (nesResult) {
                    // 检查 NES 结果是否为有意义的编辑
                    let isMeaningfulEdit = false;
                    if (nesResult.items.length > 0) {
                        for (const item of nesResult.items) {
                            // 如果没有范围信息，认为是有意义的（可能是命令或其他操作）
                            if (!item.range) {
                                isMeaningfulEdit = true;
                                break;
                            }
                            // 如果插入文本不是字符串，认为是有意义的
                            if (typeof item.insertText !== 'string') {
                                isMeaningfulEdit = true;
                                break;
                            }
                            // 获取范围内的原始文本
                            const originalText = document.getText(item.range);

                            // 若插入文本与原始文本相同，跳过
                            if (originalText === item.insertText) {
                                continue;
                            }

                            // 检查是否是"完全替换整行"的情况（可能是 NES 误解上下文）
                            // 如果替换范围包含整行且插入文本包含多行，可能是过度生成
                            const insertedLines = item.insertText.split('\n');
                            const originalLines = originalText.split('\n');

                            if (
                                item.range.start.character === 0 &&
                                item.range.end.character === document.lineAt(item.range.end.line).text.length &&
                                insertedLines.length > originalLines.length + 2
                            ) {
                                CompletionLogger.trace(
                                    `[InlineCompletionProvider] NES 生成内容异常（跨多行替换），可能误解了上下文:\r\n原始文本=\r\n${originalText}\r\n插入文本=\r\n${item.insertText}`
                                );
                                // 这种情况认为是无意义编辑，继续检查下一项
                                continue;
                            }

                            // 认为是有意义的编辑
                            CompletionLogger.trace(
                                `[InlineCompletionProvider] NES 建议与原始文本不同，视为有意义编辑:\r\n原始文本=\r\n${originalText}\r\n插入文本=\r\n${item.insertText}`
                            );
                            isMeaningfulEdit = true;
                            break;
                        }
                    }

                    if (isMeaningfulEdit) {
                        CompletionLogger.trace('[InlineCompletionProvider] NES 有意义结果，返回 NES 结果');
                        return nesResult;
                    } else {
                        CompletionLogger.trace('[InlineCompletionProvider] NES 结果无意义或过度生成，回退到 FIM');
                        return this._invokeFIMProvider(document, position, tokens);
                    }
                }
                // NES 无结果，回退到 FIM
                CompletionLogger.trace('[InlineCompletionProvider] NES 无结果，回退到 FIM');
                return this._invokeFIMProvider(document, position, tokens);
            }
        }

        // 情况2：只有 FIM 启用
        if (fimConfig.enabled) {
            CompletionLogger.trace('[InlineCompletionProvider] 仅 FIM 启用，使用 FIM');
            return this._invokeFIMProvider(document, position, tokens);
        }

        // 情况3：只有 NES 启用
        if (nesConfig.enabled) {
            // NES 手动触发模式，但这是自动触发请求，不处理
            if (nesConfig.manualOnly) {
                CompletionLogger.trace('[InlineCompletionProvider] 仅 NES 启用但为手动触发模式，忽略自动请求');
                return undefined;
            }

            CompletionLogger.trace('[InlineCompletionProvider] 仅 NES 启用，使用 NES');
            return this._invokeNESProvider(document, tokens);
        }

        // 情况4：都未启用
        CompletionLogger.trace('[InlineCompletionProvider] FIM 和 NES 都未启用');
        return undefined;
    }

    private async _invokeFIMProvider(
        document: vscode.TextDocument,
        position: vscode.Position,
        tokens: { completionsCts: vscode.CancellationTokenSource }
    ): Promise<vscode.InlineCompletionList | undefined> {
        const config = ConfigManager.getFIMConfig();
        if (!config.enabled || !this.fimProvider) {
            return undefined;
        }

        CompletionLogger.trace('[InlineCompletionProvider] 调用 FIM');
        const startTime = Date.now();

        try {
            const textDoc = CopilotTextDocument.create(
                document.uri.toString(),
                document.languageId,
                document.version,
                document.getText()
            );

            // 创建超时 Promise
            const timeoutPromise = new Promise<null>((_, reject) => {
                setTimeout(() => {
                    reject(new Error(`FIM 请求超时 (${config.timeoutMs}ms)`));
                }, config.timeoutMs);
            });

            // 获取内联补全建议
            const fimPromise = this.fimProvider.getInlineCompletions(
                textDoc,
                { line: position.line, character: position.character },
                tokens.completionsCts.token
            );

            // 处理请求与超时
            const fimResult = await Promise.race([fimPromise, timeoutPromise]);

            const elapsed = Date.now() - startTime;
            CompletionLogger.trace(`[InlineCompletionProvider] FIM 请求完成，耗时: ${elapsed}ms`);

            if (!fimResult || !fimResult.length) {
                return undefined;
            }

            const items = fimResult.map((completion, index) => {
                const range = new vscode.Range(
                    completion.range.start.line,
                    completion.range.start.character,
                    completion.range.end.line,
                    completion.range.end.character
                );
                CompletionLogger.info(
                    `[InlineCompletionProvider] 返回 FIM 建议 [${index}]: insertText=\r\n${completion.insertText}`
                );
                return new vscode.InlineCompletionItem(completion.insertText, range);
            });

            return new vscode.InlineCompletionList(items);
        } catch (error) {
            const elapsed = Date.now() - startTime;

            if (error instanceof Error && error.message.includes('超时')) {
                CompletionLogger.warn(`[InlineCompletionProvider] ${error.message}`);
                return undefined;
            }

            if (error instanceof Error && error.name === 'AbortError') {
                return undefined;
            }

            CompletionLogger.error(`[InlineCompletionProvider] FIM 请求异常 (${elapsed}ms):`, error);
            return undefined;
        }
    }

    private async _invokeNESProvider(
        document: vscode.TextDocument,
        tokens: { nesCts: vscode.CancellationTokenSource }
    ): Promise<vscode.InlineCompletionList | undefined> {
        const config = ConfigManager.getNESConfig();
        if (!config.enabled || !this.nesProvider || !this.nesWorkspaceAdapter) {
            return undefined;
        }

        CompletionLogger.trace('[InlineCompletionProvider] 调用 NES');
        const startTime = Date.now();

        try {
            // 同步文档到 NES 工作区
            this.nesWorkspaceAdapter.syncDocument(document);

            // 创建超时 Promise
            const timeoutPromise = new Promise<null>((_, reject) => {
                setTimeout(() => {
                    reject(new Error(`NES 请求超时 (${config.timeoutMs}ms)`));
                }, config.timeoutMs);
            });

            // 使用 chat-lib NES 提供者获取下一个编辑建议
            const nesPromise = this.nesProvider.getNextEdit(
                document.uri,
                tokens.nesCts.token as unknown as CancellationToken
            );

            // 处理请求与超时
            const nesResult = await Promise.race([nesPromise, timeoutPromise]);

            const elapsed = Date.now() - startTime;
            CompletionLogger.trace(`[InlineCompletionProvider] NES 请求完成，耗时: ${elapsed}ms`);

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
            this.nesProvider.handleShown(nesResult);

            CompletionLogger.info(
                `[InlineCompletionProvider] 返回 NES 建议: insertText=\r\n${completionItem?.insertText}`
            );

            return new vscode.InlineCompletionList([completionItem]);
        } catch (error) {
            const elapsed = Date.now() - startTime;

            if (error instanceof Error && error.message.includes('超时')) {
                CompletionLogger.warn(`[InlineCompletionProvider] ${error.message}`);
                return undefined;
            }

            if (error instanceof Error && error.name === 'AbortError') {
                return undefined;
            }

            CompletionLogger.error(`[InlineCompletionProvider] NES 请求异常 (${elapsed}ms):`, error);
            return undefined;
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
        CompletionLogger.trace('[InlineCompletionProvider.dispose] 开始释放资源');

        // 清除防抖定时器
        if (this.debounceTimer) {
            clearTimeout(this.debounceTimer);
            this.debounceTimer = null;
        }

        // 清理防抖请求
        if (this.pendingDebounceRequest) {
            this.pendingDebounceRequest.resolve(undefined);
            this.pendingDebounceRequest = null;
        }

        // 释放 FIM 提供者
        if (this._fimProvider) {
            this._fimProvider.dispose();
            this._fimProvider = null;
        }

        // 释放 NES 提供者
        if (this._nesProvider) {
            this._nesProvider.dispose();
            this._nesProvider = null;
        }

        // 清理所有 disposables (包含 onDidChangeEmitter, nesWorkspaceAdapter, provider 和命令)
        this.disposables.forEach(d => {
            try {
                d.dispose();
            } catch (error) {
                CompletionLogger.warn('[InlineCompletionProvider.dispose] 释放资源时出错:', error);
            }
        });
        this.disposables.length = 0;

        CompletionLogger.info('🧹 [InlineCompletionProvider] 已释放所有资源');
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
