/**
 * 提供商统计组件
 * 负责渲染提供商和模型列表
 */

import type { ProviderData } from '../types';
import { createElement } from '../../utils';
import { TokenStats } from '../../../usages/fileLogger/types';
import { calculateTotalTokens, formatTokens, calculateAverageSpeed } from '../utils';

// ============= 工具函数 =============

/**
 * 创建表格单元格
 */
function createCell(content: string | number, className = ''): HTMLElement {
    const cell = createElement('td');
    if (className) {
        cell.className = className;
    }
    cell.textContent = String(content);
    return cell;
}

// ============= 组件渲染 =============

/**
 * 创建提供商统计区域
 */
export function createProviderStats(providers: ProviderData[]): HTMLElement {
    const section = createElement('section');

    const h2 = createElement('h2');
    h2.textContent = '按提供商统计';
    section.appendChild(h2);

    if (providers && providers.length > 0) {
        const table = createElement('table', 'provider-stats-table');
        const thead = createElement('thead');
        const headerRow = createElement('tr');

        const headers = ['提供商/模型', '输入Tokens', '缓存命中', '输出Tokens', '消耗Tokens', '请求次数', '平均速度'];
        headers.forEach(h => {
            const th = createElement('th');
            th.textContent = h;
            headerRow.appendChild(th);
        });
        thead.appendChild(headerRow);
        table.appendChild(thead);

        const tbody = createElement('tbody');

        // 计算合计数据
        let totalInput = 0;
        let totalCache = 0;
        let totalOutput = 0;
        let totalRequests = 0;

        providers.forEach(provider => {
            // 累加合计数据
            totalInput += provider.actualInput || 0;
            totalCache += provider.cacheTokens || 0;
            totalOutput += provider.outputTokens || 0;
            totalRequests += provider.requests || 0;

            // 提供商行
            const providerRow = createElement('tr');
            providerRow.style.backgroundColor = 'var(--vscode-editor-inactiveSelectionBackground)';
            providerRow.style.fontWeight = 'bold';

            const totalTokens = calculateTotalTokens(provider);

            providerRow.appendChild(createCell(provider.providerName));
            providerRow.appendChild(createCell(formatTokens(provider.actualInput)));
            providerRow.appendChild(createCell(formatTokens(provider.cacheTokens)));
            providerRow.appendChild(createCell(formatTokens(provider.outputTokens)));
            providerRow.appendChild(createCell(formatTokens(totalTokens)));
            providerRow.appendChild(createCell(provider.requests));
            providerRow.appendChild(createCell(calculateAverageSpeed(provider)));

            tbody.appendChild(providerRow);

            // 模型行
            Object.entries(provider.models).forEach(([, stats]) => {
                const modelRow = createElement('tr') as HTMLTableRowElement;
                const totalTokens = calculateTotalTokens(stats);

                modelRow.appendChild(createCell(`└─ ${stats.modelName}`, 'model-cell'));
                modelRow.appendChild(createCell(formatTokens(stats.actualInput)));
                modelRow.appendChild(createCell(formatTokens(stats.cacheTokens)));
                modelRow.appendChild(createCell(formatTokens(stats.outputTokens)));
                modelRow.appendChild(createCell(formatTokens(totalTokens)));
                modelRow.appendChild(createCell(stats.requests));
                modelRow.appendChild(createCell(calculateAverageSpeed(stats)));

                const cell = modelRow.cells[0] as HTMLElement;
                cell.style.paddingLeft = '24px';
                cell.style.opacity = '0.85';
                tbody.appendChild(modelRow);
            });
        });

        // 添加合计行
        const totalRow = createElement('tr');
        totalRow.style.backgroundColor = 'var(--vscode-editor-selectionBackground)';
        totalRow.style.fontWeight = 'bold';
        totalRow.style.borderTop = '2px solid var(--vscode-editor-selectionForeground)';

        const grandTotal = totalInput + totalOutput;
        totalRow.appendChild(createCell('合计'));
        totalRow.appendChild(createCell(formatTokens(totalInput)));
        totalRow.appendChild(createCell(formatTokens(totalCache)));
        totalRow.appendChild(createCell(formatTokens(totalOutput)));
        totalRow.appendChild(createCell(formatTokens(grandTotal)));
        totalRow.appendChild(createCell(totalRequests));
        // 计算合计的平均速度
        let totalStreamDuration = 0;
        let totalValidStreamRequests = 0;
        let totalValidStreamOutputTokens = 0;
        providers.forEach(provider => {
            totalStreamDuration += provider.totalStreamDuration || 0;
            totalValidStreamRequests += provider.validStreamRequests || 0;
            totalValidStreamOutputTokens += provider.validStreamOutputTokens || 0;
        });
        const totalStats = {
            totalStreamDuration,
            validStreamRequests: totalValidStreamRequests,
            validStreamOutputTokens: totalValidStreamOutputTokens
        } as TokenStats;
        totalRow.appendChild(createCell(calculateAverageSpeed(totalStats)));

        tbody.appendChild(totalRow);
        table.appendChild(tbody);
        section.appendChild(table);
    } else {
        const empty = createElement('div', 'empty-message');
        empty.textContent = '暂无提供商数据';
        section.appendChild(empty);
    }

    return section;
}
