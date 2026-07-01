/*---------------------------------------------------------------------------------------------
 *  Model Editor WebView 后端宿主
 *  管理模型创建和编辑的可视化 WebviewPanel（替代旧 modelEditor.ts + modelEditor.js 方案）
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import * as path from 'path';
import OpenAI from 'openai';
import { CompatibleModelConfig } from '../../utils/compatibleModelManager';
import { configProviders } from '../../providers/config';
import { KnownProviders } from '../../utils/knownProviders';
import { ApiKeyManager } from '../../utils/apiKeyManager';
import { VersionManager } from '../../utils/versionManager';
import { ConfigManager } from '../../utils/configManager';
import { t } from '../../utils/l10n';
import type { ModelFormData, ProviderOption, WebViewMessage } from './types';
// 样式以 raw 字符串形式内联到 HTML（由 esbuild 的 inlineLessPlugin 处理）
import modelEditorCss from './style.less?raw';

/**
 * 编辑后的模型配置（附带可选 apiKey，用于首次创建时一并保存）
 */
export interface EditedModelConfig extends CompatibleModelConfig {
    /** API 密钥（可选，如果提供，将会自动设置 API key） */
    apiKey?: string;
}

/**
 * 删除模型标记接口
 */
export interface DeleteModelMarker {
    _deleteModel: true;
    modelId: string;
}

interface EndpointResolutionResult {
    ok: true;
    url: string;
}

interface EndpointResolutionError {
    ok: false;
    error: string;
}

type EndpointResolution = EndpointResolutionResult | EndpointResolutionError;

/**
 * 模型编辑器
 * 管理模型创建和编辑的可视化 WebviewPanel 界面
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
        const modelDisplayName = model.name || t('Untitled Model', '未命名模型');
        const panel = vscode.window.createWebviewPanel(
            'compatibleModelEditor',
            isCreateMode ?
                t('Create New Model', '创建新模型')
            :   t('Edit Model: {0}', '编辑模型: {0}', modelDisplayName),
            vscode.ViewColumn.One,
            {
                enableScripts: true,
                retainContextWhenHidden: true
            }
        );

        panel.webview.html = this.getWebviewContent(panel.webview, model, isCreateMode);

        return new Promise<EditedModelConfig | DeleteModelMarker | undefined>(resolve => {
            const disposables: vscode.Disposable[] = [];

            disposables.push(
                panel.webview.onDidReceiveMessage(
                    async message => {
                        await this.handleMessage(panel.webview, message, resolve, () => panel.dispose());
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
     * 统一处理 webview 消息
     */
    private static async handleMessage(
        webview: vscode.Webview,
        message: WebViewMessage,
        resolve: (value: EditedModelConfig | DeleteModelMarker | undefined) => void,
        closePanel: () => void
    ): Promise<void> {
        switch (message.command) {
            case 'ready':
                // 前端就绪，发送提供商列表
                this.sendProvidersList(webview);
                return;
            case 'getProviders':
                // 兼容旧消息（部分场景前端初始化时直接请求）
                this.sendProvidersList(webview);
                return;
            case 'fetchModels':
                await this.fetchModelsFromAPI(
                    webview,
                    message.baseUrl,
                    message.modelsEndpoint,
                    message.apiKey,
                    message.provider,
                    message.proxy
                );
                return;
            case 'save': {
                const modelConfig = this.formDataToModelConfig(message.model);
                if (modelConfig) {
                    resolve(modelConfig);
                } else {
                    vscode.window.showErrorMessage(t('The saved model data is invalid.', '保存的模型数据无效'));
                    resolve(undefined);
                }
                closePanel();
                return;
            }
            case 'delete': {
                const modelName = message.modelName || t('this model', '该模型');
                const deleteAction = t('Delete', '删除');
                const confirmed = await vscode.window.showWarningMessage(
                    t('Delete model "{0}"?', '确定要删除模型"{0}"吗？', modelName),
                    { modal: true },
                    deleteAction
                );
                if (confirmed === deleteAction) {
                    resolve({ _deleteModel: true, modelId: message.modelId });
                    closePanel();
                }
                // 用户取消则保持面板打开继续编辑
                return;
            }
            case 'cancel':
                resolve(undefined);
                closePanel();
                return;
        }
    }

    /**
     * 将前端表单数据转换回 CompatibleModelConfig
     * 包含必填字段校验；失败返回 undefined
     */
    private static formDataToModelConfig(data: ModelFormData): EditedModelConfig | undefined {
        if (!data || typeof data !== 'object') {
            return undefined;
        }
        if (!data.id || !data.name || !data.provider) {
            return undefined;
        }

        const model: EditedModelConfig = JSON.parse(JSON.stringify(data)) as EditedModelConfig;

        // 还原 capabilities 嵌套结构
        model.capabilities = {
            toolCalling: data.toolCalling,
            imageInput: data.imageInput
        };
        delete (model as { toolCalling?: boolean }).toolCalling;
        delete (model as { imageInput?: boolean }).imageInput;

        // tooltip: 空字符串 → undefined 表示清空（CompatibleModelConfig 字段为可选，不用 null）
        model.tooltip = data.tooltip || undefined;
        model.baseUrl = data.baseUrl || undefined;
        model.endpoint = data.endpoint || undefined;
        model.modelsEndpoint = data.modelsEndpoint || undefined;
        model.proxy = data.proxy || undefined;
        model.model = data.model || undefined;
        model.maxInputTokens = data.maxInputTokens || 12800;
        model.maxOutputTokens = data.maxOutputTokens || 8192;

        // 仅当 sdkMode 为 openai-responses 时才更新 useInstructions
        if (data.sdkMode === 'openai-responses') {
            model.useInstructions = data.useInstructions ?? false;
        } else if (!model.useInstructions) {
            model.useInstructions = undefined;
        }

        // 仅当 sdkMode 为 anthropic 时才更新 webSearchTool
        if (data.sdkMode === 'anthropic') {
            model.webSearchTool = data.webSearchTool ?? false;
        } else if (!model.webSearchTool) {
            model.webSearchTool = undefined;
        }

        // reasoningEffort 多选值，空数组 → undefined 清理字段
        model.reasoningEffort =
            data.reasoningEffort && data.reasoningEffort.length > 0 ? data.reasoningEffort : undefined;

        // reasoningDefault：空字符串 → undefined 清理字段；
        // 若 reasoningEffort 数组非空，则该值必须包含在其中，否则忽略
        const defaultEffort = data.reasoningDefault;
        if (defaultEffort && (!model.reasoningEffort || model.reasoningEffort.includes(defaultEffort))) {
            model.reasoningDefault = defaultEffort;
        } else {
            model.reasoningDefault = undefined;
        }

        // customHeader / extraBody JSON 解析（customHeader 值类型为 string）
        const customHeaderParsed = this.parseJsonObject(data.customHeader);
        model.customHeader = customHeaderParsed ? (customHeaderParsed as Record<string, string>) : undefined;
        model.extraBody = this.parseJsonObject(data.extraBody) ?? undefined;

        // apiKey 单独保留在 EditedModelConfig 上
        model.apiKey = data.apiKey || undefined;

        return model;
    }

    /**
     * 解析 JSON 字符串为对象，空或无效返回 null（表示清空）
     */
    private static parseJsonObject(text: string): Record<string, unknown> | null {
        if (!text || !text.trim()) {
            return null;
        }
        try {
            const parsed = JSON.parse(text);
            if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
                return parsed as Record<string, unknown>;
            }
            return null;
        } catch {
            return null;
        }
    }

    /**
     * 生成 webview HTML
     * 前端入口由 esbuild 打包为 dist/ui/modelEditor.js 注入
     */
    private static getWebviewContent(
        webview: vscode.Webview,
        model: CompatibleModelConfig,
        isCreateMode: boolean
    ): string {
        const cspSource = webview.cspSource || '';
        const htmlLang = vscode.env.language.toLowerCase().startsWith('zh') ? 'zh-CN' : 'en';

        // 注入前端运行时所需的全局数据
        const initialState = {
            model: this.modelConfigToFormData(model),
            isCreateMode,
            locale: vscode.env.language
        };

        // 前端脚本：dist/ui/modelEditor.js（由 esbuild 自动扫描 app.ts 生成）
        const scriptUri = webview.asWebviewUri(vscode.Uri.file(path.join(this.getDistUiPath(), 'modelEditor.js')));

        return `<!DOCTYPE html>
<html lang="${htmlLang}">
    <head>
        <meta charset="UTF-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1.0" />
        <meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src ${cspSource} https: data:; style-src 'unsafe-inline' ${cspSource}; script-src 'unsafe-inline' ${cspSource};" />
        <style>
            ${modelEditorCss}
        </style>
    </head>
    <body>
        <div class="container">
            <div id="app"></div>
        </div>
        <script>
            window.__INITIAL_STATE__ = ${JSON.stringify(initialState)};
            window.__VS_CODE_LOCALE__ = ${JSON.stringify(vscode.env.language)};
        </script>
        <script src="${scriptUri}"></script>
    </body>
</html>`;
    }

    /**
     * 获取 dist/ui 目录路径
     * 使用 vscode.extensions.getExtension 获取扩展安装路径，
     * 与 auxiliaryModelSettings/usagesView 的做法保持一致
     */
    private static getDistUiPath(): string {
        const extension = vscode.extensions.getExtension('vicanent.gcmp');
        if (!extension) {
            // 极端情况（扩展未注册），回退到 __dirname 推算
            return path.join(__dirname, '..', 'ui');
        }
        return path.join(extension.extensionPath, 'dist', 'ui');
    }

    /**
     * 将 CompatibleModelConfig 转换为前端表单数据（拍平 capabilities + 序列化 JSON 字段）
     */
    private static modelConfigToFormData(model: CompatibleModelConfig): ModelFormData {
        return {
            id: model?.id || '',
            name: model?.name || '',
            provider: model?.provider || '',
            tooltip: model?.tooltip || '',
            baseUrl: model?.baseUrl || '',
            endpoint: model?.endpoint || '',
            modelsEndpoint: model?.modelsEndpoint || '',
            proxy: model?.proxy || '',
            apiKey: '',
            model: model?.model || '',
            sdkMode: model?.sdkMode || 'openai',
            maxInputTokens: model?.maxInputTokens || 128000,
            maxOutputTokens: model?.maxOutputTokens || 4096,
            toolCalling: model?.capabilities?.toolCalling || false,
            imageInput: model?.capabilities?.imageInput || false,
            useInstructions: model?.useInstructions,
            webSearchTool: model?.webSearchTool,
            reasoningEffort: model?.reasoningEffort || [],
            reasoningDefault: model?.reasoningDefault || '',
            customHeader: model?.customHeader ? JSON.stringify(model.customHeader, null, 2) : '',
            extraBody: model?.extraBody ? JSON.stringify(model.extraBody, null, 2) : ''
        };
    }

    /**
     * 发送提供商列表给 webview
     */
    private static sendProvidersList(webview: vscode.Webview): void {
        const providersMap = new Map<string, ProviderOption>();

        Object.entries(configProviders).forEach(([key, config]) => {
            providersMap.set(key, {
                id: key,
                name: config.displayName || key
            });
        });

        Object.entries(KnownProviders).forEach(([key, config]) => {
            providersMap.set(key, {
                id: key,
                name: config.displayName || key,
                baseUrls: this.getKnownProviderBaseUrls(config)
            });
        });

        webview.postMessage({
            command: 'setProviders',
            providers: Array.from(providersMap.values())
        });
    }

    private static getKnownProviderBaseUrls(
        config: (typeof KnownProviders)[keyof typeof KnownProviders]
    ): ProviderOption['baseUrls'] {
        const baseUrls: NonNullable<ProviderOption['baseUrls']> = {};

        if (config.openai?.baseUrl) {
            baseUrls.openai = config.openai.baseUrl;
            baseUrls['openai-sse'] = config.openai.baseUrl;
            baseUrls['openai-responses'] = config.openai.baseUrl;
        }
        if (config.anthropic?.baseUrl) {
            baseUrls.anthropic = config.anthropic.baseUrl;
        }

        return Object.keys(baseUrls).length > 0 ? baseUrls : undefined;
    }

    /**
     * 从 API 获取模型列表
     */
    private static async fetchModelsFromAPI(
        webview: vscode.Webview,
        baseUrl: string,
        modelsEndpoint: string | undefined,
        apiKey: string | undefined,
        provider: string | undefined,
        proxy: string | undefined
    ): Promise<void> {
        try {
            if (!baseUrl || !baseUrl.trim()) {
                webview.postMessage({
                    command: 'modelsError',
                    error: t('Enter BASE URL first.', '请先输入 BASE URL')
                });
                return;
            }

            const modelsUrlResult = this.resolveModelsUrl(baseUrl, modelsEndpoint);
            if (!modelsUrlResult.ok) {
                webview.postMessage({ command: 'modelsError', error: modelsUrlResult.error });
                return;
            }

            const modelsUrl = modelsUrlResult.url;
            webview.postMessage({ command: 'modelsLoading' });

            const headers: Record<string, string> = {
                'Content-Type': 'application/json',
                'User-Agent': VersionManager.getUserAgent('ModelEditor')
            };

            let effectiveApiKey = apiKey;
            if (!effectiveApiKey && provider) {
                effectiveApiKey = await ApiKeyManager.getApiKey(provider);
            }
            if (effectiveApiKey && effectiveApiKey.trim()) {
                headers['Authorization'] = `Bearer ${effectiveApiKey.trim()}`;
            }

            const proxyOptions = proxy ? { proxyUrl: proxy } : { providerKey: provider };
            const response = await ConfigManager.fetchWithProxy(modelsUrl, { method: 'GET', headers }, proxyOptions);

            if (!response.ok) {
                throw new Error(`HTTP ${response.status}: ${response.statusText}`);
            }

            const responseData = (await response.json()) as
                | OpenAI.Models.ModelsPage
                | { models: OpenAI.Models.Model[] | string[] }
                | OpenAI.Models.Model[]
                | string[];

            let models: string[] = [];
            if ('data' in responseData && Array.isArray(responseData.data)) {
                models = responseData.data
                    .filter((item): item is OpenAI.Models.Model => !!item?.id)
                    .map(item => item.id);
            } else if (Array.isArray(responseData)) {
                models = responseData
                    .filter((item): item is string | OpenAI.Models.Model => typeof item === 'string' || !!item?.id)
                    .map(item => (typeof item === 'string' ? item : item.id));
            } else if ('models' in responseData && Array.isArray(responseData.models)) {
                models = responseData.models
                    .filter((item): item is string | OpenAI.Models.Model => typeof item === 'string' || !!item?.id)
                    .map(item => (typeof item === 'string' ? item : item.id));
            }

            webview.postMessage({ command: 'modelsLoaded', models });
        } catch (error) {
            const errorMessage = error instanceof Error ? error.message : t('Unknown error', '未知错误');
            webview.postMessage({
                command: 'modelsError',
                error: t('Failed to fetch model list: {0}', '获取模型列表失败: {0}', errorMessage)
            });
        }
    }

    private static resolveModelsUrl(baseUrl: string, modelsEndpoint?: string): EndpointResolution {
        const normalizedBaseUrl = baseUrl.trim().replace(/\/+$/, '');
        const normalizedModelsEndpoint = modelsEndpoint?.trim();

        if (!normalizedModelsEndpoint) {
            return { ok: true, url: `${normalizedBaseUrl}/models` };
        }

        if (normalizedModelsEndpoint.startsWith('http://') || normalizedModelsEndpoint.startsWith('https://')) {
            try {
                const modelsUrl = new URL(normalizedModelsEndpoint);
                if (modelsUrl.protocol !== 'http:' && modelsUrl.protocol !== 'https:') {
                    return {
                        ok: false,
                        error: t(
                            'Models endpoint must start with http:// or https://.',
                            '模型列表端点必须以 http:// 或 https:// 开头'
                        )
                    };
                }
                return { ok: true, url: modelsUrl.toString().replace(/\/+$/, '') };
            } catch {
                return {
                    ok: false,
                    error: t(
                        'Models endpoint is invalid. Enter a valid URL or path.',
                        '模型列表端点格式不正确，请输入有效的 URL 或路径'
                    )
                };
            }
        }

        return {
            ok: true,
            url: `${normalizedBaseUrl}${normalizedModelsEndpoint.startsWith('/') ? '' : '/'}${normalizedModelsEndpoint}`
        };
    }
}
