import * as vscode from 'vscode';

/**
 * 内联代码补全配置接口
 */
export interface InlineCompletionConfig {
    /** 是否启用内联代码补全 */
    enabled: boolean;
}

/**
 * 内置默认配置
 */
export const INLINE_COMPLETION_CONFIG = {
    /** 最小前缀长度（触发补全） */
    minPrefixLength: 2,
    /** 最大上下文行数 */
    maxContextLines: 50,
    /** 补全延迟（毫秒） */
    debounceDelay: 500,
    /** 使用的模型 */
    model: 'glm-4.5-air',
    /** 最大补全长度 */
    maxCompletionLength: 500,
    /** 温度参数 */
    temperature: 0.2
} as const;

/**
 * 配置键前缀
 */
const CONFIG_PREFIX = 'gcmp.inlineCompletion';

/**
 * 获取内联补全配置
 */
export function getInlineCompletionConfig(): InlineCompletionConfig {
    const config = vscode.workspace.getConfiguration(CONFIG_PREFIX);

    return {
        enabled: config.get<boolean>('enabled', false)  // 默认禁用，需要用户主动启用
    };
}

/**
 * 监听配置变化
 * @param callback 配置变化回调
 */
export function onConfigurationChanged(
    callback: (config: InlineCompletionConfig) => void
): vscode.Disposable {
    return vscode.workspace.onDidChangeConfiguration(event => {
        if (event.affectsConfiguration(CONFIG_PREFIX)) {
            callback(getInlineCompletionConfig());
        }
    });
}

/**
 * 更新配置项
 * @param key 配置键
 * @param value 配置值
 * @param global 是否为全局配置
 */
export async function updateConfig(
    key: string,
    value: unknown,
    global = true
): Promise<void> {
    const config = vscode.workspace.getConfiguration(CONFIG_PREFIX);
    await config.update(key, value, global);
}

/**
 * 切换启用/禁用状态
 */
export async function toggleEnabled(): Promise<void> {
    const config = getInlineCompletionConfig();
    await updateConfig('enabled', !config.enabled);
}
