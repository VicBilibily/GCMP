/**
 * Model Editor 表单校验与数据收集
 * 对应旧 modelEditor.js 的 validateForm / saveModel 数据收集逻辑
 */

import type { EditorState } from '../app';
import type { ModelFormData } from '../types';
import { t } from '../l10n';
import { CLI_RESERVED_PROVIDERS } from '../types';
import { isValidProxyInput, normalizeProxyInput, parseJSON, validateJSON } from '../utils';

/**
 * 显示全局错误提示
 */
export function showGlobalError(message: string): void {
    const banner = document.getElementById('globalErrorBanner');
    const messageSpan = document.getElementById('globalErrorMessage');
    if (banner && messageSpan) {
        messageSpan.textContent = message;
        banner.style.display = 'flex';
        banner.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    }
}

/**
 * 隐藏全局错误提示
 */
export function hideGlobalError(): void {
    const banner = document.getElementById('globalErrorBanner');
    if (banner) {
        banner.style.display = 'none';
    }
}

/**
 * 表单校验（必填字段 + URL + token + JSON 格式）
 */
export function validateForm(): boolean {
    const modelId = (document.getElementById('modelId') as HTMLInputElement).value.trim();
    const modelName = (document.getElementById('modelName') as HTMLInputElement).value.trim();
    const provider = (document.getElementById('provider') as HTMLInputElement).value.trim();
    const baseUrl = (document.getElementById('baseUrl') as HTMLInputElement).value.trim();
    const endpoint = (document.getElementById('endpoint') as HTMLInputElement).value.trim();
    const modelsEndpoint = (document.getElementById('modelsEndpoint') as HTMLInputElement).value.trim();
    const proxyUrl = normalizeProxyInput((document.getElementById('proxy') as HTMLInputElement).value);
    const maxInputTokens = (document.getElementById('maxInputTokens') as HTMLInputElement).value.trim();
    const maxOutputTokens = (document.getElementById('maxOutputTokens') as HTMLInputElement).value.trim();

    if (!modelId) {
        showGlobalError(t('Enter the model ID.', '请输入模型ID'));
        document.getElementById('modelId')?.focus();
        return false;
    }
    if (!modelName) {
        showGlobalError(t('Enter the display name.', '请输入显示名称'));
        document.getElementById('modelName')?.focus();
        return false;
    }
    if (!provider) {
        showGlobalError(t('Enter the provider.', '请输入提供商'));
        document.getElementById('provider')?.focus();
        return false;
    }
    if (CLI_RESERVED_PROVIDERS.includes(provider.toLowerCase() as (typeof CLI_RESERVED_PROVIDERS)[number])) {
        showGlobalError(
            t(
                'Provider "{0}" is reserved for CLI use and cannot be used for custom models.',
                '提供商 "{0}" 为 CLI 专用，不可在自定义模型中使用',
                provider
            )
        );
        document.getElementById('provider')?.focus();
        return false;
    }
    if (!baseUrl) {
        showGlobalError(t('Enter BASE URL.', '请输入 BASE URL'));
        document.getElementById('baseUrl')?.focus();
        return false;
    }

    if (baseUrl) {
        try {
            const urlObj = new URL(baseUrl);
            if (urlObj.protocol !== 'http:' && urlObj.protocol !== 'https:') {
                showGlobalError(
                    t('BASE URL must start with http:// or https://.', 'BASE URL 必须以 http:// 或 https:// 开头')
                );
                document.getElementById('baseUrl')?.focus();
                return false;
            }
        } catch {
            showGlobalError(t('BASE URL is invalid. Enter a valid URL.', 'BASE URL 格式不正确，请输入有效的 URL'));
            document.getElementById('baseUrl')?.focus();
            return false;
        }
    }

    if (!isValidProxyInput(proxyUrl)) {
        showGlobalError(
            t(
                'Proxy URL is invalid. Enter a valid URL, host:port, or "noproxy".',
                '代理 URL 格式不正确，请输入有效的 URL、host:port 或 "noproxy"'
            )
        );
        document.getElementById('proxy')?.focus();
        return false;
    }

    const endpointFields: { value: string; id: string; invalidMessage: string }[] = [
        {
            value: endpoint,
            id: 'endpoint',
            invalidMessage: t(
                'Chat endpoint is invalid. Enter a valid URL or path.',
                '聊天端点格式不正确，请输入有效的 URL 或路径'
            )
        },
        {
            value: modelsEndpoint,
            id: 'modelsEndpoint',
            invalidMessage: t(
                'Models endpoint is invalid. Enter a valid URL or path.',
                '模型列表端点格式不正确，请输入有效的 URL 或路径'
            )
        }
    ];
    for (const field of endpointFields) {
        if (!field.value) {
            continue;
        }
        if (field.value.startsWith('http://') || field.value.startsWith('https://')) {
            try {
                const urlObj = new URL(field.value);
                if (urlObj.protocol !== 'http:' && urlObj.protocol !== 'https:') {
                    showGlobalError(field.invalidMessage);
                    document.getElementById(field.id)?.focus();
                    return false;
                }
            } catch {
                showGlobalError(field.invalidMessage);
                document.getElementById(field.id)?.focus();
                return false;
            }
        }
    }

    if (!maxInputTokens || isNaN(parseInt(maxInputTokens)) || parseInt(maxInputTokens) <= 0) {
        showGlobalError(t('Max input tokens must be a number greater than 0.', '最大输入Token必须是大于0的数字'));
        document.getElementById('maxInputTokens')?.focus();
        return false;
    }
    if (!maxOutputTokens || isNaN(parseInt(maxOutputTokens)) || parseInt(maxOutputTokens) <= 0) {
        showGlobalError(t('Max output tokens must be a number greater than 0.', '最大输出Token必须是大于0的数字'));
        document.getElementById('maxOutputTokens')?.focus();
        return false;
    }

    const customHeaderJson = (document.getElementById('customHeader') as HTMLTextAreaElement).value.trim();
    if (customHeaderJson && !validateJSON(customHeaderJson)) {
        showGlobalError(
            t('Custom HTTP headers JSON must be a valid object.', '自定义HTTP头部的JSON格式不正确，必须是对象类型')
        );
        document.getElementById('customHeader')?.focus();
        return false;
    }

    const extraBodyJson = (document.getElementById('extraBody') as HTMLTextAreaElement).value.trim();
    if (extraBodyJson && !validateJSON(extraBodyJson)) {
        showGlobalError(
            t('Extra request body JSON must be a valid object.', '额外请求体参数的JSON格式不正确，必须是对象类型')
        );
        document.getElementById('extraBody')?.focus();
        return false;
    }

    return true;
}

/**
 * 从 DOM 收集表单数据为 ModelFormData
 * 失败时返回 null
 */
export function collectFormData(state: EditorState): ModelFormData | null {
    const modelId = (document.getElementById('modelId') as HTMLInputElement).value.trim();
    const modelName = (document.getElementById('modelName') as HTMLInputElement).value.trim();
    const provider = (document.getElementById('provider') as HTMLInputElement).value.trim();
    if (!modelId || !modelName || !provider) {
        return null;
    }

    const tooltip = (document.getElementById('modelTooltip') as HTMLTextAreaElement).value.trim();
    const requestModel = (document.getElementById('requestModel') as HTMLInputElement).value.trim();
    const baseUrl = (document.getElementById('baseUrl') as HTMLInputElement).value.trim();
    const endpoint = (document.getElementById('endpoint') as HTMLInputElement).value.trim();
    const modelsEndpoint = (document.getElementById('modelsEndpoint') as HTMLInputElement).value.trim();
    const proxy = normalizeProxyInput((document.getElementById('proxy') as HTMLInputElement).value);
    const apiKey = (document.getElementById('apiKey') as HTMLInputElement).value.trim();
    const sdkMode = ((document.getElementById('sdkMode') as HTMLSelectElement).value ||
        'openai') as ModelFormData['sdkMode'];
    const maxInputTokens = parseInt((document.getElementById('maxInputTokens') as HTMLInputElement).value) || 12800;
    const maxOutputTokens = parseInt((document.getElementById('maxOutputTokens') as HTMLInputElement).value) || 8192;
    const toolCalling = (document.getElementById('toolCalling') as HTMLInputElement).checked;
    const imageInput = (document.getElementById('imageInput') as HTMLInputElement).checked;
    // editTools 不提供 UI 控件，从原始状态透传保留
    const editTools = state.model.editTools;
    const useInstructionsEl = document.getElementById('useInstructions') as HTMLInputElement | null;
    const webSearchToolEl = document.getElementById('webSearchTool') as HTMLInputElement | null;

    const useInstructions =
        sdkMode === 'openai-responses' ? (useInstructionsEl?.checked ?? false) : (state.model.useInstructions ?? false);
    const webSearchTool =
        sdkMode === 'anthropic' ? (webSearchToolEl?.checked ?? false) : (state.model.webSearchTool ?? false);

    // reasoningEffort 多选
    const reasoningEffortContainer = document.getElementById('reasoningEffortOptions');
    const reasoningEffortValues: string[] = [];
    if (reasoningEffortContainer) {
        reasoningEffortContainer.querySelectorAll<HTMLInputElement>('input[type="checkbox"]').forEach(cb => {
            if (cb.checked) {
                reasoningEffortValues.push(cb.value);
            }
        });
    }

    // reasoningDefault 下拉（空字符串表示未配置）
    const reasoningDefaultEl = document.getElementById('reasoningDefault') as HTMLSelectElement | null;
    const reasoningDefault = reasoningDefaultEl?.value ?? '';

    const customHeaderText = (document.getElementById('customHeader') as HTMLTextAreaElement).value.trim();
    const extraBodyText = (document.getElementById('extraBody') as HTMLTextAreaElement).value.trim();

    return {
        id: modelId,
        name: modelName,
        provider,
        tooltip,
        baseUrl,
        endpoint,
        modelsEndpoint,
        proxy,
        apiKey,
        model: requestModel,
        sdkMode,
        maxInputTokens,
        maxOutputTokens,
        toolCalling,
        imageInput,
        editTools,
        useInstructions,
        webSearchTool,
        reasoningEffort: reasoningEffortValues as ModelFormData['reasoningEffort'],
        reasoningDefault: reasoningDefault as ModelFormData['reasoningDefault'],
        // 当前可视化编辑器尚未提供 tokenPricing 单独输入控件；保存时保留已有值，
        // 避免用户编辑其他字段时把 settings.json 中的 tokenPricing 清空。
        tokenPricing: state.model.tokenPricing || '',
        customHeader: parseJSON(customHeaderText) ? customHeaderText : '',
        extraBody: parseJSON(extraBodyText) ? extraBodyText : ''
    };
}
