/*---------------------------------------------------------------------------------------------
 *  状态栏项基类
 *  提供状态栏管理的通用逻辑和生命周期管理
 *  此类为最通用的基类，不包含 API Key 相关逻辑
 *  适用于需要管理多个提供商或自定义显示逻辑的状态栏项（如 CompatibleStatusBar）
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { StatusLogger } from '../utils/statusLogger';
import { LeaderElectionService } from './leaderElectionService';
import { t } from '../utils/l10n';

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
 * 基础状态栏项配置
 * 不包含 apiKeyProvider，适用于不依赖单个 API Key 的状态栏
 */
export interface BaseStatusBarItemConfig {
    /** 状态栏项唯一标识符（用于 VS Code 区分不同状态栏项） */
    id: string;
    /** 状态栏项名称（显示在状态栏项菜单中） */
    name: string;
    /** 状态栏项对齐方式 */
    alignment: vscode.StatusBarAlignment;
    /** 状态栏项优先级 */
    priority: number;
    /** 刷新命令ID */
    refreshCommand: string;
    /** 缓存键前缀 */
    cacheKeyPrefix: string;
    /** 日志前缀 */
    logPrefix: string;
    /** 状态栏图标，如 '$(gcmp-minimax)' */
    icon: string;
}

/**
 * 扩展的状态栏项配置（包含 API Key 提供商）
 * 适用于单提供商状态栏（如 MiniMaxStatusBar、DeepSeekStatusBar 等）
 */
export interface StatusBarItemConfig extends BaseStatusBarItemConfig {
    /** API Key 提供商标识 */
    apiKeyProvider: string;
}

/**
 * 状态栏项基类
 * 提供状态栏管理的最通用逻辑，包括：
 * - 生命周期管理（初始化、销毁）
 * - 刷新机制（手动刷新、延时刷新、周期性刷新）
 * - 缓存管理（读取、写入、过期检测）
 * - 防抖逻辑
 *
 * 此类不包含 API Key 相关逻辑，适用于：
 * - 管理多个提供商的状态栏（如 CompatibleStatusBar）
 * - 自定义显示逻辑的状态栏
 *
 * 对于单提供商状态栏，请使用 ProviderStatusBarItem 子类
 *
 * @template T 状态数据类型
 */
export abstract class BaseStatusBarItem<T> {
    // ==================== 实例成员 ====================
    protected statusBarItem: vscode.StatusBarItem | undefined;
    protected context: vscode.ExtensionContext | undefined;
    protected readonly config: BaseStatusBarItemConfig;

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
    protected readonly HIGH_USAGE_THRESHOLD = 80; // 高使用率阈值 80%

    /**
     * 构造函数
     * @param config 状态栏项配置
     */
    constructor(config: BaseStatusBarItemConfig) {
        this.config = config;
        this.validateConfig();
    }

    /**
     * 验证配置参数的有效性
     * @throws {Error} 当配置无效时抛出错误
     */
    private validateConfig(): void {
        const requiredFields: (keyof BaseStatusBarItemConfig)[] = [
            'id',
            'name',
            'refreshCommand',
            'cacheKeyPrefix',
            'logPrefix',
            'icon'
        ];

        for (const field of requiredFields) {
            if (!this.config[field]) {
                throw new Error(`Invalid status bar configuration: ${field} cannot be empty.`);
            }
        }

        if (typeof this.config.priority !== 'number') {
            throw new Error('Invalid status bar configuration: priority must be a number.');
        }
    }

    // ==================== 抽象方法（子类必须实现） ====================

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
     * 检查是否需要刷新缓存
     * 由子类实现自定义的刷新判断逻辑（包括缓存触发和主实例定时触发）
     * @returns 是否需要刷新
     */
    protected abstract shouldRefresh(): boolean;

    /**
     * 检查是否应该显示状态栏
     * 子类需要根据自身逻辑实现（如检查 API Key 是否存在、是否有配置的提供商等）
     * @returns 是否应该显示状态栏
     */
    protected abstract shouldShowStatusBar(): Promise<boolean>;

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

    /**
     * 在状态数据成功更新后执行的钩子方法
     * 子类可以重写此方法以执行数据更新后的额外逻辑
     */
    protected onStatusDataUpdated(): void {
        // 默认为空实现，子类可以重写
    }

    // ==================== 公共方法 ====================

    /**
     * 初始化状态栏项
     * @param context 扩展上下文
     */
    async initialize(context: vscode.ExtensionContext): Promise<void> {
        if (this.initialized) {
            StatusLogger.warn(
                `[${this.config.logPrefix}] Status bar item is already initialized. Skipping duplicate initialization.`
            );
            return;
        }

        this.context = context;

        // 创建 StatusBarItem（使用唯一 id 确保 VS Code 能正确区分不同状态栏项）
        this.statusBarItem = vscode.window.createStatusBarItem(
            this.config.id,
            this.config.alignment,
            this.config.priority
        );
        this.statusBarItem.name = this.config.name;
        this.statusBarItem.text = this.config.icon;
        this.statusBarItem.command = this.config.refreshCommand;

        // 异步检查是否应该显示状态栏(不阻塞初始化)
        // 先隐藏,等检查完成后再决定是否显示
        this.statusBarItem.hide();
        this.shouldShowStatusBar()
            .then(shouldShow => {
                if (shouldShow && this.statusBarItem) {
                    this.statusBarItem.show();
                } else {
                    StatusLogger.trace(`[${this.config.logPrefix}] Display conditions not met. Hiding status bar.`);
                }
            })
            .catch(error => {
                StatusLogger.error(`[${this.config.logPrefix}] Failed to evaluate display conditions`, error);
            });

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

        StatusLogger.info(`[${this.config.logPrefix}] Status bar item initialized`);
    }

    /**
     * 检查并显示状态栏（在满足条件后调用）
     */
    async checkAndShowStatus(): Promise<void> {
        if (this.statusBarItem) {
            const shouldShow = await this.shouldShowStatusBar();
            if (shouldShow) {
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
            timeSinceLastUpdate < this.MIN_DELAYED_UPDATE_INTERVAL ?
                this.MIN_DELAYED_UPDATE_INTERVAL - timeSinceLastUpdate
            :   delayMs;

        StatusLogger.debug(`[${this.config.logPrefix}] Scheduled delayed update in ${finalDelayMs / 1000} seconds`);

        // 设置新的防抖定时器
        this.updateDebouncer = setTimeout(async () => {
            try {
                StatusLogger.debug(`[${this.config.logPrefix}] Running delayed update`);
                this.lastDelayedUpdateTime = Date.now();
                await this.performInitialUpdate();
            } catch (error) {
                StatusLogger.error(`[${this.config.logPrefix}] Delayed update failed`, error);
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

        StatusLogger.info(`[${this.config.logPrefix}] Status bar item disposed`);
    }

    // ==================== 私有方法 ====================

    /**
     * 执行初始更新（后台加载）
     */
    private async performInitialUpdate(): Promise<void> {
        // 检查是否应该显示状态栏
        const shouldShow = await this.shouldShowStatusBar();

        if (!shouldShow) {
            if (this.statusBarItem) {
                this.statusBarItem.hide();
            }
            return;
        }

        // 确保状态栏显示
        if (this.statusBarItem) {
            this.statusBarItem.show();
        }

        // 执行 API 查询（自动刷新，失败时不显示 ERR）
        await this.executeApiQuery(false);
    }

    /**
     * 执行用户刷新（带加载状态）
     */
    private async performRefresh(): Promise<void> {
        try {
            // 显示加载中状态
            if (this.statusBarItem && this.lastStatusData) {
                const previousText = this.getDisplayText(this.lastStatusData.data);
                this.statusBarItem.text = `$(loading~spin) ${previousText.replace(this.config.icon, '').trim()}`;
                this.statusBarItem.backgroundColor = undefined;
                this.statusBarItem.tooltip = t('Loading...', '加载中...');
            }

            // 检查是否应该显示状态栏
            const shouldShow = await this.shouldShowStatusBar();

            if (!shouldShow) {
                if (this.statusBarItem) {
                    this.statusBarItem.hide();
                }
                return;
            }

            // 确保状态栏显示
            if (this.statusBarItem) {
                this.statusBarItem.show();
            }

            // 执行 API 查询（手动刷新，失败时显示 ERR）
            await this.executeApiQuery(true);
        } catch (error) {
            StatusLogger.error(`[${this.config.logPrefix}] Refresh failed`, error);

            if (this.statusBarItem) {
                this.statusBarItem.text = `${this.config.icon} ERR`;
                this.statusBarItem.tooltip = t(
                    'Failed to fetch: {0}',
                    '获取失败: {0}',
                    error instanceof Error ? error.message : t('Unknown error', '未知错误')
                );
            }
        }
    }

    /**
     * 执行 API 查询并更新状态栏
     * @param isManualRefresh 是否为手动刷新（用户点击触发），手动刷新失败时显示 ERR，自动刷新失败时保持原状态
     */
    protected async executeApiQuery(isManualRefresh = false): Promise<void> {
        // 防止并发执行
        if (this.isLoading) {
            StatusLogger.debug(`[${this.config.logPrefix}] Query already running. Skipping duplicate request.`);
            return;
        }

        // 非手动刷新时，检查缓存是否在 5 秒内有效，有效则跳过本次加载
        if (!isManualRefresh && this.lastStatusData) {
            try {
                const dataAge = Date.now() - this.lastStatusData.timestamp;
                if (dataAge >= 0 && dataAge < 5000) {
                    StatusLogger.debug(
                        `[${this.config.logPrefix}] Cached data is still valid within 5 seconds (${(dataAge / 1000).toFixed(1)}s ago). Skipping auto refresh.`
                    );
                    return;
                }
            } catch {
                // 旧版本数据格式不兼容，忽略错误继续执行刷新
                StatusLogger.debug(
                    `[${this.config.logPrefix}] Cached data format is incompatible. Continuing refresh.`
                );
            }
        }

        this.isLoading = true;

        try {
            StatusLogger.debug(`[${this.config.logPrefix}] Starting usage query...`);

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

                    // 通知子类数据已更新（子类可重写此方法执行额外逻辑）
                    this.onStatusDataUpdated();

                    StatusLogger.info(`[${this.config.logPrefix}] Usage query succeeded`);
                }
            } else {
                // 错误处理
                const errorMsg = result.error || t('Unknown error', '未知错误');

                // 只有手动刷新时才显示 ERR，自动刷新失败时保持原状态等待下次刷新
                if (isManualRefresh && this.statusBarItem) {
                    this.statusBarItem.text = `${this.config.icon} ERR`;
                    this.statusBarItem.tooltip = t('Failed to fetch: {0}', '获取失败: {0}', errorMsg);
                }

                StatusLogger.warn(`[${this.config.logPrefix}] Usage query failed: ${errorMsg}`);
            }
        } catch (error) {
            StatusLogger.error(`[${this.config.logPrefix}] Failed to update status bar`, error);

            // 只有手动刷新时才显示 ERR，自动刷新失败时保持原状态等待下次刷新
            if (isManualRefresh && this.statusBarItem) {
                this.statusBarItem.text = `${this.config.icon} ERR`;
                this.statusBarItem.tooltip = t(
                    'Failed to fetch: {0}',
                    '获取失败: {0}',
                    error instanceof Error ? error.message : t('Unknown error', '未知错误')
                );
            }
        } finally {
            // 一定要在最后重置加载状态
            this.isLoading = false;
        }
    }

    /**
     * 更新状态栏 UI
     * @param data 状态数据
     */
    protected updateStatusBarUI(data: T): void {
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

                if (dataAge > 30 * 1000) {
                    // 30秒以上的数据视为无变更，跳过更新
                    if (dataAge < 60 * 1000) {
                        // 30-60秒内的数据视为警告日志
                        StatusLogger.debug(
                            `[${this.config.logPrefix}] Cached data has expired (${(dataAge / 1000).toFixed(1)}s ago). Skipping update.`
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
                    `[${this.config.logPrefix}] Updated status from cache (${(dataAge / 1000).toFixed(1)}s ago)`
                );
            }
        } catch (error) {
            StatusLogger.warn(`[${this.config.logPrefix}] Failed to update status from cache`, error);
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

        StatusLogger.debug(`[${this.config.logPrefix}] Cache update timer started (${this.CACHE_UPDATE_INTERVAL}ms)`);
    }

    /**
     * 注册主实例定时刷新任务
     */
    private registerLeaderPeriodicTask(): void {
        LeaderElectionService.registerPeriodicTask(async () => {
            // 只有主实例才会执行此任务
            if (!this.initialized || !this.context || !this.statusBarItem) {
                StatusLogger.trace(
                    `[${this.config.logPrefix}] Skipping leader periodic task: not initialized or missing context.`
                );
                return;
            }

            // 检查是否需要刷新
            const needRefresh = this.shouldRefresh();
            StatusLogger.trace(
                `[${this.config.logPrefix}] Leader periodic task check: needRefresh=${needRefresh}, lastStatusData=${!!this.lastStatusData}`
            );

            if (needRefresh) {
                StatusLogger.debug(`[${this.config.logPrefix}] Leader instance triggered scheduled refresh`);
                // 定时刷新属于自动刷新，失败时不显示 ERR
                await this.executeApiQuery(false);
            }
        });

        StatusLogger.debug(`[${this.config.logPrefix}] Registered leader periodic refresh task`);
    }
}
