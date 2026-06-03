/*---------------------------------------------------------------------------------------------
 *  工具上下文管理器
 *  通过 setContext 维护工具可用性上下文键，配合 package.json 的 when 子句控制工具可见性
 *  当 API Key 配置变更时自动更新上下文键，VS Code 会重新评估 when 子句
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { Logger } from '../utils/logger';
import { ApiKeyManager } from '../utils/apiKeyManager';

/**
 * 工具上下文键名定义
 */
const TOOL_CONTEXT_KEYS = {
    zhipu: 'gcmp.tool.zhipuWebSearch.enabled',
    minimax: 'gcmp.tool.minimaxWebSearch.enabled',
    kimi: 'gcmp.tool.kimiWebSearch.enabled',
    dashscope: 'gcmp.tool.dashscopeWebSearch.enabled'
} as const;

type ToolProvider = keyof typeof TOOL_CONTEXT_KEYS;

/**
 * provider key 到上下文键的映射
 */
const PROVIDER_TO_TOOL: Record<string, ToolProvider> = {
    zhipu: 'zhipu',
    'minimax-token': 'minimax',
    kimi: 'kimi',
    dashscope: 'dashscope'
};

/**
 * 工具上下文管理器
 * 维护所有搜索工具的可用性上下文键，配合 package.json 的 when 子句实现工具可见性控制
 */
export class ToolContextManager {
    private static secretsListener: vscode.Disposable | null = null;
    private static initialized = false;

    /**
     * 初始化工具上下文
     * - 设置初始上下文键（根据当前 API Key 状态）
     * - 监听 API Key 变更，自动更新上下文
     */
    static initialize(context: vscode.ExtensionContext): void {
        if (ToolContextManager.initialized) {
            return;
        }
        ToolContextManager.initialized = true;

        // 初始化所有工具的上下文键
        ToolContextManager.refreshAll();

        // 监听 API Key 变更事件
        ToolContextManager.secretsListener = context.secrets.onDidChange(e => {
            // e.key 格式为 "zhipu.apiKey", "kimi.apiKey" 等
            const provider = e.key.replace('.apiKey', '');
            const toolProvider = PROVIDER_TO_TOOL[provider];
            if (toolProvider) {
                Logger.debug(
                    `[ToolContextManager] API Key changed for provider "${provider}", refreshing context key...`
                );
                ToolContextManager.refreshOne(toolProvider);
            }
        });

        context.subscriptions.push({
            dispose: () => ToolContextManager.dispose()
        });

        Logger.info('[ToolContextManager] Initialized');
    }

    /**
     * 刷新所有工具的上下文键
     */
    static refreshAll(): void {
        const keys = Object.keys(TOOL_CONTEXT_KEYS) as ToolProvider[];
        keys.forEach(tool => ToolContextManager.refreshOne(tool));
    }

    /**
     * 刷新单个工具的上下文键
     */
    static refreshOne(tool: ToolProvider): void {
        const contextKey = TOOL_CONTEXT_KEYS[tool];

        const checkKey = (): Promise<boolean> => {
            if (tool === 'kimi') {
                return ApiKeyManager.hasValidApiKey('kimi');
            }
            const provider = ToolContextManager.getProviderForTool(tool);
            if (!provider) {
                return Promise.resolve(false);
            }
            return ApiKeyManager.hasValidApiKey(provider);
        };

        checkKey()
            .then(hasKey => {
                Logger.debug(`[ToolContextManager] Set context "${contextKey}" = ${hasKey}`);
                return vscode.commands.executeCommand('setContext', contextKey, hasKey);
            })
            .catch(err => {
                Logger.warn(`[ToolContextManager] Failed to set context "${contextKey}":`, err);
            });
    }

    /**
     * 获取工具对应的 provider key
     */
    private static getProviderForTool(tool: ToolProvider): string | undefined {
        for (const [provider, t] of Object.entries(PROVIDER_TO_TOOL)) {
            if (t === tool) {
                return provider;
            }
        }
        return undefined;
    }

    /**
     * 获取指定 provider 对应的上下文键
     */
    static getContextKey(provider: string): string | undefined {
        const tool = PROVIDER_TO_TOOL[provider];
        return tool ? TOOL_CONTEXT_KEYS[tool] : undefined;
    }

    /**
     * 手动刷新指定 provider 对应的上下文键
     */
    static refreshByProvider(provider: string): void {
        const tool = PROVIDER_TO_TOOL[provider];
        if (tool) {
            ToolContextManager.refreshOne(tool);
        }
    }

    /**
     * 清理资源
     */
    static dispose(): void {
        ToolContextManager.secretsListener?.dispose();
        ToolContextManager.secretsListener = null;
        ToolContextManager.initialized = false;
        Logger.info('[ToolContextManager] Disposed');
    }
}
