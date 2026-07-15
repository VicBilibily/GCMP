/**
 * Model Editor 表单 DOM 构建
 * 对应旧 modelEditor.js 的 createDOM 及其辅助函数
 */

import type { EditorState } from '../app';
import {
    CLI_RESERVED_PROVIDERS,
    MODELS_ENDPOINT_PRESETS,
    REASONING_EFFORT_OPTIONS,
    SDK_MODE_OPTIONS,
    type ModelFormData
} from '../types';
import { t } from '../l10n';

interface CreateDomState {
    model: ModelFormData;
    isCreateMode: boolean;
}

/**
 * 创建整个表单 DOM 并挂载到指定容器（默认 #app）
 */
export function createDOM(state: CreateDomState, rootEl?: HTMLElement): void {
    const container = rootEl ?? document.getElementById('app');
    if (!container) {
        return;
    }
    container.innerHTML = '';
    const { model, isCreateMode } = state;

    const basicSection = createSection(t('Basic Info', '基本信息'), [
        createFormGroup(
            'modelId',
            isCreateMode ? t('Model ID *', '模型ID *') : t('Model ID', '模型ID'),
            'id',
            'input',
            {
                type: 'text',
                placeholder: t('e.g. zhipu:glm-4.6', '例如: zhipu:glm-4.6'),
                value: model.id,
                readonly: !isCreateMode
            },
            isCreateMode ?
                t('Unique model identifier. It cannot be changed after creation.', '模型唯一标识符，创建后不可更改')
            :   t(
                    'Unique model identifier. Editing is not supported here; edit the configuration file directly if needed.',
                    '模型唯一标识符，不支持更改，若需修改请直接编辑配置文件。'
                )
        ),
        createFormGroup(
            'modelName',
            t('Display Name *', '显示名称 *'),
            'name',
            'input',
            {
                type: 'text',
                placeholder: t('e.g. GLM-4.6 (Zhipu AI)', '例如: GLM-4.6 (智谱AI)'),
                value: model.name
            },
            t('Name shown in the model picker.', '在模型选择器中显示的名称')
        ),
        createFormGroup(
            'modelTooltip',
            t('Description', '描述'),
            'tooltip',
            'textarea',
            {
                rows: '2',
                placeholder: t('Detailed model description (optional).', '模型的详细描述（可选）'),
                value: model.tooltip
            },
            t('Tooltip shown on hover.', '悬停时显示的工具提示')
        )
    ]);

    const apiSection = createSection(t('API Settings', 'API配置'), [
        createProviderFormGroup(),
        createFormGroup(
            'sdkMode',
            t('SDK Mode', 'SDK模式'),
            'sdkMode',
            'select',
            {
                options: SDK_MODE_OPTIONS.map(opt => ({
                    value: opt.value,
                    label: t(opt.labelEn, opt.labelZh),
                    selected: model.sdkMode === opt.value
                }))
            },
            t('Compatibility mode used for model communication.', '模型通讯使用的兼容模式')
        ),
        createFormGroup(
            'baseUrl',
            'BASE URL *',
            'baseUrl',
            'input',
            {
                type: 'url',
                placeholder: t(
                    'e.g. https://api.openai.com/v1 or https://api.anthropic.com',
                    '例如：https://api.openai.com/v1 或 https://api.anthropic.com'
                ),
                value: model.baseUrl
            },
            t(
                'Base URL used for API requests. It must start with http:// or https://.\r\nFor example: https://api.openai.com/v1 or https://api.anthropic.com',
                'API请求的 baseUrl 地址，必须以 http:// 或 https:// 开头\r\n例如：https://api.openai.com/v1 或 https://api.anthropic.com'
            )
        ),
        createFormGroup(
            'endpoint',
            t('Chat Endpoint', '聊天端点'),
            'endpoint',
            'input',
            {
                type: 'text',
                placeholder: t(
                    'e.g. /chat/completions or https://api.example.com/chat/completions',
                    '例如：/chat/completions 或 https://api.example.com/chat/completions'
                ),
                value: model.endpoint || ''
            },
            t(
                'Optional custom endpoint used for chat requests. Supports either a relative path or a full URL.',
                '可选的自定义聊天请求端点。支持相对路径或完整 URL。'
            )
        ),
        createFormGroup(
            'proxy',
            t('Proxy URL', '代理 URL'),
            'proxy',
            'input',
            {
                type: 'text',
                placeholder: t(
                    'e.g. 127.0.0.1:7890, http://127.0.0.1:7890, or noproxy',
                    '例如: 127.0.0.1:7890、http://127.0.0.1:7890 或 noproxy'
                ),
                value: model.proxy || ''
            },
            t(
                'Optional proxy used for API requests and model discovery. Standard proxy URLs are supported, and protocol is optional for host:port values such as 127.0.0.1:7890. Use "noproxy" to bypass both configured and system proxies.',
                '可选的代理服务器地址。配置后会同时用于 API 请求和"获取模型"请求；标准代理 URL 可直接使用，像 127.0.0.1:7890 这样的 host:port 也可省略协议。填写"noproxy"可显式绕过已配置代理和系统代理。'
            )
        ),
        createFormGroup(
            'apiKey',
            t('API Key', 'API 密钥'),
            'apiKey',
            'input',
            {
                type: 'password',
                placeholder: t('Leave blank to keep the saved key unchanged', '留空则保持已保存的密钥不变'),
                value: model.apiKey || ''
            },
            t(
                'API key (optional). Setting it here updates the saved key automatically.',
                'API 密钥（可选）。在此设置会自动更新密钥。'
            )
        ),
        createModelsEndpointFormGroup(model.modelsEndpoint || ''),
        createModelComboboxFormGroup()
    ]);

    const perfSection = createSection(t('Model Limits', '模型性能'), [
        createFormGroup(
            'maxInputTokens',
            t('Max Input Tokens', '最大请求输入Token'),
            'maxInputTokens',
            'input',
            {
                type: 'number',
                min: '128',
                value: String(model.maxInputTokens)
            },
            t('Maximum input context supported by the model.', '模型支持的最大输入上下文限制')
        ),
        createFormGroup(
            'maxOutputTokens',
            t('Max Output Tokens', '最大响应输出Token'),
            'maxOutputTokens',
            'input',
            {
                type: 'number',
                min: '8',
                value: String(model.maxOutputTokens)
            },
            t('Maximum output tokens supported by the model.', '模型支持的最大输出Token限制')
        )
    ]);

    const capSection = createSection(t('Capabilities', '模型能力'), [
        createCheckboxFormGroup(
            'toolCalling',
            t('Supports Tool Calling', '支持工具调用'),
            'capabilities.toolCalling',
            model.toolCalling
        ),
        createCheckboxFormGroup(
            'imageInput',
            t('Supports Image Input', '支持图像输入'),
            'capabilities.imageInput',
            model.imageInput
        )
    ]);

    const advSection = createSection(t('Advanced Settings', '高级设置'), [
        createCheckboxFormGroup(
            'useInstructions',
            t(
                'Use instructions parameter (openai-responses only)',
                '使用 instructions 参数（仅 openai-responses 有效）'
            ),
            'useInstructions',
            model.useInstructions,
            t(
                'When SDK mode is openai-responses, use the instructions parameter for system messages (default uses user messages).',
                '当 SDK 模式为 openai-responses 时，使用 instructions 参数传递系统消息（默认使用用户消息传递）。'
            )
        ),
        createCheckboxFormGroup(
            'webSearchTool',
            t(
                'Enable Anthropic native web_search tool (anthropic only)',
                '启用 Anthropic 原生 web_search 工具（仅 anthropic 有效）'
            ),
            'webSearchTool',
            model.webSearchTool,
            t(
                'Enable this when the endpoint supports Anthropic native web_search. The tool is exposed to the model automatically.',
                '当接口兼容 Anthropic 原生 web_search 工具时启用。启用后会自动向模型暴露 web_search。'
            )
        ),
        createMultiSelectCheckboxFormGroup(
            'reasoningEffortOptions',
            t('Reasoning Effort Options', '推理强度选项'),
            'reasoningEffort',
            REASONING_EFFORT_OPTIONS.map(opt => ({ value: opt.value, label: opt.label })),
            model.reasoningEffort,
            t(
                'Selectable reasoning effort levels for the model picker. Default value rules:\n- If "Medium" is included, it is always the default.\n- Otherwise, the first selected item is the default.\nUse drag handle (⠿) to reorder. Leave all unchecked to keep unconfigured.',
                '模型 picker 的可选推理强度列表。默认值规则：\n- 如果包含 "Medium"，始终以 Medium 为默认值\n- 否则以列表首项为默认值\n使用拖拽手柄 (⠿) 调整顺序。全部不选则保持未配置状态。'
            )
        ),
        createFormGroup(
            'reasoningDefault',
            t('Default Reasoning Effort', '默认推理强度'),
            'reasoningDefault',
            'select',
            {
                options: [
                    {
                        value: '',
                        label: t('(Auto — follow default rules)', '（自动 — 按默认规则）'),
                        selected: !model.reasoningDefault
                    },
                    ...REASONING_EFFORT_OPTIONS.map(opt => ({
                        value: opt.value,
                        label: opt.label,
                        selected: model.reasoningDefault === opt.value
                    }))
                ]
            },
            t(
                'Override the default reasoning effort. When specified, it takes precedence over the "Medium-first / first-item" rule. The value must be included in the Reasoning Effort Options above.',
                '覆盖默认推理强度。指定时优先级高于“Medium 优先 / 数组首项”规则。该值必须包含在上方的推理强度选项中。'
            )
        ),
        createJSONFormGroup(
            'customHeader',
            t('Custom HTTP Headers (JSON)', '自定义HTTP头部（JSON格式）'),
            'customHeader',
            model.customHeader,
            '{"Authorization": "Bearer ${APIKEY}", "X-Custom-Header": "value"}',
            t(
                'Optional custom HTTP headers. Supports ${APIKEY} placeholder replacement with the actual API key.',
                '可选的自定义HTTP头部配置。支持 ${APIKEY} 占位符自动替换为实际的API密钥。'
            )
        ),
        createJSONFormGroup(
            'extraBody',
            t('Extra Request Body (JSON)', '额外请求体参数（JSON格式）'),
            'extraBody',
            model.extraBody,
            '{"temperature": 1, "top_p": null}',
            t(
                'Extra request body parameters merged into API requests. Set unsupported parameters to null to remove them.',
                '额外的请求体参数，将在API请求中合并到请求体中。若模型不支持某些参数，可设置为 null 以移除对应值。'
            )
        )
    ]);

    const buttonGroup = createButtonGroup(isCreateMode);
    const errorBanner = createErrorBanner();

    container.appendChild(errorBanner);
    container.appendChild(basicSection);
    container.appendChild(apiSection);
    container.appendChild(perfSection);
    container.appendChild(capSection);
    container.appendChild(advSection);
    container.appendChild(buttonGroup);
}

// ============= 通用组件构造函数 =============

function createSection(title: string, formGroups: HTMLElement[]): HTMLElement {
    const section = document.createElement('div');
    section.className = 'section';
    const h3 = document.createElement('h3');
    h3.textContent = title;
    section.appendChild(h3);
    formGroups.forEach(group => section.appendChild(group));
    return section;
}

interface SelectOption {
    value: string;
    label: string;
    selected?: boolean;
}

/**
 * 表单元素属性（input/textarea 的标准属性 + select 的 options）
 * 注意：不使用 index signature，避免与 options 数组类型冲突
 */
interface FormAttrs {
    type?: string;
    placeholder?: string;
    value?: string;
    readonly?: boolean;
    min?: string;
    rows?: string;
    options?: SelectOption[];
    [key: string]: string | boolean | SelectOption[] | undefined;
}

function createFormGroup(
    id: string,
    labelText: string,
    fieldName: string,
    elementType: 'input' | 'textarea' | 'select',
    attrs: FormAttrs,
    helpText?: string
): HTMLElement {
    const group = document.createElement('div');
    group.className = 'form-group';

    const label = document.createElement('label');
    label.htmlFor = id;
    label.innerHTML = `${labelText} <span class="field-name">(${fieldName})</span>`;
    group.appendChild(label);

    let element: HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement;
    if (elementType === 'input') {
        const input = document.createElement('input');
        Object.entries(attrs).forEach(([key, value]) => {
            if (key === 'readonly') {
                // readonly 是 HTML 布尔属性：属性存在即生效，不能用 setAttribute('readonly', 'false')
                if (value) {
                    input.setAttribute('readonly', '');
                    input.classList.add('readonly');
                }
            } else if (key !== 'options') {
                input.setAttribute(key, String(value ?? ''));
            }
        });
        element = input;
    } else if (elementType === 'textarea') {
        const textarea = document.createElement('textarea');
        Object.entries(attrs).forEach(([key, value]) => {
            if (key === 'value') {
                textarea.textContent = String(value ?? '');
            } else if (key !== 'options') {
                textarea.setAttribute(key, String(value ?? ''));
            }
        });
        element = textarea;
    } else {
        const select = document.createElement('select');
        attrs.options?.forEach(opt => {
            const option = document.createElement('option');
            option.value = opt.value;
            option.textContent = opt.label;
            if (opt.selected) {
                option.selected = true;
            }
            select.appendChild(option);
        });
        element = select;
    }

    element.id = id;
    group.appendChild(element);

    if (helpText) {
        const help = document.createElement('div');
        help.className = 'help-text detailed';
        help.textContent = helpText;
        group.appendChild(help);
    }
    return group;
}

function createCheckboxFormGroup(
    id: string,
    labelText: string,
    fieldName: string,
    checked: boolean | undefined,
    detailedHelp?: string
): HTMLElement {
    const group = document.createElement('div');
    group.className = 'form-group';

    const checkboxGroup = document.createElement('div');
    checkboxGroup.className = 'checkbox-group';

    const checkbox = document.createElement('input');
    checkbox.type = 'checkbox';
    checkbox.id = id;
    checkbox.checked = checked || false;

    const label = document.createElement('label');
    label.htmlFor = id;
    label.innerHTML = `${labelText} <span class="field-name">(${fieldName})</span>`;

    checkboxGroup.appendChild(checkbox);
    checkboxGroup.appendChild(label);
    group.appendChild(checkboxGroup);

    if (detailedHelp) {
        const help = document.createElement('div');
        help.className = 'help-text detailed';
        help.textContent = detailedHelp;
        group.appendChild(help);
    } else {
        group.classList.add('no-bottom');
    }
    return group;
}

function createMultiSelectCheckboxFormGroup(
    id: string,
    labelText: string,
    fieldName: string,
    options: { value: string; label: string }[],
    selectedValues: string[] | undefined,
    helpText?: string
): HTMLElement {
    const group = document.createElement('div');
    group.className = 'form-group';

    const label = document.createElement('label');
    label.innerHTML = `${labelText} <span class="field-name">(${fieldName})</span>`;
    group.appendChild(label);

    const optionsContainer = document.createElement('div');
    optionsContainer.className = 'multi-checkbox-options';
    optionsContainer.id = id;

    const selectedSet = new Set(selectedValues || []);
    const renderedSet = new Set<string>();

    // 先按 selectedValues 的顺序渲染已选项
    (selectedValues || []).forEach(value => {
        const opt = options.find(o => o.value === value);
        if (opt) {
            appendCheckbox(optionsContainer, opt, true);
            renderedSet.add(value);
        }
    });
    // 再按 options 顺序渲染未选项
    options.forEach(opt => {
        if (!renderedSet.has(opt.value)) {
            appendCheckbox(optionsContainer, opt, selectedSet.has(opt.value));
        }
    });

    enableDragSort(optionsContainer);
    group.appendChild(optionsContainer);

    if (helpText) {
        const help = document.createElement('div');
        help.className = 'help-text detailed';
        help.textContent = helpText;
        group.appendChild(help);
    }
    return group;
}

function appendCheckbox(container: HTMLElement, opt: { value: string; label: string }, checked: boolean): void {
    const item = document.createElement('label');
    item.className = 'multi-checkbox-item';
    item.draggable = true;

    const dragHandle = document.createElement('span');
    dragHandle.className = 'drag-handle';
    dragHandle.textContent = '⠿';

    const checkbox = document.createElement('input');
    checkbox.type = 'checkbox';
    checkbox.value = opt.value;
    checkbox.checked = checked;

    const span = document.createElement('span');
    span.textContent = opt.label;

    item.appendChild(dragHandle);
    item.appendChild(checkbox);
    item.appendChild(span);
    container.appendChild(item);
}

function enableDragSort(container: HTMLElement): void {
    let dragItem: HTMLElement | null = null;

    container.addEventListener('dragstart', e => {
        const item = (e.target as HTMLElement).closest('.multi-checkbox-item') as HTMLElement | null;
        if (!item) {
            return;
        }
        dragItem = item;
        item.classList.add('dragging');
        if (e.dataTransfer) {
            e.dataTransfer.effectAllowed = 'move';
            e.dataTransfer.setData('text/plain', '');
        }
    });

    container.addEventListener('dragend', () => {
        container.querySelectorAll('.multi-checkbox-item').forEach(el => {
            el.classList.remove('dragging');
            el.classList.remove('drag-over');
        });
        dragItem = null;
    });

    container.addEventListener('dragover', e => {
        e.preventDefault();
        if (e.dataTransfer) {
            e.dataTransfer.dropEffect = 'move';
        }
        const target = (e.target as HTMLElement).closest('.multi-checkbox-item');
        if (!target || target === dragItem) {
            return;
        }
        const rect = target.getBoundingClientRect();
        const midY = rect.top + rect.height / 2;
        if (e.clientY < midY) {
            target.classList.add('drag-over');
        } else {
            target.classList.remove('drag-over');
        }
    });

    container.addEventListener('drop', e => {
        e.preventDefault();
        if (!dragItem) {
            return;
        }
        const target = (e.target as HTMLElement).closest('.multi-checkbox-item');
        if (!target || target === dragItem) {
            return;
        }
        const rect = target.getBoundingClientRect();
        const midY = rect.top + rect.height / 2;
        if (e.clientY < midY) {
            container.insertBefore(dragItem, target);
        } else {
            container.insertBefore(dragItem, target.nextSibling);
        }
        container.querySelectorAll('.multi-checkbox-item').forEach(el => el.classList.remove('drag-over'));
    });
}

function createProviderFormGroup(): HTMLElement {
    const group = document.createElement('div');
    group.className = 'form-group';

    const label = document.createElement('label');
    label.htmlFor = 'provider';
    label.innerHTML = `${t('Provider *', '提供商 *')} <span class="field-name">(provider)</span>`;
    group.appendChild(label);

    const dropdown = document.createElement('div');
    dropdown.className = 'provider-dropdown';

    const input = document.createElement('input');
    input.type = 'text';
    input.id = 'provider';
    input.className = 'provider-input';
    // value 由调用方后续设置（state.model.provider）
    input.setAttribute('value', '');
    input.autocomplete = 'off';

    const list = document.createElement('div');
    list.className = 'provider-list';
    list.id = 'providerList';

    dropdown.appendChild(input);
    dropdown.appendChild(list);
    group.appendChild(dropdown);

    const help = document.createElement('div');
    help.className = 'help-text';
    help.textContent = t(
        'Model provider identifier. You can select a built-in or known provider, or enter a custom one.',
        '模型提供商标识符（可选择内置/已知提供商或自定义输入）'
    );
    group.appendChild(help);
    return group;
}

/**
 * Models Endpoint 输入框 + 常见预设下拉
 *
 * 仿 provider-dropdown 模式：聚焦即展开，点击外部关闭，选项点击填入输入框。
 * 字体粗细继承 input 默认（normal），避免 datalist native 弹层加粗问题。
 */
function createModelsEndpointFormGroup(value: string): HTMLElement {
    const group = document.createElement('div');
    group.className = 'form-group';

    const label = document.createElement('label');
    label.htmlFor = 'modelsEndpoint';
    label.innerHTML = `${t('Models Endpoint', '模型列表端点')} <span class="field-name">(modelsEndpoint)</span>`;
    group.appendChild(label);

    const dropdown = document.createElement('div');
    dropdown.className = 'provider-dropdown';

    const input = document.createElement('input');
    input.type = 'text';
    input.id = 'modelsEndpoint';
    input.className = 'provider-input';
    input.value = value || '';
    input.placeholder = t(
        'e.g. /models, /v4/models, or https://api.example.com/v4/models',
        '例如：/models、/v4/models 或 https://api.example.com/v4/models'
    );
    input.autocomplete = 'off';

    const list = document.createElement('div');
    list.className = 'provider-list';
    list.id = 'modelsEndpointList';
    MODELS_ENDPOINT_PRESETS.forEach(preset => {
        const item = document.createElement('div');
        item.className = 'provider-list-item';
        item.textContent = preset;
        item.dataset.value = preset;
        list.appendChild(item);
    });

    dropdown.appendChild(input);
    dropdown.appendChild(list);
    group.appendChild(dropdown);

    const help = document.createElement('div');
    help.className = 'help-text detailed';
    help.textContent = t(
        'Optional custom endpoint used by the "Fetch Models" button. Supports either a relative path or a full URL.',
        '"获取模型"按钮使用的可选自定义模型列表端点。支持相对路径或完整 URL。'
    );
    group.appendChild(help);

    return group;
}

function createModelComboboxFormGroup(): HTMLElement {
    const group = document.createElement('div');
    group.className = 'form-group';

    const label = document.createElement('label');
    label.htmlFor = 'requestModel';
    label.innerHTML = `${t('Request Model ID', '请求模型ID')} <span class="field-name">(model)</span>`;
    group.appendChild(label);

    const dropdown = document.createElement('div');
    dropdown.className = 'model-dropdown';

    const inputWrapper = document.createElement('div');
    inputWrapper.className = 'model-input-wrapper';

    const input = document.createElement('input');
    input.type = 'text';
    input.id = 'requestModel';
    input.className = 'model-input';
    input.setAttribute('value', '');
    input.placeholder = t('e.g. gpt-4', '例如: gpt-4');
    input.autocomplete = 'off';

    const fetchButton = document.createElement('button');
    fetchButton.type = 'button';
    fetchButton.className = 'fetch-models-button';
    fetchButton.id = 'fetchModelsButton';
    fetchButton.textContent = t('Fetch Models', '获取模型');
    fetchButton.title = t('Fetch available model IDs from BASE URL', '从 BASE URL 获取可用模型列表');

    const spinner = document.createElement('span');
    spinner.className = 'fetch-spinner';
    spinner.style.display = 'none';
    fetchButton.appendChild(spinner);

    inputWrapper.appendChild(input);
    inputWrapper.appendChild(fetchButton);

    const list = document.createElement('div');
    list.className = 'model-list';
    list.id = 'modelList';

    dropdown.appendChild(inputWrapper);
    dropdown.appendChild(list);
    group.appendChild(dropdown);

    const help = document.createElement('div');
    help.className = 'help-text detailed';
    help.textContent = t(
        'Model ID used in requests (optional). If empty, the Model id value is used.\r\nClick "Fetch Models" to load available model IDs from BASE URL automatically. Some providers may not support this.',
        '发起请求时使用的模型ID（可选），若不填写则使用 模型ID (id) 的值。\r\n点击"获取模型"按钮从 BASE URL 自动获取可用模型列表（可能部分提供商不支持）。'
    );
    group.appendChild(help);

    const statusDiv = document.createElement('div');
    statusDiv.className = 'model-fetch-status';
    statusDiv.id = 'modelFetchStatus';
    statusDiv.style.display = 'none';
    group.appendChild(statusDiv);

    return group;
}

function createJSONFormGroup(
    id: string,
    labelText: string,
    fieldName: string,
    value: string,
    placeholder: string,
    helpText: string
): HTMLElement {
    const group = document.createElement('div');
    group.className = 'form-group';

    const label = document.createElement('label');
    label.htmlFor = id;
    label.innerHTML = `${labelText} <span class="field-name">(${fieldName})</span>`;
    group.appendChild(label);

    const container = document.createElement('div');
    container.className = 'json-container';

    const toolbar = document.createElement('div');
    toolbar.className = 'json-toolbar';

    const formatBtn = document.createElement('button');
    formatBtn.type = 'button';
    formatBtn.className = 'json-button';
    formatBtn.textContent = t('Format', '格式化');
    formatBtn.dataset.target = id;
    formatBtn.classList.add('json-format-btn');

    const clearBtn = document.createElement('button');
    clearBtn.type = 'button';
    clearBtn.className = 'json-button';
    clearBtn.textContent = t('Clear', '清空');
    clearBtn.dataset.target = id;
    clearBtn.classList.add('json-clear-btn');

    const status = document.createElement('div');
    status.className = 'json-status';
    status.id = `${id}Status`;

    const indicator = document.createElement('span');
    indicator.className = 'json-status-indicator';

    const statusText = document.createElement('span');
    statusText.id = `${id}StatusText`;
    statusText.textContent = t('Empty', '无内容');

    status.appendChild(indicator);
    status.appendChild(statusText);

    toolbar.appendChild(formatBtn);
    toolbar.appendChild(clearBtn);
    toolbar.appendChild(status);
    container.appendChild(toolbar);

    const textarea = document.createElement('textarea');
    textarea.id = id;
    textarea.className = 'json-input';
    textarea.placeholder = placeholder;
    textarea.value = value || '';
    container.appendChild(textarea);

    const error = document.createElement('div');
    error.className = 'json-error';
    error.id = `${id}Error`;
    container.appendChild(error);

    group.appendChild(container);

    const help = document.createElement('div');
    help.className = 'help-text detailed';
    help.textContent = helpText;
    group.appendChild(help);

    return group;
}

function createErrorBanner(): HTMLElement {
    const banner = document.createElement('div');
    banner.id = 'globalErrorBanner';
    banner.className = 'error-banner';
    banner.style.display = 'none';

    const messageSpan = document.createElement('span');
    messageSpan.id = 'globalErrorMessage';

    const closeBtn = document.createElement('button');
    closeBtn.className = 'error-banner-close';
    closeBtn.textContent = '×';
    closeBtn.id = 'globalErrorClose';

    banner.appendChild(messageSpan);
    banner.appendChild(closeBtn);
    return banner;
}

function createButtonGroup(isCreateMode: boolean): HTMLElement {
    const group = document.createElement('div');
    group.className = 'button-group';

    const inner = document.createElement('div');
    inner.className = 'button-group-inner';

    const leftButtons = document.createElement('div');
    leftButtons.style.display = 'flex';
    leftButtons.style.gap = '10px';

    const rightButtons = document.createElement('div');
    rightButtons.style.display = 'flex';
    rightButtons.style.gap = '10px';

    if (!isCreateMode) {
        const deleteBtn = document.createElement('button');
        deleteBtn.className = 'delete-button';
        deleteBtn.id = 'deleteButton';
        deleteBtn.textContent = t('Delete', '删除');
        leftButtons.appendChild(deleteBtn);
    }

    const saveBtn = document.createElement('button');
    saveBtn.className = 'primary-button';
    saveBtn.id = 'saveButton';
    saveBtn.textContent = isCreateMode ? t('Create', '创建') : t('Update', '更新');

    const cancelBtn = document.createElement('button');
    cancelBtn.className = 'secondary-button';
    cancelBtn.id = 'cancelButton';
    cancelBtn.textContent = t('Cancel', '取消');

    rightButtons.appendChild(saveBtn);
    rightButtons.appendChild(cancelBtn);

    inner.appendChild(leftButtons);
    inner.appendChild(rightButtons);
    group.appendChild(inner);
    return group;
}

// 在 createDOM 后补设 provider/requestModel 的初始值（避免属性设置被覆盖）
export function applyInitialValues(state: EditorState): void {
    const providerInput = document.getElementById('provider') as HTMLInputElement | null;
    if (providerInput) {
        providerInput.value = state.model.provider;
    }
    const requestModelInput = document.getElementById('requestModel') as HTMLInputElement | null;
    if (requestModelInput) {
        requestModelInput.value = state.model.model;
    }
}

// 引用避免未使用告警
void CLI_RESERVED_PROVIDERS;
