import Chart from 'chart.js/auto';
import { createEmptyNativeCostSplit, mergeNativeCostSplit } from '../../../usages/fileLogger/nativeCostSplit';
import type { NativeCostSplit } from '../../../usages/fileLogger/types';
import type { MultiDayAnalysisResult } from '../../../usages/multiDay/types';
import type { MultiDayRenderOptions } from '../types';
import { formatDisplayCostAmount } from '../../costDisplay';
import { t } from '../../usagesView/utils';
import { createElement, formatTokens } from '../../utils';

const COLORS = ['#4a90d9', '#50c878', '#ff8c42', '#9b59b6', '#e74c3c', '#1abc9c', '#f39c12', '#3498db'];

export function createProviderModelRank(data: MultiDayAnalysisResult, options: MultiDayRenderOptions): HTMLElement {
    const container = createElement('div', 'provider-model-rank');

    const left = createElement('div', 'rank-left');
    const donutTitle = createElement('h3', 'chart-section-title');
    donutTitle.textContent = t('Provider Share', '提供商占比');
    left.appendChild(donutTitle);
    const canvas = document.createElement('canvas');
    canvas.id = 'chart-provider-donut';
    const chartW = createElement('div', 'donut-chart');
    chartW.appendChild(canvas);
    left.appendChild(chartW);
    const table = createDonutTable(data.providerRanking, 'name', options);
    left.appendChild(table);
    container.appendChild(left);

    const right = createElement('div', 'rank-right');
    const modelTitle = createElement('h3', 'chart-section-title');
    modelTitle.textContent = t('Model Share', '模型占比');
    right.appendChild(modelTitle);
    const modelCanvas = document.createElement('canvas');
    modelCanvas.id = 'chart-model-donut';
    const modelChartW = createElement('div', 'donut-chart');
    modelChartW.appendChild(modelCanvas);
    right.appendChild(modelChartW);
    const modelTable = createDonutTable(data.modelRanking, 'name', options, true);
    right.appendChild(modelTable);
    container.appendChild(right);

    setTimeout(() => {
        renderDonut(canvas.id, data.providerRanking, 'name');
        renderDonut(modelCanvas.id, data.modelRanking, 'name');
    }, 0);

    return container;
}

function createDonutTable(
    items: Array<Record<string, unknown>>,
    nameKey: string,
    options: MultiDayRenderOptions,
    showProvider = false
): HTMLElement {
    const totalTokens = items.reduce((sum, item) => sum + (item.totalTokens as number) || 0, 0) || 1;
    const table = document.createElement('table');
    table.className = 'donut-table';
    const headCells =
        (showProvider ? '<th>' + t('Provider', '提供商') + '</th>' : '') +
        '<th>' +
        t('Name', '名称') +
        '</th>' +
        '<th>' +
        t('Input', '输入') +
        '</th>' +
        '<th>' +
        t('Cache', '缓存') +
        '</th>' +
        '<th>' +
        t('Output', '输出') +
        '</th>' +
        '<th>' +
        t('Tokens', '消耗') +
        '</th>' +
        '<th>%</th>';
    table.innerHTML = '<thead><tr>' + headCells + '</tr></thead>';
    const tbody = document.createElement('tbody');

    let grandInput = 0,
        grandCache = 0,
        grandOutput = 0;
    const grandNativeCosts = createEmptyNativeCostSplit();
    let grandInputCost = 0,
        grandInputCostRmb = 0,
        grandCacheReadCost = 0,
        grandCacheReadCostRmb = 0,
        grandOutputCost = 0,
        grandOutputCostRmb = 0,
        grandEstimatedCost = 0;
    let grandEstimatedCostRmb = 0;

    for (const item of items) {
        const share = ((((item.totalTokens as number) || 0) / totalTokens) * 100).toFixed(1);
        const providerName = showProvider ? (item.providerName as string) || '-' : '';
        const modelName =
            showProvider ? (item.modelName as string) || (item[nameKey] as string) : (item[nameKey] as string) || '';
        const input = (item.totalInput as number) || 0;
        const cache = (item.totalCache as number) || 0;
        const output = (item.totalOutput as number) || 0;
        const nativeCosts = item.nativeCosts as NativeCostSplit | undefined;
        const miss = input - cache;
        const inputCost = ((item.inputCost as number) || 0) + ((item.cacheWriteCost as number) || 0);
        const inputCostRmb = ((item.inputCostRmb as number) || 0) + ((item.cacheWriteCostRmb as number) || 0);
        const cacheReadCost = (item.cacheReadCost as number) || 0;
        const cacheReadCostRmb = (item.cacheReadCostRmb as number) || 0;
        const outputCost = (item.outputCost as number) || 0;
        const outputCostRmb = (item.outputCostRmb as number) || 0;
        const estimatedCost = (item.estimatedCost as number) || 0;
        const estimatedCostRmb = (item.estimatedCostRmb as number) || 0;

        grandInput += miss > 0 ? miss : input;
        grandCache += cache;
        grandOutput += output;
        grandInputCost += inputCost;
        grandInputCostRmb += inputCostRmb;
        grandCacheReadCost += cacheReadCost;
        grandCacheReadCostRmb += cacheReadCostRmb;
        grandOutputCost += outputCost;
        grandOutputCostRmb += outputCostRmb;
        grandEstimatedCost += estimatedCost;
        grandEstimatedCostRmb += estimatedCostRmb;
        if (nativeCosts) {
            mergeNativeCostSplit(grandNativeCosts, nativeCosts);
        }

        const tr = document.createElement('tr');
        tr.innerHTML =
            (showProvider ? `<td>${providerName}</td>` : '') +
            `<td>${modelName}</td>` +
            buildTokensCell(
                miss > 0 ? miss : input,
                inputCost,
                inputCostRmb,
                nativeCosts ? nativeCosts.inputUsd + nativeCosts.cacheWriteUsd : undefined,
                nativeCosts ? nativeCosts.inputRmb + nativeCosts.cacheWriteRmb : undefined,
                options
            ) +
            buildTokensCell(
                cache,
                cacheReadCost,
                cacheReadCostRmb,
                nativeCosts?.cacheReadUsd,
                nativeCosts?.cacheReadRmb,
                options
            ) +
            buildTokensCell(output, outputCost, outputCostRmb, nativeCosts?.outputUsd, nativeCosts?.outputRmb, options) +
            buildTokensCell(input + output, estimatedCost, estimatedCostRmb, nativeCosts?.totalUsd, nativeCosts?.totalRmb, options) +
            `<td>${share}%</td>`;
        tbody.appendChild(tr);
    }

    // 合计行（与日报表 providerStats 样式一致）
    const totalRow = document.createElement('tr');
    totalRow.className = 'donut-total-row';
    const grandTotal = grandInput + grandCache + grandOutput;
    const grandShare = totalTokens > 0 ? ((grandTotal / totalTokens) * 100).toFixed(1) : '0.0';
    totalRow.innerHTML =
        (showProvider ? '<td></td>' : '') +
        `<td><strong>${t('Total', '合计')}</strong></td>` +
        buildTokensCell(
            grandInput,
            grandInputCost,
            grandInputCostRmb,
            grandNativeCosts.inputUsd + grandNativeCosts.cacheWriteUsd,
            grandNativeCosts.inputRmb + grandNativeCosts.cacheWriteRmb,
            options
        ) +
        buildTokensCell(
            grandCache,
            grandCacheReadCost,
            grandCacheReadCostRmb,
            grandNativeCosts.cacheReadUsd,
            grandNativeCosts.cacheReadRmb,
            options
        ) +
        buildTokensCell(
            grandOutput,
            grandOutputCost,
            grandOutputCostRmb,
            grandNativeCosts.outputUsd,
            grandNativeCosts.outputRmb,
            options
        ) +
        buildTokensCell(
            grandTotal,
            grandEstimatedCost,
            grandEstimatedCostRmb,
            grandNativeCosts.totalUsd,
            grandNativeCosts.totalRmb,
            options
        ) +
        `<td>${grandShare}%</td>`;
    tbody.appendChild(totalRow);

    table.appendChild(tbody);
    return table;
}

/** 构建内联成本的 Token 单元格（与日报表格式一致） */
function buildTokensCell(
    tokens: number,
    usdCost: number,
    rmbCost: number,
    nativeUsdCost: number | undefined,
    nativeRmbCost: number | undefined,
    options: MultiDayRenderOptions
): string {
    const tokenStr = tokens > 0 ? formatTokens(tokens) : '-';
    const costStr = formatDisplayCostAmount({
        usd: usdCost,
        rmb: rmbCost,
        nativeUsd: nativeUsdCost,
        nativeRmb: nativeRmbCost,
        currency: options.displayCurrency,
        fixedDecimals: 2,
        exactRmb: (nativeRmbCost ?? 0) > 0
    });
    if (costStr) {
        return (
            `<td><div class="tokens-row">${tokenStr}</div>` +
            `<div class="tokens-detail"><span class="tokens-cost" data-toggle-cost-currency="true" title="${options.toggleTitle}">${costStr}</span></div></td>`
        );
    }
    return `<td>${tokenStr}</td>`;
}

function renderDonut(canvasId: string, items: Array<Record<string, unknown>>, nameKey: string): void {
    const canvas = document.getElementById(canvasId) as HTMLCanvasElement;
    if (!canvas) {
        return;
    }
    const ctx = canvas.getContext('2d');
    if (!ctx) {
        return;
    }
    new Chart(ctx, {
        type: 'doughnut',
        data: {
            labels: items.map((item: Record<string, unknown>) => {
                return (item.modelName as string) || (item[nameKey] as string) || '';
            }),
            datasets: [
                {
                    data: items.map((item: Record<string, unknown>) => (item.totalTokens as number) || 0),
                    backgroundColor: items.map((_: unknown, i: number) => COLORS[i % COLORS.length]),
                    borderWidth: 2,
                    borderColor: '#1e1e1e'
                }
            ]
        },
        options: {
            responsive: true,
            maintainAspectRatio: false,
            plugins: { legend: { position: 'bottom', labels: { boxWidth: 10, padding: 6, font: { size: 10 } } } }
        }
    });
}
