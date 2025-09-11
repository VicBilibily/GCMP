import * as vscode from "vscode";
import { BaseModelProvider } from "./baseProvider";
import { ProviderConfig, SDKType } from "../types/sharedTypes";

/**
 * 魔搭社区供应商配置
 */
const MODELSCOPE_PROVIDER_CONFIG: ProviderConfig = {
  name: "modelscope",
  displayName: "魔搭社区",
  apiKeyTemplate: "ms-xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx",
  openAiUrl: "https://api-inference.modelscope.cn/v1",
  // anthropicUrl: "https://api-inference.modelscope.cn" (暂不调用Anthropic)
};

/**
 * 魔搭社区模型定义
 * 基于最新的魔搭社区模型配置，只列举Qwen3系列
 */
const MODELSCOPE_MODELS: vscode.LanguageModelChatInformation[] = [
  // Qwen3 系列 - 235B 指令模型
  {
    id: 'qwen/Qwen3-235B-A22B-Instruct-2507',
    name: 'Qwen3-235B-A22B-Instruct-2507',
    tooltip: 'MODELSCOPE Qwen3 235B A22B Instruct 2507 - 阿里巴巴最新一代大模型',
    family: 'qwen3',
    maxInputTokens: 131072,
    maxOutputTokens: 8192,
    version: 'qwen3-235b-a22b-instruct-2507',
    capabilities: {
      toolCalling: true,
      imageInput: false
    },
    sdkType: SDKType.OPENAI
  },
  // Qwen3 系列 - 30B 指令模型
  {
    id: 'qwen/Qwen3-30B-A3B-Instruct-2507',
    name: 'Qwen3-30B-A3B-Instruct-2507',
    tooltip: 'MODELSCOPE Qwen3 30B A3B Instruct 2507 - 高效轻量级',
    family: 'qwen3',
    maxInputTokens: 32768,
    maxOutputTokens: 4096,
    version: 'qwen3-30b-a3b-instruct-2507',
    capabilities: {
      toolCalling: true,
      imageInput: false
    },
    sdkType: SDKType.OPENAI
  },
  // Qwen3-Coder 系列 - 480B 代码模型
  {
    id: 'qwen/Qwen3-Coder-480B-A35B-Instruct',
    name: 'Qwen3-Coder-480B-A35B-Instruct',
    tooltip: 'MODELSCOPE Qwen3 Coder 480B A35B Instruct - 专业代码生成和推理',
    family: 'qwen3-coder',
    maxInputTokens: 131072,
    maxOutputTokens: 8192,
    version: 'qwen3-coder-480b-a35b-instruct',
    capabilities: {
      toolCalling: true,
      imageInput: false
    },
    sdkType: SDKType.OPENAI
  },
  // Qwen3-Coder 系列 - 30B 代码模型
  {
    id: 'qwen/Qwen3-Coder-30B-A3B-Instruct',
    name: 'Qwen3-Coder-30B-A3B-Instruct',
    tooltip: 'MODELSCOPE Qwen3 Coder 30B A3B Instruct - 代码生成和推理',
    family: 'qwen3-coder',
    maxInputTokens: 32768,
    maxOutputTokens: 4096,
    version: 'qwen3-coder-30b-a3b-instruct',
    capabilities: {
      toolCalling: true,
      imageInput: false
    },
    sdkType: SDKType.OPENAI
  }
];

/**
 * 魔搭社区模型供应商类
 * 继承BaseModelProvider，提供魔搭社区特定的实现
 */
export class ModelscopeChatModelProvider extends BaseModelProvider {
  static providerConfig = MODELSCOPE_PROVIDER_CONFIG;
  static models = MODELSCOPE_MODELS;

  constructor() {
    super();
  }
}
