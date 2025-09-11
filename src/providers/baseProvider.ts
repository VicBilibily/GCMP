/*---------------------------------------------------------------------------------------------
 *  基础Provider类
 *  提供通用的模型供应商实现逻辑
 *--------------------------------------------------------------------------------------------*/

import * as vscode from "vscode";
import {
  CancellationToken,
  LanguageModelChatInformation,
  LanguageModelChatMessage,
  LanguageModelChatProvider,
  LanguageModelTextPart,
  Progress,
  ProvideLanguageModelChatResponseOptions,
} from "vscode";
import { ProviderConfig, ModelHandler } from "../types/sharedTypes";
import { ApiKeyManager, Logger } from "../utils";
import { AnthropicHandler } from "../handlers/anthropicHandler";
import { OpenAIHandler } from "../handlers/openaiHandler";

/**
 * 基础模型供应商类
 * 提供通用的供应商实现逻辑
 */
export abstract class BaseModelProvider implements LanguageModelChatProvider {
  protected readonly handlers: Map<string, ModelHandler>;

  /**
   * 静态供应商信息配置 - 子类必须覆盖
   */
  static providerConfig: ProviderConfig;

  /**
   * 静态模型列表配置 - 子类必须覆盖
   */
  static models: LanguageModelChatInformation[];

  constructor() {
    this.handlers = new Map();

    // 根据providerConfig中的URL配置自动创建handlers
    this.initializeHandlers();
  }

  /**
   * 获取当前实例的供应商信息
   */
  protected get providerConfig(): ProviderConfig {
    return (this.constructor as typeof BaseModelProvider).providerConfig;
  }

  /**
   * 获取当前实例的模型列表
   */
  protected get models(): LanguageModelChatInformation[] {
    return (this.constructor as typeof BaseModelProvider).models;
  }

  /**
   * 根据providerConfig配置自动初始化handlers
   */
  private initializeHandlers(): void {
    // 如果配置了OpenAI兼容API，创建OpenAI handler
    if (this.providerConfig.openAiUrl) {
      const openaiHandler = new OpenAIHandler(
        this.providerConfig.name,
        this.providerConfig.displayName,
        this.providerConfig.openAiUrl
      );
      this.handlers.set("openai", openaiHandler);
    }
    // 如果配置了Anthropic API，创建Anthropic handler
    if (this.providerConfig.anthropicUrl) {
      const anthropicHandler = new AnthropicHandler(
        this.providerConfig.name,
        this.providerConfig.displayName,
        this.providerConfig.anthropicUrl
      );
      this.handlers.set("anthropic", anthropicHandler);
    }
  }

  /**
   * 通用激活方法
   * 根据供应商信息自动注册provider和命令
   */
  static activateProvider<T extends BaseModelProvider>(
    context: vscode.ExtensionContext,
    ProviderClass: new () => T,
    providerConfig: ProviderConfig
  ): T {
    // 显示激活消息
    Logger.info(`${providerConfig.displayName}模型扩展已激活!`);

    // 创建并注册模型供应商
    const provider = new ProviderClass();
    const providerDisposable = vscode.lm.registerLanguageModelChatProvider(
      `gcmp.${providerConfig.name}`,
      provider
    );
    context.subscriptions.push(providerDisposable);

    // 注册设置API密钥命令
    const setApiKeyCommand = vscode.commands.registerCommand(
      `gcmp.${providerConfig.name}.setApiKey`,
      async () => {
        await ApiKeyManager.promptAndSetApiKey(
          providerConfig.name,
          providerConfig.displayName,
          providerConfig.apiKeyTemplate
        );
      }
    );
    context.subscriptions.push(setApiKeyCommand);

    return provider;
  }

  /**
   * 通用激活方法 - 使用静态配置
   */
  static activate<T extends BaseModelProvider>(
    context: vscode.ExtensionContext,
    ProviderClass: (new () => T) & {
      providerConfig: ProviderConfig;
    }
  ): T {
    const providerConfig = ProviderClass.providerConfig;
    return BaseModelProvider.activateProvider(
      context,
      ProviderClass,
      providerConfig
    );
  }

  async provideLanguageModelChatInformation(
    options: { silent: boolean },
    _token: CancellationToken
  ): Promise<LanguageModelChatInformation[]> {
    // 检查是否有API密钥
    const hasApiKey = await ApiKeyManager.hasValidApiKey(this.providerConfig.name);
    if (!hasApiKey) {
      // 如果是静默模式（如扩展启动时），不触发用户交互，直接返回空列表
      if (options.silent) {
        return [];
      }
      // 非静默模式下，直接触发API密钥设置
      await vscode.commands.executeCommand(`gcmp.${this.providerConfig.name}.setApiKey`);
      // 重新检查API密钥
      const hasApiKeyAfterSet = await ApiKeyManager.hasValidApiKey(this.providerConfig.name);
      if (!hasApiKeyAfterSet) {
        // 如果用户取消设置或设置失败，返回空列表
        return [];
      }
    }

    return this.models.map((model) => ({
      ...model,
      name: `[GCMP] ${model.name}`,
      // 高效编辑工具 GHC 用 family 前缀判断
      family: `claude_${model.family}`,
    }));
  }

  async provideLanguageModelChatResponse(
    model: LanguageModelChatInformation,
    messages: Array<LanguageModelChatMessage>,
    options: ProvideLanguageModelChatResponseOptions,
    progress: Progress<
      vscode.LanguageModelTextPart | vscode.LanguageModelToolCallPart
    >,
    token: CancellationToken
  ): Promise<void> {
    const modelInfo = this.models.find((m) => m.id === model.id);
    if (!modelInfo) {
      const errorMessage = `未找到模型: ${model.id}`;
      Logger.error(errorMessage);
      progress.report(new LanguageModelTextPart(errorMessage));
      return;
    }

    // 确保有API密钥（最后的保险检查）
    await ApiKeyManager.ensureApiKey(this.providerConfig.name, this.providerConfig.displayName);

    Logger.info(
      `${this.providerConfig.displayName} Provider 开始处理请求: ${modelInfo.name}`
    );

    try {
      await this.handleModelRequest(
        modelInfo,
        messages,
        options,
        progress,
        token
      );
    } catch (error) {
      const errorMessage = `错误: ${error instanceof Error ? error.message : "未知错误"
        }`;
      Logger.error(errorMessage);
      progress.report(new LanguageModelTextPart(errorMessage));
    }
  }

  async provideTokenCount(
    _model: LanguageModelChatInformation,
    text: string | LanguageModelChatMessage,
    _token: CancellationToken
  ): Promise<number> {
    // 简单的token计数实现
    const textContent =
      typeof text === "string" ? text : text.content?.toString() || "";
    return Math.ceil(textContent.length / 4); // 粗略估算，1个token ≈ 4个字符
  }

  /**
   * 通用的模型请求处理逻辑
   * 根据模型的SDK类型选择合适的handler
   */
  protected async handleModelRequest(
    model: LanguageModelChatInformation,
    messages: Array<LanguageModelChatMessage>,
    options: ProvideLanguageModelChatResponseOptions,
    progress: Progress<
      vscode.LanguageModelTextPart | vscode.LanguageModelToolCallPart
    >,
    token: CancellationToken
  ): Promise<void> {
    try {
      const handler = this.handlers.get(model.sdkType);
      if (!handler) {
        throw new Error(
          `${this.providerConfig.displayName}不支持的SDK类型: ${model.sdkType}`
        );
      }

      await handler.handleRequest(model, messages, options, progress, token);
    } catch (error) {
      const errorMessage = `错误: ${error instanceof Error ? error.message : "未知错误"
        }`;
      progress.report(new LanguageModelTextPart(errorMessage));
    }
  }

  /**
   * 清理资源
   */
  dispose(): void {
    // 清理所有handlers
    this.handlers.forEach((handler) => handler.dispose());
    this.handlers.clear();
  }
}
