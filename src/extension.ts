// The module 'vscode' contains the VS Code extensibility API
// Import the module and reference it with the alias vscode in your code below
import * as vscode from "vscode";
import { ZhipuChatModelProvider } from "./providers/zhipuProvider";
import { ModelscopeChatModelProvider } from "./providers/modelscopeProvider";
import { DeepSeekChatModelProvider } from "./providers/deepseekProvider";
import { IFlowChatModelProvider } from "./providers/iflowProvider";
import { MoonshotChatModelProvider } from "./providers/moonshotProvider";
import { BaseModelProvider } from "./providers/baseProvider";
import { Logger, LogLevel } from "./utils/logger";
import { ApiKeyManager, ConfigManager } from "./utils";

// This method is called when your extension is activated
// Your extension is activated the very first time the command is executed
export function activate(context: vscode.ExtensionContext) {
  Logger.initialize("GitHub Copilot Models Provider (GCMP)"); // 初始化日志管理器
  // 根据是否为调试模式设置日志级别
  const isDevelopment = context.extensionMode === vscode.ExtensionMode.Development;
  Logger.setLevel(isDevelopment ? LogLevel.DEBUG : LogLevel.INFO);

  ApiKeyManager.initialize(context); // 初始化API密钥管理器

  // 初始化配置管理器并注册到context
  const configDisposable = ConfigManager.initialize();
  context.subscriptions.push(configDisposable);

  BaseModelProvider.activate(context, ZhipuChatModelProvider); // 智谱AI
  BaseModelProvider.activate(context, MoonshotChatModelProvider); // 月之暗面
  BaseModelProvider.activate(context, DeepSeekChatModelProvider); // DeepSeek
  BaseModelProvider.activate(context, ModelscopeChatModelProvider); // 魔搭社区
  BaseModelProvider.activate(context, IFlowChatModelProvider); // iFlow心流
}

// This method is called when your extension is deactivated
export function deactivate() {
  ConfigManager.dispose(); // 清理配置管理器
  Logger.dispose(); // 在扩展销毁时才 dispose Logger
}
