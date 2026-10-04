/*---------------------------------------------------------------------------------------------
 *  参数化配额状态栏
 *  由 config + QuotaStatusAdapter + 标题声明式初始化；表格/摘要/高亮/刷新策略
 *  全部来自 quota 层适配器，本类仅负责 VS Code 状态栏渲染。
 *---------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { ProviderStatusBarItem, StatusBarItemConfig, type ProviderApiQueryResult } from './providerStatusBarItem';
import { StatusLogger } from '../utils/runtime/statusLogger';
import { t } from '../utils/runtime/l10n';
import { buildApiKeySwitchLink, ConfigSetStore } from '../utils/config/configSetStore';
import { ApiKeyManager } from '../utils/config/apiKeyManager';
import { InterInstanceBus, ApiKeyFailoverToggledEvent } from '../interInstance';
import {
    collectMultiKeyStatus,
    hashApiKey,
    isMultiKeyModeImpl,
    renderMultiKeySections,
    renderQuotaTable,
    type ActiveEntryReuse,
    type MultiKeyConfigSource,
    type MultiKeySectionLabels,
    type MultiKeyStatusData
} from './multiKeyQuotaTracker';
import type { QuotaStatusAdapter } from '../quota/statusAdapters';
import type { QuotaTable } from '../quota/types';
import { ConfigManager } from '../utils/config/configManager';
import { getBalanceAlertLevel } from '../utils/config/balanceWarning';

/** 多 key 状态缓存键后缀（globalState） */
const MULTI_KEY_CACHE_KEY = 'multiKeyStatusData';
/** 多 key 持久化缓存有效期：略宽于主状态 5 分钟刷新节奏，供重启/新窗口 tooltip 直接展示 */
const MULTI_KEY_CACHE_MAX_AGE = 10 * 60 * 1000;

/** 生产数据源：委托 ConfigSetStore */
function createConfigSource(slot: string): MultiKeyConfigSource {
    return {
        list: () => ConfigSetStore.list(slot),
        getActiveId: () => ConfigSetStore.getActiveId(slot),
        getApiKey: id => ConfigSetStore.getApiKey(slot, id)
    };
}

function isMultiKeyMode(slot: string): boolean {
    // 先判模式再读列表：ConfigSetStore 未初始化时 list 会抛错
    const mode = ConfigSetStore.getSwitchMode(slot);
    if (mode === 'off') {
        return false;
    }
    return isMultiKeyModeImpl(mode, ConfigSetStore.list(slot).length);
}

/** 通用配额状态栏构造参数 */
export interface ProviderQuotaStatusBarOptions<TRaw> {
    /** 状态栏配置（id/icon/priority/apiKeyProvider 等） */
    config: StatusBarItemConfig;
    /** 数据适配器（query/summary/tables/高亮/刷新提示） */
    adapter: QuotaStatusAdapter<TRaw>;
    /** Tooltip 标题（延迟求值以跟随语言设置） */
    title: () => string;
    /** 数据驱动的动态标题（如订阅套餐名）；提供时优先于 title 作为 tooltip 主标题 */
    titleOf?: (data: TRaw) => string | undefined;
    /** 从数据提取最后更新时间（提供时在 tooltip 尾部展示） */
    lastUpdatedOf?: (data: TRaw) => string | undefined;
}

export class ProviderQuotaStatusBar<TRaw> extends ProviderStatusBarItem<TRaw> {
    private readonly adapter: QuotaStatusAdapter<TRaw>;
    private readonly titleText: () => string;
    private readonly titleOf?: (data: TRaw) => string | undefined;
    private readonly lastUpdatedOf?: (data: TRaw) => string | undefined;

    /** 多 key 模式（failover/balance）下全部配置的配额状态 */
    private multiKeyStatus: MultiKeyStatusData<TRaw> | undefined;
    /** 多 key 懒收集进行中，避免 tooltip 高频触发并发收集 */
    private multiKeyCollecting: Promise<void> | undefined;
    private multiKeyCollectionGeneration = 0;
    private failoverToggleSubscription: vscode.Disposable | undefined;

    constructor(options: ProviderQuotaStatusBarOptions<TRaw>) {
        super(options.config);
        this.adapter = options.adapter;
        this.titleText = options.title;
        this.titleOf = options.titleOf;
        this.lastUpdatedOf = options.lastUpdatedOf;
    }

    /**
     * 初始化：追加订阅切换模式变化（跨实例），模式变化后清多 key 缓存并刷新
     */
    override async initialize(context: vscode.ExtensionContext): Promise<void> {
        await super.initialize(context);
        this.failoverToggleSubscription = InterInstanceBus.subscribe('apiKeyFailoverToggled', event => {
            const payload = (event as ApiKeyFailoverToggledEvent).payload;
            if (payload.slot !== this.config.apiKeyProvider) {
                return;
            }
            this.onApiKeyChangeDetected();
            this.checkAndShowStatus().catch(error =>
                StatusLogger.error(`[${this.config.logPrefix}] Failed to refresh after switch mode change`, error)
            );
        });
        context.subscriptions.push(this.failoverToggleSubscription);
    }

    override dispose(): void {
        this.multiKeyCollectionGeneration++;
        this.failoverToggleSubscription?.dispose();
        this.failoverToggleSubscription = undefined;
        this.multiKeyStatus = undefined;
        this.multiKeyCollecting = undefined;
        super.dispose();
    }

    /**
     * 查询：主查询（激活 key）成功后，多 key 模式下收集全部配置配额状态；
     * 收集失败不影响主状态显示。
     */
    protected override async performApiQuery(): Promise<ProviderApiQueryResult<TRaw>> {
        const generation = this.queryGeneration;
        const result = await super.performApiQuery();
        const slot = this.config.apiKeyProvider;
        if (generation !== this.queryGeneration) {
            return { success: false };
        }

        if (result.success && result.data !== undefined && isMultiKeyMode(slot)) {
            await this.collectMultiKey(slot, result);
        } else {
            // 单 key 模式（off 或仅剩一套配置）不保留多 key 缓存
            this.multiKeyStatus = undefined;
        }

        if (result.success && result.keyHash) {
            const currentKey = await ApiKeyManager.getApiKey(slot);
            if (generation !== this.queryGeneration) {
                return { success: false };
            }
            if (!currentKey || hashApiKey(currentKey) !== result.keyHash) {
                this.onApiKeyChangeDetected();
                return { success: false };
            }
        }
        return result;
    }

    /** 收集槽位全部配置配额状态并持久化；失败不影响主状态显示 */
    private async collectMultiKey(slot: string, activeResult?: ProviderApiQueryResult<TRaw>): Promise<void> {
        const generation = this.queryGeneration;
        const collectionGeneration = ++this.multiKeyCollectionGeneration;
        const context = this.context;
        const activeId = ConfigSetStore.getActiveId(slot);
        try {
            const runtimeKey = await ApiKeyManager.getApiKey(slot);
            if (!runtimeKey || generation !== this.queryGeneration || context !== this.context) {
                return;
            }
            const activeReuse =
                activeResult?.data !== undefined && activeResult.keyHash ?
                    await this.buildActiveReuse(slot, activeResult.data, activeResult.keyHash)
                :   undefined;
            const status = await collectMultiKeyStatus(createConfigSource(slot), this.adapter, {
                activeReuse
            });
            const currentKey = await ApiKeyManager.getApiKey(slot);
            if (
                generation !== this.queryGeneration ||
                context !== this.context ||
                collectionGeneration !== this.multiKeyCollectionGeneration ||
                !isMultiKeyMode(slot)
            ) {
                return;
            }
            if (currentKey !== runtimeKey || ConfigSetStore.getActiveId(slot) !== activeId) {
                this.onApiKeyChangeDetected();
                return;
            }
            this.multiKeyStatus = status;
            await context?.globalState.update(this.getCacheKey(MULTI_KEY_CACHE_KEY), status);
        } catch (error) {
            StatusLogger.warn(`[${this.config.logPrefix}] Failed to collect multi-key status`, error);
            if (generation === this.queryGeneration && collectionGeneration === this.multiKeyCollectionGeneration) {
                this.multiKeyStatus = undefined;
            }
        }
    }

    /** 激活项与运行时 key 身份一致时复用主查询结果，避免重复请求激活 key */
    private async buildActiveReuse(
        slot: string,
        data: TRaw,
        queryKeyHash: string
    ): Promise<ActiveEntryReuse<TRaw> | undefined> {
        const activeId = ConfigSetStore.getActiveId(slot);
        if (!activeId) {
            return undefined;
        }
        const [activeKey, runtimeKey] = await Promise.all([
            ConfigSetStore.getApiKey(slot, activeId),
            ApiKeyManager.getApiKey(slot)
        ]);
        if (!activeKey || !runtimeKey) {
            return undefined;
        }
        const activeHash = hashApiKey(activeKey);
        if (
            activeHash !== queryKeyHash ||
            activeHash !== hashApiKey(runtimeKey) ||
            ConfigSetStore.getActiveId(slot) !== activeId
        ) {
            return undefined;
        }
        return { configId: activeId, keyHash: activeHash, data };
    }

    /** 读取持久化的多 key 缓存（重启/其他窗口恢复 tooltip） */
    private readMultiKeyFromCache(): MultiKeyStatusData<TRaw> | undefined {
        const isValid = (status: MultiKeyStatusData<TRaw> | undefined): status is MultiKeyStatusData<TRaw> => {
            if (!status || !Array.isArray(status.entries) || status.entries.length <= 1) {
                return false;
            }
            const items = ConfigSetStore.list(this.config.apiKeyProvider);
            const activeId = ConfigSetStore.getActiveId(this.config.apiKeyProvider);
            if (
                items.length !== status.entries.length ||
                items.some((item, index) => {
                    const entry = status.entries[index];
                    return (
                        !entry ||
                        entry.configId !== item.id ||
                        entry.label !== item.label ||
                        entry.site !== item.site ||
                        entry.isActive !== (item.id === activeId)
                    );
                })
            ) {
                return false;
            }
            const age = Date.now() - status.timestamp;
            return (
                Number.isFinite(status.timestamp) && Number.isFinite(age) && age >= 0 && age <= MULTI_KEY_CACHE_MAX_AGE
            );
        };
        if (!isValid(this.multiKeyStatus)) {
            this.multiKeyStatus = undefined;
        }
        const cached = this.context?.globalState.get<MultiKeyStatusData<TRaw>>(this.getCacheKey(MULTI_KEY_CACHE_KEY));
        if (isValid(cached) && (!this.multiKeyStatus || cached.timestamp >= this.multiKeyStatus.timestamp)) {
            this.multiKeyStatus = cached;
        }
        return this.multiKeyStatus;
    }

    protected override onCachePolled(): void {
        if (
            !this.context ||
            this.isLoading ||
            this.statusBarErrorDisplayed ||
            !isMultiKeyMode(this.config.apiKeyProvider)
        ) {
            return;
        }
        const previous = this.multiKeyStatus;
        if (this.readMultiKeyFromCache() !== previous && this.lastStatusData) {
            this.updateStatusBarUI(this.lastStatusData.data);
        }
    }

    /** 多 key 模式下若尚未收集（如刚切换模式），后台触发一次收集 */
    private ensureMultiKeyCollected(): void {
        const slot = this.config.apiKeyProvider;
        if (this.multiKeyStatus || this.multiKeyCollecting || !isMultiKeyMode(slot)) {
            return;
        }
        const generation = this.queryGeneration;
        const context = this.context;
        const collection = this.collectMultiKey(slot).finally(() => {
            if (
                this.multiKeyCollecting !== collection ||
                generation !== this.queryGeneration ||
                context !== this.context
            ) {
                return;
            }
            this.multiKeyCollecting = undefined;
            if (this.multiKeyStatus && this.lastStatusData && !this.isLoading && !this.statusBarErrorDisplayed) {
                this.updateStatusBarUI(this.lastStatusData.data);
            }
        });
        this.multiKeyCollecting = collection;
        void collection.catch(error =>
            StatusLogger.warn(`[${this.config.logPrefix}] Lazy multi-key collect failed`, error)
        );
    }

    protected getDisplayText(data: TRaw): string {
        const summary = this.adapter.summary(data);
        return summary ? `${this.config.icon} ${summary}` : `${this.config.icon}`;
    }

    protected generateTooltip(data: TRaw): vscode.MarkdownString {
        const md = new vscode.MarkdownString();
        md.supportHtml = true;
        // 仅放行切换命令：配额表格内容来自 provider 响应，不能整体 trusted
        md.isTrusted = { enabledCommands: ['gcmp.configSet.switchKey'] };
        const heading = this.titleOf?.(data) ?? this.titleText();
        md.appendMarkdown(`#### ${heading}\n\n`);

        const tables = this.adapter.tables(data);
        for (const [index, table] of tables.entries()) {
            if (index > 0) {
                md.appendMarkdown('\n---\n');
            }
            if (table.title) {
                md.appendMarkdown(`${table.title}\n\n`);
            }
            appendQuotaTable(md, table);
        }

        const details = this.adapter.details?.(data) ?? [];
        if (details.length > 0) {
            md.appendMarkdown('\n---\n');
            for (const detail of details) {
                md.appendMarkdown(`${detail}\n`);
            }
        }

        const lastUpdated = this.lastUpdatedOf?.(data);
        if (lastUpdated) {
            md.appendMarkdown('\n---\n');
            md.appendMarkdown(`**${t('Last updated', '最后更新')}** ${lastUpdated}\n`);
        }

        const slot = this.config.apiKeyProvider;
        const switchLink = slot ? buildApiKeySwitchLink(slot) : undefined;
        if (switchLink) {
            md.appendMarkdown('\n---\n');
            md.appendMarkdown(`\n${switchLink}\n`);
        }

        // 多 key 模式（故障切换/负载均衡）：tooltip 列出全部配置的配额状态
        const multiSection = this.buildMultiKeySection();
        if (multiSection) {
            md.appendMarkdown('\n---\n\n');
            md.appendMarkdown(multiSection);
        }

        md.appendMarkdown('\n---\n');
        md.appendMarkdown(`${t('Click the status bar to refresh manually', '点击状态栏可手动刷新')}\n`);
        return md;
    }

    /** 生成多 key 小节；核验缓存，仍无则后台收集并在完成后重绘。 */
    private buildMultiKeySection(): string {
        const slot = this.config.apiKeyProvider;
        if (!isMultiKeyMode(slot)) {
            return '';
        }
        const status = this.readMultiKeyFromCache();
        if (!status) {
            this.ensureMultiKeyCollected();
            return '';
        }
        const labels: MultiKeySectionLabels = {
            nameColumn: t('Name', '名称'),
            usageColumn: t('Usage', '使用情况'),
            notConfigured: t('API key not configured for this entry.', '未配置 API 密钥'),
            queryFailed: t('Query failed.', '查询失败'),
            staleResult: t(
                'Result expired (key changed during query), will refresh on next cycle.',
                '结果已过期，将于下次刷新'
            )
        };
        return renderMultiKeySections(status, this.adapter, labels);
    }

    /**
     * 查询状态数据（密钥检查与异常包装在 ProviderStatusBarItem 模板）
     */
    protected async performQuery(apiKey: string): Promise<TRaw> {
        return await this.adapter.query(apiKey);
    }

    protected shouldHighlightWarning(data: TRaw): boolean {
        // 高亮仅以激活 key 为准；多 key 列表仅作展示，不参与告警
        const usageWarning = this.adapter.highlightWarning?.(data, this.HIGH_USAGE_THRESHOLD) ?? false;
        if (usageWarning) {
            return true;
        }
        return this.getBalanceAlertLevel(data) === 'warning';
    }

    protected override shouldHighlightError(data: TRaw): boolean {
        // 余额为负才为 error
        return this.getBalanceAlertLevel(data) === 'error';
    }

    /**
     * key 变化后多 key 缓存一并失效（激活项身份已变化），持久化缓存同步清除
     */
    protected override onApiKeyChangeDetected(): void {
        super.onApiKeyChangeDetected();
        this.multiKeyCollectionGeneration++;
        this.multiKeyCollecting = undefined;
        this.multiKeyStatus = undefined;
        void this.context?.globalState.update(this.getCacheKey(MULTI_KEY_CACHE_KEY), undefined);
    }

    private getBalanceAlertLevel(data: TRaw) {
        const balance = this.adapter.balance?.(data);
        const threshold = ConfigManager.getProviderBalanceWarningThreshold(this.config.apiKeyProvider);
        return getBalanceAlertLevel(balance, threshold);
    }

    /**
     * 缓存刷新：越过任一重置点（缓存写入早于该点）或超过 5 分钟固定阈值
     * 无缓存数据时刷新（如初始化查询失败后的周期重试，与 Grok/ChatGPT 状态栏行为一致）
     */
    protected shouldRefresh(): boolean {
        if (!this.lastStatusData) {
            return true;
        }

        const dataAge = Date.now() - this.lastStatusData.timestamp;
        const CACHE_EXPIRY_THRESHOLD = (5 * 60 - 10) * 1000;

        const resetPoints = this.adapter.refreshHints?.(this.lastStatusData.data, this.lastStatusData.timestamp) ?? [];
        const minReset = resetPoints.length > 0 ? Math.min(...resetPoints) : 0;
        if (minReset > 0 && this.lastStatusData.timestamp < minReset && Date.now() >= minReset) {
            StatusLogger.debug(`[${this.config.logPrefix}] 缓存写入早于重置点且已越过，触发API刷新`);
            return true;
        }

        if (dataAge > CACHE_EXPIRY_THRESHOLD) {
            StatusLogger.debug(
                `[${this.config.logPrefix}] 缓存时间(${(dataAge / 1000).toFixed(1)}秒)超过5分钟固定过期时间，触发API刷新`
            );
            return true;
        }

        return false;
    }
}

function appendQuotaTable(md: vscode.MarkdownString, table: QuotaTable): void {
    md.appendMarkdown(renderQuotaTable(table));
}
