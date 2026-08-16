/*---------------------------------------------------------------------------------------------
 *  Config Set Manager - 状态构建与下发
 *  从 index.ts 抽出：构建提供商选项 / 各槽位状态 / CLI 提供商状态刷新。
 *  通过 PanelContext 与 Panel 解耦；自身维护 CLI 刷新序号防止过期回写。
 *--------------------------------------------------------------------------------------------*/

import {
    getSiteOptions,
    getVariantSlots,
    listEligibleProviders,
    listSlots,
    readCurrentSite,
    siteLabel
} from '../../utils/config/configSetCommands';
import { ApiKeyManager } from '../../utils/config/apiKeyManager';
import { ConfigSetItem, ConfigSetStore } from '../../utils/config/configSetStore';
import { getKeyDisplayName } from '../../sync/gistSyncService';
import { CompatibleModelManager } from '../../utils/config/compatibleModelManager';
import { Logger } from '../../utils/runtime/logger';
import { isQuotaSupportedSlot, getQuotaMetricType } from '../../quota/providerQuota';
import { buildCliProviders as buildCliProvidersFromCliHost } from './cliHost';
import type { PanelContext, ProviderOption, ProviderState } from './types';

/** 全部受管槽位（内置主/变体 + 自定义 provider，不含 CLI 认证槽位），顺序即面板管理的默认排序 */
export function collectManagedSlots(): Array<{ slot: string; displayName: string }> {
    const managed: Array<{ slot: string; displayName: string }> = [];
    for (const p of listEligibleProviders()) {
        for (const s of listSlots(p.provider)) {
            managed.push({ slot: s.slot, displayName: s.displayName });
        }
    }
    for (const provider of CompatibleModelManager.getCustomProviderIds()) {
        managed.push({ slot: provider, displayName: getKeyDisplayName(`${provider}.apiKey`) });
    }
    return managed;
}

/**
 * 状态构建与下发宿主
 * 负责：buildProviderOptions / buildStates / sendStates / refreshCliProviders。
 */
export class StateHost {
    private cliProvidersRequestSeq = 0;

    constructor(private readonly ctx: PanelContext) {}

    /** 使后续 refreshCliProviders 的过期回写失效（面板销毁时调用） */
    dispose(): void {
        this.cliProvidersRequestSeq += 1;
    }

    buildProviderOptions(): ProviderOption[] {
        const builtin = listEligibleProviders().map(p => {
            const sites = getSiteOptions(p.provider);
            return {
                provider: p.provider,
                displayName: p.displayName,
                apiKeyTemplate: p.apiKeyTemplate,
                hasSite: !!sites,
                sites: sites ?? undefined,
                variantSlots: getVariantSlots(p.provider)
            };
        });

        const custom = CompatibleModelManager.getCustomProviderIds().map(provider => ({
            provider,
            displayName: getKeyDisplayName(`${provider}.apiKey`),
            apiKeyTemplate: 'sk-xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx',
            hasSite: false,
            sites: undefined,
            variantSlots: []
        }));

        return [...builtin, ...custom];
    }

    async buildStates(): Promise<ProviderState[]> {
        const builtinProviders = listEligibleProviders().map(p => ({
            provider: p.provider,
            displayName: p.displayName,
            custom: false
        }));
        const customProviders = CompatibleModelManager.getCustomProviderIds().map(provider => ({
            provider,
            displayName: getKeyDisplayName(`${provider}.apiKey`),
            custom: true
        }));
        const states: ProviderState[] = [];
        for (const p of [...builtinProviders, ...customProviders]) {
            const slots =
                p.custom ? [{ slot: p.provider, displayName: p.displayName, isMain: true }] : listSlots(p.provider);
            const slotStates = [];
            const providerCurrentSite = p.custom ? undefined : readCurrentSite(p.provider);
            for (const slotInfo of slots) {
                const currentSite = !p.custom && slotInfo.siteProvider ? providerCurrentSite : undefined;
                await ConfigSetStore.ensureMigrated(slotInfo.slot, currentSite);
                await ConfigSetStore.backfillMissingSite(slotInfo.slot, currentSite);
                const items = ConfigSetStore.list(slotInfo.slot);
                const activeId = ConfigSetStore.getActiveId(slotInfo.slot);
                // 激活判定以 ApiKeyManager 实际生效的 Key 为准。
                const [currentKey, ...itemKeyValues] = await Promise.all([
                    ApiKeyManager.getApiKey(slotInfo.slot),
                    ...items.map(item => ConfigSetStore.getApiKey(slotInfo.slot, item.id))
                ]);
                const itemKeys = new Map<string, string | undefined>(
                    items.map((item, index) => [item.id, itemKeyValues[index]] as const)
                );
                // 计算真实激活 ID：仅当当前生效 Key 与配置项实际匹配时才标记为激活。
                const siteOwner = slotInfo.siteProvider;
                const matchesCurrent = (item: ConfigSetItem): boolean => {
                    if (itemKeys.get(item.id) !== currentKey) {
                        return false;
                    }
                    return !siteOwner || (item.site ?? currentSite) === currentSite;
                };
                let effectiveActiveId: string | undefined;
                if (!currentKey) {
                    effectiveActiveId = undefined;
                } else {
                    const activeItem = items.find(item => item.id === activeId);
                    effectiveActiveId =
                        activeItem && matchesCurrent(activeItem) ? activeId : items.find(matchesCurrent)?.id;
                }
                const hasUsage = isQuotaSupportedSlot(slotInfo.slot);
                slotStates.push({
                    slot: slotInfo.slot,
                    displayName: slotInfo.displayName,
                    isMain: slotInfo.isMain,
                    hasSite: !p.custom && !!slotInfo.siteProvider,
                    hasUsage,
                    usageMetricType: hasUsage ? getQuotaMetricType(slotInfo.slot) : undefined,
                    currentSiteLabel:
                        !p.custom && slotInfo.siteProvider ? siteLabel(slotInfo.siteProvider, currentSite) : undefined,
                    rows: items.map(item => ({
                        id: item.id,
                        label: item.label,
                        site: item.site,
                        note: item.note,
                        siteLabel:
                            !p.custom && slotInfo.siteProvider ?
                                siteLabel(slotInfo.siteProvider, item.site ?? currentSite)
                            :   undefined,
                        isActive: item.id === effectiveActiveId
                    }))
                });
            }
            states.push({
                provider: p.provider,
                displayName: p.displayName,
                isCustom: p.custom,
                slots: slotStates
            });
        }
        return states;
    }

    async sendStates(): Promise<void> {
        const states = await this.buildStates();
        this.ctx.post({ command: 'states', states });
    }

    async refreshCliProviders(): Promise<void> {
        const requestSeq = ++this.cliProvidersRequestSeq;
        try {
            const cliProviders = await buildCliProvidersFromCliHost();
            if (!this.ctx.isAlive() || requestSeq !== this.cliProvidersRequestSeq) {
                return;
            }
            this.ctx.post({ command: 'cliProviders', cliProviders });
        } catch (error) {
            Logger.error('[ConfigSetManager] refresh CLI providers failed:', error);
        }
    }

    isCustomCompatibleProvider(provider: string): boolean {
        return CompatibleModelManager.getCustomProviderIds().includes(provider);
    }
}
