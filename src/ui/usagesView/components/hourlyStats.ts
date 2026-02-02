/**
 * 小时统计组件
 * 负责渲染每小时的使用统计，包含提供商和模型详情
 */

import type { HourlyStats, ModelData, ProviderData } from '../types';
import { createElement } from '../../utils';
import { formatTokens, calculateAverageSpeed, calculateAverageFirstTokenLatency } from '../utils';

// ============= 组件渲染 =============

/**
 * 创建模型统计行
 */
function createModelRow(modelName: string, stats: ModelData, isLast: boolean = false): HTMLTableRowElement {
    const row = createElement('tr', 'model-row') as HTMLTableRowElement;

    const nameCell = createElement('td');
    const prefix = isLast ? '└─' : '├─';
    nameCell.innerHTML = `<span class="model-name">${prefix} ${modelName}</span>`;
    row.appendChild(nameCell);

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
    totalCell.textContent = formatTokens(stats.actualInput + stats.outputTokens);
    row.appendChild(totalCell);

    const requestsCell = createElement('td');
    requestsCell.textContent = String(stats.requests);
    row.appendChild(requestsCell);

    const latencyCell = createElement('td');
    latencyCell.textContent = calculateAverageFirstTokenLatency(stats);
    row.appendChild(latencyCell);

    const speedCell = createElement('td');
    speedCell.textContent = calculateAverageSpeed(stats);
    row.appendChild(speedCell);

    return row;
}

/**
 * 创建提供商统计行（包含其下的模型）
 */
function createProviderRows(providerName: string, providerStats: ProviderData): HTMLTableRowElement[] {
    const rows: HTMLTableRowElement[] = [];

    // 如果提供商没有有效请求，不显示
    if (providerStats.requests === 0 || providerStats.outputTokens === 0) {
        return rows;
    }

    // 创建提供商汇总行
    const providerRow = createElement('tr', 'provider-row') as HTMLTableRowElement;
    const nameCell = createElement('td');
    nameCell.innerHTML = `<strong class="provider-name">📦 ${providerName}</strong>`;
    providerRow.appendChild(nameCell);

    // 计算提供商总计
    const providerTotal = {
        estimatedInput: 0,
        actualInput: 0,
        cacheTokens: 0,
        outputTokens: 0,
        requests: 0,
        totalStreamDuration: 0,
        validStreamRequests: 0,
        validStreamOutputTokens: 0,
        totalFirstTokenLatency: 0
    };

    Object.values(providerStats.models).forEach(model => {
        providerTotal.estimatedInput += model.estimatedInput;
        providerTotal.actualInput += model.actualInput;
        providerTotal.cacheTokens += model.cacheTokens;
        providerTotal.outputTokens += model.outputTokens;
        providerTotal.requests += model.requests;
        providerTotal.totalStreamDuration += model.totalStreamDuration || 0;
        providerTotal.validStreamRequests += model.validStreamRequests || 0;
        providerTotal.validStreamOutputTokens += model.validStreamOutputTokens || 0;
        providerTotal.totalFirstTokenLatency += model.totalFirstTokenLatency || 0;
    });

    const inputCell = createElement('td');
    inputCell.innerHTML = `<strong>${formatTokens(providerTotal.actualInput)}</strong>`;
    providerRow.appendChild(inputCell);

    const cacheCell = createElement('td');
    cacheCell.innerHTML = `<strong>${formatTokens(providerTotal.cacheTokens)}</strong>`;
    providerRow.appendChild(cacheCell);

    const outputCell = createElement('td');
    outputCell.innerHTML = `<strong>${formatTokens(providerTotal.outputTokens)}</strong>`;
    providerRow.appendChild(outputCell);

    const totalCell = createElement('td');
    totalCell.innerHTML = `<strong>${formatTokens(providerTotal.actualInput + providerTotal.outputTokens)}</strong>`;
    providerRow.appendChild(totalCell);

    const requestsCell = createElement('td');
    requestsCell.innerHTML = `<strong>${String(providerTotal.requests)}</strong>`;
    providerRow.appendChild(requestsCell);

    const latencyCell = createElement('td');
    latencyCell.innerHTML = `<strong>${calculateAverageFirstTokenLatency(providerTotal)}</strong>`;
    providerRow.appendChild(latencyCell);

    const speedCell = createElement('td');
    speedCell.innerHTML = `<strong>${calculateAverageSpeed(providerTotal)}</strong>`;
    providerRow.appendChild(speedCell);

    rows.push(providerRow);

    // 创建模型行
    const modelEntries = Object.entries(providerStats.models).sort(([, a], [, b]) => b.requests - a.requests); // 按请求数降序排列

    modelEntries.forEach(([_modelId, modelStats], index) => {
        if (modelStats.requests > 0) {
            const isLast = index === modelEntries.length - 1;
            rows.push(createModelRow(modelStats.modelName, modelStats, isLast));
        }
    });

    return rows;
}

/**
 * 创建小时统计区域
 */
export function createHourlyStats(hourlyStats: Record<string, HourlyStats>): HTMLElement {
    const section = createElement('section');

    const h2 = createElement('h2');
    h2.textContent = '各小时用量';
    section.appendChild(h2);

    if (hourlyStats && Object.keys(hourlyStats).length > 0) {
        const table = createElement('table', 'hourly-stats-table');
        const thead = createElement('thead');
        const headerRow = createElement('tr');

        const headers = [
            '时间',
            '输入Tokens',
            '缓存命中',
            '输出Tokens',
            '消耗Tokens',
            '请求次数',
            '平均延迟',
            '平均速度'
        ];
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

                const totalTokens = stats.actualInput + stats.outputTokens;

                // 创建小时汇总行
                const hourRow = createElement('tr', 'hour-row') as HTMLTableRowElement;

                const timeCell = createElement('td');
                timeCell.innerHTML = `<strong class="hour-title">⏰ ${String(hour).padStart(2, '0')}:00</strong>`;
                hourRow.appendChild(timeCell);

                const inputCell = createElement('td');
                inputCell.innerHTML = `<strong>${formatTokens(stats.actualInput)}</strong>`;
                hourRow.appendChild(inputCell);

                const cacheCell = createElement('td');
                cacheCell.innerHTML = `<strong>${formatTokens(stats.cacheTokens)}</strong>`;
                hourRow.appendChild(cacheCell);

                const outputCell = createElement('td');
                outputCell.innerHTML = `<strong>${formatTokens(stats.outputTokens)}</strong>`;
                hourRow.appendChild(outputCell);

                const totalCell = createElement('td');
                totalCell.innerHTML = `<strong>${formatTokens(totalTokens)}</strong>`;
                hourRow.appendChild(totalCell);

                const requestsCell = createElement('td');
                requestsCell.innerHTML = `<strong>${String(stats.requests)}</strong>`;
                hourRow.appendChild(requestsCell);

                const latencyCell = createElement('td');
                latencyCell.innerHTML = `<strong>${calculateAverageFirstTokenLatency(stats)}</strong>`;
                hourRow.appendChild(latencyCell);

                const speedCell = createElement('td');
                speedCell.innerHTML = `<strong>${calculateAverageSpeed(stats)}</strong>`;
                hourRow.appendChild(speedCell);

                tbody.appendChild(hourRow);

                // 添加提供商和模型详情行
                if (stats.providers && Object.keys(stats.providers).length > 0) {
                    Object.entries(stats.providers)
                        .sort(([, a], [, b]) => b.requests - a.requests) // 按请求数降序排列
                        .forEach(([_providerId, providerStats]) => {
                            if (providerStats.requests > 0) {
                                const providerRows = createProviderRows(providerStats.providerName, providerStats);
                                providerRows.forEach(row => tbody.appendChild(row));
                            }
                        });
                }
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
