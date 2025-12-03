/*---------------------------------------------------------------------------------------------
 *  Copilot Types - @vscode/chat-lib 内部类型导入
 *  集中管理所有从 chat-lib 导入的内部类型
 *--------------------------------------------------------------------------------------------*/

// // ============================================================================
// // 从 @vscode/chat-lib 导入内部类型
// // ============================================================================

// // 网络相关类型
// export type { IFetcher } from '@vscode/chat-lib/dist/src/_internal/platform/networking/common/networking';
// export type {
//     FetchOptions,
//     PaginationOptions,
//     IAbortController,
//     IHeaders,
//     Response
// } from '@vscode/chat-lib/dist/src/_internal/platform/networking/common/fetcherService';

// // 端点相关类型
// export type {
//     IChatEndpoint,
//     IEmbeddingsEndpoint
// } from '@vscode/chat-lib/dist/src/_internal/platform/networking/common/networking';
// export type {
//     ChatEndpointFamily,
//     EmbeddingsEndpointFamily,
//     ICompletionModelInformation
// } from '@vscode/chat-lib/dist/src/_internal/platform/endpoint/common/endpointProvider';

// // 文档相关类型
// export type {
//     TextDocumentIdentifier,
//     ITextDocument
// } from '@vscode/chat-lib/dist/src/_internal/extension/completions-core/vscode-node/lib/src/textDocument';
// export type {
//     TextDocumentChangeEvent,
//     TextDocumentOpenEvent,
//     TextDocumentCloseEvent,
//     TextDocumentFocusedEvent,
//     WorkspaceFoldersChangeEvent
// } from '@vscode/chat-lib/dist/src/_internal/extension/completions-core/vscode-node/lib/src/textDocumentManager';

// // 其他类型
// export type { ChatRequest } from '@vscode/chat-lib/dist/src/_internal/vscodeTypes';
// export type { CopilotCompletion } from '@vscode/chat-lib/dist/src/_internal/extension/completions-core/vscode-node/lib/src/ghostText/copilotCompletion';

// ============================================================================
// FIM 提供商配置接口
// ============================================================================

/**
 * FIM 提供商配置接口
 */
export interface FimProviderConfig {
    /** 提供商唯一标识 */
    id: string;
    /** 显示名称 */
    name: string;
    /** API 密钥对应的 provider key */
    providerKey: string;
    /** API 基础 URL */
    baseUrl: string;
    /** API 请求路径 */
    requestPath: string;
    /** 请求发送模型 ID */
    requestModel: string;
    /** 是否支持 suffix 参数 */
    supportsSuffix: boolean;
    /** 最大 token 数量 */
    maxTokens: number;
}

/**
 * FIM 补全配置
 */
export interface FimCompletionConfig {
    /** 是否启用 FIM 补全 */
    enabled: boolean;
    /** 当前使用的提供商 ID */
    provider: string;
    /** 使用的模型 ID（可选，使用提供商默认值） */
    model?: string;
    /** 最大生成 token 数量 */
    maxTokens: number;
    /** 采样温度 */
    temperature: number;
    /** 上下文行数（光标前后各取多少行） */
    contextLines: number;
    /** 触发延迟（毫秒） */
    triggerDelay: number;
}

export interface NESCompletionConfig {
    enabled: boolean;
    debounceMs: number;
    timeoutMs: number; // 请求超时时间
    maxConcurrent: number; // 最大并发请求数
}
