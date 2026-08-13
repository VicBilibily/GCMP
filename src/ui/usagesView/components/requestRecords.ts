/**
 * 请求记录组件
 * 负责渲染请求记录会话分栏与详情表格
 */

import type {
    ExtendedTokenRequestLog,
    RecordsPageMessage,
    RequestTotals,
    SessionGroupSummary,
    SessionRecoveryDebugSummary,
    SessionSummary,
    TrackRecordsMessage
} from '../types';
import { createElement } from '../../utils';
import { getDisplayCostPresentation } from '../../costDisplay';
import {
    createSessionFilter,
    buildSessionDetailMeta,
    buildSessionDetailTitle,
    MAX_TRACKED_SESSIONS,
    shouldShowSessionGroupInFilter
} from './sessionFilter';
import {
    buildCostBreakdownTitle,
    formatSessionTimeRange,
    formatTokens,
    getRecordNativeCostSplit,
    getCurrencyToggleTitle,
    getDisplayCurrency,
    getProviderDisplayName,
    getRequestKindDisplayName,
    getSessionDisplayId,
    postToVSCode,
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

/** 活跃日期多选跟踪：所有会话共享的记录行数预算（按会话数均分，有下限） */
const MULTI_TRACK_ROW_BUDGET = 20;
const MULTI_TRACK_MIN_ROWS = 4;

let isSessionPopoverOpen = false;
let trackLimitHintTimer: number | undefined;

/**
 * 判断当前是否在查看活跃日期（今天）的请求记录
 * 仅活跃日期支持多选会话进行活跃跟踪
 */
export function isActiveDateView(): boolean {
    return window.usagesState?.dateDetails?.isToday === true;
}

/**
 * 获取当前生效的多选跟踪会话 ID 列表（仅保留仍在可见分组中的会话）
 * 非活跃日期直接返回空列表，保证筛选栏高亮与详情视图一致
 */
export function getTrackedSessionIds(visibleSessionIds: Set<string>): string[] {
    if (!isActiveDateView()) {
        return [];
    }
    const tracked = window.usagesState?.selectedSessionIds ?? [];
    return tracked.filter(id => visibleSessionIds.has(id));
}

/**
 * 计算多选跟踪模式下每个会话展示的记录条数上限
 * 按会话数均分总预算，保证下限，避免会话过多时展示过少
 */
export function getTrackedRecordsLimit(sessionCount: number): number {
    if (sessionCount <= 0) {
        return MULTI_TRACK_ROW_BUDGET;
    }
    return Math.max(MULTI_TRACK_MIN_ROWS, Math.floor(MULTI_TRACK_ROW_BUDGET / sessionCount));
}

interface RequestCostPresentationData {
    usd?: number;
    rmb?: number;
    nativeUsd?: number;
    nativeRmb?: number;
    fixedDecimals?: number;
    costBreakdown?: ExtendedTokenRequestLog['costBreakdown'];
}

/**
 * 获取当前日期详情中的会话分组摘要列表
 */
function getCurrentSessionGroups(): SessionGroupSummary[] {
    return window.usagesState?.dateDetails?.sessionGroups || [];
}

/**
 * 获取当前日期详情缓存
 */
function getCurrentDateDetails(): typeof window.usagesState.dateDetails | null {
    return window.usagesState?.dateDetails || null;
}

/**
 * 判断当前是否处于多选跟踪模式（活跃日期 + 至少 2 个可见跟踪会话）
 */
export function isTrackModeActive(): boolean {
    const details = getCurrentDateDetails();
    if (!details?.isToday) {
        return false;
    }
    const visibleGroups = details.sessionGroups.filter(shouldShowSessionGroupInFilter);
    return getTrackedSessionIds(new Set(visibleGroups.map(group => group.sessionId))).length >= 2;
}

/** 最近一次发出的明细拉取请求参数（响应过期校验用） */
interface DetailRequestParams {
    command: 'getRecordsPage' | 'getTrackRecords';
    date: string;
    mode?: 'all' | 'session';
    sessionId?: string;
    page?: number;
    sessionIds?: string[];
}

let lastDetailRequest: DetailRequestParams | null = null;

function recordDetailRequest(params: DetailRequestParams): void {
    lastDetailRequest = params;
}

/**
 * 判断明细响应是否已过期：日期不匹配，或参数与最近一次请求不一致
 * （快速翻页/切会话/切视图模式时，旧响应不得覆盖新请求的结果）
 */
export function isStaleDetailResponse(message: RecordsPageMessage | TrackRecordsMessage): boolean {
    const last = lastDetailRequest;
    if (!last || last.date !== message.date) {
        return true;
    }
    if (message.command === 'recordsPage') {
        return (
            last.command !== 'getRecordsPage' ||
            last.mode !== message.mode ||
            last.sessionId !== message.sessionId ||
            last.page !== message.page
        );
    }
    return (
        last.command !== 'getTrackRecords' ||
        !last.sessionIds ||
        last.sessionIds.length !== message.groups.length ||
        last.sessionIds.some(id => !message.groups.some(group => group.sessionId === id))
    );
}

/**
 * 按当前视图状态向扩展侧拉取明细：
 * 跟踪模式拉每会话最新 N 条；分页模式拉当前页（无视图数据时按选中会话或全部会话第 1 页）
 */
export function fetchDetailByCurrentView(preferCurrentSelection = false): void {
    const details = getCurrentDateDetails();
    if (!details) {
        return;
    }

    if (isTrackModeActive()) {
        const visibleGroups = details.sessionGroups.filter(shouldShowSessionGroupInFilter);
        const trackedSessionIds = getTrackedSessionIds(new Set(visibleGroups.map(group => group.sessionId)));
        const limitPerSession = getTrackedRecordsLimit(trackedSessionIds.length);
        recordDetailRequest({
            command: 'getTrackRecords',
            date: details.date,
            sessionIds: trackedSessionIds
        });
        postToVSCode({
            command: 'getTrackRecords',
            date: details.date,
            sessionIds: trackedSessionIds,
            limitPerSession
        });
        return;
    }

    const rawSelectedSessionId = window.usagesState?.selectedSessionId || null;
    const selectedSessionId = rawSelectedSessionId === UNKNOWN_SESSION_ID ? null : rawSelectedSessionId;
    const view = details.recordsView;
    const params = {
        command: 'getRecordsPage' as const,
        date: details.date,
        mode:
            preferCurrentSelection ?
                selectedSessionId ? 'session'
                :   'all'
            :   (view?.mode ?? (selectedSessionId ? 'session' : 'all')),
        sessionId:
            preferCurrentSelection ?
                (selectedSessionId ?? undefined)
            :   (view?.sessionId ?? selectedSessionId ?? undefined),
        page: preferCurrentSelection ? 1 : (view?.page ?? 1)
    };
    recordDetailRequest(params);
    postToVSCode(params);
}

/**
 * 基于当前状态重新渲染请求记录区域
 */
function rerenderRequestRecords(): void {
    const recordsContainer = document.querySelector('#records-container') as HTMLElement | null;
    if (!recordsContainer) {
        return;
    }

    createRequestRecordsSection(getCurrentSessionGroups(), recordsContainer);
}

/**
 * 切换窄屏会话浮窗的显示状态
 */
function toggleSessionPopover(show?: boolean): void {
    isSessionPopoverOpen = show ?? !isSessionPopoverOpen;
    rerenderRequestRecords();
}

/**
 * 在记录区域顶部短暂展示“已达跟踪上限”提示（2 秒后自动消失）
 */
function showTrackLimitHint(): void {
    const layout = document.querySelector('#records-container .records-layout');
    if (!(layout instanceof HTMLElement)) {
        return;
    }

    layout.querySelector('.track-limit-hint')?.remove();
    const hint = createElement('div', 'track-limit-hint');
    hint.textContent = t('Track up to {0} sessions at a time', '最多同时跟踪 {0} 个会话', MAX_TRACKED_SESSIONS);
    layout.appendChild(hint);

    if (trackLimitHintTimer !== undefined) {
        window.clearTimeout(trackLimitHintTimer);
    }
    trackLimitHintTimer = window.setTimeout(() => {
        hint.remove();
        trackLimitHintTimer = undefined;
    }, 2000);
}

/**
 * 切换当前选中的会话，并回到该会话的第一页
 * 普通点击为单选（分页详情）；活跃日期下按住 Ctrl/Cmd 点击才会话加入/移出多选跟踪，
 * 选中 2-3 个时进入紧凑跟踪视图（不分页），减到 1 个时自动回落为单选分页视图
 */
function changeSelectedSession(sessionId: string | null, multiSelectKey = false): void {
    if (!window.usagesState) {
        return;
    }

    if (sessionId !== null && multiSelectKey && isActiveDateView()) {
        const tracked = window.usagesState.selectedSessionIds ?? [];
        const single = window.usagesState.selectedSessionId;
        const current =
            tracked.length > 0 ? tracked
            : single ? [single]
            : [];
        let next: string[];
        if (current.includes(sessionId)) {
            next = current.filter(id => id !== sessionId);
        } else if (current.length < MAX_TRACKED_SESSIONS) {
            next = [...current, sessionId];
        } else {
            // 已达跟踪上限：提示后忽略本次选择
            showTrackLimitHint();
            return;
        }
        // 多选仅剩 1 个时回落为单选（恢复分页视图）
        if (next.length <= 1) {
            window.usagesState.selectedSessionIds = [];
            window.usagesState.selectedSessionId = next[0] ?? null;
        } else {
            window.usagesState.selectedSessionIds = next;
            window.usagesState.selectedSessionId = null;
        }
        // Ctrl 多选时保持浮窗打开，便于连续勾选
    } else {
        window.usagesState.selectedSessionIds = [];
        window.usagesState.selectedSessionId = sessionId;
        isSessionPopoverOpen = false;
    }

    window.usagesSetLoading?.('dateDetails', true);
    fetchDetailByCurrentView(true);
    rerenderRequestRecords();
}

/**
 * 更新当前分页并重新拉取该页
 */
function changePage(page: number): void {
    const details = getCurrentDateDetails();
    const view = details?.recordsView;
    if (!details || !view) {
        return;
    }

    // 乐观更新页码，响应到达后刷新数据
    details.recordsView = { ...view, page };
    const params = {
        command: 'getRecordsPage' as const,
        date: details.date,
        mode: view.mode,
        sessionId: view.sessionId,
        page
    };
    recordDetailRequest(params);
    postToVSCode(params);
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

function shouldShowSessionRecoveryDebugInfo(): boolean {
    return window.usagesState?.dateDetails?.isExtensionHostDebugMode === true;
}

function createSessionRecoverySummaryChip(
    recoveryDebug: SessionRecoveryDebugSummary | undefined
): HTMLElement | undefined {
    if (!shouldShowSessionRecoveryDebugInfo() || !recoveryDebug) {
        return undefined;
    }

    const { bridgeCount, newUuidCount } = recoveryDebug;
    if (bridgeCount <= 0 && newUuidCount <= 0) {
        return undefined;
    }

    const parts: string[] = [];
    if (bridgeCount > 0) {
        parts.push(t('bridge {0}', '桥接 {0}', bridgeCount));
    }
    if (newUuidCount > 0) {
        parts.push(t('new {0}', '新建 {0}', newUuidCount));
    }

    return createSummaryChip(
        t('Recovery', '恢复'),
        parts.join(' · '),
        t(
            'Debug-only signal showing requests that used summary bridge or new UUID fallback.',
            '仅在调试模式显示：统计使用摘要桥接或新 UUID 回退的请求。'
        )
    );
}

/**
 * 创建右侧详情头部的会话摘要区域
 * 仅保留时间范围：Tokens 与平均速度在底部合计行（appendTotalsRow）已有展示
 */
function createSummarySection(
    summary: SessionSummary,
    recoveryDebug: SessionRecoveryDebugSummary | undefined
): HTMLElement {
    const summaryEl = createElement('div', 'session-detail-summary');
    const timeRange = formatSessionTimeRange(summary.startTime, summary.endTime);

    summaryEl.appendChild(createSummaryChip(t('Time', '时间'), timeRange, timeRange));

    const recoveryChip = createSessionRecoverySummaryChip(recoveryDebug);
    if (recoveryChip) {
        summaryEl.appendChild(recoveryChip);
    }

    return summaryEl;
}

function getSessionRecoveryDebugHint(
    source: ExtendedTokenRequestLog['sessionRecoverySource']
): { label: string; title: string } | undefined {
    if (!shouldShowSessionRecoveryDebugInfo()) {
        return undefined;
    }

    switch (source) {
        case 'trace-bridge':
            return {
                label: 'bridge',
                title: t('trace bridge (same trace continuity)', 'Trace 桥接（同一 trace 延续）')
            };
        case 'turn-bridge':
            return {
                label: 'bridge',
                title: t('turn bridge (resume after compaction on next turn)', 'Turn 桥接（压缩后下一轮继续沿用会话）')
            };
        case 'summary-bridge-exact':
            return {
                label: 'bridge',
                title: t('summary bridge (exact match)', '摘要桥接（精确匹配）')
            };
        case 'summary-bridge-embedded':
            return {
                label: 'bridge',
                title: t('summary bridge (embedded match)', '摘要桥接（嵌入匹配）')
            };
        case 'summary-bridge-truncated':
            return {
                label: 'bridge',
                title: t('summary bridge (truncated match)', '摘要桥接（截断匹配）')
            };
        case 'new-uuid':
            return {
                label: 'new',
                title: t('new UUID fallback', '新 UUID 回退')
            };
        default:
            return undefined;
    }
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
    const breakdownTitle = buildCostBreakdownTitle(data.costBreakdown, currency);
    element.title =
        breakdownTitle ? `${breakdownTitle}\n${getCurrencyToggleTitle(currency)}` : getCurrencyToggleTitle(currency);
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
    if (data.costBreakdown) {
        element.dataset.costBreakdown = JSON.stringify(data.costBreakdown);
    }
    applyRequestCostPresentation(element, data, getDisplayCurrency());
    return element;
}

function readRequestCostPresentationData(element: HTMLElement): RequestCostPresentationData {
    const rawBreakdown = element.dataset.costBreakdown;
    return {
        usd: readNumericDataAttribute(element, 'usd'),
        rmb: readNumericDataAttribute(element, 'rmb'),
        nativeUsd: readNumericDataAttribute(element, 'nativeUsd'),
        nativeRmb: readNumericDataAttribute(element, 'nativeRmb'),
        fixedDecimals: readNumericDataAttribute(element, 'fixedDecimals'),
        costBreakdown: rawBreakdown ? JSON.parse(rawBreakdown) : undefined
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
 * showRequestCount 为 true 时（多会话跟踪视图），右下角状态单元格显示「当前展示数量/总请求量」
 */
function appendTotalsRow(
    tbody: HTMLElement,
    summary: SessionSummary,
    totals: RequestTotals,
    currency: ReturnType<typeof getDisplayCurrency>,
    showRequestCount = false
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
    if (showRequestCount) {
        // 合计行尚未追加，tbody 现有行即当前展示的数据行数
        statusCell.classList.add('records-total-count');
        statusCell.dataset.totalRequests = String(summary.requestCount);
        statusCell.textContent = `${tbody.querySelectorAll('tr').length}/${summary.requestCount}`;
        statusCell.title = t('Visible requests / total requests', '当前展示数量 / 总请求量');
    }

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
    visibleSessionIds: Set<string>,
    showRequestCount = false
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
                    nativeRmb: nativeSplit?.totalRmb,
                    costBreakdown: record.costBreakdown
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
        // 仅“全部会话”视图（单选为空且未进入多选跟踪）在状态列展示会话链接
        const isAllSessions =
            window.usagesState?.selectedSessionId === null &&
            (window.usagesState?.selectedSessionIds?.length ?? 0) === 0;
        const recoveryHint = getSessionRecoveryDebugHint(record.sessionRecoverySource);
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
        const detailParts: string[] = [];
        if (recoveryHint) {
            detailParts.push(
                `<span class="tokens-session-recovery" title="${recoveryHint.title}">${recoveryHint.label}</span>`
            );
        }
        if (isAllSessions && record.sessionId && visibleSessionIds.has(record.sessionId)) {
            const displayId = getSessionDisplayId(record.sessionId);
            detailParts.push(
                `<a class="tokens-session-link" href="javascript:void(0)" title="SESSION: #${displayId}">#${displayId}</a>`
            );
        }
        if (detailParts.length > 0) {
            const separator = '<span class="tokens-detail-separator">·</span>';
            status.innerHTML =
                `<span class="status-label">${statusLabel}</span>` +
                `<div class="tokens-detail">${detailParts.join(separator)}</div>`;
            status
                .querySelector('.tokens-session-link')
                ?.addEventListener('click', () => changeSelectedSession(record.sessionId!));
        } else {
            status.innerHTML = `<span class="status-label status-full-row">${statusLabel}</span>`;
        }

        row.append(time, providerModel, input, output, total, status);
        tbody.appendChild(row);
    });

    appendTotalsRow(tbody, summary, totals, currency, showRequestCount);

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
function createDetailHeader(
    titleText: string,
    summary: SessionSummary,
    recoveryDebug: SessionRecoveryDebugSummary | undefined,
    metaText?: string
): HTMLElement {
    const header = createElement('div', 'session-detail-header');
    const titleRow = createElement('div', 'session-detail-title-row');
    const title = createElement('h3', 'session-detail-title');
    title.textContent = titleText;
    titleRow.appendChild(title);
    if (metaText) {
        const meta = createElement('span', 'session-detail-title-meta');
        meta.textContent = metaText;
        titleRow.appendChild(meta);
    }
    titleRow.appendChild(createSummarySection(summary, recoveryDebug));

    header.appendChild(titleRow);
    return header;
}

/**
 * 创建窄屏会话选择浮窗
 */
function createSessionPopover(
    sessionGroups: SessionGroupSummary[],
    selectedSessionId: string | null,
    onChange: (sessionId: string | null, multiSelectKey?: boolean) => void,
    selectedSessionIds: string[] = []
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
    panel.appendChild(createSessionFilter(sessionGroups, selectedSessionId, onChange, selectedSessionIds));

    popover.appendChild(backdrop);
    popover.appendChild(panel);
    return popover;
}

/**
 * 创建右侧详情区，包含摘要、分页和请求表格（records 为已按页拉取的当前页）
 */
function createDetailView(
    titleText: string,
    metaText: string | undefined,
    summary: SessionSummary,
    totals: RequestTotals,
    recoveryDebug: SessionRecoveryDebugSummary | undefined,
    records: ExtendedTokenRequestLog[],
    totalItems: number,
    page: number,
    visibleSessionIds: Set<string>
): HTMLElement {
    const detail = createElement('div', 'records-detail');
    detail.appendChild(createDetailHeader(titleText, summary, recoveryDebug, metaText));

    const content = createElement('div', 'records-detail-content');

    const totalPages = Math.ceil(totalItems / PAGE_SIZE) || 1;

    if (totalItems > PAGE_SIZE) {
        content.appendChild(createPagination(page, totalPages, totalItems));
    }

    content.appendChild(createRequestRecordsTable(records, summary, totals, visibleSessionIds));

    if (totalItems > PAGE_SIZE) {
        content.appendChild(createPagination(page, totalPages, totalItems));
    }

    detail.appendChild(content);

    return detail;
}

/**
 * 创建活跃日期的多会话跟踪视图：
 * 每个选中会话渲染一个紧凑块（标题 + 限量最新记录 + 底部合计行），不启用分页
 * 每个会话的记录条数上限按会话数均分总预算自动计算
 */
function createSessionTrackView(
    trackedGroups: SessionGroupSummary[],
    trackGroups: Array<{ sessionId: string; records: ExtendedTokenRequestLog[] }>,
    visibleSessionIds: Set<string>
): HTMLElement {
    const detail = createElement('div', 'records-detail records-detail-multi');
    const content = createElement('div', 'records-detail-content');
    const limit = getTrackedRecordsLimit(trackedGroups.length);

    trackedGroups.forEach(group => {
        const records = trackGroups.find(item => item.sessionId === group.sessionId)?.records ?? [];
        const block = createElement('section', 'session-track-block');
        block.appendChild(
            createDetailHeader(
                buildSessionDetailTitle(group),
                group.summary,
                group.recoveryDebug,
                buildSessionDetailMeta(group)
            )
        );
        block.appendChild(
            createRequestRecordsTable(records.slice(0, limit), group.summary, group.totals, visibleSessionIds, true)
        );
        content.appendChild(block);
    });

    detail.appendChild(content);
    return detail;
}

/**
 * 按容器实际可用高度裁减多会话跟踪视图的记录行：
 * 每次从行数最多的会话块末尾移除一行（每块至少保留 1 行），直到内容不再溢出。
 * 返回是否已适配容器高度；false 表示裁到最少仍溢出（跟踪会话过多），
 * 调用方应改用随内容增长的布局，避免详情区出现内部滚动条。
 *
 * 性能：一次性收集各块数据行；先按行高估算并批量裁减（不做测量），
 * 再由精确循环收尾，将强制同步重排从逐行一次降至约 2-3 次。
 */
function trimSessionTrackViewToFit(detail: HTMLElement): boolean {
    const content = detail.querySelector('.records-detail-content');
    if (!(content instanceof HTMLElement) || content.clientHeight === 0) {
        return true;
    }

    // 一次性收集各块数据行，避免裁减循环中重复查询 DOM
    const blockRows = Array.from(detail.querySelectorAll('.session-track-block')).map(block =>
        Array.from(block.querySelectorAll<HTMLTableRowElement>('tbody tr:not(.records-total-row)'))
    );
    // 从行数最多的块末尾移除一行（每块至少保留 1 行）；返回是否确有行被移除
    const removeRowFromFullestBlock = (): boolean => {
        let fullestRows: HTMLTableRowElement[] = [];
        for (const rows of blockRows) {
            if (rows.length > fullestRows.length) {
                fullestRows = rows;
            }
        }
        if (fullestRows.length <= 1) {
            return false;
        }
        fullestRows.pop()?.remove();
        return true;
    };

    const overflow = content.scrollHeight - content.clientHeight;
    if (overflow > 1) {
        // 按首行高度估算需裁减的行数并批量移除；有意低估（floor + 1px 余量），
        // 裁不够由下方精确循环兜底，不会裁过头
        const sampleRow = blockRows.find(rows => rows.length > 0)?.[0];
        const rowHeight = sampleRow?.getBoundingClientRect().height ?? 0;
        if (rowHeight > 1) {
            let estimated = Math.floor((overflow - 1) / rowHeight);
            while (estimated-- > 0 && removeRowFromFullestBlock()) {
                // 批量阶段不做测量
            }
        }
    }

    // 精确收尾：通常 0-2 次迭代即可适配
    let guard = 50;
    while (content.scrollHeight > content.clientHeight + 1 && guard-- > 0 && removeRowFromFullestBlock()) {
        // 逐行移除并重新测量
    }

    // 裁减后刷新各块合计行的「当前展示数量/总请求量」
    detail.querySelectorAll('.session-track-block').forEach(block => {
        const cell = block.querySelector<HTMLElement>('.records-total-count');
        if (!cell) {
            return;
        }
        const total = cell.dataset.totalRequests ?? '0';
        const visible = block.querySelectorAll('tbody tr:not(.records-total-row)').length;
        cell.textContent = `${visible}/${total}`;
    });

    return content.scrollHeight <= content.clientHeight + 1;
}

/**
 * 创建明细加载占位详情区（响应尚未到达）
 */
function createLoadingDetail(): HTMLElement {
    const detail = createElement('div', 'records-detail');
    const loading = createElement('div', 'empty-message');
    loading.textContent = t('Loading...', '加载中...');
    detail.appendChild(loading);
    return detail;
}

/**
 * 重置请求记录区域的内部状态（浮窗等）
 */
export function resetRequestRecordsState(): void {
    isSessionPopoverOpen = false;
}

/**
 * 创建请求记录主区域：左侧会话列表，右侧会话详情
 * 明细数据来自 dateDetails.recordsView（分页）或 dateDetails.trackRecords（多选跟踪）
 */
export function createRequestRecordsSection(
    sessionGroups: SessionGroupSummary[],
    existingContainer?: HTMLElement
): HTMLElement {
    const container = existingContainer || createElement('div', '', { id: 'records-container' });
    container.id = 'records-container';
    container.innerHTML = '';

    const layout = createElement('div', 'records-layout');
    const rawSelectedSessionId = window.usagesState?.selectedSessionId || null;
    const selectedSessionId = rawSelectedSessionId === UNKNOWN_SESSION_ID ? null : rawSelectedSessionId;
    const visibleSessionGroups = sessionGroups.filter(shouldShowSessionGroupInFilter);
    const hasVisibleSessionGroups = visibleSessionGroups.length > 0;
    const allSessionIds = new Set(visibleSessionGroups.map(group => group.sessionId));
    const trackedSessionIds = getTrackedSessionIds(allSessionIds);
    const isTrackMode = isActiveDateView() && trackedSessionIds.length >= 2;
    const dateDetails = getCurrentDateDetails();
    const selectedGroup =
        selectedSessionId ? visibleSessionGroups.find(group => group.sessionId === selectedSessionId) : undefined;

    if (hasVisibleSessionGroups) {
        layout.appendChild(
            createSessionFilter(
                sessionGroups,
                selectedGroup?.sessionId || null,
                changeSelectedSession,
                trackedSessionIds
            )
        );
        layout.appendChild(createSessionToggleButton());
        layout.appendChild(
            createSessionPopover(
                sessionGroups,
                selectedGroup?.sessionId || null,
                changeSelectedSession,
                trackedSessionIds
            )
        );
    }

    const trackedGroups =
        isTrackMode ?
            // 跟踪块按开始时间倒序：startTime 稳定，不随新请求推进的 endTime 重排导致顺序跳动
            visibleSessionGroups
                .filter(group => trackedSessionIds.includes(group.sessionId))
                .sort((a, b) => (b.summary.startTime || 0) - (a.summary.startTime || 0))
        :   [];
    const view = dateDetails?.recordsView;
    const displayGroup =
        view?.mode === 'session' && view.sessionId ?
            visibleSessionGroups.find(group => group.sessionId === view.sessionId)
        :   undefined;
    let trackDetail: HTMLElement | undefined;
    if (isTrackMode) {
        if (dateDetails?.trackRecords) {
            trackDetail = createSessionTrackView(trackedGroups, dateDetails.trackRecords.groups, allSessionIds);
        } else {
            trackDetail = createLoadingDetail();
        }
        layout.appendChild(trackDetail);
    } else if (selectedGroup || view) {
        // 会话模式下选中组必然存在（摘要与视图同源）；all 模式下直接展示
        if (view && (displayGroup || view.mode === 'all')) {
            layout.appendChild(
                createDetailView(
                    displayGroup ? buildSessionDetailTitle(displayGroup) : t('All Sessions', '全部会话'),
                    displayGroup ? buildSessionDetailMeta(displayGroup) : undefined,
                    view.summary,
                    view.totals,
                    view.recoveryDebug,
                    view.records,
                    view.totalItems,
                    view.page,
                    allSessionIds
                )
            );
        } else {
            layout.appendChild(createLoadingDetail());
        }
    } else if ((dateDetails?.allSummary.requestCount ?? 0) > 0) {
        // 有记录但明细未拉取到（初次加载/切换视图）
        layout.appendChild(createLoadingDetail());
    } else {
        const detail = createElement('div', 'records-detail');
        const empty = createElement('div', 'empty-message');
        empty.textContent = t('No request records yet', '暂无请求记录');
        detail.appendChild(empty);
        layout.appendChild(detail);
    }

    container.appendChild(layout);

    // 多会话跟踪：按容器实际高度裁减记录行，避免详情区出现内部滚动条；
    // 会话过多、每块仅剩 1 行仍放不下时，放开固定高度让布局随内容增长（由页面级滚动接管）
    if (trackDetail && container.isConnected && !trimSessionTrackViewToFit(trackDetail)) {
        layout.classList.add('records-layout-grow');
        trackDetail.replaceWith(
            createSessionTrackView(trackedGroups, dateDetails?.trackRecords?.groups ?? [], allSessionIds)
        );
    }

    return container;
}
