/*---------------------------------------------------------------------------------------------
 *  JointInlineCompletionProvider - 联合内联代码补全提供商
 *
 *  参照 https://github.com/microsoft/vscode-copilot-chat/blob/main/src/extension/inlineEdits/vscode-node/jointInlineCompletionProvider.t
 *
 *  实现 "竞争模式" (Competition Mode):
 *  同时运行 FIM 和 NES 补全
 *
 *  策略 (基于官方实现):
 *  1. 缓存优先: 如果存在上一次的 NES 建议，优先给 NES 极短时间(10ms)进行快速验证。
 *  2. 快速命中: 如果 NES 快速返回且与缓存一致，直接采用，跳过 FIM。
 *  3. 并发竞争: 否则，同时发起 FIM 和 NES 请求。
 *  4. FIM 优先: 在并发场景下，优先采用 FIM 的结果（除非 NES 先回且与缓存一致），以保证响应速度。
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
import { MutableObservableWorkspace } from '@vscode/chat-lib/dist/src/_internal/platform/inlineEdits/common/observableWorkspace';
import { CopilotTextDocument } from '@vscode/chat-lib/dist/src/_internal/extension/completions-core/vscode-node/lib/src/textDocument';
import { CopilotCompletion } from '@vscode/chat-lib/dist/src/_internal/extension/completions-core/vscode-node/lib/src/ghostText/copilotCompletion';
import { CancellationToken } from '@vscode/chat-lib/dist/src/_internal/util/vs/base/common/cancellation';

import { Logger, VersionManager } from '../utils';
import { FimCompletionConfig, FimProviderConfig, NESCompletionConfig } from './types';
import { WorkspaceAdapter } from './workspaceAdapter';
import { DocumentManager } from './documentManager';
import { Fetcher } from './fetcher';
import { AuthenticationService } from './auth';
import { TelemetrySender } from './telemetry';
import { LogTarget } from './logTarget';
import { EndpointProvider } from './endpoint';
import { CAPIClientService } from './capiClient';

interface LastNesSuggestion {
    docUri: vscode.Uri;
    docVersionId: number;
    docWithNesEditApplied: string;
}

interface SingularCompletionList extends vscode.InlineCompletionList {
    source: 'FIM' | 'NES';
}

/**
 * 联合内联补全提供商
 * 整合 FIM 和 NES 的核心实现，实现竞争模式
 */
export class JointInlineCompletionProvider implements vscode.InlineCompletionItemProvider, vscode.Disposable {
    private readonly disposables: vscode.Disposable[] = [];

    // ========================================================================
    // 事件支持
    // ========================================================================
    private readonly onDidChangeEmitter = new vscode.EventEmitter<void>();
    readonly onDidChange = this.onDidChangeEmitter.event;

    // ========================================================================
    // FIM 相关属性
    // ========================================================================
    private fimEnabled = true;
    private fimProvider: IInlineCompletionsProvider | null = null;
    private readonly fimDefaultConfig: FimCompletionConfig = {
        enabled: true,
        provider: 'deepseek',
        maxTokens: 128,
        temperature: 0,
        contextLines: 50,
        triggerDelay: 300
    };

    // ========================================================================
    // NES 相关属性
    // ========================================================================
    private nesEnabled = true;
    private nesProvider: INESProvider<INESResult> | null = null;
    private nesWorkspaceAdapter: WorkspaceAdapter | null = null;
    private nesInitialized = false;
    private nesPendingRequestCount = 0;
    private nesCurrentAbortController: AbortController | null = null;
    private nesDebounceTimer: ReturnType<typeof setTimeout> | null = null;
    private readonly nesDefaultConfig: NESCompletionConfig = {
        enabled: true,
        debounceMs: 150,
        timeoutMs: 5000,
        maxConcurrent: 1
    };

    // ========================================================================
    // 联合提供商属性
    // ========================================================================
    private fimProviderConfig: FimProviderConfig;
    private nesProviderConfig: FimProviderConfig;
    private lastNesSuggestion: LastNesSuggestion | null = null;
    private provideInlineCompletionItemsInvocationCount = 0;

    constructor(private readonly context: vscode.ExtensionContext) {
        // 注册 emitter 的清理
        this.disposables.push(this.onDidChangeEmitter);

        // FIM 提供商配置
        this.fimProviderConfig = {
            id: 'deepseek',
            name: 'DeepSeek',
            providerKey: 'deepseek',
            baseUrl: 'https://api.deepseek.com/beta',
            requestPath: 'completions',
            requestModel: 'deepseek-chat',
            supportsSuffix: true,
            maxTokens: 4096
        };

        // NES 提供商配置（与 FIM 不同的 API 端点）
        this.nesProviderConfig = {
            id: 'deepseek',
            name: 'DeepSeek',
            providerKey: 'deepseek',
            baseUrl: 'https://api.deepseek.com/v1',
            requestPath: 'chat/completions',
            requestModel: 'deepseek-chat',
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
            // 初始化 FIM 提供商
            this.initializeFimProvider()
                .then(() => Logger.trace('[JointInlineCompletionProvider] FIM 提供商初始化成功'))
                .catch((error: unknown) => Logger.error('[JointInlineCompletionProvider] FIM 初始化失败:', error));

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
                    if (e.affectsConfiguration('gcmp.inlineCompletion')) {
                        this.updateFimConfig();
                    }
                    if (e.affectsConfiguration('gcmp.nesCompletion')) {
                        this.updateNesConfig();
                    }
                })
            );

            Logger.info('✅ [JointInlineCompletionProvider] 联合提供商已激活 (官方策略模式)');
        } catch (error) {
            Logger.error('[JointInlineCompletionProvider.activate] 激活失败:', error);
            throw error;
        }
    }

    /**
     * 初始化 FIM 提供商 (基于 @vscode/chat-lib)
     */
    private async initializeFimProvider(): Promise<void> {
        this.fimProvider = createInlineCompletionsProvider({
            fetcher: new Fetcher(this.fimProviderConfig),
            authService: new AuthenticationService(),
            telemetrySender: new TelemetrySender(),
            logTarget: new LogTarget(),
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
            endpointProvider: new EndpointProvider(),
            capiClientService: new CAPIClientService()
        });
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

    private getFimConfig(): FimCompletionConfig {
        const config = vscode.workspace.getConfiguration('gcmp.inlineCompletion');
        return {
            enabled: config.get('enabled', this.fimDefaultConfig.enabled),
            provider: config.get('provider', this.fimDefaultConfig.provider),
            model: config.get('model'),
            maxTokens: config.get('maxTokens', this.fimDefaultConfig.maxTokens),
            temperature: config.get('temperature', this.fimDefaultConfig.temperature),
            contextLines: config.get('contextLines', this.fimDefaultConfig.contextLines),
            triggerDelay: config.get('triggerDelay', this.fimDefaultConfig.triggerDelay)
        };
    }

    private getNesConfig(): NESCompletionConfig {
        const config = vscode.workspace.getConfiguration('gcmp.nesCompletion');
        return {
            enabled: config.get('enabled', this.nesDefaultConfig.enabled),
            debounceMs: config.get('debounceMs', this.nesDefaultConfig.debounceMs),
            timeoutMs: config.get('timeoutMs', this.nesDefaultConfig.timeoutMs),
            maxConcurrent: config.get('maxConcurrent', this.nesDefaultConfig.maxConcurrent)
        };
    }

    private updateFimConfig(): void {
        const config = this.getFimConfig();
        this.fimEnabled = config.enabled;
        Logger.trace(`[JointInlineCompletionProvider] FIM 配置已更新: enabled=${this.fimEnabled}`);
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
        // FIM 命令
        this.disposables.push(
            vscode.commands.registerCommand('gcmp.inlineCompletion.enable', async () => {
                await vscode.workspace
                    .getConfiguration('gcmp.inlineCompletion')
                    .update('enabled', true, vscode.ConfigurationTarget.Global);
                vscode.window.showInformationMessage('✅ 内联代码补全已启用');
                Logger.info('[JointInlineCompletionProvider] FIM 补全已启用');
            })
        );

        this.disposables.push(
            vscode.commands.registerCommand('gcmp.inlineCompletion.disable', async () => {
                await vscode.workspace
                    .getConfiguration('gcmp.inlineCompletion')
                    .update('enabled', false, vscode.ConfigurationTarget.Global);
                vscode.window.showInformationMessage('❌ 内联代码补全已禁用');
                Logger.info('[JointInlineCompletionProvider] FIM 补全已禁用');
            })
        );

        this.disposables.push(
            vscode.commands.registerCommand('gcmp.inlineCompletion.toggle', async () => {
                const config = this.getFimConfig();
                const newState = !config.enabled;
                await vscode.workspace
                    .getConfiguration('gcmp.inlineCompletion')
                    .update('enabled', newState, vscode.ConfigurationTarget.Global);
                vscode.window.showInformationMessage(`内联代码补全 ${newState ? '已启用' : '已禁用'}`);
                Logger.info(`[JointInlineCompletionProvider] FIM 补全 ${newState ? '已启用' : '已禁用'}`);
            })
        );

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

        Logger.trace('[JointInlineCompletionProvider.registerCommands] 已注册 6 个命令');
    }

    // ========================================================================
    // 主入口：竞争模式补全
    // ========================================================================

    async provideInlineCompletionItems(
        document: vscode.TextDocument,
        position: vscode.Position,
        context: vscode.InlineCompletionContext,
        token: vscode.CancellationToken
    ): Promise<vscode.InlineCompletionItem[] | vscode.InlineCompletionList | undefined> {
        const { triggerKind } = context as { triggerKind: vscode.InlineCompletionTriggerKind };
        if (triggerKind == vscode.InlineCompletionTriggerKind.Invoke) {
            /** 手动触发 */
            Logger.warn('用户手动触发补全');

            // 将键绑定放在此文件中以覆盖默认值
            // [
            //     {
            //         key: 'alt+oem_2',
            //         command: 'editor.action.inlineSuggest.trigger',
            //         when: 'editorHasCompletionItemProvider && textInputFocus && !editorReadonly && !suggestWidgetVisible'
            //     }
            // ];
        } else {
            // 自动触发跳过
            Logger.warn('自动触发跳过补全');
            return;
        }

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

            Logger.trace(`[JointInlineCompletionProvider] 请求 #${invocationId} 结束`, list);

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
            saveLastNesSuggestion = {
                docUri: document.uri,
                docVersionId,
                docWithNesEditApplied:
                    document.getText().substring(0, document.offsetAt(firstItem.range.start)) +
                    firstItem.insertText +
                    document.getText().substring(document.offsetAt(firstItem.range.end))
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

            if (fastNesResult && fastNesResult.items[0]) {
                const nesEdit = fastNesResult.items[0];
                if (nesEdit.range && typeof nesEdit.insertText === 'string') {
                    const applied =
                        document.getText().substring(0, document.offsetAt(nesEdit.range.start)) +
                        nesEdit.insertText +
                        document.getText().substring(document.offsetAt(nesEdit.range.end));
                    if (applied === lastNesSuggestion.docWithNesEditApplied) {
                        Logger.info('[JointInlineCompletionProvider] NES 缓存命中且一致，直接使用 NES');
                        const singularList = fastNesResult as SingularCompletionList;
                        singularList.source = 'NES';
                        return singularList;
                    }
                }
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
        if (suggestionsList.type === 'NES' && suggestionsList.res && suggestionsList.res.items[0]) {
            const nesEdit = suggestionsList.res.items[0];
            if (nesEdit.range && typeof nesEdit.insertText === 'string') {
                const applied =
                    document.getText().substring(0, document.offsetAt(nesEdit.range.start)) +
                    nesEdit.insertText +
                    document.getText().substring(document.offsetAt(nesEdit.range.end));
                if (applied === lastNesSuggestion.docWithNesEditApplied) {
                    Logger.info('[JointInlineCompletionProvider] NES 先回且一致，使用 NES');
                    tokens.completionsCts.cancel();
                    const singularList = suggestionsList.res as SingularCompletionList;
                    singularList.source = 'NES';
                    return singularList;
                }
            }
        }

        Logger.trace('[JointInlineCompletionProvider] 回退到默认策略 (FIM 优先)');
        return this._returnCompletionsOrOtherwiseNES(completionsP, nesP, tokens);
    }

    /**
     * 创建 ITextDocument 从 vscode.TextDocument
     */
    private _invokeCompletionsProvider(
        document: vscode.TextDocument,
        position: vscode.Position,
        _context: vscode.InlineCompletionContext,
        tokens: { completionsCts: vscode.CancellationTokenSource }
    ): Promise<vscode.InlineCompletionList | undefined> | undefined {
        Logger.trace('[JointInlineCompletionProvider] 调用 FIM');

        // 检查 FIM 配置和启用状态
        const fimConfig = this.getFimConfig();
        if (!fimConfig.enabled || !this.fimEnabled || !this.fimProvider) {
            Logger.trace('[JointInlineCompletionProvider] FIM 已禁用或未初始化，跳过');
            return Promise.resolve(undefined);
        }

        const textDoc = CopilotTextDocument.create(
            document.uri.toString(),
            document.languageId,
            document.version,
            document.getText()
        );
        const cancellationToken = {
            isCancellationRequested: tokens.completionsCts.token.isCancellationRequested,
            onCancellationRequested: tokens.completionsCts.token.onCancellationRequested
        };

        return this.fimProvider
            .getInlineCompletions(textDoc, { line: position.line, character: position.character }, cancellationToken)
            .then((completions: CopilotCompletion[] | undefined) => {
                if (!completions || completions.length === 0) {
                    return undefined;
                }
                const items = completions.map((completion: CopilotCompletion) => {
                    const range = new vscode.Range(
                        completion.range.start.line,
                        completion.range.start.character,
                        completion.range.end.line,
                        completion.range.end.character
                    );
                    return new vscode.InlineCompletionItem(completion.insertText, range);
                });
                return new vscode.InlineCompletionList(items);
            })
            .catch((e: unknown) => {
                if (e instanceof Error && e.name === 'AbortError') {
                    return undefined;
                }
                Logger.error('[JointInlineCompletionProvider] FIM 错误:', e);
                return undefined;
            });
    }

    // ========================================================================
    // NES 核心实现
    // ========================================================================

    /**
     * 取消当前挂起的 NES 请求
     */
    private cancelPendingNesRequest(): void {
        if (this.nesCurrentAbortController) {
            this.nesCurrentAbortController.abort();
            this.nesCurrentAbortController = null;
        }
    }

    /**
     * 调用 NES 提供商获取补全
     */
    private _invokeNESProvider(
        document: vscode.TextDocument,
        position: vscode.Position,
        _context: vscode.InlineCompletionContext,
        tokens: { nesCts: vscode.CancellationTokenSource }
    ): Promise<vscode.InlineCompletionList | undefined> | undefined {
        Logger.trace('[JointInlineCompletionProvider] 调用 NES');

        if (!this.nesEnabled || !this.nesInitialized || !this.nesProvider || !this.nesWorkspaceAdapter) {
            return Promise.resolve(undefined);
        }

        const nesConfig = this.getNesConfig();

        // 并发控制
        if (this.nesPendingRequestCount >= nesConfig.maxConcurrent) {
            Logger.trace('[JointInlineCompletionProvider] NES 并发请求过多，跳过');
            return Promise.resolve(undefined);
        }

        // 取消之前的请求
        this.cancelPendingNesRequest();

        return this.executeNesRequest(document, position, tokens.nesCts.token, nesConfig);
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
        this.nesCurrentAbortController = new AbortController();
        const startTime = Date.now();

        try {
            // 确保文档已同步到工作区
            this.nesWorkspaceAdapter!.syncDocument(document);

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
    ): Promise<SingularCompletionList | undefined> {
        const completionsR = completionsP ? await completionsP : undefined;
        if (completionsR && completionsR.items.length > 0) {
            Logger.info('[JointInlineCompletionProvider] 使用 FIM 结果');
            tokens.nesCts.cancel();
            const singularList = completionsR as SingularCompletionList;
            singularList.source = 'FIM';
            return singularList;
        }

        const nesR = nesP ? await nesP : undefined;
        if (nesR && nesR.items.length > 0) {
            Logger.info('[JointInlineCompletionProvider] FIM 无结果，使用 NES 结果');
            tokens.completionsCts.cancel();
            const singularList = nesR as SingularCompletionList;
            singularList.source = 'NES';
            return singularList;
        }

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
        this.cancelPendingNesRequest();

        // 清除 NES 防抖定时器
        if (this.nesDebounceTimer) {
            clearTimeout(this.nesDebounceTimer);
            this.nesDebounceTimer = null;
        }

        // 释放 FIM 提供商
        if (this.fimProvider) {
            this.fimProvider.dispose();
            this.fimProvider = null;
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
