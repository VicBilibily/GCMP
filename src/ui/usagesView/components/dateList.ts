/**
 * 日期列表组件
 * 负责渲染和交互左侧日期列表
 */

import { DateSummary } from '../types';
import { formatTokens, getCurrencyToggleTitle, getDisplayCurrency, postToVSCode, t } from '../utils';
import { createElement } from '../../utils';
import { getDisplayCostPresentation } from '../../costDisplay';

// ============= 工具函数 =============

/**
 * 打开存储目录
 */
function openStorageDir(): void {
    postToVSCode({ command: 'openStorageDir' });
}

function updateSelectedDateHighlight(selectedDate: string): void {
    const dateListEl = document.getElementById('date-list');
    if (!dateListEl) {
        return;
    }

    Array.from(dateListEl.children).forEach(item => {
        const el = item as HTMLElement;
        el.classList.toggle('selected', el.dataset.date === selectedDate);
    });
}

/**
 * 创建日期条目成本 span，纳入 refreshRequestRecordCosts 的统一刷新
 */
function createDateCostSpan(summary: DateSummary): HTMLElement | undefined {
    const currency = getDisplayCurrency();
    const presentation = getDisplayCostPresentation({
        usd: summary.total_cost,
        rmb: summary.total_cost_rmb,
        nativeUsd: summary.native_total_cost,
        nativeRmb: summary.native_total_cost_rmb,
        currency,
        fixedDecimals: 2
    });
    if (!presentation.text) {
        return undefined;
    }

    const element = createElement('span');
    element.dataset.requestCost = 'true';
    if (summary.total_cost !== undefined) {
        element.dataset.usd = String(summary.total_cost);
    }
    if (summary.total_cost_rmb !== undefined) {
        element.dataset.rmb = String(summary.total_cost_rmb);
    }
    if (summary.native_total_cost !== undefined && summary.native_total_cost > 0) {
        element.dataset.nativeUsd = String(summary.native_total_cost);
    }
    if (summary.native_total_cost_rmb !== undefined && summary.native_total_cost_rmb > 0) {
        element.dataset.nativeRmb = String(summary.native_total_cost_rmb);
    }
    element.dataset.fixedDecimals = '2';
    element.textContent = presentation.text;
    element.title = getCurrencyToggleTitle(currency);
    element.className = 'tokens-cost';
    element.dataset.toggleCostCurrency = 'true';
    return element;
}

// ============= 组件渲染 =============

function createDateListItem(summary: DateSummary): HTMLElement {
    const item = createElement('div', 'date-item');
    item.dataset.date = summary.date;

    const isSelected = window.usagesState?.selectedDate === summary.date;
    const isDateToday = summary.date === window.usagesState?.today;
    const displayDate = isDateToday ? t('Today ({0})', '今日 ({0})', summary.date) : summary.date;
    const totalTokens = summary.total_input + summary.total_output;

    if (isSelected) {
        item.classList.add('selected');
    }

    const inner = createElement('div', 'date-item-inner');
    inner.onclick = () => {
        if (window.usagesState) {
            window.usagesState.selectedDate = summary.date;
        }
        updateSelectedDateHighlight(summary.date);
        // 设置加载状态
        if (window.usagesSetLoading) {
            window.usagesSetLoading('dateDetails', true);
        }
        postToVSCode({ command: 'selectDate', date: summary.date });
    };

    const title = createElement('div', isDateToday ? 'date-item-title today' : 'date-item-title');
    title.textContent = displayDate;

    const stats = createElement('div', 'date-item-stats');
    stats.textContent = t(
        'Requests: {0} | Tokens: {1}',
        '请求: {0} | Tokens: {1}',
        summary.total_requests,
        formatTokens(totalTokens)
    );

    inner.appendChild(title);
    inner.appendChild(stats);

    const costSpan = createDateCostSpan(summary);
    if (costSpan) {
        const costRow = createElement('div', 'date-item-cost');
        costRow.textContent = t('Est. Cost: ', '预估成本: ');
        costRow.appendChild(costSpan);
        inner.appendChild(costRow);
    }

    item.appendChild(inner);

    return item;
}

export function createSidebar(): HTMLElement {
    const sidebar = createElement('div', 'sidebar');

    // 侧边栏头部
    const header = createElement('div', 'sidebar-header');
    const headerTop = createElement('div', 'sidebar-header-top');
    const h1 = createElement('h1');
    h1.textContent = t('Token Usage', 'Token 消耗统计');
    const openBtn = createElement('button', 'sidebar-action-btn');
    openBtn.textContent = '📁';
    openBtn.title = t('Open storage directory', '打开存储目录');
    openBtn.onclick = openStorageDir;
    headerTop.appendChild(h1);
    headerTop.appendChild(openBtn);

    // 多日趋势按钮
    const multiDayBtn = createElement('button', 'sidebar-action-btn');
    multiDayBtn.textContent = '📊';
    multiDayBtn.title = t('Multi-Day Consumption', '多日消耗分析');
    multiDayBtn.onclick = () => postToVSCode({ command: 'openMultiDayTrend' });
    headerTop.appendChild(multiDayBtn);

    header.appendChild(headerTop);

    // 日期列表容器
    const dateListContainer = createElement('div', 'date-list');
    dateListContainer.id = 'date-list';

    sidebar.appendChild(header);
    sidebar.appendChild(dateListContainer);

    return sidebar;
}

export function updateDateList(dateList: DateSummary[]): void {
    const dateListEl = document.getElementById('date-list');
    if (!dateListEl) {
        return;
    }

    const existingItems = Array.from(dateListEl.children) as HTMLElement[];

    // 检查是否需要全量重新渲染
    const needsFullRender =
        existingItems.length !== dateList.length ||
        existingItems.some((item, index) => item.dataset.date !== dateList[index]?.date);

    if (needsFullRender) {
        // 全量重新渲染
        dateListEl.innerHTML = '';
        dateList.forEach(summary => {
            dateListEl.appendChild(createDateListItem(summary));
        });
    } else {
        // 日期集合未变化时逐项更新内容，保留当前滚动位置和点击事件。
        dateList.forEach((summary, index) => {
            const item = existingItems[index];
            item.classList.toggle('selected', window.usagesState?.selectedDate === summary.date);

            const title = item.querySelector('.date-item-title') as HTMLElement;
            const stats = item.querySelector('.date-item-stats') as HTMLElement;
            const costRow = item.querySelector('.date-item-cost') as HTMLElement | null;
            const totalTokens = summary.total_input + summary.total_output;

            if (title) {
                const isToday = summary.date === window.usagesState?.today;
                title.textContent = isToday ? t('Today ({0})', '今日 ({0})', summary.date) : summary.date;
                title.className = isToday ? 'date-item-title today' : 'date-item-title';
            }
            if (stats) {
                stats.textContent = t(
                    'Requests: {0} | Tokens: {1}',
                    '请求: {0} | Tokens: {1}',
                    summary.total_requests,
                    formatTokens(totalTokens)
                );
            }

            // 成本行增量更新：无成本时移除旧行，有成本时重建 span
            const newCostSpan = createDateCostSpan(summary);
            if (newCostSpan) {
                if (costRow) {
                    costRow.textContent = t('Est. Cost: ', '预估成本: ');
                    costRow.appendChild(newCostSpan);
                } else {
                    const row = createElement('div', 'date-item-cost');
                    row.textContent = t('Est. Cost: ', '预估成本: ');
                    row.appendChild(newCostSpan);
                    const inner = item.querySelector('.date-item-inner');
                    inner?.appendChild(row);
                }
            } else if (costRow) {
                costRow.remove();
            }
        });
    }
}
