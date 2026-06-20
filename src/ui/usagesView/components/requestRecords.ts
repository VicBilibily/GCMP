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
    getRequestKindDisplayName,
    summarizeSessionRecords,
    t,
    UNKNOWN_SESSION_ID
} from '../utils';

/**
 * 请求类型 → CSS class 映射
 */
const REQUEST_KIND_CSS_CLASS: Record<string, string> = {
    'main-agent': 'request-kind-main-agent',
    'terminal-steering': 'request-kind-terminal',
    'terminal-command': 'request-kind-terminal-cmd',
    'terminal-quickfix': 'request-kind-terminal-fix',
    'terminal-explain': 'request-kind-terminal-exp',
    'explain-code': 'request-kind-explain',
    'workspace-search': 'request-kind-search-ws',
    'code-search': 'request-kind-code-search',
    'vscode-qa': 'request-kind-vscode',
    'search-subagent': 'request-kind-search',
    'execution-subagent': 'request-kind-exec',
    'todo-tracker': 'request-kind-todo',
    'prompt-categorizer': 'request-kind-prompt',
    'intent-detector': 'request-kind-intent',
    'settings-resolver': 'request-kind-settings',
    'chat-title': 'request-kind-title',
    'inline-progress-message': 'request-kind-progress',
    'git-branch-name': 'request-kind-branch',
    'git-commit-message': 'request-kind-commit',
    'pr-description': 'request-kind-pr',
    'rename-suggestions': 'request-kind-rename',
    summarization: 'request-kind-summary',
    'code-mapper': 'request-kind-codemap',
    'feedback-gen': 'request-kind-feedback',
    'debug-config': 'request-kind-debug',
    'workspace-gen': 'request-kind-wsgen',
    'test-gen': 'request-kind-test',
    'goal-summary': 'request-kind-goal',
    'risk-assessment': 'request-kind-risk',
    background: 'request-kind-background',
    unknown: 'request-kind-unknown'
};

function getRequestKindCssClass(kind: string | undefined): string {
    return REQUEST_KIND_CSS_CLASS[kind || ''] || 'request-kind-unknown';
}

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

    const labelCell = createElement('td', 'records-total-empty');
    const emptyCell = createElement('td', 'records-total-empty');

    const inputCell = createElement('td');
    const totalInputTokens = totals.inputTokens;
    if (totals.cacheTokens > 0 && totalInputTokens > 0) {
        const ratio = ((totals.cacheTokens / totalInputTokens) * 100).toFixed(1);
        const miss = totalInputTokens - totals.cacheTokens;
        const ratioNum = parseFloat(ratio);
        const ratioClass =
            ratioNum >= 90 ? 'cache-ratio-high'
            : ratioNum >= 80 ? 'cache-ratio-mid'
            : ratioNum >= 60 ? 'cache-ratio-low'
            : 'cache-ratio-none';
        inputCell.innerHTML =
            `<div class="input-row"><span class="cache-ratio ${ratioClass}">${ratio}%</span><span class="input-total">${formatTokens(totalInputTokens)}</span></div>` +
            `<div class="input-detail"><span class="cache-amount">${formatTokens(totals.cacheTokens)}</span><span class="input-miss" title="${miss.toLocaleString('en-US')} miss">${formatTokens(miss)}</span></div>`;
    } else {
        inputCell.textContent = formatTokens(totalInputTokens);
    }
    if (totalInputTokens > 0) {
        inputCell.title = totalInputTokens.toLocaleString('en-US');
    }

    const outputCell = createElement('td');
    outputCell.innerHTML =
        `<div class="output-row"><span class="output-ttft">${totals.latencyValueText}</span><span class="output-tokens">${formatTokens(totals.outputTokens)}</span></div>` +
        `<div class="output-detail"><span class="output-tpot">${totals.durationValueText}</span><span class="output-speed">${totals.summary.avgSpeed ? `${totals.summary.avgSpeed.toFixed(1)} t/s` : '-'}</span></div>`;

    const totalCell = createElement('td', 'records-total-number');
    totalCell.textContent = formatTokens(totals.summary.totalTokens);
    if (totals.summary.totalTokens > 0) {
        totalCell.title = totals.summary.totalTokens.toLocaleString('en-US');
    }

    const statusCell = createElement('td', 'records-total-empty');

    row.append(labelCell, emptyCell, inputCell, outputCell, totalCell, statusCell);
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
        t('Provider & Model', '提供商模型'),
        t('<span>Cache</span><span>Input</span>', '<span>缓存命中</span><span>输入总计</span>'),
        t('<span>Duration</span><span>Output</span>', '<span>输出耗时</span><span>输出速度</span>'),
        t('Tokens', '令牌消耗'),
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
        const emptyCell = createElement('td', '', { colSpan: 6 });
        emptyCell.textContent = t('No request records yet', '暂无请求记录');
        emptyCell.style.textAlign = 'center';
        emptyRow.appendChild(emptyCell);
        tbody.appendChild(emptyRow);
        table.appendChild(tbody);
        return table;
    }

    records.forEach(record => {
        const row = createElement('tr');
        // 存储请求ID和状态，用于实时指标精确匹配
        if (record.requestId) {
            row.setAttribute('data-request-id', record.requestId);
        }
        row.setAttribute('data-request-status', record.status);

        const time = createElement('td');
        const timeStr = record.timestamp ? new Date(record.timestamp).toLocaleTimeString('zh-CN') : '-';
        const kindName = getRequestKindDisplayName(record.requestKind);
        if (record.requestKind) {
            time.title = kindName;
            const kindClass = getRequestKindCssClass(record.requestKind);
            time.innerHTML = `<div class="request-kind ${kindClass}">${kindName}</div><div class="request-time">${timeStr}</div>`;
        } else {
            time.textContent = timeStr;
        }

        const providerModel = createElement('td');
        const provName = getProviderDisplayName(record.providerKey, record.providerName) || '-';
        const modName = record.modelName || '-';
        providerModel.title = `${provName} · ${modName}`;
        providerModel.innerHTML = `<div class="prov-model-provider">${provName}</div><div class="prov-model-model">${modName}</div>`;

        const input = createElement('td', 'records-input-merged');
        const isCompleted = record.status === 'completed' && record.rawUsage && record.totalTokens > 0;
        const inputVal = isCompleted ? record.actualInput || 0 : record.estimatedInput || 0;
        const cacheVal = isCompleted && record.cacheReadTokens > 0 ? record.cacheReadTokens : 0;
        if (cacheVal > 0 && inputVal > 0) {
            const ratio = ((cacheVal / inputVal) * 100).toFixed(1);
            const miss = inputVal - cacheVal;
            const ratioNum = parseFloat(ratio);
            const ratioClass =
                ratioNum >= 90 ? 'cache-ratio-high'
                : ratioNum >= 80 ? 'cache-ratio-mid'
                : ratioNum >= 60 ? 'cache-ratio-low'
                : 'cache-ratio-none';
            input.innerHTML =
                `<div class="input-row"><span class="cache-ratio ${ratioClass}" title="${cacheVal.toLocaleString('en-US')} cacheReadTokens">${ratio}%</span><span class="input-total">${!isCompleted ? '~' : ''}${formatTokens(inputVal)}</span></div>` +
                `<div class="input-detail"><span class="cache-amount">${formatTokens(cacheVal)}</span><span class="input-miss" title="${miss.toLocaleString('en-US')} miss">${miss.toLocaleString('en-US')}</span></div>`;
        } else {
            input.textContent = inputVal > 0 ? `${!isCompleted ? '~' : ''}${formatTokens(inputVal)}` : '-';
        }
        if (inputVal > 0) {
            input.title = inputVal.toLocaleString('en-US');
        }

        // 合并输出列：上行 TTFT | 输出令牌，下行 TPOT | 输出速度
        const output = createElement('td', 'records-output-merged');
        output.setAttribute('data-metric', 'output');
        const outputVal = record.status === 'completed' && record.outputTokens > 0 ? record.outputTokens : 0;
        const ttft =
            (
                record.streamStartTime !== undefined &&
                record.timestamp !== undefined &&
                Number.isFinite(record.streamStartTime - record.timestamp) &&
                record.streamStartTime - record.timestamp >= 0
            ) ?
                record.streamStartTime - record.timestamp
            :   undefined;
        const speedVal = record.outputSpeed && record.outputSpeed > 0 ? record.outputSpeed : undefined;
        const tpot =
            record.streamDuration !== undefined && record.streamDuration > 0 ? record.streamDuration : undefined;

        if (ttft !== undefined || outputVal > 0) {
            const ttftText =
                ttft !== undefined ?
                    ttft >= 1000 ?
                        `${(ttft / 1000).toFixed(1)}s`
                    :   `${Math.round(ttft)}ms`
                :   '-';
            const tpotText =
                tpot !== undefined ?
                    tpot >= 1000 ?
                        `${(tpot / 1000).toFixed(1)}s`
                    :   `${Math.round(tpot)}ms`
                :   '-';
            const speedText = speedVal !== undefined ? `${speedVal.toFixed(1)} t/s` : '-';
            output.innerHTML =
                `<div class="output-row"><span class="output-ttft" title="TTFT: ${ttft !== undefined ? ttft.toLocaleString('en-US') + 'ms' : '-'}">${ttftText}</span><span class="output-tokens" title="Output tokens: ${outputVal.toLocaleString('en-US')}">${formatTokens(outputVal)}</span></div>` +
                `<div class="output-detail"><span class="output-tpot" title="TPOT: ${tpot !== undefined ? tpot.toLocaleString('en-US') + 'ms' : '-'}">${tpotText}</span><span class="output-speed" title="Speed: ${speedText}">${speedText}</span></div>`;
        } else {
            output.textContent = outputVal > 0 ? formatTokens(outputVal) : '-';
        }
        if (outputVal > 0) {
            output.title = outputVal.toLocaleString('en-US');
        }

        const total = createElement('td');
        const totalVal = record.status === 'completed' && record.totalTokens > 0 ? record.totalTokens : 0;
        total.textContent = totalVal > 0 ? formatTokens(record.totalTokens) : '-';
        if (totalVal > 0) {
            total.title = totalVal.toLocaleString('en-US');
        }

        const status = createElement('td');
        status.className =
            record.status === 'completed' ? 'status-completed'
            : record.status === 'failed' ? 'status-failed'
            : 'status-estimated';
        status.textContent =
            record.status === 'completed' ? '✅'
            : record.status === 'failed' ? '❌'
            : '⏳';

        row.append(time, providerModel, input, output, total, status);
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
