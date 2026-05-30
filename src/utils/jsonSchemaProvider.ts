/*---------------------------------------------------------------------------------------------
 *  JSON Schema 提供者
 *  动态生成 GCMP 配置的 JSON Schema，为 settings.json 提供智能提示
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { ProviderConfig } from '../types/sharedTypes';
import { ConfigManager } from './configManager';
import { Logger } from './logger';
import { t } from './l10n';
import type { JSONSchema7 } from 'json-schema';
import { KnownProviders } from './knownProviders';
import { CompatibleModelManager } from './compatibleModelManager';

/**
 * 扩展的 JSON Schema 接口，支持 VS Code 特有的 enumDescriptions 属性
 */
declare module 'json-schema' {
    interface JSONSchema7 {
        enumDescriptions?: string[];
        deprecationMessage?: string;
        errorMessage?: string;
    }
}

/**
 * JSON Schema 提供者类
 * 动态生成 GCMP 配置的 JSON Schema，为 settings.json 提供智能提示
 */
export class JsonSchemaProvider {
    private static readonly SCHEMA_URI = 'gcmp-settings://root/schema.json';
    private static readonly SCHEMA_VSCODE_URI = vscode.Uri.parse(JsonSchemaProvider.SCHEMA_URI);
    private static fsProviderDisposable: vscode.Disposable | null = null;
    private static onDidChangeFileEmitter: vscode.EventEmitter<vscode.FileChangeEvent[]> | null = null;
    private static eventDisposables: vscode.Disposable[] = [];

    // 仅用于 FileSystemProvider.stat 的文件元信息：避免每次 stat 都 Date.now() 抖动
    private static schemaCtime = Date.now();
    private static schemaMtime = Date.now();

    private static isSchemaUri(uri: vscode.Uri): boolean {
        return uri.scheme === 'gcmp-settings' && uri.authority === 'root' && uri.path === '/schema.json';
    }
    private static throwReadOnly(): never {
        throw vscode.FileSystemError.NoPermissions('gcmp-settings is read-only');
    }

    private static getUseInstructionsDescription(): string {
        return t(
            'Whether to use the instructions parameter in the Responses API (optional)\n- false: pass system messages via user messages (default)\n- true: pass system messages via the instructions parameter',
            '是否在 Responses API 中使用 instructions 参数（可选）\n- false: 使用用户消息传递系统消息（默认）\n- true: 使用 instructions 参数传递系统消息'
        );
    }

    private static getAnthropicWebSearchDescription(): string {
        return t(
            'Whether to enable the native Anthropic web_search tool (only effective when sdkMode=anthropic)',
            '是否启用 Anthropic 原生 web_search 工具（仅 sdkMode=anthropic 时生效）'
        );
    }

    private static getAnthropicWebSearchEnabledDescription(): string {
        return t(
            'Whether to enable the native Anthropic web_search tool. When enabled, web_search is exposed to the model automatically.',
            '是否启用 Anthropic 原生 web_search 工具。启用后会自动向模型暴露 web_search。'
        );
    }

    private static getThinkingDescription(): string {
        return t(
            'Thinking configuration that controls whether the model outputs chain-of-thought content',
            '深度思考配置，控制模型是否输出思维链内容'
        );
    }

    private static getThinkingFormatDescription(includeModeNote: boolean = false): string {
        return includeModeNote ?
                t(
                    'Transmission format for thinking-mode parameters, used to match the API format requirements of different models (only effective for openai/openai-sse)',
                    '思考模式参数的传递格式，用于兼容不同模型的API格式要求（仅 openai/openai-sse 模式生效）'
                )
            :   t(
                    'Transmission format for thinking-mode parameters, used to match the API format requirements of different models',
                    '思考模式参数的传递格式，用于兼容不同模型的API格式要求'
                );
    }

    private static getReasoningEffortDescription(): string {
        return t(
            'Adjusts chain-of-thought depth to balance quality, latency, and cost across scenarios',
            '调节思维链长度，平衡不同场景对效果、时延、成本的需求'
        );
    }

    private static getToolCallingDescription(): string {
        return t('Whether tool calling is supported', '是否支持工具调用');
    }

    private static getImageInputDescription(): string {
        return t('Whether image input is supported', '是否支持图像输入');
    }

    private static getProviderCustomHeaderDescription(): string {
        return t(
            'Custom HTTP header configuration at the provider level, supporting ${APIKEY} placeholder replacement',
            '提供商级别的自定义HTTP头部，支持 ${APIKEY} 占位符替换'
        );
    }

    private static getModelCustomHeaderDescription(): string {
        return t(
            'Custom HTTP headers for the model, supporting ${APIKEY} placeholder replacement',
            '模型自定义HTTP头部，支持 ${APIKEY} 占位符替换'
        );
    }

    private static getCustomHeaderDescription(): string {
        return t(
            'Custom HTTP header configuration, supporting ${APIKEY} placeholder replacement',
            '自定义HTTP头部配置，支持 ${APIKEY} 占位符替换'
        );
    }

    private static getHttpHeaderValueDescription(): string {
        return t('HTTP header value', 'HTTP头部值');
    }

    private static getExtraBodyDescription(optional: boolean = false): string {
        return optional ?
                t('Extra request body parameters (optional)', '额外的请求体参数（可选）')
            :   t(
                    'Extra request body parameters merged into the API request body',
                    '额外的请求体参数，将在API请求中合并到请求体中'
                );
    }

    private static getExtraBodyValueDescription(): string {
        return t('Value for an extra request body parameter', '额外的请求体参数值');
    }

    private static getIncludeThinkingDescription(): string {
        return t(
            'Whether to include thinking content (deprecated; this parameter has been removed)',
            '是否包含思考内容（已弃用，此参数已移除）'
        );
    }

    private static getIncludeThinkingDeprecationMessage(): string {
        return t(
            'includeThinking has been deprecated and is no longer supported',
            'includeThinking 已被弃用，此参数不再被支持'
        );
    }

    private static getOutputThinkingDescription(): string {
        return t(
            'Whether to output thinking content (deprecated; this parameter has been removed)',
            '是否输出思考内容（已弃用，此参数已移除）'
        );
    }

    private static getOutputThinkingDeprecationMessage(): string {
        return t(
            'outputThinking has been deprecated and is no longer supported',
            'outputThinking 已被弃用，此参数不再被支持'
        );
    }

    private static getSdkModeEnumDescriptions(): string[] {
        return [
            t(
                'OpenAI SDK standard mode, using the official OpenAI SDK for request/response handling',
                'OpenAI SDK 标准模式，使用官方 OpenAI SDK 进行请求响应处理'
            ),
            t(
                "OpenAI SSE compatible mode, using the extension's built-in SSE parser for streaming responses",
                'OpenAI SSE 兼容模式，使用插件内实现的SSE解析逻辑进行流式响应处理'
            ),
            t(
                'OpenAI Responses API mode, using the Responses API for request/response handling',
                'OpenAI Responses API 模式，使用 Responses API 进行请求响应处理'
            ),
            t(
                'Anthropic SDK standard mode, using the official Anthropic SDK for request/response handling',
                'Anthropic SDK 标准模式，使用官方 Anthropic SDK 进行请求响应处理'
            ),
            t(
                'Gemini HTTP SSE mode (experimental), using pure HTTP + SSE parsing and compatible with third-party Gemini gateways',
                'Gemini HTTP SSE 模式（实验性），使用纯 HTTP + SSE 解析，兼容第三方 Gemini 网关'
            )
        ];
    }

    private static getThinkingEnumDescriptions(): string[] {
        return [
            t(
                'Force thinking off; the model does not output chain-of-thought content',
                '强制关闭深度思考能力，模型不输出思维链内容'
            ),
            t(
                'Force thinking on; the model always outputs chain-of-thought content',
                '强制开启深度思考能力，模型强制输出思维链内容'
            ),
            t('Let the model decide whether deep thinking is needed', '模型自行判断是否需要进行深度思考'),
            t('Adapt the thinking mode automatically based on the context', '模型根据上下文自适应调整深度思考模式')
        ];
    }

    private static getThinkingFormatEnumDescriptions(): string[] {
        return [
            t('Boolean format: { enable_thinking: true/false }', '使用布尔值格式: { enable_thinking: true/false }'),
            t(
                "Object format: { thinking: { type: 'enabled' | 'disabled' } }",
                "使用对象格式: { thinking: { type: 'enabled' | 'disabled' } }"
            )
        ];
    }

    private static getReasoningEffortEnumDescriptions(): string[] {
        return [
            t('Turn thinking off and answer directly', '关闭思考，直接回答'),
            t('Turn thinking off and answer directly', '关闭思考，直接回答'),
            t('Lightweight thinking with a focus on fast responses', '轻量思考，侧重快速响应'),
            t('Balanced mode that combines speed and depth', '均衡模式，兼顾速度与深度'),
            t('Deep analysis for complex problems', '深度分析，处理复杂问题'),
            t('Maximum reasoning depth with slower response speed', '最大推理深度，速度较慢'),
            t('Absolute highest capability with no token budget limit', '绝对最高能力，对 token 消耗没有限制')
        ];
    }

    /**
     * 初始化 JSON Schema 提供者
     */
    static initialize(): void {
        if (this.fsProviderDisposable) {
            this.fsProviderDisposable.dispose();
        }

        this.schemaCtime = Date.now();
        this.schemaMtime = Date.now();

        // 清理之前注册的事件监听
        this.eventDisposables.forEach(d => d.dispose());
        this.eventDisposables = [];

        // 重建文件变更通知 emitter
        if (this.onDidChangeFileEmitter) {
            this.onDidChangeFileEmitter.dispose();
        }
        this.onDidChangeFileEmitter = new vscode.EventEmitter<vscode.FileChangeEvent[]>();

        // 注册只读文件系统提供者：让 JSON 语言服务用“文件读取”的方式获取 schema
        const provider: vscode.FileSystemProvider = {
            onDidChangeFile: this.onDidChangeFileEmitter.event,
            watch: () => new vscode.Disposable(() => undefined),
            stat: (uri: vscode.Uri) => {
                if (!this.isSchemaUri(uri)) {
                    throw vscode.FileSystemError.FileNotFound(uri);
                }
                return {
                    type: vscode.FileType.File,
                    ctime: this.schemaCtime,
                    mtime: this.schemaMtime,
                    // schema 实际是动态内容；这里给一个非 0 的 size，避免被误判为空文件
                    size: 1
                };
            },
            readDirectory: (uri: vscode.Uri) => {
                // 仅支持 root 目录
                if (
                    uri.scheme !== 'gcmp-settings' ||
                    uri.authority !== 'root' ||
                    (uri.path !== '/' && uri.path !== '')
                ) {
                    throw vscode.FileSystemError.FileNotFound(uri);
                }
                return [['schema.json', vscode.FileType.File]];
            },
            createDirectory: () => this.throwReadOnly(),
            readFile: (uri: vscode.Uri) => {
                if (!this.isSchemaUri(uri)) {
                    throw vscode.FileSystemError.FileNotFound(uri);
                }
                const schema = this.getSettingsSchema();
                const text = JSON.stringify(schema, null, 2);
                return Buffer.from(text, 'utf8');
            },
            writeFile: () => this.throwReadOnly(),
            delete: () => this.throwReadOnly(),
            rename: () => this.throwReadOnly()
        };

        this.fsProviderDisposable = vscode.workspace.registerFileSystemProvider('gcmp-settings', provider, {
            isReadonly: true,
            isCaseSensitive: true
        });

        // 监听配置变化，及时更新 schema
        this.eventDisposables.push(
            vscode.workspace.onDidChangeConfiguration(e => {
                if (e.affectsConfiguration('gcmp')) {
                    this.invalidateCache();
                }
            })
        );

        Logger.debug('Dynamic JSON Schema provider initialized');
    }

    /**
     * 使缓存失效，触发 schema 更新
     */
    private static invalidateCache(): void {
        this.updateSchema();
    }

    /**
     * 更新 Schema
     */
    private static updateSchema(): void {
        try {
            // 配置变更是小概率事件：直接通知 VS Code 重新获取 schema 内容
            this.schemaMtime = Date.now();
            this.onDidChangeFileEmitter?.fire([
                {
                    type: vscode.FileChangeType.Changed,
                    uri: this.SCHEMA_VSCODE_URI
                }
            ]);
            Logger.info('JSON schema updated');
        } catch (error) {
            Logger.error('Failed to update JSON schema:', error);
        }
    }

    /**
     * 获取 family 字段的基础 JSON Schema
     * 用于模型配置中的 family 字段定义
     */
    private static getFamilySchema(): JSONSchema7 {
        return {
            type: 'string',
            description: t(
                'Model family identifier used to determine the editing tool mode.\nIf it is not set, the default is inferred from sdkMode:\n- anthropic → claude-sonnet-4.6\n- openai/openai-sse/openai-responses → claude-sonnet-4.6\n- gemini-sse → gemini-3-pro',
                '模型的 family 标识，用于确定编辑工具模式。\n如果未设置，将根据 sdkMode 自动推断默认值：\n- anthropic → claude-sonnet-4.6\n- openai/openai-sse/openai-responses → claude-sonnet-4.6\n- gemini-sse → gemini-3-pro'
            ),
            enum: ['claude-sonnet-4.6', 'gpt-5.2', 'gemini-3-pro'],
            enumDescriptions: [
                t(
                    'Claude-style editing tool (replace_string_in_file) - efficient, precise single replacements with multi-file support',
                    'Claude 风格编辑工具 (replace_string_in_file) - 高效精确的单次替换，支持多文件替换'
                ),
                t(
                    'GPT-5-style editing tool (apply_patch) - batch diff application with support for complex refactors',
                    'GPT-5 风格编辑工具 (apply_patch) - 批量差异应用，支持复杂重构'
                ),
                t(
                    'Gemini-style editing tool (replace_string_in_file) - efficient, precise single replacements',
                    'Gemini 风格编辑工具 (replace_string_in_file) - 高效精确的单次替换'
                )
            ]
        };
    }

    /**
     * 获取 GCMP 配置的完整 JSON Schema
     * 为 settings.json 提供智能提示和验证
     */
    static getSettingsSchema(): JSONSchema7 {
        const providerConfigs = ConfigManager.getConfigProvider();
        const patternProperties: Record<string, JSONSchema7> = {};
        const propertyNames: JSONSchema7 = {
            type: 'string',
            description: t('Provider configuration key', '提供商配置键名'),
            enum: Object.keys(providerConfigs),
            enumDescriptions: Object.entries(providerConfigs).map(([key, config]) => config.displayName || key)
        };

        // 为每个提供商生成 schema
        for (const [providerKey, config] of Object.entries(providerConfigs)) {
            patternProperties[`^${providerKey}$`] = this.createProviderSchema(providerKey, config);
        }

        // 获取所有可用的提供商ID（用于其它配置项，如 fim/nes/compatibleModels.provider）
        const { providerIds, enumDescriptions: allProviderDescriptions } = this.getAllAvailableProviders();

        // Commit 模型选择：provider 是 VS Code Language Model API 的 vendor（注册给 VS Code 的提供商ID）
        const commitSchema = this.getCommitModelSchema();

        return {
            $schema: 'http://json-schema.org/draft-07/schema#',
            $id: this.SCHEMA_URI,
            title: 'GCMP Configuration Schema',
            description: t(
                'Schema for GCMP configuration with dynamic model ID suggestions',
                '带动态模型 ID 提示的 GCMP 配置 Schema'
            ),
            type: 'object',
            properties: {
                'gcmp.retry.maxAttempts': {
                    type: 'number',
                    description: t(
                        'Maximum automatic retry attempts after a request failure. Only applies to retryable errors. Default: 3, maximum: 5.',
                        '请求失败后的最大自动重试次数，仅对可重试错误生效。默认 3 次，最大 5 次。'
                    ),
                    default: 3,
                    minimum: 1,
                    maximum: 5
                },
                'gcmp.providerOverrides': {
                    type: 'object',
                    description: t(
                        'Provider configuration overrides. Lets you override provider-level baseUrl and model configuration, add new models, or override parameters for existing models.',
                        '提供商配置覆盖。允许覆盖提供商的baseUrl和模型配置，支持添加新模型或覆盖现有模型的参数。'
                    ),
                    patternProperties,
                    propertyNames
                },
                'gcmp.fimCompletion.modelConfig': {
                    type: 'object',
                    description: t(
                        'FIM (Fill-in-the-Middle) completion mode configuration',
                        'FIM (Fill-in-the-Middle) 补全模式配置'
                    ),
                    properties: {
                        provider: {
                            type: 'string',
                            description: t('Provider ID used by FIM completion', 'FIM补全使用的提供商ID'),
                            enum: providerIds,
                            enumDescriptions: allProviderDescriptions
                        }
                    },
                    additionalProperties: true
                },
                'gcmp.nesCompletion.modelConfig': {
                    type: 'object',
                    description: t(
                        'NES (Next Edit Suggestion) completion mode configuration',
                        'NES (Next Edit Suggestion) 补全模式配置'
                    ),
                    properties: {
                        provider: {
                            type: 'string',
                            description: t('Provider ID used by NES completion', 'NES补全使用的提供商ID'),
                            enum: providerIds,
                            enumDescriptions: allProviderDescriptions
                        }
                    },
                    additionalProperties: true
                },
                'gcmp.compatibleModels': {
                    type: 'array',
                    description: t(
                        'Custom model configuration for the Compatible Provider.',
                        'Compatible Provider 的自定义模型配置。'
                    ),
                    default: [],
                    items: {
                        type: 'object',
                        properties: {
                            id: {
                                type: 'string',
                                description: t('Model ID', '模型ID'),
                                minLength: 1
                            },
                            name: {
                                type: 'string',
                                description: t('Model display name', '模型显示名称'),
                                minLength: 1
                            },
                            tooltip: {
                                type: 'string',
                                description: t('Model description', '模型描述')
                            },
                            provider: {
                                description: t(
                                    'Model provider identifier. Select an existing provider ID from the dropdown, or enter a new ID to create a custom provider.',
                                    '模型提供商标识符。从下拉列表选择现有提供商ID，或输入新ID创建自定义提供商。'
                                ),
                                allOf: [
                                    {
                                        anyOf: [
                                            {
                                                type: 'string',
                                                enum: providerIds,
                                                description: t('Select an existing provider ID', '选择现有提供商ID')
                                            },
                                            {
                                                type: 'string',
                                                minLength: 3,
                                                maxLength: 100,
                                                pattern: '^[a-zA-Z0-9_-]+$',
                                                description: t(
                                                    'Create a new custom provider ID (letters, numbers, underscores, and hyphens are allowed)',
                                                    '新增自定义提供商ID（允许字母、数字、下划线、连字符）'
                                                )
                                            }
                                        ]
                                    },
                                    {
                                        not: {
                                            anyOf: [{ const: 'codex' }, { const: 'gemini' }, { const: 'grok' }]
                                        },
                                        errorMessage: t(
                                            '"codex", "gemini", and "grok" are CLI-only providers and cannot be used in custom models',
                                            '"codex"、"gemini" 和 "grok" 为 CLI 专用提供商，不可在自定义模型中使用'
                                        )
                                    }
                                ]
                            },
                            sdkMode: {
                                type: 'string',
                                enum: ['openai', 'openai-sse', 'openai-responses', 'anthropic', 'gemini-sse'],
                                enumDescriptions: this.getSdkModeEnumDescriptions(),
                                description: t('SDK mode defaults to openai.', 'SDK模式默认为 openai。'),
                                default: 'openai'
                            },
                            baseUrl: {
                                type: 'string',
                                description: t('API base URL', 'API基础URL'),
                                format: 'uri'
                            },
                            model: {
                                type: 'string',
                                description: t(
                                    'Model name used in API requests (optional; defaults to the model ID)',
                                    'API请求时使用的模型名称（可选，默认使用模型ID）'
                                )
                            },
                            maxInputTokens: {
                                type: 'number',
                                description: t('Maximum number of input tokens', '最大输入token数量'),
                                minimum: 128
                            },
                            maxOutputTokens: {
                                type: 'number',
                                description: t('Maximum number of output tokens', '最大输出token数量'),
                                minimum: 8
                            },
                            useInstructions: {
                                type: 'boolean',
                                description: this.getUseInstructionsDescription(),
                                default: false
                            },
                            webSearchTool: {
                                type: 'boolean',
                                description: this.getAnthropicWebSearchDescription(),
                                default: false
                            },
                            family: this.getFamilySchema(),
                            thinking: {
                                type: 'array',
                                items: {
                                    type: 'string',
                                    enum: ['disabled', 'enabled', 'auto', 'adaptive'],
                                    enumDescriptions: this.getThinkingEnumDescriptions()
                                },
                                description: this.getThinkingDescription()
                            },
                            thinkingFormat: {
                                type: 'string',
                                enum: ['boolean', 'object'],
                                enumDescriptions: this.getThinkingFormatEnumDescriptions(),
                                default: 'boolean',
                                description: this.getThinkingFormatDescription(true)
                            },
                            reasoningEffort: {
                                type: 'array',
                                items: {
                                    type: 'string',
                                    enum: ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'],
                                    enumDescriptions: this.getReasoningEffortEnumDescriptions()
                                },
                                description: this.getReasoningEffortDescription()
                            },
                            contextSize: {
                                type: 'array',
                                items: {
                                    type: 'integer',
                                    minimum: 1,
                                    description: t(
                                        'Optional context window size (in tokens)',
                                        '单个可选上下文窗口大小（token）'
                                    )
                                },
                                uniqueItems: true,
                                description: t(
                                    'List of context window size options, determining the selectable values and default in the model picker in order. Commonly used for 200K / 400K / full window switching.',
                                    '上下文窗口调节选项列表，按顺序决定模型 picker 的可选值和默认值，常用于 200K / 400K / 满窗口切换'
                                )
                            },
                            capabilities: {
                                type: 'object',
                                properties: {
                                    toolCalling: {
                                        type: 'boolean',
                                        description: this.getToolCallingDescription()
                                    },
                                    imageInput: {
                                        type: 'boolean',
                                        description: this.getImageInputDescription()
                                    }
                                },
                                required: ['toolCalling', 'imageInput']
                            },
                            customHeader: {
                                type: 'object',
                                description: this.getCustomHeaderDescription(),
                                additionalProperties: {
                                    type: 'string',
                                    description: this.getHttpHeaderValueDescription()
                                }
                            },
                            extraBody: {
                                type: 'object',
                                description: this.getExtraBodyDescription(),
                                additionalProperties: {
                                    description: this.getExtraBodyValueDescription()
                                }
                            },
                            includeThinking: {
                                type: 'boolean',
                                description: this.getIncludeThinkingDescription(),
                                deprecationMessage: this.getIncludeThinkingDeprecationMessage()
                            },
                            outputThinking: {
                                type: 'boolean',
                                description: this.getOutputThinkingDescription(),
                                deprecationMessage: this.getOutputThinkingDeprecationMessage()
                            }
                        },
                        required: ['id', 'name', 'provider', 'maxInputTokens', 'maxOutputTokens', 'capabilities'],
                        allOf: [
                            {
                                // endpoint 仅对 openai / openai-sse / openai-responses 生效
                                // anthropic 和 gemini-sse 不提示，且已配置时标红警告
                                if: {
                                    anyOf: [
                                        { not: { required: ['sdkMode'] } },
                                        {
                                            properties: {
                                                sdkMode: { enum: ['openai', 'openai-sse', 'openai-responses'] }
                                            },
                                            required: ['sdkMode']
                                        }
                                    ]
                                },
                                then: {
                                    properties: {
                                        endpoint: {
                                            type: 'string',
                                            description: t(
                                                'Custom API endpoint path (optional).\nUsed to replace the default path appended to baseUrl (such as /chat/completions or /responses).\n- Relative path (for example /custom/path): concatenated with baseUrl\n- Full URL: used directly as the request URL\nOnly effective for openai, openai-sse, and openai-responses modes',
                                                '自定义 API 端点路径（可选）。\n用于替换默认附加到 baseUrl 后的路径（如 /chat/completions、/responses）。\n- 相对路径（如 /custom/path）：与 baseUrl 拼接使用\n- 完整 URL：直接填写完整的地址作为请求地址\n仅对 openai、openai-sse、openai-responses 模式生效'
                                            )
                                        }
                                    }
                                },
                                else: {
                                    properties: {
                                        endpoint: {
                                            deprecationMessage: t(
                                                'endpoint is only effective for openai, openai-sse, and openai-responses modes',
                                                'endpoint 仅对 openai、openai-sse、openai-responses 模式生效'
                                            )
                                        }
                                    }
                                }
                            },
                            {
                                // useInstructions 仅对 openai-responses 生效
                                if: {
                                    properties: {
                                        sdkMode: { const: 'openai-responses' }
                                    },
                                    required: ['sdkMode']
                                },
                                then: {
                                    properties: {
                                        useInstructions: {
                                            type: 'boolean',
                                            description: this.getUseInstructionsDescription(),
                                            default: false
                                        }
                                    }
                                },
                                else: {
                                    properties: {
                                        useInstructions: {
                                            deprecationMessage: t(
                                                'useInstructions is only effective for openai-responses mode',
                                                'useInstructions 仅对 openai-responses 模式生效'
                                            )
                                        }
                                    }
                                }
                            },
                            {
                                // webSearchTool 仅对 anthropic 生效
                                if: {
                                    properties: {
                                        sdkMode: { const: 'anthropic' }
                                    },
                                    required: ['sdkMode']
                                },
                                then: {
                                    properties: {
                                        webSearchTool: {
                                            type: 'boolean',
                                            description: this.getAnthropicWebSearchEnabledDescription(),
                                            default: false
                                        }
                                    }
                                },
                                else: {
                                    properties: {
                                        webSearchTool: {
                                            deprecationMessage: t(
                                                'webSearchTool is only effective for anthropic mode',
                                                'webSearchTool 仅对 anthropic 模式生效'
                                            )
                                        }
                                    }
                                }
                            },
                            {
                                // thinkingFormat 仅对 openai/openai-sse 生效
                                if: {
                                    anyOf: [
                                        { not: { required: ['sdkMode'] } },
                                        {
                                            properties: {
                                                sdkMode: { enum: ['openai', 'openai-sse'] }
                                            },
                                            required: ['sdkMode']
                                        }
                                    ]
                                },
                                then: {
                                    properties: {
                                        thinkingFormat: {
                                            type: 'string',
                                            enum: ['boolean', 'object'],
                                            enumDescriptions: this.getThinkingFormatEnumDescriptions(),
                                            default: 'boolean',
                                            description: this.getThinkingFormatDescription()
                                        }
                                    }
                                },
                                else: {
                                    properties: {
                                        thinkingFormat: {
                                            deprecationMessage: t(
                                                'thinkingFormat is only effective for openai and openai-sse modes',
                                                'thinkingFormat 仅对 openai 和 openai-sse 模式生效'
                                            )
                                        }
                                    }
                                }
                            },
                            {
                                // family 条件建议：根据 sdkMode 推荐默认值
                                // anthropic 模式推荐 claude-sonnet-4.6
                                if: {
                                    properties: {
                                        sdkMode: { const: 'anthropic' }
                                    },
                                    required: ['sdkMode']
                                },
                                then: {
                                    properties: {
                                        family: {
                                            type: 'string',
                                            description: t(
                                                'Model family identifier. Default for anthropic mode: claude-sonnet-4.6\nClaude-style editing tool (replace_string_in_file) - efficient, precise single replacements',
                                                '模型的 family 标识。anthropic 模式默认: claude-sonnet-4.6\nClaude 风格编辑工具 (replace_string_in_file) - 高效精确的单次替换'
                                            ),
                                            default: 'claude-sonnet-4.6',
                                            enum: ['claude-sonnet-4.6', 'gpt-5.2', 'gemini-3-pro'],
                                            enumDescriptions: [
                                                t(
                                                    'Claude-style editing tool (replace_string_in_file) - recommended',
                                                    'Claude 风格编辑工具 (replace_string_in_file) - 推荐'
                                                ),
                                                t(
                                                    'GPT-5-style editing tool (apply_patch)',
                                                    'GPT-5 风格编辑工具 (apply_patch)'
                                                ),
                                                t(
                                                    'Gemini-style editing tool (replace_string_in_file)',
                                                    'Gemini 风格编辑工具 (replace_string_in_file)'
                                                )
                                            ]
                                        }
                                    }
                                }
                            },
                            {
                                // gemini-sse 模式推荐 gemini-3-pro
                                if: {
                                    properties: {
                                        sdkMode: { const: 'gemini-sse' }
                                    },
                                    required: ['sdkMode']
                                },
                                then: {
                                    properties: {
                                        family: {
                                            type: 'string',
                                            description: t(
                                                'Model family identifier. Default for gemini-sse mode: gemini-3-pro\nGemini-style editing tool (replace_string_in_file) - efficient, precise single replacements',
                                                '模型的 family 标识。gemini-sse 模式默认: gemini-3-pro\nGemini 风格编辑工具 (replace_string_in_file) - 高效精确的单次替换'
                                            ),
                                            default: 'gemini-3-pro',
                                            enum: ['gemini-3-pro', 'claude-sonnet-4.6', 'gpt-5.2'],
                                            enumDescriptions: [
                                                t(
                                                    'Gemini-style editing tool (replace_string_in_file) - recommended',
                                                    'Gemini 风格编辑工具 (replace_string_in_file) - 推荐'
                                                ),
                                                t(
                                                    'Claude-style editing tool (replace_string_in_file)',
                                                    'Claude 风格编辑工具 (replace_string_in_file)'
                                                ),
                                                t(
                                                    'GPT-5-style editing tool (apply_patch)',
                                                    'GPT-5 风格编辑工具 (apply_patch)'
                                                )
                                            ]
                                        }
                                    }
                                }
                            },
                            {
                                // openai/openai-sse/openai-responses 模式（默认）
                                if: {
                                    anyOf: [
                                        { not: { required: ['sdkMode'] } },
                                        {
                                            properties: {
                                                sdkMode: { enum: ['openai', 'openai-sse', 'openai-responses'] }
                                            },
                                            required: ['sdkMode']
                                        }
                                    ]
                                },
                                then: {
                                    properties: {
                                        family: {
                                            type: 'string',
                                            description: t(
                                                'Model family identifier.\nDefault for openai/openai-sse/openai-responses modes: claude-sonnet-4.6\nClaude-style editing tool (replace_string_in_file) - efficient, precise single replacements',
                                                '模型的 family 标识。\nopenai/openai-sse/openai-responses 模式默认: claude-sonnet-4.6\nClaude 风格编辑工具 (replace_string_in_file) - 高效精确的单次替换'
                                            ),
                                            enum: ['claude-sonnet-4.6', 'gpt-5.2', 'gemini-3-pro'],
                                            enumDescriptions: [
                                                t(
                                                    'Claude-style editing tool (replace_string_in_file) - recommended',
                                                    'Claude 风格编辑工具 (replace_string_in_file) - 推荐'
                                                ),
                                                t(
                                                    'GPT-5-style editing tool (apply_patch) - batch diff application',
                                                    'GPT-5 风格编辑工具 (apply_patch) - 批量差异应用'
                                                ),
                                                t(
                                                    'Gemini-style editing tool (replace_string_in_file)',
                                                    'Gemini 风格编辑工具 (replace_string_in_file)'
                                                )
                                            ]
                                        }
                                    }
                                }
                            }
                        ]
                    }
                },
                // Commit 模型选择：保存 provider + model
                'gcmp.commit.model': commitSchema
            },
            additionalProperties: true
        };
    }

    /**
     * 为特定提供商创建 JSON Schema
     */
    private static createProviderSchema(providerKey: string, config: ProviderConfig): JSONSchema7 {
        const modelIds = config.models?.map(model => model.id) || [];

        // 创建 id 属性的 schema，支持选择现有模型ID或输入自定义ID
        const idProperty: JSONSchema7 = {
            anyOf: [
                {
                    type: 'string',
                    enum: modelIds,
                    description: t('Override an existing model ID', '覆盖现有模型ID')
                },
                {
                    type: 'string',
                    minLength: 3,
                    maxLength: 100,
                    pattern: '^[a-zA-Z0-9._-]+$',
                    description: t(
                        'Create a new custom model ID (letters, numbers, underscores, hyphens, and dots are allowed)',
                        '新增自定义模型ID（允许字母、数字、下划线、连字符和点号）'
                    )
                }
            ],
            description: t(
                'Select an existing model ID from the dropdown, or enter a new ID to create a custom configuration',
                '从下拉列表选择现有模型ID，或输入新ID创建自定义配置'
            )
        };

        // 为 streamlake 的 model 字段添加正则验证
        const modelProperty: JSONSchema7 = {
            type: 'string',
            minLength: 1,
            description: t(
                'Override the model name or endpoint ID used in API requests',
                '覆盖API请求时使用的模型名称或端点ID'
            )
        };
        if (providerKey === 'streamlake') {
            modelProperty.pattern = '^ep-[a-zA-Z0-9]{6}-\\d{19}$';
            modelProperty.description = t(
                'Must match the format ep-xxxxxx-xxxxxxxxxxxxxxxxxxx',
                '必须符合格式 ep-xxxxxx-xxxxxxxxxxxxxxxxxxx'
            );
        }

        return {
            type: 'object',
            description: t('{0} configuration override', '{0} 配置覆盖', config.displayName || providerKey),
            properties: {
                baseUrl: {
                    type: 'string',
                    description: t('Override the provider-level API base URL', '覆盖提供商级别的API基础URL'),
                    format: 'uri'
                },
                customHeader: {
                    type: 'object',
                    description: this.getProviderCustomHeaderDescription(),
                    additionalProperties: {
                        type: 'string',
                        description: this.getHttpHeaderValueDescription()
                    }
                },
                models: {
                    type: 'array',
                    description: t('Model override configuration list', '模型覆盖配置列表'),
                    minItems: 1,
                    items: {
                        type: 'object',
                        properties: {
                            id: idProperty,
                            model: modelProperty,
                            name: {
                                type: 'string',
                                minLength: 1,
                                description: t(
                                    'Friendly name shown in the model picker.\r\nOnly applies to custom model IDs and does not override the names of built-in models.',
                                    '在模型选择器中显示的友好名称。\r\n对于自定义模型ID有效，不会覆盖预置模型的名称。'
                                )
                            },
                            tooltip: {
                                type: 'string',
                                minLength: 1,
                                description: t(
                                    'Detailed description shown in hover tooltips.\r\nOnly applies to custom model IDs and does not override the descriptions of built-in models.',
                                    '作为悬停工具提示显示的详细描述。\r\n对于自定义模型ID有效，不会覆盖预置模型的描述。'
                                )
                            },
                            maxInputTokens: {
                                type: 'number',
                                minimum: 1,
                                maximum: 2000000,
                                description: t('Override the maximum number of input tokens', '覆盖最大输入token数量')
                            },
                            maxOutputTokens: {
                                type: 'number',
                                minimum: 1,
                                maximum: 200000,
                                description: t('Override the maximum number of output tokens', '覆盖最大输出token数量')
                            },
                            sdkMode: {
                                type: 'string',
                                enum: ['openai', 'openai-sse', 'openai-responses', 'anthropic', 'gemini-sse'],
                                enumDescriptions: [
                                    t('OpenAI SDK standard mode', 'OpenAI SDK 标准模式'),
                                    t(
                                        'OpenAI SSE compatible mode (custom streaming handler)',
                                        'OpenAI SSE 兼容模式（自定义流式处理）'
                                    ),
                                    t('OpenAI Responses API mode', 'OpenAI Responses API 模式'),
                                    t('Anthropic SDK standard mode', 'Anthropic SDK 标准模式'),
                                    t('Gemini HTTP SSE mode (experimental)', 'Gemini HTTP SSE 模式（实验性）')
                                ],
                                description: t(
                                    'Override the SDK mode; defaults to openai',
                                    '覆盖SDK模式，默认为 openai'
                                )
                            },
                            baseUrl: {
                                type: 'string',
                                description: t('Override the model-level API base URL', '覆盖模型级别的API基础URL'),
                                format: 'uri'
                            },
                            capabilities: {
                                type: 'object',
                                description: t('Model capability configuration', '模型能力配置'),
                                properties: {
                                    toolCalling: {
                                        type: 'boolean',
                                        description: this.getToolCallingDescription()
                                    },
                                    imageInput: {
                                        type: 'boolean',
                                        description: this.getImageInputDescription()
                                    }
                                },
                                required: ['toolCalling', 'imageInput'],
                                additionalProperties: false
                            },
                            customHeader: {
                                type: 'object',
                                description: this.getModelCustomHeaderDescription(),
                                additionalProperties: {
                                    type: 'string',
                                    description: this.getHttpHeaderValueDescription()
                                }
                            },
                            extraBody: {
                                type: 'object',
                                description: this.getExtraBodyDescription(true),
                                additionalProperties: {
                                    description: this.getExtraBodyValueDescription()
                                }
                            },
                            useInstructions: {
                                type: 'boolean',
                                description: this.getUseInstructionsDescription(),
                                default: false
                            },
                            webSearchTool: {
                                type: 'boolean',
                                description: this.getAnthropicWebSearchDescription(),
                                default: false
                            },
                            family: this.getFamilySchema(),
                            thinking: {
                                type: 'array',
                                items: {
                                    type: 'string',
                                    enum: ['disabled', 'enabled', 'auto', 'adaptive'],
                                    enumDescriptions: this.getThinkingEnumDescriptions()
                                },
                                description: this.getThinkingDescription()
                            },
                            thinkingFormat: {
                                type: 'string',
                                enum: ['boolean', 'object'],
                                enumDescriptions: this.getThinkingFormatEnumDescriptions(),
                                default: 'boolean',
                                description: this.getThinkingFormatDescription(true)
                            },
                            reasoningEffort: {
                                type: 'array',
                                items: {
                                    type: 'string',
                                    enum: ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'],
                                    enumDescriptions: this.getReasoningEffortEnumDescriptions()
                                },
                                description: this.getReasoningEffortDescription()
                            },
                            contextSize: {
                                type: 'array',
                                items: {
                                    type: 'integer',
                                    minimum: 1,
                                    description: t(
                                        'Optional context window size (in tokens)',
                                        '单个可选上下文窗口大小（token）'
                                    )
                                },
                                uniqueItems: true,
                                description: t(
                                    'List of context window size options, determining the selectable values and default in the model picker in order. Commonly used for 200K / 400K / full window switching.',
                                    '上下文窗口调节选项列表，按顺序决定模型 picker 的可选值和默认值，常用于 200K / 400K / 满窗口切换'
                                )
                            },
                            includeThinking: {
                                type: 'boolean',
                                description: this.getIncludeThinkingDescription(),
                                deprecationMessage: this.getIncludeThinkingDeprecationMessage()
                            },
                            outputThinking: {
                                type: 'boolean',
                                description: this.getOutputThinkingDescription(),
                                deprecationMessage: this.getOutputThinkingDeprecationMessage()
                            }
                        },
                        required: ['id'],
                        allOf: [
                            {
                                if: {
                                    properties: {
                                        sdkMode: { const: 'anthropic' }
                                    },
                                    required: ['sdkMode']
                                },
                                then: {
                                    properties: {
                                        webSearchTool: {
                                            type: 'boolean',
                                            description: this.getAnthropicWebSearchEnabledDescription(),
                                            default: false
                                        }
                                    }
                                },
                                else: {
                                    properties: {
                                        webSearchTool: {
                                            deprecationMessage: t(
                                                'webSearchTool is only effective for anthropic mode',
                                                'webSearchTool 仅对 anthropic 模式生效'
                                            )
                                        }
                                    }
                                }
                            },
                            {
                                if: {
                                    properties: {
                                        sdkMode: { const: 'openai-responses' }
                                    },
                                    required: ['sdkMode']
                                },
                                then: {
                                    properties: {
                                        useInstructions: {
                                            type: 'boolean',
                                            description: this.getUseInstructionsDescription(),
                                            default: false
                                        }
                                    }
                                },
                                else: {
                                    properties: {
                                        useInstructions: {
                                            deprecationMessage: t(
                                                'useInstructions is only effective for openai-responses mode',
                                                'useInstructions 仅对 openai-responses 模式生效'
                                            )
                                        }
                                    }
                                }
                            },
                            {
                                if: {
                                    anyOf: [
                                        { not: { required: ['sdkMode'] } },
                                        {
                                            properties: {
                                                sdkMode: { enum: ['openai', 'openai-sse'] }
                                            },
                                            required: ['sdkMode']
                                        }
                                    ]
                                },
                                then: {
                                    properties: {
                                        thinkingFormat: {
                                            type: 'string',
                                            enum: ['boolean', 'object'],
                                            enumDescriptions: this.getThinkingFormatEnumDescriptions(),
                                            default: 'boolean',
                                            description: this.getThinkingFormatDescription()
                                        }
                                    }
                                },
                                else: {
                                    properties: {
                                        thinkingFormat: {
                                            deprecationMessage: t(
                                                'thinkingFormat is only effective for openai and openai-sse modes',
                                                'thinkingFormat 仅对 openai 和 openai-sse 模式生效'
                                            )
                                        }
                                    }
                                }
                            }
                        ],
                        additionalProperties: false
                    }
                }
            },
            additionalProperties: false
        };
    }

    /** CLI 专用的提供商 ID，禁止在通用配置中使用 */
    private static readonly CLI_RESERVED_PROVIDERS = ['codex', 'gemini', 'grok'];

    /**
     * 获取所有可用的提供商ID（包括内置、已知、自定义和历史提供商）
     * 注意：会过滤掉 CLI 专用的提供商（codex、gemini、grok）
     */
    private static getAllAvailableProviders(): { providerIds: string[]; enumDescriptions: string[] } {
        const providerIds: string[] = [];
        const enumDescriptions: string[] = [];

        try {
            // 1. 获取内置提供商
            for (const [providerId, config] of Object.entries(ConfigManager.getConfigProvider())) {
                if (this.CLI_RESERVED_PROVIDERS.includes(providerId)) {
                    continue;
                }
                providerIds.push(providerId);
                enumDescriptions.push(config.displayName || providerId);
            }

            // 2. 获取已知提供商
            for (const [providerId, config] of Object.entries(KnownProviders)) {
                if (!providerIds.includes(providerId)) {
                    providerIds.push(providerId);
                    enumDescriptions.push(config.displayName || providerId);
                }
            }

            // 3. 获取自定义模型中的历史提供商
            const customModels = CompatibleModelManager.getModels();
            const customProviders = new Set<string>();

            for (const model of customModels) {
                const p = (model.provider || '').trim().toLowerCase();
                if (
                    p &&
                    !providerIds.map(id => id.toLowerCase()).includes(p) &&
                    !this.CLI_RESERVED_PROVIDERS.includes(p)
                ) {
                    customProviders.add(p);
                }
            }

            // 添加自定义提供商
            for (const providerId of Array.from(customProviders).sort()) {
                providerIds.push(providerId);
                enumDescriptions.push(t('Custom provider: {0}', '自定义提供商：{0}', providerId));
            }
        } catch (error) {
            Logger.error('Failed to get available providers:', error);
        }

        return { providerIds, enumDescriptions };
    }

    private static getCommitModelSchema(): JSONSchema7 {
        // Commit 的 provider 为用户友好的 providerKey（不包含 gcmp. 前缀）。
        // 在运行时根据该 providerKey 自动拼接为 VS Code Language Model vendor：gcmp.<providerKey>。
        const commitProviderIds: string[] = [];
        const commitProviderDescriptions: string[] = [];

        const providerModelIdsMap: Record<string, string[]> = {};

        // 内置提供商（providerKey）+ 用户 providerOverrides 合并后的模型列表
        // 注意：commit 模型下拉应包含用户通过 override 新增的模型，而不是仅限于内置 configProviders。
        const providerConfigs = ConfigManager.getConfigProvider();
        for (const [providerKey, originalConfig] of Object.entries(providerConfigs)) {
            commitProviderIds.push(providerKey);
            commitProviderDescriptions.push(originalConfig.displayName || providerKey);

            const effectiveConfig = ConfigManager.applyProviderOverrides(providerKey, originalConfig);
            providerModelIdsMap[providerKey] = (effectiveConfig.models ?? []).map(m => m.id).filter(Boolean);
        }

        // Compatible Provider（providerKey = compatible）
        const compatibleModelIds = CompatibleModelManager.getModels()
            .map(m => m.id)
            .filter(Boolean);
        if (!commitProviderIds.includes('compatible')) {
            commitProviderIds.push('compatible');
            commitProviderDescriptions.push(t('OpenAI / Anthropic Compatible', 'OpenAI / Anthropic 兼容'));
        }
        providerModelIdsMap['compatible'] = compatibleModelIds;

        const base: JSONSchema7 = {
            type: 'object',
            description: t(
                'Commit message generation model configuration (provider + model)',
                'Commit 消息生成模型配置（provider + model）'
            ),
            properties: {
                provider: {
                    type: 'string',
                    description: t('Language model provider (vendor)', '语言模型提供商（vendor）'),
                    enum: commitProviderIds,
                    enumDescriptions: commitProviderDescriptions
                },
                model: {
                    type: 'string',
                    description: t(
                        'Model ID (corresponding to Language Model API model.id)',
                        '模型 ID（对应 Language Model API 的 model.id）'
                    ),
                    minLength: 1
                }
            },
            required: ['provider', 'model'],
            additionalProperties: false
        };

        const linkedRules: JSONSchema7[] = [];
        for (const [provider, modelIds] of Object.entries(providerModelIdsMap)) {
            // Copilot 或无可枚举模型：仅验证 provider
            if (!modelIds || modelIds.length === 0) {
                continue;
            }

            linkedRules.push({
                if: {
                    properties: {
                        provider: { const: provider }
                    },
                    required: ['provider']
                },
                then: {
                    properties: {
                        model: {
                            type: 'string',
                            enum: modelIds
                        }
                    },
                    required: ['model']
                }
            });
        }

        if (linkedRules.length > 0) {
            base.allOf = linkedRules;
        }

        return base;
    }

    /**
     * 清理资源
     */
    static dispose(): void {
        if (this.fsProviderDisposable) {
            this.fsProviderDisposable.dispose();
            this.fsProviderDisposable = null;
        }

        this.eventDisposables.forEach(d => d.dispose());
        this.eventDisposables = [];

        if (this.onDidChangeFileEmitter) {
            this.onDidChangeFileEmitter.dispose();
            this.onDidChangeFileEmitter = null;
        }

        Logger.trace('Dynamic JSON Schema provider disposed');
    }
}
