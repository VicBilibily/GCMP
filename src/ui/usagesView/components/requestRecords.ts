/**
 * 请求记录组件
 * 负责渲染请求记录会话分栏与详情表格
 */

import type { ExtendedTokenRequestLog, SessionGroup, SessionSummary } from '../types';
import { createElement } from '../../utils';
import { createSessionFilter, shouldShowSessionGroupInFilter } from './sessionFilter';
import {
    formatSessionTimeRange,
    formatTokens,
    getProviderDisplayName,
    summarizeSessionRecords,
    t,
    UNKNOWN_SESSION_ID
} from '../utils';

const PAGE_SIZE = 20;

let currentPage = 1;
let isSessionPopoverOpen = false;

/**
 * 获取当前日期详情中的会话分组列表
 */
function getCurrentSessionGroups(): SessionGroup[] {
    return window.usagesState?.dateDetails?.sessionGroups || [];
}

/**
 * 按时间倒序排列请求记录
 */
function sortRecords(records: ExtendedTokenRequestLog[]): ExtendedTokenRequestLog[] {
    return [...records].sort((a, b) => b.timestamp - a.timestamp);
}

/**
 * 合并全部会话记录，用于“全部会话”视图
 */
function getAllRecords(sessionGroups: SessionGroup[]): ExtendedTokenRequestLog[] {
    return sortRecords(sessionGroups.flatMap(group => group.records));
}

/**
 * 汇总全部会话记录的统计信息
 */
function buildAllSessionsSummary(records: ExtendedTokenRequestLog[]): SessionSummary {
    return summarizeSessionRecords(records);
}

/**
 * 基于当前状态重新渲染请求记录区域
 */
function rerenderRequestRecords(): void {
    const recordsContainer = document.querySelector('#records-container') as HTMLElement | null;
    if (!recordsContainer) {
        return;
    }

    createRequestRecordsSection(getCurrentSessionGroups(), currentPage, recordsContainer);
}

/**
 * 切换窄屏会话浮窗的显示状态
 */
function toggleSessionPopover(show?: boolean): void {
    isSessionPopoverOpen = show ?? !isSessionPopoverOpen;
    rerenderRequestRecords();
}

/**
 * 切换当前选中的会话，并回到该会话的第一页
 */
function changeSelectedSession(sessionId: string | null): void {
    if (!window.usagesState) {
        return;
    }

    window.usagesState.selectedSessionId = sessionId;
    isSessionPopoverOpen = false;
    currentPage = 1;
    rerenderRequestRecords();
}

/**
 * 更新当前分页并重新渲染
 */
function changePage(page: number): void {
    currentPage = page;
    rerenderRequestRecords();
}

/**
 * 创建分页控件
 */
function createPagination(page: number, totalPages: number, totalItems: number): HTMLElement {
    const container = createElement('div', 'pagination');

    const prevBtn = createElement('button') as HTMLButtonElement;
    prevBtn.textContent = t('Previous', '上一页');
    prevBtn.disabled = page <= 1;
    prevBtn.onclick = () => page > 1 && changePage(page - 1);
    container.appendChild(prevBtn);

    const firstPageBtn = createElement('button') as HTMLButtonElement;
    firstPageBtn.textContent = '1';
    firstPageBtn.className = `page-number${page === 1 ? ' active' : ''}`;
    firstPageBtn.onclick = () => page !== 1 && changePage(1);
    container.appendChild(firstPageBtn);

    const maxPages = 5;
    let startPage = Math.max(2, page - Math.floor(maxPages / 2));
    const endPage = Math.min(totalPages - 1, startPage + maxPages - 1);
    if (endPage - startPage < maxPages - 1) {
        startPage = Math.max(2, endPage - maxPages + 1);
    }

    if (startPage > 2) {
        const ellipsis = createElement('span');
        ellipsis.textContent = '...';
        container.appendChild(ellipsis);
    }

    for (let i = startPage; i <= endPage; i++) {
        const pageBtn = createElement('button') as HTMLButtonElement;
        pageBtn.textContent = String(i);
        pageBtn.className = `page-number${i === page ? ' active' : ''}`;
        pageBtn.onclick = () => i !== page && changePage(i);
        container.appendChild(pageBtn);
    }

    if (endPage < totalPages - 1) {
        const ellipsis = createElement('span');
        ellipsis.textContent = '...';
        container.appendChild(ellipsis);
    }

    if (totalPages > 1) {
        const lastPageBtn = createElement('button') as HTMLButtonElement;
        lastPageBtn.textContent = String(totalPages);
        lastPageBtn.className = `page-number${page === totalPages ? ' active' : ''}`;
        lastPageBtn.onclick = () => page !== totalPages && changePage(totalPages);
        container.appendChild(lastPageBtn);
    }

    const nextBtn = createElement('button') as HTMLButtonElement;
    nextBtn.textContent = t('Next', '下一页');
    nextBtn.disabled = page >= totalPages;
    nextBtn.onclick = () => page < totalPages && changePage(page + 1);
    container.appendChild(nextBtn);

    const info = createElement('span', 'pagination-info');
    const start = (page - 1) * PAGE_SIZE + 1;
    const end = Math.min(page * PAGE_SIZE, totalItems);
    info.textContent = `${start}-${end} / ${totalItems}`;
    container.appendChild(info);

    return container;
}

/**
 * 创建会话摘要标签
 */
function createSummaryChip(label: string, value: string, title?: string): HTMLElement {
    const chip = createElement('span', 'session-summary-chip');
    chip.textContent = `${label}: ${value}`;
    if (title) {
        chip.title = title;
    }
    return chip;
}

/**
 * 创建右侧详情头部的会话摘要区域
 */
function createSummarySection(summary: SessionSummary): HTMLElement {
    const summaryEl = createElement('div', 'session-detail-summary');
    const avgSpeedText = summary.avgSpeed ? `${summary.avgSpeed.toFixed(1)} t/s` : '-';
    const timeRange = formatSessionTimeRange(summary.startTime, summary.endTime);

    summaryEl.appendChild(createSummaryChip(t('Tokens', 'Tokens'), formatTokens(summary.totalTokens)));
    summaryEl.appendChild(createSummaryChip(t('Time', '时间'), timeRange, timeRange));
    summaryEl.appendChild(createSummaryChip(t('Avg Speed', '平均速度'), avgSpeedText));

    return summaryEl;
}

/**
 * 将毫秒时长格式化为毫秒或秒文本
 */
function formatDuration(milliseconds: number): string {
    return milliseconds >= 1000 ? `${(milliseconds / 1000).toFixed(1)}s` : `${Math.round(milliseconds)}ms`;
}

/**
 * 统计当前表格对应记录的合计数据
 */
function buildRequestTotals(records: ExtendedTokenRequestLog[]): {
    summary: SessionSummary;
    inputTokens: number;
    cacheTokens: number;
    outputTokens: number;
    latencyValueText: string;
    durationValueText: string;
} {
    let inputTokens = 0;
    let cacheTokens = 0;
    let outputTokens = 0;
    const latencies: number[] = [];
    const durations: number[] = [];

    records.forEach(record => {
        inputTokens +=
            record.status === 'completed' && record.rawUsage && record.totalTokens > 0 ?
                Math.max(record.actualInput || 0, 0)
            :   Math.max(record.estimatedInput || 0, 0);
        cacheTokens += Math.max(record.cacheReadTokens || 0, 0);
        outputTokens += Math.max(record.outputTokens || 0, 0);

        if (record.streamDuration !== undefined && record.streamDuration > 0) {
            durations.push(record.streamDuration);
        }

        if (record.streamStartTime !== undefined && record.timestamp !== undefined) {
            const latency = record.streamStartTime - record.timestamp;
            if (Number.isFinite(latency) && latency >= 0) {
                latencies.push(latency);
            }
        }
    });

    const avgLatency = latencies.length > 0 ? latencies.reduce((sum, value) => sum + value, 0) / latencies.length : 0;
    const avgDuration = durations.length > 0 ? durations.reduce((sum, value) => sum + value, 0) / durations.length : 0;

    return {
        summary: summarizeSessionRecords(records),
        inputTokens,
        cacheTokens,
        outputTokens,
        latencyValueText: avgLatency > 0 ? formatDuration(avgLatency) : '-',
        durationValueText: avgDuration > 0 ? formatDuration(avgDuration) : '-'
    };
}

/**
 * 在表格底部追加合计行
 */
function appendTotalsRow(tbody: HTMLElement, summaryRecords: ExtendedTokenRequestLog[]): void {
    const totals = buildRequestTotals(summaryRecords);
    const row = createElement('tr', 'records-total-row');

    const labelCell = createElement('td', 'records-total-label') as HTMLTableCellElement;
    labelCell.colSpan = 3;

    const inputCell = createElement('td', 'records-total-number');
    inputCell.textContent = formatTokens(totals.inputTokens);

    const cacheCell = createElement('td', 'records-total-number');
    cacheCell.textContent = formatTokens(totals.cacheTokens);

    const outputCell = createElement('td', 'records-total-number');
    outputCell.textContent = formatTokens(totals.outputTokens);

    const totalCell = createElement('td', 'records-total-number');
    totalCell.textContent = formatTokens(totals.summary.totalTokens);

    const latencyCell = createElement('td', 'records-total-number');
    const latencyValue = createElement('span');
    latencyValue.textContent = totals.latencyValueText;
    const durationValue = createElement('span');
    durationValue.textContent = totals.durationValueText;
    latencyCell.append(latencyValue, ' + ', durationValue);

    const speedCell = createElement('td', 'records-total-number');
    speedCell.textContent = totals.summary.avgSpeed ? `${totals.summary.avgSpeed.toFixed(1)} t/s` : '-';

    const statusCell = createElement('td', 'records-total-empty');

    row.append(labelCell, inputCell, cacheCell, outputCell, totalCell, latencyCell, speedCell, statusCell);
    tbody.appendChild(row);
}

/**
 * 创建请求记录表格，并在底部展示当前会话/全部会话的汇总行
 */
function createRequestRecordsTable(
    records: ExtendedTokenRequestLog[],
    summaryRecords: ExtendedTokenRequestLog[]
): HTMLElement {
    const table = createElement('table', 'records-table');
    const thead = createElement('thead');
    const headerRow = createElement('tr');
    const headers = [
        t('Time', '时间'),
        t('Provider', '提供商'),
        t('Model', '模型'),
        t('Input', '输入令牌'),
        t('Cache', '缓存命中'),
        t('Output', '输出令牌'),
        t('Tokens', '消耗令牌'),
        t('<span>TTFT</span> + <span>TPOT</span>', '首令延迟 + 输出耗时'),
        t('Speed', '输出速度'),
        t('Status', '状态')
    ];

    headers.forEach(header => {
        const th = createElement('th');
        th.innerHTML = header;
        headerRow.appendChild(th);
    });
    thead.appendChild(headerRow);
    table.appendChild(thead);

    const tbody = createElement('tbody');
    if (records.length === 0) {
        const emptyRow = createElement('tr');
        const emptyCell = createElement('td', '', { colSpan: 10 });
        emptyCell.textContent = t('No request records yet', '暂无请求记录');
        emptyCell.style.textAlign = 'center';
        emptyRow.appendChild(emptyCell);
        tbody.appendChild(emptyRow);
        table.appendChild(tbody);
        return table;
    }

    records.forEach(record => {
        const row = createElement('tr');
        const time = createElement('td');
        time.textContent = record.timestamp ? new Date(record.timestamp).toLocaleTimeString('zh-CN') : '-';

        const provider = createElement('td');
        provider.textContent = getProviderDisplayName(record.providerKey, record.providerName) || '-';

        const model = createElement('td');
        model.textContent = record.modelName || '-';

        const input = createElement('td');
        input.textContent =
            record.status === 'completed' && record.rawUsage && record.totalTokens > 0 ?
                formatTokens(record.actualInput)
            : record.estimatedInput && record.estimatedInput > 0 ? `~${formatTokens(record.estimatedInput)}`
            : '-';

        const cache = createElement('td');
        cache.textContent =
            record.status === 'completed' && record.cacheReadTokens > 0 ? formatTokens(record.cacheReadTokens) : '-';

        const output = createElement('td');
        output.textContent =
            record.status === 'completed' && record.outputTokens > 0 ? formatTokens(record.outputTokens) : '-';

        const total = createElement('td');
        total.textContent =
            record.status === 'completed' && record.totalTokens > 0 ? formatTokens(record.totalTokens) : '-';

        const firstTokenLatency = createElement('td');
        if (record.streamDuration !== undefined && record.streamDuration > 0) {
            const duration =
                record.streamDuration >= 1000 ?
                    `<span>${(record.streamDuration / 1000).toFixed(1)}s</span>`
                :   `<span>${Math.round(record.streamDuration)}ms</span>`;

            if (record.streamStartTime !== undefined && record.timestamp !== undefined) {
                const latency = record.streamStartTime - record.timestamp;
                if (Number.isFinite(latency) && latency >= 0) {
                    const latencyText =
                        latency >= 1000 ?
                            `<span>${(latency / 1000).toFixed(1)}s</span>`
                        :   `<span>${Math.round(latency)}ms</span>`;
                    firstTokenLatency.innerHTML = `${latencyText} + ${duration}`;
                } else {
                    firstTokenLatency.innerHTML = `- + ${duration}`;
                }
            } else {
                firstTokenLatency.innerHTML = `- + ${duration}`;
            }
        } else {
            firstTokenLatency.textContent = '-';
        }

        const speed = createElement('td');
        speed.textContent = record.outputSpeed && record.outputSpeed > 0 ? `${record.outputSpeed.toFixed(1)} t/s` : '-';

        const status = createElement('td');
        status.className =
            record.status === 'completed' ? 'status-completed'
            : record.status === 'failed' ? 'status-failed'
            : 'status-estimated';
        status.textContent =
            record.status === 'completed' ? '✅'
            : record.status === 'failed' ? '❌'
            : '⏳';

        row.append(time, provider, model, input, cache, output, total, firstTokenLatency, speed, status);
        tbody.appendChild(row);
    });

    appendTotalsRow(tbody, summaryRecords);

    table.appendChild(tbody);
    return table;
}

/**
 * 创建窄屏下位于请求记录区域右上角的会话选择按钮
 */
function createSessionToggleButton(): HTMLElement {
    const sessionToggle = createElement('button', 'secondary session-filter-toggle') as HTMLButtonElement;
    const icon = createElement('span', 'toggle-icon');
    icon.textContent = isSessionPopoverOpen ? '◀' : '☰';
    const label = isSessionPopoverOpen ? t('Collapse List', '收起列表') : t('Session List', '会话列表');
    sessionToggle.append(icon, label);
    sessionToggle.onclick = () => toggleSessionPopover();
    return sessionToggle;
}

/**
 * 创建右侧详情头部，包括标题、副标题和摘要信息
 */
function createDetailHeader(titleText: string, summary: SessionSummary): HTMLElement {
    const header = createElement('div', 'session-detail-header');
    const titleRow = createElement('div', 'session-detail-title-row');
    const title = createElement('h3', 'session-detail-title');
    title.textContent = titleText;
    titleRow.appendChild(title);
    titleRow.appendChild(createSummarySection(summary));

    header.appendChild(titleRow);
    return header;
}

/**
 * 创建窄屏会话选择浮窗
 */
function createSessionPopover(
    sessionGroups: SessionGroup[],
    selectedSessionId: string | null,
    onChange: (sessionId: string | null) => void
): HTMLElement {
    const popover = createElement('div', 'session-filter-popover');
    if (isSessionPopoverOpen) {
        popover.classList.add('open');
    }

    const backdrop = createElement('button', 'session-filter-popover-backdrop') as HTMLButtonElement;
    backdrop.type = 'button';
    backdrop.setAttribute('aria-label', t('Close session selector', '关闭会话选择'));
    backdrop.onclick = () => toggleSessionPopover(false);

    const panel = createElement('div', 'session-filter-popover-panel');
    panel.appendChild(createSessionFilter(sessionGroups, selectedSessionId, onChange));

    popover.appendChild(backdrop);
    popover.appendChild(panel);
    return popover;
}

/**
 * 创建右侧详情区，包含摘要、分页和请求表格
 */
function createDetailView(titleText: string, summary: SessionSummary, records: ExtendedTokenRequestLog[]): HTMLElement {
    const detail = createElement('div', 'records-detail');
    detail.appendChild(createDetailHeader(titleText, summary));

    const content = createElement('div', 'records-detail-content');

    const totalPages = Math.ceil(records.length / PAGE_SIZE) || 1;
    currentPage = Math.min(currentPage, totalPages);

    if (records.length > PAGE_SIZE) {
        content.appendChild(createPagination(currentPage, totalPages, records.length));
    }

    const startIndex = (currentPage - 1) * PAGE_SIZE;
    content.appendChild(createRequestRecordsTable(records.slice(startIndex, startIndex + PAGE_SIZE), records));

    if (records.length > PAGE_SIZE) {
        content.appendChild(createPagination(currentPage, totalPages, records.length));
    }

    detail.appendChild(content);

    return detail;
}

/**
 * 重置请求记录区域的内部分页状态
 */
export function resetRequestRecordsState(): void {
    currentPage = 1;
    isSessionPopoverOpen = false;
}

/**
 * 创建请求记录主区域：左侧会话列表，右侧会话详情
 */
export function createRequestRecordsSection(
    sessionGroups: SessionGroup[],
    page?: number,
    existingContainer?: HTMLElement
): HTMLElement {
    if (page !== undefined) {
        currentPage = page;
    }

    const container = existingContainer || createElement('div', '', { id: 'records-container' });
    container.id = 'records-container';
    container.innerHTML = '';

    const layout = createElement('div', 'records-layout');
    const rawSelectedSessionId = window.usagesState?.selectedSessionId || null;
    const selectedSessionId = rawSelectedSessionId === UNKNOWN_SESSION_ID ? null : rawSelectedSessionId;
    const visibleSessionGroups = sessionGroups.filter(shouldShowSessionGroupInFilter);
    const hasVisibleSessionGroups = visibleSessionGroups.length > 0;
    const allRecords = getAllRecords(sessionGroups);
    const selectedGroup =
        selectedSessionId ? visibleSessionGroups.find(group => group.sessionId === selectedSessionId) : undefined;

    if (hasVisibleSessionGroups) {
        layout.appendChild(createSessionFilter(sessionGroups, selectedGroup?.sessionId || null, changeSelectedSession));
        layout.appendChild(createSessionToggleButton());
        layout.appendChild(
            createSessionPopover(sessionGroups, selectedGroup?.sessionId || null, changeSelectedSession)
        );
    }

    if (selectedGroup) {
        layout.appendChild(
            createDetailView(`#${selectedGroup.displayId}`, selectedGroup.summary, selectedGroup.records)
        );
    } else if (allRecords.length > 0) {
        layout.appendChild(
            createDetailView(t('All Sessions', '全部会话'), buildAllSessionsSummary(allRecords), allRecords)
        );
    } else {
        const detail = createElement('div', 'records-detail');
        const empty = createElement('div', 'empty-message');
        empty.textContent = t('No request records yet', '暂无请求记录');
        detail.appendChild(empty);
        layout.appendChild(detail);
    }

    container.appendChild(layout);
    return container;
}
