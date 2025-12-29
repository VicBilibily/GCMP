/**
 * 日期列表组件
 * 负责渲染和交互左侧日期列表
 */

import { DateSummary } from '../types';
import { formatTokens, postToVSCode } from '../utils';
import { createElement } from '../../utils';

// ============= 工具函数 =============

/**
 * 打开存储目录
 */
function openStorageDir(): void {
    postToVSCode({ command: 'openStorageDir' });
}

// ============= 组件渲染 =============

function createDateListItem(summary: DateSummary): HTMLElement {
    const item = createElement('div', 'date-item');
    item.dataset.date = summary.date;

    const isSelected = window.usagesState?.selectedDate === summary.date;
    const isDateToday = summary.date === window.usagesState?.today;
    const displayDate = isDateToday ? `今日 (${summary.date})` : summary.date;
    const totalTokens = summary.total_input + summary.total_output;

    if (isSelected) {
        item.classList.add('selected');
    }

    const inner = createElement('div');
    inner.onclick = () => {
        if (window.usagesState) {
            console.log('selectDate:', summary.date, 'current:', window.usagesState.selectedDate);
            window.usagesState.selectedDate = summary.date;
        }
        // 设置加载状态
        if (window.usagesSetLoading) {
            window.usagesSetLoading('dateDetails', true);
        }
        postToVSCode({ command: 'selectDate', date: summary.date });
    };

    const title = createElement('div', isDateToday ? 'date-item-title today' : 'date-item-title');
    title.textContent = displayDate;

    const stats = createElement('div', 'date-item-stats');
    stats.textContent = `请求: ${summary.total_requests} | Token: ${formatTokens(totalTokens)}`;

    inner.appendChild(title);
    inner.appendChild(stats);

    item.appendChild(inner);

    return item;
}

export function createSidebar(): HTMLElement {
    const sidebar = createElement('div', 'sidebar');

    // 侧边栏头部
    const header = createElement('div', 'sidebar-header');
    const headerTop = createElement('div', 'sidebar-header-top');
    const h1 = createElement('h1');
    h1.textContent = 'Token 消耗统计';
    const openBtn = createElement('button', 'open-storage-button');
    openBtn.textContent = '📁';
    openBtn.title = '打开存储目录';
    openBtn.onclick = openStorageDir;
    headerTop.appendChild(h1);
    headerTop.appendChild(openBtn);
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

    const existingItems = dateListEl.children;
    const firstItem = existingItems[0] as HTMLElement;
    const firstItemDate = firstItem?.dataset.date;

    // 检查是否需要全量重新渲染
    const needsFullRender = existingItems.length !== dateList.length || firstItemDate !== dateList[0]?.date;

    if (needsFullRender) {
        // 全量重新渲染
        dateListEl.innerHTML = '';
        dateList.forEach(summary => {
            dateListEl.appendChild(createDateListItem(summary));
        });
    } else {
        // 差分更新：更新第一个元素的内容
        if (existingItems.length > 0 && dateList.length > 0) {
            const todaySummary = dateList[0];
            firstItem.dataset.date = todaySummary.date;
            firstItem.classList.toggle('selected', window.usagesState?.selectedDate === todaySummary.date);

            const title = firstItem.querySelector('.date-item-title') as HTMLElement;
            const stats = firstItem.querySelector('.date-item-stats') as HTMLElement;
            const totalTokens = todaySummary.total_input + todaySummary.total_output;

            if (title) {
                const isToday = todaySummary.date === window.usagesState?.today;
                title.textContent = isToday ? `今日 (${todaySummary.date})` : todaySummary.date;
                title.className = isToday ? 'date-item-title today' : 'date-item-title';
            }
            if (stats) {
                stats.textContent = `请求: ${todaySummary.total_requests} | Token: ${formatTokens(totalTokens)}`;
            }
        }

        // 更新所有项的选中状态高亮
        Array.from(existingItems).forEach(item => {
            const el = item as HTMLElement;
            const date = el.dataset.date;
            el.classList.toggle('selected', date === window.usagesState?.selectedDate);
        });
    }
}
