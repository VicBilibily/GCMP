/*---------------------------------------------------------------------------------------------
 *  Codex App Server 服务入口（单例）
 *  组合 processManager + client，向 Provider/Handler/Quota 提供统一访问点
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { ConfigManager } from '../../utils/config/configManager';
import { CodexAppServerClient } from './client';
import { CodexAppServerProcessManager } from './processManager';
import type { CodexAppServerConfig } from './type';

/** 读取 appServer 传输配置（providerOverrides.codex.appServer） */
export function getCodexAppServerConfig(): CodexAppServerConfig {
    const overrides = ConfigManager.getProviderOverrides();
    return overrides['codex']?.appServer ?? {};
}

/** codex 是否启用 appServer 传输 */
export function isCodexAppServerTransport(): boolean {
    return ConfigManager.getProviderOverrides()['codex']?.transport === 'appServer';
}

let instance: { processManager: CodexAppServerProcessManager; client: CodexAppServerClient } | undefined;
let storedContext: vscode.ExtensionContext | undefined;

/** 注册扩展上下文（CodexProvider 激活时调用一次） */
export function initCodexAppServer(context: vscode.ExtensionContext): void {
    storedContext = context;
}

/** 获取（懒创建）App Server 客户端；配置变更后由 resetCodexAppServer 重建 */
export function getCodexAppServerClient(context?: vscode.ExtensionContext): CodexAppServerClient {
    storedContext ??= context;
    if (!storedContext) {
        throw new Error('Codex App Server is not initialized: ExtensionContext unavailable');
    }
    if (!instance) {
        const processManager = new CodexAppServerProcessManager(getCodexAppServerConfig);
        const client = new CodexAppServerClient(processManager);
        storedContext.subscriptions.push({ dispose: () => processManager.dispose() });
        instance = { processManager, client };
    }
    return instance.client;
}

/** 配置变更/切回 direct 时调用：关闭进程并清理单例 */
export function resetCodexAppServer(): void {
    instance?.processManager.dispose();
    instance = undefined;
}
