/*---------------------------------------------------------------------------------------------
 *  提供商配置集纯逻辑（供 WebviewPanel 与同步服务复用）
 *  每套配置 = 站点 + API Key；切换时将整套配置覆盖写入现有消费点：
 *  - API Key -> ApiKeyManager 现有槽位（自动缓存失效 + 跨实例广播）
 *  - 站点    -> 现有 gcmp.{provider}.endpoint 设置（handler 逐请求实时读取）
 *  不改动任何现有实现。
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { configProviders } from '../../providers/config';
import { CliAuthFactory } from '../../cli/auth/cliAuthFactory';
import { ApiKeyManager } from './apiKeyManager';
import { CompatibleModelManager } from './compatibleModelManager';
import { ConfigSetItem, ConfigSetStore } from './configSetStore';
import { StatusBarManager } from '../../status/statusBarManager';
import { t } from '../runtime/l10n';
import { Logger } from '../runtime/logger';
import { KNOWN_KEY_LABELS } from '../../sync/gistSyncService';
import { getRegisteredProvider } from './providerRegistry';

/** 站点选项 */
export interface SiteOption {
    value: string;
    label: string;
}

/** 参与配置集的提供商 */
export interface ProviderPick {
    provider: string;
    displayName: string;
    apiKeyTemplate?: string;
}

let configSetMutationQueue: Promise<unknown> = Promise.resolve();

export function enqueueConfigSetMutation<T>(task: () => Promise<T>): Promise<T> {
    const run = configSetMutationQueue.then(task, task);
    configSetMutationQueue = run.catch(() => undefined);
    return run;
}

async function writeSiteSetting(provider: string, site: string | undefined): Promise<void> {
    await vscode.workspace
        .getConfiguration(`gcmp.${provider}`)
        .update('endpoint', site, vscode.ConfigurationTarget.Global);
}

/**
 * 获取提供商的站点选项（不支持站点切换的提供商返回 undefined）
 * 取值与 gcmp.{provider}.endpoint 设置的枚举值一一对应
 */
export function getSiteOptions(provider: string): SiteOption[] | undefined {
    switch (provider) {
        case 'zhipu':
            return [
                { value: 'open.bigmodel.cn', label: t('China (open.bigmodel.cn)', '国内站 (open.bigmodel.cn)') },
                { value: 'api.z.ai', label: t('International (api.z.ai)', '国际站 (api.z.ai)') }
            ];
        case 'minimax':
            return [
                { value: 'minimaxi.com', label: t('China (minimaxi.com)', '国内站 (minimaxi.com)') },
                { value: 'minimax.io', label: t('International (minimax.io)', '国际站 (minimax.io)') }
            ];
        case 'xiaomimimo':
            return [
                { value: 'cn', label: t('China (cn)', '中国接入点 (cn)') },
                { value: 'sgp', label: t('Singapore (sgp)', '新加坡接入点 (sgp)') },
                { value: 'ams', label: t('Europe (ams)', '欧洲接入点 (ams)') }
            ];
        default:
            return undefined;
    }
}

/** 站点标识转显示文本 */
export function siteLabel(provider: string, site: string | undefined): string | undefined {
    if (!site) {
        return undefined;
    }
    return getSiteOptions(provider)?.find(option => option.value === site)?.label ?? site;
}

/**
 * 获取某个接入点配置真正影响到的槽位。
 * - zhipu: 主槽位
 * - minimax: 仅 Token Plan 槽位
 * - xiaomimimo: 仅 Token Plan 槽位
 */
function getSiteScopedSlots(provider: string): string[] {
    switch (provider) {
        case 'minimax':
            return ['minimax-token'];
        case 'xiaomimimo':
            return ['xiaomimimo-token'];
        case 'zhipu':
            return ['zhipu'];
        default:
            return [];
    }
}

/** 读取当前 endpoint 设置值（仅支持站点切换的提供商） */
export function readCurrentSite(provider: string): string | undefined {
    const options = getSiteOptions(provider);
    if (!options || options.length === 0) {
        return undefined;
    }
    return vscode.workspace.getConfiguration(`gcmp.${provider}`).get<string>('endpoint') ?? options[0]?.value;
}

/** 可参与配置集的提供商：全部预置提供商，排除 CLI 认证（codex/grok） */
export function listEligibleProviders(): ProviderPick[] {
    const cliIds = CliAuthFactory.getSupportedCliTypes().map(cli => cli.id);
    return Object.entries(configProviders)
        .filter(([key]) => !cliIds.includes(key))
        .map(([key, config]) => ({
            provider: key,
            displayName: config.displayName || key,
            apiKeyTemplate: config.apiKeyTemplate
        }));
}

/**
 * 获取提供商的套餐变体槽位（如 minimax-token、dashscope-token）
 */
export function getVariantSlots(provider: string): string[] {
    const variants = new Set<string>();
    for (const model of configProviders[provider as keyof typeof configProviders]?.models ?? []) {
        if (model.provider && model.provider !== provider) {
            variants.add(model.provider);
        }
    }
    return Array.from(variants);
}

/** 获取变体槽位的显示名 */
export function variantDisplayName(variant: string): string {
    return KNOWN_KEY_LABELS[variant] ?? variant;
}

export function getSiteOwnerProvider(slot: string): string | undefined {
    for (const provider of Object.keys(configProviders)) {
        if (!getSiteOptions(provider)) {
            continue;
        }
        if (getSiteScopedSlots(provider).includes(slot)) {
            return provider;
        }
    }
    return undefined;
}

/**
 * 查找 slot 对应的 owner provider（用于 provider 实例注册表查找）
 * - slot 本身是主 provider（configProviders 有该键）→ 返回 slot
 * - slot 是某 provider 的变体（model.provider 指向该 slot）→ 返回该 provider
 * - slot 是自定义 compatible provider → 返回 'compatible'（自定义模型由统一的 compatible 实例管理，
 *   与 GistSyncService.notifyProviders 的未知 key 映射保持一致）
 * - 否则返回 undefined
 */
export function findOwnerProviderKey(slot: string): string | undefined {
    if (configProviders[slot as keyof typeof configProviders]) {
        return slot;
    }
    for (const provider of Object.keys(configProviders)) {
        if (getVariantSlots(provider).includes(slot)) {
            return provider;
        }
    }
    if (CompatibleModelManager.getCustomProviderIds().includes(slot)) {
        return 'compatible';
    }
    return undefined;
}

/** 槽位信息 */
export interface SlotInfo {
    slot: string;
    displayName: string;
    isMain: boolean;
    siteProvider?: string;
}

/**
 * 列出某提供商的全部槽位（主槽位 + 变体槽位）
 * 若提供商没有主槽位模型（如 tencent/xfyun，全部是变体），则只返回变体槽位。
 */
export function listSlots(provider: string): SlotInfo[] {
    const config = configProviders[provider as keyof typeof configProviders];
    const variantSlots = getVariantSlots(provider);
    const slots: SlotInfo[] = [];
    const siteScopedSlots = new Set(getSiteScopedSlots(provider));
    // 主槽位：仅当提供商有主槽位模型时才加入
    const hasMainModel = (config?.models ?? []).some(m => !m.provider || m.provider === provider);
    if (hasMainModel) {
        const mainName = config?.displayName || KNOWN_KEY_LABELS[provider] || provider;
        slots.push({
            slot: provider,
            displayName: mainName,
            isMain: true,
            siteProvider: siteScopedSlots.has(provider) ? provider : undefined
        });
    }
    for (const variant of variantSlots) {
        slots.push({
            slot: variant,
            displayName: variantDisplayName(variant),
            isMain: false,
            siteProvider: siteScopedSlots.has(variant) ? provider : undefined
        });
    }
    return slots;
}

/**
 * 将站点值写入现有 endpoint 设置
 */
export async function applySiteSetting(provider: string, site: string | undefined): Promise<void> {
    await writeSiteSetting(provider, site);
}

/**
 * 通知 slot 所属 provider 实例失效模型缓存并刷新模型列表
 * custom compatible slot 的模型缓存统一挂在 compatible 实例上，缓存失效目标须用实例自身 key
 */
export function notifySlotProviderChanged(slot: string): void {
    const ownerProviderKey = findOwnerProviderKey(slot);
    if (!ownerProviderKey) {
        return;
    }
    try {
        getRegisteredProvider(ownerProviderKey)?.invalidateAndNotify(
            ownerProviderKey === 'compatible' ? undefined : slot
        );
    } catch (error) {
        Logger.warn(`[ConfigSet] Failed to refresh provider state for ${slot}:`, error);
    }
}

/**
 * 应用一套配置到指定槽位：激活标记 + Key 覆盖 + 站点覆盖（仅受接入点影响的槽位）
 * 每个槽位独立切换，互不影响。
 */
export async function applyConfigSetUnlocked(slot: string, item: ConfigSetItem): Promise<boolean> {
    const apiKey = await ConfigSetStore.getApiKey(slot, item.id);
    if (!apiKey) {
        return false;
    }

    const siteProvider = getSiteOwnerProvider(slot);
    const previousKey = await ApiKeyManager.getApiKey(slot);
    const previousActiveId = ConfigSetStore.getActiveId(slot);
    const previousSite =
        siteProvider ? vscode.workspace.getConfiguration(`gcmp.${siteProvider}`).get<string>('endpoint') : undefined;
    const nextSite = item.site;
    let siteChanged = false;

    if (nextSite && siteProvider && nextSite !== readCurrentSite(siteProvider)) {
        // 站点先于 Key 写入：apiKeyChanged 事件触发的状态栏刷新会在事件后读取站点设置
        await applySiteSetting(siteProvider, nextSite);
        siteChanged = true;
    }

    try {
        await ConfigSetStore.setActive(slot, item.id);
        await ApiKeyManager.setApiKey(slot, apiKey);
    } catch (error) {
        if (previousActiveId) {
            await ConfigSetStore.setActive(slot, previousActiveId);
        } else {
            await ConfigSetStore.clearActive(slot);
        }
        if (siteChanged && siteProvider) {
            await writeSiteSetting(siteProvider, previousSite);
        }
        throw error;
    }

    if (siteChanged && siteProvider && previousKey === apiKey && StatusBarManager.getStatusBar(siteProvider)) {
        void StatusBarManager.checkAndShowStatus(siteProvider);
    }

    // setApiKey 命令链路自带的 invalidateAndNotify 只覆盖手动命令，不覆盖面板 apply
    notifySlotProviderChanged(slot);
    return true;
}

export async function applyConfigSet(slot: string, item: ConfigSetItem): Promise<boolean> {
    return await enqueueConfigSetMutation(() => applyConfigSetUnlocked(slot, item));
}

export async function deactivateConfigSetUnlocked(slot: string, deleteCurrentKey = true): Promise<void> {
    const previousActiveId = ConfigSetStore.getActiveId(slot);
    const previousKey = await ApiKeyManager.getApiKey(slot);

    if (previousActiveId) {
        await ConfigSetStore.clearActive(slot);
    }

    try {
        if (deleteCurrentKey && previousKey) {
            await ApiKeyManager.deleteApiKey(slot);
        }
    } catch (error) {
        if (previousActiveId) {
            await ConfigSetStore.setActive(slot, previousActiveId);
        }
        throw error;
    }

    notifySlotProviderChanged(slot);
}

export async function deactivateConfigSet(slot: string, deleteCurrentKey = true): Promise<void> {
    await enqueueConfigSetMutation(() => deactivateConfigSetUnlocked(slot, deleteCurrentKey));
}
