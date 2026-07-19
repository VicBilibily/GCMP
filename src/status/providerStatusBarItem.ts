/*---------------------------------------------------------------------------------------------
 *  单提供商状态栏项基类
 *  继承 BaseStatusBarItem，添加 API Key 相关逻辑
 *  适用于依赖单个 API Key 的提供商状态栏（如 MiniMax、DeepSeek、Kimi、Moonshot 等）
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { BaseStatusBarItem, StatusBarItemConfig } from './baseStatusBarItem';
import { ApiKeyManager } from '../utils/config/apiKeyManager';
import { InterInstanceBus, ApiKeyChangedEvent } from '../interInstance';

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

    /** API Key 变更事件订阅 */
    private apiKeySubscription: vscode.Disposable | undefined;

    /**
     * 构造函数
     * @param config 包含 apiKeyProvider 的状态栏项配置
     */
    constructor(config: StatusBarItemConfig) {
        super(config);
        this.config = config;
    }

    /**
     * 初始化状态栏项
     */
    override async initialize(context: vscode.ExtensionContext): Promise<void> {
        await super.initialize(context);

        // 订阅跨实例 API Key 变更事件
        this.apiKeySubscription = InterInstanceBus.subscribe('apiKeyChanged', event => {
            this.handleApiKeyChangedEvent(event as ApiKeyChangedEvent);
        });
        context.subscriptions.push(this.apiKeySubscription);
    }

    /**
     * 销毁状态栏项
     */
    override dispose(): void {
        this.apiKeySubscription?.dispose();
        this.apiKeySubscription = undefined;
        super.dispose();
    }

    /**
     * 检查是否应该显示状态栏
     * 通过检查 API Key 是否存在来决定
     * @returns 是否应该显示状态栏
     */
    protected async shouldShowStatusBar(): Promise<boolean> {
        return await ApiKeyManager.hasValidApiKey(this.config.apiKeyProvider);
    }

    /**
     * 处理跨实例 API Key 变更事件
     */
    private handleApiKeyChangedEvent(event: ApiKeyChangedEvent): void {
        if (event.payload.provider !== this.config.apiKeyProvider) {
            return;
        }

        // API Key 变更后刷新状态栏显示状态
        this.checkAndShowStatus().catch(error =>
            console.error(`[${this.config.logPrefix}] Failed to refresh after API key change`, error)
        );
    }
}
