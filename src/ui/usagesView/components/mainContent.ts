/**
 * 主内容区组件
 * 负责渲染右侧主内容区域
 */

import { createProviderStats } from './providerStats';
import { createHourlyStats } from './hourlyStats';
import { createElement } from '../../utils';

// ============= 工具函数 =============

/**
 * 判断是否是今天
 */
function isToday(date: string): boolean {
    return date === window.usagesState?.today;
}

// ============= 组件渲染 =============

/**
 * 创建空内容提示
 */
function createEmptyContent(dateText: string): HTMLElement {
    const content = createElement('div', 'empty-message');
    content.innerHTML = `💡 ${dateText} 暂无 Token 消耗记录`;
    return content;
}

/**
 * 创建主内容区
 */
export function createMainContent(): HTMLElement {
    const content = createElement('div', 'content');

    const title = createElement('h2', '', { id: 'details-title' });
    title.textContent = '加载中...';

    const detailsContent = createElement('div', '', { id: 'details-content' });

    content.appendChild(title);
    content.appendChild(detailsContent);

    return content;
}

/**
 * 更新主内容区
 */
export function updateMainContent(): void {
    const content = document.querySelector('.content');
    if (!content || !window.usagesState) {
        return;
    }

    const title = content.querySelector('#details-title') as HTMLElement;
    const detailsContent = content.querySelector('#details-content') as HTMLElement;

    // 更新标题
    const dateDetails = window.usagesState.dateDetails;
    const displayText = dateDetails?.date && isToday(dateDetails.date) ? '今日' : dateDetails?.date || '加载中...';
    title.textContent = `${displayText} 使用详情`;

    // 更新内容
    if (dateDetails && dateDetails.providers && dateDetails.providers.length > 0) {
        detailsContent.innerHTML = '';

        const providerSection = createProviderStats(dateDetails.providers);
        const hourlySection = createHourlyStats(dateDetails.hourlyStats);

        detailsContent.appendChild(providerSection);
        detailsContent.appendChild(hourlySection);
    } else {
        const displayText2 = dateDetails?.date && isToday(dateDetails.date) ? '今日' : dateDetails?.date || '今日';
        detailsContent.innerHTML = '';
        detailsContent.appendChild(createEmptyContent(displayText2));
    }
}
