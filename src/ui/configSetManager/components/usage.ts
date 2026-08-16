/*---------------------------------------------------------------------------------------------
 *  Config Set Manager - 用量/余额渲染
 *  renderUsageTables / renderConfigUsage / renderCliUsage / 合并状态工具
 *--------------------------------------------------------------------------------------------*/

import type {
    ConfigUsageTable,
    ConfigUsageState,
    SlotState,
    ConfigSetRow,
    CliProviderOption,
    CliUsageState
} from '../types';
import { el, t, state, getConfigMetricType, postToVSCode, clearMessage } from './state';

// ============= 表格单元格样式 =============

export function getUsageTableCellClass(columns: string[], columnIndex: number): string {
    const column = columns[columnIndex];
    if (column === t('Reset Time', '重置时间')) {
        return 'csm-slot-usage-table-cell-center';
    }
    return columnIndex === 0 ? 'csm-slot-usage-table-cell-label' : 'csm-slot-usage-table-cell-value';
}

// ============= 表格渲染 =============

export function renderUsageTables(tables: ConfigUsageTable[]): HTMLElement {
    const tablesWrap = el('div', 'csm-slot-usage-tables');
    for (const tableState of tables) {
        const section = el('div', 'csm-slot-usage-table-section');
        if (tableState.title) {
            section.appendChild(el('div', 'csm-slot-usage-table-title', tableState.title));
        }

        const table = el('table', 'csm-slot-usage-table') as HTMLTableElement;
        const thead = document.createElement('thead');
        const headRow = document.createElement('tr');
        tableState.columns.forEach((column, columnIndex) => {
            const th = document.createElement('th');
            th.className = getUsageTableCellClass(tableState.columns, columnIndex);
            th.textContent = column;
            headRow.appendChild(th);
        });
        thead.appendChild(headRow);
        table.appendChild(thead);

        const tbody = document.createElement('tbody');
        for (const rowValues of tableState.rows) {
            const tr = document.createElement('tr');
            rowValues.forEach((value, columnIndex) => {
                const td = document.createElement('td');
                td.className = getUsageTableCellClass(tableState.columns, columnIndex);
                td.textContent = value;
                tr.appendChild(td);
            });
            tbody.appendChild(tr);
        }
        table.appendChild(tbody);
        section.appendChild(table);
        tablesWrap.appendChild(section);
    }
    return tablesWrap;
}

// ============= 用量状态合并工具 =============

export function shouldPreserveUsageDisplay(previous: ConfigUsageState | undefined, next: ConfigUsageState): boolean {
    if (!previous || (!next.loading && !next.queued)) {
        return false;
    }

    return (
        next.summary === undefined &&
        next.tables === undefined &&
        next.usageEntries === undefined &&
        next.details === undefined &&
        next.error === undefined &&
        next.lastUpdated === undefined
    );
}

export function mergeConfigUsageState(
    previous: ConfigUsageState | undefined,
    next: ConfigUsageState
): ConfigUsageState {
    if (!shouldPreserveUsageDisplay(previous, next)) {
        return next;
    }

    const previousState = previous!;

    return {
        ...next,
        summary: previousState.summary,
        tables: previousState.tables,
        usageEntries: previousState.usageEntries,
        details: previousState.details,
        error: previousState.error,
        lastUpdated: previousState.lastUpdated
    };
}

/**
 * CLI 余量状态合并：刷新期间仅下发 { loading: true } 时，保留之前的展示数据。
 * 与 mergeConfigUsageState 同思路：next 只声明了 loading 而缺数据字段时，
 * 用 previous 的数据填充，避免刷新时已有数据闪掉。
 */
export function mergeCliUsageState(previous: CliUsageState | undefined, next: CliUsageState): CliUsageState {
    if (!previous || !next.loading) {
        return next;
    }
    const onlyLoading =
        next.summary === undefined &&
        next.table === undefined &&
        next.planType === undefined &&
        next.email === undefined &&
        next.error === undefined &&
        next.lastUpdated === undefined;
    if (!onlyLoading) {
        return next;
    }
    return {
        ...next,
        summary: previous.summary,
        table: previous.table,
        planType: previous.planType,
        email: previous.email,
        lastUpdated: previous.lastUpdated
    };
}

// ============= Slot 用量卡片 =============

export function renderConfigUsage(slotState: SlotState, row: ConfigSetRow, usageState: ConfigUsageState): HTMLElement {
    const metricType = getConfigMetricType(slotState.slot, usageState.metricType);
    const metricLabel = metricType === 'balance' ? t('Balance', '账号余额') : t('Remaining', '剩余');
    const summary =
        usageState.summary ??
        (usageState.loading ?
            metricType === 'balance' ?
                t('Loading balance data...', '正在加载余额数据...')
            :   t('Loading remaining data...', '正在加载剩余额度数据...')
        : usageState.queued ? t('Waiting to refresh in order...', '正在等待依次刷新...')
        : metricType === 'balance' ? t('No balance data available', '暂无余额数据')
        : t('No remaining data available', '暂无剩余额度数据'));
    const panel = el('div', 'csm-slot-usage csm-config-card-usage');
    const head = el('div', 'csm-slot-usage-head');
    const titleWrap = el('div', 'csm-slot-usage-titlewrap');
    titleWrap.appendChild(el('div', 'csm-slot-usage-title', metricLabel));
    titleWrap.appendChild(el('div', 'csm-slot-usage-summary', summary));
    head.appendChild(titleWrap);

    const actions = el('div', 'csm-slot-usage-actions');
    if (usageState.loading) {
        actions.appendChild(el('span', 'csm-slot-usage-loading', t('Refreshing...', '刷新中...')));
    } else if (usageState.queued) {
        actions.appendChild(el('span', 'csm-slot-usage-loading', t('Queued...', '排队中...')));
    }
    const refreshBtn = el('button', 'csm-btn csm-btn-sm', t('Refresh', '刷新'));
    refreshBtn.disabled = state.busy || usageState.loading;
    refreshBtn.addEventListener('click', () => {
        clearMessage();
        postToVSCode({ command: 'refreshConfigUsage', slot: slotState.slot, id: row.id });
    });
    actions.appendChild(refreshBtn);
    head.appendChild(actions);
    panel.appendChild(head);

    if (usageState.tables && usageState.tables.length > 0) {
        panel.appendChild(renderUsageTables(usageState.tables));
    }

    if (usageState.usageEntries && usageState.usageEntries.length > 0) {
        const entriesWrap = el('div', 'csm-slot-usage-entries');
        const singleEntry = usageState.usageEntries.length === 1;
        for (const entry of usageState.usageEntries) {
            const item = singleEntry ? entriesWrap : el('div', 'csm-slot-usage-entry');
            if (!singleEntry) {
                const entryHead = el('div', 'csm-slot-usage-entry-head');
                if (entry.label) {
                    entryHead.appendChild(el('div', 'csm-slot-usage-entry-label', entry.label));
                }
                entryHead.appendChild(el('div', 'csm-slot-usage-entry-summary', entry.summary));
                item.appendChild(entryHead);
            }

            if (entry.tables && entry.tables.length > 0) {
                item.appendChild(renderUsageTables(entry.tables));
            }

            if (!singleEntry) {
                entriesWrap.appendChild(item);
            }
        }
        panel.appendChild(entriesWrap);
    }

    if (usageState.error) {
        panel.appendChild(el('div', 'csm-slot-usage-error', usageState.error));
    }

    if (usageState.lastUpdated) {
        panel.appendChild(
            el('div', 'csm-slot-usage-meta', t('Last updated: {0}', '最后更新：{0}', usageState.lastUpdated))
        );
    }

    return panel;
}

// ============= CLI 余量区块 =============

export function renderCliUsage(cli: CliProviderOption): HTMLElement {
    const usage = cli.usage!;
    const panel = el('div', 'csm-slot-usage csm-config-card-usage');

    const head = el('div', 'csm-slot-usage-head');
    const titleWrap = el('div', 'csm-slot-usage-titlewrap');
    titleWrap.appendChild(el('div', 'csm-slot-usage-title', t('Usage Quota', '用量额度')));
    if (usage.summary) {
        titleWrap.appendChild(el('div', 'csm-slot-usage-summary', usage.summary));
    }
    head.appendChild(titleWrap);

    const actions = el('div', 'csm-slot-usage-actions');
    if (usage.loading) {
        actions.appendChild(el('span', 'csm-slot-usage-loading', t('Refreshing...', '刷新中...')));
    }
    const refreshBtn = el('button', 'csm-btn csm-btn-sm', t('Refresh', '刷新'));
    refreshBtn.disabled = state.busy || usage.loading;
    refreshBtn.addEventListener('click', () => {
        clearMessage();
        postToVSCode({ command: 'refreshCliUsage', provider: cli.provider });
    });
    actions.appendChild(refreshBtn);
    head.appendChild(actions);
    panel.appendChild(head);

    if (usage.table) {
        panel.appendChild(renderUsageTables([usage.table]));
    }

    if (usage.error) {
        panel.appendChild(el('div', 'csm-slot-usage-error', usage.error));
    }

    if (usage.lastUpdated) {
        panel.appendChild(el('div', 'csm-slot-usage-meta', t('Last updated: {0}', '最后更新：{0}', usage.lastUpdated)));
    }

    return panel;
}
