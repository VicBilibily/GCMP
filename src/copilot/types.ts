// ============================================================================
// NES 配置接口
// ============================================================================

/**
 * 提供商配置接口
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
 * NES 补全配置
 */
export interface NESCompletionConfig {
    enabled: boolean;
    debounceMs: number;
    timeoutMs: number; // 请求超时时间
    maxConcurrent: number; // 最大并发请求数
}
