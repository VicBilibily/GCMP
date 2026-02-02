/**
 * 小时统计组件
 * 负责渲染每小时的使用统计，包含提供商和模型详情
 */

import type { HourlyStats, ModelData, ProviderData } from '../types';
import { createElement } from '../../utils';
import { formatTokens, calculateAverageSpeed, calculateAverageFirstTokenLatency } from '../utils';

// ============= 类型定义 =============

type ViewMode = 'hour' | 'provider' | 'model';

// 保存当前选择的视图模式
let currentViewMode: ViewMode = 'hour';

// ============= 辅助函数 =============

/**
 * 创建统计单元格
 * @param value 单元格值
 * @param isBold 是否加粗
 * @returns HTMLTableCellElement
 */
function createStatCell(value: string, isBold: boolean = false): HTMLTableCellElement {
    const cell = createElement('td') as HTMLTableCellElement;
    if (isBold) {
        cell.innerHTML = `<strong>${value}</strong>`;
    } else {
        cell.textContent = value;
    }
    return cell;
}

/**
 * 为行添加统计单元格（输入、缓存、输出、总计、请求次数、延迟、速度）
 * @param row 表格行
 * @param stats 统计数据
 * @param isBold 是否加粗
 */
function appendStatCells(
    row: HTMLTableRowElement,
    stats: ProviderData | ModelData | HourlyStats,
    isBold: boolean = false
): void {
    const totalTokens = stats.actualInput + stats.outputTokens;
    row.appendChild(createStatCell(formatTokens(stats.actualInput), isBold));
    row.appendChild(createStatCell(formatTokens(stats.cacheTokens), isBold));
    row.appendChild(createStatCell(formatTokens(stats.outputTokens), isBold));
    row.appendChild(createStatCell(formatTokens(totalTokens), isBold));
    row.appendChild(createStatCell(String(stats.requests), isBold));
    row.appendChild(createStatCell(calculateAverageFirstTokenLatency(stats), isBold));
    row.appendChild(createStatCell(calculateAverageSpeed(stats), isBold));
}

// ============= 组件渲染 =============

/**
 * 创建小时明细行（用于提供商/模型模式下显示某小时的数据）
 */
function createHourDetailRow(
    hour: string,
    stats: ProviderData | ModelData,
    isLast: boolean = false
): HTMLTableRowElement {
    const row = createElement('tr', 'hour-detail-row') as HTMLTableRowElement;

    const nameCell = createElement('td');
    const prefix = isLast ? '└─' : '├─';
    nameCell.innerHTML = `<span class="hour-detail"><strong>${prefix} ${String(hour).padStart(2, '0')}:00</strong></span>`;
    row.appendChild(nameCell);

    appendStatCells(row, stats, false);

    return row;
}

/**
 * 渲染表格内容
 */
function renderTable(
    tableContainer: HTMLElement,
    providers: ProviderData[],
    hourlyStats: Record<string, HourlyStats>,
    mode: ViewMode
): void {
    tableContainer.innerHTML = '';
    const table = createElement('table', 'hourly-stats-table');
    const thead = createElement('thead');
    const headerRow = createElement('tr');

    const headers = ['时间', '输入Tokens', '缓存命中', '输出Tokens', '消耗Tokens', '请求次数', '平均延迟', '平均速度'];
    headers.forEach(h => {
        const th = createElement('th');
        th.textContent = h;
        headerRow.appendChild(th);
    });
    thead.appendChild(headerRow);
    table.appendChild(thead);

    const tbody = createElement('tbody');

    if (mode === 'hour') {
        // 模式1: 按小时列表
        Object.entries(hourlyStats)
            .sort(([a], [b]) => Number(a) - Number(b))
            .forEach(([hour, stats]) => {
                if (stats.requests === 0) {
                    return;
                }

                const row = createElement('tr', 'hour-row') as HTMLTableRowElement;

                const timeCell = createElement('td');
                timeCell.innerHTML = `<strong>${String(hour).padStart(2, '0')}:00</strong>`;
                row.appendChild(timeCell);

                appendStatCells(row, stats, false);

                tbody.appendChild(row);
            });
    } else if (mode === 'provider') {
        // 模式2: 按提供商分组
        providers.forEach(provider => {
            if (provider.requests === 0) {
                return;
            }

            const providerRow = createElement('tr', 'provider-row') as HTMLTableRowElement;
            const nameCell = createElement('td');
            nameCell.innerHTML = `<strong class="provider-name">📦 ${provider.providerName}</strong>`;
            providerRow.appendChild(nameCell);

            appendStatCells(providerRow, provider, true);

            tbody.appendChild(providerRow);

            // 收集该提供商的所有小时数据
            const providerHourlyData: Array<[string, ProviderData]> = [];
            Object.entries(hourlyStats).forEach(([hour, stats]) => {
                if (!stats.providers) {
                    return;
                }
                const providerInHour = Object.values(stats.providers).find(
                    p => p.providerName === provider.providerName
                );
                if (providerInHour && providerInHour.requests > 0) {
                    providerHourlyData.push([hour, providerInHour]);
                }
            });

            providerHourlyData.sort(([a], [b]) => Number(a) - Number(b));
            providerHourlyData.forEach(([hour, hourStats], index) => {
                const isLast = index === providerHourlyData.length - 1;
                tbody.appendChild(createHourDetailRow(hour, hourStats, isLast));
            });
        });
    } else if (mode === 'model') {
        // 模式3: 按提供商→模型分组
        providers.forEach(provider => {
            if (provider.requests === 0) {
                return;
            }

            const providerRow = createElement('tr', 'provider-row') as HTMLTableRowElement;
            const nameCell = createElement('td');
            nameCell.innerHTML = `<strong class="provider-name">📦 ${provider.providerName}</strong>`;
            providerRow.appendChild(nameCell);

            appendStatCells(providerRow, provider, true);

            tbody.appendChild(providerRow);

            const modelEntries = Object.entries(provider.models).sort(([, a], [, b]) => b.requests - a.requests);

            modelEntries.forEach(([modelId, modelData], modelIndex) => {
                if (modelData.requests === 0) {
                    return;
                }

                const isLastModel = modelIndex === modelEntries.length - 1;

                const modelRow = createElement('tr', 'model-row') as HTMLTableRowElement;
                const modelNameCell = createElement('td');
                const modelPrefix = isLastModel ? '└─' : '├─';
                modelNameCell.innerHTML = `<span class="model-name"><strong>${modelPrefix} 🔧 ${modelData.modelName}</strong></span>`;
                modelRow.appendChild(modelNameCell);

                appendStatCells(modelRow, modelData, true);

                tbody.appendChild(modelRow);

                const modelHourlyData: Array<[string, ModelData]> = [];
                Object.entries(hourlyStats).forEach(([hour, stats]) => {
                    if (!stats.providers) {
                        return;
                    }
                    const providerInHour = Object.values(stats.providers).find(
                        p => p.providerName === provider.providerName
                    );
                    if (providerInHour && providerInHour.models && providerInHour.models[modelId]) {
                        const modelStats = providerInHour.models[modelId];
                        if (modelStats.requests > 0) {
                            modelHourlyData.push([hour, modelStats]);
                        }
                    }
                });

                modelHourlyData.sort(([a], [b]) => Number(a) - Number(b));
                modelHourlyData.forEach(([hour, hourStats], hourIndex) => {
                    const isLastHour = hourIndex === modelHourlyData.length - 1;
                    const hourRow = createElement('tr', 'hour-detail-row model-hour-detail') as HTMLTableRowElement;

                    const hourNameCell = createElement('td');
                    const hourPrefix = isLastHour ? '└─' : '├─';
                    hourNameCell.innerHTML = `<span class="hour-detail"><strong>${hourPrefix} ${String(hour).padStart(2, '0')}:00</strong></span>`;
                    hourRow.appendChild(hourNameCell);

                    appendStatCells(hourRow, hourStats, false);

                    tbody.appendChild(hourRow);
                });
            });
        });
    }

    table.appendChild(tbody);
    tableContainer.appendChild(table);
}

/**
 * 创建小时统计区域
 * 如果容器已存在，只更新数据；否则创建新组件
 */
export function createHourlyStats(
    providers: ProviderData[],
    hourlyStats: Record<string, HourlyStats>,
    existingContainer?: HTMLElement
): HTMLElement {
    // 如果传入了已存在的容器，只更新数据
    if (existingContainer) {
        const tableContainer = existingContainer.querySelector('.table-container') as HTMLElement;
        if (tableContainer) {
            // 容器存在，只更新表格数据
            setTimeout(() => {
                renderTable(tableContainer, providers, hourlyStats, currentViewMode);
            }, 0);
            return existingContainer;
        }
    }

    // 创建新容器
    const section = createElement('section', 'hourly-stats-section');

    const h2 = createElement('h2');
    h2.textContent = '各小时用量';
    section.appendChild(h2);

    if (!hourlyStats || Object.keys(hourlyStats).length === 0) {
        const empty = createElement('div', 'empty-message');
        empty.textContent = '暂无小时统计数据';
        section.appendChild(empty);
        return section;
    }

    // 创建切换按钮
    const toggleContainer = createElement('div', 'stats-toggle-container');
    const hourButton = createElement('button', 'stats-toggle-button active');
    hourButton.textContent = '📊 小时';
    const providerButton = createElement('button', 'stats-toggle-button');
    providerButton.textContent = '📦 提供商';
    const modelButton = createElement('button', 'stats-toggle-button');
    modelButton.textContent = '🔧 模型';
    toggleContainer.appendChild(hourButton);
    toggleContainer.appendChild(providerButton);
    toggleContainer.appendChild(modelButton);
    section.appendChild(toggleContainer);

    // 创建表格容器
    const tableContainer = createElement('div', 'table-container');

    // 初始渲染（使用保存的模式）
    renderTable(tableContainer, providers, hourlyStats, currentViewMode);

    section.appendChild(tableContainer);

    // 添加切换事件
    setTimeout(() => {
        hourButton.onclick = () => {
            currentViewMode = 'hour';
            hourButton.classList.add('active');
            providerButton.classList.remove('active');
            modelButton.classList.remove('active');
            renderTable(tableContainer, providers, hourlyStats, 'hour');
        };

        providerButton.onclick = () => {
            currentViewMode = 'provider';
            providerButton.classList.add('active');
            hourButton.classList.remove('active');
            modelButton.classList.remove('active');
            renderTable(tableContainer, providers, hourlyStats, 'provider');
        };

        modelButton.onclick = () => {
            currentViewMode = 'model';
            modelButton.classList.add('active');
            hourButton.classList.remove('active');
            providerButton.classList.remove('active');
            renderTable(tableContainer, providers, hourlyStats, 'model');
        };
    }, 100);

    return section;
}
