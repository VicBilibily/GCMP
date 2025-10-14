import * as vscode from 'vscode';
import OpenAI from 'openai';
import { Logger } from '../utils/logger';
import { INLINE_COMPLETION_CONFIG } from './configuration';
import { ApiKeyManager } from '../utils/apiKeyManager';
import { completionCache } from './completionCache';

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
 * 集成了位置缓存系统，缓存最近100个位置的补全结果
 */
export async function requestInlineCompletion(
    request: InlineCompletionRequest
): Promise<string | undefined> {
    // 检查缓存
    const cachedResult = completionCache.get(request.document, request.position);
    if (cachedResult) {
        Logger.debug('使用缓存的补全结果');
        return cachedResult;
    }

    // 创建取消控制器
    const abortController = new AbortController();

    // 监听取消信号
    request.token.onCancellationRequested(() => {
        abortController.abort();
    });

    try {
        // 执行实际的补全请求
        const result = await executeInlineCompletion(request, abortController.signal);

        // 如果请求成功且有结果，且不是无效内容，则缓存它
        if (result && result.trim() && !request.token.isCancellationRequested) {
            completionCache.set(request.document, request.position, result);
            Logger.debug('缓存补全结果');
        }

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
 * 优化版本：更好地利用上下文信息
 */
function buildCompletionPrompt(request: InlineCompletionRequest): string {
    const { context, prefix, language, document, position } = request;

    // 获取当前行的完整内容
    const currentLine = document.lineAt(position.line).text;
    const suffix = currentLine.substring(position.character);

    // 构建系统提示
    const systemPrompt = `你是一个专业的代码补全助手。请根据提供的上下文和代码结构，为当前光标位置生成最合适的代码补全。

补全原则：
1. 严格遵循上下文中的代码风格和命名规范
2. 考虑已有的类型定义和函数签名
3. 只返回需要补全的代码，不要重复前缀内容
4. 不要添加任何解释或注释
5. 如果有后缀内容，确保补全与后缀连接自然或替换冲突的后缀
6. 优先使用上下文中已定义的符号和导入
7. 必须包含完整的语句结束符（如分号、闭合括号等）

补全策略：
- 优先补全整行：如果能完成当前行，提供完整的行内容（包括分号等结束符）
- 支持多行补全：如果是函数、类、循环等代码块，提供完整的块结构
- 智能替换：如果光标后有冲突内容（如多余的括号、分号），补全时会自动替换`;

    // 构建用户提示
    const userPrompt = `
## 编程语言
${language}

## 代码上下文
${context}

## 当前补全位置
当前行: \`${currentLine}\`
光标前: \`${prefix}\`
光标后: \`${suffix}\`
${suffix ? '\n注意: 光标后有内容，如果补全内容与后缀冲突（如括号、引号等），只需提供完整正确的补全，系统会自动处理替换。' : ''}

## 任务
请为光标位置生成合适的代码补全：
- 如果能补全整行，就补全整行（必须包含分号等结束符）
- 如果是代码块的开始（如函数定义、if语句、循环等），提供完整的代码块结构
- 只输出需要补全的代码内容，不要包含解释

## 重要提示
补全内容必须是语法完整的代码，包含所有必要的结束符：
- 语句结束的分号 (;)
- 闭合的括号 (), [], {}
- 闭合的引号 '', "", \`\``;

    return `${systemPrompt}\n\n${userPrompt}`.trim();
}

/**
 * 后处理补全结果
 * 优化版本：更智能的结果清理，避免无效补全
 */
function postProcessCompletion(
    completion: string,
    request: InlineCompletionRequest
): string {
    let result = completion;

    // 移除可能的代码块标记
    result = result.replace(/^```[\w]*\n?/, '').replace(/\n?```$/, '');

    // 移除 markdown 格式
    result = result.replace(/^`+|`+$/g, '');

    // 移除前导和尾随空白（保留缩进）
    result = result.replace(/^\s*\n/, '').replace(/\n\s*$/, '');

    // 如果补全内容以前缀开头，移除重复的前缀
    const prefix = request.prefix.trim();
    if (prefix && result.startsWith(prefix)) {
        result = result.substring(prefix.length);
    }

    // 智能去重：处理前缀末尾和补全开头的重复符号
    result = removeDuplicateSymbols(result, request);

    // 检查是否与后续代码重复（避免无效补全）
    if (isDuplicateWithFollowingCode(result, request)) {
        Logger.trace('补全内容与后续代码重复，跳过');
        return '';
    }

    // 检查是否为无意义的补全
    if (isInvalidCompletion(result, request)) {
        Logger.trace('补全内容无效，跳过');
        return '';
    }

    // 智能限制补全长度
    const lines = result.split('\n');

    // 对于单行补全，限制字符数
    if (lines.length === 1 && result.length > 300) {
        result = result.substring(0, 300);
    }

    // 对于多行补全，限制行数（增加到20行以支持代码块）
    if (lines.length > 20) {
        result = lines.slice(0, 20).join('\n');
    }

    // 移除可能的解释性文本
    const explanationPatterns = [
        /^(解释|说明|注释|Note|Explanation)[:：].*/gim,
        /^这段代码.*/gim,
        /^以下是.*/gim
    ];

    for (const pattern of explanationPatterns) {
        result = result.replace(pattern, '');
    }

    // 最后再次清理空白（但保留必要的空格）
    result = result.trim();

    // 再次检查是否为空或无效
    if (!result || result.length < 2) {
        Logger.trace('补全内容过短或为空，跳过');
        return '';
    }

    // 确保单行补全包含结束符（如果应该有的话）
    if (lines.length === 1) {
        result = ensureProperEnding(result, request);
    }

    return result;
}

/**
 * 确保补全内容有正确的结束符
 * @param completion 补全内容
 * @param request 请求参数
 * @returns 处理后的补全内容
 */
function ensureProperEnding(completion: string, request: InlineCompletionRequest): string {
    // 如果光标后已经有内容，不添加结束符（会被替换）
    const suffix = request.document.lineAt(request.position.line).text.substring(request.position.character);
    if (suffix.trim()) {
        return completion;
    }

    // 检查是否需要添加分号
    const needsSemicolon = shouldHaveSemicolon(completion, request.language);

    if (needsSemicolon && !completion.endsWith(';') && !completion.endsWith(',')) {
        // 检查是否是完整的语句但缺少分号
        if (looksLikeStatement(completion)) {
            Logger.trace('补全语句缺少分号，自动添加');
            return completion + ';';
        }
    }

    return completion;
}

/**
 * 判断是否应该有分号结尾
 * @param completion 补全内容
 * @param language 编程语言
 * @returns 是否需要分号
 */
function shouldHaveSemicolon(completion: string, language: string): boolean {
    // 需要分号的语言
    const semicolonLanguages = ['typescript', 'javascript', 'java', 'c', 'cpp', 'csharp', 'go', 'rust'];

    if (!semicolonLanguages.includes(language)) {
        return false;
    }

    // 已经有结束符的情况
    if (/[;,}\])]$/.test(completion.trim())) {
        return false;
    }

    // 是代码块开始的情况（不需要分号）
    if (/[{([[\]]$/.test(completion.trim())) {
        return false;
    }

    return true;
}

/**
 * 判断是否看起来像一个完整的语句
 * @param completion 补全内容
 * @returns 是否是语句
 */
function looksLikeStatement(completion: string): boolean {
    const trimmed = completion.trim();

    // 看起来像变量声明或赋值
    if (/^(const|let|var|return|throw)\s+/.test(trimmed)) {
        return true;
    }

    // 看起来像函数调用
    if (/\w+\([^)]*\)$/.test(trimmed)) {
        return true;
    }

    // 看起来像对象字面量或数组
    if (/[}\]]$/.test(trimmed)) {
        return true;
    }

    // 看起来像简单的赋值
    if (/\w+\s*=\s*.+/.test(trimmed)) {
        return true;
    }

    return false;
}

/**
 * 检查补全内容是否与后续代码重复
 * @param completion 补全内容
 * @param request 请求参数
 * @returns 是否重复
 */
function isDuplicateWithFollowingCode(completion: string, request: InlineCompletionRequest): boolean {
    const { document, position } = request;

    // 获取后续几行代码用于比较
    const maxLinesToCheck = 10;
    const completionLines = completion.split('\n').map(line => line.trim()).filter(line => line);

    if (completionLines.length === 0) {
        return false;
    }

    // 获取后续代码行
    const followingLines: string[] = [];
    for (let i = position.line; i < Math.min(position.line + maxLinesToCheck, document.lineCount); i++) {
        const line = document.lineAt(i).text.trim();
        if (line) {
            followingLines.push(line);
        }
    }

    if (followingLines.length === 0) {
        return false;
    }

    // 检查补全的第一行是否与后续代码重复
    const firstCompletionLine = completionLines[0];

    // 如果第一行补全与后续任何一行完全相同或高度相似
    for (const followingLine of followingLines) {
        // 完全相同
        if (firstCompletionLine === followingLine) {
            Logger.trace(`补全内容与后续代码重复: "${firstCompletionLine}"`);
            return true;
        }

        // 高度相似（去除空白后比较）
        const normalizedCompletion = firstCompletionLine.replace(/\s+/g, '');
        const normalizedFollowing = followingLine.replace(/\s+/g, '');

        if (normalizedCompletion === normalizedFollowing) {
            Logger.trace(`补全内容与后续代码高度相似: "${firstCompletionLine}" vs "${followingLine}"`);
            return true;
        }

        // 检查是否是子字符串包含（可能是部分重复）
        if (normalizedFollowing.length > 10 && normalizedCompletion.length > 10) {
            if (normalizedFollowing.includes(normalizedCompletion) ||
                normalizedCompletion.includes(normalizedFollowing)) {
                Logger.trace('补全内容与后续代码部分重复');
                return true;
            }
        }
    }

    // 检查多行补全是否与后续代码块重复
    if (completionLines.length > 1 && followingLines.length > 1) {
        let matchCount = 0;
        const checkLines = Math.min(completionLines.length, followingLines.length, 5);

        for (let i = 0; i < checkLines; i++) {
            const compLine = completionLines[i].replace(/\s+/g, '');
            const followLine = followingLines[i].replace(/\s+/g, '');

            if (compLine === followLine ||
                compLine.includes(followLine) ||
                followLine.includes(compLine)) {
                matchCount++;
            }
        }

        // 如果超过50%的行重复，认为是无效补全
        if (matchCount / checkLines > 0.5) {
            Logger.trace(`多行补全与后续代码重复率过高: ${matchCount}/${checkLines}`);
            return true;
        }
    }

    return false;
}

/**
 * 检查是否为无效的补全内容
 * @param completion 补全内容
 * @param request 请求参数
 * @returns 是否无效
 */
function isInvalidCompletion(completion: string, request: InlineCompletionRequest): boolean {
    const trimmed = completion.trim();

    // 空白
    if (!trimmed) {
        return true;
    }

    // 只是注释
    if (/^\/\//.test(trimmed) || /^\/\*/.test(trimmed) || /^#/.test(trimmed)) {
        // 但如果是有意义的注释（超过10个字符），可能是有效的
        if (trimmed.length < 15) {
            Logger.trace('补全内容只是简短注释');
            return true;
        }
    }

    // 检查单个符号的有效性
    if (trimmed.length === 1) {
        // 检查是否是有意义的单个符号
        if (isMeaningfulSingleSymbol(trimmed, request)) {
            return false; // 有意义的单个符号，允许通过
        }

        // 检查是否是无意义的单个符号
        if (isMeaninglessSingleSymbol(trimmed)) {
            Logger.trace('补全内容是无意义的单个符号');
            return true;
        }
    }

    // 检查单个关键字（通常无效，除非是特殊情况）
    if (/^(if|else|for|while|do|switch|case|break|continue|return)$/.test(trimmed)) {
        // 但如果是在特定上下文中，可能是有效的
        if (!isKeywordInValidContext(trimmed, request)) {
            Logger.trace('补全内容只是单个关键字');
            return true;
        }
    }

    // 只是空白行
    const lines = completion.split('\n');
    const nonEmptyLines = lines.filter(line => line.trim());
    if (nonEmptyLines.length === 0) {
        return true;
    }

    // 检查是否只是重复当前行的一部分
    const currentLine = request.document.lineAt(request.position.line).text;
    const currentLineNormalized = currentLine.trim().replace(/\s+/g, '');
    const completionNormalized = trimmed.replace(/\s+/g, '');

    // 如果补全内容完全包含在当前行中（说明是重复）
    if (currentLineNormalized.includes(completionNormalized) && completionNormalized.length > 5) {
        Logger.trace('补全内容是当前行的重复部分');
        return true;
    }

    // 检查是否只是空格或缩进
    if (/^\s+$/.test(completion)) {
        return true;
    }

    return false;
}

/**
 * 检查是否是有意义的单个符号
 * @param symbol 单个符号
 * @param request 请求参数
 * @returns 是否有意义
 */
function isMeaningfulSingleSymbol(symbol: string, request: InlineCompletionRequest): boolean {
    const { document, position } = request;
    const currentLine = document.lineAt(position.line).text;
    const prefix = currentLine.substring(0, position.character);
    const suffix = currentLine.substring(position.character);

    // 闭合符号：如果前面有对应的开放符号，则闭合符号是有意义的
    const closingPairs: Record<string, string> = {
        ')': '(',
        ']': '[',
        '}': '{',
        '>': '<',
        '"': '"',
        '\'': '\'',
        '`': '`'
    };

    if (closingPairs[symbol]) {
        // 检查前面是否有对应的开放符号
        const openSymbol = closingPairs[symbol];
        const prefixCount = (prefix.match(new RegExp('\\' + openSymbol, 'g')) || []).length;
        const suffixCount = (suffix.match(new RegExp('\\' + symbol, 'g')) || []).length;

        // 如果开放符号比闭合符号多，则这个闭合符号是有意义的
        if (prefixCount > suffixCount) {
            Logger.trace(`有意义的闭合符号 '${symbol}' (开放符号: ${prefixCount}, 闭合符号: ${suffixCount})`);
            return true;
        }
    }

    // 分号：在语句末尾是有意义的
    if (symbol === ';') {
        // 检查是否在语句末尾（前面有实际内容，后面没有内容或只有空白）
        const trimmedPrefix = prefix.trim();
        if (trimmedPrefix &&
            !trimmedPrefix.endsWith('{') &&
            !trimmedPrefix.endsWith(';') &&
            !trimmedPrefix.endsWith(',')) {
            Logger.trace('有意义的分号补全');
            return true;
        }
    }

    // 逗号：在数组、对象、参数列表中是有意义的
    if (symbol === ',') {
        // 检查是否在数组、对象或函数调用中
        const hasOpenBracket = /[{}[(]/.test(prefix);
        const hasCloseBracket = /[})\]]/.test(suffix);

        if (hasOpenBracket && !hasCloseBracket) {
            Logger.trace('有意义的逗号补全');
            return true;
        }
    }

    // 冒号：在对象属性、类型注解中是有意义的
    if (symbol === ':') {
        // 检查是否在对象定义或类型注解中
        const hasPropertyPattern = /\w+\s*$/.test(prefix.trim());
        const hasTypeAnnotationPattern = /\w+\s*:\s*$/.test(prefix.trim());

        if (hasPropertyPattern || hasTypeAnnotationPattern) {
            Logger.trace('有意义的冒号补全');
            return true;
        }
    }

    // 点号：在对象属性访问中是有意义的
    if (symbol === '.') {
        // 检查前面是否是对象或变量
        const hasObjectPattern = /\w+\s*$/.test(prefix.trim());
        if (hasObjectPattern) {
            Logger.trace('有意义的点号补全');
            return true;
        }
    }

    return false;
}

/**
 * 检查是否是无意义的单个符号
 * @param _symbol 单个符号
 * @returns 是否无意义
 */
function isMeaninglessSingleSymbol(_symbol: string): boolean {
    // 暂时不标记任何符号为绝对无意义，让上下文判断
    return false;
}

/**
 * 检查关键字是否在有效上下文中
 * @param keyword 关键字
 * @param request 请求参数
 * @returns 是否在有效上下文中
 */
function isKeywordInValidContext(keyword: string, request: InlineCompletionRequest): boolean {
    const { document, position } = request;
    const currentLine = document.lineAt(position.line).text;
    const prefix = currentLine.substring(0, position.character).trim();

    // 某些关键字在特定上下文中是有效的
    switch (keyword) {
        case 'return':
            // 在函数体内，return 是有意义的
            return /function|=>|\{/.test(prefix);

        case 'break':
        case 'continue':
            // 在循环体内，这些关键字是有意义的
            return /(for|while|do)\s*\(/.test(prefix);

        case 'else':
            // 在 if 语句后，else 是有意义的
            return /if\s*\([^)]*\)\s*\{?\s*$/.test(prefix);

        default:
            return false;
    }
}

/**
 * 移除重复的符号
 * 处理前缀末尾和补全开头的重复符号（如括号、引号等）
 * @param completion 补全内容
 * @param request 请求参数
 * @returns 处理后的补全内容
 */
function removeDuplicateSymbols(completion: string, request: InlineCompletionRequest): string {
    if (!completion) {
        return completion;
    }

    const prefix = request.prefix;
    if (!prefix) {
        return completion;
    }

    // 获取前缀的最后几个字符
    const prefixEnd = prefix.slice(-10); // 检查最后10个字符

    // 常见的可能重复的符号模式
    const symbolPatterns = [
        { symbol: '(', regex: /^\s*\(+/ },    // 左括号
        { symbol: '[', regex: /^\s*\[+/ },    // 左方括号
        { symbol: '{', regex: /^\s*\{+/ },    // 左花括号
        { symbol: ')', regex: /^\s*\)+/ },    // 右括号
        { symbol: ']', regex: /^\s*\]+/ },    // 右方括号
        { symbol: '}', regex: /^\s*\}+/ },    // 右花括号
        { symbol: '"', regex: /^\s*"+/ },     // 双引号
        { symbol: '\'', regex: /^\s*'+/ },    // 单引号
        { symbol: '`', regex: /^\s*`+/ },     // 反引号
        { symbol: ',', regex: /^\s*,+/ },     // 逗号
        { symbol: ';', regex: /^\s*;+/ },     // 分号
        { symbol: ':', regex: /^\s*:+/ }      // 冒号
    ];

    let result = completion;

    // 检查每种符号
    for (const { symbol, regex } of symbolPatterns) {
        // 如果前缀以该符号结尾，且补全以该符号开头
        if (prefixEnd.endsWith(symbol)) {
            const match = result.match(regex);
            if (match) {
                // 移除补全开头的重复符号
                result = result.substring(match[0].length);
                Logger.trace(`移除重复符号 '${symbol}': "${match[0]}"`);
            }
        }
    }

    return result;
}
