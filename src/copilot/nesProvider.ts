/*---------------------------------------------------------------------------------------------
 *  NESProvider - Next Edit Suggest 提供商
 *  基于 @vscode/chat-lib 的 createNESProvider 实现
 *  参考: nesProvider.spec.ts 测试用例
 *
 *  用于对接 NES（Next Edit Suggest）功能
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { createNESProvider, INESProvider, INESResult } from '@vscode/chat-lib';
import { CancellationToken } from '@vscode/chat-lib/dist/src/_internal/util/vs/base/common/cancellation';
import { WorkspaceAdapter } from './workspaceAdapter';
import { FimProviderConfig, NESCompletionConfig } from './types';
import { Logger } from '../utils';
import { Fetcher } from './fetcher';
import { AuthenticationService } from './auth';
import { TelemetrySender } from './telemetry';
import { LogTarget } from './logTarget';

/**
 * NES 提供商 - 用于 Next Edit Suggest 实验
 * 基于 @vscode/chat-lib 的 createNESProvider 实现
 *
 * 实现功能:
 * ✅ 实现 vscode.InlineCompletionItemProvider 接口
 * ✅ 使用 createNESProvider 创建 chat-lib NES 提供商
 * ✅ 通过 VSCodeWorkspaceAdapter 同步文档状态
 * ✅ 将 INESResult 转换为 vscode.InlineCompletionItem
 * ✅ 命令注册系统（enable/disable/toggle）
 * ✅ 配置管理系统
 */
export class NESProvider implements vscode.InlineCompletionItemProvider, vscode.Disposable {
    private readonly disposables: vscode.Disposable[] = [];
    private isEnabled = true;
    private currentProvider: FimProviderConfig;
    private chatLibNESProvider: INESProvider<INESResult> | null = null;
    private workspaceAdapter: WorkspaceAdapter | null = null;
    private isInitialized = false;

    // 请求管理 - 防止卡住编辑器
    private pendingRequestCount = 0;
    private lastRequestTime = 0;
    private currentAbortController: AbortController | null = null;
    private debounceTimer: ReturnType<typeof setTimeout> | null = null;

    private readonly defaultConfig: NESCompletionConfig = {
        enabled: true,
        debounceMs: 150, // 防抖延迟
        timeoutMs: 5000, // 5秒超时
        maxConcurrent: 1 // 最多1个并发请求
    };

    // ========================================================================
    // 生命周期方法
    // ========================================================================

    /**
     * 静态工厂方法 - 创建并激活 NES 提供商
     */
    static createAndActivate(context: vscode.ExtensionContext): {
        provider: NESProvider;
        disposables: vscode.Disposable[];
    } {
        Logger.trace('[NESProvider.createAndActivate] 开始创建并激活 NES 提供商');
        const disposables: vscode.Disposable[] = [];

        try {
            const provider = new NESProvider(context);
            provider.activate();
            disposables.push(provider);
            Logger.trace('[NESProvider.createAndActivate] NES 提供商创建并激活成功');
            return { provider, disposables };
        } catch (error) {
            Logger.error('[NESProvider.createAndActivate] 创建失败:', error);
            throw error;
        }
    }

    constructor(private readonly context: vscode.ExtensionContext) {
        // this.currentProvider = {
        //     id: 'glm-4.5-air',
        //     name: 'GLM-4.5-Air',
        //     providerKey: 'zhipu',
        //     baseUrl: 'https://open.bigmodel.cn/api/coding/paas/v4',
        //     requestPath: 'chat/completions',
        //     requestModel: 'glm-4.5',
        //     supportsSuffix: true,
        //     maxTokens: 4096
        // };
        this.currentProvider = {
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

    /**
     * 激活 NES 提供商
     */
    private activate(): void {
        Logger.trace('[NESProvider.activate] 激活开始');

        try {
            // 监听配置变化
            this.disposables.push(
                vscode.workspace.onDidChangeConfiguration(e => {
                    if (e.affectsConfiguration('gcmp.nesCompletion')) {
                        Logger.trace('[NESProvider] 检测到配置变化，更新状态');
                        this.updateEnabledStatus();
                    }
                })
            );

            // 注册为 VS Code 提供商
            const provider = vscode.languages.registerInlineCompletionItemProvider({ pattern: '**/*' }, this);
            this.disposables.push(provider);
            Logger.trace('[NESProvider.activate] InlineCompletionItemProvider 注册成功');

            // 注册命令
            this.registerCommands();

            // 初始化 chat-lib NES 提供商
            this.initializeChatLibNESProvider()
                .then(() => {
                    Logger.info(`✅ [NESProvider.activate] 提供商已激活，当前使用: ${this.currentProvider}`);
                })
                .catch(error => {
                    Logger.error('[NESProvider.activate] chat-lib NES 初始化失败:', error);
                });

            Logger.trace('[NESProvider.activate] 激活完成');
        } catch (error) {
            Logger.error('[NESProvider.activate] 激活失败:', error);
            throw error;
        }
    }

    /**
     * 初始化 chat-lib NES 提供商
     */
    private async initializeChatLibNESProvider(): Promise<void> {
        Logger.trace('[NESProvider.initializeChatLibNESProvider] 开始初始化');

        try {
            // 创建工作区适配器
            this.workspaceAdapter = new WorkspaceAdapter();
            this.disposables.push(this.workspaceAdapter);

            // 创建 NES 提供商
            this.chatLibNESProvider = createNESProvider({
                workspace: this.workspaceAdapter.getWorkspace(),
                fetcher: new Fetcher(this.currentProvider),
                copilotTokenManager: new AuthenticationService(),
                telemetrySender: new TelemetrySender(),
                logTarget: new LogTarget(),
                waitForTreatmentVariables: false
            });

            this.isInitialized = true;
            Logger.trace('[NESProvider.initializeChatLibNESProvider] 初始化完成');
        } catch (error) {
            Logger.error('[NESProvider.initializeChatLibNESProvider] 初始化失败:', error);
            throw error;
        }
    }

    // ========================================================================
    // 配置管理
    // ========================================================================

    private getConfig(): NESCompletionConfig {
        const config = vscode.workspace.getConfiguration('gcmp.nesCompletion');
        return {
            enabled: config.get('enabled', this.defaultConfig.enabled),
            debounceMs: config.get('debounceMs', this.defaultConfig.debounceMs),
            timeoutMs: config.get('timeoutMs', this.defaultConfig.timeoutMs),
            maxConcurrent: config.get('maxConcurrent', this.defaultConfig.maxConcurrent)
        };
    }

    private updateEnabledStatus(): void {
        const config = this.getConfig();
        this.isEnabled = config.enabled;
        Logger.trace(`[NESProvider] 启用状态已更新: enabled=${this.isEnabled}, provider=${this.currentProvider}`);
    }

    // ========================================================================
    // 命令注册
    // ========================================================================

    private registerCommands(): void {
        const enableCommand = vscode.commands.registerCommand('gcmp.nesCompletion.enable', async () => {
            await vscode.workspace
                .getConfiguration('gcmp.nesCompletion')
                .update('enabled', true, vscode.ConfigurationTarget.Global);
            vscode.window.showInformationMessage('✅ NES 补全已启用');
            Logger.info('[NESProvider] NES 补全已启用');
        });
        this.disposables.push(enableCommand);

        const disableCommand = vscode.commands.registerCommand('gcmp.nesCompletion.disable', async () => {
            await vscode.workspace
                .getConfiguration('gcmp.nesCompletion')
                .update('enabled', false, vscode.ConfigurationTarget.Global);
            vscode.window.showInformationMessage('❌ NES 补全已禁用');
            Logger.info('[NESProvider] NES 补全已禁用');
        });
        this.disposables.push(disableCommand);

        const toggleCommand = vscode.commands.registerCommand('gcmp.nesCompletion.toggle', async () => {
            const config = this.getConfig();
            const newState = !config.enabled;
            await vscode.workspace
                .getConfiguration('gcmp.nesCompletion')
                .update('enabled', newState, vscode.ConfigurationTarget.Global);
            const status = newState ? '已启用' : '已禁用';
            vscode.window.showInformationMessage(`NES 补全 ${status}`);
            Logger.info(`[NESProvider] NES 补全 ${status}`);
        });
        this.disposables.push(toggleCommand);

        Logger.trace('[NESProvider.registerCommands] 已注册 3 个命令');
    }

    // ========================================================================
    // NES 补全功能
    // ========================================================================

    /**
     * 实现 vscode.InlineCompletionItemProvider 接口
     * 优化：超时控制、请求节流、取消机制，防止卡住编辑器
     */
    async provideInlineCompletionItems(
        document: vscode.TextDocument,
        position: vscode.Position,
        context: vscode.InlineCompletionContext,
        token: vscode.CancellationToken
    ): Promise<vscode.InlineCompletionItem[] | vscode.InlineCompletionList | undefined> {
        const config = this.getConfig();

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
        }

        // 检查是否启用
        if (!this.isEnabled) {
            return undefined;
        }

        // 检查是否已初始化
        if (!this.isInitialized || !this.chatLibNESProvider || !this.workspaceAdapter) {
            return undefined;
        }

        // 并发控制：如果已有太多请求在进行中，直接跳过
        if (this.pendingRequestCount >= config.maxConcurrent) {
            Logger.trace('[NESProvider] 并发请求过多，跳过本次请求');
            return undefined;
        }

        // 取消之前的请求（如果有）
        this.cancelPendingRequest();

        // 防抖：等待用户停止输入
        return new Promise(resolve => {
            // 清除之前的防抖定时器
            if (this.debounceTimer) {
                clearTimeout(this.debounceTimer);
            }

            this.debounceTimer = setTimeout(async () => {
                // 检查 token 是否已取消
                if (token.isCancellationRequested) {
                    resolve(undefined);
                    return;
                }

                const result = await this.executeNESRequest(document, position, token, config);
                resolve(result);
            }, config.debounceMs);

            // 监听取消事件
            token.onCancellationRequested(() => {
                if (this.debounceTimer) {
                    clearTimeout(this.debounceTimer);
                    this.debounceTimer = null;
                }
                this.cancelPendingRequest();
                resolve(undefined);
            });
        });
    }

    /**
     * 取消当前挂起的请求
     */
    private cancelPendingRequest(): void {
        if (this.currentAbortController) {
            this.currentAbortController.abort();
            this.currentAbortController = null;
        }
    }

    /**
     * 执行 NES 请求（带超时控制）
     */
    private async executeNESRequest(
        document: vscode.TextDocument,
        position: vscode.Position,
        token: vscode.CancellationToken,
        config: NESCompletionConfig
    ): Promise<vscode.InlineCompletionItem[] | undefined> {
        this.pendingRequestCount++;
        this.currentAbortController = new AbortController();
        const startTime = Date.now();

        try {
            // 确保文档已同步到工作区
            this.workspaceAdapter!.syncDocument(document);

            // 创建超时 Promise
            const timeoutPromise = new Promise<null>((_, reject) => {
                setTimeout(() => {
                    reject(new Error(`NES 请求超时 (${config.timeoutMs}ms)`));
                }, config.timeoutMs);
            });

            // 使用 chat-lib NES 提供商获取下一个编辑建议
            const nesPromise = this.chatLibNESProvider!.getNextEdit(
                document.uri,
                token as unknown as CancellationToken
            );

            // 竞争：请求 vs 超时
            const nesResult = await Promise.race([nesPromise, timeoutPromise]);

            const elapsed = Date.now() - startTime;
            Logger.trace(`[NESProvider] NES 请求完成，耗时: ${elapsed}ms`);

            // 如果没有结果，返回 undefined
            if (!nesResult || !nesResult.result) {
                return undefined;
            }

            // 将 NES 结果转换为 VS Code InlineCompletionItem
            const { newText, range } = nesResult.result;

            Logger.trace(`[NESProvider] 原始 newText: ${JSON.stringify(newText)}`);

            if (!newText) {
                Logger.trace('[NESProvider] 内容为空，跳过');
                return undefined;
            }

            // 将字符偏移转换为 VS Code Position
            const startPos = document.positionAt(range.start);
            const endPos = document.positionAt(range.endExclusive);
            const vscodeRange = new vscode.Range(startPos, endPos);

            const completionItem = new vscode.InlineCompletionItem(newText, vscodeRange);

            // 记录建议已显示
            this.chatLibNESProvider!.handleShown(nesResult);

            Logger.trace(
                `[NESProvider] 返回 NES 建议: range=${range.start}-${range.endExclusive}, ` +
                    `newText.length=${newText.length}, elapsed=${elapsed}ms`
            );

            return [completionItem];
        } catch (error) {
            const elapsed = Date.now() - startTime;

            // 超时错误特殊处理
            if (error instanceof Error && error.message.includes('超时')) {
                Logger.warn(`[NESProvider] ${error.message}`);
                return undefined;
            }

            // 取消错误不记录
            if (error instanceof Error && error.name === 'AbortError') {
                return undefined;
            }

            Logger.error(`[NESProvider] 获取 NES 补全异常 (${elapsed}ms):`, error);
            return undefined;
        } finally {
            this.pendingRequestCount--;
            this.currentAbortController = null;
        }
    }

    // ========================================================================
    // 清理方法
    // ========================================================================

    dispose(): void {
        Logger.trace('[NESProvider.dispose] 开始释放资源');

        // 取消挂起的请求
        this.cancelPendingRequest();

        // 清除防抖定时器
        if (this.debounceTimer) {
            clearTimeout(this.debounceTimer);
            this.debounceTimer = null;
        }

        // 释放 chat-lib NES 提供商
        if (this.chatLibNESProvider) {
            this.chatLibNESProvider.dispose();
            this.chatLibNESProvider = null;
        }

        // 清理所有 disposables
        for (const disposable of this.disposables) {
            disposable.dispose();
        }
        this.disposables.length = 0;

        Logger.info('🧹 [NESProvider] 已释放所有资源');
    }
}
