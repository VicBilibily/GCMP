/*---------------------------------------------------------------------------------------------
 *  兼容提供商状态栏项
 *  继承 BaseStatusBarItem，复用通用状态栏逻辑
 *  此状态栏管理多个内置供应商查询，各提供商缓存独立
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { BaseStatusBarItem, BaseStatusBarItemConfig } from './baseStatusBarItem';
import { StatusLogger } from '../utils/runtime/statusLogger';
import { CompatibleModelManager } from '../utils/config/compatibleModelManager';
import { BalanceQueryManager } from './compatible/balanceQueryManager';
import { ApiKeyManager } from '../utils/config/apiKeyManager';
import { KnownProviders } from '../utils/config/knownProviders';
import { LeaderElectionService } from './leaderElectionService';
import { InterInstanceBus } from '../interInstance';
import { t } from '../utils/runtime/l10n';

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

    /** 内置支持定向延时更新的提供商列表 */
    private static readonly SUPPORTED_DELAYED_UPDATE_PROVIDERS = ['aihubmix', 'openrouter'];

    constructor() {
        const config: BaseStatusBarItemConfig = {
            id: 'gcmp.statusBar.compatible',
            name: 'GCMP: Compatible Balance',
            alignment: vscode.StatusBarAlignment.Right,
            priority: 10, // 优先级取一个低值，靠右显示
            refreshCommand: 'gcmp.compatible.refreshBalance',
            cacheKeyPrefix: 'compatible',
            logPrefix: 'Compatible Status Bar',
            icon: '$(gcmp-compatible)'
        };
        super(config);
    }

    // ==================== 实现基类抽象方法 ====================

    /**
     * 获取当前已配置模型对应的所有可查询 provider 条目。
     */
    private getConfiguredProviderEntries(): string[] {
        const models = CompatibleModelManager.getModels();
        const providerEntries = new Set<string>();

        for (const model of models) {
            if (!model.provider) {
                continue;
            }

            const registeredProviders = BalanceQueryManager.getRegisteredProvidersForBaseProvider(model.provider);
            for (const providerId of registeredProviders) {
                providerEntries.add(providerId);
            }
        }

        return Array.from(providerEntries);
    }

    /**
     * 获取 provider 条目的显示名称。
     */
    private getProviderDisplayName(providerId: string): string {
        const baseProviderId = BalanceQueryManager.getBaseProviderId(providerId);
        const baseDisplayName = KnownProviders[baseProviderId]?.displayName || baseProviderId;
        const usageDisplayName = BalanceQueryManager.getCustomUsageDisplayName(providerId);
        return usageDisplayName ? `${baseDisplayName} / ${usageDisplayName}` : baseDisplayName;
    }

    /**
     * 检查 provider 是否支持请求后的定向余额刷新。
     * 内置支持列表外，凡是配置了 usage/usages 的自定义 provider 也应立即刷新，
     * 否则请求完成后只能等定时轮询，状态栏不会及时反映最新余额。
     */
    private supportsTargetedDelayedUpdate(providerId: string): boolean {
        return (
            CompatibleStatusBar.SUPPORTED_DELAYED_UPDATE_PROVIDERS.includes(providerId) ||
            BalanceQueryManager.hasCustomUsageEntries(providerId)
        );
    }

    /**
     * 检查是否应该显示状态栏
     * 通过检查是否有配置支持的兼容提供商且该提供商有 API Key（或无需鉴权）来决定
     * 逐个检查，找到第一个有效就立即返回 true
     */
    protected async shouldShowStatusBar(): Promise<boolean> {
        const providersToCheck = this.getConfiguredProviderEntries();
        if (providersToCheck.length === 0) {
            return false;
        }

        // 逐个检查，无需鉴权或有有效 API Key 即认为可显示
        for (const provider of providersToCheck) {
            if (!BalanceQueryManager.requiresApiKey(provider)) {
                return true;
            }
            const hasApiKey = await ApiKeyManager.hasValidApiKey(BalanceQueryManager.getBaseProviderId(provider));
            if (hasApiKey) {
                return true;
            }
        }

        return false;
    }

    /**
     * 获取单位前缀/符号
     */
    private getUnitPrefix(currency: string): string {
        switch (currency) {
            case 'USD':
                return '$';
            case 'CNY':
            case 'RMB':
                return '¥';
            default:
                return '';
        }
    }

    /**
     * 格式化余额显示
     */
    private formatBalance(balance: number, currency: string): string {
        if (balance === Number.MAX_SAFE_INTEGER) {
            return t('Unlimited', '无限制');
        }
        if (balance === Number.MIN_SAFE_INTEGER) {
            return t('Depleted', '耗尽');
        }

        const prefix = this.getUnitPrefix(currency);
        if (prefix) {
            return `${prefix}${balance.toFixed(2)}`;
        }

        // Token / 次 / 点数等场景：数值后追加单位
        const formatted = Number.isInteger(balance) ? balance.toString() : balance.toFixed(2);
        return `${formatted} ${currency}`;
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
            balanceTexts.push(this.formatBalance(provider.balance, provider.currency));
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
        md.appendMarkdown(`#### ${t('Compatible Provider Balances', 'Compatible 提供商余额信息')}\n\n`);

        if (data.providers.length === 0) {
            md.appendMarkdown(`${t('No Compatible providers are configured.', '暂无配置的 Compatible 提供商')}\n`);
            md.appendMarkdown('\n---\n');
            md.appendMarkdown(`${t('Click the status bar to refresh manually', '点击状态栏可手动刷新')}\n`);
            return md;
        }

        const sortedProviders = [...data.providers].sort((a, b) => a.providerId.localeCompare(b.providerId));
        const hasDetailedBalances = sortedProviders.some(
            provider => provider.success && (provider.paid !== undefined || provider.granted !== undefined)
        );

        if (hasDetailedBalances) {
            md.appendMarkdown(
                `| ${t('Provider', '提供商')} | ${t('Paid Balance', '充值余额')} | ${t('Granted', '赠金余额')} | ${t('Available', '可用余额')} |\n`
            );
            md.appendMarkdown('| :--- |---: | ---: | ---: |\n');
        } else {
            md.appendMarkdown(`| ${t('Provider', '提供商')} | ${t('Available', '可用余额')} |\n`);
            md.appendMarkdown('| :--- | ---: |\n');
        }

        for (const provider of sortedProviders) {
            if (provider.success) {
                const availableBalance = this.formatBalance(provider.balance, provider.currency);

                if (hasDetailedBalances) {
                    const paidBalance =
                        provider.paid !== undefined ? this.formatBalance(provider.paid, provider.currency) : '-';
                    const grantedBalance =
                        provider.granted !== undefined ? this.formatBalance(provider.granted, provider.currency) : '-';

                    md.appendMarkdown(
                        `| ${provider.providerName} | ${paidBalance} | ${grantedBalance} | ${availableBalance} |\n`
                    );
                } else {
                    md.appendMarkdown(`| ${provider.providerName} | ${availableBalance} |\n`);
                }
            } else {
                if (hasDetailedBalances) {
                    md.appendMarkdown(`| ${provider.providerName} |  - | - | ${t('Query failed', '查询失败')} |\n`);
                } else {
                    md.appendMarkdown(`| ${provider.providerName} | ${t('Query failed', '查询失败')} |\n`);
                }
            }
        }

        md.appendMarkdown('\n---\n');
        md.appendMarkdown(`${t('Click the status bar to refresh manually', '点击状态栏可手动刷新')}\n`);
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
            const providerEntries = this.getConfiguredProviderEntries();
            const providerMap = new Map<string, CompatibleProviderBalance>();

            for (const providerId of providerEntries) {
                const baseProviderId = BalanceQueryManager.getBaseProviderId(providerId);

                // 检查提供商是否有有效的 API Key（或无需鉴权），没有则跳过
                const requiresApiKey = BalanceQueryManager.requiresApiKey(providerId);
                const hasApiKey = requiresApiKey ? await ApiKeyManager.hasValidApiKey(baseProviderId) : true;
                if (!hasApiKey) {
                    StatusLogger.debug(
                        `[${this.config.logPrefix}] Skipping provider without a configured API key: ${providerId}`
                    );
                    continue;
                }

                if (!providerMap.has(providerId)) {
                    const providerName = this.getProviderDisplayName(providerId);

                    if (isManualRefresh) {
                        providerMap.set(providerId, {
                            providerId,
                            providerName,
                            balance: 0,
                            currency: 'CNY',
                            lastUpdated: new Date(),
                            success: false
                        });
                        continue;
                    }

                    const cachedProvider = this.providerCaches.get(providerId);
                    if (cachedProvider && !this.isProviderCacheExpired(providerId)) {
                        providerMap.set(providerId, cachedProvider.balance);
                    } else {
                        providerMap.set(providerId, {
                            providerId,
                            providerName,
                            balance: 0,
                            currency: 'CNY',
                            lastUpdated: new Date(),
                            success: false
                        });
                    }
                }
            }

            // 找出需要查询的提供商
            const providersToQuery = Array.from(providerMap.values()).filter(
                provider =>
                    !provider.success || (isManualRefresh ? true : this.isProviderCacheExpired(provider.providerId))
            );

            StatusLogger.debug(
                `[${this.config.logPrefix}] ${isManualRefresh ? 'Manual refresh' : 'Automatic refresh'}: querying ${providersToQuery.length}/${providerMap.size} providers`
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
                    StatusLogger.error(
                        `[${this.config.logPrefix}] Failed to query balance for provider ${provider.providerId}`,
                        error
                    );
                    provider.error = typeof error === 'string' ? error : t('Query failed', '查询失败');
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
            StatusLogger.error(`[${this.config.logPrefix}] Failed to query compatible provider balances`, error);
            return { success: false, error: typeof error === 'string' ? error : t('Query failed', '查询失败') };
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

        for (const providerId of this.getConfiguredProviderEntries()) {
            if (this.isProviderCacheExpired(providerId)) {
                StatusLogger.debug(
                    `[${this.config.logPrefix}] Cache age exceeded the fixed 5-minute expiration, triggering API refresh`
                );
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
                StatusLogger.debug(
                    `[${this.config.logPrefix}] Compatible model configuration changed, triggering status update`
                );
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

        if (!this.supportsTargetedDelayedUpdate(providerId)) {
            if (BalanceQueryManager.getRegisteredProvidersForBaseProvider(providerId).length > 0) {
                StatusLogger.debug(
                    `[${this.config.logPrefix}] Provider ${providerId} does not need delayed updates and is handled by the scheduled refresh`
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
            timeSinceLastUpdate < this.MIN_DELAYED_UPDATE_INTERVAL ?
                this.MIN_DELAYED_UPDATE_INTERVAL - timeSinceLastUpdate
            :   delayMs;

        StatusLogger.debug(
            `[${this.config.logPrefix}] Scheduled delayed update for provider ${providerId}, executing in ${finalDelayMs / 1000} seconds`
        );

        // 设置新的防抖定时器
        this.updateDebouncer = setTimeout(async () => {
            try {
                StatusLogger.debug(`[${this.config.logPrefix}] Executing delayed update for provider ${providerId}`);
                this.providerLastDelayedUpdateTimes.set(providerId, Date.now());
                await this.performProviderUpdate(providerId);
            } catch (error) {
                StatusLogger.error(
                    `[${this.config.logPrefix}] Delayed update failed for provider ${providerId}`,
                    error
                );
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
            StatusLogger.debug(`[${this.config.logPrefix}] Query is already in progress, skipping duplicate call`);
            return;
        }

        // 手动刷新时跳过基类的缓存检查，直接执行查询
        if (isManualRefresh) {
            StatusLogger.debug(`[${this.config.logPrefix}] Manual refresh requested, skipping cache check`);
        } else {
            // 自动刷新时，检查缓存是否在 5 秒内有效，有效则跳过本次加载
            if (this.lastStatusData) {
                try {
                    const dataAge = Date.now() - this.lastStatusData.timestamp;
                    if (dataAge >= 0 && dataAge < 5000) {
                        StatusLogger.debug(
                            `[${this.config.logPrefix}] Data is still valid within 5 seconds (${(dataAge / 1000).toFixed(1)}s ago), skipping automatic refresh`
                        );
                        return;
                    }
                } catch {
                    // 旧版本数据格式不兼容，忽略错误继续执行刷新
                    StatusLogger.debug(
                        `[${this.config.logPrefix}] Cached data format is incompatible, continuing with refresh`
                    );
                }
            }
        }

        this.isLoading = true;

        try {
            StatusLogger.debug(`[${this.config.logPrefix}] Starting balance query...`);

            const result = await this.performApiQuery(isManualRefresh);

            if (result.success && result.data) {
                if (this.statusBarItem) {
                    const data = result.data;

                    // 检查是否有任何查询结果
                    if (data.providers.length === 0) {
                        // 没有任何提供商可以查询，隐藏状态栏
                        this.statusBarItem.hide();
                        StatusLogger.debug(
                            `[${this.config.logPrefix}] No providers support balance queries, hiding status bar`
                        );
                        return;
                    }

                    // 检查是否有成功的查询结果
                    if (data.successCount === 0) {
                        // 所有提供商都查询失败，显示 ERR
                        this.statusBarItem.text = `${this.config.icon} ERR`;
                        this.statusBarItem.tooltip = t('All provider queries failed.', '所有提供商查询失败');
                        StatusLogger.warn(`[${this.config.logPrefix}] All provider queries failed`);
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

                    // 跨实例广播状态更新（Leader 查询成功后同步到其他窗口）
                    if (LeaderElectionService.isLeader()) {
                        InterInstanceBus.publish({
                            type: 'statusUpdated',
                            payload: {
                                providerKey: this.config.cacheKeyPrefix,
                                data: this.lastStatusData,
                                source: 'api'
                            }
                        });
                    }

                    // 更新状态栏 UI
                    this.updateStatusBarUI(data);

                    StatusLogger.info(
                        `[${this.config.logPrefix}] Balance check succeeded (${data.successCount}/${data.totalCount})`
                    );
                }
            } else {
                // 查询完全失败，显示 ERR
                const errorMsg = result.error || t('Unknown error', '未知错误');
                if (this.statusBarItem) {
                    this.statusBarItem.text = `${this.config.icon} ERR`;
                    this.statusBarItem.tooltip = t('Query failed: {0}', '查询失败: {0}', errorMsg);
                }
                StatusLogger.warn(`[${this.config.logPrefix}] Balance query failed: ${errorMsg}`);
            }
        } catch (error) {
            StatusLogger.error(`[${this.config.logPrefix}] Failed to update status bar`, error);

            // 查询异常，显示 ERR
            if (this.statusBarItem) {
                this.statusBarItem.text = `${this.config.icon} ERR`;
                this.statusBarItem.tooltip = t(
                    'Fetch failed: {0}',
                    '获取失败: {0}',
                    error instanceof Error ? error.message : t('Unknown error', '未知错误')
                );
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

            StatusLogger.debug(`[${this.config.logPrefix}] Loaded ${this.providerCaches.size} provider caches`);
        } catch (error) {
            StatusLogger.error(`[${this.config.logPrefix}] Failed to load provider caches`, error);
        }
    }

    /**
     * 接收到跨实例状态更新事件后同步各提供商缓存
     */
    protected override onStatusUpdatedFromEvent(data: CompatibleStatusData): void {
        for (const provider of data.providers) {
            const cacheData: ProviderCacheData = {
                balance: provider,
                timestamp: Date.now()
            };
            this.providerCaches.set(provider.providerId, cacheData);
            if (this.context) {
                const cacheKey = this.getProviderCacheKey(provider.providerId);
                Promise.resolve(this.context.globalState.update(cacheKey, cacheData)).catch(error =>
                    StatusLogger.error(`[${this.config.logPrefix}] Failed to sync provider cache from event`, error)
                );
            }
        }
        StatusLogger.debug(
            `[${this.config.logPrefix}] Synced ${data.providers.length} provider caches from inter-instance event`
        );
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

            StatusLogger.debug(`[${this.config.logPrefix}] Saved cache for provider ${providerId}`);
        } catch (error) {
            StatusLogger.error(`[${this.config.logPrefix}] Failed to save cache for provider ${providerId}`, error);
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
            StatusLogger.debug(
                `[${this.config.logPrefix}] Query is already in progress, skipping update for provider ${providerId}`
            );
            return;
        }

        const targetProviderIds = BalanceQueryManager.getRegisteredProvidersForBaseProvider(providerId);
        if (targetProviderIds.length === 0) {
            StatusLogger.warn(`[${this.config.logPrefix}] Provider ${providerId} does not support balance queries`);
            return;
        }

        this.isLoading = true;

        try {
            StatusLogger.debug(`[${this.config.logPrefix}] Starting balance query for provider ${providerId}...`);

            for (const targetProviderId of targetProviderIds) {
                const baseProviderId = BalanceQueryManager.getBaseProviderId(targetProviderId);
                const providerBalance: CompatibleProviderBalance = {
                    providerId: targetProviderId,
                    providerName: this.getProviderDisplayName(targetProviderId),
                    balance: 0,
                    currency: 'CNY',
                    lastUpdated: new Date(),
                    success: false
                };

                try {
                    if (BalanceQueryManager.requiresApiKey(targetProviderId)) {
                        const hasApiKey = await ApiKeyManager.hasValidApiKey(baseProviderId);
                        if (!hasApiKey) {
                            throw new Error(`No API key configured for provider ${baseProviderId}`);
                        }
                    }

                    const balanceInfo = await BalanceQueryManager.queryBalance(targetProviderId);

                    providerBalance.paid = balanceInfo.paid;
                    providerBalance.granted = balanceInfo.granted;
                    providerBalance.balance = balanceInfo.balance;
                    providerBalance.currency = balanceInfo.currency;
                    providerBalance.lastUpdated = new Date();
                    providerBalance.success = true;

                    await this.saveProviderCache(targetProviderId, providerBalance);

                    StatusLogger.info(
                        `[${this.config.logPrefix}] Balance query succeeded for provider ${targetProviderId}`
                    );
                } catch (error) {
                    StatusLogger.error(
                        `[${this.config.logPrefix}] Failed to query balance for provider ${targetProviderId}`,
                        error
                    );
                    providerBalance.error = typeof error === 'string' ? error : t('Query failed', '查询失败');
                    providerBalance.success = false;
                }

                if (this.lastStatusData && this.lastStatusData.data) {
                    const existingProviderIndex = this.lastStatusData.data.providers.findIndex(
                        p => p.providerId === targetProviderId
                    );

                    if (existingProviderIndex >= 0) {
                        this.lastStatusData.data.providers[existingProviderIndex] = providerBalance;
                    } else {
                        this.lastStatusData.data.providers.push(providerBalance);
                        this.lastStatusData.data.totalCount++;
                    }
                }
            }

            if (this.lastStatusData && this.lastStatusData.data) {
                this.lastStatusData.data.successCount = this.lastStatusData.data.providers.filter(
                    p => p.success
                ).length;
                this.lastStatusData.timestamp = Date.now();

                if (this.context) {
                    this.context.globalState.update(this.getCacheKey('statusData'), this.lastStatusData);
                }

                this.updateStatusBarUI(this.lastStatusData.data);
            } else {
                await this.checkAndShowStatus();
            }
        } catch (error) {
            StatusLogger.error(`[${this.config.logPrefix}] Failed to update balance for provider ${providerId}`, error);
        } finally {
            // 一定要在最后重置加载状态
            this.isLoading = false;
        }
    }
}
