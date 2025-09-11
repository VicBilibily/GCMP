import * as vscode from "vscode";
import { BaseModelProvider } from "./baseProvider";
import { ProviderConfig, SDKType } from "../types/sharedTypes";

/**
 * iFlow供应商配置
 */
const IFLOW_PROVIDER_CONFIG: ProviderConfig = {
  name: "iflow",
  displayName: "iFlow心流",
  apiKeyTemplate: "sk-xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx",
  openAiUrl: "https://apis.iflow.cn/v1",
  // anthropicUrl: 不支持 Anthropic SDK
};

/**
 * iFlow模型定义
 * 基于iFlow心流平台官方API模型配置
 */
const IFLOW_MODELS: vscode.LanguageModelChatInformation[] = [
  // Qwen3-Max-Preview 🔥 最新预览版模型
  {
    id: 'qwen3-max-preview',
    name: 'Qwen3-Max-Preview (iFlow)',
    tooltip: 'iFlow Qwen3-Max-Preview - 通义千问3系列Max模型Preview版本，整体通用能力大幅提升，知识幻觉更少',
    family: 'qwen3-max',
    maxInputTokens: 256000,
    maxOutputTokens: 64000,
    version: 'qwen3-max-preview',
    capabilities: {
      toolCalling: true,
      imageInput: false
    },
    sdkType: SDKType.OPENAI
  },
  // Qwen3-Coder 代码模型
  {
    id: 'qwen3-coder',
    name: 'Qwen3-Coder-480B-A35B (iFlow)',
    tooltip: 'iFlow Qwen3-Coder-480B-A35B - 专业代码生成和推理模型',
    family: 'qwen',
    maxInputTokens: 256000,
    maxOutputTokens: 64000,
    version: 'qwen3-coder',
    capabilities: {
      toolCalling: true,
      imageInput: false
    },
    sdkType: SDKType.OPENAI
  },
  // GLM-4.5 多模态模型
  {
    id: 'glm-4.5',
    name: 'GLM-4.5 (iFlow)',
    tooltip: 'iFlow GLM-4.5 - 智谱AI多模态模型，支持图像理解',
    family: 'glm',
    maxInputTokens: 128000,
    maxOutputTokens: 64000,
    version: 'glm-4.5',
    capabilities: {
      toolCalling: true,
      imageInput: true
    },
    sdkType: SDKType.OPENAI
  },
  // Kimi-K2 对话模型
  {
    id: 'kimi-k2',
    name: 'Kimi-K2 (iFlow)',
    tooltip: 'iFlow Kimi-K2 - 月之暗面K2模型，强大的对话理解能力',
    family: 'kimi',
    maxInputTokens: 128000,
    maxOutputTokens: 64000,
    version: 'kimi-k2',
    capabilities: {
      toolCalling: true,
      imageInput: false
    },
    sdkType: SDKType.OPENAI
  },
  // Kimi-K2-0905 开源万亿参数MoE模型
  {
    id: 'kimi-k2-0905',
    name: 'Kimi-K2-Instruct-0905 (iFlow)',
    tooltip: 'iFlow Kimi-K2-Instruct-0905 - 月之暗面开源万亿参数MoE模型，320亿激活参数，卓越编码智能与工具调用能力',
    family: 'kimi',
    maxInputTokens: 256000,
    maxOutputTokens: 64000,
    version: 'kimi-k2-0905',
    capabilities: {
      toolCalling: true,
      imageInput: false
    },
    sdkType: SDKType.OPENAI
  },
  // DeepSeek-V3.1 推理模型
  {
    id: 'deepseek-v3.1',
    name: 'DeepSeek-V3.1 (iFlow)',
    tooltip: 'iFlow DeepSeek-V3.1 - 深度求索V3.1模型，强大的推理能力',
    family: 'deepseek',
    maxInputTokens: 128000,
    maxOutputTokens: 64000,
    version: 'deepseek-v3.1',
    capabilities: {
      toolCalling: true,
      imageInput: false
    },
    sdkType: SDKType.OPENAI
  }
];

/**
 * iFlow模型供应商类
 * 继承BaseModelProvider，提供iFlow特定的实现
 */
export class IFlowChatModelProvider extends BaseModelProvider {
  static providerConfig = IFLOW_PROVIDER_CONFIG;
  static models = IFLOW_MODELS;

  constructor() {
    super();
  }
}