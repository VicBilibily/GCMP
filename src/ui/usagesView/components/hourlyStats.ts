/**
 * 小时统计组件
 * 负责渲染每小时的使用统计，包含提供商和模型详情
 */

import type { HourlyStats, ModelData, ProviderData } from '../types';
import { createElement } from '../../utils';
import { getDisplayCostPresentation } from '../../costDisplay';
import {
    formatTokens,
    calculateAverageSpeed,
    calculateAverageFirstTokenLatency,
    getStatsNativeCostSplit,
    getCurrencyToggleTitle,
    getDisplayCurrency,
    getProviderDisplayName,
    t
} from '../utils';

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
    cell.innerHTML = isBold ? `<strong>${value}</strong>` : value;
    return cell;
}

/**
 * 创建带内联成本的统计单元格
 * 上方显示 token 数，下方显示预估成本（2 位小数）
 */
function createTokensCell(
    tokens: number,
    usdCost: number | undefined,
    rmbCost: number | undefined,
    nativeUsdCost: number | undefined,
    nativeRmbCost: number | undefined,
    currency: ReturnType<typeof getDisplayCurrency>,
    isBold: boolean = false
): HTMLTableCellElement {
    const cell = createElement('td') as HTMLTableCellElement;
    const tokenStr = tokens > 0 ? formatTokens(tokens) : '-';
    const costPresentation = getDisplayCostPresentation({
        usd: usdCost,
        rmb: rmbCost,
        nativeUsd: nativeUsdCost,
        nativeRmb: nativeRmbCost,
        currency
    });
    const costStr = costPresentation.text;
    const tokenHtml = isBold ? `<strong>${tokenStr}</strong>` : tokenStr;
    if (costStr) {
        const costClass = costPresentation.toggleable ? 'tokens-cost' : 'tokens-cost tokens-cost-static';
        const costAttrs =
            `class="${costClass}"` +
            (costPresentation.toggleable ?
                ` data-toggle-cost-currency="true" title="${getCurrencyToggleTitle(currency)}"`
            :   '');
        const costHtml =
            currency === 'MIXED' && costPresentation.segments.length > 1 ?
                `<span class="tokens-cost-group">${costPresentation.segments
                    .map((segment, index) => {
                        const separator =
                            index === 0 ? '' : '<span class="tokens-cost-separator" aria-hidden="true">+</span>';
                        return `${separator}<span ${costAttrs}>${segment.text}</span>`;
                    })
                    .join('')}</span>`
            :   `<span ${costAttrs}>${costStr}</span>`;
        cell.innerHTML = [
            `<div class="tokens-row">${tokenHtml}</div>`,
            '<div class="tokens-detail">',
            costHtml,
            '</div>'
        ].join('');
    } else {
        cell.innerHTML = tokenHtml;
    }
    if (tokens > 0) {
        cell.title = tokens.toLocaleString('en-US');
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
    currency: ReturnType<typeof getDisplayCurrency>,
    nativeCosts: {
        inputUsd: number;
        inputRmb: number;
        outputUsd: number;
        outputRmb: number;
        cacheReadUsd: number;
        cacheReadRmb: number;
        cacheWriteUsd: number;
        cacheWriteRmb: number;
        totalUsd: number;
        totalRmb: number;
    },
    isBold: boolean = false
): void {
    const totalTokens = stats.actualInput + stats.outputTokens;
    const miss = (stats.actualInput || 0) - (stats.cacheTokens || 0);
    row.appendChild(
        createTokensCell(
            miss > 0 ? miss : stats.actualInput,
            (stats.inputCost || 0) + (stats.cacheWriteCost || 0),
            (stats.inputCostRmb || 0) + (stats.cacheWriteCostRmb || 0),
            nativeCosts.inputUsd + nativeCosts.cacheWriteUsd,
            nativeCosts.inputRmb + nativeCosts.cacheWriteRmb,
            currency,
            isBold
        )
    );
    row.appendChild(
        createTokensCell(
            stats.cacheTokens,
            stats.cacheReadCost,
            stats.cacheReadCostRmb,
            nativeCosts.cacheReadUsd,
            nativeCosts.cacheReadRmb,
            currency,
            isBold
        )
    );
    row.appendChild(
        createTokensCell(
            stats.outputTokens,
            stats.outputCost,
            stats.outputCostRmb,
            nativeCosts.outputUsd,
            nativeCosts.outputRmb,
            currency,
            isBold
        )
    );
    row.appendChild(
        createTokensCell(
            totalTokens,
            stats.estimatedCost,
            stats.estimatedCostRmb,
            nativeCosts.totalUsd,
            nativeCosts.totalRmb,
            currency,
            isBold
        )
    );
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
    currency: ReturnType<typeof getDisplayCurrency>,
    nativeCosts: {
        inputUsd: number;
        inputRmb: number;
        outputUsd: number;
        outputRmb: number;
        cacheReadUsd: number;
        cacheReadRmb: number;
        cacheWriteUsd: number;
        cacheWriteRmb: number;
        totalUsd: number;
        totalRmb: number;
    },
    isLast: boolean = false
): HTMLTableRowElement {
    const row = createElement('tr', 'hour-detail-row') as HTMLTableRowElement;

    const nameCell = createElement('td');
    const prefix = isLast ? '└─' : '├─';
    nameCell.innerHTML = `<span class="hour-detail"><strong>${prefix} ${String(hour).padStart(2, '0')}:00</strong></span>`;
    row.appendChild(nameCell);

    appendStatCells(row, stats, currency, nativeCosts, false);

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
    const nativeSplitIndex = window.usagesState?.dateDetails?.nativeSplitIndex;
    const currency = getDisplayCurrency();
    const table = createElement('table', 'hourly-stats-table');
    const thead = createElement('thead');
    const headerRow = createElement('tr');

    const headers = [
        t('Time', '时间'),
        t('Input', '输入Tokens'),
        t('Cache', '缓存命中'),
        t('Output', '输出Tokens'),
        t('Tokens', '消耗Tokens'),
        t('Requests', '请求次数'),
        t('Latency', '平均延迟'),
        t('Speed', '平均速度')
    ];
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

                appendStatCells(
                    row,
                    stats,
                    currency,
                    getStatsNativeCostSplit(stats, nativeSplitIndex?.hours[hour]),
                    false
                );

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
            nameCell.innerHTML = `<strong class="provider-name">📦 ${getProviderDisplayName(provider.providerKey, provider.providerName)}</strong>`;
            providerRow.appendChild(nameCell);

            appendStatCells(
                providerRow,
                provider,
                currency,
                getStatsNativeCostSplit(provider, nativeSplitIndex?.providers[provider.providerKey]),
                true
            );

            tbody.appendChild(providerRow);

            // 收集该提供商的所有小时数据
            const providerHourlyData: Array<[string, ProviderData]> = [];
            Object.entries(hourlyStats).forEach(([hour, stats]) => {
                if (!stats.providers) {
                    return;
                }
                // 使用 providerKey 查找
                const providerInHour = provider.providerKey ? stats.providers[provider.providerKey] : undefined;
                if (providerInHour && providerInHour.requests > 0) {
                    // 添加 providerKey 字段，转换为 ProviderData 类型
                    providerHourlyData.push([hour, { ...providerInHour, providerKey: provider.providerKey }]);
                }
            });

            providerHourlyData.sort(([a], [b]) => Number(a) - Number(b));
            providerHourlyData.forEach(([hour, hourStats], index) => {
                const isLast = index === providerHourlyData.length - 1;
                tbody.appendChild(
                    createHourDetailRow(
                        hour,
                        hourStats,
                        currency,
                        getStatsNativeCostSplit(
                            hourStats,
                            nativeSplitIndex?.hourProviders[hour]?.[provider.providerKey]
                        ),
                        isLast
                    )
                );
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
            nameCell.innerHTML = `<strong class="provider-name">📦 ${getProviderDisplayName(provider.providerKey, provider.providerName)}</strong>`;
            providerRow.appendChild(nameCell);

            appendStatCells(
                providerRow,
                provider,
                currency,
                getStatsNativeCostSplit(provider, nativeSplitIndex?.providers[provider.providerKey]),
                true
            );

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

                appendStatCells(
                    modelRow,
                    modelData,
                    currency,
                    getStatsNativeCostSplit(modelData, nativeSplitIndex?.models[provider.providerKey]?.[modelId]),
                    true
                );

                tbody.appendChild(modelRow);

                const modelHourlyData: Array<[string, ModelData]> = [];
                Object.entries(hourlyStats).forEach(([hour, stats]) => {
                    if (!stats.providers) {
                        return;
                    }
                    const providerInHour = provider.providerKey ? stats.providers[provider.providerKey] : undefined;
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

                    appendStatCells(
                        hourRow,
                        hourStats,
                        currency,
                        getStatsNativeCostSplit(
                            hourStats,
                            nativeSplitIndex?.hourModels[hour]?.[provider.providerKey]?.[modelId]
                        ),
                        false
                    );

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
    h2.textContent = t('Hourly Usage', '各小时用量');
    section.appendChild(h2);

    if (!hourlyStats || Object.keys(hourlyStats).length === 0) {
        const empty = createElement('div', 'empty-message');
        empty.textContent = t('No hourly statistics available', '暂无小时统计数据');
        section.appendChild(empty);
        return section;
    }

    // 创建切换按钮
    const toggleContainer = createElement('div', 'stats-toggle-container');
    const hourButton = createElement('button', 'stats-toggle-button active');
    hourButton.textContent = `📊 ${t('Hours', '小时')}`;
    const providerButton = createElement('button', 'stats-toggle-button');
    providerButton.textContent = `📦 ${t('Providers', '提供商')}`;
    const modelButton = createElement('button', 'stats-toggle-button');
    modelButton.textContent = `🔧 ${t('Models', '模型')}`;
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
