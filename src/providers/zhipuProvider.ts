import * as vscode from "vscode";
import { BaseModelProvider } from "./baseProvider";
import { ProviderConfig, SDKType } from "../types/sharedTypes";

/**
 * 智谱AI供应商配置
 */
const ZHIPU_PROVIDER_CONFIG: ProviderConfig = {
  name: 'zhipu',
  displayName: '智谱AI',
  apiKeyTemplate: 'xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx.xxxxxxxxxxxxxxxx',
  openAiUrl: 'https://open.bigmodel.cn/api/paas/v4',
  anthropicUrl: 'https://open.bigmodel.cn/api/anthropic'
};

/**
 * 智谱AI模型定义
 * 直接使用原生LanguageModelChatInformation，只通过module augmentation添加sdkType
 */
const ZHIPU_MODELS: vscode.LanguageModelChatInformation[] = [
  // 使用Claude SDK代理的模型
  {
    id: 'glm-4.5',
    name: 'GLM-4.5 (订阅)',
    tooltip: 'ZHIPU GLM-4.5 - 最强大的推理模型，3550亿参数，专为复杂推理任务优化 (ANTHROPIC SDK)',
    family: 'glm-4.5',
    maxInputTokens: 128000,
    maxOutputTokens: 96000,
    version: "glm-4.5",
    capabilities: {
      toolCalling: true,
      imageInput: false
    },
    sdkType: SDKType.ANTHROPIC
  },
  {
    id: 'glm-4.5-air',
    name: 'GLM-4.5-Air (订阅)',
    tooltip: 'ZHIPU GLM-4.5-Air - 高性价比模型，轻量级设计，强性能表现 (ANTHROPIC SDK)',
    family: 'glm-4.5',
    maxInputTokens: 128000,
    maxOutputTokens: 96000,
    version: "glm-4.5-air",
    capabilities: {
      toolCalling: true,
      imageInput: false
    },
    sdkType: SDKType.ANTHROPIC
  },
  // 使用OpenAI SDK代理的模型
  {
    id: 'glm-4.5-x',
    name: 'GLM-4.5-X (极速)',
    tooltip: 'ZHIPU GLM-4.5-X - 高性能模型，强推理能力，极速响应 (OPENAI SDK)',
    family: 'glm-4.5',
    maxInputTokens: 128000,
    maxOutputTokens: 96000,
    version: "glm-4.5-x",
    capabilities: {
      toolCalling: true,
      imageInput: false
    },
    sdkType: SDKType.OPENAI
  },
  {
    id: 'glm-4.5-airx',
    name: 'GLM-4.5-AirX (极速)',
    tooltip: 'ZHIPU GLM-4.5-AirX - 轻量级高性能，强性能，极速响应 (OPENAI SDK)',
    family: 'glm-4.5',
    maxInputTokens: 128000,
    maxOutputTokens: 96000,
    version: "glm-4.5-airx",
    capabilities: {
      toolCalling: true,
      imageInput: false
    },
    sdkType: SDKType.OPENAI
  },
  {
    id: 'glm-4.5-flash',
    name: 'GLM-4.5-Flash (免费)',
    tooltip: 'ZHIPU GLM-4.5-Flash - 免费模型，高效多功能，快速响应 (OPENAI SDK)',
    family: 'glm-4.5',
    maxInputTokens: 128000,
    maxOutputTokens: 96000,
    version: "glm-4.5",
    capabilities: {
      toolCalling: true,
      imageInput: false
    },
    sdkType: SDKType.OPENAI
  },
  {
    id: 'glm-4.5v',
    name: 'GLM-4.5V (视觉)',
    tooltip: 'ZHIPU GLM-4.5V - 旗舰视觉推理模型，106B参数，支持视频/图像/文档理解 (OPENAI SDK)',
    family: 'glm-4.5v',
    maxInputTokens: 64000,
    maxOutputTokens: 96000,
    version: "glm-4.5v",
    capabilities: {
      toolCalling: true,
      imageInput: true
    },
    sdkType: SDKType.OPENAI
  }
];

/**
 * 智谱AI模型供应商类
 * 继承BaseModelProvider，提供智谱AI特定的实现
 */
export class ZhipuChatModelProvider extends BaseModelProvider {
  static providerConfig = ZHIPU_PROVIDER_CONFIG;
  static models = ZHIPU_MODELS;

  constructor() {
    super();
  }
}