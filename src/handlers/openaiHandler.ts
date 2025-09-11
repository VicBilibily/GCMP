/*---------------------------------------------------------------------------------------------
 *  通用OpenAI兼容SDK处理器
 *  纯粹的处理逻辑，不包含供应商特定配置
 *  配置由各个Provider提供
 *--------------------------------------------------------------------------------------------*/

import * as vscode from "vscode";
import OpenAI from "openai";
import { ModelHandler, SDKType } from "../types/sharedTypes";
import { ApiKeyManager, Logger } from "../utils";

/**
 * 通用OpenAI兼容处理器类
 * 接收完整的供应商配置，不依赖模型metadata
 */
export class OpenAIHandler implements ModelHandler {
  readonly sdkType = SDKType.OPENAI;

  private clients = new Map<string, OpenAI>();
  private cachedApiKeys = new Map<string, string>();

  constructor(
    public readonly provider: string,
    private readonly baseURL: string
  ) {
    // provider 和 baseURL 由调用方传入
  }

  /**
   * 获取或创建OpenAI客户端
   * 使用构造时传入的配置
   */
  private async getOpenAIClient(): Promise<OpenAI> {
    const currentApiKey = await ApiKeyManager.getApiKey(this.provider);

    if (!currentApiKey) {
      throw new Error(`缺少${this.provider}API密钥`);
    }

    const clientKey = `${this.provider}_${this.baseURL}`;
    const cachedKey = this.cachedApiKeys.get(clientKey);

    // 如果API密钥变更了，重置客户端
    if (!this.clients.has(clientKey) || cachedKey !== currentApiKey) {
      const client = new OpenAI({
        apiKey: currentApiKey,
        baseURL: this.baseURL,
      });

      this.clients.set(clientKey, client);
      this.cachedApiKeys.set(clientKey, currentApiKey);
      Logger.info(`${this.provider} OpenAI兼容客户端已重新创建（API密钥更新）`);
    }

    return this.clients.get(clientKey)!;
  }

  /**
   * 重置客户端
   */
  resetClient(): void {
    this.clients.clear();
    this.cachedApiKeys.clear();
    Logger.debug("OpenAI兼容客户端已重置");
  }

  /**
   * 处理OpenAI SDK请求
   */
  async handleRequest(
    model: vscode.LanguageModelChatInformation,
    messages: readonly vscode.LanguageModelChatMessage[],
    options: vscode.ProvideLanguageModelChatResponseOptions,
    progress: vscode.Progress<
      vscode.LanguageModelTextPart | vscode.LanguageModelToolCallPart
    >,
    token: vscode.CancellationToken
  ): Promise<void> {
    try {
      const client = await this.getOpenAIClient();

      Logger.info(
        `[${model.name}] 处理 ${messages.length} 条消息，使用 ${this.provider} (OpenAI兼容API)`
      );

      const createParams: OpenAI.Chat.ChatCompletionCreateParamsStreaming = {
        model: model.id,
        messages: this.convertMessagesToOpenAI(messages),
        max_tokens: Math.min(model.maxOutputTokens, 4096),
        stream: true,
        temperature: 0.7,
        top_p: 1,
      };

      // 添加工具支持（如果有）
      if (
        options.tools &&
        options.tools.length > 0 &&
        model.capabilities?.toolCalling
      ) {
        createParams.tools = this.convertToolsToOpenAI([...options.tools]);
        createParams.tool_choice = "auto";
      }

      Logger.debug(`[${model.name}] 发送 ${this.provider} API 请求`);
      const stream = await client.chat.completions.create(createParams);

      let hasReceivedContent = false;
      for await (const chunk of stream) {
        if (token.isCancellationRequested) {
          Logger.warn(`[${model.name}] 用户取消了请求`);
          break;
        }

        const hasContent = this.handleOpenAIStreamChunk(chunk, progress);
        if (hasContent) {
          hasReceivedContent = true;
        }
      }

      if (!hasReceivedContent) {
        Logger.warn(`[${model.name}] 没有接收到任何内容`);
        progress.report(
          new vscode.LanguageModelTextPart(
            `[${model.name}] 响应完成，但未收到内容。`
          )
        );
      }

      Logger.debug(`[${model.name}] ${this.provider} API请求完成`);
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : "未知错误";
      Logger.error(
        `[${model.name}] ${this.provider} API请求失败: ${errorMessage}`
      );

      // 通用错误处理
      this.handleError(error, model, progress);
    }
  }

  /**
   * 通用错误处理
   */
  private handleError(
    error: unknown,
    model: vscode.LanguageModelChatInformation,
    progress: vscode.Progress<
      vscode.LanguageModelTextPart | vscode.LanguageModelToolCallPart
    >
  ): void {
    let errorMessage = `[${model.name}] ${this.provider} API调用失败`;
    if (error instanceof Error) {
      errorMessage += `: ${error.message}`;
    }
    progress.report(new vscode.LanguageModelTextPart(errorMessage));
  }

  /**
   * 完整的消息转换 - 支持文本、图片和工具调用
   */
  private convertMessagesToOpenAI(
    messages: readonly vscode.LanguageModelChatMessage[]
  ): OpenAI.Chat.ChatCompletionMessageParam[] {
    const result: OpenAI.Chat.ChatCompletionMessageParam[] = [];

    for (const message of messages) {
      if (message.role === vscode.LanguageModelChatMessageRole.User) {
        // 检查是否有多模态内容（文本+图片）
        const textParts = message.content.filter(
          (part) => part instanceof vscode.LanguageModelTextPart
        );
        const imageParts: vscode.LanguageModelDataPart[] = [];

        // 安全地收集图片部分
        for (const part of message.content) {
          if (
            part instanceof vscode.LanguageModelDataPart &&
            this.isImageMimeType(part.mimeType)
          ) {
            imageParts.push(part);
          }
        }

        if (imageParts.length > 0) {
          // 多模态消息：包含图片
          const contentArray: (
            | OpenAI.Chat.ChatCompletionContentPartText
            | OpenAI.Chat.ChatCompletionContentPartImage
          )[] = [];

          // 添加文本内容
          if (textParts.length > 0) {
            contentArray.push({
              type: "text",
              text: textParts
                .map((part) => (part as vscode.LanguageModelTextPart).value)
                .join("\n"),
            });
          }

          // 添加图片内容
          for (const imagePart of imageParts) {
            const dataUrl = this.createDataUrl(imagePart);
            contentArray.push({
              type: "image_url",
              image_url: {
                url: dataUrl,
              },
            });
          }

          result.push({
            role: "user",
            content: contentArray,
          });
        } else if (textParts.length > 0) {
          // 纯文本消息
          result.push({
            role: "user",
            content: textParts
              .map((part) => (part as vscode.LanguageModelTextPart).value)
              .join("\n"),
          });
        }

        // 处理工具结果消息 - 这是防止无限重复的关键
        for (const part of message.content) {
          if (part instanceof vscode.LanguageModelToolResultPart) {
            let toolContent = "";
            if (typeof part.content === "string") {
              toolContent = part.content;
            } else if (Array.isArray(part.content)) {
              toolContent = part.content
                .map((resultPart) => {
                  if (resultPart instanceof vscode.LanguageModelTextPart) {
                    return resultPart.value;
                  }
                  return JSON.stringify(resultPart);
                })
                .join("\n");
            } else {
              toolContent = JSON.stringify(part.content);
            }

            result.push({
              role: "tool",
              content: toolContent,
              tool_call_id: part.callId,
            });
          }
        }
      } else if (
        message.role === vscode.LanguageModelChatMessageRole.Assistant
      ) {
        // 助手消息 - 处理文本和工具调用
        const textParts = message.content
          .filter((part) => part instanceof vscode.LanguageModelTextPart)
          .map((part) => (part as vscode.LanguageModelTextPart).value);

        const toolCalls: OpenAI.Chat.ChatCompletionMessageToolCall[] = [];
        for (const part of message.content) {
          if (part instanceof vscode.LanguageModelToolCallPart) {
            toolCalls.push({
              id: part.callId,
              type: "function",
              function: {
                name: part.name,
                arguments: JSON.stringify(part.input),
              },
            });
          }
        }

        const assistantMessage: OpenAI.Chat.ChatCompletionAssistantMessageParam =
          {
            role: "assistant",
            content: textParts.length > 0 ? textParts.join("\n") : null,
          };

        if (toolCalls.length > 0) {
          assistantMessage.tool_calls = toolCalls;
        }

        // 只有有内容或工具调用时才添加消息
        if (assistantMessage.content || toolCalls.length > 0) {
          result.push(assistantMessage);
        }
      } else if (message.role === vscode.LanguageModelChatMessageRole.System) {
        // 系统消息
        const textParts = message.content
          .filter((part) => part instanceof vscode.LanguageModelTextPart)
          .map((part) => (part as vscode.LanguageModelTextPart).value);

        if (textParts.length > 0) {
          result.push({
            role: "system",
            content: textParts.join("\n"),
          });
        }
      }
    }

    return result;
  }

  /**
   * 增强的工具转换 - 确保参数格式正确
   */
  private convertToolsToOpenAI(
    tools: vscode.LanguageModelChatTool[]
  ): OpenAI.Chat.ChatCompletionTool[] {
    return tools.map((tool) => {
      const functionDef: OpenAI.Chat.ChatCompletionTool = {
        type: "function",
        function: {
          name: tool.name,
          description: tool.description || "",
        },
      };

      // 处理参数schema
      if (tool.inputSchema) {
        if (typeof tool.inputSchema === "object" && tool.inputSchema !== null) {
          functionDef.function.parameters = tool.inputSchema as Record<
            string,
            unknown
          >;
        } else {
          // 如果不是对象，提供默认schema
          functionDef.function.parameters = {
            type: "object",
            properties: {},
            required: [],
          };
        }
      } else {
        // 默认schema
        functionDef.function.parameters = {
          type: "object",
          properties: {},
          required: [],
        };
      }

      return functionDef;
    });
  }

  /**
   * 修复的流处理 - 避免工具调用无限重复
   */
  private handleOpenAIStreamChunk(
    chunk: OpenAI.Chat.Completions.ChatCompletionChunk,
    progress: vscode.Progress<
      vscode.LanguageModelTextPart | vscode.LanguageModelToolCallPart
    >
  ): boolean {
    let hasContent = false;

    for (const choice of chunk.choices || []) {
      const delta = choice.delta;

      if (!delta) {
        continue;
      }

      // 处理文本内容
      if (delta.content && typeof delta.content === "string") {
        progress.report(new vscode.LanguageModelTextPart(delta.content));
        hasContent = true;
      }

      // 处理工具调用 - 关键修复：只在完整工具调用时报告
      if (delta.tool_calls && Array.isArray(delta.tool_calls)) {
        for (const toolCall of delta.tool_calls) {
          // 只有当工具调用完整时才报告（有名称和参数）
          if (toolCall.function?.name && toolCall.function?.arguments) {
            try {
              const args = JSON.parse(toolCall.function.arguments);
              const toolCallId =
                toolCall.id ||
                `tool_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;

              progress.report(
                new vscode.LanguageModelToolCallPart(
                  toolCallId,
                  toolCall.function.name,
                  args
                )
              );
              hasContent = true;
            } catch (error) {
              console.error("Error parsing tool call arguments:", error);
              // 解析失败时不报告工具调用，避免无限重复
            }
          }
        }
      }

      // 检查是否完成 - 这很重要
      if (
        choice.finish_reason === "tool_calls" ||
        choice.finish_reason === "stop"
      ) {
        Logger.debug(`流已结束，原因: ${choice.finish_reason}`);
      }
    }

    return hasContent;
  }

  /**
   * 检查是否为图片MIME类型
   */
  private isImageMimeType(mimeType: string): boolean {
    return (
      mimeType.startsWith("image/") &&
      ["image/jpeg", "image/png", "image/gif", "image/webp"].includes(mimeType)
    );
  }

  /**
   * 创建图片的data URL
   */
  private createDataUrl(dataPart: vscode.LanguageModelDataPart): string {
    const base64Data = Buffer.from(dataPart.data).toString("base64");
    return `data:${dataPart.mimeType};base64,${base64Data}`;
  }

  /**
   * 清理资源
   */
  dispose(): void {
    this.resetClient();
    Logger.debug("OpenAIHandler 已清理");
  }
}
