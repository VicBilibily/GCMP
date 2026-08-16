/*---------------------------------------------------------------------------------------------
 *  Config Set Manager - 用量/余量调度
 *  从 index.ts 抽出：Config Usage 的排队/超时/序号管理，以及 CLI 余量刷新。
 *  通过 PanelContext 与 Panel 解耦；自身维护所有 requestSeq 与 timeout 状态。
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { ConfigSetStore } from '../../utils/config/configSetStore';
import { listSlots } from '../../utils/config/configSetCommands';
import { getKeyDisplayName } from '../../sync/gistSyncService';
import { t } from '../../utils/runtime/l10n';
import { buildCodexUsageSummary, buildCodexUsageTable, queryCodexUsage } from '../../quota/codexQuota';
import { buildGrokUsageSummary, buildGrokUsageTable, queryGrokUsage } from '../../quota/grokQuota';
import {
    queryProviderQuota,
    isQuotaSupportedSlot,
    getQuotaMetricType,
    getQuotaMetricLabel,
    resolveQuotaSite,
    formatQuotaLastUpdated
} from '../../quota/providerQuota';
import type { PanelContext, ConfigUsageState } from './types';
import type { QuotaQueryResult } from '../../quota/types';

/** 支持余量查询的 CLI 提供商（首屏占位 + 后台查询） */
const CLI_USAGE_PROVIDERS = new Set(['codex', 'grok']);

/** 单次配额查询超时：前端提示与队列解除共用（挂起的请求会被跳过，不阻塞后续排队项） */
const QUOTA_QUERY_TIMEOUT_MS = 15000;

/** 单个配置用量查询请求（排队调度用） */
interface UsageRequest {
    slot: string;
    id: string;
    apiKey: string;
    site: string | undefined;
    requestSeq: number;
}

/**
 * 用量/余量调度宿主
 * 负责：refreshCliUsage / handleLoadProviderUsage / handleRefreshConfigUsage，
 * 以及内部的超时、序号、状态构建等所有调度辅助。
 */
export class UsageHost {
    private providerUsageLoadSeq = 0;
    private configUsageTimeouts = new Map<string, ReturnType<typeof setTimeout>>();
    private configUsageRequestSeq = new Map<string, number>();

    constructor(private readonly ctx: PanelContext) {}

    /** 面板销毁时调用：作废所有未完成的请求与超时 */
    dispose(): void {
        this.providerUsageLoadSeq += 1;
        for (const timeout of this.configUsageTimeouts.values()) {
            clearTimeout(timeout);
        }
        this.configUsageTimeouts.clear();
        this.configUsageRequestSeq.clear();
    }

    // ============= CLI 余量 =============

    async refreshCliUsage(provider: string): Promise<void> {
        if (!CLI_USAGE_PROVIDERS.has(provider)) {
            return;
        }
        this.ctx.post({ command: 'cliUsage', provider, usage: { loading: true } });
        try {
            if (provider === 'codex') {
                await this.refreshCodexUsage(provider);
            } else if (provider === 'grok') {
                await this.refreshGrokUsage(provider);
            }
        } catch (error) {
            if (!this.ctx.isAlive()) {
                return;
            }
            const errorMessage = error instanceof Error ? error.message : String(error);
            this.ctx.post({ command: 'cliUsage', provider, usage: { loading: false, error: errorMessage } });
        }
    }

    private async refreshCodexUsage(provider: string): Promise<void> {
        const result = await queryCodexUsage();
        if (!this.ctx.isAlive()) {
            return;
        }
        if (!result.success || !result.data) {
            this.ctx.post({
                command: 'cliUsage',
                provider,
                usage: { loading: false, error: result.error }
            });
            return;
        }
        const data = result.data;
        const table = buildCodexUsageTable(data);
        this.ctx.post({
            command: 'cliUsage',
            provider,
            usage: {
                loading: false,
                planType: data.planType,
                email: data.email,
                summary: buildCodexUsageSummary(data),
                table: { columns: table.columns, rows: table.rows },
                lastUpdated: data.lastUpdated
            }
        });
    }

    private async refreshGrokUsage(provider: string): Promise<void> {
        const lastUpdated = new Date().toLocaleString(
            vscode.env.language.toLowerCase().startsWith('zh') ? 'zh-CN' : 'en-US'
        );
        const result = await queryGrokUsage(lastUpdated);
        if (!this.ctx.isAlive()) {
            return;
        }
        if (!result.success || !result.data) {
            this.ctx.post({
                command: 'cliUsage',
                provider,
                usage: { loading: false, error: result.error }
            });
            return;
        }
        const data = result.data;
        const table = buildGrokUsageTable(data);
        this.ctx.post({
            command: 'cliUsage',
            provider,
            usage: {
                loading: false,
                planType: data.usage.subscriptionTier,
                summary: buildGrokUsageSummary(data),
                table: { columns: table.columns, rows: table.rows },
                lastUpdated: data.lastUpdated
            }
        });
    }

    // ============= Provider 用量（per-slot） =============

    async handleLoadProviderUsage(provider: string, isCustom: boolean): Promise<void> {
        const providerUsageLoadSeq = ++this.providerUsageLoadSeq;
        const configUsages: ConfigUsageState[] = [];
        const priorityRequests: UsageRequest[] = [];
        const normalRequests: UsageRequest[] = [];

        const slotInfos =
            isCustom ?
                [{ slot: provider, displayName: getKeyDisplayName(`${provider}.apiKey`), isMain: true }]
            :   listSlots(provider);

        for (const slotInfo of slotInfos) {
            if (!isQuotaSupportedSlot(slotInfo.slot)) {
                continue;
            }

            const items = ConfigSetStore.list(slotInfo.slot);
            const activeId = ConfigSetStore.getActiveId(slotInfo.slot);
            const itemApiKeys = await Promise.all(items.map(item => ConfigSetStore.getApiKey(slotInfo.slot, item.id)));
            for (const [index, item] of items.entries()) {
                const configUsageKey = this.getConfigUsageKey(slotInfo.slot, item.id);
                const apiKey = itemApiKeys[index];
                if (!apiKey) {
                    this.clearConfigUsageTimeout(configUsageKey);
                    configUsages.push(this.buildMissingKeyUsageState(slotInfo.slot, item.id));
                    continue;
                }

                const requestSeq = this.nextConfigUsageRequestSeq(configUsageKey);
                configUsages.push(
                    this.createConfigUsageState(slotInfo.slot, item.id, { loading: false, queued: true })
                );

                const request: UsageRequest = {
                    slot: slotInfo.slot,
                    id: item.id,
                    apiKey,
                    site: resolveQuotaSite(slotInfo.slot, item.site),
                    requestSeq
                };

                if (item.id === activeId) {
                    priorityRequests.push(request);
                } else {
                    normalRequests.push(request);
                }
            }
        }

        this.postConfigUsages(configUsages);
        void this.runQueuedProviderUsageRefresh([...priorityRequests, ...normalRequests], providerUsageLoadSeq);
    }

    async handleRefreshConfigUsage(slot: string, id: string): Promise<void> {
        if (!isQuotaSupportedSlot(slot)) {
            return;
        }

        const item = ConfigSetStore.list(slot).find(entry => entry.id === id);
        if (!item) {
            return;
        }

        const apiKey = await ConfigSetStore.getApiKey(slot, id);
        if (!apiKey) {
            this.clearConfigUsageTimeout(this.getConfigUsageKey(slot, id));
            this.postConfigUsages([this.buildMissingKeyUsageState(slot, id)]);
            return;
        }

        const configUsageKey = this.getConfigUsageKey(slot, id);
        const requestSeq = this.nextConfigUsageRequestSeq(configUsageKey);
        this.scheduleConfigUsageTimeout(slot, id, requestSeq);
        this.postConfigUsages([this.createConfigUsageState(slot, id, { loading: true })]);
        void this.queryAndPostConfigUsage(slot, id, apiKey, resolveQuotaSite(slot, item.site), requestSeq);
    }

    // ============= 内部辅助 =============

    private getConfigUsageKey(slot: string, id: string): string {
        return `${slot}:${id}`;
    }

    private postConfigUsages(configUsages: ConfigUsageState[]): void {
        if (configUsages.length === 0) {
            return;
        }
        this.ctx.post({ command: 'configUsages', configUsages });
    }

    private createConfigUsageState(
        slot: string,
        id: string,
        options?: Omit<ConfigUsageState, 'slot' | 'id' | 'supported'>
    ): ConfigUsageState {
        return {
            slot,
            id,
            supported: true,
            metricType: options?.metricType ?? getQuotaMetricType(slot),
            queued: options?.queued,
            loading: options?.loading ?? false,
            summary: options?.summary,
            tables: options?.tables,
            usageEntries: options?.usageEntries,
            details: options?.details,
            error: options?.error,
            lastUpdated: options?.lastUpdated
        };
    }

    private buildMissingKeyUsageState(slot: string, id: string): ConfigUsageState {
        return this.createConfigUsageState(slot, id, {
            loading: false,
            error: t('This configuration does not have a saved API key.', '该配置当前没有可用的已保存 API Key。')
        });
    }

    private nextConfigUsageRequestSeq(configUsageKey: string): number {
        const nextSeq = (this.configUsageRequestSeq.get(configUsageKey) ?? 0) + 1;
        this.configUsageRequestSeq.set(configUsageKey, nextSeq);
        return nextSeq;
    }

    private clearConfigUsageTimeout(configUsageKey: string): void {
        const timeout = this.configUsageTimeouts.get(configUsageKey);
        if (timeout) {
            clearTimeout(timeout);
            this.configUsageTimeouts.delete(configUsageKey);
        }
    }

    private scheduleConfigUsageTimeout(slot: string, id: string, requestSeq: number): void {
        const configUsageKey = this.getConfigUsageKey(slot, id);
        this.clearConfigUsageTimeout(configUsageKey);
        this.configUsageTimeouts.set(
            configUsageKey,
            setTimeout(() => {
                if (this.configUsageRequestSeq.get(configUsageKey) !== requestSeq) {
                    return;
                }
                this.configUsageTimeouts.delete(configUsageKey);
                this.postConfigUsages([
                    this.createConfigUsageState(slot, id, {
                        loading: false,
                        summary: t('Unable to load {0} data', '暂时无法加载{0}数据', getQuotaMetricLabel(slot)),
                        error: t(
                            '{0} query timed out. Please refresh and retry.',
                            '{0}查询超时，请手动刷新重试。',
                            getQuotaMetricLabel(slot)
                        )
                    })
                ]);
            }, QUOTA_QUERY_TIMEOUT_MS)
        );
    }

    /**
     * 配额查询带超时保护：网络挂起时在超时后返回 undefined，解除顺序队列阻塞。
     * 超时提示由 scheduleConfigUsageTimeout 负责，这里不重复下发消息。
     */
    private async runQuotaQueryWithTimeout(
        slot: string,
        apiKey: string,
        site: string | undefined
    ): Promise<QuotaQueryResult | undefined> {
        let timeoutId: ReturnType<typeof setTimeout> | undefined;
        const timeout = new Promise<undefined>(resolve => {
            timeoutId = setTimeout(resolve, QUOTA_QUERY_TIMEOUT_MS, undefined);
        });
        try {
            return await Promise.race([
                queryProviderQuota(slot, apiKey, site, formatQuotaLastUpdated(new Date())),
                timeout
            ]);
        } finally {
            clearTimeout(timeoutId);
        }
    }

    private async queryAndPostConfigUsage(
        slot: string,
        id: string,
        apiKey: string,
        site: string | undefined,
        requestSeq: number,
        providerUsageLoadSeq?: number
    ): Promise<void> {
        const configUsageKey = this.getConfigUsageKey(slot, id);
        try {
            const result = await this.runQuotaQueryWithTimeout(slot, apiKey, site);
            if (!result) {
                // 查询挂起超时：超时提示已由 timer 下发，这里仅解除队列阻塞
                return;
            }
            if (
                !this.ctx.isAlive() ||
                this.configUsageRequestSeq.get(configUsageKey) !== requestSeq ||
                (providerUsageLoadSeq !== undefined && this.providerUsageLoadSeq !== providerUsageLoadSeq)
            ) {
                return;
            }
            this.clearConfigUsageTimeout(configUsageKey);
            this.postConfigUsages([
                this.createConfigUsageState(slot, id, {
                    loading: false,
                    queued: false,
                    metricType: result.metricType,
                    summary: result.summary,
                    tables: result.tables,
                    usageEntries: result.quotaEntries,
                    details: result.details,
                    lastUpdated: result.lastUpdated
                })
            ]);
        } catch (error) {
            if (
                !this.ctx.isAlive() ||
                this.configUsageRequestSeq.get(configUsageKey) !== requestSeq ||
                (providerUsageLoadSeq !== undefined && this.providerUsageLoadSeq !== providerUsageLoadSeq)
            ) {
                return;
            }
            this.clearConfigUsageTimeout(configUsageKey);
            const errorMessage = error instanceof Error ? error.message : String(error);
            this.postConfigUsages([
                this.createConfigUsageState(slot, id, {
                    loading: false,
                    queued: false,
                    summary: t('Unable to load {0} data', '暂时无法加载{0}数据', getQuotaMetricLabel(slot)),
                    error: errorMessage
                })
            ]);
        }
    }

    private async runQueuedProviderUsageRefresh(requests: UsageRequest[], providerUsageLoadSeq: number): Promise<void> {
        for (const request of requests) {
            if (!this.ctx.isAlive() || this.providerUsageLoadSeq !== providerUsageLoadSeq) {
                return;
            }

            const configUsageKey = this.getConfigUsageKey(request.slot, request.id);
            if (this.configUsageRequestSeq.get(configUsageKey) !== request.requestSeq) {
                continue;
            }

            this.scheduleConfigUsageTimeout(request.slot, request.id, request.requestSeq);
            this.postConfigUsages([
                this.createConfigUsageState(request.slot, request.id, {
                    loading: true,
                    queued: false
                })
            ]);

            await this.queryAndPostConfigUsage(
                request.slot,
                request.id,
                request.apiKey,
                request.site,
                request.requestSeq,
                providerUsageLoadSeq
            );
        }
    }
}
