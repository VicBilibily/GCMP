/**
 * 请求记录组件
 * 负责渲染请求记录会话分栏与详情表格
 */

import type { ExtendedTokenRequestLog, RequestTotals, SessionGroup, SessionSummary } from '../types';
import { createElement } from '../../utils';
import { getDisplayCostPresentation } from '../../costDisplay';
import { createSessionFilter, shouldShowSessionGroupInFilter } from './sessionFilter';
import {
    buildRequestTotals,
    formatSessionTimeRange,
    formatTokens,
    getRecordNativeCostSplit,
    getCurrencyToggleTitle,
    getDisplayCurrency,
    getProviderDisplayName,
    getRequestKindDisplayName,
    getSessionDisplayId,
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
const REQUEST_COST_SPAN_SELECTOR = '[data-request-cost="true"]';

let currentPage = 1;
let isSessionPopoverOpen = false;

interface RequestCostPresentationData {
    usd?: number;
    rmb?: number;
    nativeUsd?: number;
    nativeRmb?: number;
    fixedDecimals?: number;
}

/**
 * 获取当前日期详情中的会话分组列表
 */
function getCurrentSessionGroups(): SessionGroup[] {
    return window.usagesState?.dateDetails?.sessionGroups || [];
}

/**
 * 获取当前日期详情缓存
 */
function getCurrentDateDetails(): typeof window.usagesState.dateDetails | null {
    return window.usagesState?.dateDetails || null;
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
    const statusBreakdown = `✅ ${summary.completedCount} / ❌ ${summary.failedCount} / 🚫 ${summary.cancelledCount}`;

    summaryEl.appendChild(createSummaryChip(t('Tokens', 'Tokens'), formatTokens(summary.totalTokens)));
    summaryEl.appendChild(createSummaryChip(t('Time', '时间'), timeRange, timeRange));
    summaryEl.appendChild(createSummaryChip(t('Avg Speed', '平均速度'), avgSpeedText));
    summaryEl.appendChild(createSummaryChip(t('Status', '状态'), statusBreakdown));

    return summaryEl;
}

/**
 * 将毫秒时长格式化为毫秒或秒文本
 */
function formatDuration(milliseconds: number): string {
    return milliseconds >= 1000 ? `${(milliseconds / 1000).toFixed(1)}s` : `${Math.round(milliseconds)}ms`;
}

function setNumericDataAttribute(element: HTMLElement, key: string, value: number | undefined): void {
    if (value === undefined || !Number.isFinite(value)) {
        delete element.dataset[key];
        return;
    }
    element.dataset[key] = String(value);
}

function readNumericDataAttribute(element: HTMLElement, key: string): number | undefined {
    const raw = element.dataset[key];
    if (raw === undefined) {
        return undefined;
    }
    const parsed = Number(raw);
    return Number.isFinite(parsed) ? parsed : undefined;
}

function applyRequestCostPresentation(
    element: HTMLElement,
    data: RequestCostPresentationData,
    currency: ReturnType<typeof getDisplayCurrency>
): void {
    const presentation = getDisplayCostPresentation({
        usd: data.usd,
        rmb: data.rmb,
        nativeUsd: data.nativeUsd,
        nativeRmb: data.nativeRmb,
        currency,
        fixedDecimals: data.fixedDecimals
    });

    element.textContent = presentation.text;
    element.title = getCurrencyToggleTitle(currency);
    element.className = 'tokens-cost';
    element.dataset.toggleCostCurrency = 'true';
}

function createRequestCostSpan(data: RequestCostPresentationData): HTMLElement {
    const element = createElement('span');
    element.dataset.requestCost = 'true';
    setNumericDataAttribute(element, 'usd', data.usd);
    setNumericDataAttribute(element, 'rmb', data.rmb);
    setNumericDataAttribute(element, 'nativeUsd', data.nativeUsd);
    setNumericDataAttribute(element, 'nativeRmb', data.nativeRmb);
    setNumericDataAttribute(element, 'fixedDecimals', data.fixedDecimals);
    applyRequestCostPresentation(element, data, getDisplayCurrency());
    return element;
}

function readRequestCostPresentationData(element: HTMLElement): RequestCostPresentationData {
    return {
        usd: readNumericDataAttribute(element, 'usd'),
        rmb: readNumericDataAttribute(element, 'rmb'),
        nativeUsd: readNumericDataAttribute(element, 'nativeUsd'),
        nativeRmb: readNumericDataAttribute(element, 'nativeRmb'),
        fixedDecimals: readNumericDataAttribute(element, 'fixedDecimals')
    };
}

export function refreshRequestRecordCosts(container?: ParentNode): void {
    const root = container ?? document.querySelector('#records-container');
    if (!root) {
        return;
    }

    const currency = getDisplayCurrency();
    root.querySelectorAll<HTMLElement>(REQUEST_COST_SPAN_SELECTOR).forEach(element => {
        applyRequestCostPresentation(element, readRequestCostPresentationData(element), currency);
    });
}

/**
 * 在表格底部追加合计行
 */
function appendTotalsRow(
    tbody: HTMLElement,
    summary: SessionSummary,
    totals: RequestTotals,
    currency: ReturnType<typeof getDisplayCurrency>
): void {
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
    const latencyValueText = totals.avgLatency && totals.avgLatency > 0 ? formatDuration(totals.avgLatency) : '-';
    const durationValueText = totals.avgDuration && totals.avgDuration > 0 ? formatDuration(totals.avgDuration) : '-';
    outputCell.innerHTML =
        `<div class="output-row"><span class="output-ttft">${latencyValueText}</span><span class="output-tokens">${formatTokens(totals.outputTokens)}</span></div>` +
        `<div class="output-detail"><span class="output-tpot">${durationValueText}</span><span class="output-speed">${summary.avgSpeed ? `${summary.avgSpeed.toFixed(1)} t/s` : '-'}</span></div>`;

    const totalCell = createElement('td', 'records-total-number');
    const totalTokenStr = formatTokens(summary.totalTokens);
    const totalCostPresentation = getDisplayCostPresentation({
        usd: totals.totalCost,
        rmb: totals.totalCostRmb,
        nativeUsd: totals.nativeCosts.totalUsd,
        nativeRmb: totals.nativeCosts.totalRmb,
        currency,
        fixedDecimals: 2
    });
    const totalCostStr = totalCostPresentation.text;
    if (totalCostStr) {
        const costSpan = createRequestCostSpan({
            usd: totals.totalCost,
            rmb: totals.totalCostRmb,
            nativeUsd: totals.nativeCosts.totalUsd,
            nativeRmb: totals.nativeCosts.totalRmb,
            fixedDecimals: 2
        });
        const tokensRow = createElement('div', 'tokens-row');
        tokensRow.textContent = totalTokenStr;
        const tokensDetail = createElement('div', 'tokens-detail');
        tokensDetail.appendChild(costSpan);
        totalCell.append(tokensRow, tokensDetail);
    } else {
        totalCell.textContent = totalTokenStr;
    }
    if (summary.totalTokens > 0) {
        totalCell.title = summary.totalTokens.toLocaleString('en-US');
    }

    const statusCell = createElement('td', 'records-total-empty');

    row.append(labelCell, emptyCell, inputCell, outputCell, totalCell, statusCell);
    tbody.appendChild(row);
}

/**
 * 创建请求记录表格，并在底部展示当前会话/全部会话的汇总行
 * 同时被 createRequestRecordsSection 和 app.ts 的实时指标占位逻辑复用
 */
export function createRequestRecordsTable(
    records: ExtendedTokenRequestLog[],
    summary: SessionSummary,
    totals: RequestTotals,
    visibleSessionIds: Set<string>
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

    const currency = getDisplayCurrency();

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
        const providerDiv = createElement('div', 'prov-model-provider');
        providerDiv.textContent = provName;
        const modelDiv = createElement('div', 'prov-model-model');
        modelDiv.textContent = modName;
        providerModel.append(providerDiv, modelDiv);

        const input = createElement('td', 'records-input-merged');
        const hasActualUsage =
            (record.status === 'completed' || record.status === 'cancelled') &&
            !!record.rawUsage &&
            record.totalTokens > 0;
        const inputVal = hasActualUsage ? record.actualInput || 0 : record.estimatedInput || 0;
        const cacheVal = hasActualUsage && record.cacheReadTokens > 0 ? record.cacheReadTokens : 0;

        // 增量预估模式：显示 预估总值 / +本次新增
        if (
            !hasActualUsage &&
            record.estimatedIncrement !== undefined &&
            record.estimatedIncrement > 0 &&
            inputVal > 0
        ) {
            const increment = record.estimatedIncrement;
            const totalFormatted = formatTokens(inputVal);
            const incrementFormatted = increment.toLocaleString('en-US');
            const totalTitle = `~${inputVal.toLocaleString('en-US')} input tokens (estimated)`;
            const incrementTitle = `+${increment.toLocaleString('en-US')} tokens (this request)`;
            input.innerHTML =
                `<div class="input-row"><span></span><span class="input-total" title="${totalTitle}">~${totalFormatted}</span></div>` +
                `<div class="input-detail"><span></span><span class="input-increment" title="${incrementTitle}">~${incrementFormatted}</span></div>`;
        } else if (cacheVal > 0 && inputVal > 0) {
            const ratio = ((cacheVal / inputVal) * 100).toFixed(1);
            const miss = inputVal - cacheVal;
            const ratioNum = parseFloat(ratio);
            const ratioClass =
                ratioNum >= 90 ? 'cache-ratio-high'
                : ratioNum >= 80 ? 'cache-ratio-mid'
                : ratioNum >= 60 ? 'cache-ratio-low'
                : 'cache-ratio-none';
            const inputPrefix = !hasActualUsage ? '~' : '';
            const formattedInput = `${inputPrefix}${formatTokens(inputVal)}`;
            const formattedCache = formatTokens(cacheVal);
            const formattedMiss = miss.toLocaleString('en-US');
            const totalInputTitle = `${inputPrefix}${inputVal.toLocaleString('en-US')} input tokens`;
            const cacheAmountTitle = `${cacheVal.toLocaleString('en-US')} cacheReadTokens`;
            const missTitle = `${formattedMiss} miss`;
            const inputRowHtml =
                '<div class="input-row">' +
                `<span class="cache-ratio ${ratioClass}" title="${cacheAmountTitle}">${ratio}%</span>` +
                `<span class="input-total" title="${totalInputTitle}">${formattedInput}</span>` +
                '</div>';
            const inputDetailHtml =
                '<div class="input-detail">' +
                `<span class="cache-amount" title="${cacheAmountTitle}">${formattedCache}</span>` +
                `<span class="input-miss" title="${missTitle}">${formattedMiss}</span>` +
                '</div>';
            input.innerHTML = inputRowHtml + inputDetailHtml;
        } else {
            input.textContent = inputVal > 0 ? `${!hasActualUsage ? '~' : ''}${formatTokens(inputVal)}` : '-';
            if (inputVal > 0) {
                input.title = `${!hasActualUsage ? '~' : ''}${inputVal.toLocaleString('en-US')} input tokens`;
            }
        }

        // 合并输出列：上行 TTFT | 输出令牌，下行 TPOT | 输出速度
        const output = createElement('td', 'records-output-merged');
        output.setAttribute('data-metric', 'output');
        const outputVal = hasActualUsage && record.outputTokens > 0 ? record.outputTokens : 0;
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
        const outputTokensText = outputVal > 0 ? formatTokens(outputVal) : '-';
        const ttftTitle = `TTFT: ${ttft !== undefined ? ttft.toLocaleString('en-US') + 'ms' : '-'}`;
        const outputTokensTitle = `Output tokens: ${outputVal > 0 ? outputVal.toLocaleString('en-US') : '-'}`;
        const tpotTitle = `TPOT: ${tpot !== undefined ? tpot.toLocaleString('en-US') + 'ms' : '-'}`;
        const speedTitle = `Speed: ${speedText}`;
        const outputRowHtml =
            '<div class="output-row">' +
            `<span class="output-ttft" title="${ttftTitle}">${ttftText}</span>` +
            `<span class="output-tokens" title="${outputTokensTitle}">${outputTokensText}</span>` +
            '</div>';
        const outputDetailHtml =
            '<div class="output-detail">' +
            `<span class="output-tpot" title="${tpotTitle}">${tpotText}</span>` +
            `<span class="output-speed" title="${speedTitle}">${speedText}</span>` +
            '</div>';
        output.innerHTML = outputRowHtml + outputDetailHtml;

        const total = createElement('td');
        // 有实际消耗数据时显示 total（input+output），否则仅显示 output
        const totalVal =
            hasActualUsage && record.totalTokens > 0 ? record.totalTokens
            : record.outputTokens > 0 ? record.outputTokens
            : 0;
        const nativeSplit = getRecordNativeCostSplit(record);
        const costPresentation = getDisplayCostPresentation({
            usd: record.estimatedCost,
            rmb: record.costBreakdown?.currencies?.RMB?.total,
            nativeUsd: nativeSplit?.totalUsd,
            nativeRmb: nativeSplit?.totalRmb,
            currency
        });
        const costText = costPresentation.text;
        const displayVal = totalVal > 0 ? formatTokens(totalVal) : '-';
        if (costText) {
            const tokensRow = createElement('div', 'tokens-row');
            tokensRow.textContent = displayVal;
            const tokensDetail = createElement('div', 'tokens-detail');
            tokensDetail.appendChild(
                createRequestCostSpan({
                    usd: record.estimatedCost,
                    rmb: record.costBreakdown?.currencies?.RMB?.total,
                    nativeUsd: nativeSplit?.totalUsd,
                    nativeRmb: nativeSplit?.totalRmb
                })
            );
            total.append(tokensRow, tokensDetail);
        } else {
            total.textContent = displayVal;
        }
        if (totalVal > 0) {
            total.title = totalVal.toLocaleString('en-US');
        }

        const status = createElement('td');
        const isAllSessions = window.usagesState?.selectedSessionId === null;
        const statusLabel =
            record.status === 'completed' ? 'DONE'
            : record.status === 'failed' ? 'ERROR'
            : record.status === 'cancelled' ? 'CANCEL'
            : 'ACTIVE';
        status.className =
            record.status === 'completed' ? 'status-completed'
            : record.status === 'failed' ? 'status-failed'
            : record.status === 'cancelled' ? 'status-cancelled'
            : 'status-estimated';
        let statusHtml = `<span class="status-label">${statusLabel}</span>`;
        // session 链接放在状态文字下方
        if (isAllSessions && record.sessionId && visibleSessionIds.has(record.sessionId)) {
            const displayId = getSessionDisplayId(record.sessionId);
            const linkHtml = `<a class="tokens-session-link" href="javascript:void(0)" title="SESSION: #${displayId}">#${displayId}</a>`;
            statusHtml += `<div class="tokens-detail">${linkHtml}</div>`;
            status.innerHTML = statusHtml;
            status
                .querySelector('.tokens-session-link')
                ?.addEventListener('click', () => changeSelectedSession(record.sessionId!));
        } else {
            statusHtml = `<span class="status-label status-full-row">${statusLabel}</span>`;
            status.innerHTML = statusHtml;
        }

        row.append(time, providerModel, input, output, total, status);
        tbody.appendChild(row);
    });

    appendTotalsRow(tbody, summary, totals, currency);

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
function createDetailView(
    titleText: string,
    summary: SessionSummary,
    totals: RequestTotals,
    records: ExtendedTokenRequestLog[],
    visibleSessionIds: Set<string>
): HTMLElement {
    const detail = createElement('div', 'records-detail');
    detail.appendChild(createDetailHeader(titleText, summary));

    const content = createElement('div', 'records-detail-content');

    const totalPages = Math.ceil(records.length / PAGE_SIZE) || 1;
    currentPage = Math.min(currentPage, totalPages);

    if (records.length > PAGE_SIZE) {
        content.appendChild(createPagination(currentPage, totalPages, records.length));
    }

    const startIndex = (currentPage - 1) * PAGE_SIZE;
    content.appendChild(
        createRequestRecordsTable(records.slice(startIndex, startIndex + PAGE_SIZE), summary, totals, visibleSessionIds)
    );

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
    const allSessionIds = new Set(visibleSessionGroups.map(group => group.sessionId));
    const dateDetails = getCurrentDateDetails();
    const allRecords = dateDetails?.allRecords || [];
    const allSummary = dateDetails?.allSummary || summarizeSessionRecords(allRecords);
    const allTotals = dateDetails?.allTotals || buildRequestTotals(allRecords);
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
            createDetailView(
                `#${selectedGroup.displayId}`,
                selectedGroup.summary,
                selectedGroup.totals,
                selectedGroup.records,
                allSessionIds
            )
        );
    } else if (allRecords.length > 0) {
        layout.appendChild(
            createDetailView(t('All Sessions', '全部会话'), allSummary, allTotals, allRecords, allSessionIds)
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
