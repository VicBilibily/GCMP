/*---------------------------------------------------------------------------------------------
 *  JSON Schema 提供者
 *  动态生成 GCMP 配置的 JSON Schema，为 settings.json 提供智能提示
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { ProviderConfig } from '../types/sharedTypes';
import { ConfigManager } from './configManager';
import { Logger } from './logger';
import type { JSONSchema7 } from 'json-schema';
import { KnownProviders } from './knownProviders';
import { CompatibleModelManager } from './compatibleModelManager';

/**
 * 扩展的 JSON Schema 接口，支持 VS Code 特有的 enumDescriptions 属性
 */
declare module 'json-schema' {
    interface JSONSchema7 {
        enumDescriptions?: string[];
    }
}

/**
 * JSON Schema 提供者类
 * 动态生成 GCMP 配置的 JSON Schema，为 settings.json 提供智能提示
 */
export class JsonSchemaProvider {
    private static readonly SCHEMA_URI = 'gcmp-settings://root/schema.json';
    private static schemaProvider: vscode.Disposable | null = null;
    private static lastSchemaHash: string | null = null;

    /**
     * 初始化 JSON Schema 提供者
     */
    static initialize(): void {
        if (this.schemaProvider) {
            this.schemaProvider.dispose();
        }

        // 注册 JSON Schema 内容提供者，使用正确的 scheme
        this.schemaProvider = vscode.workspace.registerTextDocumentContentProvider('gcmp-settings', {
            provideTextDocumentContent: (uri: vscode.Uri): string => {
                if (uri.toString() === this.SCHEMA_URI) {
                    const schema = this.getProviderOverridesSchema();
                    return JSON.stringify(schema, null, 2);
                }
                return '';
            }
        });

        // 监听文件系统访问，动态更新 schema
        vscode.workspace.onDidOpenTextDocument(document => {
            if (document.uri.scheme === 'gcmp-settings') {
                this.updateSchema();
            }
        });

        // 监听配置变化，及时更新 schema
        vscode.workspace.onDidChangeConfiguration(e => {
            if (e.affectsConfiguration('gcmp')) {
                this.invalidateCache();
            }
        });

        Logger.info('动态 JSON Schema 提供者已初始化');
    }

    /**
     * 使缓存失效，触发 schema 更新
     */
    private static invalidateCache(): void {
        this.lastSchemaHash = null;
        this.updateSchema();
    }

    /**
     * 更新 Schema
     */
    private static updateSchema(): void {
        try {
            // 生成新的 schema
            const newSchema = this.getProviderOverridesSchema();
            const newHash = this.generateSchemaHash(newSchema);

            // 如果 schema 没有变化，跳过更新
            if (this.lastSchemaHash === newHash) {
                return;
            }

            this.lastSchemaHash = newHash;

            // 触发内容更新
            const uri = vscode.Uri.parse(this.SCHEMA_URI);
            vscode.workspace.textDocuments.forEach(doc => {
                if (doc.uri.toString() === this.SCHEMA_URI) {
                    // 重新生成 schema 内容
                    const newContent = JSON.stringify(newSchema, null, 2);
                    const edit = new vscode.WorkspaceEdit();
                    edit.replace(uri, new vscode.Range(0, 0, doc.lineCount, 0), newContent);
                    vscode.workspace.applyEdit(edit);
                    Logger.info('JSON Schema 已更新');
                }
            });
        } catch (error) {
            Logger.error('更新 JSON Schema 失败:', error);
        }
    }

    /**
     * 生成 schema 的哈希值用于缓存比较
     */
    private static generateSchemaHash(schema: JSONSchema7): string {
        return JSON.stringify(schema, Object.keys(schema).sort());
    }

    /**
     * 获取提供商覆盖配置的 JSON Schema
     */
    static getProviderOverridesSchema(): JSONSchema7 {
        const providerConfigs = ConfigManager.getConfigProvider();
        const patternProperties: Record<string, JSONSchema7> = {};
        const propertyNames: JSONSchema7 = {
            type: 'string',
            description: '提供商配置键名',
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
            description: 'Schema for GCMP configuration with dynamic model ID suggestions',
            type: 'object',
            properties: {
                'gcmp.providerOverrides': {
                    type: 'object',
                    description:
                        '提供商配置覆盖。允许覆盖提供商的baseUrl和模型配置，支持添加新模型或覆盖现有模型的参数。',
                    patternProperties,
                    propertyNames
                },
                'gcmp.fimCompletion.modelConfig': {
                    type: 'object',
                    description: 'FIM (Fill-in-the-Middle) 补全模式配置',
                    properties: {
                        provider: {
                            type: 'string',
                            description: 'FIM补全使用的提供商ID',
                            enum: providerIds,
                            enumDescriptions: allProviderDescriptions
                        }
                    },
                    additionalProperties: true
                },
                'gcmp.nesCompletion.modelConfig': {
                    type: 'object',
                    description: 'NES (Next Edit Suggestion) 补全模式配置',
                    properties: {
                        provider: {
                            type: 'string',
                            description: 'NES补全使用的提供商ID',
                            enum: providerIds,
                            enumDescriptions: allProviderDescriptions
                        }
                    },
                    additionalProperties: true
                },
                'gcmp.compatibleModels': {
                    type: 'array',
                    description: 'Compatible Provider 的自定义模型配置。',
                    default: [],
                    items: {
                        type: 'object',
                        properties: {
                            id: {
                                type: 'string',
                                description: '模型ID',
                                minLength: 1
                            },
                            name: {
                                type: 'string',
                                description: '模型显示名称',
                                minLength: 1
                            },
                            tooltip: {
                                type: 'string',
                                description: '模型描述'
                            },
                            provider: {
                                type: 'string',
                                description:
                                    '模型提供商标识符。从下拉列表选择现有提供商ID，或输入新ID创建自定义提供商。',
                                anyOf: [
                                    {
                                        type: 'string',
                                        enum: providerIds,
                                        description: '选择现有提供商ID'
                                    },
                                    {
                                        type: 'string',
                                        minLength: 3,
                                        maxLength: 100,
                                        pattern: '^[a-zA-Z0-9_-]+$',
                                        description: '新增自定义提供商ID（允许字母、数字、下划线、连字符）'
                                    }
                                ]
                            },
                            sdkMode: {
                                type: 'string',
                                enum: ['openai', 'openai-sse', 'openai-responses', 'anthropic', 'gemini-sse'],
                                enumDescriptions: [
                                    'OpenAI SDK 标准模式，使用官方 OpenAI SDK 进行请求响应处理',
                                    'OpenAI SSE 兼容模式，使用插件内实现的SSE解析逻辑进行流式响应处理',
                                    'OpenAI Responses API 模式，使用 Responses API 进行请求响应处理',
                                    'Anthropic SDK 标准模式，使用官方 Anthropic SDK 进行请求响应处理',
                                    'Gemini HTTP SSE 模式（实验性），使用纯 HTTP + SSE 解析，兼容第三方 Gemini 网关'
                                ],
                                description: 'SDK模式默认为 openai。',
                                default: 'openai'
                            },
                            baseUrl: {
                                type: 'string',
                                description: 'API基础URL',
                                format: 'uri'
                            },
                            model: {
                                type: 'string',
                                description: 'API请求时使用的模型名称（可选，默认使用模型ID）'
                            },
                            maxInputTokens: {
                                type: 'number',
                                description: '最大输入token数量',
                                minimum: 128
                            },
                            maxOutputTokens: {
                                type: 'number',
                                description: '最大输出token数量',
                                minimum: 8
                            },
                            includeThinking: {
                                type: 'boolean',
                                description:
                                    '多轮对话消息是否必须包含思考内容（可选）\n- false: 不包含思考内容（默认）\n- true: 总是包含思考内容',
                                default: false
                            },
                            useInstructions: {
                                type: 'boolean',
                                description:
                                    '是否在 Responses API 中使用 instructions 参数（可选）\n- false: 使用用户消息传递系统消息（默认）\n- true: 使用 instructions 参数传递系统消息',
                                default: false
                            },
                            capabilities: {
                                type: 'object',
                                properties: {
                                    toolCalling: {
                                        type: 'boolean',
                                        description: '是否支持工具调用'
                                    },
                                    imageInput: {
                                        type: 'boolean',
                                        description: '是否支持图像输入'
                                    }
                                },
                                required: ['toolCalling', 'imageInput']
                            },
                            customHeader: {
                                type: 'object',
                                description: '自定义HTTP头部配置，支持 ${APIKEY} 占位符替换',
                                additionalProperties: {
                                    type: 'string',
                                    description: 'HTTP头部值'
                                }
                            },
                            extraBody: {
                                type: 'object',
                                description: '额外的请求体参数，将在API请求中合并到请求体中',
                                additionalProperties: {
                                    description: '额外的请求体参数值'
                                }
                            }
                        },
                        required: ['id', 'name', 'maxInputTokens', 'maxOutputTokens', 'capabilities']
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
                    description: '覆盖现有模型ID'
                },
                {
                    type: 'string',
                    minLength: 3,
                    maxLength: 100,
                    pattern: '^[a-zA-Z0-9._-]+$',
                    description: '新增自定义模型ID（允许字母、数字、下划线、连字符和点号）'
                }
            ],
            description: '从下拉列表选择现有模型ID，或输入新ID创建自定义配置'
        };

        // 为 streamlake 的 model 字段添加正则验证
        const modelProperty: JSONSchema7 = {
            type: 'string',
            minLength: 1,
            description: '覆盖API请求时使用的模型名称或端点ID'
        };
        if (providerKey === 'streamlake') {
            modelProperty.pattern = '^ep-[a-zA-Z0-9]{6}-\\d{19}$';
            modelProperty.description = '必须符合格式 ep-xxxxxx-xxxxxxxxxxxxxxxxxxx';
        }

        return {
            type: 'object',
            description: `${config.displayName || providerKey} 配置覆盖`,
            properties: {
                baseUrl: {
                    type: 'string',
                    description: '覆盖提供商级别的API基础URL',
                    format: 'uri'
                },
                customHeader: {
                    type: 'object',
                    description: '提供商级别的自定义HTTP头部，支持 ${APIKEY} 占位符替换',
                    additionalProperties: {
                        type: 'string',
                        description: 'HTTP头部值'
                    }
                },
                models: {
                    type: 'array',
                    description: '模型覆盖配置列表',
                    minItems: 1,
                    items: {
                        type: 'object',
                        properties: {
                            id: idProperty,
                            model: modelProperty,
                            name: {
                                type: 'string',
                                minLength: 1,
                                description:
                                    '在模型选择器中显示的友好名称。\r\n对于自定义模型ID有效，不会覆盖预置模型的名称。'
                            },
                            tooltip: {
                                type: 'string',
                                minLength: 1,
                                description:
                                    '作为悬停工具提示显示的详细描述。\r\n对于自定义模型ID有效，不会覆盖预置模型的描述。'
                            },
                            maxInputTokens: {
                                type: 'number',
                                minimum: 1,
                                maximum: 2000000,
                                description: '覆盖最大输入token数量'
                            },
                            maxOutputTokens: {
                                type: 'number',
                                minimum: 1,
                                maximum: 200000,
                                description: '覆盖最大输出token数量'
                            },
                            sdkMode: {
                                type: 'string',
                                enum: ['openai', 'anthropic', 'gemini-sse'],
                                description:
                                    '覆盖SDK模式：openai（OpenAI兼容格式）、anthropic（Anthropic兼容格式）或 gemini-sse（Gemini HTTP SSE 模式，实验性）'
                            },
                            baseUrl: {
                                type: 'string',
                                description: '覆盖模型级别的API基础URL',
                                format: 'uri'
                            },
                            includeThinking: {
                                type: 'boolean',
                                description:
                                    '多轮对话消息是否必须包含思考内容（可选）\n- false: 不包含思考内容（默认）\n- true: 总是包含思考内容',
                                default: false
                            },
                            capabilities: {
                                type: 'object',
                                description: '模型能力配置',
                                properties: {
                                    toolCalling: {
                                        type: 'boolean',
                                        description: '是否支持工具调用'
                                    },
                                    imageInput: {
                                        type: 'boolean',
                                        description: '是否支持图像输入'
                                    }
                                },
                                required: ['toolCalling', 'imageInput'],
                                additionalProperties: false
                            },
                            customHeader: {
                                type: 'object',
                                description: '模型自定义HTTP头部，支持 ${APIKEY} 占位符替换',
                                additionalProperties: {
                                    type: 'string',
                                    description: 'HTTP头部值'
                                }
                            },
                            extraBody: {
                                type: 'object',
                                description: '额外的请求体参数（可选）',
                                additionalProperties: {
                                    description: '额外的请求体参数值'
                                }
                            }
                        },
                        required: ['id'],
                        additionalProperties: false
                    }
                }
            },
            additionalProperties: false
        };
    }

    /**
     * 获取所有可用的提供商ID（包括内置、已知、自定义和历史提供商）
     */
    private static getAllAvailableProviders(): { providerIds: string[]; enumDescriptions: string[] } {
        const providerIds: string[] = [];
        const enumDescriptions: string[] = [];

        try {
            // 1. 获取内置提供商
            for (const [providerId, config] of Object.entries(ConfigManager.getConfigProvider())) {
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
                if (model.provider && model.provider.trim() && !providerIds.includes(model.provider)) {
                    customProviders.add(model.provider.trim());
                }
            }

            // 添加自定义提供商
            for (const providerId of Array.from(customProviders).sort()) {
                providerIds.push(providerId);
                enumDescriptions.push('自定义提供商：' + providerId);
            }
        } catch (error) {
            Logger.error('获取可用提供商列表失败:', error);
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
            commitProviderDescriptions.push('OpenAI / Anthropic Compatible');
        }
        providerModelIdsMap['compatible'] = compatibleModelIds;

        const base: JSONSchema7 = {
            type: 'object',
            description: 'Commit 消息生成模型配置（provider + model）',
            properties: {
                provider: {
                    type: 'string',
                    description: '语言模型提供商（vendor）',
                    enum: commitProviderIds,
                    enumDescriptions: commitProviderDescriptions
                },
                model: {
                    type: 'string',
                    description: '模型 ID（对应 Language Model API 的 model.id）',
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
        if (this.schemaProvider) {
            this.schemaProvider.dispose();
            this.schemaProvider = null;
        }
        Logger.trace('动态 JSON Schema 提供者已清理');
    }
}
