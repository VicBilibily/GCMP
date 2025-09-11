import * as vscode from "vscode";
import { BaseModelProvider } from "./baseProvider";
import { ProviderConfig, SDKType } from "../types/sharedTypes";

/**
 * DeepSeek供应商配置
 */
const DEEPSEEK_PROVIDER_CONFIG: ProviderConfig = {
  name: "deepseek",
  displayName: "DeepSeek",
  apiKeyTemplate: "sk-xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx",
  openAiUrl: "https://api.deepseek.com/v1",
  // anthropicUrl: "https://api.deepseek.com/anthropic" (暂不调用Anthropic)
};

/**
 * DeepSeek模型定义
 * 基于DeepSeek官方API模型配置
 */
const DEEPSEEK_MODELS: vscode.LanguageModelChatInformation[] = [
  {
    id: 'deepseek-chat',
    name: 'DeepSeek V3.1 (官方)',
    tooltip: 'DeepSeek V3.1 官方模型 - 全面升级的对话和推理能力',
    family: 'deepseek-v3.1',
    maxInputTokens: 128000,
    maxOutputTokens: 8192,
    version: 'deepseek-chat',
    capabilities: {
      toolCalling: true,
      imageInput: false
    },
    sdkType: SDKType.OPENAI
  },
  {
    id: 'deepseek-reasoner',
    name: 'DeepSeek V3.1 (思考模式)',
    tooltip: 'DeepSeek V3.1 思考模式 - 具备思维链推理能力的高级模型',
    family: 'deepseek-v3.1',
    maxInputTokens: 128000,
    maxOutputTokens: 8192,
    version: 'deepseek-reasoner',
    capabilities: {
      toolCalling: false, 
      imageInput: false
    },
    sdkType: SDKType.OPENAI
  }
];

/**
 * DeepSeek模型供应商类
 * 继承BaseModelProvider，提供DeepSeek特定的实现
 */
export class DeepSeekChatModelProvider extends BaseModelProvider {
  static providerConfig = DEEPSEEK_PROVIDER_CONFIG;
  static models = DEEPSEEK_MODELS;

  constructor() {
    super();
  }
}