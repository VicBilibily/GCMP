/*---------------------------------------------------------------------------------------------
 *  JSON Schema 提供者
 *  动态生成 GCMP 配置的 JSON Schema，为 settings.json 提供智能提示
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { ProviderConfig } from '../types/sharedTypes';
import { ConfigManager } from './configManager';
import { Logger } from './logger';
import type { JSONSchema7 } from 'json-schema';

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
     * 获取供应商覆盖配置的 JSON Schema
     */
    static getProviderOverridesSchema(): JSONSchema7 {
        const providerConfigs = ConfigManager.getConfigProvider();
        const patternProperties: Record<string, JSONSchema7> = {};
        const propertyNames: JSONSchema7 = {
            type: 'string',
            description: '供应商配置键名',
            enum: Object.keys(providerConfigs)
        };

        // 为每个供应商生成 schema
        for (const [providerKey, config] of Object.entries(providerConfigs)) {
            patternProperties[`^${providerKey}$`] = this.createProviderSchema(providerKey, config);
        }
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
                        '供应商配置覆盖。允许覆盖供应商的baseUrl和模型配置，支持添加新模型或覆盖现有模型的参数。',
                    patternProperties,
                    propertyNames,
                    additionalProperties: {
                        type: 'object',
                        description: '自定义供应商配置覆盖',
                        properties: {
                            baseUrl: {
                                type: 'string',
                                description: '覆盖供应商级别的API基础URL',
                                format: 'uri',
                                pattern: '^https?://'
                            },
                            models: {
                                type: 'array',
                                description: '模型覆盖配置列表',
                                minItems: 1,
                                items: {
                                    type: 'object',
                                    properties: {
                                        id: {
                                            type: 'string',
                                            minLength: 3,
                                            maxLength: 100,
                                            description: '模型ID（用于匹配现有模型或添加新模型）'
                                        },
                                        model: {
                                            type: 'string',
                                            minLength: 1,
                                            description: '覆盖API请求时使用的模型名称或端点ID'
                                        },
                                        maxInputTokens: {
                                            type: 'number',
                                            minimum: 512,
                                            description: '覆盖最大输入token数量'
                                        },
                                        maxOutputTokens: {
                                            type: 'number',
                                            minimum: 64,
                                            description: '覆盖最大输出token数量'
                                        },
                                        baseUrl: {
                                            type: 'string',
                                            description: '覆盖模型级别的API基础URL',
                                            format: 'uri',
                                            pattern: '^https?://'
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
                                        }
                                    },
                                    required: ['id'],
                                    additionalProperties: false
                                }
                            }
                        },
                        additionalProperties: false
                    }
                }
            },
            additionalProperties: true
        };
    }

    /**
     * 为特定供应商创建 JSON Schema
     */
    private static createProviderSchema(providerKey: string, config: ProviderConfig): JSONSchema7 {
        const modelIds = config.models?.map(model => model.id) || [];

        const idProperty: JSONSchema7 = {
            type: 'string',
            minLength: 3,
            maxLength: 100,
            description: '模型ID（用于匹配现有模型或添加新模型）'
        };

        // 如果有模型ID，添加枚举和示例
        if (modelIds.length > 0) {
            idProperty.enum = modelIds;
            idProperty.examples = modelIds.slice(0, 3);
        }

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
                    description: '覆盖供应商级别的API基础URL',
                    format: 'uri'
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
                            baseUrl: {
                                type: 'string',
                                description: '覆盖模型级别的API基础URL',
                                format: 'uri'
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
