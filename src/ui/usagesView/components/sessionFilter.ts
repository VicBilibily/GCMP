import type { SessionGroup } from '../types';
import { createElement } from '../../utils';
import { formatTokens, t, UNKNOWN_SESSION_ID } from '../utils';

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
 * 创建会话列表中的单个条目
 */
function createSessionItem(options: {
    title: string;
    titleMeta?: string;
    stats: string;
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
    pinned.appendChild(
        createSessionItem({
            title: t('All Sessions', '全部会话'),
            stats: t(
                'Requests: {0} | Tokens: {1}',
                '请求: {0} | Tokens: {1}',
                totalRequests,
                formatTokens(totalTokens)
            ),
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
                selected: selectedSessionId === group.sessionId,
                onClick: () => onChange(group.sessionId)
            })
        );
    });

    container.appendChild(pinned);
    container.appendChild(list);

    return container;
}
