/*---------------------------------------------------------------------------------------------
 *  阶跃星辰 StepFun MCP WebSearch 客户端
 *  使用官方 @modelcontextprotocol/sdk 通过 StreamableHTTP 连接阶跃星辰 MCP
 *  MCP Server: https://api.stepfun.com/step_plan/v1/mcp/web_search/mcp
 *  提供工具: web_search, web_fetch
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { Logger } from '../../utils/runtime/logger';
import { ConfigManager } from '../../utils/config/configManager';
import { ApiKeyManager } from '../../utils/config/apiKeyManager';
import { t } from '../../utils/runtime/l10n';
import { VersionManager } from '../../utils/runtime/versionManager';
import { StepFunSearchResult } from '../stepfunSearch';
import { clearMCPClientCache, getMCPClientCacheStats, clearStaleMCPInstances } from './mcpCacheHelpers';

/**
 * 搜索请求参数
 */
export interface StepFunWebSearchRequest {
    search_query: string;
    n?: number;
    category?: string;
}

/**
 * 阶跃星辰 StepFun MCP WebSearch 客户端
 */
export class StepFunMCPWebSearchClient {
    private static clientCache = new Map<string, StepFunMCPWebSearchClient>();
    private static readonly MCP_ENDPOINT = 'https://api.stepfun.com/step_plan/v1/mcp/web_search/mcp';

    private static buildCacheKey(apiKey: string): string {
        const endpoint = StepFunMCPWebSearchClient.MCP_ENDPOINT;
        const proxyUrl = ConfigManager.resolveProxyForModel(undefined, 'stepfun') || '';
        return `${apiKey}::${endpoint}::${proxyUrl}`;
    }

    private static async clearStaleInstances(apiKey: string, activeCacheKey: string): Promise<void> {
        await clearStaleMCPInstances(this.clientCache, 'StepFun MCP', apiKey, activeCacheKey);
    }

    private client: Client | null = null;
    private transport: StreamableHTTPClientTransport | null = null;
    private readonly userAgent: string;
    private currentApiKey: string | null = null;
    private isConnecting = false;
    private connectionPromise: Promise<void> | null = null;
    private activeSearchCount = 0;
    private cleanupTimer: ReturnType<typeof setTimeout> | null = null;
    private cleanupPromise: Promise<void> | null = null;

    private constructor() {
        this.userAgent = VersionManager.getUserAgent('MCPWebSearch');
    }

    static async getInstance(apiKey?: string): Promise<StepFunMCPWebSearchClient> {
        const resolvedApiKey = apiKey || (await ApiKeyManager.getApiKey('stepfun'));
        if (!resolvedApiKey) {
            throw new Error(t('StepFun API key is not configured', '阶跃星辰API密钥未设置'));
        }

        const cacheKey = this.buildCacheKey(resolvedApiKey);
        await this.clearStaleInstances(resolvedApiKey, cacheKey);

        let instance = StepFunMCPWebSearchClient.clientCache.get(cacheKey);

        if (!instance) {
            Logger.debug(
                `📦 [StepFun MCP] Creating new client instance (API key: ${resolvedApiKey.substring(0, 8)}...)`
            );
            instance = new StepFunMCPWebSearchClient();
            instance.currentApiKey = resolvedApiKey;
            StepFunMCPWebSearchClient.clientCache.set(cacheKey, instance);
        } else {
            Logger.debug(
                `♻️ [StepFun MCP] Reusing cached client instance (API key: ${resolvedApiKey.substring(0, 8)}...)`
            );
        }

        await instance.ensureConnected();

        return instance;
    }

    static async clearCache(apiKey?: string): Promise<void> {
        await clearMCPClientCache(this.clientCache, 'StepFun MCP', apiKey);
    }

    static getCacheStats(): { totalClients: number; connectedClients: number; apiKeys: string[] } {
        return getMCPClientCacheStats(this.clientCache);
    }

    isConnected(): boolean {
        return this.client !== null && this.transport !== null;
    }

    /**
     * 确保 MCP 客户端已连接
     * 取消待执行的清理，等清理完成后重新连接
     */
    private async ensureConnected(): Promise<void> {
        this.cancelPendingCleanup();

        if (this.cleanupPromise) {
            Logger.debug('⏳ [StepFun MCP] Waiting for connection cleanup to finish...');
            await this.cleanupPromise;
        }

        if (this.isConnected()) {
            Logger.debug('✅ [StepFun MCP] Client connected');
            return;
        }

        if (this.isConnecting && this.connectionPromise) {
            await this.connectionPromise;
            return;
        }

        this.isConnecting = true;
        this.connectionPromise = this.connect();

        try {
            await this.connectionPromise;
        } finally {
            this.isConnecting = false;
            this.connectionPromise = null;
        }
    }

    /**
     * 建立 MCP 连接
     */
    private async connect(): Promise<void> {
        const apiKey = this.currentApiKey;
        if (!apiKey) {
            throw new Error(t('StepFun API key is required', '需要阶跃星辰API密钥'));
        }

        try {
            Logger.debug(`🔗 [StepFun MCP] Connecting to ${StepFunMCPWebSearchClient.MCP_ENDPOINT}...`);

            this.client = new Client(
                {
                    name: 'gcmp-stepfun-mcp-web-search',
                    version: VersionManager.getVersion()
                },
                {
                    capabilities: {}
                }
            );

            this.transport = new StreamableHTTPClientTransport(new URL(StepFunMCPWebSearchClient.MCP_ENDPOINT), {
                fetch: ConfigManager.createProxyAwareFetch({ providerKey: 'stepfun' }) as typeof fetch,
                requestInit: {
                    headers: {
                        Authorization: `Bearer ${apiKey}`,
                        'User-Agent': this.userAgent
                    }
                }
            });

            await this.client.connect(this.transport);
            Logger.info('✅ [StepFun MCP] Connected using StreamableHTTP transport');
        } catch (error) {
            Logger.error('❌ [StepFun MCP] Connection failed', error instanceof Error ? error : undefined);
            this.client = null;
            this.transport = null;
            throw new Error(
                t(
                    'StepFun MCP client connection failed: {0}',
                    '阶跃星辰 MCP 客户端连接失败: {0}',
                    error instanceof Error ? error.message : 'Unknown error'
                )
            );
        }
    }

    /**
     * 执行搜索
     */
    async search(request: StepFunWebSearchRequest): Promise<StepFunSearchResult[]> {
        Logger.info(`🔍 [StepFun MCP] Starting search: "${request.search_query}"`);

        this.cancelPendingCleanup();
        this.activeSearchCount++;

        await this.ensureConnected();

        if (!this.client) {
            this.activeSearchCount = Math.max(0, this.activeSearchCount - 1);
            throw new Error(t('StepFun MCP client is not connected', '阶跃星辰MCP客户端未连接'));
        }

        try {
            const result = await this.client.callTool({
                name: 'web_search',
                arguments: {
                    query: request.search_query,
                    ...(request.n && { n: request.n }),
                    ...(request.category && { category: request.category })
                }
            });

            if (Array.isArray(result.content)) {
                const [{ text }] = result.content as { type: 'text'; text: string }[];
                if (text.startsWith('MCP error')) {
                    throw new Error(text);
                }
                try {
                    return JSON.parse(text) as StepFunSearchResult[];
                } catch {
                    return [
                        {
                            title: 'Search Result',
                            link: '',
                            content: text,
                            publish_date: new Date().toISOString()
                        }
                    ];
                }
            }

            Logger.warn('⚠️ [StepFun MCP] Search returned unexpected format');
            return [];
        } catch (error) {
            Logger.error('❌ [StepFun MCP] Search failed', error instanceof Error ? error : undefined);

            if (error instanceof Error) {
                await this.handleErrorResponse(error);
            }

            throw new Error(
                t(
                    'StepFun MCP search failed: {0}',
                    '阶跃星辰MCP搜索失败: {0}',
                    error instanceof Error ? error.message : 'Unknown error'
                )
            );
        } finally {
            this.activeSearchCount = Math.max(0, this.activeSearchCount - 1);
            this.scheduleCleanupAfterIdle();
        }
    }

    /**
     * 处理错误响应
     * 仅处理权限类错误（弹对话框 + 切换模式），其他错误不处理（交由调用方 catch 统一包装）
     */
    private async handleErrorResponse(error: Error): Promise<void> {
        const errorMessage = error.message;

        if (errorMessage.includes('403') || errorMessage.includes('permission') || errorMessage.includes('无权')) {
            Logger.warn(`⚠️ [StepFun MCP] Permission denied: ${errorMessage}`);

            const shouldDisableMCP = await this.showMCPDisableDialog();

            if (shouldDisableMCP) {
                await this.disableMCPMode();
                throw new Error(
                    t(
                        'StepFun search permission denied: MCP mode was disabled. Please retry the search.',
                        '阶跃星辰搜索权限不足：MCP模式已禁用，请重新尝试搜索。'
                    )
                );
            } else {
                throw new Error(
                    t(
                        'StepFun search permission denied: your account cannot access the web search MCP feature. Check your Step Plan subscription.',
                        '阶跃星辰搜索权限不足：您的账户无权访问联网搜索 MCP 功能。请检查您的 Step Plan 套餐订阅状态。'
                    )
                );
            }
        }
        // 非权限类错误，不 throw，交由调用方 catch 块统一包装
    }

    /**
     * 显示 MCP 禁用确认对话框
     */
    private async showMCPDisableDialog(): Promise<boolean> {
        const message = t(
            'Your StepFun account cannot access the web search MCP feature. Possible reasons:\n\n1. Your account does not have a Step Plan subscription\n2. Your API key does not have sufficient permissions\n\nSwitch to standard billing mode (per-request billing)?',
            '检测到您的阶跃星辰账户无权访问联网搜索 MCP 功能。这可能是因为：\n\n1. 您的账户没有 Step Plan 订阅\n2. API 密钥权限不足\n\n是否切换到标准计费模式（按次计费 ¥0.04/次）？'
        );
        const switchLabel = t('Switch to standard mode', '切换到标准模式');
        const keepLabel = t('Keep MCP mode', '保持MCP模式');

        const result = await vscode.window.showWarningMessage(message, { modal: true }, switchLabel, keepLabel);

        return result === switchLabel;
    }

    /**
     * 禁用 MCP 模式
     */
    private async disableMCPMode(): Promise<void> {
        try {
            const config = vscode.workspace.getConfiguration('gcmp.stepfun.search');
            await config.update('enableMCP', false, vscode.ConfigurationTarget.Global);

            Logger.info('✅ [StepFun MCP] MCP mode disabled, switched to standard billing mode');

            vscode.window.showInformationMessage(
                t(
                    'StepFun MCP mode disabled. Switched to standard billing mode (¥0.04/request).',
                    '阶跃星辰 MCP 模式已禁用，已切换到标准计费模式（¥0.04/次）。'
                )
            );
        } catch (error) {
            Logger.error('❌ [StepFun MCP] Failed to disable MCP mode', error instanceof Error ? error : undefined);
        }
    }

    /**
     * 清理连接
     */
    async cleanup(): Promise<void> {
        this.cancelPendingCleanup();
        await this.internalCleanup();
    }

    /**
     * 内部清理（关闭传输层）
     */
    private async internalCleanup(): Promise<void> {
        try {
            if (this.transport) {
                await this.transport.close();
                this.transport = null;
            }
            this.client = null;
            Logger.info('✅ [StepFun MCP] Client connection cleaned up');
        } catch (error) {
            Logger.error('❌ [StepFun MCP] Connection cleanup failed', error instanceof Error ? error : undefined);
        }
    }

    /**
     * 取消待执行的闲时清理
     */
    private cancelPendingCleanup(): void {
        if (this.cleanupTimer) {
            clearTimeout(this.cleanupTimer);
            this.cleanupTimer = null;
        }
    }

    /**
     * 搜索结束后安排闲时清理连接，减少轮询
     */
    private scheduleCleanupAfterIdle(): void {
        if (this.activeSearchCount > 0 || this.cleanupTimer || this.cleanupPromise) {
            return;
        }

        this.cleanupTimer = setTimeout(() => {
            this.cleanupTimer = null;
            void this.cleanupIfIdle();
        }, 0);
    }

    /**
     * 如果空闲则断开连接
     */
    private async cleanupIfIdle(): Promise<void> {
        if (this.activeSearchCount > 0 || this.cleanupPromise) {
            return;
        }

        this.cleanupPromise = (async () => {
            await this.internalCleanup();
            Logger.debug('🔌 [StepFun MCP] Closed connection after becoming idle');
        })().finally(() => {
            this.cleanupPromise = null;
        });

        await this.cleanupPromise;
    }
}
