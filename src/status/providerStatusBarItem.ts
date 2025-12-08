/*---------------------------------------------------------------------------------------------
 *  单提供商状态栏项基类
 *  继承 BaseStatusBarItem，添加 API Key 相关逻辑
 *  适用于依赖单个 API Key 的提供商状态栏（如 MiniMax、DeepSeek、Kimi、Moonshot 等）
 *--------------------------------------------------------------------------------------------*/

import { BaseStatusBarItem, StatusBarItemConfig } from './baseStatusBarItem';
import { ApiKeyManager } from '../utils/apiKeyManager';

// 重新导出 StatusBarItemConfig 以便子类使用
export { StatusBarItemConfig } from './baseStatusBarItem';

/**
 * 单提供商状态栏项基类
 * 继承 BaseStatusBarItem，提供 API Key 检查逻辑
 *
 * 适用于：
 * - 依赖单个 API Key 的提供商
 * - MiniMaxStatusBar、DeepSeekStatusBar、KimiStatusBar、MoonshotStatusBar 等
 *
 * @template T 状态数据类型
 */
export abstract class ProviderStatusBarItem<T> extends BaseStatusBarItem<T> {
    /** 状态栏项配置（包含 apiKeyProvider） */
    protected override readonly config: StatusBarItemConfig;

    /**
     * 构造函数
     * @param config 包含 apiKeyProvider 的状态栏项配置
     */
    constructor(config: StatusBarItemConfig) {
        super(config);
        this.config = config;
    }

    /**
     * 检查是否应该显示状态栏
     * 通过检查 API Key 是否存在来决定
     * @returns 是否应该显示状态栏
     */
    protected async shouldShowStatusBar(): Promise<boolean> {
        return await ApiKeyManager.hasValidApiKey(this.config.apiKeyProvider);
    }
}
