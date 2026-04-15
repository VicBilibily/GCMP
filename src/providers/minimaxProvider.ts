/*---------------------------------------------------------------------------------------------
 *  MiniMax 专用 Provider
 *  为 MiniMax 提供商提供多密钥管理和专属配置向导功能
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
import { Logger, ApiKeyManager, MiniMaxWizard } from '../utils';
import { StatusBarManager } from '../status';
import { TokenUsagesManager } from '../usages/usagesManager';
import { MiniMaxVisionTool } from '../tools/minimaxVision';

/**
 * MiniMax 专用模型提供商类
 * 继承 GenericModelProvider，添加多密钥管理和配置向导功能
 */
export class MiniMaxProvider extends GenericModelProvider implements LanguageModelChatProvider {
    constructor(context: vscode.ExtensionContext, providerKey: string, providerConfig: ProviderConfig) {
        super(context, providerKey, providerConfig);
    }

    /**
     * 静态工厂方法 - 创建并激活 MiniMax 提供商
     */
    static createAndActivate(
        context: vscode.ExtensionContext,
        providerKey: string,
        providerConfig: ProviderConfig
    ): { provider: MiniMaxProvider; disposables: vscode.Disposable[] } {
        Logger.trace(`${providerConfig.displayName} 专用模型扩展已激活!`);
        // 创建提供商实例
        const provider = new MiniMaxProvider(context, providerKey, providerConfig);
        // 注册语言模型聊天提供商
        const providerDisposable = vscode.lm.registerLanguageModelChatProvider(`gcmp.${providerKey}`, provider);

        // 注册设置普通 API 密钥命令
        const setApiKeyCommand = vscode.commands.registerCommand(`gcmp.${providerKey}.setApiKey`, async () => {
            await MiniMaxWizard.setNormalApiKey(providerConfig.displayName, providerConfig.apiKeyTemplate);
            // API 密钥变更后清除缓存
            await provider.modelInfoCache?.invalidateCache(providerKey);
            // 触发模型信息变更事件
            provider._onDidChangeLanguageModelChatInformation.fire();
        });

        // 注册设置 Coding Plan 专用密钥命令
        const setCodingKeyCommand = vscode.commands.registerCommand(
            `gcmp.${providerKey}.setCodingPlanApiKey`,
            async () => {
                await MiniMaxWizard.setCodingPlanApiKey(providerConfig.displayName, providerConfig.codingKeyTemplate);
                // API 密钥变更后清除缓存
                await provider.modelInfoCache?.invalidateCache('minimax-coding');
                // 触发模型信息变更事件
                provider._onDidChangeLanguageModelChatInformation.fire();
            }
        );

        // 注册设置 Coding Plan 接入点命令
        const setCodingPlanEndpointCommand = vscode.commands.registerCommand(
            `gcmp.${providerKey}.setCodingPlanEndpoint`,
            async () => {
                Logger.info(`用户手动打开 ${providerConfig.displayName} Coding Plan 接入点选择`);
                await MiniMaxWizard.setCodingPlanEndpoint(providerConfig.displayName);
            }
        );

        // 注册配置向导命令
        const configWizardCommand = vscode.commands.registerCommand(`gcmp.${providerKey}.configWizard`, async () => {
            Logger.info(`启动 ${providerConfig.displayName} 配置向导`);
            await MiniMaxWizard.startWizard(
                providerConfig.displayName,
                providerConfig.apiKeyTemplate,
                providerConfig.codingKeyTemplate
            );
        });

        const disposables = [
            providerDisposable,
            setApiKeyCommand,
            setCodingKeyCommand,
            setCodingPlanEndpointCommand,
            configWizardCommand
        ];
        disposables.forEach(disposable => context.subscriptions.push(disposable));
        return { provider, disposables };
    }

    /**
     * 获取 MiniMax 状态栏实例（用于 delayedUpdate 调用）
     */
    static getMiniMaxStatusBar() {
        return StatusBarManager.minimax;
    }

    /**
     * 获取模型对应的 provider key（考虑 provider 字段和默认值）
     */
    private getProviderKeyForModel(modelConfig: ModelConfig): string {
        // 优先使用模型特定的 provider 字段
        if (modelConfig.provider) {
            return modelConfig.provider;
        }
        // 否则使用提供商默认的 provider key
        return this.providerKey;
    }

    /**
     * 检查是否为支持的图片 MIME 类型
     * MiniMax Vision API 仅支持 JPEG、PNG、WebP，不支持 GIF
     */
    private isImageMimeType(mimeType: string): boolean {
        const normalizedMimeType = mimeType.toLowerCase() === 'image/jpg' ? 'image/jpeg' : mimeType.toLowerCase();
        const supportedTypes = ['image/jpeg', 'image/png', 'image/webp'];
        return supportedTypes.includes(normalizedMimeType);
    }

    /**
     * 预处理消息中的图片（图片桥接功能）
     * 使用 MiniMax Vision API 将图片转换为文字描述后再发送给模型
     * 注意：只处理当前轮次的新消息（最后一条用户消息），历史消息已在上一轮处理过
     * @param messages 原始消息列表
     * @param modelConfig 模型配置
     * @param progress 可选的进度报告器，用于显示图片解析进度
     * @returns 处理后的消息列表
     */
    private async preprocessImagesInMessages(
        messages: Array<LanguageModelChatMessage>,
        modelConfig: ModelConfig
    ): Promise<Array<LanguageModelChatMessage>> {
        // 只对 Coding Plan 模型启用图片桥接
        const providerKey = this.getProviderKeyForModel(modelConfig);
        if (providerKey !== 'minimax-coding') {
            return messages;
        }

        // 检查是否有 MiniMax Vision API 密钥
        const hasApiKey = await ApiKeyManager.hasValidApiKey('minimax-coding');
        if (!hasApiKey) {
            Logger.debug('MiniMax 图片桥接: 未配置 Coding Plan API 密钥，跳过图片预处理');
            return messages;
        }

        const visionTool = new MiniMaxVisionTool();

        // 找到最后一条用户消息（当前轮次的新消息）
        let lastUserMessageIndex = -1;
        for (let i = messages.length - 1; i >= 0; i--) {
            if (messages[i].role === vscode.LanguageModelChatMessageRole.User) {
                lastUserMessageIndex = i;
                break;
            }
        }

        // 统计需要处理的图片数量（包含所有 image/* 类型，确保 GIF 等不支持格式也进入桥接）
        let totalImages = 0;
        let processedCount = 0;
        if (lastUserMessageIndex >= 0) {
            const lastUserMessage = messages[lastUserMessageIndex];
            for (const part of lastUserMessage.content) {
                if (part instanceof vscode.LanguageModelDataPart && part.mimeType.startsWith('image/')) {
                    totalImages++;
                }
            }
        }

        if (totalImages === 0) {
            return messages;
        }

        Logger.info(`检测到 ${totalImages} 张图片需要分析`);

        // 只处理最后一条用户消息
        const lastUserMessage = messages[lastUserMessageIndex];

        // 先提取用户原始问题（用于喂给视觉模型的提示词）
        const originalTextParts: string[] = [];
        for (const part of lastUserMessage.content) {
            if (part instanceof vscode.LanguageModelTextPart) {
                originalTextParts.push(part.value);
            }
        }
        const originalQuestion = originalTextParts.join('\n').trim();

        // 再处理图片部分
        const imageDescriptions: string[] = [];
        for (const part of lastUserMessage.content) {
            if (part instanceof vscode.LanguageModelDataPart && part.mimeType.startsWith('image/')) {
                if (!this.isImageMimeType(part.mimeType)) {
                    Logger.error(`不支持的图片格式: ${part.mimeType}`);
                    throw new Error(`不支持的图片格式: ${part.mimeType}。MiniMax Vision 仅支持 JPEG、PNG、WebP。`);
                } else {
                    processedCount++;
                    try {
                        Logger.info(`正在分析图片 (${processedCount}/${totalImages}): mimeType=${part.mimeType}, data大小=${part.data.length}字节`);

                        // 带上图片序号（共N张）和用户问题，让视觉模型给出结构化、有针对性的描述
                        const visionPrompt = originalQuestion
                            ? `这是第${processedCount}张（共${totalImages}张）。用户的问题是：${originalQuestion}\n\n请详细描述这张图片的内容，力求准确完整。`
                            : `这是第${processedCount}张（共${totalImages}张）。\n\n请详细描述这张图片的内容，力求准确完整。`;
                        const response = await visionTool.understandImage(part.data, part.mimeType, visionPrompt);
                        imageDescriptions.push(response.content);
                        Logger.info(`图片 ${processedCount}/${totalImages} 转换成功`);
                    } catch (error) {
                        Logger.error(`图片 ${processedCount}/${totalImages} 转换失败`, error instanceof Error ? error : undefined);
                        imageDescriptions.push('[图片分析失败]');
                    }
                }
            }
        }

        if (processedCount > 0) {
            Logger.info(`全部 ${processedCount} 张图片解析完成`);
        }

        // 构造新的 content 数组：用 Vision 描述替换图片 parts，保留原始文本 parts
        // 格式：先列出"你（主模型）不支持图片"，再逐张列出 Vision 描述，最后附用户问题
        const bridgedContent: vscode.LanguageModelTextPart[] = [
            new vscode.LanguageModelTextPart(
                `你（主模型）不支持直接接收图片，用户共上传了${processedCount}张图片。以下是由视觉模型对这些图片的分析结果，以及用户的原始问题。\n\n图片内容（共${processedCount}张）：\n`
            )
        ];
        for (let i = 0; i < imageDescriptions.length; i++) {
            bridgedContent.push(new vscode.LanguageModelTextPart(`${i + 1}. ${imageDescriptions[i]}\n`));
        }
        bridgedContent.push(new vscode.LanguageModelTextPart(`\n用户问题：${originalQuestion}`));

        // 直接修改原消息的内容，不创建新数组
        // 使用类型断言因为 LanguageModelChatMessage 的 content 是只读的
        (lastUserMessage as unknown as { content: typeof bridgedContent }).content = bridgedContent;

        return messages;
    }

    /**
     * 获取模型对应的密钥，确保存在有效密钥
     * @param modelConfig 模型配置
     * @returns 返回可用的 API 密钥
     */
    private async ensureApiKeyForModel(modelConfig: ModelConfig): Promise<string> {
        const providerKey = this.getProviderKeyForModel(modelConfig);
        const isCodingPlan = providerKey === 'minimax-coding';
        const keyType = isCodingPlan ? 'Coding Plan 专用' : '普通';

        // 检查是否已有密钥
        const hasApiKey = await ApiKeyManager.hasValidApiKey(providerKey);
        if (hasApiKey) {
            const apiKey = await ApiKeyManager.getApiKey(providerKey);
            if (apiKey) {
                return apiKey;
            }
        }

        // 密钥不存在，直接进入设置流程（不弹窗确认）
        Logger.warn(`模型 ${modelConfig.name} 缺少 ${keyType} API 密钥，进入设置流程`);

        if (isCodingPlan) {
            // Coding Plan 模型直接进入专用密钥设置
            await MiniMaxWizard.setCodingPlanApiKey(
                this.providerConfig.displayName,
                this.providerConfig.codingKeyTemplate
            );
        } else {
            // 普通模型直接进入普通密钥设置
            await MiniMaxWizard.setNormalApiKey(this.providerConfig.displayName, this.providerConfig.apiKeyTemplate);
        }

        // 重新检查密钥是否设置成功
        const apiKey = await ApiKeyManager.getApiKey(providerKey);
        if (apiKey) {
            Logger.info(`${keyType}密钥设置成功`);
            return apiKey;
        }

        // 用户未设置或设置失败
        throw new Error(`${this.providerConfig.displayName}: 用户未设置 ${keyType} API 密钥`);
    }

    /**
     * 重写：获取模型信息 - 添加密钥检查
     * 只要有任意密钥存在就返回所有模型，不进行过滤
     * 具体的密钥验证在实际使用时（provideLanguageModelChatResponse）进行
     */
    override async provideLanguageModelChatInformation(
        options: PrepareLanguageModelChatModelOptions,
        _token: CancellationToken
    ): Promise<LanguageModelChatInformation[]> {
        if (options.configuration) {
            // 如果请求中包含 configuration，不返回模型列表
            return [];
        }

        // 检查是否有任意密钥
        const hasNormalKey = await ApiKeyManager.hasValidApiKey(this.providerKey);
        const hasCodingKey = await ApiKeyManager.hasValidApiKey('minimax-coding');
        const hasAnyKey = hasNormalKey || hasCodingKey;

        // 如果是静默模式且没有任何密钥，直接返回空列表
        if (options.silent && !hasAnyKey) {
            Logger.debug(`${this.providerConfig.displayName}: 静默模式下，未检测到任何密钥，返回空模型列表`);
            return [];
        }

        // 非静默模式：启动配置向导
        if (!options.silent) {
            await MiniMaxWizard.startWizard(
                this.providerConfig.displayName,
                this.providerConfig.apiKeyTemplate,
                this.providerConfig.codingKeyTemplate
            );

            // 重新检查是否设置了密钥
            const normalKeyValid = await ApiKeyManager.hasValidApiKey(this.providerKey);
            const codingKeyValid = await ApiKeyManager.hasValidApiKey('minimax-coding');

            // 如果用户仍未设置任何密钥，返回空列表
            if (!normalKeyValid && !codingKeyValid) {
                Logger.warn(`${this.providerConfig.displayName}: 用户未设置任何密钥，返回空模型列表`);
                return [];
            }
        }

        // 返回所有模型，不进行过滤
        // 具体的密钥验证会在用户选择模型后的 provideLanguageModelChatResponse 中进行
        Logger.debug(`${this.providerConfig.displayName}: 返回全部 ${this.providerConfig.models.length} 个模型`);

        // 将配置中的模型转换为 VS Code 所需的格式
        const models = this.providerConfig.models.map(model => this.modelConfigToInfo(model));

        return models;
    }

    /**
     * 重写：提供语言模型聊天响应 - 添加请求前密钥确保机制
     * 在处理请求前确保对应的密钥存在
     */
    async provideLanguageModelChatResponse(
        model: LanguageModelChatInformation,
        messages: Array<LanguageModelChatMessage>,
        options: ProvideLanguageModelChatResponseOptions,
        progress: Progress<vscode.LanguageModelResponsePart>,
        _token: CancellationToken
    ): Promise<void> {
        // 查找对应的模型配置
        const modelConfig = this.findModelConfigById(model);
        if (!modelConfig) {
            const errorMessage = `未找到模型: ${model.id}`;
            Logger.error(errorMessage);
            throw new Error(errorMessage);
        }

        // 请求前：确保模型对应的密钥存在
        // 这会在没有密钥时弹出设置对话框
        const providerKey = this.getProviderKeyForModel(modelConfig);
        const apiKey = await this.ensureApiKeyForModel(modelConfig);

        if (!apiKey) {
            const keyType = providerKey === 'minimax-coding' ? 'Coding Plan 专用' : '普通';
            throw new Error(`${this.providerConfig.displayName}: 无效的 ${keyType} API 密钥`);
        }

        Logger.debug(
            `${this.providerConfig.displayName}: 即将处理请求，使用 ${providerKey === 'minimax-coding' ? 'Coding Plan' : '普通'} 密钥 - 模型: ${modelConfig.name}`
        );

        // 图片桥接：预处理消息中的图片
        // 当模型不支持图片输入但使用 Coding Plan 密钥时，自动将图片转换为文字描述
        // 注意：此操作在 Token 统计之前执行，确保统计的是模型实际收到的文本描述而非原始图片
        const processedMessages = await this.preprocessImagesInMessages(messages, modelConfig);

        // 计算输入 token 数量并更新状态栏（使用桥接后的消息，图片已被替换为文本描述）
        const totalInputTokens = await this.updateContextUsageStatusBar(
            model,
            processedMessages,
            modelConfig,
            options
        );

        // === Token 统计: 记录预估输入 token ===
        const usagesManager = TokenUsagesManager.instance;
        let requestId: string | null = null;
        try {
            requestId = await usagesManager.recordEstimatedTokens({
                providerKey: providerKey,
                displayName: this.providerConfig.displayName,
                modelId: model.id,
                modelName: model.name || modelConfig.name,
                estimatedInputTokens: totalInputTokens
            });
        } catch (err) {
            Logger.warn('记录预估Token失败，继续执行请求:', err);
        }

        // 根据模型的 sdkMode 选择使用的 handler
        // 注：此处不调用 super.provideLanguageModelChatResponse，而是直接处理
        // 避免双重密钥检查，因为我们已经在 ensureApiKeyForModel 中检查过了
        const sdkMode = modelConfig.sdkMode || 'openai';
        const sdkName = this.getSdkDisplayName(sdkMode);
        Logger.info(`${this.providerConfig.displayName} Provider 开始处理请求 (${sdkName}): ${modelConfig.name}`);

        try {
            await this.executeModelRequest(
                model,
                modelConfig,
                processedMessages,
                options,
                progress,
                _token,
                requestId,
                providerKey
            );
        } catch (error) {
            const errorMessage = `错误: ${error instanceof Error ? error.message : '未知错误'}`;
            Logger.error(errorMessage);

            // === Token 统计: 更新失败状态 ===
            if (requestId) {
                try {
                    await usagesManager.updateActualTokens({
                        requestId,
                        status: 'failed'
                    });
                } catch (err) {
                    Logger.warn('更新Token统计失败状态失败:', err);
                }
            }

            throw error;
        } finally {
            Logger.info(`✅ ${this.providerConfig.displayName}: ${model.name} 请求已完成`);

            // 如果使用的是 Coding Plan 密钥，延时更新状态栏使用量
            if (providerKey === 'minimax-coding') {
                const statusBar = MiniMaxProvider.getMiniMaxStatusBar();
                statusBar?.delayedUpdate();
            }
        }
    }
}
