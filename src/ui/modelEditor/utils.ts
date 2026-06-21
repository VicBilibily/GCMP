/**
 * Model Editor 前端工具函数
 */

import type { WebViewMessage } from './types';

/**
 * webview 全局 API（由 VS Code 注入）
 */
declare function acquireVsCodeApi(): {
    postMessage(message: { command: string; [key: string]: unknown }): void;
};

/**
 * 获取 VS Code API（首次调用时通过 acquireVsCodeApi 获取并缓存）
 */
let vscodeApi: ReturnType<typeof acquireVsCodeApi> | null = null;

export function getVsCodeApi(): ReturnType<typeof acquireVsCodeApi> {
    if (!vscodeApi) {
        vscodeApi = acquireVsCodeApi();
    }
    return vscodeApi;
}

/**
 * 发送消息到扩展宿主
 */
export function postToVSCode(message: WebViewMessage): void {
    getVsCodeApi().postMessage(message);
}

/**
 * 创建 DOM 元素的快捷方法
 */
export function createElement<K extends keyof HTMLElementTagNameMap>(
    tag: K,
    className?: string
): HTMLElementTagNameMap[K];
export function createElement(tag: string, className?: string): HTMLElement;
export function createElement(tag: string, className: string = ''): HTMLElement {
    const element = document.createElement(tag);
    if (className) {
        element.className = className;
    }
    return element;
}

/**
 * 判断是否为图片 MIME 类型（与旧 modelEditor.js 保持一致）
 */
export function isImageMimeType(mimeType: string): boolean {
    if (!mimeType) {
        return false;
    }
    return mimeType.startsWith('image/');
}

/**
 * 判断是否为 noproxy 字面量
 */
export function isNoProxyValue(value: string): boolean {
    return typeof value === 'string' && value.trim().toLowerCase() === 'noproxy';
}

/**
 * 规范化代理输入：noproxy 字面量统一为小写
 */
export function normalizeProxyInput(value: string): string {
    const trimmed = value.trim();
    return isNoProxyValue(trimmed) ? 'noproxy' : trimmed;
}

/**
 * 校验代理输入合法性
 */
export function isValidProxyInput(value: string): boolean {
    const normalized = normalizeProxyInput(value);
    if (!normalized || isNoProxyValue(normalized)) {
        return true;
    }

    const candidate = /^[a-zA-Z][a-zA-Z\d+.-]*:\/\//.test(normalized) ? normalized : `http://${normalized}`;
    try {
        new URL(candidate);
        return true;
    } catch {
        return false;
    }
}

/**
 * 判断解析后的 JSON 是否为有效对象（非数组、非 null、非基本类型）
 */
export function isValidJSONObject(parsed: unknown): boolean {
    return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed);
}

/**
 * 验证 JSON 字符串格式（空字符串视为有效）
 */
export function validateJSON(jsonString: string): boolean {
    if (!jsonString || jsonString.trim() === '') {
        return true;
    }
    try {
        const parsed = JSON.parse(jsonString);
        return isValidJSONObject(parsed);
    } catch {
        return false;
    }
}

/**
 * 解析 JSON 字符串为对象（空或无效返回 undefined）
 */
export function parseJSON(jsonString: string): Record<string, unknown> | undefined {
    if (!jsonString || jsonString.trim() === '') {
        return undefined;
    }
    try {
        const parsed = JSON.parse(jsonString);
        if (isValidJSONObject(parsed)) {
            return parsed as Record<string, unknown>;
        }
        return undefined;
    } catch {
        return undefined;
    }
}

/**
 * 自动调整 textarea 高度以适应内容
 */
export function autoResizeTextarea(textarea: HTMLTextAreaElement | null): void {
    if (!textarea) {
        return;
    }
    textarea.style.height = 'auto';
    textarea.style.height = `${textarea.scrollHeight}px`;
}

/**
 * 为所有 textarea 添加自动扩展高度功能
 */
export function autoResizeAllTextareas(): void {
    const textareas = document.querySelectorAll('textarea');
    textareas.forEach(textarea => {
        autoResizeTextarea(textarea);
        textarea.addEventListener('input', () => autoResizeTextarea(textarea));
        textarea.addEventListener('change', () => autoResizeTextarea(textarea));
        textarea.addEventListener('paste', () => {
            setTimeout(() => autoResizeTextarea(textarea), 0);
        });
    });
}

/**
 * 添加非空校验（invalid class 切换）
 */
export function addSimpleValidation(element: HTMLInputElement | HTMLTextAreaElement): void {
    element.addEventListener('input', function (this: HTMLInputElement | HTMLTextAreaElement) {
        if (this.value.trim()) {
            this.classList.remove('invalid');
        } else {
            this.classList.add('invalid');
        }
    });
}

/**
 * 添加正整数校验
 */
export function addNumberValidation(element: HTMLInputElement): void {
    element.addEventListener('input', function (this: HTMLInputElement) {
        const value = parseInt(this.value);
        if (value && value > 0) {
            this.classList.remove('invalid');
        } else {
            this.classList.add('invalid');
        }
    });
}
