/**
 * Model Editor 前端工具函数
 */

import type { WebViewMessage } from './types';
import { t } from './l10n';

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
 * 验证 webSearchToolConfig JSON 对象的字段类型
 * 与 providerConfig.schema.json / jsonSchemaProvider.ts 中的 schema 约束保持一致：
 * - 仅允许 maxUses / allowedDomains / blockedDomains / userLocation 四个顶层字段
 * - maxUses 必须为正整数
 * - allowedDomains / blockedDomains 必须为非空字符串数组且无重复项
 * - userLocation 仅允许 city / region / country / timezone 子字段，且均为字符串
 * 返回 null 表示通过，否则返回错误消息字符串
 */
export function validateWebSearchToolConfig(jsonString: string): string | null {
    if (!jsonString || jsonString.trim() === '') {
        return null;
    }
    let parsed: unknown;
    try {
        parsed = JSON.parse(jsonString);
    } catch {
        return t(
            'Web Search Tool Config JSON must be a valid object.',
            '联网搜索工具配置的JSON格式不正确，必须是对象类型'
        );
    }
    if (!isValidJSONObject(parsed)) {
        return t(
            'Web Search Tool Config JSON must be a valid object.',
            '联网搜索工具配置的JSON格式不正确，必须是对象类型'
        );
    }
    const obj = parsed as Record<string, unknown>;

    const ALLOWED_TOP_KEYS = ['maxUses', 'allowedDomains', 'blockedDomains', 'userLocation'];
    const unknownTopKey = Object.keys(obj).find(k => !ALLOWED_TOP_KEYS.includes(k));
    if (unknownTopKey) {
        return t(
            'Unknown field "{0}" in web search tool config. Allowed: maxUses, allowedDomains, blockedDomains, userLocation.',
            '联网搜索工具配置包含未知字段 "{0}"。允许的字段: maxUses, allowedDomains, blockedDomains, userLocation。',
            unknownTopKey
        );
    }

    if (
        obj.maxUses !== undefined &&
        (typeof obj.maxUses !== 'number' || obj.maxUses <= 0 || !Number.isInteger(obj.maxUses))
    ) {
        return t('maxUses must be a positive integer.', 'maxUses 必须是正整数');
    }

    const validateDomainArray = (value: unknown, field: string): string | null => {
        if (!Array.isArray(value)) {
            return t('{0} must be an array of strings.', '{0} 必须是字符串数组', field);
        }
        if (value.some(item => typeof item !== 'string')) {
            return t('{0} must be an array of strings.', '{0} 必须是字符串数组', field);
        }
        if (value.some(item => typeof item === 'string' && item.trim() === '')) {
            return t('{0} must not contain empty strings.', '{0} 不能包含空字符串', field);
        }
        const seen = new Set<string>();
        for (const item of value as string[]) {
            if (seen.has(item)) {
                return t('{0} must not contain duplicate values.', '{0} 不能包含重复值', field);
            }
            seen.add(item);
        }
        return null;
    };

    if (obj.allowedDomains !== undefined) {
        const err = validateDomainArray(obj.allowedDomains, 'allowedDomains');
        if (err) {
            return err;
        }
    }
    if (obj.blockedDomains !== undefined) {
        const err = validateDomainArray(obj.blockedDomains, 'blockedDomains');
        if (err) {
            return err;
        }
    }

    if (obj.userLocation !== undefined) {
        if (typeof obj.userLocation !== 'object' || obj.userLocation === null || Array.isArray(obj.userLocation)) {
            return t('userLocation must be an object.', 'userLocation 必须是对象');
        }
        const loc = obj.userLocation as Record<string, unknown>;
        const ALLOWED_LOCATION_KEYS = ['city', 'region', 'country', 'timezone'];
        const unknownLocKey = Object.keys(loc).find(k => !ALLOWED_LOCATION_KEYS.includes(k));
        if (unknownLocKey) {
            return t(
                'Unknown field "userLocation.{0}". Allowed: city, region, country, timezone.',
                'userLocation 包含未知字段 "{0}"。允许的字段: city, region, country, timezone。',
                unknownLocKey
            );
        }
        for (const key of Object.keys(loc)) {
            if (typeof loc[key] !== 'string') {
                return t('userLocation.{0} must be a string.', 'userLocation.{0} 必须是字符串', key);
            }
            if ((loc[key] as string).trim() === '') {
                return t('userLocation.{0} must not be empty.', 'userLocation.{0} 不能为空字符串', key);
            }
        }
    }
    return null;
}

/**
 * 验证 nativeTools JSON 数组的字段类型
 * 与 providerConfig.schema.json / jsonSchemaProvider.ts 中的 nativeToolConfig schema 约束保持一致：
 * - 必须为数组
 * - 每个元素必须含 type 字段（非空字符串，如 web_search / web_extractor）
 * - 仅 web_search 支持额外字段（maxUses/allowedDomains/blockedDomains/userLocation）
 * 返回 null 表示通过，否则返回错误消息字符串
 */
export function validateNativeTools(jsonString: string): string | null {
    if (!jsonString || jsonString.trim() === '') {
        return null;
    }
    let parsed: unknown;
    try {
        parsed = JSON.parse(jsonString);
    } catch {
        return t('Native Tools JSON must be a valid array.', '原生工具箱配置的JSON格式不正确，必须是数组类型');
    }
    if (!Array.isArray(parsed)) {
        return t('Native Tools JSON must be a valid array.', '原生工具箱配置的JSON格式不正确，必须是数组类型');
    }

    const ALLOWED_TOP_KEYS = ['type', 'maxUses', 'allowedDomains', 'blockedDomains', 'userLocation'];
    const ALLOWED_LOCATION_KEYS = ['city', 'region', 'country', 'timezone'];

    for (let i = 0; i < parsed.length; i++) {
        const item = parsed[i] as unknown;
        if (typeof item !== 'object' || item === null || Array.isArray(item)) {
            return t('Native Tools[{0}] must be an object.', '原生工具箱第 {0} 项必须是对象', String(i));
        }
        const obj = item as Record<string, unknown>;

        // type 必填且为非空字符串（不限定枚举，兼容未来新增工具）
        if (typeof obj.type !== 'string' || obj.type.trim() === '') {
            return t(
                'Native Tools[{0}].type must be a non-empty string (e.g. web_search, web_extractor).',
                '原生工具箱第 {0} 项的 type 必须是非空字符串（如 web_search、web_extractor）',
                String(i)
            );
        }

        // 顶层字段白名单（schema 用 additionalProperties: false 约束）
        const unknownKey = Object.keys(obj).find(k => !ALLOWED_TOP_KEYS.includes(k));
        if (unknownKey) {
            return t(
                'Native Tools[{0}] contains unknown field "{1}". Allowed: type, maxUses, allowedDomains, blockedDomains, userLocation.',
                '原生工具箱第 {0} 项包含未知字段 "{1}"。允许的字段: type, maxUses, allowedDomains, blockedDomains, userLocation',
                String(i),
                unknownKey
            );
        }

        // 非 web_search 跳过额外字段校验：schema 与运行时均声明"其他工具忽略额外字段"
        if (obj.type !== 'web_search') {
            continue;
        }

        // web_search 的额外字段校验
        if (obj.maxUses !== undefined) {
            if (typeof obj.maxUses !== 'number' || obj.maxUses <= 0 || !Number.isInteger(obj.maxUses)) {
                return t(
                    'Native Tools[{0}].maxUses must be a positive integer.',
                    '原生工具箱第 {0} 项的 maxUses 必须是正整数',
                    String(i)
                );
            }
        }

        const validateDomainArray = (value: unknown, field: string): string | null => {
            if (!Array.isArray(value)) {
                return t('{0} must be an array of strings.', '{0} 必须是字符串数组', field);
            }
            if (value.some(item => typeof item !== 'string')) {
                return t('{0} must be an array of strings.', '{0} 必须是字符串数组', field);
            }
            if (value.some(item => typeof item === 'string' && item.trim() === '')) {
                return t('{0} must not contain empty strings.', '{0} 不能包含空字符串', field);
            }
            const seen = new Set<string>();
            for (const item of value as string[]) {
                if (seen.has(item)) {
                    return t('{0} must not contain duplicate values.', '{0} 不能包含重复值', field);
                }
                seen.add(item);
            }
            return null;
        };

        if (obj.allowedDomains !== undefined) {
            const err = validateDomainArray(obj.allowedDomains, `Native Tools[${i}].allowedDomains`);
            if (err) {
                return err;
            }
        }
        if (obj.blockedDomains !== undefined) {
            const err = validateDomainArray(obj.blockedDomains, `Native Tools[${i}].blockedDomains`);
            if (err) {
                return err;
            }
        }

        if (obj.userLocation !== undefined) {
            if (typeof obj.userLocation !== 'object' || obj.userLocation === null || Array.isArray(obj.userLocation)) {
                return t(
                    'Native Tools[{0}].userLocation must be an object.',
                    '原生工具箱第 {0} 项的 userLocation 必须是对象',
                    String(i)
                );
            }
            const loc = obj.userLocation as Record<string, unknown>;
            const unknownLocKey = Object.keys(loc).find(k => !ALLOWED_LOCATION_KEYS.includes(k));
            if (unknownLocKey) {
                return t(
                    'Native Tools[{0}].userLocation contains unknown field "{1}". Allowed: city, region, country, timezone.',
                    '原生工具箱第 {0} 项的 userLocation 包含未知字段 "{1}"。允许的字段: city, region, country, timezone',
                    String(i),
                    unknownLocKey
                );
            }
            for (const key of Object.keys(loc)) {
                if (typeof loc[key] !== 'string') {
                    return t(
                        'Native Tools[{0}].userLocation.{1} must be a string.',
                        '原生工具箱第 {0} 项的 userLocation.{1} 必须是字符串',
                        String(i),
                        key
                    );
                }
                if ((loc[key] as string).trim() === '') {
                    return t(
                        'Native Tools[{0}].userLocation.{1} must not be empty.',
                        '原生工具箱第 {0} 项的 userLocation.{1} 不能为空字符串',
                        String(i),
                        key
                    );
                }
            }
        }
    }
    return null;
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
