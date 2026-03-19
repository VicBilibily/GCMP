/*---------------------------------------------------------------------------------------------
 *  Gemini HTTP Handler
 *  纯 fetch + 自定义流解析（兼容 SSE data: 与 JSON 行流），不依赖 Google SDK
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import * as crypto from 'node:crypto';
import { execSync } from 'node:child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { ApiKeyManager } from '../utils/apiKeyManager';
import { ConfigManager } from '../utils/configManager';
import { Logger } from '../utils/logger';
import { TokenUsagesManager } from '../usages/usagesManager';
import type { ModelConfig, ProviderConfig } from '../types/sharedTypes';
import type { GenericUsageData, RawUsageData } from '../usages/fileLogger/types';
import { convertMessagesToGemini, convertToolsToGemini } from './geminiConverter';
import { getStatefulMarkerAndIndex } from './statefulMarker';
import { StreamReporter } from './streamReporter';
import type { GenericModelProvider } from '../providers/genericModelProvider';
import type {
    GeminiGenerationConfig,
    GeminiGenerateContentRequest,
    GeminiGenerateContentResponse,
    GeminiPart,
    GeminiTool
} from './geminiType';

export class GeminiHandler {
    /** 缓存 loadCodeAssist 获取到的托管 project（key = baseUrl:tokenSuffix） */
    private readonly codeAssistProjectCache = new Map<string, string>();
    /** 缓存扩展版本号 */
    private static extensionVersion: string | null = null;
    /** 缓存可用的 Gemini 模型列表 */
    private static availableModels: string[] | null = null;

    /** 默认 Gemini CLI 版本 */
    private static readonly defaultCliVersion = '0.32.1';

    constructor(private readonly providerInstance: GenericModelProvider) {}

    private get provider(): string {
        return this.providerInstance.provider;
    }
    private get providerConfig(): ProviderConfig | undefined {
        return this.providerInstance.providerConfig;
    }
    private get displayName(): string {
        return this.providerConfig?.displayName || this.provider;
    }

    /**
     * 规范化 baseUrl：去除首尾空白与末尾 `/`。
     * 用途：避免后续拼接路径时出现 `//` 或空字符串导致的 URL 构建失败。
     */
    private normalizeBaseUrl(baseUrl: string | undefined): string {
        const v = typeof baseUrl === 'string' ? baseUrl.trim() : '';
        return v.endsWith('/') ? v.slice(0, -1) : v;
    }

    private isCodeAssistBaseUrl(baseUrl: string): boolean {
        const normalized = this.normalizeBaseUrl(baseUrl);
        try {
            const u = new URL(normalized);
            return u.hostname.toLowerCase() === 'cloudcode-pa.googleapis.com';
        } catch {
            return normalized.toLowerCase().includes('cloudcode-pa.googleapis.com');
        }
    }

    private buildCodeAssistEndpoint(baseUrl: string, stream: boolean): string {
        const normalized = this.normalizeBaseUrl(baseUrl);
        if (!normalized) {
            return '';
        }

        // Code Assist API 使用 `v1internal:{method}`
        const method = stream ? 'streamGenerateContent' : 'generateContent';

        try {
            const u0 = new URL(normalized);
            // 如果已配置为完整端点，则保留它并仅规范化方法。
            let p = (u0.pathname || '').replace(/\/+$/, '') || '/';
            if (/:generateContent$/i.test(p) || /:streamGenerateContent$/i.test(p)) {
                u0.pathname = p.replace(/:(streamGenerateContent|generateContent)$/i, `:${method}`);
            } else {
                // 如果存在 `/v1internal` 前缀则规范化，否则默认为 `/v1internal`。
                // 重要说明：Code Assist 方法被附加为 `/v1internal:{method}`（没有额外的 '/'）。
                const pLower = p.toLowerCase();
                const idx = pLower.indexOf('/v1internal');

                if (idx >= 0) {
                    // 如果 baseUrl 在 /v1internal 之后意外包含额外段，则修剪它们。
                    p = p.slice(0, idx + '/v1internal'.length);
                } else {
                    p = this.joinPathPrefix(p, '/v1internal');
                }

                const basePath = (p || '').replace(/\/+$/, '');
                u0.pathname = `${basePath}:${method}`;
            }

            if (stream) {
                u0.searchParams.set('alt', 'sse');
            }
            return u0.toString();
        } catch {
            const join = normalized.endsWith('/') ? normalized.slice(0, -1) : normalized;
            const url = `${join}/v1internal:${method}`;
            return stream ? `${url}${url.includes('?') ? '&' : '?'}alt=sse` : url;
        }
    }

    /**
     * 构建 Gemini `:streamGenerateContent` SSE endpoint（仅流式路径）。
     *
     * 关键兼容点：
     * - baseUrl 可能是：域名根、带 /v1beta 前缀、甚至完整的 `:generateContent/:streamGenerateContent` 端点。
     * - 流式模式会自动加 `alt=sse`（兼容官方与第三方 Gemini 网关）。
     */
    private buildEndpoint(baseUrl: string, modelId: string, stream: boolean): string {
        const normalized = this.normalizeBaseUrl(baseUrl);
        if (!normalized) {
            return '';
        }

        // 特殊处理 Gemini Code Assist 端点。
        if (this.isCodeAssistBaseUrl(normalized)) {
            return this.buildCodeAssistEndpoint(normalized, stream);
        }

        const method = stream ? 'streamGenerateContent' : 'generateContent';

        try {
            const u0 = new URL(normalized);
            let basePath = (u0.pathname || '').replace(/\/+$/, '') || '/';

            // 如果已配置为完整端点，则保留它（仅根据流式切换方法）。
            if (/:generateContent$/i.test(basePath) || /:streamGenerateContent$/i.test(basePath)) {
                u0.pathname = basePath.replace(/:(streamGenerateContent|generateContent)$/i, `:${method}`);
                if (stream) {
                    u0.searchParams.set('alt', 'sse');
                }
                return u0.toString();
            }

            const modelPath = this.normalizeGeminiModelPath(modelId);
            if (!modelPath) {
                return '';
            }

            // 如果基础路径已包含版本段，则不要再次附加。
            if (!/\/v1beta$/i.test(basePath) && !/\/v1beta\//i.test(`${basePath}/`)) {
                basePath = this.joinPathPrefix(basePath, '/v1beta');
            }

            u0.pathname = this.joinPathPrefix(basePath, `/${modelPath}:${method}`);
            if (stream) {
                u0.searchParams.set('alt', 'sse');
            }
            return u0.toString();
        } catch {
            // 非 URL baseUrl（尽力而为的回退）
            const modelPath = this.normalizeGeminiModelPath(modelId);
            if (!modelPath) {
                return '';
            }
            const suffix = stream ? ':streamGenerateContent' : ':generateContent';
            const join = normalized.endsWith('/') ? normalized.slice(0, -1) : normalized;
            const url = `${join}/v1beta/${modelPath}${suffix}`;
            return stream ? `${url}${url.includes('?') ? '&' : '?'}alt=sse` : url;
        }
    }

    private joinPathPrefix(basePath: string, nextPath: string): string {
        const a = basePath || '';
        const b = nextPath || '';
        const aTrim = a.endsWith('/') ? a.slice(0, -1) : a;
        const bTrim = b.startsWith('/') ? b : `/${b}`;
        return `${aTrim || ''}${bTrim}`;
    }

    private normalizeGeminiModelPath(modelId: string): string {
        const raw = (modelId || '').trim();
        if (!raw) {
            return 'models/gemini-2.5-flash';
        }

        if (raw.includes('..') || raw.includes('?') || raw.includes('&') || raw.includes('#')) {
            return '';
        }

        // 接受用户提供的 "models/..." 或 "tunedModels/..."
        if (/^(models|tunedModels)\//i.test(raw)) {
            return raw;
        }

        // 如果用户意外传递了完整路径如 "/v1beta/models/xxx"，尝试恢复尾部。
        const m = raw.match(/\b(models|tunedModels)\/[A-Za-z0-9._-]+/i);
        if (m && typeof m[0] === 'string' && m[0]) {
            return m[0];
        }

        return `models/${raw}`;
    }

    private isPlainObject(value: unknown): value is Record<string, unknown> {
        if (!value || typeof value !== 'object' || Array.isArray(value)) {
            return false;
        }
        const proto = Object.getPrototypeOf(value);
        return proto === Object.prototype || proto === null;
    }

    private deepMergePlainObjects(
        base: Record<string, unknown>,
        override: Record<string, unknown>
    ): Record<string, unknown> {
        const out: Record<string, unknown> = { ...base };
        for (const [key, value] of Object.entries(override)) {
            if (value === undefined) {
                continue;
            }
            const existing = out[key];
            if (this.isPlainObject(existing) && this.isPlainObject(value)) {
                out[key] = this.deepMergePlainObjects(existing, value);
                continue;
            }
            out[key] = value;
        }
        return out;
    }

    private extractGenerationConfigOverrides(extraBody: Record<string, unknown>): Record<string, unknown> {
        const overrides: Record<string, unknown> = {};
        // 兼容旧写法：extraBody.generationConfig
        const nested = (extraBody as Record<string, unknown>).generationConfig;
        if (this.isPlainObject(nested)) {
            Object.assign(overrides, nested);
        }
        // 新写法：extraBody 直接作为 generationConfig 的补充字段
        for (const [k, v] of Object.entries(extraBody)) {
            // Code Assist wrapper 专用字段：不应进入 generationConfig
            if (k === 'project' || k === 'generationConfig') {
                continue;
            }
            overrides[k] = v;
        }
        return overrides;
    }

    private parseDotEnv(text: string): Record<string, string> {
        const out: Record<string, string> = {};
        const lines = (text || '').split(/\r?\n/);
        for (const rawLine of lines) {
            const line = rawLine.trim();
            if (!line || line.startsWith('#')) {
                continue;
            }
            const eq = line.indexOf('=');
            if (eq <= 0) {
                continue;
            }
            const key = line.slice(0, eq).trim();
            let value = line.slice(eq + 1).trim();
            if (!key) {
                continue;
            }
            // 去除引号
            if (value.startsWith('"') && value.endsWith('"')) {
                value = value.slice(1, -1);
            }
            out[key] = value;
        }
        return out;
    }

    private async discoverProjectId(modelConfig: ModelConfig): Promise<string | undefined> {
        // 1) 显式配置
        const fromExtra = modelConfig?.extraBody?.project;
        if (typeof fromExtra === 'string' && fromExtra.trim()) {
            return fromExtra.trim();
        }

        // 2) 环境变量
        const envCandidates = [
            process.env.GOOGLE_CLOUD_PROJECT,
            process.env.GOOGLE_CLOUD_PROJECT_ID,
            process.env.CLOUDSDK_CORE_PROJECT,
            process.env.GCLOUD_PROJECT
        ];
        for (const c of envCandidates) {
            if (typeof c === 'string' && c.trim()) {
                return c.trim();
            }
        }

        // 3) ~/.gemini/.env 文件
        try {
            const envPath = path.join(os.homedir(), '.gemini', '.env');
            if (!fs.existsSync(envPath)) {
                return undefined;
            }
            const text = await fs.promises.readFile(envPath, 'utf-8');
            const parsed = this.parseDotEnv(text);
            const v =
                parsed.GOOGLE_CLOUD_PROJECT ||
                parsed.GOOGLE_CLOUD_PROJECT_ID ||
                parsed.CLOUDSDK_CORE_PROJECT ||
                parsed.GCLOUD_PROJECT;
            if (typeof v === 'string' && v.trim()) {
                return v.trim();
            }
        } catch (err) {
            Logger.trace('[Gemini] 读取 ~/.gemini/.env 失败:', err);
        }
        return undefined;
    }

    /**
     * 构建 Code Assist 请求所用的 User-Agent（与 Gemini CLI 对齐）。
     */
    /**
     * 获取 Gemini CLI 真实版本号（通过执行 `gemini --version`）。
     * 这样可以完全模仿 Gemini CLI，并在 CLI 更新时自动使用新版本。
     */
    private static async getGeminiCliVersion(): Promise<string> {
        if (GeminiHandler.extensionVersion) {
            return GeminiHandler.extensionVersion;
        }
        try {
            const output = execSync('gemini --version', { encoding: 'utf-8', timeout: 5000 }).trim();
            // Gemini CLI --version 通常输出格式为 "0.33.0" 或 "gemini-cli v0.33.0" 等
            const versionMatch = output.match(/(\d+\.\d+\.\d+)/);
            if (versionMatch) {
                const version = versionMatch[1];
                GeminiHandler.extensionVersion = version;
                Logger.info(`[Gemini] 检测到 Gemini CLI 版本: ${version}`);
                return version;
            }
        } catch (e) {
            Logger.warn('[Gemini] 无法获取 Gemini CLI 版本，将使用默认版本', e);
        }
        // 默认版本号：与当前 Gemini CLI 最新版本对齐
        const defaultVersion = GeminiHandler.defaultCliVersion;
        GeminiHandler.extensionVersion = defaultVersion;
        return defaultVersion;
    }

    private buildCodeAssistUserAgent(modelId: string): string {
        const platform = process.platform;
        const arch = process.arch;
        const version = GeminiHandler.extensionVersion || GeminiHandler.defaultCliVersion;
        return `GeminiCLI/${version}/${modelId} (${platform}; ${arch})`;
    }

    /**
     * 调用 loadCodeAssist 接口，获取 Google 托管的 cloudaicompanionProject。
     * 模仿 Gemini CLI 个人 OAuth 模式的行为：首次请求前先通过该接口让服务端分配项目。
     * 结果按 baseUrl+token 末位缓存，避免每次请求都调用。
     */
    private async callLoadCodeAssist(
        baseUrl: string,
        accessToken: string,
        modelId: string
    ): Promise<string | undefined> {
        const cacheKey = `${baseUrl}::${accessToken.slice(-12)}`;
        const cached = this.codeAssistProjectCache.get(cacheKey);
        if (cached) {
            return cached;
        }
        const endpoint = `${baseUrl}/v1internal:loadCodeAssist`;
        try {
            const body = {
                metadata: {
                    ideType: 'IDE_UNSPECIFIED',
                    platform: 'PLATFORM_UNSPECIFIED',
                    pluginType: 'GEMINI'
                }
            };
            const res = await fetch(endpoint, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    Authorization: `Bearer ${accessToken}`,
                    'User-Agent': this.buildCodeAssistUserAgent(modelId)
                },
                body: JSON.stringify(body)
            });
            const text = await res.text();
            if (!res.ok) {
                Logger.warn(`[Gemini] loadCodeAssist 失败 (${res.status}): ${text.slice(0, 200)}`);
                return undefined;
            }
            let data: Record<string, unknown> = {};
            try {
                data = JSON.parse(text) as Record<string, unknown>;
            } catch {
                return undefined;
            }
            const project = data.cloudaicompanionProject;
            if (typeof project === 'string' && project.trim()) {
                const projectId = project.trim();
                this.codeAssistProjectCache.set(cacheKey, projectId);
                Logger.info(`[Gemini] loadCodeAssist 获取到托管 project: ${projectId}`);
                return projectId;
            }
            return undefined;
        } catch (err) {
            Logger.warn('[Gemini] callLoadCodeAssist 异常:', err);
            return undefined;
        }
    }

    /**
     * Code Assist 专用 project 发现逻辑。
     * 优先级：静态配置 > loadCodeAssist API（模仿 Gemini CLI 个人 OAuth 流程）。
     */
    private async discoverCodeAssistProjectId(
        modelConfig: ModelConfig,
        accessToken: string,
        modelId: string,
        baseUrl: string
    ): Promise<string | undefined> {
        const staticProject = await this.discoverProjectId(modelConfig);
        if (staticProject) {
            return staticProject;
        }
        return this.callLoadCodeAssist(baseUrl, accessToken, modelId);
    }

    /**
     * 确保 Gemini CLI 版本号已加载（异步初始化）。
     * 首次调用时会真正执行 `gemini --version`，后续调用返回缓存。
     */
    private static async ensureCliVersionLoaded(): Promise<void> {
        if (!GeminiHandler.extensionVersion) {
            await GeminiHandler.getGeminiCliVersion();
        }
    }

    /**
     * 获取 Gemini 可用模型列表。
     * 当前使用静态列表（从 gemini.json 提取）作为 fallback。
     *
     * 注意：如果在 dependencies 中安装 @google/genai SDK，可以升级此方法
     * 改为调用 models.list() API 以获取实时模型列表：
     *
     *   const { GoogleAIFileManager } = require('@google/genai');
     *   const fileManager = new GoogleAIFileManager(accessToken);
     *   const { models } = await fileManager.listCachedFiles();
     *
     * 目前 Gemini CLI 0.33.0 使用的模型列表为：
     * - gemini-3.1-pro-preview
     * - gemini-3.1-pro-preview-customtools
     * - gemini-3-pro-preview
     * - gemini-3-flash-preview
     * - gemini-2.5-pro
     * - gemini-2.5-flash
     * - gemini-2.5-flash-lite
     */
    static async getAvailableModels(
        _accessToken?: string // 预留参数，如果升级为 SDK API 调用时使用
    ): Promise<string[]> {
        if (GeminiHandler.availableModels) {
            return GeminiHandler.availableModels;
        }

        // 静态模型列表（当前方案）
        const staticModels = [
            'gemini-3.1-pro-preview',
            'gemini-3.1-pro-preview-customtools',
            'gemini-3-pro-preview',
            'gemini-3-flash-preview',
            'gemini-2.5-pro',
            'gemini-2.5-flash',
            'gemini-2.5-flash-lite'
        ];
        GeminiHandler.availableModels = staticModels;
        return staticModels;
    }

    private async getApiKey(modelConfig?: ModelConfig): Promise<string> {
        const providerKey = modelConfig?.provider || this.provider;
        const currentApiKey = await ApiKeyManager.getApiKey(providerKey);
        if (!currentApiKey) {
            throw new Error(`缺少 ${this.displayName} API密钥`);
        }
        return currentApiKey;
    }

    async handleRequest(
        model: vscode.LanguageModelChatInformation,
        modelConfig: ModelConfig,
        messages: readonly vscode.LanguageModelChatMessage[],
        options: vscode.ProvideLanguageModelChatResponseOptions,
        progress: vscode.Progress<vscode.LanguageModelResponsePart2>,
        token: vscode.CancellationToken,
        requestId?: string | null
    ): Promise<void> {
        // 确保 Gemini CLI 版本号已加载（首次调用时会执行 `gemini --version`，后续调用返回缓存）。
        await GeminiHandler.ensureCliVersionLoaded();

        const apiKey = await this.getApiKey(modelConfig);

        // Gemini HTTP 模式要求存在 baseUrl：优先使用模型级别 baseUrl，缺省回退到提供商级别 baseUrl。
        const baseUrl = modelConfig.baseUrl || this.providerConfig?.baseUrl;

        // 合并提供商级别 & 模型级别 customHeader，并用 ${APIKEY} 替换
        const mergedCustomHeader = {
            ...(this.providerConfig?.customHeader || {}),
            ...(modelConfig.customHeader || {})
        };
        // 默认使用扩展内置存储的 apiKey 注入鉴权头；同时允许用户通过 customHeader 覆盖鉴权方式。
        const processedHeaders = ApiKeyManager.processCustomHeader(mergedCustomHeader, apiKey);

        // 用途：将 VS Code 的 messages / tools 转换为 Gemini HTTP API 可接受的结构。
        const { contents, systemInstruction } = convertMessagesToGemini(messages);
        const tools: GeminiTool[] = convertToolsToGemini(options.tools);

        const abortController = new AbortController();
        const cancelSub = token.onCancellationRequested(() => abortController.abort());

        const modelId = modelConfig.model || modelConfig.id;

        // 覆盖 User-Agent 使用动态版本（而不是 customHeader 中可能的硬编码值）
        const dynamicUserAgent = this.buildCodeAssistUserAgent(modelId);
        const headersWithDynamicUA = { ...processedHeaders, 'User-Agent': dynamicUserAgent };
        const normalizedBaseUrl = this.normalizeBaseUrl(baseUrl);
        if (!normalizedBaseUrl) {
            throw new Error('Gemini 模式需要在 modelInfo 中指定 baseUrl');
        }

        let generationConfig: GeminiGenerationConfig = {
            maxOutputTokens: ConfigManager.getMaxTokensForModel(model.maxOutputTokens)
        };

        // extraBody：不再合并到 request body 顶层，而是合并到 generationConfig。
        // 合并策略：若 value 是对象，则做对象合并覆盖（而不是直接替换对象）。
        if (modelConfig.extraBody) {
            const overrides = this.extractGenerationConfigOverrides(modelConfig.extraBody);
            generationConfig = this.deepMergePlainObjects(
                generationConfig as Record<string, unknown>,
                overrides
            ) as GeminiGenerationConfig;
        }

        // 使用 statefulMarker 获取会话状态
        const markerAndIndex = getStatefulMarkerAndIndex(model.id, 'gemini', messages);
        const statefulMarker = markerAndIndex?.statefulMarker;
        const sessionId = statefulMarker?.sessionId || crypto.randomUUID();
        Logger.debug(`🎯 ${model.name} 使用 session_id: ${sessionId}`);

        // 用途：组装请求体（Gemini v1beta / Code Assist v1internal 都复用 contents + generationConfig）。
        const baseRequest: GeminiGenerateContentRequest = {
            contents,
            ...(systemInstruction ? { systemInstruction: { role: 'user', parts: [{ text: systemInstruction }] } } : {}),
            ...(tools.length > 0 ? { tools } : {}),
            generationConfig,
            session_id: sessionId
        };

        // Code Assist 期望包装格式：{ model, project, user_prompt_id, request: { ... } }
        // 保持 Gemini v1beta 为直接请求体。
        let requestBody: unknown = baseRequest;
        if (this.isCodeAssistBaseUrl(normalizedBaseUrl)) {
            const projectId = await this.discoverCodeAssistProjectId(modelConfig, apiKey, modelId, normalizedBaseUrl);
            const userPromptId = crypto.randomUUID();
            requestBody = {
                model: modelId,
                ...(projectId ? { project: projectId } : {}),
                user_prompt_id: userPromptId,
                request: baseRequest
            };
        }

        Logger.info(`🚀 ${model.name} 发送 ${this.displayName} Gemini HTTP 请求 (model=${modelId})`);

        try {
            // 用途：构建第三方 Gemini 网关可用的流式 SSE endpoint。
            const endpoint = this.buildEndpoint(normalizedBaseUrl, modelId, true);
            if (!endpoint) {
                throw new Error('无法构建 Gemini 请求地址（请检查 baseUrl / model 配置）');
            }

            // 创建统一的流报告器
            const reporter = new StreamReporter({
                modelName: model.name,
                modelId: model.id,
                provider: this.provider,
                sdkMode: 'gemini',
                progress,
                sessionId
            });

            // 用途：执行 fetch 请求
            const response = await fetch(endpoint, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    Authorization: `Bearer ${apiKey}`,
                    ...headersWithDynamicUA
                },
                body: JSON.stringify(requestBody),
                signal: abortController.signal
            });

            // 用途：非 2xx 直接提取可读错误信息并抛出。
            if (!response.ok) {
                const text = await response.text();
                const message = this.extractErrorMessage(text || '', response.status, response.statusText);
                throw new Error(message);
            }

            // 用途：SSE/行流响应必须存在 response.body。
            if (!response.body) {
                throw new Error('响应体为空');
            }

            // 用途：处理流式响应
            await this.processStream(response.body, reporter, requestId || '', token);

            Logger.debug(`✅ ${model.name} ${this.displayName} Gemini HTTP 请求完成`);
        } catch (error) {
            if (
                token.isCancellationRequested ||
                error instanceof vscode.CancellationError ||
                (error instanceof Error && error.name === 'AbortError')
            ) {
                Logger.warn(`[${model.name}] 用户取消了请求`);
                throw new vscode.CancellationError();
            }

            Logger.error(`[${model.name}] Gemini HTTP error:`, error);

            if (requestId) {
                try {
                    const usagesManager = TokenUsagesManager.instance;
                    await usagesManager.updateActualTokens({ requestId, status: 'failed' });
                } catch (err) {
                    Logger.warn('更新Token统计失败:', err);
                }
            }

            throw error;
        } finally {
            cancelSub.dispose();
        }
    }

    /**
     * 处理 Gemini HTTP 流式响应，解析 SSE/行流增量输出。
     *
     * 输出内容包含：
     * - 文本：LanguageModelTextPart
     * - thinking：LanguageModelThinkingPart
     * - 工具调用：LanguageModelToolCallPart
     * - usage：原样透传 usageMetadata 供后续统计解析
     */
    private async processStream(
        body: ReadableStream<Uint8Array>,
        reporter: StreamReporter,
        requestId: string,
        token: vscode.CancellationToken
    ): Promise<void> {
        // 用途：读取 Web ReadableStream，逐块 decode 并按行切分。
        const reader = body.getReader();
        const decoder = new TextDecoder();
        let buffer = '';

        // Token 统计: 收集 usage 信息
        let finalUsage: RawUsageData | undefined;
        // 记录流处理的开始时间（首次接收数据时记录）
        let streamStartTime: number | undefined = undefined;

        // 用途：处理一行 SSE/行流。
        // 关键兼容点：
        // - 标准 SSE：`data: {json}` 或 `data: [DONE]`
        // - 类 SSE/网关实现：可能直接输出 JSON 行（不带 data:）
        // - 这里按“行”解析，因此若网关把 JSON 拆成多行，仍可能需要后续增强（目前按现有兼容策略）。
        const processRawLine = (rawLine: string): void => {
            const line = rawLine.trim();
            if (!line) {
                return;
            }

            // 解析 SSE `data:` 前缀（不存在则当作纯 JSON 行）。
            const payload = line.startsWith('data:') ? line.slice(5).trim() : line;
            if (!payload) {
                return;
            }
            if (payload === '[DONE]') {
                return;
            }

            // 关键说明：网关可能夹杂非 JSON 行/心跳，解析失败直接忽略。
            const chunk = this.safeJsonParse(payload);
            if (!chunk) {
                return;
            }

            // 记录首次接收有效数据的时间
            if (streamStartTime === undefined) {
                streamStartTime = Date.now();
            }

            // 兼容 Code Assist 包装：可能是 { response: GenerateContentResponse }。
            const wrapped = chunk as { response?: unknown; error?: { message?: string } };
            const inner = wrapped && typeof wrapped === 'object' && wrapped.response ? wrapped.response : chunk;

            const event = inner as GeminiGenerateContentResponse;

            // 检查是否存在错误，存在则序列化整个 error 对象
            const errorObj = event?.error || wrapped?.error;
            if (errorObj) {
                const errorMsg = typeof errorObj === 'object' ? JSON.stringify(errorObj, null, 2) : String(errorObj);
                throw new Error(errorMsg);
            }

            // 用途：把 Gemini 增量 chunk 转为 VS Code 的增量 response parts（文本/思考/tool）。
            const eventUsage = this.processGeminiEvent(event, reporter);
            if (eventUsage) {
                finalUsage = eventUsage;
            }
        };

        try {
            while (true) {
                if (token.isCancellationRequested) {
                    break;
                }
                const { done, value } = await reader.read();
                if (done) {
                    break;
                }
                buffer += decoder.decode(value, { stream: true });

                // 按 \n 切分：处理完整行，保留末尾残片到下一轮 chunk。
                const lines = buffer.split('\n');
                buffer = lines.pop() || '';

                for (const rawLine of lines) {
                    processRawLine(rawLine);
                }
            }

            if (buffer.trim()) {
                processRawLine(buffer);
            }
        } catch (error) {
            if (error instanceof Error && error.name === 'AbortError') {
                Logger.warn(`[${reporter.getModelName()}] 用户取消了请求`);
                throw new vscode.CancellationError();
            }
            throw error;
        } finally {
            reader.releaseLock();
        }

        // 记录流结束时间
        const streamEndTime = Date.now();

        // 流结束，输出所有剩余内容
        reporter.flushAll(null, {
            sessionId: reporter.getSessionId(),
            responseId: reporter.getResponseId() as string
        });

        // Token 统计: 更新实际 token
        if (finalUsage) {
            try {
                const usagesManager = TokenUsagesManager.instance;
                await usagesManager.updateActualTokens({
                    requestId,
                    rawUsage: finalUsage,
                    status: 'completed',
                    streamStartTime,
                    streamEndTime
                });
            } catch (err) {
                Logger.warn('更新Token统计失败:', err);
            }
        }
    }

    /**
     * 处理单个 Gemini stream event（一个 JSON chunk）。
     *
     * 解析流程：
     * 1) candidates[0].content.parts[]：按 part 类型分别输出文本 / thinking / functionCall。
     * 2) thoughtSignature：用于把"思考段"与后续 tool call 关联（VS Code thinking signature）。
     * 3) usageMetadata：原样透传给 usage logger。
     * 4) responseId：提取并设置到 reporter，用于会话追踪。
     *
     * @returns usage 数据（如果存在）
     */
    private processGeminiEvent(
        event: GeminiGenerateContentResponse,
        reporter: StreamReporter
    ): RawUsageData | undefined {
        if (event.responseId && typeof event.responseId === 'string') {
            reporter.setResponseId(event.responseId);
        }

        // 关键说明：流式场景通常只关心第一候选，其他候选（如有）暂不输出。
        const candidates = Array.isArray(event.candidates) ? event.candidates : [];
        const cand = candidates.length > 0 ? candidates[0] : undefined;
        const parts = Array.isArray(cand?.content?.parts) ? (cand?.content?.parts as GeminiPart[]) : [];

        for (const part of parts) {
            // 解析 thoughtSignature：用于把“即将输出的 thinking”与后续 tool call 关联。
            const sig =
                (typeof part.thoughtSignature === 'string' && part.thoughtSignature ? part.thoughtSignature : '') ||
                (typeof part.thought_signature === 'string' && part.thought_signature ? part.thought_signature : '');
            if (sig) {
                reporter.setThoughtSignature(sig);
            }

            // 解析 thinking：向 UI 输出。
            if (part.thought === true && typeof part.text === 'string' && part.text) {
                reporter.bufferThinking(part.text);
                // Gemini 的每个 thought part 是独立的思考块，处理完后立即结束
                reporter.flushThinking('Gemini thought part 完成');
                reporter.endThinkingChain();
                continue;
            }

            // 解析普通文本：直接增量输出。
            if (typeof part.text === 'string' && part.text) {
                reporter.reportText(part.text);
                continue;
            }

            // 解析工具调用：Gemini 返回完整的 tool call，直接输出
            if (part.functionCall && typeof part.functionCall.name === 'string' && part.functionCall.name) {
                // 使用 UUID 生成唯一 ID，避免并行调用时重复
                const callId = crypto.randomUUID();
                const args =
                    part.functionCall.args && typeof part.functionCall.args === 'object'
                        ? (part.functionCall.args as Record<string, unknown>)
                        : {};
                // Gemini 直接输出 ToolCallPart，不需要累积
                reporter.reportToolCall(callId, part.functionCall.name, args);
                continue;
            }
        }

        if (event.usageMetadata) {
            // 用途：usage 原样记录。
            // 关键说明：不同 Gemini 网关返回的 usage 字段可能不完全一致，原样保留便于后续统计解析/调试。
            return event.usageMetadata as GenericUsageData;
        }

        return undefined;
    }

    /**
     * 安全 JSON 解析：解析失败返回 null（用于忽略心跳/噪声行）。
     */
    private safeJsonParse(text: string): unknown | null {
        try {
            return JSON.parse(text);
        } catch {
            return null;
        }
    }

    private extractErrorMessage(bodyText: string, status: number, statusText: string): string {
        let msg = `API请求失败: ${status} ${statusText}`;
        const parsed = this.safeJsonParse(bodyText);
        let isExtracted = false;
        if (parsed && typeof parsed === 'object' && 'error' in parsed) {
            const err = (parsed as { error?: unknown }).error;
            if (err && typeof err === 'object' && 'message' in err) {
                const m = (err as { message?: unknown }).message;
                if (typeof m === 'string' && m.trim()) {
                    msg = m;
                    isExtracted = true;
                }
            }
        }
        if (parsed && typeof parsed === 'object' && 'detail' in parsed && !isExtracted) {
            const detail = (parsed as { detail?: unknown }).detail;
            if (typeof detail === 'string' && detail.trim()) {
                msg = detail;
                isExtracted = true;
            }
        }
        if (!isExtracted && bodyText.trim()) {
            msg = `${msg} - ${bodyText}`;
        }
        return msg;
    }
}
