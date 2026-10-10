/*---------------------------------------------------------------------------------------------
 *  类型定义 - FIM/NES 补全扩展
 *
 *  补全配置由本扩展读取，共享服务通过主扩展 exports 注入。
 *--------------------------------------------------------------------------------------------*/

// ========================================================================
// FIM / NES 配置
// ========================================================================

/** FIM / NES 模型配置 */
export interface CompletionModelConfig {
    provider: string;
    baseUrl: string;
    proxy?: string;
    model: string;
    maxTokens: number;
    extraBody?: Record<string, unknown>;
}

/** NES 补全配置 */
export interface NESCompletionConfig {
    enabled: boolean;
    debounceMs: number;
    /** 请求超时时间 */
    timeoutMs: number;
    /** 仅手动触发模式 */
    manualOnly: boolean;
    modelConfig: CompletionModelConfig;
}

export type FIMCompletionConfig = Omit<NESCompletionConfig, 'manualOnly'>;

// ========================================================================
// 主扩展服务接口
// ========================================================================

/** 对齐主扩展 ApiKeyManager.getApiKey */
export interface ApiKeyManagerLike {
    getApiKey(provider: string): Promise<string | undefined>;
}

/** 代理感知请求选项（对齐主扩展 ProxyFetchOptions） */
export interface ProxyFetchOptionsLike {
    modelConfig?: { id?: string; model?: string; proxy?: string; provider?: string };
    providerKey?: string;
    proxyUrl?: string;
    /** 跳过 HAR 记录。FIM/NES 补全等高频请求应设为 true */
    skipHar?: boolean;
}

/** 主扩展共享的代理请求能力 */
export interface ConfigManagerLike {
    fetchWithProxy(
        input: string | URL | Request,
        init?: RequestInit,
        options?: ProxyFetchOptionsLike
    ): Promise<Response>;
}

/** 主扩展 activate() exports 注入给本扩展的补全服务集合（日志通道由本扩展自建，见 completionLogger.ts） */
export interface GcmpCompletionServices {
    ApiKeyManager: ApiKeyManagerLike;
    ConfigManager: ConfigManagerLike;
    /** 关闭主扩展共享的 ProxyAgent 连接池 */
    closeProxyAgents(): Promise<void>;
    getAvailableProviders(): { providerIds: string[]; enumDescriptions: string[] };
}
