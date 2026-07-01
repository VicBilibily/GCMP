/**
 * Model Editor WebView 类型定义
 *
 * 前后端通过 discriminated union 的消息协议通信。
 * 后端（VS Code 侧）→ HostMessage；前端（webview 侧）→ WebViewMessage。
 */

import type { CompatibleModelConfig } from '../../utils/compatibleModelManager';

/**
 * SDK 兼容模式（与 CompatibleModelConfig.sdkMode 保持一致）
 */
export type SdkMode = NonNullable<CompatibleModelConfig['sdkMode']>;

/**
 * 推理强度选项（与 CompatibleModelConfig.reasoningEffort 元素一致）
 */
export type ReasoningEffort = NonNullable<CompatibleModelConfig['reasoningEffort']>[number];

/**
 * 前端使用的扁平化模型数据
 *
 * 说明：旧 modelEditor.js 将 `capabilities.toolCalling/imageInput` 拍平到顶层，
 * 且把 `customHeader` / `extraBody` 序列化为 JSON 字符串便于 textarea 编辑。
 * 此结构用于前后端传输；保存时由前端组装回 CompatibleModelConfig。
 */
export interface ModelFormData {
    id: string;
    name: string;
    provider: string;
    tooltip: string;
    baseUrl: string;
    endpoint: string;
    modelsEndpoint: string;
    proxy: string;
    apiKey: string;
    model: string;
    sdkMode: SdkMode;
    maxInputTokens: number;
    maxOutputTokens: number;
    toolCalling: boolean;
    imageInput: boolean;
    useInstructions: boolean | undefined;
    webSearchTool: boolean | undefined;
    reasoningEffort: ReasoningEffort[];
    reasoningDefault: ReasoningEffort | '';
    customHeader: string; // JSON 字符串
    extraBody: string; // JSON 字符串
}

/**
 * 提供商下拉项
 */
export interface ProviderOption {
    id: string;
    name: string;
    /** 已知提供商的默认 baseUrl；选中该提供商且 BASE URL 为空时自动回填 */
    defaultBaseUrl?: string;
}

/**
 * 初始化时由后端注入 webview 的数据
 */
export interface InitialState {
    /** 原始模型数据（已拍平为 ModelFormData） */
    model: ModelFormData;
    /** 是否为创建模式 */
    isCreateMode: boolean;
    /** 当前 locale（如 'zh-cn' / 'en'），供前端 l10n 判定 */
    locale: string;
}

/**
 * 后端 → 前端 消息
 */
export type HostMessage =
    | { command: 'setProviders'; providers: ProviderOption[] }
    | { command: 'modelsLoading' }
    | { command: 'modelsLoaded'; models: string[] }
    | { command: 'modelsError'; error: string };

/**
 * 前端 → 后端 消息
 */
export type WebViewMessage =
    | { command: 'ready' }
    | { command: 'getProviders' }
    | {
          command: 'fetchModels';
          baseUrl: string;
          modelsEndpoint: string;
          apiKey: string;
          provider: string;
          proxy: string;
      }
    | { command: 'save'; model: ModelFormData }
    | { command: 'delete'; modelId: string; modelName: string }
    | { command: 'cancel' };

/**
 * CLI 专用的提供商 ID，禁止在通用配置中使用（与旧 modelEditor.js 保持一致）
 */
export const CLI_RESERVED_PROVIDERS = ['codex', 'gemini', 'grok'] as const;

/**
 * 模型列表端点（modelsEndpoint）常见预设值
 *
 * baseUrl 通常已含版本前缀（如 https://api.openai.com/v1），因此多数 provider 用相对路径 /models 即可。
 * 列表用于"获取模型"按钮的下拉快捷选项。
 */
export const MODELS_ENDPOINT_PRESETS: string[] = [
    '/models',
    '/v1/models',
    '/v4/models',
    '/api/v1/models',
    '/openai/v1/models'
];

/**
 * 推理强度可选项（与旧 modelEditor.js 保持一致）
 */
export const REASONING_EFFORT_OPTIONS: { value: ReasoningEffort; label: string }[] = [
    { value: 'none', label: 'None' },
    { value: 'minimal', label: 'Minimal' },
    { value: 'low', label: 'Low' },
    { value: 'medium', label: 'Medium' },
    { value: 'high', label: 'High' },
    { value: 'xhigh', label: 'XHigh' },
    { value: 'max', label: 'Max' }
];

/**
 * SDK 模式可选项（与旧 modelEditor.js 保持一致）
 */
export const SDK_MODE_OPTIONS: { value: SdkMode; labelEn: string; labelZh: string }[] = [
    {
        value: 'openai',
        labelEn: 'OpenAI SDK (uses the official SDK for streaming responses)',
        labelZh: 'OpenAI SDK (使用官方SDK进行流式传输数据处理)'
    },
    {
        value: 'openai-sse',
        labelEn: 'OpenAI SSE (uses the built-in compatible parser for streaming responses)',
        labelZh: 'OpenAI SSE (使用内置兼容解析进行流式传输数据处理)'
    },
    {
        value: 'openai-responses',
        labelEn: 'OpenAI Responses (experimental; uses the Responses API for request and response handling)',
        labelZh: 'OpenAI Responses (实验性支持，使用 Responses API 进行请求响应处理)'
    },
    {
        value: 'anthropic',
        labelEn: 'Anthropic SDK (uses the official SDK for streaming responses)',
        labelZh: 'Anthropic SDK (使用官方SDK进行流式传输数据处理)'
    },
    {
        value: 'gemini-sse',
        labelEn:
            'Gemini HTTP SSE (experimental; uses the built-in compatible parser for streaming responses and works with third-party gateways)',
        labelZh: 'Gemini HTTP SSE (实验性支持，使用内置兼容解析进行流式传输数据处理，兼容第三方网关)'
    }
];
