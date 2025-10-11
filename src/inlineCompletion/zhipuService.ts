import * as vscode from 'vscode';
import OpenAI from 'openai';
import { Logger } from '../utils/logger';
import { INLINE_COMPLETION_CONFIG } from './configuration';
import { ApiKeyManager } from '../utils/apiKeyManager';

/**
 * 缓存的OpenAI客户端实例
 */
let inlineOpenAi: OpenAI | null = null;
let cachedApiKey: string | null = null;

/**
 * 内联补全请求参数
 */
export interface InlineCompletionRequest {
    document: vscode.TextDocument;
    position: vscode.Position;
    context: string;
    prefix: string;
    language: string;
    token: vscode.CancellationToken;
}

/**
 * 获取或创建缓存的OpenAI客户端
 */
function getOrCreateOpenAIClient(apiKey: string): OpenAI {
    // 如果API密钥已变更，重置客户端
    if (cachedApiKey !== apiKey) {
        Logger.debug('API密钥已变更，重置OpenAI客户端');
        inlineOpenAi = null;
        cachedApiKey = apiKey;
    }

    // 如果客户端不存在，创建新的实例
    if (!inlineOpenAi) {
        Logger.debug('创建新的OpenAI客户端实例');
        inlineOpenAi = new OpenAI({
            apiKey: apiKey,
            baseURL: 'https://open.bigmodel.cn/api/coding/paas/v4'
        });
    }

    return inlineOpenAi;
}

/**
 * 重置缓存的OpenAI客户端
 * 在API密钥变更时调用
 */
export function resetInlineOpenAiClient(): void {
    Logger.debug('重置内联补全的OpenAI客户端');
    inlineOpenAi = null;
    cachedApiKey = null;
}

/**
 * 请求内联补全
 * 使用 OpenAI SDK 调用智谱 GLM-4.5-Air 模型获取代码补全建议
 */
export async function requestInlineCompletion(
    request: InlineCompletionRequest
): Promise<string | undefined> {
    // 创建取消控制器
    const abortController = new AbortController();

    // 监听取消信号
    request.token.onCancellationRequested(() => {
        abortController.abort();
    });

    try {
        // 执行实际的补全请求
        const result = await executeInlineCompletion(request, abortController.signal);
        return result;
    } catch (error) {
        // 如果是取消请求，返回 undefined
        if (abortController.signal.aborted ||
            (error instanceof Error && (
                error.name === 'AbortError' ||
                error.message.includes('Request was aborted') ||
                error.message.includes('The operation was aborted') ||
                error.message.includes('The user aborted a request') ||
                error.message.includes('canceled')
            ))) {
            Logger.debug('补全请求被取消');
            return undefined;
        }
        throw error;
    }
}

/**
 * 执行内联补全请求的实际函数
 * @param request 补全请求参数
 * @param signal 取消信号
 * @returns 补全结果
 */
async function executeInlineCompletion(
    request: InlineCompletionRequest,
    signal: AbortSignal
): Promise<string | undefined> {
    // 获取 API Key
    const apiKey = await ApiKeyManager.getApiKey('zhipu');
    if (!apiKey) {
        Logger.warn('未配置智谱 API Key');
        return undefined;
    }

    try {
        Logger.trace('准备调用智谱 API 进行代码补全');

        // 获取或创建缓存的 OpenAI 客户端
        const client = getOrCreateOpenAIClient(apiKey);

        // 构建提示词
        const prompt = buildCompletionPrompt(request);

        // 监听取消令牌
        const abortController = new AbortController();
        const tokenListener = request.token.onCancellationRequested(() => {
            abortController.abort();
        });

        // 如果外部信号已经中止，直接返回
        if (signal.aborted) {
            Logger.debug('代码补全请求已取消（外部信号）');
            return undefined;
        }

        // 监听外部取消信号
        signal.addEventListener('abort', () => {
            abortController.abort();
        });

        const requestBody: OpenAI.ChatCompletionCreateParamsNonStreaming = {
            model: INLINE_COMPLETION_CONFIG.model,
            messages: [
                {
                    role: 'system',
                    content: '你是一个智能代码补全助手。你的任务是根据用户提供的代码上下文，补全当前光标位置的代码。只返回需要补全的代码，不要包含任何解释或注释。'
                },
                {
                    role: 'user',
                    content: prompt
                }
            ],
            temperature: INLINE_COMPLETION_CONFIG.temperature,
            max_tokens: INLINE_COMPLETION_CONFIG.maxCompletionLength,
            stream: false
        };
        // 关闭思考模式
        (requestBody as unknown as { thinking: { type: 'disabled' } }).thinking = { type: 'disabled' };

        Logger.debug('正在请求智谱 API 进行代码补全');

        // 调用智谱 API
        const response = await client.chat.completions.create(requestBody, {
            signal: abortController.signal
        });

        tokenListener.dispose();

        if (!response.choices || response.choices.length === 0) {
            Logger.warn('智谱 API 返回空结果');
            return undefined;
        }

        const completion = response.choices[0].message?.content?.trim();

        if (!completion) {
            return undefined;
        }

        // 后处理补全结果
        return postProcessCompletion(completion, request);

    } catch (error: unknown) {
        // 如果是取消请求，不记录错误
        if (error instanceof Error) {
            // 检查多种取消请求的错误类型
            if (
                error.name === 'AbortError' ||
                error.message.includes('Request was aborted') ||
                error.message.includes('The operation was aborted') ||
                error.message.includes('The user aborted a request') ||
                error.message.includes('canceled')
            ) {
                Logger.trace('代码补全请求已取消');
                return undefined;
            }
        }

        Logger.error('调用智谱 API 时出错:', error);
        return undefined;
    }
}

/**
 * 构建补全提示词
 */
function buildCompletionPrompt(request: InlineCompletionRequest): string {
    const { context, prefix, language } = request;

    return `
语言: ${language}

代码上下文:
\`\`\`${language}
${context}
\`\`\`

当前行前缀: ${prefix}

请补全当前光标位置的代码。只返回需要补全的代码片段，不要重复前缀内容。
`.trim();
}

/**
 * 后处理补全结果
 */
function postProcessCompletion(
    completion: string,
    request: InlineCompletionRequest
): string {
    let result = completion;

    // 移除可能的代码块标记
    result = result.replace(/^```[\w]*\n?/, '').replace(/\n?```$/, '');

    // 移除前导和尾随空白
    result = result.trim();

    // 如果补全内容以前缀开头，移除重复的前缀
    const prefix = request.prefix.trim();
    if (prefix && result.startsWith(prefix)) {
        result = result.substring(prefix.length).trim();
    }

    // 限制补全长度（按行数）
    const lines = result.split('\n');
    if (lines.length > 10) {
        result = lines.slice(0, 10).join('\n');
    }

    return result;
}
