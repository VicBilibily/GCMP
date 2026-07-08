/**
 * Model Editor 前端入口
 *
 * 由 index.ts 后端通过 `window.__INITIAL_STATE__` 注入初始数据，
 * 通过 `window.__VS_CODE_LOCALE__` 注入 locale。
 *
 * 启动流程：
 * 1. 解析 INITIAL_STATE 获取 ModelFormData 与 isCreateMode
 * 2. 调用 createDOM 构建表单结构
 * 3. 调用 bindEvents 绑定事件
 * 4. 发送 ready 消息，触发后端推送 providers 列表
 * 5. 初始化 JSON 校验状态
 */

import type { HostMessage, InitialState, ModelFormData, ProviderOption } from './types';
// 样式由后端 index.ts 通过 ?raw 内联到 HTML，前端无需再 import
import { t } from './l10n';
import {
    addNumberValidation,
    addSimpleValidation,
    autoResizeAllTextareas,
    isValidJSONObject,
    normalizeProxyInput,
    parseJSON,
    postToVSCode,
    validateJSON
} from './utils';
import { createDOM } from './components/form';
import { bindEvents } from './components/events';
import { validateForm, collectFormData, showGlobalError, hideGlobalError } from './components/validation';

// ============= 全局状态 =============

export interface EditorState {
    model: ModelFormData;
    isCreateMode: boolean;
    providers: ProviderOption[];
    availableModels: string[];
    isLoadingModels: boolean;
}

declare global {
    interface Window {
        __INITIAL_STATE__?: InitialState;
        __VS_CODE_LOCALE__?: string;
    }
}

const state: EditorState = {
    model: {
        id: '',
        name: '',
        provider: '',
        tooltip: '',
        baseUrl: '',
        endpoint: '',
        modelsEndpoint: '',
        proxy: '',
        apiKey: '',
        model: '',
        sdkMode: 'openai',
        maxInputTokens: 128000,
        maxOutputTokens: 4096,
        toolCalling: false,
        imageInput: false,
        editTools: undefined,
        useInstructions: undefined,
        webSearchTool: undefined,
        reasoningEffort: [],
        reasoningDefault: '',
        tokenPricing: '',
        customHeader: '',
        extraBody: ''
    },
    isCreateMode: false,
    providers: [],
    availableModels: [],
    isLoadingModels: false
};

// ============= 初始化入口 =============

function initializeEditor(): void {
    const initial = window.__INITIAL_STATE__;
    if (!initial) {
        console.error('[ModelEditor] Missing __INITIAL_STATE__');
        return;
    }

    state.model = initial.model;
    state.isCreateMode = initial.isCreateMode;
    createDOM(state);
    bindEvents(state, { saveModel, deleteModel, cancelEdit, fetchModelsFromAPI });
    autoResizeAllTextareas();
    validateJSON_UI('customHeader');
    validateJSON_UI('extraBody');

    postToVSCode({ command: 'ready' });

    window.addEventListener('message', event => {
        const message = event.data as HostMessage;
        handleMessage(message);
    });
}

// ============= 后端消息处理 =============

function handleMessage(message: HostMessage): void {
    switch (message.command) {
        case 'setProviders':
            state.providers = message.providers;
            renderProviderList(state.providers);
            break;
        case 'modelsLoading':
            handleModelsLoading();
            break;
        case 'modelsLoaded':
            handleModelsLoaded(message.models);
            break;
        case 'modelsError':
            handleModelsError(message.error);
            break;
    }
}

// ============= 操作动作（委托给 events） =============

function saveModel(): void {
    hideGlobalError();
    if (!validateForm()) {
        return;
    }
    const formData = collectFormData(state);
    if (!formData) {
        showGlobalError(t('Model configuration is incomplete. Try again.', '模型配置不完整，请重试'));
        return;
    }
    postToVSCode({ command: 'save', model: formData });
}

function deleteModel(): void {
    postToVSCode({
        command: 'delete',
        modelId: state.model.id,
        modelName: state.model.name
    });
}

function cancelEdit(): void {
    postToVSCode({ command: 'cancel' });
}

function fetchModelsFromAPI(): void {
    const baseUrl = (document.getElementById('baseUrl') as HTMLInputElement).value.trim();
    const modelsEndpoint = (document.getElementById('modelsEndpoint') as HTMLInputElement).value.trim();
    const proxy = normalizeProxyInput((document.getElementById('proxy') as HTMLInputElement).value);
    const apiKey = (document.getElementById('apiKey') as HTMLInputElement).value.trim();
    const provider = (document.getElementById('provider') as HTMLInputElement).value.trim();

    if (!baseUrl) {
        showGlobalError(t('Enter BASE URL first.', '请先输入 BASE URL'));
        return;
    }
    try {
        const urlObj = new URL(baseUrl);
        if (urlObj.protocol !== 'http:' && urlObj.protocol !== 'https:') {
            showGlobalError(
                t('BASE URL must start with http:// or https://.', 'BASE URL 必须以 http:// 或 https:// 开头')
            );
            return;
        }
    } catch {
        showGlobalError(t('BASE URL is invalid. Enter a valid URL.', 'BASE URL 格式不正确，请输入有效的 URL'));
        return;
    }

    if (modelsEndpoint && (modelsEndpoint.startsWith('http://') || modelsEndpoint.startsWith('https://'))) {
        try {
            const urlObj = new URL(modelsEndpoint);
            if (urlObj.protocol !== 'http:' && urlObj.protocol !== 'https:') {
                showGlobalError(
                    t(
                        'Models endpoint must start with http:// or https://.',
                        '模型列表端点必须以 http:// 或 https:// 开头'
                    )
                );
                return;
            }
        } catch {
            showGlobalError(
                t(
                    'Models endpoint is invalid. Enter a valid URL or path.',
                    '模型列表端点格式不正确，请输入有效的 URL 或路径'
                )
            );
            return;
        }
    }

    postToVSCode({
        command: 'fetchModels',
        baseUrl,
        modelsEndpoint: modelsEndpoint || '',
        apiKey: apiKey || '',
        provider: provider || '',
        proxy: proxy || ''
    });
}

// ============= 模型列表加载回调 =============

function handleModelsLoading(): void {
    state.isLoadingModels = true;
    const button = document.getElementById('fetchModelsButton') as HTMLButtonElement | null;
    const statusDiv = document.getElementById('modelFetchStatus');
    const spinner = button?.querySelector('.fetch-spinner');
    if (button) {
        button.disabled = true;
    }
    button?.classList.add('loading');
    if (spinner) {
        (spinner as HTMLElement).style.display = 'inline-block';
    }
    if (statusDiv) {
        statusDiv.textContent = t('Fetching model list...', '正在获取模型列表...');
        statusDiv.className = 'model-fetch-status loading';
        statusDiv.style.display = 'block';
    }
    hideGlobalError();
}

function handleModelsLoaded(models: string[]): void {
    state.isLoadingModels = false;
    const button = document.getElementById('fetchModelsButton') as HTMLButtonElement | null;
    const statusDiv = document.getElementById('modelFetchStatus');
    const spinner = button?.querySelector('.fetch-spinner');
    if (button) {
        button.disabled = false;
    }
    button?.classList.remove('loading');
    if (spinner) {
        (spinner as HTMLElement).style.display = 'none';
    }

    if (models && models.length > 0) {
        state.availableModels = models;
        if (statusDiv) {
            statusDiv.textContent = t('Fetched {0} models successfully', '成功获取 {0} 个模型', models.length);
            statusDiv.className = 'model-fetch-status success';
            statusDiv.style.display = 'block';
        }
        renderModelList(state.availableModels);
        document.getElementById('modelList')?.classList.add('show');
        setTimeout(() => {
            if (statusDiv) {
                statusDiv.style.display = 'none';
            }
        }, 3000);
    } else {
        state.availableModels = [];
        if (statusDiv) {
            statusDiv.textContent = t('No available models found', '未找到可用模型');
            statusDiv.className = 'model-fetch-status warning';
            statusDiv.style.display = 'block';
        }
        setTimeout(() => {
            if (statusDiv) {
                statusDiv.style.display = 'none';
            }
        }, 3000);
    }
}

function handleModelsError(error: string): void {
    state.isLoadingModels = false;
    const button = document.getElementById('fetchModelsButton') as HTMLButtonElement | null;
    const statusDiv = document.getElementById('modelFetchStatus');
    const spinner = button?.querySelector('.fetch-spinner');
    if (button) {
        button.disabled = false;
    }
    button?.classList.remove('loading');
    if (spinner) {
        (spinner as HTMLElement).style.display = 'none';
    }
    if (statusDiv) {
        statusDiv.textContent = error || t('Failed to fetch model list', '获取模型列表失败');
        statusDiv.className = 'model-fetch-status error';
        statusDiv.style.display = 'block';
    }
    setTimeout(() => {
        if (statusDiv) {
            statusDiv.style.display = 'none';
        }
    }, 5000);
}

// ============= 列表渲染 =============

function getProviderDefaultBaseUrl(provider: ProviderOption): string | undefined {
    const sdkModeSelect = document.getElementById('sdkMode') as HTMLSelectElement | null;
    const sdkMode = (sdkModeSelect?.value || 'openai') as ModelFormData['sdkMode'];
    const baseUrls = provider.baseUrls;

    if (!baseUrls) {
        return undefined;
    }

    if (sdkMode === 'openai-sse' || sdkMode === 'openai-responses') {
        return baseUrls[sdkMode] || baseUrls.openai;
    }

    return baseUrls[sdkMode];
}

/**
 * 选中提供商时，若 BASE URL 为空或仍为自动回填值，则按当前 SDK 模式自动回填默认地址
 */
export function autofillBaseUrl(provider: ProviderOption, preserveWhenMissing = false): void {
    const baseUrlInput = document.getElementById('baseUrl') as HTMLInputElement | null;
    if (!baseUrlInput) {
        return;
    }

    const defaultBaseUrl = getProviderDefaultBaseUrl(provider);
    if (!defaultBaseUrl) {
        if (!preserveWhenMissing && baseUrlInput.dataset.autofilled === 'true') {
            baseUrlInput.value = '';
            baseUrlInput.classList.add('invalid');
            delete baseUrlInput.dataset.autofilled;
            delete baseUrlInput.dataset.autofilledValue;
        }
        return;
    }

    if (!baseUrlInput.value.trim() || baseUrlInput.dataset.autofilled === 'true') {
        baseUrlInput.value = defaultBaseUrl;
        baseUrlInput.classList.remove('invalid');
        baseUrlInput.dataset.autofilled = 'true';
        baseUrlInput.dataset.autofilledValue = defaultBaseUrl;
    }
}

function renderProviderList(providers: ProviderOption[]): void {
    const list = document.getElementById('providerList');
    const input = document.getElementById('provider') as HTMLInputElement | null;
    if (!list || !input) {
        return;
    }
    const currentValue = input.value;
    list.innerHTML = '';

    if (!providers || providers.length === 0) {
        const item = document.createElement('div');
        item.className = 'provider-list-item';
        item.textContent = t('No matching providers', '无匹配的提供商');
        item.style.pointerEvents = 'none';
        item.style.opacity = '0.5';
        list.appendChild(item);
        return;
    }

    providers.forEach(provider => {
        const item = document.createElement('div');
        item.className = 'provider-list-item';
        if (provider.id === currentValue) {
            item.classList.add('selected');
        }
        item.textContent = `${provider.name} (${provider.id})`;
        item.addEventListener('click', () => {
            input.value = provider.id;
            input.classList.remove('invalid');
            autofillBaseUrl(provider);
            list.classList.remove('show');
        });
        list.appendChild(item);
    });
}

function renderModelList(models: string[]): void {
    const list = document.getElementById('modelList');
    const input = document.getElementById('requestModel') as HTMLInputElement | null;
    if (!list || !input) {
        return;
    }
    const currentValue = input.value;
    list.innerHTML = '';

    if (!models || models.length === 0) {
        const item = document.createElement('div');
        item.className = 'model-list-item';
        item.textContent = t('No available models', '无可用模型');
        item.style.pointerEvents = 'none';
        item.style.opacity = '0.5';
        list.appendChild(item);
        return;
    }

    models.forEach(model => {
        const item = document.createElement('div');
        item.className = 'model-list-item';
        if (model === currentValue) {
            item.classList.add('selected');
        }
        item.textContent = model;
        item.addEventListener('click', () => {
            input.value = model;
            list.classList.remove('show');
        });
        list.appendChild(item);
    });
}

// ============= JSON 校验 UI 反馈 =============

export function validateJSON_UI(fieldId: string): boolean {
    const textarea = document.getElementById(fieldId) as HTMLTextAreaElement | null;
    const statusDiv = document.getElementById(`${fieldId}Status`);
    const statusText = document.getElementById(`${fieldId}StatusText`);
    const errorDiv = document.getElementById(`${fieldId}Error`);
    const content = textarea?.value.trim() || '';

    textarea?.classList.remove('json-valid', 'json-invalid');
    errorDiv?.classList.remove('show');

    if (!content) {
        const indicator = statusDiv?.querySelector('.json-status-indicator');
        if (indicator) {
            indicator.className = 'json-status-indicator';
        }
        if (statusText) {
            statusText.textContent = t('Empty', '无内容');
        }
        return true;
    }

    try {
        const parsed = JSON.parse(content);
        if (isValidJSONObject(parsed)) {
            const indicator = statusDiv?.querySelector('.json-status-indicator');
            if (indicator) {
                indicator.className = 'json-status-indicator';
            }
            if (statusText) {
                statusText.textContent = t('Valid ✓', '有效 ✓');
            }
            return true;
        }
        textarea?.classList.add('json-invalid');
        const indicator = statusDiv?.querySelector('.json-status-indicator');
        if (indicator) {
            indicator.className = 'json-status-indicator invalid';
        }
        if (statusText) {
            statusText.textContent = t('Invalid ✗', '无效 ✗');
        }
        if (errorDiv) {
            errorDiv.textContent = t(
                'Must be an object (for example {"key": "value"}), not an array, number, or string.',
                '必须是对象类型（如 {"key": "value"}），不能是数组、数字或字符串'
            );
            errorDiv.classList.add('show');
        }
        return false;
    } catch (e) {
        textarea?.classList.add('json-invalid');
        const indicator = statusDiv?.querySelector('.json-status-indicator');
        if (indicator) {
            indicator.className = 'json-status-indicator invalid';
        }
        if (statusText) {
            statusText.textContent = t('Invalid ✗', '无效 ✗');
        }
        if (errorDiv) {
            errorDiv.textContent = t('Error: {0}', '错误: {0}', (e as Error).message);
            errorDiv.classList.add('show');
        }
        return false;
    }
}

// 暴露给 events 模块的 JSON 操作
export function formatJSON(fieldId: string): void {
    const textarea = document.getElementById(fieldId) as HTMLTextAreaElement | null;
    if (!textarea) {
        return;
    }
    const content = textarea.value.trim();
    if (!content) {
        showGlobalError(t('There is no content to format.', '没有内容可以格式化'));
        return;
    }
    try {
        const parsed = JSON.parse(content);
        if (!isValidJSONObject(parsed)) {
            showGlobalError(
                t(
                    'Invalid JSON: it must be an object (for example {"key": "value"}), not an array, number, or string.',
                    'JSON格式错误：必须是对象类型（如 {"key": "value"}），不能是数组、数字或字符串'
                )
            );
            return;
        }
        textarea.value = JSON.stringify(parsed, null, 2);
        validateJSON_UI(fieldId);
        import('./utils').then(({ autoResizeTextarea }) => autoResizeTextarea(textarea));
        textarea.style.opacity = '0.7';
        setTimeout(() => (textarea.style.opacity = '1'), 200);
        hideGlobalError();
    } catch (e) {
        showGlobalError(
            t('Invalid JSON. Unable to format:\n{0}', 'JSON格式错误，无法格式化：\n{0}', (e as Error).message)
        );
    }
}

export function clearJSON(fieldId: string): void {
    const textarea = document.getElementById(fieldId) as HTMLTextAreaElement | null;
    if (!textarea) {
        return;
    }
    textarea.value = '';
    validateJSON_UI(fieldId);
    import('./utils').then(({ autoResizeTextarea }) => autoResizeTextarea(textarea));
}

// ============= 启动 =============

if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initializeEditor);
} else {
    initializeEditor();
}

// 导出供 components 使用
export { state, postToVSCode };
export { addSimpleValidation, addNumberValidation, parseJSON, validateJSON, normalizeProxyInput };
