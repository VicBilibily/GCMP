/**
 * Auxiliary Model Settings WebView 前端入口
 */

import './style.less';
import type { HostMessage, WebViewMessage, AuxiliaryProviderData, FormValues } from './types';
import { createElement, t } from './utils';

// ============= 全局状态 =============

interface State {
    providers: AuxiliaryProviderData[];
    values: FormValues;
}

const state: State = {
    providers: [],
    values: {
        commit: null,
        vision: null,
        utility: null,
        utilitySmall: null,
        agent: null
    }
};

/** 操作栏消息元素的引用，由 createActions 创建后缓存 */
let actionMessageEl: HTMLElement | null = null;

// ============= 工具函数 =============

function postToVSCode(message: WebViewMessage): void {
    window.vscode.postMessage(message);
}

function getModelsByProvider(providerKey: string): AuxiliaryProviderData | undefined {
    return state.providers.find(p => p.key === providerKey);
}

function createProviderSelect(
    currentProvider: string,
    onChange: (providerKey: string) => void,
    allowEmpty?: boolean
): HTMLSelectElement {
    const select = createElement('select', 'ams-select') as HTMLSelectElement;
    if (allowEmpty) {
        const empty = createElement('option') as HTMLOptionElement;
        empty.value = '';
        empty.textContent = t('Not set', '未设置');
        select.appendChild(empty);
    }
    for (const provider of state.providers) {
        const option = createElement('option') as HTMLOptionElement;
        option.value = provider.key;
        option.textContent = provider.displayName;
        select.appendChild(option);
    }
    select.value = currentProvider;
    select.addEventListener('change', () => onChange(select.value));
    return select;
}

function createModelSelect(
    providerKey: string,
    currentModel: string,
    filter: (model: { hasToolCalling: boolean; hasImageInput: boolean }) => boolean,
    onChange: (modelId: string) => void
): HTMLSelectElement {
    const select = createElement('select', 'ams-select') as HTMLSelectElement;
    const empty = createElement('option') as HTMLOptionElement;
    empty.value = '';
    empty.textContent = t('Select a model', '选择模型');
    select.appendChild(empty);

    const provider = getModelsByProvider(providerKey);
    if (provider) {
        for (const model of provider.models) {
            if (!filter(model)) {
                continue;
            }
            const option = createElement('option') as HTMLOptionElement;
            option.value = model.id;
            option.textContent = model.name;
            select.appendChild(option);
        }
    }
    select.value = currentModel;
    select.disabled = !providerKey;
    select.addEventListener('change', () => onChange(select.value));
    return select;
}

function updateModelSelect(
    row: HTMLElement,
    providerKey: string,
    modelKey: keyof FormValues,
    filter: (model: { hasToolCalling: boolean; hasImageInput: boolean }) => boolean
): void {
    const modelSelectContainer = row.querySelector('.ams-model-select') as HTMLElement;
    if (!modelSelectContainer) {
        return;
    }
    modelSelectContainer.innerHTML = '';
    const currentValue = state.values[modelKey];
    const modelSelect = createModelSelect(
        providerKey,
        currentValue?.provider === providerKey ? currentValue.model : '',
        filter,
        modelId => {
            if (modelId && providerKey) {
                state.values[modelKey] = { provider: providerKey, model: modelId };
            } else if (!modelId && providerKey) {
                state.values[modelKey] = { provider: providerKey, model: '' };
            } else {
                state.values[modelKey] = null;
            }
        }
    );
    modelSelectContainer.appendChild(modelSelect);
}

// ============= 渲染 =============

function render(): void {
    const root = document.getElementById('app');
    if (!root) {
        return;
    }
    root.innerHTML = '';

    root.appendChild(createHeader());
    root.appendChild(createForm());
    root.appendChild(createActions());
}

function createHeader(): HTMLElement {
    const header = createElement('div', 'ams-header');
    const title = createElement('h2');
    title.textContent = t('Auxiliary Model Settings', '辅助工具模型设置');
    const subtitle = createElement('p', 'ams-subtitle');
    subtitle.textContent = t(
        'Configure models used by GCMP features and Copilot internal routes.',
        '配置 GCMP 功能与 Copilot 内部路由使用的模型。'
    );
    header.appendChild(title);
    header.appendChild(subtitle);
    return header;
}

function createForm(): HTMLElement {
    const form = createElement('form', 'ams-form');

    // 插件辅助模型组
    form.appendChild(createGroupTitle(t('GCMP Auxiliary Models', '插件辅助模型')));
    form.appendChild(
        createModelRow(
            'commit',
            t('Commit Message Model', '提交消息模型'),
            t('Used for generating commit messages.', '用于生成提交消息。')
        )
    );
    form.appendChild(
        createModelRow(
            'vision',
            t('Vision Analysis Model', '视觉分析模型'),
            t('Used for image / screenshot analysis.', '用于图像 / 截图分析。'),
            m => m.hasImageInput
        )
    );

    // Copilot 辅助模型组
    form.appendChild(createGroupTitle(t('Copilot Auxiliary Models', 'Copilot 辅助模型')));
    form.appendChild(
        createModelRow(
            'utility',
            t('Utility Model', '通用辅助模型'),
            t('Used for settings-resolver, explain-code, vscode-qa, etc.', '用于设置搜索、代码解释、VS Code 问答等。'),
            () => true,
            t(
                'Recommendation: use a capable general-purpose model with tool calling (e.g. DeepSeek-V4-Pro, GLM-5.2, GLM-4.7, Kimi-K2.7-Code).',
                '建议：选择具备工具调用能力的高级主力模型（如 DeepSeek-V4-Pro、GLM-5.2、GLM-4.7、Kimi-K2.7-Code）。'
            )
        )
    );
    form.appendChild(
        createModelRow(
            'utilitySmall',
            t('Utility Small Model', '轻量辅助模型'),
            t(
                'Used for chat-title, git-commit-message, prompt-categorizer, etc.',
                '用于标题生成、提交消息、意图分类等。'
            ),
            () => true,
            t(
                'Recommendation: use a fast and cost-efficient model (e.g. DeepSeek-V4-Flash, GLM-4.7-Flash, MiniMax-M2.5, Qwen3.6-Flash).',
                '建议：选择响应快、成本低的轻量模型（如 DeepSeek-V4-Flash、GLM-4.7-Flash、MiniMax-M2.5、Qwen3.6-Flash）。'
            )
        )
    );
    form.appendChild(
        createModelRow(
            'agent',
            t('Agent Model (Unified)', 'Agent 模型（统一）'),
            t(
                'Used for Plan / Explore / Ask / Implement agents and inline chat.',
                '用于 Plan / Explore / Ask / Implement Agent 以及内联聊天。'
            ),
            () => true,
            t(
                'Recommendation: use a strong reasoning model with tool calling (e.g. DeepSeek-V4-Pro, GLM-5.2, Kimi-K2.7-Code, Qwen3.7-Plus).',
                '建议：选择具备工具调用与强推理能力的高级模型（如 DeepSeek-V4-Pro、GLM-5.2、Kimi-K2.7-Code、Qwen3.7-Plus）。'
            )
        )
    );

    return form;
}

function createSuggestion(text: string): HTMLElement {
    const note = createElement('div', 'ams-suggestion');
    note.textContent = text;
    return note;
}

function createGroupTitle(text: string): HTMLElement {
    const title = createElement('div', 'ams-group-title');
    title.textContent = text;
    return title;
}

function createModelRow(
    key: keyof FormValues,
    label: string,
    description: string,
    filter: (model: { hasToolCalling: boolean; hasImageInput: boolean }) => boolean = () => true,
    suggestion?: string
): HTMLElement {
    const row = createElement('div', 'ams-row');
    row.dataset.key = key;

    const info = createElement('div', 'ams-row-info');
    const title = createElement('label', 'ams-row-label');
    title.textContent = label;
    const desc = createElement('div', 'ams-row-desc');
    desc.textContent = description;
    info.appendChild(title);
    info.appendChild(desc);

    if (suggestion) {
        info.appendChild(createSuggestion(suggestion));
    }

    const controls = createElement('div', 'ams-row-controls');
    const providerSelect = createProviderSelect(
        state.values[key]?.provider ?? '',
        providerKey => {
            state.values[key] = providerKey ? { provider: providerKey, model: '' } : null;
            updateModelSelect(row, providerKey, key, filter);
        },
        true
    );

    const modelSelectContainer = createElement('div', 'ams-model-select');
    const modelSelect = createModelSelect(
        state.values[key]?.provider ?? '',
        state.values[key]?.model ?? '',
        filter,
        modelId => {
            const currentProvider = state.values[key]?.provider ?? '';
            if (modelId && currentProvider) {
                state.values[key] = { provider: currentProvider, model: modelId };
            } else if (!modelId && currentProvider) {
                state.values[key] = { provider: currentProvider, model: '' };
            } else {
                state.values[key] = null;
            }
        }
    );
    modelSelectContainer.appendChild(modelSelect);

    controls.appendChild(providerSelect);
    controls.appendChild(modelSelectContainer);

    row.appendChild(info);
    row.appendChild(controls);
    return row;
}

function createActions(): HTMLElement {
    const actions = createElement('div', 'ams-actions');

    const messageEl = createElement('div', 'ams-action-message');

    const save = createElement('button', 'ams-button ams-button-primary', { type: 'button' });
    save.textContent = t('Save', '保存');
    save.addEventListener('click', () => {
        const error = validateForm();
        if (error) {
            showActionMessage(error, 'error');
            return;
        }
        showActionMessage('', 'info');
        postToVSCode({ command: 'save', values: state.values });
    });

    const cancel = createElement('button', 'ams-button ams-button-secondary', { type: 'button' });
    cancel.textContent = t('Cancel', '取消');
    cancel.addEventListener('click', () => postToVSCode({ command: 'cancel' }));

    actions.appendChild(messageEl);
    actions.appendChild(save);
    actions.appendChild(cancel);
    actionMessageEl = messageEl;
    return actions;
}

function validateForm(): string {
    const labels: Record<keyof FormValues, string> = {
        commit: t('Commit Message Model', '提交消息模型'),
        vision: t('Vision Analysis Model', '视觉分析模型'),
        utility: t('Utility Model', '通用辅助模型'),
        utilitySmall: t('Utility Small Model', '轻量辅助模型'),
        agent: t('Agent Model (Unified)', 'Agent 模型（统一）')
    };

    for (const key of Object.keys(state.values) as (keyof FormValues)[]) {
        const value = state.values[key];
        if (value && value.provider && !value.model) {
            return t('Please select a model for {0}.', '请为 {0} 选择模型。', labels[key]);
        }
    }

    return '';
}

function showActionMessage(text: string, type: 'info' | 'error'): void {
    if (!actionMessageEl) {
        return;
    }
    actionMessageEl.textContent = text;
    actionMessageEl.className = 'ams-action-message' + (type === 'error' ? ' ams-action-message-error' : '');
}

// ============= 消息处理 =============

function handleMessage(event: MessageEvent): void {
    const message = event.data as HostMessage;
    if (message.command === 'init') {
        state.providers = message.providers;
        state.values = {
            commit: message.initialValues.commit ?? null,
            vision: message.initialValues.vision ?? null,
            utility: message.initialValues.utility ?? null,
            utilitySmall: message.initialValues.utilitySmall ?? null,
            agent: message.initialValues.agent ?? null
        };
        render();
    } else if (message.command === 'saved') {
        postToVSCode({ command: 'cancel' });
    } else if (message.command === 'savedPartial') {
        // 用户取消了 Agent 统一覆盖，其他设置也未写入；保留面板打开，提示用户
        showActionMessage(
            t('Save cancelled: Copilot agent models were kept as-is.', '已取消保存：Copilot Agent 模型保持不变。'),
            'info'
        );
    } else if (message.command === 'saveError') {
        showActionMessage(message.error, 'error');
    }
}

window.addEventListener('message', handleMessage);
document.addEventListener('DOMContentLoaded', () => {
    postToVSCode({ command: 'getInitialData' });
});
