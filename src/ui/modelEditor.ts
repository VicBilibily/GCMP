/**
 * 模型编辑器 - 可视化表单界面
 * 提供创建和编辑兼容模型的可视化界面
 */

import * as vscode from 'vscode';
import { CompatibleModelConfig } from '../utils/compatibleModelManager';
import { configProviders } from '../providers/config';
import { KnownProviders } from '../utils/knownProviders';
import { ApiKeyManager } from '../utils/apiKeyManager';
import { VersionManager } from '../utils/versionManager';
import modelEditorCss from './modelEditor.css?raw';
import modelEditorJs from './modelEditor.js?raw';
import OpenAI from 'openai';

interface EditedModelConfig extends CompatibleModelConfig {
    /** API密钥（可选，如果提供，将会自动设置API key） */
    apiKey?: string;
}
/**
 * 删除模型标记接口
 */
interface DeleteModelMarker {
    _deleteModel: true;
    modelId: string;
}

/**
 * 模型编辑器类
 * 管理模型创建和编辑的可视化表单界面
 */
export class ModelEditor {
    /**
     * 显示模型编辑器
     * @param model 要编辑的模型配置
     * @param isCreateMode 是否为创建模式
     * @returns 更新后的模型配置，或 undefined 如果取消，或删除标记对象
     */
    static async show(
        model: CompatibleModelConfig,
        isCreateMode: boolean = false
    ): Promise<EditedModelConfig | DeleteModelMarker | undefined> {
        const panel = vscode.window.createWebviewPanel(
            'compatibleModelEditor',
            isCreateMode ? '创建新模型' : `编辑模型: ${model.name || '未命名模型'}`,
            vscode.ViewColumn.One,
            {
                enableScripts: true,
                retainContextWhenHidden: true
            }
        );

        // 生成表单HTML
        panel.webview.html = this.generateHTML(model, isCreateMode, panel.webview);

        return new Promise<CompatibleModelConfig | DeleteModelMarker | undefined>(resolve => {
            const disposables: vscode.Disposable[] = [];

            disposables.push(
                panel.webview.onDidReceiveMessage(
                    async message => {
                        switch (message.command) {
                            case 'getProviders':
                                // 返回可用的提供商列表
                                this.sendProvidersList(panel.webview);
                                break;
                            case 'fetchModels':
                                // 获取模型列表
                                await this.fetchModelsFromAPI(
                                    panel.webview,
                                    message.baseUrl,
                                    message.apiKey,
                                    message.provider
                                );
                                break;
                            case 'save':
                                // 验证返回的模型对象
                                if (
                                    message.model &&
                                    typeof message.model === 'object' &&
                                    message.model.id &&
                                    message.model.name &&
                                    message.model.provider
                                ) {
                                    resolve(message.model);
                                } else {
                                    vscode.window.showErrorMessage('保存的模型数据无效');
                                    resolve(undefined);
                                }
                                panel.dispose();
                                break;
                            case 'delete':
                                // 处理删除操作 - 显示确认对话框
                                if (message.modelId && typeof message.modelId === 'string') {
                                    const modelName = message.modelName || '该模型';
                                    const confirmed = await vscode.window.showWarningMessage(
                                        `确定要删除模型"${modelName}"吗？`,
                                        { modal: true },
                                        '删除'
                                    );
                                    if (confirmed === '删除') {
                                        // 返回特殊的删除标记对象
                                        resolve({ _deleteModel: true, modelId: message.modelId });
                                        panel.dispose();
                                    }
                                    // 如果用户取消，不关闭面板，继续编辑
                                } else {
                                    vscode.window.showErrorMessage('删除失败:模型ID无效');
                                }
                                break;
                            case 'cancel':
                                resolve(undefined);
                                panel.dispose();
                                break;
                        }
                    },
                    undefined,
                    disposables
                )
            );

            disposables.push(
                panel.onDidDispose(
                    () => {
                        disposables.forEach(d => d.dispose());
                    },
                    undefined,
                    disposables
                )
            );
        });
    }

    /**
     * 生成模型编辑器HTML
     */
    private static generateHTML(model: CompatibleModelConfig, isCreateMode: boolean, webview: vscode.Webview): string {
        const cspSource = webview.cspSource || '';

        // 准备模型数据
        const modelData = {
            id: model?.id || '',
            name: model?.name || '',
            provider: model?.provider || '',
            sdkMode: model?.sdkMode || 'openai',
            tooltip: model?.tooltip || '',
            baseUrl: model?.baseUrl || '',
            model: model?.model || '',
            maxInputTokens: model?.maxInputTokens || 128000,
            maxOutputTokens: model?.maxOutputTokens || 4096,
            toolCalling: model?.capabilities?.toolCalling || false,
            imageInput: model?.capabilities?.imageInput || false,
            useInstructions: model?.useInstructions,
            customHeader: model?.customHeader ? JSON.stringify(model.customHeader, null, 2) : '',
            extraBody: model?.extraBody ? JSON.stringify(model.extraBody, null, 2) : ''
        };

        const pageTitle = isCreateMode ? '创建新模型' : `编辑模型: ${this.escapeHtml(modelData.name)}`;

        return `<!DOCTYPE html>
<html lang="zh-CN">
    <head>
        <meta charset="UTF-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1.0" />
        <title>${pageTitle}</title>
        <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline' ${cspSource}; script-src 'unsafe-inline' ${cspSource};" />
        <style>
            ${modelEditorCss}
        </style>
    </head>
    <body>
        <div class="container">
            <div id="app"></div>
        </div>
        <script>
            ${modelEditorJs}

            // 初始化数据
            const initialModelData = ${JSON.stringify(modelData)};
            const initialIsCreateMode = ${isCreateMode};

            // 启动编辑器
            document.addEventListener('DOMContentLoaded', function() {
                initializeEditor(initialModelData, initialIsCreateMode);
            });
        </script>
    </body>
</html>`;
    }

    /**
     * HTML转义函数
     */
    private static escapeHtml(text: string): string {
        if (!text) {
            return '';
        }
        const map: Record<string, string> = {
            '&': '&amp;',
            '<': '&lt;',
            '>': '&gt;',
            '"': '&quot;',
            // eslint-disable-next-line @stylistic/quotes
            "'": '&#039;'
        };
        return text.replace(/[&<>"']/g, char => map[char]);
    }

    /**
     * 发送提供商列表给 webview
     */
    private static sendProvidersList(webview: vscode.Webview) {
        const providersMap = new Map<string, { id: string; name: string }>();

        // 从内置配置中获取提供商 (configProviders)
        Object.entries(configProviders).forEach(([key, config]) => {
            providersMap.set(key, {
                id: key,
                name: config.displayName || key
            });
        });

        // 添加已知提供商 (KnownProviders)，避免重复
        Object.entries(KnownProviders).forEach(([key, config]) => {
            if (!providersMap.has(key)) {
                providersMap.set(key, {
                    id: key,
                    name: config.displayName || key
                });
            }
        });

        webview.postMessage({
            command: 'setProviders',
            providers: Array.from(providersMap.values())
        });
    }

    /**
     * 从 API 获取模型列表
     */
    private static async fetchModelsFromAPI(
        webview: vscode.Webview,
        baseUrl: string,
        apiKey?: string,
        provider?: string
    ) {
        try {
            // 验证 URL
            if (!baseUrl || !baseUrl.trim()) {
                webview.postMessage({
                    command: 'modelsError',
                    error: '请先输入 BASE URL'
                });
                return;
            }

            // 构建完整的 URL
            let url = baseUrl.trim();
            // 移除末尾的斜杠
            url = url.replace(/\/+$/, '');

            // 智能添加 /models 端点
            // 如果 URL 不包含 /v1，则添加 /v1/models
            // 如果已经包含 /v1，则只添加 /models
            let modelsUrl: string;
            if (url.includes('/v1')) {
                // 已经包含 /v1，直接添加 /models
                modelsUrl = `${url}/models`;
            } else {
                // 不包含 /v1，添加 /v1/models
                modelsUrl = `${url}/v1/models`;
            }

            // 发送加载中状态
            webview.postMessage({
                command: 'modelsLoading'
            });

            // 构建请求头
            const headers: Record<string, string> = {
                'Content-Type': 'application/json',
                'User-Agent': VersionManager.getUserAgent('ModelEditor')
            };

            // 如果提供了 API Key，添加到请求头
            let effectiveApiKey = apiKey;
            if (!effectiveApiKey && provider) {
                // 如果未提供 API Key，尝试从 ApiKeyManager 获取
                effectiveApiKey = await ApiKeyManager.getApiKey(provider);
            }
            if (effectiveApiKey && effectiveApiKey.trim()) {
                headers['Authorization'] = `Bearer ${effectiveApiKey.trim()}`;
            }

            // 发起请求
            const response = await fetch(modelsUrl, {
                method: 'GET',
                headers: headers
            });

            if (!response.ok) {
                throw new Error(`HTTP ${response.status}: ${response.statusText}`);
            }

            const responseData = (await response.json()) as
                | OpenAI.Models.ModelsPage
                | { models: OpenAI.Models.Model[] | string[] }
                | OpenAI.Models.Model[]
                | string[];

            // 解析模型列表
            let models: string[] = [];

            // OpenAI 格式: { data: [{ id: "model-name" }] }
            if ('data' in responseData && Array.isArray(responseData.data)) {
                models = responseData.data
                    .filter((item): item is OpenAI.Models.Model => !!item?.id)
                    .map(item => item.id);
            }
            // 直接数组格式: ["model1", "model2"]
            else if (Array.isArray(responseData)) {
                models = responseData
                    .filter((item): item is string | OpenAI.Models.Model => typeof item === 'string' || !!item?.id)
                    .map(item => (typeof item === 'string' ? item : item.id));
            }
            // 其他格式: { models: [...] } 或 { models: ["model1", "model2"] }
            else if ('models' in responseData && Array.isArray(responseData.models)) {
                models = responseData.models
                    .filter((item): item is string | OpenAI.Models.Model => typeof item === 'string' || !!item?.id)
                    .map(item => (typeof item === 'string' ? item : item.id));
            }

            // 发送模型列表
            webview.postMessage({
                command: 'modelsLoaded',
                models: models
            });
        } catch (error) {
            const errorMessage = error instanceof Error ? error.message : '未知错误';
            webview.postMessage({
                command: 'modelsError',
                error: `获取模型列表失败: ${errorMessage}`
            });
        }
    }
}
