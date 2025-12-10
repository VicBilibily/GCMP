/*---------------------------------------------------------------------------------------------
 *  兼容提供商状态栏项
 *  继承 BaseStatusBarItem，复用通用状态栏逻辑
 *  此状态栏管理多个内置供应商查询，各提供商缓存独立
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { BaseStatusBarItem, BaseStatusBarItemConfig } from './baseStatusBarItem';
import { StatusLogger } from '../utils/statusLogger';
import { CompatibleModelManager } from '../utils/compatibleModelManager';
import { BalanceQueryManager } from './compatible/balanceQueryManager';
import { ApiKeyManager } from '../utils/apiKeyManager';

/**
 * Compatible 提供商余额信息
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
export interface CompatibleStatusData {
    /** 所有提供商的余额信息 */
    providers: CompatibleProviderBalance[];
    /** 查询成功的提供商数量 */
    successCount: number;
    /** 总提供商数量 */
    totalCount: number;
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
 * 兼容提供商状态栏项
 * 显示多个兼容提供商的余额信息，包括：
 * - 各提供商的余额
 * - 总余额（相同货币累加）
 * - 查询状态
 *
 * 继承 BaseStatusBarItem，复用通用状态栏逻辑：
 * - 生命周期管理
 * - 刷新机制
 * - 缓存管理
 * - 防抖逻辑
 *
 * 特殊逻辑：
 * - 管理多个内置供应商的查询
 * - 各提供商缓存独立
 */
export class CompatibleStatusBar extends BaseStatusBarItem<CompatibleStatusData> {
    /** 各提供商独立缓存 */
    private providerCaches = new Map<string, ProviderCacheData>();

    /** 各提供商的最后延时更新时间戳 */
    private providerLastDelayedUpdateTimes = new Map<string, number>();

    /** 支持延时更新的提供商列表 */
    private static readonly SUPPORTED_DELAYED_UPDATE_PROVIDERS = ['aihubmix'];

    constructor() {
        const config: BaseStatusBarItemConfig = {
            id: 'gcmp.statusBar.compatible',
            name: 'GCMP: Compatible Balance',
            alignment: vscode.StatusBarAlignment.Right,
            priority: 10, // 优先级取一个低值，靠右显示
            refreshCommand: 'gcmp.compatible.refreshBalance',
            cacheKeyPrefix: 'compatible',
            logPrefix: 'Compatible状态栏',
            icon: '$(gcmp-compatible)'
        };
        super(config);
    }

    // ==================== 实现基类抽象方法 ====================

    /**
     * 检查是否应该显示状态栏
     * 通过检查是否有配置支持的兼容提供商且该提供商有 API Key 来决定
     */
    protected async shouldShowStatusBar(): Promise<boolean> {
        const models = CompatibleModelManager.getModels();
        const supportedProviders = new Set(BalanceQueryManager.getRegisteredProviders());

        // 检查是否有配置的模型且其提供商既支持余额查询，又有 API Key
        for (const model of models) {
            if (model.provider && supportedProviders.has(model.provider)) {
                // 检查该提供商是否有有效的 API Key
                const hasApiKey = await ApiKeyManager.hasValidApiKey(model.provider);
                if (hasApiKey) {
                    return true;
                }
            }
        }
        return false;
    }

    /**
     * 获取显示文本
     */
    protected getDisplayText(data: CompatibleStatusData): string {
        const { successCount, totalCount, providers } = data;
        if (successCount === 0) {
            return `${this.config.icon} Compatible`;
        }

        // 只显示成功的提供商的金额
        const balanceTexts: string[] = [];
        const successfulProviders = providers.filter(p => p.success);
        const sortedProviders = successfulProviders.sort((a, b) => a.providerId.localeCompare(b.providerId));

        for (const provider of sortedProviders) {
            if (provider.balance === Number.MAX_SAFE_INTEGER) {
                // balanceTexts.push('∞');
                continue;
            }
            if (provider.balance === Number.MIN_SAFE_INTEGER) {
                balanceTexts.push('耗尽');
                continue;
            }
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
    protected generateTooltip(data: CompatibleStatusData): vscode.MarkdownString {
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

        const sortedProviders = [...data.providers].sort((a, b) => a.providerId.localeCompare(b.providerId));
        for (const provider of sortedProviders) {
            if (provider.success) {
                const currencySymbol = provider.currency === 'USD' ? '$' : '¥';
                const paidBalance = provider.paid !== undefined ? `${currencySymbol}${provider.paid.toFixed(2)}` : '-';
                const grantedBalance =
                    provider.granted !== undefined ? `${currencySymbol}${provider.granted.toFixed(2)}` : '-';
                let availableBalance = `${currencySymbol}${provider.balance.toFixed(2)}`;
                if (provider.balance === Number.MAX_SAFE_INTEGER) {
                    availableBalance = '无限制';
                } else if (provider.balance === Number.MIN_SAFE_INTEGER) {
                    availableBalance = '已耗尽';
                }

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

    /**
     * 执行 API 查询
     * 查询所有兼容提供商的余额信息
     * 使用各提供商独立缓存，只查询缓存过期的提供商
     * 手动刷新时强制查询所有提供商，忽略缓存
     * 只查询已设置 API Key 的提供商
     */
    protected async performApiQuery(
        isManualRefresh = false
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

                // 检查提供商是否有有效的 API Key，没有则跳过
                const hasApiKey = await ApiKeyManager.hasValidApiKey(model.provider);
                if (!hasApiKey) {
                    StatusLogger.debug(`[${this.config.logPrefix}] 跳过未配置 API Key 的提供商: ${model.provider}`);
                    continue;
                }

                if (!providerMap.has(model.provider)) {
                    const knownProvider = CompatibleModelManager.KnownProviders[model.provider];

                    // 手动刷新时强制查询所有提供商，忽略缓存
                    if (isManualRefresh) {
                        providerMap.set(model.provider, {
                            providerId: model.provider,
                            providerName: knownProvider?.displayName || model.provider,
                            balance: 0,
                            currency: 'CNY', // 默认货币
                            lastUpdated: new Date(),
                            success: false
                        });
                    } else {
                        // 自动刷新时，首先尝试从独立缓存加载
                        const cachedProvider = this.providerCaches.get(model.provider);
                        if (cachedProvider && !this.isProviderCacheExpired(model.provider)) {
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
            }

            // 找出需要查询的提供商
            const providersToQuery = Array.from(providerMap.values()).filter(
                provider =>
                    !provider.success || (isManualRefresh ? true : this.isProviderCacheExpired(provider.providerId))
            );

            StatusLogger.debug(
                `[${this.config.logPrefix}] ${isManualRefresh ? '手动刷新' : '自动刷新'}：需要查询 ${providersToQuery.length}/${providerMap.size} 个提供商`
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
     * 检查是否需要高亮警告
     * 如果有提供商查询失败，则高亮警告
     */
    protected shouldHighlightWarning(data: CompatibleStatusData): boolean {
        return data.successCount < data.totalCount;
    }

    /**
     * 检查是否需要刷新
     * 检查是否有任何提供商的缓存过期
     */
    protected shouldRefresh(): boolean {
        // 检查总体缓存是否存在
        if (!this.lastStatusData) {
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
                StatusLogger.debug(`[${this.config.logPrefix}] 缓存时间超过5分钟固定过期时间，触发API刷新`);
                return true;
            }
        }

        return false;
    }

    // ==================== 重写基类钩子方法 ====================

    /**
     * 初始化后钩子
     * 加载提供商缓存并监听模型变更事件
     */
    protected override async onInitialized(): Promise<void> {
        // 加载各提供商的独立缓存
        this.loadProviderCaches();

        // 监听兼容模型变更事件
        if (this.context) {
            const disposable = CompatibleModelManager.onDidChangeModels(() => {
                StatusLogger.debug(`[${this.config.logPrefix}] 兼容模型配置变更，触发状态更新`);
                this.delayedUpdate(1000); // 延迟1秒更新，避免频繁调用
            });
            this.context.subscriptions.push(disposable);
        }
    }

    /**
     * 销毁前钩子
     * 清理提供商缓存
     */
    protected override async onDispose(): Promise<void> {
        this.providerCaches.clear();
        this.providerLastDelayedUpdateTimes.clear();
    }

    // ==================== 重写基类方法 ====================

    /**
     * 延时更新指定提供商的余额（重载基类方法）
     * 包含防抖机制，避免频繁请求
     * @param providerId 提供商标识符
     * @param delayMs 延时时间（毫秒）
     */
    override delayedUpdate(delayMs?: number): void;
    override delayedUpdate(providerId: string, delayMs?: number): void;
    override delayedUpdate(providerId?: string | number, delayMs = 2000): void {
        // 如果没有提供 providerId 或者 providerId 不是字符串，调用基类实现
        if (!providerId || typeof providerId !== 'string') {
            super.delayedUpdate(typeof providerId === 'number' ? providerId : delayMs);
            return;
        }

        // 检查提供商是否在支持列表中
        const supportedProviders = new Set(BalanceQueryManager.getRegisteredProviders());
        if (!CompatibleStatusBar.SUPPORTED_DELAYED_UPDATE_PROVIDERS.includes(providerId)) {
            // 只在已知支持查询的列表中才输出此日志
            if (supportedProviders.has(providerId)) {
                StatusLogger.debug(
                    `[${this.config.logPrefix}] 提供商 ${providerId} 无需延时更新，由定时器统一刷新管理`
                );
            }
            return;
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
     * 重写基类的 executeApiQuery 方法
     * 手动刷新时始终执行查询，不受基类缓存限制
     * 部分提供商查询失败时不显示 ERR，只显示成功的提供商信息
     */
    protected override async executeApiQuery(isManualRefresh = false): Promise<void> {
        // 防止并发执行
        if (this.isLoading) {
            StatusLogger.debug(`[${this.config.logPrefix}] 正在执行查询，跳过重复调用`);
            return;
        }

        // 手动刷新时跳过基类的缓存检查，直接执行查询
        if (isManualRefresh) {
            StatusLogger.debug(`[${this.config.logPrefix}] 手动刷新，跳过缓存检查`);
        } else {
            // 自动刷新时，检查缓存是否在 5 秒内有效，有效则跳过本次加载
            if (this.lastStatusData) {
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

                    // 检查是否有成功的查询结果
                    if (data.successCount === 0) {
                        // 所有提供商都查询失败，显示 ERR
                        this.statusBarItem.text = `${this.config.icon} ERR`;
                        this.statusBarItem.tooltip = '所有提供商查询失败';
                        StatusLogger.warn(`[${this.config.logPrefix}] 所有提供商查询失败`);
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

                    StatusLogger.info(
                        `[${this.config.logPrefix}] 余额检查成功 (${data.successCount}/${data.totalCount})`
                    );
                }
            } else {
                // 查询完全失败，显示 ERR
                const errorMsg = result.error || '未知错误';
                if (this.statusBarItem) {
                    this.statusBarItem.text = `${this.config.icon} ERR`;
                    this.statusBarItem.tooltip = `查询失败: ${errorMsg}`;
                }
                StatusLogger.warn(`[${this.config.logPrefix}] 余额查询失败: ${errorMsg}`);
            }
        } catch (error) {
            StatusLogger.error(`[${this.config.logPrefix}] 更新状态栏失败`, error);

            // 查询异常，显示 ERR
            if (this.statusBarItem) {
                this.statusBarItem.text = `${this.config.icon} ERR`;
                this.statusBarItem.tooltip = `获取失败: ${error instanceof Error ? error.message : '未知错误'}`;
            }
        } finally {
            // 一定要在最后重置加载状态
            this.isLoading = false;
        }
    }

    // ==================== 私有方法：提供商缓存管理 ====================

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

        const PROVIDER_CACHE_EXPIRY = (5 * 60 - 10) * 1000; // 缓存过期阈值 5 分钟

        const now = Date.now();
        const cacheAge = now - cached.timestamp;
        return cacheAge > PROVIDER_CACHE_EXPIRY;
    }

    // ==================== 私有方法：单提供商更新 ====================

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
                // 如果没有现有数据，执行 checkAndShowStatus 进行完整更新
                await this.checkAndShowStatus();
            }
        } catch (error) {
            StatusLogger.error(`[${this.config.logPrefix}] 更新提供商 ${providerId} 余额失败`, error);
        } finally {
            // 一定要在最后重置加载状态
            this.isLoading = false;
        }
    }
}
