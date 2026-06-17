/*---------------------------------------------------------------------------------------------
 *  Claude Code CLI Provider
 *  继承 GenericModelProvider，重写聊天响应方法以使用 claude 子进程
 *  （而非 HTTP API 调用）
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import {
    LanguageModelChatInformation,
    LanguageModelChatMessage,
    PrepareLanguageModelChatModelOptions,
    ProvideLanguageModelChatResponseOptions,
    Progress,
    CancellationToken
} from 'vscode';
import { ProviderConfig } from '../types/sharedTypes';
import { GenericModelProvider } from './genericModelProvider';
import { ClaudeCliHandler } from '../handlers/claudeCliHandler';
import { apiMessageToAnthropicMessage } from '../handlers/anthropicConverter';
import { Logger, createLanguageModelChatInformation } from '../utils';
import { StatusBarManager } from '../status';
import { CliAuthFactory } from '../cli/auth/cliAuthFactory';
import { CliWizard } from '../cli/cliWizard';

export class ClaudeProvider extends GenericModelProvider {
    constructor(context: vscode.ExtensionContext, providerKey: string, providerConfig: ProviderConfig) {
        super(context, providerKey, providerConfig);
    }

    override async provideLanguageModelChatInformation(
        options: PrepareLanguageModelChatModelOptions,
        _token: vscode.CancellationToken
    ): Promise<LanguageModelChatInformation[]> {
        if (options.configuration) return [];

        if (!(await CliAuthFactory.isCliInstalled('claude'))) {
            Logger.debug('[ClaudeProvider] Claude CLI not detected');
            return [];
        }

        const creds = await CliAuthFactory.ensureAuthenticated('claude');
        if (!creds && !options.silent) {
            await vscode.commands.executeCommand('gcmp.claude.configWizard');
            if (!(await CliAuthFactory.ensureAuthenticated('claude'))) return [];
        }

        return this.providerConfig.models.map(m =>
            createLanguageModelChatInformation(m, {
                providerKey: this.providerKey,
                providerDisplayName: this.providerConfig.displayName,
                family: 'claude'
            })
        );
    }

    override async provideLanguageModelChatResponse(
        model: LanguageModelChatInformation,
        messages: Array<LanguageModelChatMessage>,
        _options: ProvideLanguageModelChatResponseOptions,
        progress: Progress<vscode.LanguageModelResponsePart>,
        token: CancellationToken
    ): Promise<void> {
        if (!model.id) throw new Error('Model ID is undefined');

        const rawId = model.id.includes(':::') ? model.id.split(':::')[1] : model.id;
        const modelConfig = this.providerConfig.models.find((m: any) => m.id === rawId);
        if (!modelConfig) throw new Error(`Model not found: ${model.id}`);

        const modelName = model.name || (modelConfig as any).name || model.id;
        Logger.info(`[ClaudeProvider] Starting request: ${modelName}`);

        try {
            if (!(await CliAuthFactory.isCliInstalled('claude'))) {
                throw new Error('Claude Code CLI not installed. Run: npm install -g @anthropic-ai/claude-code');
            }
            if (!(await CliAuthFactory.ensureAuthenticated('claude'))) {
                throw new Error('Claude Code CLI not authenticated. Run: claude auth login');
            }

            // 复用现成的 Anthropic 消息转换器
            const { messages: anthropicMsgs, system } = apiMessageToAnthropicMessage(modelConfig as any, messages);

            const systemText = system.text || 'You are a helpful assistant.';
            const handler = new ClaudeCliHandler();

            Logger.debug(`[ClaudeProvider] Messages count: ${anthropicMsgs.length}`);
            const firstMsg = anthropicMsgs[0] as any;
            if (firstMsg?.content) {
                const contentPreview =
                    Array.isArray(firstMsg.content) ?
                        firstMsg.content
                            .map((c: any) => `${c.type || '?'}:${String(c.text || c.content || '').substring(0, 50)}`)
                            .join(' | ')
                    :   String(firstMsg.content).substring(0, 100);
                Logger.debug(
                    `[ClaudeProvider] First message: ${JSON.stringify({ role: firstMsg.role, content: contentPreview })}`
                );
            }

            let hasText = false;
            for await (const chunk of handler.processRequest(
                {
                    systemPrompt: systemText,
                    messages: anthropicMsgs as any,
                    modelId: modelConfig.id,
                    timeoutMs: 300_000
                },
                token
            )) {
                if (token.isCancellationRequested) {
                    handler.kill();
                    break;
                }

                if (chunk.type === 'text') {
                    hasText = true;
                    progress.report({ index: 0, part: new vscode.LanguageModelTextPart(chunk.text) });
                } else if (chunk.type === 'error') {
                    Logger.error(`[ClaudeProvider] ${chunk.message}`);
                    throw new Error(chunk.message);
                }
            }

            if (!hasText && !token.isCancellationRequested) {
                throw new Error('Claude Code CLI 未返回有效响应。请检查 Output 面板的 GCMP 日志了解详情。');
            }

            Logger.info(`[ClaudeProvider] Request completed: ${modelName}`);
        } catch (error) {
            Logger.error(`[ClaudeProvider] Error: ${error instanceof Error ? error.message : 'Unknown error'}`);
            throw error;
        } finally {
            StatusBarManager.getStatusBar(this.providerKey)?.delayedUpdate(500);
        }
    }

    static createAndActivate(
        context: vscode.ExtensionContext,
        providerKey: string,
        providerConfig: ProviderConfig
    ): { provider: ClaudeProvider; disposables: vscode.Disposable[] } {
        Logger.info(`[ClaudeProvider] Activating Claude Code CLI provider`);

        const provider = new ClaudeProvider(context, providerKey, providerConfig);
        const providerDisposable = vscode.lm.registerLanguageModelChatProvider(`gcmp.${providerKey}`, provider);

        const configWizardCommand = vscode.commands.registerCommand(`gcmp.${providerKey}.configWizard`, async () => {
            await CliWizard.startWizard(providerKey, providerConfig.displayName);
            await provider.modelInfoCache?.invalidateCache(providerKey);
            provider._onDidChangeLanguageModelChatInformation.fire();
        });

        const disposables = [providerDisposable, configWizardCommand];
        disposables.forEach(d => context.subscriptions.push(d));
        return { provider, disposables };
    }
}
