/*---------------------------------------------------------------------------------------------
 *  智谱AI SSE客户端 - 支持连接复用和并发控制
 *  注意：SSE通讯模式需要订阅智谱AI套餐后才能免费调用
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import * as https from 'https';
import { IncomingMessage, ClientRequest } from 'http';
import { Logger } from '../utils';
import { ApiKeyManager } from '../utils/apiKeyManager';
import { VersionManager } from '../utils/versionManager';

/**
 * SSE事件接口
 */
interface SSEEvent {
    id?: string;
    event?: string;
    data?: string;
}

/**
 * JSON-RPC请求接口
 */
interface JSONRPCRequest {
    jsonrpc: '2.0';
    id: string | number;
    method: string;
    params?: Record<string, unknown>;
}

/**
 * 连接状态枚举
 */
enum ConnectionState {
    DISCONNECTED = 'disconnected',
    CONNECTING = 'connecting',
    CONNECTED = 'connected',
    ERROR = 'error'
}

/**
 * 搜索请求队列项
 */
interface SearchRequest {
    id: string;
    query: string;
    options: SearchOptions;
    resolve: (result: string) => void;
    reject: (error: Error) => void;
    timestamp: number;
}

/**
 * 搜索选项接口
 */
interface SearchOptions {
    count?: number;
    domainFilter?: string;
    recencyFilter?: string;
    contentSize?: string;
}

/**
 * 智谱AI SSE客户端 - 支持连接复用
 */
export class ZhipuSSEClient {
    private readonly sseEndpoint = 'https://open.bigmodel.cn/api/mcp/web_search_prime/sse';
    private readonly userAgent: string;
    private readonly defaultTimeout = 60000;
    private readonly connectionTimeout = 30000;
    private readonly maxRetries = 3;

    // 连接状态管理
    private connectionState = ConnectionState.DISCONNECTED;
    private currentConnection: ClientRequest | null = null;
    private currentResponse: IncomingMessage | null = null;
    private messageEndpoint = '';
    private sessionId = '';
    private currentApiKey = '';
    private isInitialized = false; // 跟踪是否已完成MCP初始化

    // 请求管理
    private currentRequestId = 1;
    private searchQueue: SearchRequest[] = [];
    private pendingSearches = new Map<string, SearchRequest>();
    private isProcessingQueue = false; // 队列处理锁
    private currentSearchId: string | null = null; // 当前处理的搜索ID

    // 心跳和重连
    private heartbeatTimer: NodeJS.Timeout | null = null;
    private reconnectTimer: NodeJS.Timeout | null = null;
    private retryCount = 0;

    constructor() {
        this.userAgent = VersionManager.getUserAgent('ZhipuSSE');
    }

    /**
     * 检查是否可用
     */
    async isEnabled(): Promise<boolean> {
        const apiKey = await ApiKeyManager.getApiKey('zhipu');
        return !!apiKey;
    }

    /**
     * 执行搜索 - 支持连接复用
     */
    async search(query: string, options: SearchOptions = {}): Promise<string> {
        Logger.info(`🔄 [智谱SSE] 开始搜索: "${query}"`);

        const apiKey = await ApiKeyManager.getApiKey('zhipu');
        if (!apiKey) {
            throw new Error('智谱AI API密钥未设置');
        }

        // 检查API密钥是否变更
        if (this.currentApiKey !== apiKey) {
            Logger.debug('🔑 [智谱SSE] API密钥变更，重置连接');
            await this.disconnect();
            this.currentApiKey = apiKey;
        }

        return new Promise<string>((resolve, reject) => {
            const searchRequest: SearchRequest = {
                id: `search_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
                query,
                options,
                resolve,
                reject,
                timestamp: Date.now()
            };

            // 添加到队列
            this.searchQueue.push(searchRequest);
            this.pendingSearches.set(searchRequest.id, searchRequest);

            // 设置超时
            setTimeout(() => {
                if (this.pendingSearches.has(searchRequest.id)) {
                    this.pendingSearches.delete(searchRequest.id);
                    reject(new Error('搜索超时'));
                }
            }, this.defaultTimeout);

            // 处理连接和搜索
            this.processSearchQueue();
        });
    }

    /**
     * 处理搜索队列 - 确保顺序处理，防止并发竞争
     */
    private async processSearchQueue(): Promise<void> {
        // 防止重复处理
        if (this.isProcessingQueue) {
            Logger.debug('🔒 [智谱SSE] 队列正在处理中，跳过');
            return;
        }

        if (this.searchQueue.length === 0) {
            return;
        }

        this.isProcessingQueue = true;
        Logger.debug(`📦 [智谱SSE] 开始处理搜索队列，待处理: ${this.searchQueue.length}个请求`);

        try {
            // 确保连接状态
            await this.ensureConnection();

            // 顺序处理队列中的请求
            while (this.searchQueue.length > 0 && this.connectionState === ConnectionState.CONNECTED) {
                const searchRequest = this.searchQueue.shift();
                if (searchRequest && this.pendingSearches.has(searchRequest.id)) {
                    this.currentSearchId = searchRequest.id;
                    Logger.debug(`🎯 [智谱SSE] 开始处理搜索: ${searchRequest.query} (ID: ${searchRequest.id})`);

                    try {
                        await this.executeSearch(searchRequest);
                        // 等待当前搜索完成或超时
                        await this.waitForSearchCompletion(searchRequest.id);
                    } catch (error) {
                        Logger.error(
                            `❌ [智谱SSE] 搜索处理失败: ${searchRequest.query}`,
                            error instanceof Error ? error : undefined
                        );
                        if (this.pendingSearches.has(searchRequest.id)) {
                            this.pendingSearches.delete(searchRequest.id);
                            searchRequest.reject(error instanceof Error ? error : new Error(String(error)));
                        }
                    } finally {
                        this.currentSearchId = null;
                    }
                }
            }
        } catch (error) {
            Logger.error('❌ [智谱SSE] 队列处理错误', error instanceof Error ? error : undefined);
        } finally {
            this.isProcessingQueue = false;
            Logger.debug('✅ [智谱SSE] 队列处理完成');

            // 如果还有新的请求，继续处理
            if (this.searchQueue.length > 0) {
                setImmediate(() => this.processSearchQueue());
            }
        }
    }

    /**
     * 等待搜索完成
     */
    private async waitForSearchCompletion(searchId: string): Promise<void> {
        const maxWaitTime = this.defaultTimeout;
        const checkInterval = 100;
        const startTime = Date.now();

        while (this.pendingSearches.has(searchId) && Date.now() - startTime < maxWaitTime) {
            await new Promise(resolve => setTimeout(resolve, checkInterval));
        }

        if (this.pendingSearches.has(searchId)) {
            Logger.debug(`⏰ [智谱SSE] 搜索超时: ${searchId}`);
            this.pendingSearches.delete(searchId);
        }
    }

    /**
     * 确保连接状态
     */
    private async ensureConnection(): Promise<void> {
        if (this.connectionState === ConnectionState.CONNECTED && this.messageEndpoint) {
            Logger.debug('✅ [智谱SSE] 使用现有连接');
            return;
        }

        if (this.connectionState === ConnectionState.CONNECTING) {
            Logger.debug('⏳ [智谱SSE] 等待连接建立');
            // 等待连接建立或超时
            const startTime = Date.now();
            while (
                this.connectionState === ConnectionState.CONNECTING &&
                Date.now() - startTime < this.connectionTimeout
            ) {
                await new Promise(resolve => setTimeout(resolve, 100));
            }
            return;
        }

        // 建立新连接
        await this.connect();
    }

    /**
     * 建立 SSE 连接 - 支持连接复用
     */
    private async connect(): Promise<void> {
        if (this.connectionState === ConnectionState.CONNECTING) {
            return;
        }

        this.connectionState = ConnectionState.CONNECTING;
        Logger.info('🔗 [智谱SSE] 建立连接...');

        return new Promise((resolve, reject) => {
            const timeout = setTimeout(() => {
                this.connectionState = ConnectionState.ERROR;
                reject(new Error('连接超时'));
            }, this.connectionTimeout);

            try {
                const sseUrl = `${this.sseEndpoint}?Authorization=${this.currentApiKey}`;
                this.establishSSEConnection(
                    sseUrl,
                    () => {
                        clearTimeout(timeout);
                        this.connectionState = ConnectionState.CONNECTED;
                        this.retryCount = 0;
                        this.startHeartbeat();
                        Logger.info('✅ [智谱SSE] 连接建立成功');
                        resolve();
                    },
                    (error: Error) => {
                        clearTimeout(timeout);
                        this.connectionState = ConnectionState.ERROR;
                        Logger.error('❌ [智谱SSE] 连接失败', error);
                        this.scheduleReconnect();
                        reject(error);
                    }
                );
            } catch (error) {
                clearTimeout(timeout);
                this.connectionState = ConnectionState.ERROR;
                reject(error instanceof Error ? error : new Error(String(error)));
            }
        });
    }

    /**
     * 建立持久 SSE 连接
     */
    private establishSSEConnection(sseUrl: string, onConnected: () => void, onError: (error: Error) => void): void {
        const urlObj = new URL(sseUrl);

        const requestOptions = {
            hostname: urlObj.hostname,
            port: urlObj.port || 443,
            path: urlObj.pathname + urlObj.search,
            method: 'GET',
            headers: {
                Accept: 'text/event-stream',
                'Cache-Control': 'no-cache',
                Connection: 'keep-alive',
                'User-Agent': this.userAgent
            }
        };

        Logger.debug(`🔗 [智谱SSE] 建立SSE连接: ${sseUrl.replace(/Authorization=[^&]+/, 'Authorization=***')}`);

        const req = https.request(requestOptions, res => {
            if (res.statusCode !== 200) {
                onError(new Error(`SSE连接失败: ${res.statusCode}`));
                return;
            }

            this.currentConnection = req;
            this.currentResponse = res;

            let buffer = '';
            let endpointReceived = false;

            res.on('data', chunk => {
                buffer += chunk.toString();
                const events = this.parseSSEEvents(buffer);

                for (const event of events) {
                    if (event.event === 'endpoint' && event.data && !endpointReceived) {
                        endpointReceived = true;
                        this.messageEndpoint = `${urlObj.protocol}//${urlObj.hostname}${event.data}`;

                        const sessionIdMatch = event.data.match(/sessionId=([^&]+)/);
                        if (sessionIdMatch) {
                            this.sessionId = sessionIdMatch[1];
                            Logger.debug(`✅ [智谱SSE] 获取端点: ${this.messageEndpoint}`);
                            Logger.debug(`🎫 [智谱SSE] 会话ID: ${this.sessionId}`);

                            // 连接建立后立即进行MCP初始化
                            this.initializeMCPProtocol()
                                .then(() => {
                                    this.isInitialized = true;
                                    onConnected();
                                })
                                .catch(onError);
                        } else {
                            onError(new Error('未能从端点中提取sessionId'));
                            return;
                        }
                    } else if (event.data && endpointReceived) {
                        // 处理搜索结果响应
                        this.handleSearchResponse(event.data);
                    }
                }

                // 清理缓冲区
                const lastEventIndex = buffer.lastIndexOf('\n\n');
                if (lastEventIndex !== -1) {
                    buffer = buffer.substring(lastEventIndex + 2);
                }
            });

            res.on('end', () => {
                Logger.debug('🔚 [智谱SSE] 连接结束');
                this.connectionState = ConnectionState.DISCONNECTED;
                this.cleanup();
            });

            res.on('error', error => {
                Logger.error('❌ [智谱SSE] 响应错误', error);
                this.connectionState = ConnectionState.ERROR;
                onError(error);
            });
        });

        req.on('error', error => {
            Logger.error('❌ [智谱SSE] 请求错误', error);
            this.connectionState = ConnectionState.ERROR;
            onError(error);
        });

        req.end();
    }

    /**
     * 初始化MCP协议 - 只在连接建立时执行一次
     */
    private async initializeMCPProtocol(): Promise<void> {
        if (!this.messageEndpoint) {
            throw new Error('消息端点未就绪');
        }

        Logger.debug('� [智谱SSE] 开始MCP协议初始化');

        // MCP协议初始化序列
        const initRequests = [
            // 1. Initialize
            {
                jsonrpc: '2.0',
                id: 0,
                method: 'initialize',
                params: {
                    protocolVersion: '2025-03-26',
                    capabilities: {},
                    clientInfo: VersionManager.getClientInfo()
                }
            },
            // 2. Initialized notification
            {
                jsonrpc: '2.0',
                method: 'notifications/initialized'
            },
            // 3. Tools/list
            {
                jsonrpc: '2.0',
                id: 1,
                method: 'tools/list'
            },
            // 4. Resources/list
            {
                jsonrpc: '2.0',
                id: 2,
                method: 'resources/list'
            },
            // 5. Resources/templates/list
            {
                jsonrpc: '2.0',
                id: 3,
                method: 'resources/templates/list'
            }
        ];

        // 依次发送初始化请求
        for (let i = 0; i < initRequests.length; i++) {
            const request = initRequests[i];
            await this.sendMessage(this.messageEndpoint, request as JSONRPCRequest);
            Logger.debug(`✅ [智谱SSE] 初始化请求${i + 1}/${initRequests.length}发送完成`);

            // 请求间短暂延迟
            if (i < initRequests.length - 1) {
                await new Promise(resolve => setTimeout(resolve, 50));
            }
        }

        Logger.info('🎯 [智谱SSE] MCP协议初始化完成');
    }

    /**
     * 发送搜索工具调用 - 直接发送工具调用，不重复初始化
     */
    private async sendSearchToolCall(
        query: string,
        options: { count?: number; domainFilter?: string; recencyFilter?: string; contentSize?: string }
    ): Promise<void> {
        if (!this.messageEndpoint) {
            throw new Error('消息端点未就绪');
        }

        if (!this.isInitialized) {
            throw new Error('MCP协议未初始化');
        }

        Logger.debug(`🎯 [智谱SSE] 发送搜索工具调用: ${query}`);

        // 直接发送工具调用请求
        const toolCallRequest = {
            jsonrpc: '2.0',
            id: this.currentRequestId++,
            method: 'tools/call',
            params: {
                name: 'webSearchPrime',
                arguments: {
                    search_query: query,
                    count: options.count || 10,
                    search_domain_filter: options.domainFilter,
                    search_recency_filter: options.recencyFilter || 'noLimit',
                    content_size: options.contentSize || 'medium'
                }
            }
        };

        await this.sendMessage(this.messageEndpoint, toolCallRequest);
        Logger.debug('✅ [智谱SSE] 搜索工具调用发送完成');
    }

    /**
     * 发送单个消息
     */
    private async sendMessage(
        url: string,
        request: JSONRPCRequest | { jsonrpc: string; method: string }
    ): Promise<void> {
        return new Promise((resolve, reject) => {
            const urlObj = new URL(url);
            const requestData = JSON.stringify(request);

            const options = {
                hostname: urlObj.hostname,
                port: urlObj.port || 443,
                path: urlObj.pathname + urlObj.search,
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Content-Length': Buffer.byteLength(requestData),
                    'User-Agent': this.userAgent
                }
            };

            const req = https.request(options, res => {
                // 消耗响应数据但不存储（避免内存泄漏）
                res.on('data', () => {
                    // 数据已接收
                });

                res.on('end', () => {
                    // 根据原本的实现，消息发送成功后直接resolve
                    resolve();
                });

                res.on('error', reject);
            });

            req.on('error', reject);
            req.write(requestData);
            req.end();
        });
    }

    /**
     * 解析SSE事件
     */
    private parseSSEEvents(data: string): SSEEvent[] {
        const events: SSEEvent[] = [];
        const lines = data.split('\n');
        let currentEvent: SSEEvent = {};

        for (const line of lines) {
            const trimmedLine = line.trim();

            if (trimmedLine.startsWith(':')) {
                continue;
            }

            if (trimmedLine === '') {
                if (Object.keys(currentEvent).length > 0) {
                    events.push({ ...currentEvent });
                    currentEvent = {};
                }
                continue;
            }

            const colonIndex = trimmedLine.indexOf(':');
            if (colonIndex === -1) {
                continue;
            }

            const field = trimmedLine.substring(0, colonIndex).trim();
            const value = trimmedLine.substring(colonIndex + 1).trim();

            switch (field) {
                case 'id':
                    currentEvent.id = value;
                    break;
                case 'event':
                    currentEvent.event = value;
                    break;
                case 'data':
                    currentEvent.data = currentEvent.data ? currentEvent.data + '\n' + value : value;
                    break;
            }
        }

        if (Object.keys(currentEvent).length > 0) {
            events.push({ ...currentEvent });
        }

        return events;
    }

    /**
     * 提取内容
     */
    private extractContent(result: unknown): string {
        if (typeof result === 'string') {
            return result;
        } else if (result && typeof result === 'object' && 'content' in result) {
            const content = (result as { content: unknown }).content;
            if (Array.isArray(content)) {
                return content
                    .map(item => {
                        if (item && typeof item === 'object') {
                            const obj = item as { text?: string; content?: string };
                            return obj.text || obj.content || JSON.stringify(item);
                        }
                        return String(item);
                    })
                    .join('\n');
            } else if (typeof content === 'string') {
                return content;
            }
        }
        return JSON.stringify(result);
    }

    /**
     * 处理搜索响应
     */
    private handleSearchResponse(data: string): void {
        try {
            const jsonData = JSON.parse(data);
            Logger.debug(`📨 [智谱SSE] 响应数据: ${JSON.stringify(jsonData).substring(0, 200)}...`);

            // 检查是否有错误
            if (jsonData.result && jsonData.result.isError) {
                const errorContent = this.extractContent(jsonData.result);
                Logger.error(`❌ [智谱SSE] 搜索返回错误: ${errorContent}`);

                // 处理错误响应
                this.handleErrorResponse(errorContent).catch(error => {
                    Logger.error('❌ [智谱SSE] 错误处理失败', error instanceof Error ? error : undefined);
                });
                return;
            }

            // 检查工具调用结果
            if (jsonData.result && jsonData.result.content) {
                const content = this.extractContent(jsonData.result);
                if (content && content.length > 50) {
                    // 优先匹配当前正在处理的搜索
                    if (this.currentSearchId && this.pendingSearches.has(this.currentSearchId)) {
                        const searchRequest = this.pendingSearches.get(this.currentSearchId)!;
                        this.pendingSearches.delete(this.currentSearchId);
                        searchRequest.resolve(content);
                        Logger.debug(`✅ [智谱SSE] 当前搜索完成: ${content.length}字符 (ID: ${this.currentSearchId})`);
                        return;
                    }

                    // 如果没有当前搜索，则查找最早的请求
                    for (const [requestId, searchRequest] of this.pendingSearches) {
                        if (searchRequest.timestamp + this.defaultTimeout > Date.now()) {
                            this.pendingSearches.delete(requestId);
                            searchRequest.resolve(content);
                            Logger.debug(`✅ [智谱SSE] 搜索完成: ${content.length}字符 (ID: ${requestId})`);
                            return;
                        }
                    }
                }
            }
        } catch {
            // 处理非JSON数据
            if (data.length > 50 && !data.includes('"jsonrpc"')) {
                // 优先匹配当前正在处理的搜索
                if (this.currentSearchId && this.pendingSearches.has(this.currentSearchId)) {
                    const searchRequest = this.pendingSearches.get(this.currentSearchId)!;
                    this.pendingSearches.delete(this.currentSearchId);
                    searchRequest.resolve(data);
                    Logger.debug(`📝 [智谱SSE] 当前文本数据返回: ${data.length}字符 (ID: ${this.currentSearchId})`);
                    return;
                }

                // 如果没有当前搜索，尝试返回给最早的请求
                const oldestRequest = Array.from(this.pendingSearches.values()).sort(
                    (a, b) => a.timestamp - b.timestamp
                )[0];

                if (oldestRequest) {
                    this.pendingSearches.delete(oldestRequest.id);
                    oldestRequest.resolve(data);
                    Logger.debug(`📝 [智谱SSE] 文本数据返回: ${data.length}字符 (ID: ${oldestRequest.id})`);
                }
            }
        }
    }

    /**
     * 处理错误响应
     */
    private async handleErrorResponse(errorContent: string): Promise<void> {
        let errorMessage = errorContent;

        // 检查是否是403权限错误
        if (errorContent.includes('403') && errorContent.includes('您无权访问')) {
            // 特殊处理MCP SSE 403权限错误
            if (errorContent.includes('search-prime-claude')) {
                Logger.warn(`⚠️ [智谱SSE] 检测到联网搜索 MCP 权限不足: ${errorContent}`);

                // 弹出用户对话框询问是否停用MCP模式
                const shouldDisableMCP = await this.showMCPDisableDialog();

                if (shouldDisableMCP) {
                    // 用户选择停用MCP模式，更新配置
                    await this.disableMCPMode();
                    errorMessage = '智谱AI搜索权限不足：MCP模式已禁用，请重新尝试搜索。';
                } else {
                    errorMessage =
                        '智谱AI搜索权限不足：您的账户无权访问联网搜索 MCP 功能。请检查您的智谱AI套餐订阅状态。';
                }
            } else {
                errorMessage = '智谱AI搜索权限不足：403错误。请检查您的API密钥权限或套餐订阅状态。';
            }
        } else if (errorContent.includes('MCP error')) {
            // 提取MCP错误信息
            const mcpErrorMatch = errorContent.match(/MCP error (\d+): (.+)/);
            if (mcpErrorMatch) {
                const [, errorCode, errorDesc] = mcpErrorMatch;
                errorMessage = `智谱AI MCP协议错误 ${errorCode}: ${errorDesc}`;
            }
        }

        // 将错误传递给所有等待的搜索请求
        if (this.currentSearchId && this.pendingSearches.has(this.currentSearchId)) {
            const searchRequest = this.pendingSearches.get(this.currentSearchId)!;
            this.pendingSearches.delete(this.currentSearchId);
            searchRequest.reject(new Error(errorMessage));
            Logger.debug(`❌ [智谱SSE] 当前搜索失败 (ID: ${this.currentSearchId}): ${errorMessage}`);
        } else {
            // 如果没有当前搜索，则失败最早的请求
            const oldestRequest = Array.from(this.pendingSearches.values()).sort(
                (a, b) => a.timestamp - b.timestamp
            )[0];

            if (oldestRequest) {
                this.pendingSearches.delete(oldestRequest.id);
                oldestRequest.reject(new Error(errorMessage));
                Logger.debug(`❌ [智谱SSE] 搜索失败 (ID: ${oldestRequest.id}): ${errorMessage}`);
            }
        }
    }

    /**
     * 清理连接资源
     */
    private cleanup(): void {
        if (this.currentConnection) {
            try {
                this.currentConnection.destroy();
            } catch (error) {
                Logger.debug('连接清理时出错', error instanceof Error ? error : undefined);
            }
            this.currentConnection = null;
        }

        if (this.currentResponse) {
            this.currentResponse.destroy();
            this.currentResponse = null;
        }

        this.messageEndpoint = '';
        this.sessionId = '';
        this.isInitialized = false; // 重置初始化状态
        this.isProcessingQueue = false; // 重置队列处理锁
        this.currentSearchId = null; // 重置当前搜索ID

        // 清理定时器
        if (this.heartbeatTimer) {
            clearInterval(this.heartbeatTimer);
            this.heartbeatTimer = null;
        }

        if (this.reconnectTimer) {
            clearTimeout(this.reconnectTimer);
            this.reconnectTimer = null;
        }
    }

    /**
     * 执行搜索请求
     */
    private async executeSearch(searchRequest: SearchRequest): Promise<void> {
        if (!this.messageEndpoint) {
            searchRequest.reject(new Error('连接端点未就绪'));
            return;
        }

        if (!this.isInitialized) {
            searchRequest.reject(new Error('MCP协议未初始化'));
            return;
        }

        try {
            Logger.debug(`🎯 [智谱SSE] 执行搜索: ${searchRequest.query}`);
            await this.sendSearchToolCall(searchRequest.query, searchRequest.options);
        } catch (error) {
            this.pendingSearches.delete(searchRequest.id);
            searchRequest.reject(error instanceof Error ? error : new Error(String(error)));
        }
    }

    /**
     * 开始心跳
     */
    private startHeartbeat(): void {
        this.stopHeartbeat();
        this.heartbeatTimer = setInterval(() => {
            this.sendHeartbeat();
        }, 30000); // 每30秒发送一次心跳
    }

    /**
     * 停止心跳
     */
    private stopHeartbeat(): void {
        if (this.heartbeatTimer) {
            clearInterval(this.heartbeatTimer);
            this.heartbeatTimer = null;
        }
    }

    /**
     * 发送心跳
     */
    private async sendHeartbeat(): Promise<void> {
        if (this.connectionState !== ConnectionState.CONNECTED || !this.messageEndpoint) {
            return;
        }

        try {
            // 发送简单的ping请求作为心跳
            const pingRequest = {
                jsonrpc: '2.0',
                id: 'heartbeat',
                method: 'ping'
            };
            await this.sendMessage(this.messageEndpoint, pingRequest);
            Logger.debug('💓 [智谱SSE] 心跳发送成功');
        } catch (error) {
            Logger.debug('💔 [智谱SSE] 心跳失败，尝试重连', error instanceof Error ? error : undefined);
            this.scheduleReconnect();
        }
    }

    /**
     * 安排重连
     */
    private scheduleReconnect(): void {
        if (this.connectionState === ConnectionState.CONNECTING) {
            return;
        }

        this.retryCount++;
        if (this.retryCount > this.maxRetries) {
            Logger.error('❌ [智谱SSE] 重连次数超限，停止重连');
            this.connectionState = ConnectionState.ERROR;
            this.failAllPendingSearches('连接失败，重连次数超限');
            return;
        }

        const delay = Math.min(1000 * Math.pow(2, this.retryCount), 30000);
        Logger.info(`🔄 [智谱SSE] 将在 ${delay}ms 后进行第 ${this.retryCount} 次重连`);

        this.reconnectTimer = setTimeout(async () => {
            this.cleanup();
            try {
                await this.connect();
                Logger.info('✅ [智谱SSE] 重连成功');
            } catch (error) {
                Logger.error('❌ [智谱SSE] 重连失败', error instanceof Error ? error : undefined);
                this.scheduleReconnect();
            }
        }, delay);
    }

    /**
     * 失败所有挂起的搜索
     */
    private failAllPendingSearches(reason: string): void {
        for (const [, searchRequest] of this.pendingSearches) {
            searchRequest.reject(new Error(reason));
        }
        this.pendingSearches.clear();
        this.searchQueue.length = 0;
    }

    /**
     * 显示MCP禁用对话框
     */
    private async showMCPDisableDialog(): Promise<boolean> {
        const message =
            '智谱AI搜索权限不足：您的账户无权访问联网搜索 MCP 功能。\n\n是否要停用MCP订阅服务模式，改为使用标准计费服务？\n\n• MCP模式：需要Pro+套餐订阅，免费使用\n• 标准模式：按次计费，适合所有用户';

        const action = await vscode.window.showWarningMessage(
            message,
            { modal: true },
            '切换到标准模式',
            '保持MCP模式'
        );

        Logger.info(`🔧 [智谱SSE] 用户选择: ${action || '取消'}`);
        return action === '切换到标准模式';
    }

    /**
     * 禁用MCP模式
     */
    private async disableMCPMode(): Promise<void> {
        try {
            // 更新配置，禁用MCP模式
            const config = vscode.workspace.getConfiguration('gcmp');
            await config.update('zhipu.search.enableMCP', false, vscode.ConfigurationTarget.Global);

            Logger.info('✅ [智谱SSE] MCP模式已禁用，将使用标准计费模式');

            // 断开当前SSE连接
            await this.disconnect();

            // 显示成功消息
            vscode.window.showInformationMessage('已切换到标准计费模式。请重新尝试搜索。', '确定');
        } catch (error) {
            Logger.error('❌ [智谱SSE] 禁用MCP模式失败', error instanceof Error ? error : undefined);
            vscode.window.showErrorMessage(`切换模式失败: ${error instanceof Error ? error.message : '未知错误'}`);
        }
    }

    /**
     * 断开连接
     */
    async disconnect(): Promise<void> {
        Logger.info('🔌 [智谱SSE] 断开连接...');

        this.connectionState = ConnectionState.DISCONNECTED;
        this.stopHeartbeat();

        if (this.reconnectTimer) {
            clearTimeout(this.reconnectTimer);
            this.reconnectTimer = null;
        }

        this.failAllPendingSearches('连接已断开');
        this.cleanup();

        Logger.info('✅ [智谱SSE] 连接已断开');
    }

    /**
     * 获取连接状态
     */
    getConnectionState(): ConnectionState {
        return this.connectionState;
    }

    /**
     * 获取客户端状态
     */
    getStatus(): { name: string; version: string; enabled: boolean; connectionState: string } {
        return {
            name: 'GCMP-ZhipuSSE-Client',
            version: VersionManager.getVersion(),
            enabled: true,
            connectionState: this.connectionState
        };
    }
}
