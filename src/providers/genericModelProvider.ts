/*---------------------------------------------------------------------------------------------
 *  通用Provider类
 *  基于配置文件动态创建供应商实现
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import {
    CancellationToken,
    LanguageModelChatInformation,
    LanguageModelChatMessage,
    LanguageModelChatProvider,
    Progress,
    ProvideLanguageModelChatResponseOptions
} from 'vscode';
import { createByEncoderName, TikTokenizer } from '@microsoft/tiktokenizer';
import { ProviderConfig, ModelConfig } from '../types/sharedTypes';
import { ApiKeyManager, ConfigManager, Logger, OpenAIHandler, AnthropicHandler } from '../utils';

/**
 * 全局共享的 tokenizer 实例
 * 所有供应商共享同一个 tokenizer，节省内存和初始化时间
 */
let sharedTokenizerPromise: Promise<TikTokenizer> | null = null;

/**
 * 获取共享的 tokenizer 实例（懒加载，全局单例）
 */
function getSharedTokenizer(): Promise<TikTokenizer> {
    if (!sharedTokenizerPromise) {
        Logger.trace('🔧 首次请求 tokenizer，正在初始化全局共享实例...');
        sharedTokenizerPromise = createByEncoderName('o200k_base');
    }
    return sharedTokenizerPromise;
}

/**
 * 通用模型供应商类
 * 基于配置文件动态创建供应商实现
 */
export class GenericModelProvider implements LanguageModelChatProvider {
    protected readonly openaiHandler: OpenAIHandler;
    protected readonly anthropicHandler: AnthropicHandler;
    protected readonly providerKey: string;
    protected baseProviderConfig: ProviderConfig; // protected 以支持子类访问
    protected cachedProviderConfig: ProviderConfig; // 缓存的配置
    protected configListener?: vscode.Disposable; // 配置监听器

    // 模型信息变更事件
    protected _onDidChangeLanguageModelChatInformation = new vscode.EventEmitter<void>();
    readonly onDidChangeLanguageModelChatInformation = this._onDidChangeLanguageModelChatInformation.event;

    constructor(providerKey: string, providerConfig: ProviderConfig) {
        this.providerKey = providerKey;
        // 保存原始配置（不应用覆盖）
        this.baseProviderConfig = providerConfig;
        // 初始化缓存配置（应用覆盖）
        this.cachedProviderConfig = ConfigManager.applyProviderOverrides(this.providerKey, this.baseProviderConfig);
        // 监听配置变更
        this.configListener = vscode.workspace.onDidChangeConfiguration(e => {
            // 检查是否是 providerOverrides 的变更
            if (e.affectsConfiguration('gcmp.providerOverrides') && providerKey !== 'compatible') {
                // 重新计算配置
                this.cachedProviderConfig = ConfigManager.applyProviderOverrides(
                    this.providerKey,
                    this.baseProviderConfig
                );
                Logger.trace(`${this.providerKey} 配置已更新`);
                this._onDidChangeLanguageModelChatInformation.fire();
            }
            if (e.affectsConfiguration('gcmp.editToolMode')) {
                Logger.trace(`${this.providerKey} 检测到 editToolMode 变更`);
                this._onDidChangeLanguageModelChatInformation.fire();
            }
        });

        // 创建 OpenAI SDK 处理器
        this.openaiHandler = new OpenAIHandler(providerKey, providerConfig.displayName, providerConfig.baseUrl);
        // 创建 Anthropic SDK 处理器
        this.anthropicHandler = new AnthropicHandler(providerKey, providerConfig.displayName, providerConfig.baseUrl);
    }

    /**
     * 释放资源
     */
    dispose(): void {
        // 释放配置监听器
        this.configListener?.dispose();
        // 释放事件发射器
        this._onDidChangeLanguageModelChatInformation.dispose();
        Logger.info(`🧹 ${this.providerConfig.displayName}: 扩展销毁`);
    }

    /**
     * 获取当前有效的 provider 配置
     */
    get providerConfig(): ProviderConfig {
        return this.cachedProviderConfig;
    }

    /**
     * 静态工厂方法 - 根据配置创建并激活供应商
     */
    static createAndActivate(
        context: vscode.ExtensionContext,
        providerKey: string,
        providerConfig: ProviderConfig
    ): { provider: GenericModelProvider; disposables: vscode.Disposable[] } {
        Logger.trace(`${providerConfig.displayName} 模型扩展已激活!`);
        // 创建供应商实例
        const provider = new GenericModelProvider(providerKey, providerConfig);
        // 注册语言模型聊天供应商
        const providerDisposable = vscode.lm.registerLanguageModelChatProvider(`gcmp.${providerKey}`, provider);
        // 注册设置API密钥命令
        const setApiKeyCommand = vscode.commands.registerCommand(`gcmp.${providerKey}.setApiKey`, async () => {
            await ApiKeyManager.promptAndSetApiKey(
                providerKey,
                providerConfig.displayName,
                providerConfig.apiKeyTemplate
            );
        });
        const disposables = [providerDisposable, setApiKeyCommand];
        disposables.forEach(disposable => context.subscriptions.push(disposable));
        return { provider, disposables };
    }

    /**
     * 将ModelConfig转换为LanguageModelChatInformation
     */
    protected modelConfigToInfo(model: ModelConfig): LanguageModelChatInformation {
        // 读取编辑工具模式设置
        const editToolMode = vscode.workspace.getConfiguration('gcmp').get('editToolMode', 'claude') as string;

        let family: string;
        if (editToolMode && editToolMode !== 'none') {
            family = editToolMode.startsWith('claude') ? 'claude-sonnet-4.5' : editToolMode;
        } else if (editToolMode === 'none') {
            family = model.id;
        } else {
            family = model.id; // 回退到使用模型ID
        }

        const info: LanguageModelChatInformation = {
            id: model.id,
            name: model.name,
            detail: this.providerConfig.displayName,
            tooltip: model.tooltip,
            family: family,
            maxInputTokens: model.maxInputTokens,
            maxOutputTokens: model.maxOutputTokens,
            version: model.id,
            capabilities: model.capabilities
        };

        return info;
    }

    async provideLanguageModelChatInformation(
        options: { silent: boolean },
        _token: CancellationToken
    ): Promise<LanguageModelChatInformation[]> {
        // 检查是否有API密钥
        const hasApiKey = await ApiKeyManager.hasValidApiKey(this.providerKey);
        if (!hasApiKey) {
            // 如果是静默模式（如扩展启动时），不触发用户交互，直接返回空列表
            if (options.silent) {
                return [];
            }
            // 非静默模式下，直接触发API密钥设置
            await vscode.commands.executeCommand(`gcmp.${this.providerKey}.setApiKey`);
            // 重新检查API密钥
            const hasApiKeyAfterSet = await ApiKeyManager.hasValidApiKey(this.providerKey);
            if (!hasApiKeyAfterSet) {
                // 如果用户取消设置或设置失败，返回空列表
                return [];
            }
        }
        // 将配置中的模型转换为VS Code所需的格式
        return this.providerConfig.models.map(model => this.modelConfigToInfo(model));
    }

    async provideLanguageModelChatResponse(
        model: LanguageModelChatInformation,
        messages: Array<LanguageModelChatMessage>,
        options: ProvideLanguageModelChatResponseOptions,
        progress: Progress<vscode.LanguageModelResponsePart>,
        token: CancellationToken
    ): Promise<void> {
        // 查找对应的模型配置
        const modelConfig = this.providerConfig.models.find((m: ModelConfig) => m.id === model.id);
        if (!modelConfig) {
            const errorMessage = `未找到模型: ${model.id}`;
            Logger.error(errorMessage);
            throw new Error(errorMessage);
        }

        // 确保有API密钥
        await ApiKeyManager.ensureApiKey(this.providerKey, this.providerConfig.displayName);

        // 根据模型的 sdkMode 选择使用的 handler
        const sdkMode = modelConfig.sdkMode || 'openai';
        const sdkName = sdkMode === 'anthropic' ? 'Anthropic SDK' : 'OpenAI SDK';
        Logger.info(`${this.providerConfig.displayName} Provider 开始处理请求 (${sdkName}): ${modelConfig.name}`);

        try {
            if (sdkMode === 'anthropic') {
                await this.anthropicHandler.handleRequest(model, modelConfig, messages, options, progress, token);
            } else {
                await this.openaiHandler.handleRequest(model, modelConfig, messages, options, progress, token);
            }
        } catch (error) {
            const errorMessage = `错误: ${error instanceof Error ? error.message : '未知错误'}`;
            Logger.error(errorMessage);
            // 直接抛出错误，让VS Code处理重试
            throw error;
        } finally {
            Logger.info(`✅ ${this.providerConfig.displayName}: ${model.name} 请求已完成`);
        }
    }

    async provideTokenCount(
        model: LanguageModelChatInformation,
        text: string | LanguageModelChatMessage,
        _token: CancellationToken
    ): Promise<number> {
        Logger.info(`🔢 provideTokenCount 被调用 - 模型: ${model.id}, 输入类型: ${typeof text}`);
        try {
            const tokenizer = await getSharedTokenizer();
            if (!tokenizer) {
                throw new Error('Tokenizer 初始化失败');
            }

            if (typeof text === 'string') {
                return tokenizer.encode(text).length;
            } else {
                let fullText = '';
                if (Array.isArray(text.content)) {
                    for (const part of text.content) {
                        if (part instanceof vscode.LanguageModelTextPart) {
                            fullText += part.value;
                        } else if (part instanceof vscode.LanguageModelDataPart) {
                            fullText += '[data]';
                        } else if (part instanceof vscode.LanguageModelToolCallPart) {
                            fullText += `[toolcall:${part.name}]`;
                        } else if (part instanceof vscode.LanguageModelToolResultPart) {
                            fullText += `[toolresult:${typeof part.content === 'string' ? part.content : JSON.stringify(part.content)}]`;
                        }
                    }
                }
                return tokenizer.encode(fullText).length;
            }
        } catch (error) {
            Logger.warn(`Tokenizer 计数失败，回退到估算方式: ${error}`);
            // Fallback 到原有估算方式
            if (typeof text === 'string') {
                // 对于纯文本，使用改进的估算算法
                // 考虑中英文混合的情况
                const chineseChars = (text.match(/[\u4e00-\u9fff]/g) || []).length;
                const englishWords = (text.match(/\b\w+\b/g) || []).length;
                const symbols = text.length - chineseChars - englishWords;
                // 中文字符约1.5个token，英文单词约1个token，符号约0.5个token
                return Math.ceil(chineseChars * 1.5 + englishWords + symbols * 0.5);
            } else {
                // 对于复杂消息，分别计算各部分的token
                let totalTokens = 0;
                if (Array.isArray(text.content)) {
                    for (const part of text.content) {
                        if (part instanceof vscode.LanguageModelTextPart) {
                            const partTokens = await this.provideTokenCount(model, part.value, _token);
                            totalTokens += partTokens;
                        } else if (part instanceof vscode.LanguageModelDataPart) {
                            // 图片或数据部分根据类型估算token
                            if (part.mimeType.startsWith('image/')) {
                                totalTokens += 170; // 图片大约170个token
                            } else {
                                totalTokens += Math.ceil(part.data.length / 10); // 其他数据估算
                            }
                        } else if (part instanceof vscode.LanguageModelToolCallPart) {
                            // 工具调用的token计算
                            const toolCallText = `${part.name}(${JSON.stringify(part.input)})`;
                            const toolTokens = await this.provideTokenCount(model, toolCallText, _token);
                            totalTokens += toolTokens;
                        } else if (part instanceof vscode.LanguageModelToolResultPart) {
                            // 工具结果的token计算
                            const resultText =
                                typeof part.content === 'string' ? part.content : JSON.stringify(part.content);
                            const resultTokens = await this.provideTokenCount(model, resultText, _token);
                            totalTokens += resultTokens;
                        }
                    }
                }
                // 添加角色和结构的固定开销
                totalTokens += 4; // 角色和结构开销
                return totalTokens;
            }
        }
    }
}
