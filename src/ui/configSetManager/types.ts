/*---------------------------------------------------------------------------------------------
 *  Config Set Manager WebView 类型定义（per-slot 模型）
 *  每个槽位（主 provider 或变体）独立管理配置列表与激活状态。
 *  HostMessage: 后端 -> 前端
 *  WebViewMessage: 前端 -> 后端
 *--------------------------------------------------------------------------------------------*/

/** 站点选项 */
export interface SiteOption {
    value: string;
    label: string;
}

/** 参与配置集的提供商（前端展示用） */
export interface ProviderOption {
    provider: string;
    displayName: string;
    apiKeyTemplate?: string;
    /** 是否支持站点切换 */
    hasSite: boolean;
    /** 站点选项（hasSite=true 时有值） */
    sites?: SiteOption[];
    /** 套餐变体槽位列表（如 minimax-token），每个变体可独立管理配置 */
    variantSlots?: string[];
}

/** 槽位信息 */
export interface SlotInfo {
    slot: string;
    displayName: string;
    isMain: boolean;
    siteProvider?: string;
}

/** 某个槽位的一套配置（前端展示用，不含 Key） */
export interface ConfigSetRow {
    id: string;
    label: string;
    site?: string;
    siteLabel?: string;
    note?: string;
    isActive: boolean;
}

/** 用量/余额展示表格（与 src/quota/types.ts 的 QuotaTable 同构） */
import type { QuotaTable } from '../../quota/types';
export type ConfigUsageTable = QuotaTable;

/** 某个 usage entry 的展示项（自定义 provider 多余额场景） */
export interface ConfigUsageEntryState {
    label?: string;
    summary: string;
    tables?: QuotaTable[];
}

/** 某套配置（对应单个 key）的用量查询状态 */
export interface ConfigUsageState {
    slot: string;
    id: string;
    supported: boolean;
    metricType?: 'usage' | 'balance';
    queued?: boolean;
    loading: boolean;
    summary?: string;
    tables?: ConfigUsageTable[];
    /** 自定义 provider 多 usage 展示项（usage entry 级） */
    usageEntries?: ConfigUsageEntryState[];
    details?: string[];
    error?: string;
    lastUpdated?: string;
}

/** 某个槽位的完整状态 */
export interface SlotState {
    slot: string;
    displayName: string;
    isMain: boolean;
    hasSite: boolean;
    currentSiteLabel?: string;
    /** 是否支持用量/余额查询（后端判定，前端不自行猜测） */
    hasUsage: boolean;
    /** 用量展示类型（hasUsage=true 时有值） */
    usageMetricType?: 'usage' | 'balance';
    rows: ConfigSetRow[];
}

/** 某个 provider 的完整状态（含主槽位 + 变体槽位） */
export interface ProviderState {
    provider: string;
    displayName: string;
    /** 是否自定义 compatible provider（侧栏独立分组展示） */
    isCustom?: boolean;
    slots: SlotState[];
}

/** 恢复时的远端配置项快照（不含 Key；激活状态不同步，由本地确认） */
export interface RemoteItemSnapshot {
    id: string;
    label: string;
    siteLabel?: string;
    note?: string;
}

/** 恢复时的远端槽位快照 */
export interface RemoteSlotSnapshot {
    slot: string;
    displayName: string;
    itemCount: number;
    status: 'new' | 'update' | 'unchanged';
    /** 远端配置项明细（逐项选择恢复用） */
    items: RemoteItemSnapshot[];
}

/** 槽位内逐项选择：slot -> 选中的配置项 id（恢复/上传共用） */
export interface SlotItemSelection {
    slot: string;
    itemIds: string[];
    /** 上传时按预检快照显式删除的远端配置 id */
    removeItemIds?: string[];
}

/** 上传预检的本地配置项快照（不含 Key） */
export interface LocalItemSnapshot {
    id: string;
    label: string;
    siteLabel?: string;
    note?: string;
    /** 是否有已保存的 Key（无 Key 项不可上传） */
    hasKey: boolean;
    /** 是否为本地当前激活配置 */
    isActive: boolean;
}

/** 上传预检的槽位快照 */
export interface UploadSlotSnapshot {
    slot: string;
    displayName: string;
    /** 相对远端的同步状态（远端不可读时无值） */
    status?: 'new' | 'update' | 'unchanged';
    /** 远端独有配置名（整槽全选上传时将被移除，仅提示用） */
    remoteOnlyLabels?: string[];
    /** 远端独有配置 id（整槽全选上传时按预检显式删除） */
    remoteOnlyIds?: string[];
    items: LocalItemSnapshot[];
}

/** 激活管理的槽位配置项快照（单选激活对话框用） */
export interface ActiveConfigItemSnapshot {
    id: string;
    label: string;
    siteLabel?: string;
    /** 是否有已保存的 Key（无 Key 项不可激活） */
    hasKey: boolean;
}

/** 激活管理的槽位快照（统一管理对话框用） */
export interface ActiveSlotSnapshot {
    slot: string;
    displayName: string;
    /** 当前激活的配置项 id（无激活或面板外设置时为 undefined） */
    activeId?: string;
    /** 当前有生效 Key 但不匹配任何配置（面板外设置） */
    outsideActive: boolean;
    items: ActiveConfigItemSnapshot[];
}

/** 激活管理动作：activateId 有值 = 激活该配置，缺省 = 撤销该槽位激活 */
export interface ActiveKeyAction {
    slot: string;
    activateId?: string;
    /** 面板外 Key 的删除需额外确认 */
    clearOutsideKey?: boolean;
}

/** 远端配置管理的槽位快照（勾选保留、未选删除对话框用） */
export interface RemoteManageSlotSnapshot {
    slot: string;
    displayName: string;
    items: RemoteItemSnapshot[];
}

/** CLI 提供商余量查询状态（如 Codex 限频窗口） */
export interface CliUsageState {
    /** 是否正在查询 */
    loading: boolean;
    /** 计划类型（如 Plus / Pro） */
    planType?: string;
    /** 账户邮箱 */
    email?: string;
    /** 百分比总览（如 "85% (92%)"） */
    summary?: string;
    /** 限频窗口表格 */
    table?: ConfigUsageTable;
    /** 查询错误 */
    error?: string;
    /** 最后更新时间 */
    lastUpdated?: string;
}

/** CLI 认证提供商（仅展示与跳转，不从面板直接管理凭证） */
export interface CliProviderOption {
    provider: string;
    displayName: string;
    /** 是否仍在异步检查状态 */
    loading?: boolean;
    /** 是否已认证（凭证存在且未过期） */
    isAuthenticated: boolean;
    /** CLI 命令名（如 codex / grok） */
    cliCommand: string;
    /** CLI 是否已安装 */
    isCliInstalled: boolean;
    /** 认证状态详情（过期/缺失/有效） */
    statusDetail?: string;
    /** 余量查询状态（仅支持余量的 CLI，如 codex） */
    usage?: CliUsageState;
}

/** Gist 同步状态（右上角菜单展示用） */
export interface GistSyncState {
    /** GitHub 是否已登录（静默探测） */
    isLoggedIn: boolean;
    /** GitHub 用户名（已登录时） */
    githubUser?: string;
    /** 是否已关联同步 Gist */
    hasGist: boolean;
    /** 是否已设置自定义加密口令 */
    hasCustomPassphrase: boolean;
}

export interface AddFormDraftState {
    slot: string;
    label: string;
    note: string;
    apiKey: string;
    site?: string;
}

export interface EditFormDraftState {
    key: string;
    label: string;
    note: string;
    apiKey: string;
}

/** ============= 后端 -> 前端 ============= */

export type HostMessage =
    | {
          command: 'init';
          locale: string;
          providers: ProviderOption[];
          states: ProviderState[];
          cliProviders: CliProviderOption[];
          syncState: GistSyncState;
      }
    | { command: 'states'; states: ProviderState[] }
    | { command: 'cliProviders'; cliProviders: CliProviderOption[] }
    | { command: 'cliUsage'; provider: string; usage: CliUsageState }
    | { command: 'configUsages'; configUsages: ConfigUsageState[] }
    | { command: 'addResult'; ok: boolean; error?: string; note?: string }
    | { command: 'applyResult'; ok: boolean; error?: string }
    | { command: 'deactivateResult'; ok: boolean; error?: string; note?: string }
    | { command: 'editResult'; ok: boolean; error?: string; note?: string }
    | { command: 'removeResult'; ok: boolean; error?: string; note?: string }
    | { command: 'uploadResult'; ok: boolean; error?: string; warning?: string; uploadedCount?: number }
    | { command: 'uploadPrep'; snapshots: UploadSlotSnapshot[]; remoteReadable: boolean; warning?: string }
    | { command: 'requestPassphrase'; error?: string }
    | { command: 'downloadPrep'; snapshots: RemoteSlotSnapshot[]; warning?: string }
    | { command: 'clearRestorePrep' }
    | { command: 'downloadResult'; ok: boolean; error?: string; appliedCount?: number }
    | { command: 'activeKeysPrep'; snapshots: ActiveSlotSnapshot[] }
    | { command: 'activeKeysResult'; ok: boolean; changedCount?: number; error?: string }
    | { command: 'remoteConfigsPrep'; snapshots: RemoteManageSlotSnapshot[]; warning?: string }
    | { command: 'remoteConfigsResult'; ok: boolean; removedCount?: number; error?: string }
    | { command: 'syncStatus'; busy: boolean }
    | { command: 'syncState'; syncState: GistSyncState };

/** ============= 前端 -> 后端 ============= */

export type WebViewMessage =
    | { command: 'ready' }
    | { command: 'loadProviderUsage'; provider: string }
    | { command: 'refreshConfigUsage'; slot: string; id: string }
    | { command: 'add'; slot: string; label: string; note?: string; site?: string; apiKey: string }
    | { command: 'apply'; slot: string; id: string }
    | { command: 'deactivate'; slot: string }
    | { command: 'edit'; slot: string; id: string; label: string; note?: string; apiKey?: string }
    | { command: 'remove'; slot: string; id: string }
    | { command: 'setupCli'; provider: string }
    | { command: 'openCliTerminal'; provider: string }
    | { command: 'removeCliCredential'; provider: string }
    | { command: 'refreshCliUsage'; provider: string }
    | { command: 'upload' }
    | { command: 'uploadSelected'; selections: SlotItemSelection[] }
    | { command: 'download' }
    | { command: 'downloadWithPassphrase'; passphrase: string }
    | { command: 'discardRestorePrep' }
    | { command: 'restore'; selections: SlotItemSelection[] }
    | { command: 'manageActiveKeys' }
    | { command: 'applyActiveKeys'; actions: ActiveKeyAction[] }
    | { command: 'manageRemoteConfigs' }
    | { command: 'applyRemoteConfigs'; remove: SlotItemSelection[] }
    | { command: 'setPassphrase' }
    | { command: 'clearPassphrase' }
    | { command: 'migrateLegacyGist' }
    | { command: 'openLegacySync' };

/** ============= 消息校验 ============= */

/** webview 消息字符串字段的最大长度（防巨型负载进入存储链路） */
const MAX_MESSAGE_FIELD_LENGTH = 8192;

function isValidString(value: unknown): value is string {
    return typeof value === 'string' && value.length > 0 && value.length <= MAX_MESSAGE_FIELD_LENGTH;
}

function isOptionalString(value: unknown): boolean {
    return value === undefined || (typeof value === 'string' && value.length <= MAX_MESSAGE_FIELD_LENGTH);
}

function isStringArray(value: unknown): value is string[] {
    return Array.isArray(value) && value.every(entry => typeof entry === 'string');
}

function isSlotItemSelections(value: unknown): value is SlotItemSelection[] {
    return (
        Array.isArray(value) &&
        value.every(
            entry =>
                !!entry &&
                typeof entry === 'object' &&
                isValidString((entry as SlotItemSelection).slot) &&
                isStringArray((entry as SlotItemSelection).itemIds) &&
                ((entry as SlotItemSelection).removeItemIds === undefined ||
                    isStringArray((entry as SlotItemSelection).removeItemIds))
        )
    );
}

function isActiveKeyActions(value: unknown): value is ActiveKeyAction[] {
    return (
        Array.isArray(value) &&
        value.every(
            entry =>
                !!entry &&
                typeof entry === 'object' &&
                isValidString((entry as ActiveKeyAction).slot) &&
                isOptionalString((entry as ActiveKeyAction).activateId) &&
                ((entry as ActiveKeyAction).clearOutsideKey === undefined ||
                    typeof (entry as ActiveKeyAction).clearOutsideKey === 'boolean')
        )
    );
}

/**
 * 校验并收窄前端发来的 webview 消息；未知命令或字段结构非法时返回 undefined。
 * 防御畸形负载进入配置存储与密钥管理链路。
 */
export function sanitizeWebViewMessage(raw: unknown): WebViewMessage | undefined {
    if (!raw || typeof raw !== 'object') {
        return undefined;
    }
    const msg = raw as Record<string, unknown>;
    if (typeof msg.command !== 'string') {
        return undefined;
    }
    switch (msg.command) {
        case 'ready':
        case 'upload':
        case 'download':
        case 'discardRestorePrep':
        case 'manageActiveKeys':
        case 'manageRemoteConfigs':
        case 'setPassphrase':
        case 'clearPassphrase':
        case 'migrateLegacyGist':
        case 'openLegacySync':
            return msg as unknown as WebViewMessage;
        case 'loadProviderUsage':
        case 'setupCli':
        case 'openCliTerminal':
        case 'removeCliCredential':
        case 'refreshCliUsage':
            return isValidString(msg.provider) ? (msg as unknown as WebViewMessage) : undefined;
        case 'refreshConfigUsage':
        case 'apply':
        case 'remove':
            return isValidString(msg.slot) && isValidString(msg.id) ? (msg as unknown as WebViewMessage) : undefined;
        case 'deactivate':
            return isValidString(msg.slot) ? (msg as unknown as WebViewMessage) : undefined;
        case 'add':
            return (
                    isValidString(msg.slot) &&
                        isValidString(msg.label) &&
                        isValidString(msg.apiKey) &&
                        isOptionalString(msg.note) &&
                        isOptionalString(msg.site)
                ) ?
                    (msg as unknown as WebViewMessage)
                :   undefined;
        case 'edit':
            if (
                !isValidString(msg.slot) ||
                !isValidString(msg.id) ||
                !isValidString(msg.label) ||
                !isOptionalString(msg.note) ||
                !isOptionalString(msg.apiKey)
            ) {
                return undefined;
            }
            return {
                ...(msg as {
                    command: 'edit';
                    slot: string;
                    id: string;
                    label: string;
                    note?: string;
                    apiKey?: string;
                }),
                apiKey:
                    typeof msg.apiKey === 'string' && msg.apiKey.trim().length === 0 ?
                        undefined
                    :   (msg.apiKey as string | undefined)
            };
        case 'uploadSelected':
        case 'restore':
            return isSlotItemSelections(msg.selections) ? (msg as unknown as WebViewMessage) : undefined;
        case 'downloadWithPassphrase':
            return isValidString(msg.passphrase) ? (msg as unknown as WebViewMessage) : undefined;
        case 'applyActiveKeys':
            return isActiveKeyActions(msg.actions) ? (msg as unknown as WebViewMessage) : undefined;
        case 'applyRemoteConfigs':
            return isSlotItemSelections(msg.remove) ? (msg as unknown as WebViewMessage) : undefined;
        default:
            return undefined;
    }
}

/** ============= Panel 提供给各 Host 的门面接口 ============= */

/**
 * 各业务 Host（state/usage/crud/sync）通过此接口与 Panel 协作，
 * 避免直接持有 WebviewPanel 引用；方法的具体实现委托给对应 Host。
 */
export interface PanelContext {
    /** 向前端发消息 */
    post(msg: HostMessage): void;
    /** 重新构建并下发全部提供商状态 */
    sendStates(): Promise<void>;
    /** 异步刷新 CLI 提供商状态并下发 */
    refreshCliProviders(): Promise<void>;
    /** 刷新指定 CLI 提供商的余量并下发 */
    refreshCliUsage(provider: string): Promise<void>;
    /** 面板是否仍存活（webview 未被销毁） */
    isAlive(): boolean;
}
