/*---------------------------------------------------------------------------------------------
 *  CLI 认证类型定义
 *  定义 CLI 认证相关的接口和类型
 *--------------------------------------------------------------------------------------------*/

/**
 * OAuth 凭证接口
 */
export interface OAuthCredentials {
    access_token: string;
    refresh_token: string;
    expiry_date: number;
}

/**
 * CLI 认证配置
 */
export interface CliAuthConfig {
    /** 提供商名称 */
    name: string;
    /** OAuth 客户端 ID */
    clientId: string;
    /** OAuth 客户端密钥（用于 refresh_token 刷新） */
    clientSecret?: string;
    /** OAuth 令牌端点 */
    tokenUrl: string;
    /** 凭证文件路径模式 */
    credentialPathPattern: string;
    /** CLI 命令名称 */
    cliCommand: string;
}
