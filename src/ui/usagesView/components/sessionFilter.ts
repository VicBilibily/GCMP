import type { RequestTotals, SessionGroupSummary } from '../types';
import { createElement } from '../../utils';
import { getDisplayCostPresentation } from '../../costDisplay';
import { formatTokens, getCurrencyToggleTitle, getDisplayCurrency, t, UNKNOWN_SESSION_ID } from '../utils';

/** 活跃日期多选跟踪：最多同时跟踪的会话数 */
export const MAX_TRACKED_SESSIONS = 3;

/**
 * 判断会话是否应该显示在会话列表中
 */
export function shouldShowSessionGroupInFilter(group: SessionGroupSummary): boolean {
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
 * 构建左侧会话列表的主标题文本（短 ID）
 */
export function buildSessionTitle(group: SessionGroupSummary): string {
    return group.sessionId === UNKNOWN_SESSION_ID ? t('Unknown Session', '未知会话') : `#${group.displayId}`;
}

/**
 * 构建详情头部的主标题文本：有正式标题时优先展示标题本身，弱化短 ID 的视觉权重
 */
export function buildSessionDetailTitle(group: SessionGroupSummary): string {
    if (group.sessionId === UNKNOWN_SESSION_ID) {
        return t('Unknown Session', '未知会话');
    }
    return group.title || `#${group.displayId}`;
}

/**
 * 构建详情头部的次级会话标识：仅在已有正式标题时展示短 ID，避免与标题争抢视觉主次
 */
export function buildSessionDetailMeta(group: SessionGroupSummary): string | undefined {
    if (group.sessionId === UNKNOWN_SESSION_ID || !group.title) {
        return undefined;
    }
    return `#${group.displayId}`;
}

/**
 * 构建左侧会话列表的时间状态文本
 */
function buildSessionTimeText(group: SessionGroupSummary): string | undefined {
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
    /** 会话标题（仅 VS Code 正式标题 generated），有值时独立一行显示并作为主要识别信息 */
    sessionTitle?: string;
    titleMeta?: string;
    stats: string;
    /** 会话预估成本 */
    totals?: RequestTotals;
    /** 预留插槽：附加在会话条目底部的可选详情文本 */
    detail?: string;
    selected: boolean;
    /** multiSelectKey 为 true 表示按住 Ctrl/Cmd 点击（用于多选跟踪） */
    onClick: (multiSelectKey: boolean) => void;
}): HTMLElement {
    const item = createElement('div', 'session-filter-item');
    if (options.selected) {
        item.classList.add('selected');
    }

    const inner = createElement('div');
    inner.onclick = (event: MouseEvent) => options.onClick(event.ctrlKey || event.metaKey);

    // 会话标题独立成行，置于主标题（短 ID）上方
    if (options.sessionTitle) {
        const sessionTitleEl = createElement('div', 'session-filter-item-session-title');
        sessionTitleEl.textContent = options.sessionTitle;
        inner.appendChild(sessionTitleEl);
    }

    const title = createElement('div', 'session-filter-item-title');
    if (options.sessionTitle) {
        title.classList.add('session-filter-item-title-secondary');
    }
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
 * selectedSessionIds 为活跃日期下的多选跟踪集合，命中即高亮
 */
export function createSessionFilter(
    sessionGroups: SessionGroupSummary[],
    selectedSessionId: string | null,
    onChange: (sessionId: string | null, multiSelectKey?: boolean) => void,
    selectedSessionIds: string[] = []
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
            selected: selectedSessionId === null && selectedSessionIds.length === 0,
            onClick: () => onChange(null)
        })
    );

    visibleSessionGroups.forEach(group => {
        list.appendChild(
            createSessionItem({
                title: buildSessionTitle(group),
                sessionTitle: group.title,
                titleMeta: buildSessionTimeText(group),
                stats: t(
                    'Requests: {0} | Tokens: {1}',
                    '请求: {0} | Tokens: {1}',
                    group.summary.requestCount,
                    formatTokens(group.summary.totalTokens)
                ),
                totals: group.totals,
                selected: selectedSessionId === group.sessionId || selectedSessionIds.includes(group.sessionId),
                onClick: multiSelectKey => onChange(group.sessionId, multiSelectKey)
            })
        );
    });

    container.appendChild(pinned);
    container.appendChild(list);

    // 活跃日期且有足够会话组成多选时，在底部展示多选跟踪入口提示
    if (visibleSessionGroups.length >= 2 && globalThis.window?.usagesState?.dateDetails?.isToday === true) {
        const hint = createElement('div', 'session-filter-hint');
        hint.textContent = t(
            'Ctrl+Click to track multiple sessions (2-{0})',
            'Ctrl+点击可多选跟踪 (2-{0})',
            MAX_TRACKED_SESSIONS
        );
        container.appendChild(hint);
    }

    return container;
}
