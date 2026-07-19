/**
 * 提供商统计组件
 * 负责渲染提供商和模型列表
 */

import type { ProviderData } from '../types';
import { createElement } from '../../utils';
import { TokenStats } from '../../../usages/fileLogger/types';
import { createEmptyNativeCostSplit, mergeNativeCostSplit } from '../../../usages/fileLogger/nativeCostSplit';
import { getDisplayCostPresentation } from '../../costDisplay';
import { sumCosts } from '../../../utils/pricing/pricingCurrency';
import {
    calculateTotalTokens,
    formatTokens,
    getStatsNativeCostSplit,
    calculateAverageSpeed,
    calculateAverageFirstTokenLatency,
    getCurrencyToggleTitle,
    getDisplayCurrency,
    getProviderDisplayName,
    t
} from '../utils';

export function buildProviderStatsTotalNativeSplit(
    providers: ProviderData[]
): ReturnType<typeof createEmptyNativeCostSplit> {
    const nativeSplitIndex = window.usagesState?.dateDetails?.nativeSplitIndex;
    const totalNativeSplit = createEmptyNativeCostSplit();

    providers.forEach(provider => {
        mergeNativeCostSplit(
            totalNativeSplit,
            getStatsNativeCostSplit(provider, nativeSplitIndex?.providers[provider.providerKey])
        );
    });

    return totalNativeSplit;
}

// ============= 工具函数 =============

/**
 * 创建表格单元格
 */
function createCell(content: string | number, className = '', title?: string): HTMLElement {
    const cell = createElement('td');
    if (className) {
        cell.className = className;
    }
    cell.textContent = String(content);
    if (title) {
        cell.title = title;
    }
    return cell;
}

function formatRequestBreakdown(completed: number, failed: number, cancelled: number): string {
    return `✅ ${completed} | ❌ ${failed} | 🚫 ${cancelled}`;
}

/**
 * 创建带内联成本的 Tokens 单元格
 * 上方显示 token 数，下方显示预估成本
 */
function createTokensCell(
    tokens: number,
    usdCost: number | undefined,
    rmbCost: number | undefined,
    nativeUsdCost: number | undefined,
    nativeRmbCost: number | undefined,
    currency: ReturnType<typeof getDisplayCurrency>
): HTMLElement {
    const cell = createElement('td');
    const tokenStr = tokens > 0 ? formatTokens(tokens) : '-';
    const costPresentation = getDisplayCostPresentation({
        usd: usdCost,
        rmb: rmbCost,
        nativeUsd: nativeUsdCost,
        nativeRmb: nativeRmbCost,
        currency,
        fixedDecimals: 2
    });
    const costStr = costPresentation.text;
    if (costStr) {
        const costAttrs = `class="tokens-cost" data-toggle-cost-currency="true" title="${getCurrencyToggleTitle(currency)}"`;
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
            `<div class="tokens-row">${tokenStr}</div>`,
            '<div class="tokens-detail">',
            costHtml,
            '</div>'
        ].join('');
    } else {
        cell.textContent = tokenStr;
    }
    if (tokens > 0) {
        cell.title = tokens.toLocaleString('en-US');
    }
    return cell;
}

// ============= 组件渲染 =============

/**
 * 创建提供商统计区域
 */
export function createProviderStats(providers: ProviderData[]): HTMLElement {
    const section = createElement('section', 'provider-stats-section');
    const dateDetails = window.usagesState?.dateDetails;
    const nativeSplitIndex = dateDetails?.nativeSplitIndex;
    const currency = getDisplayCurrency();

    const h2 = createElement('h2');
    h2.textContent = t('By Provider', '按提供商统计');
    section.appendChild(h2);

    if (providers && providers.length > 0) {
        const table = createElement('table', 'provider-stats-table');
        const thead = createElement('thead');
        const headerRow = createElement('tr');

        const headers = [
            t('Provider / Model', '提供商/模型'),
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

        // 计算合计数据
        let totalInput = 0;
        let totalCache = 0;
        let totalOutput = 0;
        let totalRequests = 0;
        let totalCompletedRequests = 0;
        let totalFailedRequests = 0;
        let totalCancelledRequests = 0;
        let totalCost = 0;
        let totalCostRmb = 0;
        let totalInputCost = 0;
        let totalInputCostRmb = 0;
        let totalCacheReadCost = 0;
        let totalCacheReadCostRmb = 0;
        let totalCacheWriteCost = 0;
        let totalCacheWriteCostRmb = 0;
        let totalOutputCost = 0;
        let totalOutputCostRmb = 0;
        let totalCostedRequests = 0;
        let totalRmbExactRequests = 0;
        const totalNativeSplit = buildProviderStatsTotalNativeSplit(providers);

        providers.forEach(provider => {
            // 累加合计数据
            const nonCacheInput = Math.max(0, (provider.actualInput || 0) - (provider.cacheTokens || 0));
            const providerSplit = getStatsNativeCostSplit(provider, nativeSplitIndex?.providers[provider.providerKey]);
            totalInput += nonCacheInput;
            totalCache += provider.cacheTokens || 0;
            totalOutput += provider.outputTokens || 0;
            totalRequests += provider.requests || 0;
            totalCompletedRequests += provider.completedRequests || 0;
            totalFailedRequests += provider.failedRequests || 0;
            totalCancelledRequests += provider.cancelledRequests || 0;
            totalCost = sumCosts([totalCost, provider.estimatedCost]);
            totalCostRmb = sumCosts([totalCostRmb, provider.estimatedCostRmb]);
            totalInputCost = sumCosts([totalInputCost, provider.inputCost]);
            totalInputCostRmb = sumCosts([totalInputCostRmb, provider.inputCostRmb]);
            totalCacheReadCost = sumCosts([totalCacheReadCost, provider.cacheReadCost]);
            totalCacheReadCostRmb = sumCosts([totalCacheReadCostRmb, provider.cacheReadCostRmb]);
            totalCacheWriteCost = sumCosts([totalCacheWriteCost, provider.cacheWriteCost]);
            totalCacheWriteCostRmb = sumCosts([totalCacheWriteCostRmb, provider.cacheWriteCostRmb]);
            totalOutputCost = sumCosts([totalOutputCost, provider.outputCost]);
            totalOutputCostRmb = sumCosts([totalOutputCostRmb, provider.outputCostRmb]);
            totalCostedRequests += provider.costedRequests || 0;
            totalRmbExactRequests += provider.rmbExactRequests || 0;

            // 提供商行
            const providerRow = createElement('tr');
            providerRow.style.backgroundColor = 'var(--vscode-editor-inactiveSelectionBackground)';
            providerRow.style.fontWeight = 'bold';

            const totalTokens = calculateTotalTokens(provider);

            providerRow.appendChild(createCell(getProviderDisplayName(provider.providerKey, provider.providerName)));
            providerRow.appendChild(
                createTokensCell(
                    nonCacheInput,
                    (provider.inputCost || 0) + (provider.cacheWriteCost || 0),
                    (provider.inputCostRmb || 0) + (provider.cacheWriteCostRmb || 0),
                    (providerSplit?.inputUsd || 0) + (providerSplit?.cacheWriteUsd || 0),
                    (providerSplit?.inputRmb || 0) + (providerSplit?.cacheWriteRmb || 0),
                    currency
                )
            );
            providerRow.appendChild(
                createTokensCell(
                    provider.cacheTokens,
                    provider.cacheReadCost,
                    provider.cacheReadCostRmb,
                    providerSplit?.cacheReadUsd,
                    providerSplit?.cacheReadRmb,
                    currency
                )
            );
            providerRow.appendChild(
                createTokensCell(
                    provider.outputTokens,
                    provider.outputCost,
                    provider.outputCostRmb,
                    providerSplit?.outputUsd,
                    providerSplit?.outputRmb,
                    currency
                )
            );
            providerRow.appendChild(
                createTokensCell(
                    totalTokens,
                    provider.estimatedCost,
                    provider.estimatedCostRmb,
                    providerSplit?.totalUsd,
                    providerSplit?.totalRmb,
                    currency
                )
            );
            providerRow.appendChild(
                createCell(
                    provider.requests,
                    '',
                    formatRequestBreakdown(
                        provider.completedRequests || 0,
                        provider.failedRequests || 0,
                        provider.cancelledRequests || 0
                    )
                )
            );
            providerRow.appendChild(createCell(calculateAverageFirstTokenLatency(provider)));
            providerRow.appendChild(createCell(calculateAverageSpeed(provider)));

            tbody.appendChild(providerRow);

            // 模型行
            Object.entries(provider.models).forEach(([modelId, stats]) => {
                const modelRow = createElement('tr') as HTMLTableRowElement;
                const totalTokens = calculateTotalTokens(stats);
                const modelNonCacheInput = Math.max(0, (stats.actualInput || 0) - (stats.cacheTokens || 0));
                const modelSplit = getStatsNativeCostSplit(
                    stats,
                    nativeSplitIndex?.models[provider.providerKey]?.[modelId]
                );

                modelRow.appendChild(createCell(`└─ ${stats.modelName}`, 'model-cell'));
                modelRow.appendChild(
                    createTokensCell(
                        modelNonCacheInput,
                        (stats.inputCost || 0) + (stats.cacheWriteCost || 0),
                        (stats.inputCostRmb || 0) + (stats.cacheWriteCostRmb || 0),
                        (modelSplit?.inputUsd || 0) + (modelSplit?.cacheWriteUsd || 0),
                        (modelSplit?.inputRmb || 0) + (modelSplit?.cacheWriteRmb || 0),
                        currency
                    )
                );
                modelRow.appendChild(
                    createTokensCell(
                        stats.cacheTokens,
                        stats.cacheReadCost,
                        stats.cacheReadCostRmb,
                        modelSplit?.cacheReadUsd,
                        modelSplit?.cacheReadRmb,
                        currency
                    )
                );
                modelRow.appendChild(
                    createTokensCell(
                        stats.outputTokens,
                        stats.outputCost,
                        stats.outputCostRmb,
                        modelSplit?.outputUsd,
                        modelSplit?.outputRmb,
                        currency
                    )
                );
                modelRow.appendChild(
                    createTokensCell(
                        totalTokens,
                        stats.estimatedCost,
                        stats.estimatedCostRmb,
                        modelSplit?.totalUsd,
                        modelSplit?.totalRmb,
                        currency
                    )
                );
                modelRow.appendChild(createCell(stats.requests));
                modelRow.appendChild(createCell(calculateAverageFirstTokenLatency(stats)));
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

        const grandTotal = totalInput + totalCache + totalOutput;
        const totalSplit = totalNativeSplit;
        totalRow.appendChild(createCell(t('Total', '合计')));
        totalRow.appendChild(
            createTokensCell(
                totalInput,
                totalInputCost + totalCacheWriteCost,
                totalInputCostRmb + totalCacheWriteCostRmb,
                totalSplit.inputUsd + totalSplit.cacheWriteUsd,
                totalSplit.inputRmb + totalSplit.cacheWriteRmb,
                currency
            )
        );
        totalRow.appendChild(
            createTokensCell(
                totalCache,
                totalCacheReadCost,
                totalCacheReadCostRmb,
                totalSplit.cacheReadUsd,
                totalSplit.cacheReadRmb,
                currency
            )
        );
        totalRow.appendChild(
            createTokensCell(
                totalOutput,
                totalOutputCost,
                totalOutputCostRmb,
                totalSplit.outputUsd,
                totalSplit.outputRmb,
                currency
            )
        );
        totalRow.appendChild(
            createTokensCell(grandTotal, totalCost, totalCostRmb, totalSplit.totalUsd, totalSplit.totalRmb, currency)
        );
        totalRow.appendChild(
            createCell(
                totalRequests,
                '',
                formatRequestBreakdown(totalCompletedRequests, totalFailedRequests, totalCancelledRequests)
            )
        );
        const mean = (values: number[]): number => {
            const cleaned = values.filter(v => Number.isFinite(v) && v > 0);
            if (cleaned.length === 0) {
                return 0;
            }
            return cleaned.reduce((sum, v) => sum + v, 0) / cleaned.length;
        };

        // 合计口径：对“所有模型”的已聚合指标做算术平均（与 speed 聚合口径保持一致）。
        const allModelSpeeds: number[] = [];
        const allModelLatencies: number[] = [];
        providers.forEach(provider => {
            Object.values(provider.models).forEach(model => {
                if (model.outputSpeeds && model.outputSpeeds > 0) {
                    allModelSpeeds.push(model.outputSpeeds);
                }
                if (model.firstTokenLatency && model.firstTokenLatency > 0) {
                    allModelLatencies.push(model.firstTokenLatency);
                }
            });
        });

        const totalStats = {
            estimatedInput: 0,
            actualInput: 0,
            cacheTokens: 0,
            outputTokens: 0,
            requests: 0,
            costedRequests: totalCostedRequests,
            rmbExactRequests: totalRmbExactRequests,
            completedRequests: totalCompletedRequests,
            failedRequests: totalFailedRequests,
            cancelledRequests: totalCancelledRequests,
            estimatedCost: totalCost,
            estimatedCostRmb: totalCostRmb,
            inputCost: totalInputCost,
            inputCostRmb: totalInputCostRmb,
            outputCost: totalOutputCost,
            outputCostRmb: totalOutputCostRmb,
            cacheReadCost: totalCacheReadCost,
            cacheReadCostRmb: totalCacheReadCostRmb,
            cacheWriteCost: totalCacheWriteCost,
            cacheWriteCostRmb: totalCacheWriteCostRmb,
            firstTokenLatency: mean(allModelLatencies),
            outputSpeeds: mean(allModelSpeeds)
        } as TokenStats;

        totalRow.appendChild(createCell(calculateAverageFirstTokenLatency(totalStats)));
        totalRow.appendChild(createCell(calculateAverageSpeed(totalStats)));

        tbody.appendChild(totalRow);
        table.appendChild(tbody);
        section.appendChild(table);
    } else {
        const empty = createElement('div', 'empty-message');
        empty.textContent = t('No provider data available', '暂无提供商数据');
        section.appendChild(empty);
    }

    return section;
}
