/*---------------------------------------------------------------------------------------------
 *  多 key 配额状态收集（故障切换/负载均衡模式）
 *  开启 Config Set 自动切换（failover/balance）且配置数 > 1 时，状态栏 tooltip
 *  展示槽位下全部配置的配额状态。本模块负责逐配置查询、结果身份校验与
 *  tooltip 片段生成。纯逻辑模块：不依赖 vscode / l10n / ConfigSetStore，
 *  数据源与本地化文案均由调用方注入，便于单元测试。
 *---------------------------------------------------------------------------------------------*/

import { createHash } from 'node:crypto';
import type { ConfigSetItem, ConfigSetSwitchMode } from '../utils/config/configSetStore';
import type { QuotaStatusAdapter, QuotaQueryContext } from '../quota/statusAdapters/types';
import type { QuotaTable } from '../quota/types';

/** 单配置配额状态条目 */
export interface MultiKeyEntry<TRaw> {
    /** 配置标识 */
    configId: string;
    /** 用户命名的配置名 */
    label: string;
    /** 配置项站点（支持站点切换的槽位使用） */
    site?: string;
    /** 是否为当前激活配置 */
    isActive: boolean;
    /** 查询所用 key 的指纹；身份校验用，防止迟到结果冒充替换后的 key */
    keyHash: string;
    status: 'success' | 'error' | 'missing-key' | 'stale';
    data?: TRaw;
    error?: string;
    timestamp: number;
}

/** 槽位全部配置的聚合状态（随主状态一起持久化/恢复） */
export interface MultiKeyStatusData<TRaw> {
    entries: MultiKeyEntry<TRaw>[];
    timestamp: number;
}

/** 槽位配置数据源（生产实现委托 ConfigSetStore；测试注入 fake） */
export interface MultiKeyConfigSource {
    list(): ConfigSetItem[];
    getActiveId(): string | undefined;
    getApiKey(configId: string): Promise<string | undefined>;
}

/** 激活项复用主查询结果（key 身份一致时避免重复请求） */
export interface ActiveEntryReuse<TRaw> {
    configId: string;
    keyHash: string;
    data: TRaw;
}

/** 收集选项 */
export interface CollectMultiKeyOptions<TRaw> {
    activeReuse?: ActiveEntryReuse<TRaw>;
}

/** 多 key tooltip 小节所需的本地化文案（由上层以 t() 生成后注入） */
export interface MultiKeySectionLabels {
    /** 列表表头：配置名列 */
    nameColumn: string;
    /** 列表表头：使用情况列（与状态栏 text 同口径） */
    usageColumn: string;
    /** 配置未配置 key 的提示 */
    notConfigured: string;
    /** 查询失败提示 */
    queryFailed: string;
    /** 结果过期（查询期间 key 被替换）提示 */
    staleResult: string;
}

/** 三态 + 配置数判定多 key 模式（纯函数便于测试） */
export function isMultiKeyModeImpl(mode: ConfigSetSwitchMode, itemCount: number): boolean {
    return mode !== 'off' && itemCount > 1;
}

/** key 指纹：身份校验用不可逆摘要 */
export function hashApiKey(apiKey: string): string {
    return createHash('sha256').update(apiKey).digest('hex').slice(0, 16);
}

async function queryEntry<TRaw>(
    source: MultiKeyConfigSource,
    adapter: QuotaStatusAdapter<TRaw>,
    item: ConfigSetItem,
    activeId: string | undefined,
    activeReuse: ActiveEntryReuse<TRaw> | undefined
): Promise<MultiKeyEntry<TRaw>> {
    const base: Omit<MultiKeyEntry<TRaw>, 'keyHash' | 'status'> = {
        configId: item.id,
        label: item.label,
        site: item.site,
        isActive: item.id === activeId,
        timestamp: Date.now()
    };

    const apiKey = await source.getApiKey(item.id);
    if (!apiKey) {
        return { ...base, keyHash: '', status: 'missing-key' };
    }
    const keyHash = hashApiKey(apiKey);

    // 激活项与主查询 key 身份一致时直接复用其结果，避免每周期重复请求激活 key
    if (activeReuse && item.id === activeReuse.configId && keyHash === activeReuse.keyHash) {
        return { ...base, keyHash, status: 'success', data: activeReuse.data };
    }

    try {
        const context: QuotaQueryContext | undefined = item.site ? { site: item.site } : undefined;
        const data = await adapter.query(apiKey, context);
        // 身份校验：查询期间该配置的 key 被替换/删除时，丢弃迟到结果
        const currentKey = await source.getApiKey(item.id);
        if (!currentKey || hashApiKey(currentKey) !== keyHash) {
            return { ...base, keyHash, status: 'stale' };
        }
        return { ...base, keyHash, status: 'success', data };
    } catch (error) {
        return { ...base, keyHash, status: 'error', error: error instanceof Error ? error.message : String(error) };
    }
}

/**
 * 收集槽位全部配置的配额状态。
 * 调用方需在调用前后自行判定 isMultiKeyModeImpl；本函数只按给定数据源执行。
 */
export async function collectMultiKeyStatus<TRaw>(
    source: MultiKeyConfigSource,
    adapter: QuotaStatusAdapter<TRaw>,
    options?: CollectMultiKeyOptions<TRaw>
): Promise<MultiKeyStatusData<TRaw>> {
    const items = source.list();
    const activeId = source.getActiveId();
    const entries = await Promise.all(
        items.map(item => queryEntry(source, adapter, item, activeId, options?.activeReuse))
    );
    return { entries, timestamp: Date.now() };
}

/** 渲染 quota 表格为 markdown 文本（与 providerQuotaStatusBar.appendQuotaTable 同规则） */
export function renderQuotaTable(table: QuotaTable): string {
    let md = `| ${table.columns.join(' | ')} |\n`;
    const alignOf = (i: number): string => {
        const a = table.align?.[i] ?? 'left';
        return (
            a === 'center' ? ':---:'
            : a === 'right' ? '---:'
            : ':---'
        );
    };
    md += `| ${table.columns.map((_, i) => alignOf(i)).join(' | ')} |\n`;
    const bold = new Set(table.boldColumns ?? []);
    for (const row of table.rows) {
        md += `| ${row.map((cell, i) => (bold.has(i) ? `**${cell}**` : cell)).join(' | ')} |\n`;
    }
    return md;
}

/**
 * 生成 tooltip 追加片段：全部配置的紧凑列表（markdown 表格：名称 + 使用情况）。
 * 使用情况列与状态栏 text 同口径（adapter.summary）；异常条目以占位文案显示；
 * 激活行的使用情况加粗突出。条目数 <= 1 时返回空串（无多 key 意义，调用方不追加）。
 */
export function renderMultiKeySections<TRaw>(
    status: MultiKeyStatusData<TRaw>,
    adapter: QuotaStatusAdapter<TRaw>,
    labels: MultiKeySectionLabels
): string {
    if (status.entries.length <= 1) {
        return '';
    }

    const usageOf = (entry: MultiKeyEntry<TRaw>): string => {
        if (entry.status === 'success' && entry.data !== undefined) {
            return adapter.summary(entry.data);
        }
        if (entry.status === 'missing-key') {
            return labels.notConfigured;
        }
        if (entry.status === 'stale') {
            return labels.staleResult;
        }
        return labels.queryFailed;
    };

    const rows = status.entries.map(entry => {
        const name = escapeTableText(entry.label);
        const usage = escapeTableText(usageOf(entry));
        return entry.isActive ? `| **${name}** | **${usage}** |` : `| ${name} | ${usage} |`;
    });

    return [
        `| ${escapeTableText(labels.nameColumn)} | ${escapeTableText(labels.usageColumn)} |\n`,
        '| :--- | :--- |\n',
        `${rows.join('\n')}\n`
    ].join('');
}

function escapeTableText(text: string): string {
    return text
        .replace(/\r\n|[\r\n]/g, ' ')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/[\\`*_{}[\]()#+.!|~]/g, '\\$&');
}
