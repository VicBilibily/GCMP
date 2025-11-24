/*---------------------------------------------------------------------------------------------
 *  状态栏项基类
 *  提供状态栏管理的通用逻辑和生命周期管理
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { StatusLogger } from '../utils/statusLogger';
import { ApiKeyManager } from '../utils/apiKeyManager';
import { LeaderElectionService } from './leaderElectionService';

/**
 * 缓存数据结构
 */
export interface CachedStatusData<T> {
    /** 状态数据 */
    data: T;
    /** 缓存时间戳 */
    timestamp: number;
}

/**
 * 状态栏项配置
 */
export interface StatusBarItemConfig {
    /** 状态栏项名称 */
    name: string;
    /** 状态栏项对齐方式 */
    alignment: vscode.StatusBarAlignment;
    /** 状态栏项优先级 */
    priority: number;
    /** 刷新命令ID */
    refreshCommand: string;
    /** API Key 提供商标识 */
    apiKeyProvider: string;
    /** 缓存键前缀 */
    cacheKeyPrefix: string;
    /** 日志前缀 */
    logPrefix: string;
}

/**
 * 状态栏项基类
 * 提供状态栏管理的通用逻辑，包括：
 * - 生命周期管理（初始化、销毁）
 * - 刷新机制（手动刷新、延时刷新、周期性刷新）
 * - 缓存管理（读取、写入、过期检测）
 * - 防抖逻辑
 * - API Key 检测
 *
 * @template T 状态数据类型
 */
export abstract class BaseStatusBarItem<T> {
    // ==================== 实例成员 ====================
    protected statusBarItem: vscode.StatusBarItem | undefined;
    protected context: vscode.ExtensionContext | undefined;
    protected config: StatusBarItemConfig;

    // 状态数据
    protected lastStatusData: CachedStatusData<T> | null = null;

    // 定时器
    protected updateDebouncer: NodeJS.Timeout | undefined;
    protected cacheUpdateTimer: NodeJS.Timeout | undefined;

    // 时间戳
    protected lastDelayedUpdateTime = 0;

    // 标志位
    protected isLoading = false;
    protected initialized = false;

    // 常量配置
    protected readonly MIN_DELAYED_UPDATE_INTERVAL = 30000; // 最小延时更新间隔 30 秒
    protected readonly CACHE_UPDATE_INTERVAL = 10000; // 缓存加载间隔 10 秒

    /**
     * 构造函数
     * @param config 状态栏项配置
     */
    constructor(config: StatusBarItemConfig) {
        this.config = config;
        this.validateConfig();
    }

    /**
     * 验证配置参数的有效性
     * @throws {Error} 当配置无效时抛出错误
     */
    private validateConfig(): void {
        const requiredFields: (keyof StatusBarItemConfig)[] = [
            'name',
            'refreshCommand',
            'apiKeyProvider',
            'cacheKeyPrefix',
            'logPrefix'
        ];

        for (const field of requiredFields) {
            if (!this.config[field]) {
                throw new Error(`状态栏配置无效: ${field} 不能为空`);
            }
        }

        if (typeof this.config.priority !== 'number') {
            throw new Error('状态栏配置无效: priority 必须是数字');
        }
    }

    // ==================== 抽象方法（子类必须实现） ====================

    /**
     * 获取状态栏图标
     * @returns 图标字符串，如 '$(gcmp-minimax)'
     */
    protected abstract getIcon(): string;

    /**
     * 获取显示文本
     * @param data 状态数据
     * @returns 显示在状态栏的文本
     */
    protected abstract getDisplayText(data: T): string;

    /**
     * 生成 Tooltip 内容
     * @param data 状态数据
     * @returns Tooltip 内容
     */
    protected abstract generateTooltip(data: T): vscode.MarkdownString | string;

    /**
     * 执行 API 查询
     * @returns 查询结果
     */
    protected abstract performApiQuery(): Promise<{ success: boolean; data?: T; error?: string }>;

    /**
     * 检查是否需要高亮警告
     * @param data 状态数据
     * @returns 是否需要高亮
     */
    protected abstract shouldHighlightWarning(data: T): boolean;

    /**
     * 获取缓存键名
     * @param key 键名后缀
     * @returns 完整的缓存键名
     */
    protected getCacheKey(key: string): string {
        return `${this.config.cacheKeyPrefix}.${key}`;
    }

    // ==================== 虚方法（子类可以重写） ====================

    /**
     * 检查是否需要刷新缓存
     * 由子类实现自定义的刷新判断逻辑（包括缓存触发和主实例定时触发）
     * @returns 是否需要刷新
     */
    protected abstract shouldRefresh(): boolean;

    /**
     * 在初始化后执行的钩子方法
     */
    protected async onInitialized(): Promise<void> {
        // 默认为空实现，子类可以重写
    }

    /**
     * 在销毁前执行的钩子方法
     */
    protected async onDispose(): Promise<void> {
        // 默认为空实现，子类可以重写
    }

    // ==================== 公共方法 ====================

    /**
     * 初始化状态栏项
     * @param context 扩展上下文
     */
    async initialize(context: vscode.ExtensionContext): Promise<void> {
        if (this.initialized) {
            StatusLogger.warn(`[${this.config.logPrefix}] 状态栏项已初始化，跳过重复初始化`);
            return;
        }

        this.context = context;

        // 创建 StatusBarItem
        this.statusBarItem = vscode.window.createStatusBarItem(this.config.alignment, this.config.priority);
        this.statusBarItem.name = this.config.name;
        this.statusBarItem.text = this.getIcon();
        this.statusBarItem.command = this.config.refreshCommand;

        // 检查是否设置了 API Key
        const hasKey = await ApiKeyManager.hasValidApiKey(this.config.apiKeyProvider);
        if (hasKey) {
            this.statusBarItem.show();
        } else {
            StatusLogger.trace(`[${this.config.logPrefix}] 未设置 API Key，隐藏状态栏`);
        }

        // 注册刷新命令
        context.subscriptions.push(
            vscode.commands.registerCommand(this.config.refreshCommand, () => {
                if (!this.isLoading) {
                    this.performRefresh();
                }
            })
        );

        // 初始更新
        this.performInitialUpdate();

        // 启动缓存定时器
        this.startCacheUpdateTimer();

        // 注册清理逻辑
        context.subscriptions.push({
            dispose: () => {
                this.dispose();
            }
        });

        this.initialized = true;

        // 注册主实例定时刷新任务
        this.registerLeaderPeriodicTask();

        // 调用初始化钩子
        await this.onInitialized();

        StatusLogger.info(`[${this.config.logPrefix}] 状态栏项初始化完成`);
    }

    /**
     * 检查并显示状态栏（在设置 API Key 后调用）
     */
    async checkAndShowStatus(): Promise<void> {
        if (this.statusBarItem) {
            const hasKey = await ApiKeyManager.hasValidApiKey(this.config.apiKeyProvider);
            if (hasKey) {
                this.statusBarItem.show();
                this.performInitialUpdate();
            } else {
                this.statusBarItem.hide();
            }
        }
    }

    /**
     * 延时更新状态栏（在 API 请求后调用）
     * 包含防抖机制，避免频繁请求
     * @param delayMs 延时时间（毫秒）
     */
    delayedUpdate(delayMs = 2000): void {
        // 清除之前的防抖定时器
        if (this.updateDebouncer) {
            clearTimeout(this.updateDebouncer);
        }

        const now = Date.now();
        const timeSinceLastUpdate = now - this.lastDelayedUpdateTime;

        // 如果距离上次更新不足阈值，则等到满阈值再执行
        const finalDelayMs =
            timeSinceLastUpdate < this.MIN_DELAYED_UPDATE_INTERVAL
                ? this.MIN_DELAYED_UPDATE_INTERVAL - timeSinceLastUpdate
                : delayMs;

        StatusLogger.debug(`[${this.config.logPrefix}] 设置延时更新，将在 ${finalDelayMs / 1000} 秒后执行`);

        // 设置新的防抖定时器
        this.updateDebouncer = setTimeout(async () => {
            try {
                StatusLogger.debug(`[${this.config.logPrefix}] 执行延时更新`);
                this.lastDelayedUpdateTime = Date.now();
                await this.performInitialUpdate();
            } catch (error) {
                StatusLogger.error(`[${this.config.logPrefix}] 延时更新失败`, error);
            } finally {
                this.updateDebouncer = undefined;
            }
        }, finalDelayMs);
    }

    /**
     * 销毁状态栏项
     */
    dispose(): void {
        // 调用销毁钩子
        this.onDispose();

        // 清理定时器
        if (this.updateDebouncer) {
            clearTimeout(this.updateDebouncer);
            this.updateDebouncer = undefined;
        }
        if (this.cacheUpdateTimer) {
            clearInterval(this.cacheUpdateTimer);
            this.cacheUpdateTimer = undefined;
        }

        // 清理内存状态
        this.lastStatusData = null;
        this.lastDelayedUpdateTime = 0;
        this.isLoading = false;
        this.context = undefined;

        // 销毁状态栏项
        this.statusBarItem?.dispose();
        this.statusBarItem = undefined;

        this.initialized = false;

        StatusLogger.info(`[${this.config.logPrefix}] 状态栏项已销毁`);
    }

    // ==================== 私有方法 ====================

    /**
     * 执行初始更新（后台加载）
     */
    private async performInitialUpdate(): Promise<void> {
        // 检查是否设置了 API Key
        const hasKey = await ApiKeyManager.hasValidApiKey(this.config.apiKeyProvider);

        if (!hasKey) {
            if (this.statusBarItem) {
                this.statusBarItem.hide();
            }
            return;
        }

        // 确保状态栏显示
        if (this.statusBarItem) {
            this.statusBarItem.show();
        }

        // 执行 API 查询
        await this.executeApiQuery();
    }

    /**
     * 执行用户刷新（带加载状态）
     */
    private async performRefresh(): Promise<void> {
        this.isLoading = true;

        try {
            // 显示加载中状态
            if (this.statusBarItem && this.lastStatusData) {
                const previousText = this.getDisplayText(this.lastStatusData.data);
                this.statusBarItem.text = `$(loading~spin) ${previousText.replace(this.getIcon(), '').trim()}`;
                this.statusBarItem.backgroundColor = undefined;
                this.statusBarItem.tooltip = '加载中...';
            }

            // 检查是否设置了 API Key
            const hasKey = await ApiKeyManager.hasValidApiKey(this.config.apiKeyProvider);

            if (!hasKey) {
                if (this.statusBarItem) {
                    this.statusBarItem.hide();
                }
                return;
            }

            // 确保状态栏显示
            if (this.statusBarItem) {
                this.statusBarItem.show();
            }

            // 执行 API 查询
            await this.executeApiQuery();
        } finally {
            this.isLoading = false;
        }
    }

    /**
     * 执行 API 查询并更新状态栏
     */
    private async executeApiQuery(): Promise<void> {
        // 防止并发执行
        if (this.isLoading) {
            StatusLogger.debug(`[${this.config.logPrefix}] 正在执行查询，跳过重复调用`);
            return;
        }

        this.isLoading = true;

        try {
            StatusLogger.debug(`[${this.config.logPrefix}] 开始执行用量查询...`);

            const result = await this.performApiQuery();

            if (result.success && result.data) {
                if (this.statusBarItem) {
                    const data = result.data;

                    // 保存完整的用量数据
                    this.lastStatusData = {
                        data: data,
                        timestamp: Date.now()
                    };

                    // 保存到全局状态
                    if (this.context) {
                        this.context.globalState.update(this.getCacheKey('statusData'), this.lastStatusData);
                    }

                    // 更新状态栏 UI
                    this.updateStatusBarUI(data);

                    StatusLogger.info(`[${this.config.logPrefix}] 用量查询成功`);
                }
            } else {
                // 错误处理
                const errorMsg = result.error || '未知错误';

                if (this.statusBarItem) {
                    this.statusBarItem.text = `${this.getIcon()} ERR`;
                    this.statusBarItem.tooltip = `获取失败: ${errorMsg}`;
                }

                StatusLogger.warn(`[${this.config.logPrefix}] 用量查询失败: ${errorMsg}`);
            }
        } catch (error) {
            StatusLogger.error(`[${this.config.logPrefix}] 更新状态栏失败`, error);

            if (this.statusBarItem) {
                this.statusBarItem.text = `${this.getIcon()} ERR`;
                this.statusBarItem.tooltip = `获取失败: ${error instanceof Error ? error.message : '未知错误'}`;
            }
        } finally {
            // 确保在所有情况下都重置加载标志
            this.isLoading = false;
        }
    }

    /**
     * 更新状态栏 UI
     * @param data 状态数据
     */
    private updateStatusBarUI(data: T): void {
        if (!this.statusBarItem) {
            return;
        }

        // 更新文本
        this.statusBarItem.text = this.getDisplayText(data);

        // 更新背景颜色（警告高亮）
        if (this.shouldHighlightWarning(data)) {
            this.statusBarItem.backgroundColor = new vscode.ThemeColor('statusBarItem.warningBackground');
        } else {
            this.statusBarItem.backgroundColor = undefined;
        }

        // 更新 Tooltip
        this.statusBarItem.tooltip = this.generateTooltip(data);
    }

    /**
     * 从缓存读取并更新状态信息
     */
    private updateFromCache(): void {
        if (!this.context || !this.statusBarItem || this.isLoading) {
            return;
        }

        try {
            // 从全局状态读取缓存数据
            const cachedStatusData = this.context.globalState.get<CachedStatusData<T>>(this.getCacheKey('statusData'));

            if (cachedStatusData && cachedStatusData.data) {
                const dataAge = Date.now() - cachedStatusData.timestamp;

                // 检查是否需要触发刷新
                if (this.shouldRefresh()) {
                    this.performRefresh().catch(error => {
                        StatusLogger.error(`[${this.config.logPrefix}] 自动刷新失败`, error);
                    });
                    return;
                }

                if (dataAge > 30 * 1000) {
                    // 30秒以上的数据视为无变更，跳过更新
                    if (dataAge < 60 * 1000) {
                        // 30-60秒内的数据视为警告日志
                        StatusLogger.debug(
                            `[${this.config.logPrefix}] 缓存数据已过期 (${(dataAge / 1000).toFixed(1)}秒前)，跳过更新`
                        );
                    }
                    // 超过60秒的数据不再记录日志
                    return;
                }

                // 更新内存中的数据
                this.lastStatusData = cachedStatusData;

                // 更新状态栏显示
                this.updateStatusBarUI(cachedStatusData.data);

                StatusLogger.debug(
                    `[${this.config.logPrefix}] 从缓存更新状态 (缓存时间: ${(dataAge / 1000).toFixed(1)}秒前)`
                );
            }
        } catch (error) {
            StatusLogger.warn(`[${this.config.logPrefix}] 从缓存更新状态失败`, error);
        }
    }

    /**
     * 启动缓存更新定时器
     */
    private startCacheUpdateTimer(): void {
        if (this.cacheUpdateTimer) {
            clearInterval(this.cacheUpdateTimer);
        }

        this.cacheUpdateTimer = setInterval(() => {
            this.updateFromCache();
        }, this.CACHE_UPDATE_INTERVAL);

        StatusLogger.debug(`[${this.config.logPrefix}] 缓存更新定时器已启动，间隔: ${this.CACHE_UPDATE_INTERVAL}ms`);
    }

    /**
     * 注册主实例定时刷新任务
     */
    private registerLeaderPeriodicTask(): void {
        LeaderElectionService.registerPeriodicTask(async () => {
            // 只有主实例才会执行此任务
            if (!this.initialized || !this.context || !this.statusBarItem) {
                return;
            }

            // 检查是否需要刷新
            if (this.shouldRefresh()) {
                StatusLogger.debug(`[${this.config.logPrefix}] 主实例触发定时刷新`);
                await this.executeApiQuery();
            }
        });

        StatusLogger.debug(`[${this.config.logPrefix}] 已注册主实例定时刷新任务`);
    }
}
