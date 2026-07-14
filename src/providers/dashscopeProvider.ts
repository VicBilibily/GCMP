/*---------------------------------------------------------------------------------------------
 *  Dashscope (阿里云百炼) 专用 Provider
 *  为 Dashscope 提供商提供多密钥管理和配置向导功能
 *--------------------------------------------------------------------------------------------*
 *  关于百炼 Responses API 内置工具（web_search / web_extractor / code_interpreter）：
 *  GCMP 不特意适配这些工具的中间执行输出（如 web_extractor_call 的 goal/output、
 *  code_interpreter_call 的 code/outputs），因此中间过程不会回显到对话流，仅最终
 *  文本回复可见。但模型内部仍可自行调用这些工具完成联网搜索、网页抓取、代码执行，
 *  底层注入链路已通过 nativeTools 完整支持。预置模型仅启用 web_search + web_extractor。
 *
 *  ⚠️ 不兼容 code_interpreter：code_interpreter 与 Function Calling 互斥（同时启用会报错），
 *  而 GCMP 的 Copilot agent 场景默认携带 function tools，因此预置模型与自定义模型均不
 *  支持 code_interpreter。用户若强行在自定义模型中配置 nativeTools 含 code_interpreter，
 *  在带工具调用的请求中会触发百炼服务端报错。
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import {
    CancellationToken,
    LanguageModelChatInformation,
    LanguageModelChatMessage,
    LanguageModelChatProvider,
    PrepareLanguageModelChatModelOptions,
    ProvideLanguageModelChatResponseOptions,
    Progress
} from 'vscode';
import { GenericModelProvider } from './genericModelProvider';
import { ProviderConfig, ModelConfig } from '../types/sharedTypes';
import { Logger, ApiKeyManager, isCancellationError } from '../utils';
import { DashscopeWizard } from '../wizards/dashscopeWizard';
import { TokenUsagesManager } from '../usages/usagesManager';
import { classifyRequest } from '../handlers/requestClassifier';

export class DashscopeProvider extends GenericModelProvider implements LanguageModelChatProvider {
    constructor(context: vscode.ExtensionContext, providerKey: string, providerConfig: ProviderConfig) {
        super(context, providerKey, providerConfig);
    }

    static createAndActivate(
        context: vscode.ExtensionContext,
        providerKey: string,
        providerConfig: ProviderConfig
    ): { provider: DashscopeProvider; disposables: vscode.Disposable[] } {
        Logger.trace(`${providerConfig.displayName} dedicated model extension activated`);

        const provider = new DashscopeProvider(context, providerKey, providerConfig);
        const providerDisposable = vscode.lm.registerLanguageModelChatProvider(`gcmp.${providerKey}`, provider);

        // 普通 API Key
        const setApiKeyCommand = vscode.commands.registerCommand(`gcmp.${providerKey}.setApiKey`, async () => {
            await DashscopeWizard.setNormalApiKey(providerConfig.displayName, providerConfig.apiKeyTemplate);
            await provider.modelInfoCache?.invalidateCache(providerKey);
            provider._onDidChangeLanguageModelChatInformation.fire();
        });

        // Coding Plan 专用 API Key
        const setCodingPlanApiKeyCommand = vscode.commands.registerCommand(
            `gcmp.${providerKey}.setCodingPlanApiKey`,
            async () => {
                await DashscopeWizard.setCodingPlanApiKey(providerConfig.displayName, providerConfig.codingKeyTemplate);
                await provider.modelInfoCache?.invalidateCache('dashscope-coding');
                provider._onDidChangeLanguageModelChatInformation.fire();
            }
        );

        // Token Plan 专用 API Key
        const setTokenPlanApiKeyCommand = vscode.commands.registerCommand(
            `gcmp.${providerKey}.setTokenPlanApiKey`,
            async () => {
                await DashscopeWizard.setTokenPlanApiKey(providerConfig.displayName, providerConfig.tokenKeyTemplate);
                await provider.modelInfoCache?.invalidateCache('dashscope-token');
                provider._onDidChangeLanguageModelChatInformation.fire();
            }
        );

        const configWizardCommand = vscode.commands.registerCommand(`gcmp.${providerKey}.configWizard`, async () => {
            Logger.info(`Starting ${providerConfig.displayName} setup wizard`);
            await DashscopeWizard.startWizard(
                providerConfig.displayName,
                providerConfig.apiKeyTemplate,
                providerConfig.codingKeyTemplate,
                providerConfig.tokenKeyTemplate
            );
            await provider.modelInfoCache?.invalidateCache(providerKey);
            provider._onDidChangeLanguageModelChatInformation.fire();
        });

        const disposables = [
            providerDisposable,
            setApiKeyCommand,
            setCodingPlanApiKeyCommand,
            setTokenPlanApiKeyCommand,
            configWizardCommand
        ];
        disposables.forEach(d => context.subscriptions.push(d));
        return { provider, disposables };
    }

    private async ensureApiKeyForModel(modelConfig: ModelConfig): Promise<string> {
        const providerKey = this.getProviderKeyForModel(modelConfig);
        const isCodingPlan = providerKey === 'dashscope-coding';
        const isTokenPlan = providerKey === 'dashscope-token';
        const keyType =
            isCodingPlan ? 'Coding Plan dedicated'
            : isTokenPlan ? 'Token Plan dedicated'
            : 'standard';

        const hasApiKey = await ApiKeyManager.hasValidApiKey(providerKey);
        if (hasApiKey) {
            const apiKey = await ApiKeyManager.getApiKey(providerKey);
            if (apiKey) {
                return apiKey;
            }
        }

        Logger.warn(`Model ${modelConfig.name} is missing the ${keyType} API key, entering setup flow`);

        if (isCodingPlan) {
            await DashscopeWizard.setCodingPlanApiKey(
                this.providerConfig.displayName,
                this.providerConfig.codingKeyTemplate
            );
        } else if (isTokenPlan) {
            await DashscopeWizard.setTokenPlanApiKey(
                this.providerConfig.displayName,
                this.providerConfig.tokenKeyTemplate
            );
        } else {
            await DashscopeWizard.setNormalApiKey(this.providerConfig.displayName, this.providerConfig.apiKeyTemplate);
        }

        const apiKey = await ApiKeyManager.getApiKey(providerKey);
        if (apiKey) {
            Logger.info(`${keyType} API key configured successfully`);
            return apiKey;
        }

        throw new Error(`${this.providerConfig.displayName}: user did not configure the ${keyType} API key`);
    }

    override async provideLanguageModelChatInformation(
        options: PrepareLanguageModelChatModelOptions,
        _token: CancellationToken
    ): Promise<LanguageModelChatInformation[]> {
        if (options.configuration) {
            // 如果请求中包含 configuration，不返回模型列表
            return [];
        }

        const hasNormalKey = await ApiKeyManager.hasValidApiKey(this.providerKey);
        const hasCodingKey = await ApiKeyManager.hasValidApiKey('dashscope-coding');
        const hasTokenPlanKey = await ApiKeyManager.hasValidApiKey('dashscope-token');
        const hasAnyKey = hasNormalKey || hasCodingKey || hasTokenPlanKey;

        if (options.silent && !hasAnyKey) {
            Logger.debug(
                `${this.providerConfig.displayName}: no keys detected in silent mode, returning empty model list`
            );
            return [];
        }

        if (!options.silent) {
            await DashscopeWizard.startWizard(
                this.providerConfig.displayName,
                this.providerConfig.apiKeyTemplate,
                this.providerConfig.codingKeyTemplate,
                this.providerConfig.tokenKeyTemplate
            );

            const normalKeyValid = await ApiKeyManager.hasValidApiKey(this.providerKey);
            const codingKeyValid = await ApiKeyManager.hasValidApiKey('dashscope-coding');
            const tokenPlanKeyValid = await ApiKeyManager.hasValidApiKey('dashscope-token');
            if (!normalKeyValid && !codingKeyValid && !tokenPlanKeyValid) {
                Logger.warn(
                    `${this.providerConfig.displayName}: user did not configure any keys, returning empty model list`
                );
                return [];
            }
        }

        // 根据已配置的 API Key 过滤模型
        const filteredModels = await this.filterModelsByAvailableKeys(this.providerConfig.models);
        Logger.trace(
            `${this.providerConfig.displayName}: ${filteredModels.length}/${this.providerConfig.models.length} models available after key filtering`
        );
        // 将配置中的模型转换为 VS Code 所需的格式
        return filteredModels.map(m => this.modelConfigToInfo(m));
    }

    async provideLanguageModelChatResponse(
        model: LanguageModelChatInformation,
        messages: Array<LanguageModelChatMessage>,
        options: ProvideLanguageModelChatResponseOptions,
        progress: Progress<vscode.LanguageModelResponsePart>,
        token: CancellationToken
    ): Promise<void> {
        // 查找对应的模型配置
        const modelConfig = this.findModelConfigById(model);
        if (!modelConfig) {
            const errorMessage = `Model not found: ${model.id}`;
            Logger.error(errorMessage);
            throw new Error(errorMessage);
        }

        const providerKey = this.getProviderKeyForModel(modelConfig);
        const apiKey = await this.ensureApiKeyForModel(modelConfig);
        if (!apiKey) {
            const keyType =
                providerKey === 'dashscope-coding' ? 'Coding Plan dedicated'
                : providerKey === 'dashscope-token' ? 'Token Plan dedicated'
                : 'standard';
            throw new Error(`${this.providerConfig.displayName}: invalid ${keyType} API key`);
        }

        const keyLabel =
            providerKey === 'dashscope-coding' ? 'Coding Plan'
            : providerKey === 'dashscope-token' ? 'Token Plan'
            : 'standard';
        Logger.debug(
            `${this.providerConfig.displayName}: about to handle request using ${keyLabel} key - model: ${modelConfig.name}`
        );

        // 请求分类 + 注入到 options.modelOptions（上层已设置 requestKind 时直接使用）
        const rtOpts = options as { modelOptions?: { requestKind?: string } };
        if (!rtOpts.modelOptions) {
            rtOpts.modelOptions = {};
        }
        const kind = rtOpts.modelOptions.requestKind ?? classifyRequest(messages, options.tools);
        rtOpts.modelOptions.requestKind = kind;

        const { totalInputTokens, maxInputTokens, estimatedIncrement } = await this.updateContextUsageStatusBar(
            model,
            messages,
            modelConfig,
            options
        );

        const usagesManager = TokenUsagesManager.instance;
        let requestId = '';
        const sdkMode = modelConfig.sdkMode || 'openai';
        const sessionId = this.getSessionIdFromMessages(messages, sdkMode);
        try {
            requestId = await usagesManager.recordEstimatedTokens({
                providerKey: providerKey,
                displayName: this.providerConfig.displayName,
                modelId: model.id,
                modelName: model.name || modelConfig.name,
                estimatedInputTokens: totalInputTokens,
                estimatedIncrement,
                maxInputTokens,
                requestKind: kind,
                sessionId,
                ...this.getEstimatedRequestMetadata(options)
            });
        } catch (err) {
            Logger.warn('Failed to record estimated tokens, continuing request:', err);
        }

        const sdkName = this.getSdkDisplayName(sdkMode);
        Logger.info(
            `${this.providerConfig.displayName} Provider started handling request (${sdkName}): ${modelConfig.name}`
        );

        try {
            await this.executeModelRequest(
                model,
                modelConfig,
                messages,
                options,
                progress,
                requestId,
                sessionId,
                token,
                providerKey
            );
        } catch (error) {
            if (isCancellationError(error)) {
                await this.reportRequestCancelled(requestId, sessionId);
                throw error;
            }
            this.reportRequestFailure(requestId, sessionId);
            throw error;
        } finally {
            Logger.info(`✅ ${this.providerConfig.displayName}: ${model.name} request completed`);
        }
    }
}
