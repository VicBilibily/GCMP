/**
 * 全局单例访问器 - copilot.bundle.js 中统一访问扩展的共享单例实例
 *
 * 由于 esbuild 的代码分割，extension.js 和 copilot.bundle.js 是两个独立的 CommonJS 模块
 * 此模块提供统一的接口来访问存储在 globalThis 中的共享单例，确保两个 bundle 使用同一实例
 */

import { CompletionLogger } from '../utils/completionLogger';
import { ApiKeyManager } from '../utils/apiKeyManager';
import { StatusBarManager } from '../status/statusBarManager';
import { ConfigManager } from '../utils/configManager';

/** 单例容器的类型定义 */
interface GCMPSingletons {
    CompletionLogger: typeof CompletionLogger;
    ApiKeyManager: typeof ApiKeyManager;
    StatusBarManager: typeof StatusBarManager;
    ConfigManager: typeof ConfigManager;
}

/** 扩展全局类型 */
declare global {
    var __gcmp_singletons: GCMPSingletons | undefined;
}

/**
 * 获取共享的 CompletionLogger 实例
 * 优先从 globalThis 获取（extension.js 初始化的实例），否则降级使用直接导入
 */
export function getCompletionLogger(): typeof CompletionLogger {
    return globalThis.__gcmp_singletons?.CompletionLogger || CompletionLogger;
}

/**
 * 获取共享的 ApiKeyManager 实例
 * 优先从 globalThis 获取（extension.js 初始化的实例），否则降级使用直接导入
 */
export function getApiKeyManager(): typeof ApiKeyManager {
    return globalThis.__gcmp_singletons?.ApiKeyManager || ApiKeyManager;
}

/**
 * 获取共享的 StatusBarManager 实例
 * 优先从 globalThis 获取（extension.js 初始化的实例），否则降级使用直接导入
 */
export function getStatusBarManager(): typeof StatusBarManager {
    return globalThis.__gcmp_singletons?.StatusBarManager || StatusBarManager;
}

/**
 * 获取共享的 ConfigManager 实例
 * 优先从 globalThis 获取（extension.js 初始化的实例），否则降级使用直接导入
 */
export function getConfigManager(): typeof ConfigManager {
    return globalThis.__gcmp_singletons?.ConfigManager || ConfigManager;
}

/**
 * 批量获取所有共享单例（可选）
 * 用于一次性获取多个实例
 */
export function getAllSingletons(): GCMPSingletons {
    return {
        CompletionLogger: getCompletionLogger(),
        ApiKeyManager: getApiKeyManager(),
        StatusBarManager: getStatusBarManager(),
        ConfigManager: getConfigManager()
    };
}
