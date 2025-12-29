/**
 * 小时统计组件
 * 负责渲染每小时的使用统计
 */

import type { HourlyStats } from '../types';
import { createElement } from '../../utils';
import { formatTokens } from '../utils';

// ============= 组件渲染 =============

/**
 * 创建小时统计区域
 */
export function createHourlyStats(hourlyStats: Record<string, Omit<HourlyStats, 'providers'>>): HTMLElement {
    const section = createElement('section');

    const h2 = createElement('h2');
    h2.textContent = '各小时用量';
    section.appendChild(h2);

    if (hourlyStats && Object.keys(hourlyStats).length > 0) {
        const table = createElement('table', 'hourly-stats-table');
        const thead = createElement('thead');
        const headerRow = createElement('tr');

        const headers = ['时间', '输入Tokens', '缓存命中', '输出Tokens', '消耗Tokens', '请求次数'];
        headers.forEach(h => {
            const th = createElement('th');
            th.textContent = h;
            headerRow.appendChild(th);
        });
        thead.appendChild(headerRow);
        table.appendChild(thead);

        const tbody = createElement('tbody');
        Object.entries(hourlyStats)
            .sort(([a], [b]) => Number(a) - Number(b))
            .forEach(([hour, stats]) => {
                // 跳过请求数为0的记录
                if (stats.requests === 0) {
                    return;
                }

                const totalTokens = stats.actualInput + stats.cacheTokens + stats.outputTokens;
                const row = createElement('tr') as HTMLTableRowElement;

                const timeCell = createElement('td');
                timeCell.innerHTML = `<strong>${String(hour).padStart(2, '0')}:00</strong>`;
                row.appendChild(timeCell);

                const inputCell = createElement('td');
                inputCell.textContent = formatTokens(stats.actualInput);
                row.appendChild(inputCell);

                const cacheCell = createElement('td');
                cacheCell.textContent = formatTokens(stats.cacheTokens);
                row.appendChild(cacheCell);

                const outputCell = createElement('td');
                outputCell.textContent = formatTokens(stats.outputTokens);
                row.appendChild(outputCell);

                const totalCell = createElement('td');
                totalCell.innerHTML = `<strong>${formatTokens(totalTokens)}</strong>`;
                row.appendChild(totalCell);

                const requestsCell = createElement('td');
                requestsCell.textContent = String(stats.requests);
                row.appendChild(requestsCell);

                tbody.appendChild(row);
            });
        table.appendChild(tbody);
        section.appendChild(table);
    } else {
        const empty = createElement('div', 'empty-message');
        empty.textContent = '暂无小时统计数据';
        section.appendChild(empty);
    }

    return section;
}
