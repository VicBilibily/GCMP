import type { RequestTotals, SessionGroup } from '../types';
import { createElement } from '../../utils';
import { getDisplayCostPresentation } from '../../costDisplay';
import { formatTokens, getCurrencyToggleTitle, getDisplayCurrency, t, UNKNOWN_SESSION_ID } from '../utils';

/**
 * 判断会话是否应该显示在会话列表中
 */
export function shouldShowSessionGroupInFilter(group: SessionGroup): boolean {
    return group.sessionId !== UNKNOWN_SESSION_ID && group.summary.requestCount > 1;
}

/**
 * 将会话时间范围格式化为仅包含时分的文本
 */
function formatSessionListTime(startTime?: number, endTime?: number): string {
    if (!startTime && !endTime) {
        return '';
    }

    const formatTime = (timestamp?: number): string => {
        if (!timestamp) {
            return '-';
        }

        try {
            return new Date(timestamp).toLocaleTimeString('zh-CN', {
                hour12: false,
                hour: '2-digit',
                minute: '2-digit'
            });
        } catch {
            return '-';
        }
    };

    const start = formatTime(startTime || endTime);
    const end = formatTime(endTime || startTime);
    return start === end ? start : `${start}-${end}`;
}

/**
 * 构建左侧会话列表展示标题文本
 */
function buildSessionTitle(group: SessionGroup): string {
    return group.sessionId === UNKNOWN_SESSION_ID ? t('Unknown Session', '未知会话') : `#${group.displayId}`;
}

/**
 * 构建左侧会话列表的时间状态文本
 */
function buildSessionTimeText(group: SessionGroup): string | undefined {
    const timeText = formatSessionListTime(group.summary.startTime, group.summary.endTime);
    return timeText || undefined;
}

/**
 * 创建会话列表成本 span，纳入 refreshRequestRecordCosts 的统一刷新
 */
function createSessionCostSpan(totals: RequestTotals): HTMLElement | undefined {
    const currency = getDisplayCurrency();
    const presentation = getDisplayCostPresentation({
        usd: totals.totalCost,
        rmb: totals.totalCostRmb,
        nativeUsd: totals.nativeCosts.totalUsd,
        nativeRmb: totals.nativeCosts.totalRmb,
        currency,
        fixedDecimals: 2
    });
    if (!presentation.text) {
        return undefined;
    }

    const element = createElement('span');
    element.dataset.requestCost = 'true';
    element.dataset.usd = String(totals.totalCost);
    element.dataset.rmb = String(totals.totalCostRmb);
    element.dataset.fixedDecimals = '2';
    if (totals.nativeCosts.totalUsd > 0) {
        element.dataset.nativeUsd = String(totals.nativeCosts.totalUsd);
    }
    if (totals.nativeCosts.totalRmb > 0) {
        element.dataset.nativeRmb = String(totals.nativeCosts.totalRmb);
    }
    element.textContent = presentation.text;
    element.title = getCurrencyToggleTitle(currency);
    element.className = 'tokens-cost';
    element.dataset.toggleCostCurrency = 'true';
    return element;
}

/**
 * 创建会话列表中的单个条目
 */
function createSessionItem(options: {
    title: string;
    titleMeta?: string;
    stats: string;
    /** 会话预估成本 */
    totals?: RequestTotals;
    /** 预留插槽：附加在会话条目底部的可选详情文本 */
    detail?: string;
    selected: boolean;
    onClick: () => void;
}): HTMLElement {
    const item = createElement('div', 'session-filter-item');
    if (options.selected) {
        item.classList.add('selected');
    }

    const inner = createElement('div');
    inner.onclick = options.onClick;

    const title = createElement('div', 'session-filter-item-title');
    const titleLabel = createElement('span', 'session-filter-item-title-label');
    titleLabel.textContent = options.title;
    title.appendChild(titleLabel);

    if (options.titleMeta) {
        const titleMeta = createElement('span', 'session-filter-item-title-time');
        titleMeta.textContent = options.titleMeta;
        title.appendChild(titleMeta);
    }

    const stats = createElement('div', 'session-filter-item-stats');
    stats.textContent = options.stats;

    inner.appendChild(title);
    inner.appendChild(stats);

    // 成本单独一行展示，带标题前缀
    if (options.totals) {
        const costSpan = createSessionCostSpan(options.totals);
        if (costSpan) {
            const costRow = createElement('div', 'session-filter-item-cost');
            costRow.textContent = t('Est. Cost: ', '预估成本: ');
            costRow.appendChild(costSpan);
            inner.appendChild(costRow);
        }
    }

    // 预留插槽：未传 detail 时不渲染，保持 DOM 紧凑
    if (options.detail) {
        const detail = createElement('div', 'session-filter-item-detail');
        detail.textContent = options.detail;
        inner.appendChild(detail);
    }

    item.appendChild(inner);
    return item;
}

/**
 * 创建左侧会话筛选栏，顶部固定“全部会话”，下方滚动展示各会话
 */
export function createSessionFilter(
    sessionGroups: SessionGroup[],
    selectedSessionId: string | null,
    onChange: (sessionId: string | null) => void
): HTMLElement {
    const container = createElement('div', 'session-filter');
    const visibleSessionGroups = sessionGroups.filter(shouldShowSessionGroupInFilter);

    const pinned = createElement('div', 'session-filter-pinned');
    const list = createElement('div', 'session-filter-list');

    const totalRequests = sessionGroups.reduce((sum, group) => sum + group.summary.requestCount, 0);
    const totalTokens = sessionGroups.reduce((sum, group) => sum + group.summary.totalTokens, 0);
    const allTotals = globalThis.window?.usagesState?.dateDetails?.allTotals;
    pinned.appendChild(
        createSessionItem({
            title: t('All Sessions', '全部会话'),
            stats: t(
                'Requests: {0} | Tokens: {1}',
                '请求: {0} | Tokens: {1}',
                totalRequests,
                formatTokens(totalTokens)
            ),
            totals: allTotals,
            selected: selectedSessionId === null,
            onClick: () => onChange(null)
        })
    );

    visibleSessionGroups.forEach(group => {
        list.appendChild(
            createSessionItem({
                title: buildSessionTitle(group),
                titleMeta: buildSessionTimeText(group),
                stats: t(
                    'Requests: {0} | Tokens: {1}',
                    '请求: {0} | Tokens: {1}',
                    group.summary.requestCount,
                    formatTokens(group.summary.totalTokens)
                ),
                totals: group.totals,
                selected: selectedSessionId === group.sessionId,
                onClick: () => onChange(group.sessionId)
            })
        );
    });

    container.appendChild(pinned);
    container.appendChild(list);

    return container;
}
