/**
 * Model Editor 事件绑定
 * 对应旧 modelEditor.js 的 bindEvents
 */

import type { EditorState } from '../app';
import { t } from '../l10n';
import { CLI_RESERVED_PROVIDERS, type ProviderOption } from '../types';
import { addNumberValidation, addSimpleValidation, normalizeProxyInput, isValidProxyInput } from '../utils';
import { formatJSON, clearJSON, validateJSON_UI, autofillBaseUrl } from '../app';
import { validateForm, showGlobalError, hideGlobalError } from './validation';
import { applyInitialValues } from './form';

interface Actions {
    saveModel: () => void;
    deleteModel: () => void;
    cancelEdit: () => void;
    fetchModelsFromAPI: () => void;
}

/**
 * 绑定所有事件
 */
export function bindEvents(state: EditorState, actions: Actions): void {
    // 应用 provider/requestModel 的初始值（input.value 通过属性赋值会被清空）
    applyInitialValues(state);

    const modelId = document.getElementById('modelId') as HTMLInputElement | null;
    const modelName = document.getElementById('modelName') as HTMLInputElement | null;
    const provider = document.getElementById('provider') as HTMLInputElement | null;
    const baseUrl = document.getElementById('baseUrl') as HTMLInputElement | null;
    const endpoint = document.getElementById('endpoint') as HTMLInputElement | null;
    const modelsEndpoint = document.getElementById('modelsEndpoint') as HTMLInputElement | null;
    const maxInputTokens = document.getElementById('maxInputTokens') as HTMLInputElement | null;
    const maxOutputTokens = document.getElementById('maxOutputTokens') as HTMLInputElement | null;

    // 必填字段实时校验
    if (modelId && !modelId.readOnly) {
        addSimpleValidation(modelId);
    }
    if (modelName) {
        addSimpleValidation(modelName);
    }
    if (provider) {
        addSimpleValidation(provider);
    }

    // baseUrl 必填 + URL 格式校验
    baseUrl?.addEventListener('input', function (this: HTMLInputElement) {
        const value = this.value.trim();
        if (!value) {
            this.classList.add('invalid');
            return;
        }
        try {
            const urlObj = new URL(value);
            if (urlObj.protocol === 'http:' || urlObj.protocol === 'https:') {
                this.classList.remove('invalid');
            } else {
                this.classList.add('invalid');
            }
        } catch {
            this.classList.add('invalid');
        }
    });

    [endpoint, modelsEndpoint].forEach(input => {
        input?.addEventListener('input', function (this: HTMLInputElement) {
            const value = this.value.trim();
            if (!value) {
                this.classList.remove('invalid');
                return;
            }
            if (value.startsWith('http://') || value.startsWith('https://')) {
                try {
                    const urlObj = new URL(value);
                    if (urlObj.protocol === 'http:' || urlObj.protocol === 'https:') {
                        this.classList.remove('invalid');
                    } else {
                        this.classList.add('invalid');
                    }
                } catch {
                    this.classList.add('invalid');
                }
                return;
            }
            this.classList.remove('invalid');
        });
    });

    if (maxInputTokens) {
        addNumberValidation(maxInputTokens);
    }
    if (maxOutputTokens) {
        addNumberValidation(maxOutputTokens);
    }

    // JSON 验证事件 + 工具栏按钮
    ['customHeader', 'extraBody'].forEach(fieldId => {
        const textarea = document.getElementById(fieldId) as HTMLTextAreaElement | null;
        textarea?.addEventListener('input', () => validateJSON_UI(fieldId));
        textarea?.addEventListener('change', () => validateJSON_UI(fieldId));
    });

    document.querySelectorAll<HTMLButtonElement>('.json-format-btn').forEach(btn => {
        btn.addEventListener('click', e => {
            e.preventDefault();
            formatJSON(btn.dataset.target || '');
        });
    });
    document.querySelectorAll<HTMLButtonElement>('.json-clear-btn').forEach(btn => {
        btn.addEventListener('click', e => {
            e.preventDefault();
            clearJSON(btn.dataset.target || '');
        });
    });

    // Provider 输入联想 + CLI 保留字校验
    const providerInput = document.getElementById('provider') as HTMLInputElement | null;
    const providerList = document.getElementById('providerList');
    if (providerInput && providerList) {
        providerInput.value = state.model.provider;

        providerInput.addEventListener('input', function (this: HTMLInputElement) {
            const searchText = this.value.toLowerCase();
            if (CLI_RESERVED_PROVIDERS.some(reserved => reserved.toLowerCase() === searchText)) {
                this.classList.add('invalid');
                showGlobalError(
                    t(
                        'Provider "{0}" is reserved for CLI use and cannot be used for custom models.',
                        '提供商 "{0}" 为 CLI 专用，不可在自定义模型中使用',
                        this.value
                    )
                );
            } else if (searchText) {
                this.classList.remove('invalid');
                hideGlobalError();
                const filtered = state.providers.filter(
                    (p: { id: string; name: string }) =>
                        p.id.toLowerCase().includes(searchText) || p.name.toLowerCase().includes(searchText)
                );
                renderProviderList(filtered);
                providerList.classList.add('show');
            } else {
                this.classList.remove('invalid');
                hideGlobalError();
                providerList.classList.remove('show');
            }
        });

        providerInput.addEventListener('focus', function (this: HTMLInputElement) {
            if (state.providers.length > 0) {
                renderProviderList(state.providers);
                providerList.classList.add('show');
            }
        });

        document.addEventListener('click', event => {
            const target = event.target as HTMLElement;
            // provider 与 modelsEndpoint 都复用 .provider-dropdown 类，需分别按 id 精确判断
            if (!target.closest('#provider') && !target.closest('#providerList')) {
                providerList.classList.remove('show');
            }
        });
    }

    // Models Endpoint 预设下拉：聚焦即展开，点击选项填入输入框
    const modelsEndpointInput = document.getElementById('modelsEndpoint') as HTMLInputElement | null;
    const modelsEndpointList = document.getElementById('modelsEndpointList');
    if (modelsEndpointInput && modelsEndpointList) {
        modelsEndpointInput.addEventListener('focus', () => {
            modelsEndpointList.classList.add('show');
        });
        modelsEndpointList.addEventListener('click', event => {
            const item = (event.target as HTMLElement).closest('.provider-list-item') as HTMLElement | null;
            if (item && item.dataset.value !== undefined) {
                modelsEndpointInput.value = item.dataset.value || '';
                modelsEndpointInput.classList.remove('invalid');
                modelsEndpointList.classList.remove('show');
            }
        });
        document.addEventListener('click', event => {
            const target = event.target as HTMLElement;
            if (!target.closest('#modelsEndpoint') && !target.closest('#modelsEndpointList')) {
                modelsEndpointList.classList.remove('show');
            }
        });
    }

    // SDK 模式切换 - 控制特定选项显示
    const sdkModeSelect = document.getElementById('sdkMode') as HTMLSelectElement | null;
    const useInstructionsContainer = document
        .getElementById('useInstructions')
        ?.closest('.form-group') as HTMLElement | null;
    const webSearchToolContainer = document
        .getElementById('webSearchTool')
        ?.closest('.form-group') as HTMLElement | null;
    if (sdkModeSelect && useInstructionsContainer && webSearchToolContainer) {
        const updateSdkSpecificOptionsVisibility = function () {
            useInstructionsContainer.style.display = sdkModeSelect.value === 'openai-responses' ? '' : 'none';
            webSearchToolContainer.style.display = sdkModeSelect.value === 'anthropic' ? '' : 'none';
        };
        sdkModeSelect.addEventListener('change', updateSdkSpecificOptionsVisibility);
        updateSdkSpecificOptionsVisibility();
    }

    // 请求模型 ID 输入联想
    const requestModelInput = document.getElementById('requestModel') as HTMLInputElement | null;
    const modelList = document.getElementById('modelList');
    const fetchModelsButton = document.getElementById('fetchModelsButton');
    if (requestModelInput && modelList) {
        requestModelInput.value = state.model.model;

        requestModelInput.addEventListener('focus', () => {
            fetchModelsButton?.classList.add('input-focused');
        });
        requestModelInput.addEventListener('blur', () => {
            fetchModelsButton?.classList.remove('input-focused');
        });

        requestModelInput.addEventListener('input', function (this: HTMLInputElement) {
            const searchText = this.value.toLowerCase();
            if (searchText && state.availableModels.length > 0) {
                const filtered = state.availableModels.filter((m: string) => m.toLowerCase().includes(searchText));
                renderModelList(filtered);
                modelList.classList.add('show');
            } else if (state.availableModels.length > 0) {
                renderModelList(state.availableModels);
                modelList.classList.add('show');
            } else {
                modelList.classList.remove('show');
            }
        });

        requestModelInput.addEventListener('focus', () => {
            if (state.availableModels.length > 0) {
                renderModelList(state.availableModels);
                modelList.classList.add('show');
            }
        });

        requestModelInput.addEventListener('keydown', event => {
            if (event.key === 'Enter') {
                event.preventDefault();
                modelList.classList.remove('show');
            }
        });

        document.addEventListener('click', event => {
            if (!(event.target as HTMLElement).closest('.model-dropdown')) {
                modelList.classList.remove('show');
            }
        });
    }

    // Fetch Models 按钮
    document.getElementById('fetchModelsButton')?.addEventListener('click', () => {
        actions.fetchModelsFromAPI();
    });

    // 全局错误提示关闭按钮
    document.getElementById('globalErrorClose')?.addEventListener('click', hideGlobalError);

    // 底部按钮
    document.getElementById('saveButton')?.addEventListener('click', () => actions.saveModel());
    document.getElementById('cancelButton')?.addEventListener('click', () => actions.cancelEdit());
    document.getElementById('deleteButton')?.addEventListener('click', () => actions.deleteModel());
}

// ============= 列表渲染（局部） =============

function renderProviderList(providers: ProviderOption[]): void {
    const providerListDiv = document.getElementById('providerList');
    const input = document.getElementById('provider') as HTMLInputElement | null;
    if (!providerListDiv || !input) {
        return;
    }
    const currentValue = input.value;
    providerListDiv.innerHTML = '';

    if (!providers || providers.length === 0) {
        const item = document.createElement('div');
        item.className = 'provider-list-item';
        item.textContent = t('No matching providers', '无匹配的提供商');
        item.style.pointerEvents = 'none';
        item.style.opacity = '0.5';
        providerListDiv.appendChild(item);
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
            providerListDiv.classList.remove('show');
        });
        providerListDiv.appendChild(item);
    });
}

function renderModelList(models: string[]): void {
    const modelListDiv = document.getElementById('modelList');
    const input = document.getElementById('requestModel') as HTMLInputElement | null;
    if (!modelListDiv || !input) {
        return;
    }
    const currentValue = input.value;
    modelListDiv.innerHTML = '';

    if (!models || models.length === 0) {
        const item = document.createElement('div');
        item.className = 'model-list-item';
        item.textContent = t('No available models', '无可用模型');
        item.style.pointerEvents = 'none';
        item.style.opacity = '0.5';
        modelListDiv.appendChild(item);
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
            modelListDiv.classList.remove('show');
        });
        modelListDiv.appendChild(item);
    });
}

// 引用以避免未使用告警
void normalizeProxyInput;
void isValidProxyInput;
void validateForm;
