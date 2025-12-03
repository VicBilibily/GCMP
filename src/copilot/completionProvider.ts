/*---------------------------------------------------------------------------------------------
 *  InlineCompletionProvider - 多提供商内联代码补全
 *  基于 @vscode/chat-lib 的 createInlineCompletionsProvider 实现
 *  参考: https://github.com/microsoft/vscode-copilot-chat/blob/main/chat-lib/test/getInlineCompletions.spec.ts
 *
 *  使用官方 createInlineCompletionsProvider 创建实例代理处理
 *  官方已处理防抖、缓存、请求管理等逻辑
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import {
    createInlineCompletionsProvider,
    IActionItem,
    ICompletionsStatusChangedEvent,
    ICompletionsStatusHandler,
    IInlineCompletionsProvider,
    INotificationSender,
    IURLOpener
} from '@vscode/chat-lib';
import { MutableObservableWorkspace } from '@vscode/chat-lib/dist/src/_internal/platform/inlineEdits/common/observableWorkspace';
import {
    CopilotTextDocument,
    ITextDocument
} from '@vscode/chat-lib/dist/src/_internal/extension/completions-core/vscode-node/lib/src/textDocument';

import { Logger } from '../utils/logger';
import { VersionManager } from '../utils';
import { DocumentManager } from './documentManager';
import { FimCompletionConfig, FimProviderConfig } from './types';
import { CAPIClientService } from './capiClient';
import { TelemetrySender } from './telemetry';
import { LogTarget } from './logTarget';
import { AuthenticationService } from './auth';
import { Fetcher } from './fetcher';
import { EndpointProvider } from './endpoint';
import { CopilotCompletion } from '@vscode/chat-lib/dist/src/_internal/extension/completions-core/vscode-node/lib/src/ghostText/copilotCompletion';

/**
 * 内联补全提供商
 * 完全基于 @vscode/chat-lib 的 createInlineCompletionsProvider 实现
 * 官方已处理防抖、缓存、请求管理等逻辑
 */
export class InlineCompletionProvider implements vscode.InlineCompletionItemProvider, vscode.Disposable {
    private readonly disposables: vscode.Disposable[] = [];
    private isEnabled = true;
    private currentProvider: FimProviderConfig;
    private chatLibProvider: IInlineCompletionsProvider | null = null;

    /** 默认配置 */
    private readonly defaultConfig: FimCompletionConfig = {
        enabled: true,
        provider: 'deepseek',
        maxTokens: 128,
        temperature: 0,
        contextLines: 50,
        triggerDelay: 300
    };

    constructor(private readonly context: vscode.ExtensionContext) {
        this.currentProvider = {
            id: 'deepseek',
            name: 'DeepSeek',
            providerKey: 'deepseek',
            baseUrl: 'https://api.deepseek.com/beta',
            requestPath: 'completions',
            requestModel: 'deepseek-chat',
            supportsSuffix: true,
            maxTokens: 4096
        };
    }

    /**
     * 激活内联补全提供商
     * 使用 @vscode/chat-lib 的 createInlineCompletionsProvider
     */
    activate(): void {
        Logger.trace('[InlineCompletionProvider.activate] 激活开始');

        try {
            Logger.trace('[InlineCompletionProvider.activate] 初始化 chat-lib provider');
            // 创建 @vscode/chat-lib 的 InlineCompletionsProvider
            this.initializeChatLibProvider()
                .then(() => {
                    Logger.trace('[InlineCompletionProvider.activate] chat-lib provider 初始化成功');
                })
                .catch((error: unknown) => {
                    Logger.error('[InlineCompletionProvider.activate] chat-lib provider 初始化失败:', error);
                });

            Logger.trace('[InlineCompletionProvider.activate] 注册 InlineCompletionItemProvider');
            // 使用官方的 registerInlineCompletionItemProvider
            const provider = vscode.languages.registerInlineCompletionItemProvider({ pattern: '**/*' }, this);
            this.disposables.push(provider);
            Logger.trace('[InlineCompletionProvider.activate] InlineCompletionItemProvider 注册成功');

            Logger.trace('[InlineCompletionProvider.activate] 注册命令');
            // 注册命令
            this.registerCommands();
            Logger.trace('[InlineCompletionProvider.activate] 命令注册成功');

            Logger.trace('[InlineCompletionProvider.activate] 监听配置变化');
            // 监听配置变化
            this.disposables.push(
                vscode.workspace.onDidChangeConfiguration(e => {
                    if (e.affectsConfiguration('gcmp.inlineCompletion')) {
                        Logger.trace('[InlineCompletionProvider.activate] 配置已变化，更新提供商');
                        this.updateCurrentProvider();
                    }
                })
            );
            Logger.trace('[InlineCompletionProvider.activate] 配置监听已注册');

            // 初始化提供商
            Logger.trace('[InlineCompletionProvider.activate] 更新当前提供商');
            this.updateCurrentProvider();

            Logger.info(
                `✅ [InlineCompletionProvider.activate] Provider 已激活，当前使用: ${this.currentProvider.name}`
            );
            Logger.trace('[InlineCompletionProvider.activate] 激活完成');
        } catch (error) {
            Logger.error('[InlineCompletionProvider.activate] 激活失败:', error);
            throw error;
        }
    }

    /**
     * 初始化 @vscode/chat-lib 的 InlineCompletionsProvider
     * 参考: getInlineCompletions.spec.ts 中的测试用例
     */
    private async initializeChatLibProvider(): Promise<void> {
        this.chatLibProvider = createInlineCompletionsProvider({
            fetcher: new Fetcher(this.currentProvider),
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
            editorInfo: {
                name: 'vscode',
                version: vscode.version
            },
            editorPluginInfo: {
                name: 'gcmp',
                version: VersionManager.getVersion()
            },
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
     * 注册相关命令
     */
    private registerCommands(): void {
        // 启用内联补全命令
        const enableCommand = vscode.commands.registerCommand('gcmp.inlineCompletion.enable', async () => {
            await vscode.workspace
                .getConfiguration('gcmp.inlineCompletion')
                .update('enabled', true, vscode.ConfigurationTarget.Global);
            vscode.window.showInformationMessage('✅ 内联代码补全已启用');
            Logger.info('[InlineCompletionProvider] 内联补全已启用');
        });
        this.disposables.push(enableCommand);

        // 禁用内联补全命令
        const disableCommand = vscode.commands.registerCommand('gcmp.inlineCompletion.disable', async () => {
            await vscode.workspace
                .getConfiguration('gcmp.inlineCompletion')
                .update('enabled', false, vscode.ConfigurationTarget.Global);
            vscode.window.showInformationMessage('❌ 内联代码补全已禁用');
            Logger.info('[InlineCompletionProvider] 内联补全已禁用');
        });
        this.disposables.push(disableCommand);

        // 切换启用/禁用命令
        const toggleCommand = vscode.commands.registerCommand('gcmp.inlineCompletion.toggle', async () => {
            const config = this.getConfig();
            const newState = !config.enabled;
            await vscode.workspace
                .getConfiguration('gcmp.inlineCompletion')
                .update('enabled', newState, vscode.ConfigurationTarget.Global);
            const status = newState ? '已启用' : '已禁用';
            vscode.window.showInformationMessage(`内联代码补全 ${status}`);
            Logger.info(`[InlineCompletionProvider] 内联补全 ${status}`);
        });
        this.disposables.push(toggleCommand);
    }

    /**
     * 更新当前提供商
     */
    private updateCurrentProvider(): void {
        Logger.trace('[InlineCompletionProvider.updateCurrentProvider] 开始更新提供商');
        const config = this.getConfig();
        const providerId = config.provider;
        Logger.trace(`[InlineCompletionProvider.updateCurrentProvider] 配置提供商 ID: ${providerId}`);

        // if (FIM_PROVIDERS[providerId]) {
        //     this.currentProvider = FIM_PROVIDERS[providerId];
        //     Logger.info(`[InlineCompletionProvider.updateCurrentProvider] 切换到提供商: ${this.currentProvider.name}`);
        //     Logger.trace(
        //         `[InlineCompletionProvider.updateCurrentProvider] 提供商配置: baseUrl=${this.currentProvider.baseUrl}`
        //     );

        //     // 重新初始化 chat-lib provider
        //     Logger.trace(`[InlineCompletionProvider.updateCurrentProvider] 重新初始化 chat-lib provider`);
        //     if (this.chatLibProvider) {
        //         Logger.trace(`[InlineCompletionProvider.updateCurrentProvider] 释放旧的 chat-lib provider`);
        //         this.chatLibProvider.dispose();
        //     }
        //     this.initializeChatLibProvider().catch((error: unknown) => {
        //         Logger.error(
        //             '[InlineCompletionProvider.updateCurrentProvider] 重新初始化 chat-lib provider 失败:',
        //             error
        //         );
        //     });
        // } else {
        //     Logger.warn(`[InlineCompletionProvider.updateCurrentProvider] 未知的提供商: ${providerId}，使用默认值`);
        //     this.currentProvider = FIM_PROVIDERS[this.defaultConfig.provider];
        //     Logger.trace(
        //         `[InlineCompletionProvider.updateCurrentProvider] 使用默认提供商: ${this.currentProvider.name}`
        //     );
        // }
    }

    /**
     * 获取 FIM 配置
     */
    private getConfig(): FimCompletionConfig {
        const config = vscode.workspace.getConfiguration('gcmp.inlineCompletion');

        return {
            enabled: config.get('enabled', this.defaultConfig.enabled),
            provider: config.get('provider', this.defaultConfig.provider),
            model: config.get('model'),
            maxTokens: config.get('maxTokens', this.defaultConfig.maxTokens),
            temperature: config.get('temperature', this.defaultConfig.temperature),
            contextLines: config.get('contextLines', this.defaultConfig.contextLines),
            triggerDelay: config.get('triggerDelay', this.defaultConfig.triggerDelay)
        };
    }

    /**
     * 创建 ITextDocument 从 vscode.TextDocument
     */
    private createTextDocument(document: vscode.TextDocument): ITextDocument {
        return CopilotTextDocument.create(
            document.uri.toString(),
            document.languageId,
            document.version,
            document.getText()
        );
    }

    /**
     * 官方接口方法 - provideInlineCompletionItems
     * 代理到 @vscode/chat-lib 的 getInlineCompletions
     */
    async provideInlineCompletionItems(
        document: vscode.TextDocument,
        position: vscode.Position,
        context: vscode.InlineCompletionContext,
        token: vscode.CancellationToken
    ): Promise<vscode.InlineCompletionItem[] | vscode.InlineCompletionList | undefined> {
        Logger.trace(
            '[InlineCompletionProvider] provideInlineCompletionItems 被调用: ' +
                `file=${document.fileName}, line=${position.line}, char=${position.character}, ` +
                `triggerKind=${context.triggerKind}`
        );

        // 检查是否启用
        if (!this.isEnabled) {
            Logger.trace('[InlineCompletionProvider] 已禁用，跳过补全');
            return undefined;
        }

        const config = this.getConfig();
        Logger.trace(`[InlineCompletionProvider] 配置: enabled=${config.enabled}, provider=${config.provider}`);

        if (!config.enabled) {
            Logger.trace('[InlineCompletionProvider] 配置中禁用，跳过补全');
            return undefined;
        }

        if (!this.chatLibProvider) {
            Logger.warn('[InlineCompletionProvider] chat-lib provider 未初始化');
            return undefined;
        }

        try {
            // 创建 ITextDocument
            Logger.trace('[InlineCompletionProvider.provideInlineCompletionItems] 创建 ITextDocument');
            const textDoc = this.createTextDocument(document);
            Logger.trace('[InlineCompletionProvider.provideInlineCompletionItems] ITextDocument 创建成功');

            // 创建 CancellationToken 适配器
            Logger.trace('[InlineCompletionProvider.provideInlineCompletionItems] 创建 CancellationToken 适配器');
            const cancellationToken = {
                isCancellationRequested: token.isCancellationRequested,
                onCancellationRequested: token.onCancellationRequested
            };

            // 调用 chat-lib 的 getInlineCompletions
            Logger.trace('[InlineCompletionProvider.provideInlineCompletionItems] 调用 chat-lib getInlineCompletions');
            const completions = await this.chatLibProvider.getInlineCompletions(
                textDoc,
                { line: position.line, character: position.character },
                cancellationToken
            );
            Logger.trace(
                `[InlineCompletionProvider.provideInlineCompletionItems] 获得补全数: ${completions ? completions.length : 0}`
            );

            if (!completions || completions.length === 0) {
                Logger.trace('[InlineCompletionProvider] 无补全结果');
                return undefined;
            }

            // 转换 CopilotCompletion 为 vscode.InlineCompletionItem
            Logger.trace('[InlineCompletionProvider.provideInlineCompletionItems] 转换补全结果');
            const items = completions.map((completion: CopilotCompletion) => {
                Logger.trace(
                    `[InlineCompletionProvider.provideInlineCompletionItems] 补全项: "${completion.insertText.substring(0, 50)}..."`
                );
                const range = new vscode.Range(
                    completion.range.start.line,
                    completion.range.start.character,
                    completion.range.end.line,
                    completion.range.end.character
                );
                return new vscode.InlineCompletionItem(completion.insertText, range);
            });

            Logger.trace(`[InlineCompletionProvider.provideInlineCompletionItems] 返回补全结果: ${items.length} 项`);
            return items;
        } catch (error) {
            if (error instanceof Error && error.name === 'AbortError') {
                Logger.trace('[InlineCompletionProvider.provideInlineCompletionItems] 请求被取消');
            } else {
                Logger.error('[InlineCompletionProvider.provideInlineCompletionItems] 补全请求异常:', error);
                if (error instanceof Error) {
                    Logger.error('[InlineCompletionProvider.provideInlineCompletionItems] 错误详情:', {
                        message: error.message,
                        stack: error.stack,
                        name: error.name
                    });
                }
            }
            return undefined;
        }
    }

    /**
     * 静态工厂方法 - 创建并激活提供商
     */
    static createAndActivate(context: vscode.ExtensionContext): {
        provider: InlineCompletionProvider;
        disposables: vscode.Disposable[];
    } {
        Logger.trace('[InlineCompletionProvider.createAndActivate] Creating provider instance');
        const provider = new InlineCompletionProvider(context);
        provider.activate();
        Logger.trace('[InlineCompletionProvider.createAndActivate] Provider activated successfully');
        return { provider, disposables: provider.disposables };
    }

    /**
     * 释放资源
     */
    dispose(): void {
        Logger.trace('[InlineCompletionProvider.dispose] Disposing resources');

        // 释放 chat-lib provider
        if (this.chatLibProvider) {
            this.chatLibProvider.dispose();
            this.chatLibProvider = null;
        }

        // 清理所有 disposables
        this.disposables.forEach(d => d.dispose());

        Logger.info('🧹 [InlineCompletionProvider] Provider 已释放');
    }
}
