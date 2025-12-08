/*---------------------------------------------------------------------------------------------
 *  兼容提供商状态栏项
 *  独立实现，不继承 BaseStatusBarItem
 *  此状态栏存在多个内置供应商查询，各提供商缓存独立，与一般继承实现不同
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { StatusLogger } from '../utils/statusLogger';
import { CompatibleModelManager } from '../utils/compatibleModelManager';
import { BalanceQueryManager } from './compatible/balanceQueryManager';
import { LeaderElectionService } from './leaderElectionService';

/**
 * 兼容提供商余额信息
 */
export interface CompatibleProviderBalance {
    /** 提供商标识符 */
    providerId: string;
    /** 提供商显示名称 */
    providerName: string;
    /** 已支付余额 */
    paid?: number;
    /** 赠送余额 */
    granted?: number;
    /** 可用余额 */
    balance: number;
    /** 货币符号 */
    currency: string;
    /** 最后更新时间 */
    lastUpdated: Date;
    /** 查询是否成功 */
    success: boolean;
    /** 错误信息（如果查询失败） */
    error?: string;
}

/**
 * 兼容状态栏数据
 */
interface CompatibleStatusData {
    /** 所有提供商的余额信息 */
    providers: CompatibleProviderBalance[];
    /** 查询成功的提供商数量 */
    successCount: number;
    /** 总提供商数量 */
    totalCount: number;
}

/**
 * 缓存数据结构
 */
interface CachedStatusData {
    /** 状态数据 */
    data: CompatibleStatusData;
    /** 缓存时间戳 */
    timestamp: number;
}

/**
 * 单个提供商的缓存数据
 */
interface ProviderCacheData {
    /** 提供商余额信息 */
    balance: CompatibleProviderBalance;
    /** 缓存时间戳 */
    timestamp: number;
}

/**
 * 状态栏项配置
 */
interface StatusBarItemConfig {
    /** 状态栏项唯一标识符 */
    id: string;
    /** 状态栏项名称 */
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
    /** 状态栏图标 */
    icon: string;
}

/**
 * 兼容提供商状态栏项
 * 显示多个兼容提供商的余额信息，包括：
 * - 各提供商的余额
 * - 总余额（相同货币累加）
 * - 查询状态
 *
 * 独立实现，不继承 BaseStatusBarItem，因为：
 * - 管理多个内置供应商的查询
 * - 各提供商缓存独立
 * - 与一般单提供商继承实现不同
 */
export class CompatibleStatusBar {
    // ==================== 实例成员 ====================
    private statusBarItem: vscode.StatusBarItem | undefined;
    private context: vscode.ExtensionContext | undefined;
    private readonly config: StatusBarItemConfig;

    // 状态数据
    private lastStatusData: CachedStatusData | null = null;
    /** 各提供商独立缓存 */
    private providerCaches = new Map<string, ProviderCacheData>();

    // 定时器
    private updateDebouncer: NodeJS.Timeout | undefined;
    private cacheUpdateTimer: NodeJS.Timeout | undefined;

    // 时间戳
    /** 各提供商的最后延时更新时间戳 */
    private providerLastDelayedUpdateTimes = new Map<string, number>();

    // 标志位
    private isLoading = false;
    private initialized = false;

    // 常量配置
    private readonly MIN_DELAYED_UPDATE_INTERVAL = 30000; // 最小延时更新间隔 30 秒
    private readonly CACHE_UPDATE_INTERVAL = 10000; // 缓存加载间隔 10 秒
    private readonly PROVIDER_CACHE_EXPIRY = 5 * 60 * 1000; // 单个提供商缓存过期时间 5 分钟

    constructor() {
        this.config = {
            id: 'gcmp.statusBar.compatible',
            name: 'GCMP: Compatible Balance',
            alignment: vscode.StatusBarAlignment.Right,
            priority: 10, // 优先级取一个低值，靠右显示
            refreshCommand: 'gcmp.compatible.refreshBalance',
            cacheKeyPrefix: 'compatible',
            logPrefix: 'Compatible状态栏',
            icon: '$(gcmp-compatible)'
        };
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
        this.statusBarItem = vscode.window.createStatusBarItem(
            this.config.id,
            this.config.alignment,
            this.config.priority
        );
        this.statusBarItem.name = this.config.name;
        this.statusBarItem.text = this.config.icon;
        this.statusBarItem.command = this.config.refreshCommand;

        // 加载各提供商的独立缓存
        this.loadProviderCaches();

        // 检查是否有配置的兼容模型和支持的提供商
        const models = CompatibleModelManager.getModels();
        const supportedProviders = new Set(BalanceQueryManager.getRegisteredProviders());
        const hasSupportedProviders = models.some(m => m.provider && supportedProviders.has(m.provider));

        if (hasSupportedProviders) {
            this.statusBarItem.show();
        } else {
            StatusLogger.trace(`[${this.config.logPrefix}] 未配置支持查询的兼容提供商，隐藏状态栏`);
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

        // 监听兼容模型变更事件
        const disposable = CompatibleModelManager.onDidChangeModels(() => {
            StatusLogger.debug(`[${this.config.logPrefix}] 兼容模型配置变更，触发状态更新`);
            this.delayedUpdate(1000); // 延迟1秒更新，避免频繁调用
        });
        context.subscriptions.push(disposable);

        StatusLogger.info(`[${this.config.logPrefix}] 状态栏项初始化完成`);
    }

    /**
     * 检查并显示状态栏
     */
    async checkAndShowStatus(): Promise<void> {
        if (this.statusBarItem) {
            const models = CompatibleModelManager.getModels();
            const supportedProviders = new Set(BalanceQueryManager.getRegisteredProviders());
            const hasSupportedProviders = models.some(m => m.provider && supportedProviders.has(m.provider));

            if (hasSupportedProviders) {
                this.statusBarItem.show();
                this.performInitialUpdate();
            } else {
                this.statusBarItem.hide();
            }
        }
    }

    /**
     * 延时更新指定提供商的余额
     * 包含防抖机制，避免频繁请求
     * @param providerId 提供商标识符
     * @param delayMs 延时时间（毫秒）
     */
    delayedUpdate(delayMs?: number): void;
    delayedUpdate(providerId: string, delayMs?: number): void;
    delayedUpdate(providerId?: string | number, delayMs = 2000): void {
        if (!providerId || typeof providerId !== 'string') {
            return; // 只支持指定提供商进行延时更新余额
        }

        // 清除之前的防抖定时器
        if (this.updateDebouncer) {
            clearTimeout(this.updateDebouncer);
        }

        const now = Date.now();
        const lastUpdateTime = this.providerLastDelayedUpdateTimes.get(providerId) || 0;
        const timeSinceLastUpdate = now - lastUpdateTime;

        // 如果距离上次更新不足阈值，则等到满阈值再执行
        const finalDelayMs =
            timeSinceLastUpdate < this.MIN_DELAYED_UPDATE_INTERVAL
                ? this.MIN_DELAYED_UPDATE_INTERVAL - timeSinceLastUpdate
                : delayMs;

        StatusLogger.debug(
            `[${this.config.logPrefix}] 设置延时更新提供商 ${providerId}，将在 ${finalDelayMs / 1000} 秒后执行`
        );

        // 设置新的防抖定时器
        this.updateDebouncer = setTimeout(async () => {
            try {
                StatusLogger.debug(`[${this.config.logPrefix}] 执行延时更新提供商 ${providerId}`);
                this.providerLastDelayedUpdateTimes.set(providerId, Date.now());
                await this.performProviderUpdate(providerId);
            } catch (error) {
                StatusLogger.error(`[${this.config.logPrefix}] 延时更新提供商 ${providerId} 失败`, error);
            } finally {
                this.updateDebouncer = undefined;
            }
        }, finalDelayMs);
    }

    /**
     * 销毁状态栏项
     */
    dispose(): void {
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
        this.providerCaches.clear();
        this.providerLastDelayedUpdateTimes.clear();
        this.isLoading = false;
        this.context = undefined;

        // 销毁状态栏项
        this.statusBarItem?.dispose();
        this.statusBarItem = undefined;

        this.initialized = false;

        StatusLogger.info(`[${this.config.logPrefix}] 状态栏项已销毁`);
    }

    // ==================== 私有方法：缓存管理 ====================

    /**
     * 获取缓存键名
     */
    private getCacheKey(key: string): string {
        return `${this.config.cacheKeyPrefix}.${key}`;
    }

    /**
     * 获取提供商独立缓存键名
     */
    private getProviderCacheKey(providerId: string): string {
        return `${this.config.cacheKeyPrefix}.provider.${providerId}`;
    }

    /**
     * 加载各提供商的独立缓存
     */
    private loadProviderCaches(): void {
        if (!this.context) {
            return;
        }

        try {
            const registeredProviders = BalanceQueryManager.getRegisteredProviders();

            for (const providerId of registeredProviders) {
                const cacheKey = this.getProviderCacheKey(providerId);
                const cached = this.context.globalState.get<ProviderCacheData>(cacheKey);
                if (cached) {
                    // 直接使用缓存数据，无需修复 Date 对象序列化问题
                    this.providerCaches.set(providerId, cached);
                }
            }

            StatusLogger.debug(`[${this.config.logPrefix}] 已加载 ${this.providerCaches.size} 个提供商缓存`);
        } catch (error) {
            StatusLogger.error(`[${this.config.logPrefix}] 加载提供商缓存失败`, error);
        }
    }

    /**
     * 保存提供商独立缓存
     */
    private async saveProviderCache(providerId: string, balance: CompatibleProviderBalance): Promise<void> {
        if (!this.context) {
            return;
        }

        try {
            const cacheData: ProviderCacheData = {
                balance,
                timestamp: Date.now()
            };

            this.providerCaches.set(providerId, cacheData);

            const cacheKey = this.getProviderCacheKey(providerId);
            await this.context.globalState.update(cacheKey, cacheData);

            StatusLogger.debug(`[${this.config.logPrefix}] 已保存提供商 ${providerId} 缓存`);
        } catch (error) {
            StatusLogger.error(`[${this.config.logPrefix}] 保存提供商 ${providerId} 缓存失败`, error);
        }
    }

    /**
     * 检查提供商缓存是否过期
     */
    private isProviderCacheExpired(providerId: string): boolean {
        const cached = this.providerCaches.get(providerId);
        if (!cached) {
            return true;
        }

        const now = Date.now();
        const cacheAge = now - cached.timestamp;
        return cacheAge > this.PROVIDER_CACHE_EXPIRY;
    }

    /**
     * 获取缓存数据
     */
    private getCachedData(): CachedStatusData | null {
        try {
            if (!this.context) {
                return null;
            }

            const cacheKey = this.getCacheKey('statusData');
            const cached = this.context.globalState.get<CachedStatusData>(cacheKey);

            if (!cached) {
                return null;
            }

            // 直接使用缓存数据，无需修复 Date 对象序列化问题
            return cached;
        } catch (error) {
            StatusLogger.error(`[${this.config.logPrefix}] 读取缓存失败`, error);
            return null;
        }
    }

    // ==================== 私有方法：显示相关 ====================

    /**
     * 获取显示文本
     */
    private getDisplayText(data: CompatibleStatusData): string {
        const { successCount, totalCount, providers } = data;
        if (successCount === 0) {
            return `${this.config.icon} Compatible`;
        }

        // 直接列出各提供商的金额
        const balanceTexts: string[] = [];
        const sortedProviders = providers.sort((a, b) => a.providerId.localeCompare(b.providerId));
        for (const provider of sortedProviders) {
            // 默认货币为CNY，除非明确指定为USD
            const currencySymbol = provider.currency === 'USD' ? '$' : '¥';
            balanceTexts.push(`${currencySymbol}${provider.balance.toFixed(2)}`);
        }

        const balanceText = balanceTexts.join(' ');
        if (successCount === totalCount) {
            return `${this.config.icon} ${balanceText}`;
        }
        return `${this.config.icon} (${successCount}/${totalCount}) | ${balanceText}`;
    }

    /**
     * 生成 Tooltip 内容
     */
    private generateTooltip(data: CompatibleStatusData): vscode.MarkdownString {
        const md = new vscode.MarkdownString();
        md.supportHtml = true;
        md.appendMarkdown('#### Compatible 提供商余额信息\n\n');

        if (data.providers.length === 0) {
            md.appendMarkdown('暂无配置的 Compatible 提供商\n');
            md.appendMarkdown('\n---\n');
            md.appendMarkdown('点击状态栏可手动刷新\n');
            return md;
        }

        md.appendMarkdown('| 提供商 | 充值余额 | 赠金余额 | 可用余额 |\n');
        md.appendMarkdown('| :--- |---: | ---: | ---: |\n');

        const sortedProviders = data.providers.sort((a, b) => a.providerId.localeCompare(b.providerId));
        for (const provider of sortedProviders) {
            if (provider.success) {
                const currencySymbol = provider.currency === 'USD' ? '$' : '¥';
                const paidBalance = provider.paid !== undefined ? `${currencySymbol}${provider.paid.toFixed(2)}` : '-';
                const grantedBalance =
                    provider.granted !== undefined ? `${currencySymbol}${provider.granted.toFixed(2)}` : '-';
                const availableBalance = `${currencySymbol}${provider.balance.toFixed(2)}`;

                md.appendMarkdown(
                    `| ${provider.providerName} | ${paidBalance} | ${grantedBalance} | ${availableBalance} |\n`
                );
            } else {
                md.appendMarkdown(`| ${provider.providerName} |  - | - | 查询失败 |\n`);
            }
        }

        md.appendMarkdown('\n---\n');
        md.appendMarkdown('点击状态栏可手动刷新\n');
        return md;
    }

    // ==================== 私有方法：查询和刷新 ====================

    /**
     * 执行初始更新（后台加载）
     */
    private async performInitialUpdate(): Promise<void> {
        // 检查是否有配置的兼容模型
        const models = CompatibleModelManager.getModels();
        const supportedProviders = new Set(BalanceQueryManager.getRegisteredProviders());

        // 检查是否有支持查询的提供商
        const hasSupportedProviders = models.some(m => m.provider && supportedProviders.has(m.provider));

        if (!hasSupportedProviders) {
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
                this.statusBarItem.tooltip = '加载中...';
            }

            // 确保状态栏显示
            if (this.statusBarItem) {
                this.statusBarItem.show();
            }

            // 执行 API 查询（手动刷新，失败时显示 ERR）
            await this.executeApiQuery(true);
        } catch (error) {
            StatusLogger.error(`[${this.config.logPrefix}] 刷新失败`, error);

            if (this.statusBarItem) {
                this.statusBarItem.text = `${this.config.icon} ERR`;
                this.statusBarItem.tooltip = `获取失败: ${error instanceof Error ? error.message : '未知错误'}`;
            }
        }
    }

    /**
     * 执行 API 查询并更新状态栏
     * @param isManualRefresh 是否为手动刷新（用户点击触发），手动刷新失败时显示 ERR，自动刷新失败时保持原状态
     */
    private async executeApiQuery(isManualRefresh = false): Promise<void> {
        // 防止并发执行
        if (this.isLoading) {
            StatusLogger.debug(`[${this.config.logPrefix}] 正在执行查询，跳过重复调用`);
            return;
        }

        // 非手动刷新时，检查缓存是否在 5 秒内有效，有效则跳过本次加载
        if (!isManualRefresh && this.lastStatusData) {
            try {
                const dataAge = Date.now() - this.lastStatusData.timestamp;
                if (dataAge >= 0 && dataAge < 5000) {
                    StatusLogger.debug(
                        `[${this.config.logPrefix}] 数据在 5 秒内有效 (${(dataAge / 1000).toFixed(1)}秒前)，跳过本次自动刷新`
                    );
                    return;
                }
            } catch {
                // 旧版本数据格式不兼容，忽略错误继续执行刷新
                StatusLogger.debug(`[${this.config.logPrefix}] 缓存数据格式不兼容，继续执行刷新`);
            }
        }

        this.isLoading = true;

        try {
            StatusLogger.debug(`[${this.config.logPrefix}] 开始执行余额查询...`);

            const result = await this.performApiQuery(isManualRefresh);

            if (result.success && result.data) {
                if (this.statusBarItem) {
                    const data = result.data;

                    // 检查是否有任何查询结果
                    if (data.providers.length === 0) {
                        // 没有任何提供商可以查询，隐藏状态栏
                        this.statusBarItem.hide();
                        StatusLogger.debug(`[${this.config.logPrefix}] 没有支持查询的提供商，隐藏状态栏`);
                        return;
                    }

                    // 保存完整的状态数据
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

                    StatusLogger.info(`[${this.config.logPrefix}] 余额查询成功`);
                }
            } else {
                // 错误处理
                const errorMsg = result.error || '未知错误';

                // 只有手动刷新时才显示 ERR，自动刷新失败时保持原状态等待下次刷新
                if (isManualRefresh && this.statusBarItem) {
                    this.statusBarItem.text = `${this.config.icon} ERR`;
                    this.statusBarItem.tooltip = `获取失败: ${errorMsg}`;
                }

                StatusLogger.warn(`[${this.config.logPrefix}] 余额查询失败: ${errorMsg}`);
            }
        } catch (error) {
            StatusLogger.error(`[${this.config.logPrefix}] 更新状态栏失败`, error);

            // 只有手动刷新时才显示 ERR，自动刷新失败时保持原状态等待下次刷新
            if (isManualRefresh && this.statusBarItem) {
                this.statusBarItem.text = `${this.config.icon} ERR`;
                this.statusBarItem.tooltip = `获取失败: ${error instanceof Error ? error.message : '未知错误'}`;
            }
        } finally {
            // 一定要在最后重置加载状态
            this.isLoading = false;
        }
    }

    /**
     * 执行 API 查询
     * 查询所有兼容提供商的余额信息
     * 使用各提供商独立缓存，只查询缓存过期的提供商
     * @param forceRefresh 是否强制刷新所有提供商
     */
    private async performApiQuery(
        forceRefresh = false
    ): Promise<{ success: boolean; data?: CompatibleStatusData; error?: string }> {
        try {
            const models = CompatibleModelManager.getModels();
            const supportedProviders = new Set(BalanceQueryManager.getRegisteredProviders());
            const providerMap = new Map<string, CompatibleProviderBalance>();

            // 按提供商分组模型，只处理支持的提供商
            for (const model of models) {
                if (!model.provider || !supportedProviders.has(model.provider)) {
                    continue;
                }

                if (!providerMap.has(model.provider)) {
                    const knownProvider = CompatibleModelManager.KnownProviders[model.provider];

                    // 首先尝试从独立缓存加载
                    const cachedProvider = this.providerCaches.get(model.provider);
                    if (cachedProvider && !forceRefresh && !this.isProviderCacheExpired(model.provider)) {
                        // 使用缓存数据
                        providerMap.set(model.provider, cachedProvider.balance);
                    } else {
                        // 需要查询的提供商
                        providerMap.set(model.provider, {
                            providerId: model.provider,
                            providerName: knownProvider?.displayName || model.provider,
                            balance: 0,
                            currency: 'CNY', // 默认货币
                            lastUpdated: new Date(),
                            success: false
                        });
                    }
                }
            }

            // 找出需要查询的提供商（缓存过期或强制刷新）
            const providersToQuery = Array.from(providerMap.values()).filter(
                provider => !provider.success || forceRefresh || this.isProviderCacheExpired(provider.providerId)
            );

            StatusLogger.debug(
                `[${this.config.logPrefix}] 需要查询 ${providersToQuery.length}/${providerMap.size} 个提供商`
            );

            // 并行查询需要更新的提供商
            const queryPromises = providersToQuery.map(async provider => {
                try {
                    // 使用余额查询管理器查询余额
                    const balanceInfo = await BalanceQueryManager.queryBalance(provider.providerId);

                    provider.paid = balanceInfo.paid;
                    provider.granted = balanceInfo.granted;
                    provider.balance = balanceInfo.balance;
                    provider.currency = balanceInfo.currency;
                    provider.lastUpdated = new Date();
                    provider.success = true;

                    // 保存到独立缓存
                    await this.saveProviderCache(provider.providerId, provider);
                } catch (error) {
                    StatusLogger.error(`[${this.config.logPrefix}] 查询提供商 ${provider.providerId} 余额失败`, error);
                    provider.error = typeof error === 'string' ? error : '查询失败';
                    provider.success = false;
                }
            });

            await Promise.all(queryPromises);

            const successCount = Array.from(providerMap.values()).filter(p => p.success).length;

            const statusData: CompatibleStatusData = {
                providers: Array.from(providerMap.values()),
                successCount,
                totalCount: providerMap.size
            };

            return { success: true, data: statusData };
        } catch (error) {
            StatusLogger.error(`[${this.config.logPrefix}] 查询兼容提供商余额失败`, error);
            return { success: false, error: typeof error === 'string' ? error : '查询失败' };
        }
    }

    /**
     * 执行单个提供商的余额查询并更新状态栏
     * @param providerId 提供商标识符
     */
    private async performProviderUpdate(providerId: string): Promise<void> {
        // 防止并发执行
        if (this.isLoading) {
            StatusLogger.debug(`[${this.config.logPrefix}] 正在执行查询，跳过提供商 ${providerId} 的更新`);
            return;
        }

        // 检查提供商是否支持
        const supportedProviders = new Set(BalanceQueryManager.getRegisteredProviders());
        if (!supportedProviders.has(providerId)) {
            StatusLogger.warn(`[${this.config.logPrefix}] 提供商 ${providerId} 不支持余额查询`);
            return;
        }

        this.isLoading = true;

        try {
            StatusLogger.debug(`[${this.config.logPrefix}] 开始查询提供商 ${providerId} 的余额...`);

            // 获取提供商信息
            const knownProvider = CompatibleModelManager.KnownProviders[providerId];
            const providerName = knownProvider?.displayName || providerId;

            // 创建提供商余额信息对象
            const providerBalance: CompatibleProviderBalance = {
                providerId,
                providerName,
                balance: 0,
                currency: 'CNY', // 默认货币
                lastUpdated: new Date(),
                success: false
            };

            // 查询余额
            try {
                const balanceInfo = await BalanceQueryManager.queryBalance(providerId);

                providerBalance.paid = balanceInfo.paid;
                providerBalance.granted = balanceInfo.granted;
                providerBalance.balance = balanceInfo.balance;
                providerBalance.currency = balanceInfo.currency;
                providerBalance.lastUpdated = new Date();
                providerBalance.success = true;

                // 保存到独立缓存
                await this.saveProviderCache(providerId, providerBalance);

                StatusLogger.info(`[${this.config.logPrefix}] 提供商 ${providerId} 余额查询成功`);
            } catch (error) {
                StatusLogger.error(`[${this.config.logPrefix}] 查询提供商 ${providerId} 余额失败`, error);
                providerBalance.error = typeof error === 'string' ? error : '查询失败';
                providerBalance.success = false;
            }

            // 更新状态数据
            if (this.lastStatusData && this.lastStatusData.data) {
                // 查找并更新现有提供商数据
                const existingProviderIndex = this.lastStatusData.data.providers.findIndex(
                    p => p.providerId === providerId
                );

                if (existingProviderIndex >= 0) {
                    // 更新现有提供商
                    this.lastStatusData.data.providers[existingProviderIndex] = providerBalance;
                } else {
                    // 添加新提供商
                    this.lastStatusData.data.providers.push(providerBalance);
                    this.lastStatusData.data.totalCount++;
                }

                // 更新成功计数
                this.lastStatusData.data.successCount = this.lastStatusData.data.providers.filter(
                    p => p.success
                ).length;

                // 更新时间戳
                this.lastStatusData.timestamp = Date.now();

                // 保存到全局状态
                if (this.context) {
                    this.context.globalState.update(this.getCacheKey('statusData'), this.lastStatusData);
                }

                // 更新状态栏 UI
                this.updateStatusBarUI(this.lastStatusData.data);
            } else {
                // 如果没有现有数据，执行完整更新
                await this.performInitialUpdate();
            }
        } catch (error) {
            StatusLogger.error(`[${this.config.logPrefix}] 更新提供商 ${providerId} 余额失败`, error);
        } finally {
            // 一定要在最后重置加载状态
            this.isLoading = false;
        }
    }

    /**
     * 更新状态栏 UI
     */
    private updateStatusBarUI(data: CompatibleStatusData): void {
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
            const cachedStatusData = this.getCachedData();

            if (cachedStatusData && cachedStatusData.data) {
                const dataAge = Date.now() - cachedStatusData.timestamp;

                if (dataAge > 30 * 1000) {
                    // 30秒以上的数据视为无变更，跳过更新
                    if (dataAge < 60 * 1000) {
                        // 30-60秒内的数据视为警告日志
                        StatusLogger.debug(
                            `[${this.config.logPrefix}] 缓存数据已过期 (${(dataAge / 1000).toFixed(1)}秒前)，跳过更新`
                        );
                    }
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
                StatusLogger.trace(`[${this.config.logPrefix}] 主实例周期任务跳过：未初始化或无上下文`);
                return;
            }

            // 检查是否需要刷新
            const needRefresh = this.shouldRefresh();
            StatusLogger.trace(
                `[${this.config.logPrefix}] 主实例周期任务检查：needRefresh=${needRefresh}, lastStatusData=${!!this.lastStatusData}`
            );

            if (needRefresh) {
                StatusLogger.debug(`[${this.config.logPrefix}] 主实例触发定时刷新`);
                // 定时刷新属于自动刷新，失败时不显示 ERR
                await this.executeApiQuery(false);
            }
        });

        StatusLogger.debug(`[${this.config.logPrefix}] 已注册主实例定时刷新任务`);
    }

    /**
     * 检查是否需要高亮警告
     */
    private shouldHighlightWarning(data: CompatibleStatusData): boolean {
        // 如果有提供商查询失败，则高亮警告
        return data.successCount < data.totalCount;
    }

    /**
     * 检查是否需要刷新
     * 检查是否有任何提供商的缓存过期
     */
    private shouldRefresh(): boolean {
        // 检查总体缓存是否存在
        const cachedData = this.getCachedData();
        if (!cachedData) {
            return true;
        }

        // 检查是否有任何提供商缓存过期
        const models = CompatibleModelManager.getModels();
        const providerIds = new Set<string>();
        for (const model of models) {
            if (model.provider) {
                providerIds.add(model.provider);
            }
        }

        for (const providerId of providerIds) {
            if (this.isProviderCacheExpired(providerId)) {
                return true;
            }
        }

        return false;
    }
}
