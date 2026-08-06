import Chart from 'chart.js/auto';
import type { ChartOptions } from 'chart.js';
import type { MultiDayAnalysisResult } from '../../../usages/multiDay/types';
import type { MultiDayChartCurrency, MultiDayRenderOptions } from '../types';
import { convertUsdToRmb } from '../../../utils/pricing/pricingCurrency';
import { t } from '../../usagesView/utils';
import { createElement, formatCost, formatTokens } from '../../utils';

const COLORS = ['#4a90d9', '#50c878', '#ff8c42', '#9b59b6', '#e74c3c', '#1abc9c', '#f39c12', '#3498db'];

type TrendDataset =
    | {
          label: string;
          data: number[];
          backgroundColor: string;
          borderRadius: number;
          type: 'bar';
          stack: string;
      }
    | {
          label: string;
          data: number[];
          borderColor: string;
          backgroundColor: string;
          borderWidth: number;
          tension: number;
          type: 'line';
          pointRadius: number;
          pointBackgroundColor: string;
      };

/** 已创建的图表实例：自动刷新时复用更新数据，避免销毁重建造成频闪 */
let dailyTokensChart: Chart | undefined;
let dailyCostChart: Chart | undefined;

/** 全量重建前销毁图表实例：旧实例绑定已移除的 canvas，复用会导致新 canvas 空白 */
export function disposeCharts(): void {
    dailyTokensChart?.destroy();
    dailyTokensChart = undefined;
    dailyCostChart?.destroy();
    dailyCostChart = undefined;
}

function setChartEmptyState(canvas: HTMLCanvasElement, isEmpty: boolean): void {
    const wrapper = canvas.parentElement;
    if (!wrapper) {
        return;
    }
    const placeholder = wrapper.querySelector<HTMLElement>('.chart-empty-message');
    if (isEmpty) {
        canvas.style.display = 'none';
        if (!placeholder) {
            const message = createElement('div', 'empty-message chart-empty-message');
            message.textContent = `💡 ${t('Need at least 2 days', '至少需要 2 天数据')}`;
            wrapper.appendChild(message);
        }
        return;
    }
    canvas.style.display = '';
    placeholder?.remove();
}

export function createTrendChart(data: MultiDayAnalysisResult): HTMLElement {
    const section = createElement('div', 'chart-section');
    const title = createElement('h3', 'chart-section-title');
    title.textContent = t('Daily Token Usage', '每日 Token 消耗');
    section.appendChild(title);

    const wrapper = createElement('div', 'chart-wrapper');
    const canvas = document.createElement('canvas');
    canvas.id = 'chart-daily-tokens';
    wrapper.appendChild(canvas);
    section.appendChild(wrapper);

    setTimeout(() => {
        dailyTokensChart = renderTrendChart(canvas.id, data, dailyTokensChart);
    }, 0);
    return section;
}

/** 数据刷新：复用已创建的 Chart 实例仅替换数据，避免全量重建导致的频闪 */
export function updateTrendChart(data: MultiDayAnalysisResult): void {
    dailyTokensChart = renderTrendChart('chart-daily-tokens', data, dailyTokensChart);
}

function renderTrendChart(canvasId: string, data: MultiDayAnalysisResult, existing?: Chart): Chart | undefined {
    const canvas = document.getElementById(canvasId) as HTMLCanvasElement | null;
    if (!canvas) {
        return existing;
    }
    const ctx = canvas.getContext('2d');
    if (!ctx) {
        return existing;
    }

    const { dates } = data;
    if (dates.length < 2) {
        existing?.destroy();
        setChartEmptyState(canvas, true);
        return undefined;
    }
    setChartEmptyState(canvas, false);

    const { labels, datasets } = buildTrendChartData(data);

    if (existing) {
        existing.data.labels = labels;
        existing.data.datasets = datasets;
        existing.update('none');
        return existing;
    }

    return new Chart(ctx, {
        type: 'bar',
        data: { labels, datasets },
        options: {
            responsive: true,
            maintainAspectRatio: false,
            interaction: { mode: 'index', intersect: false },
            scales: {
                y: {
                    stacked: true,
                    beginAtZero: true,
                    ticks: { callback: v => (Number(v) >= 1000 ? formatTokens(Number(v)) : String(v)) }
                }
            },
            plugins: {
                legend: { position: 'bottom', labels: { boxWidth: 12, padding: 8 } },
                tooltip: {
                    filter: item => (item.raw as number) > 0
                }
            }
        }
    });
}

function buildTrendChartData(data: MultiDayAnalysisResult): { labels: string[]; datasets: TrendDataset[] } {
    const { dates } = data;
    const labels = data.trendSeries.dates.map((d: string) => d.slice(5));

    // 先收集所有出现过的 provider key，再为每天填充（缺失填 0），确保数组长度与 labels 一致
    const allProviderKeys = new Set<string>();
    const keyToName = new Map<string, string>();
    for (const d of dates) {
        for (const [k, ps] of Object.entries(d.providers)) {
            allProviderKeys.add(k);
            if (!keyToName.has(k)) {
                keyToName.set(k, ps.providerName || k);
            }
        }
    }

    const providers = new Map<string, number[]>();
    for (const key of allProviderKeys) {
        providers.set(key, []);
    }
    for (const d of dates) {
        for (const key of allProviderKeys) {
            providers.get(key)!.push(d.providers[key]?.totalTokens ?? 0);
        }
    }

    const barDatasets: TrendDataset[] = Array.from(providers.entries()).map(([key, vals], i) => ({
        label: keyToName.get(key) || key,
        data: vals,
        backgroundColor: COLORS[i % COLORS.length],
        borderRadius: 2,
        type: 'bar' as const,
        stack: 'providers'
    }));

    const lineDataset: TrendDataset = {
        label: t('Total', '总量'),
        data: data.trendSeries.totalTokens,
        borderColor: '#333',
        backgroundColor: 'transparent',
        borderWidth: 2.5,
        tension: 0.3,
        type: 'line' as const,
        pointRadius: 3,
        pointBackgroundColor: '#333'
    };

    return { labels, datasets: [...barDatasets, lineDataset] };
}

// ============= 每日成本趋势图 =============

function getDisplayCostValue(
    usd: number | undefined,
    rmb: number | undefined,
    currency: MultiDayChartCurrency
): number {
    if (currency === 'USD') {
        return usd || 0;
    }

    return rmb || convertUsdToRmb(usd) || 0;
}

function getYAxisZeroLabel(currency: MultiDayChartCurrency): string {
    return currency === 'RMB' ? '¥0.00' : '$0.00';
}

export function createCostTrendChart(data: MultiDayAnalysisResult, options: MultiDayRenderOptions): HTMLElement {
    const section = createElement('div', 'chart-section');
    const title = createElement('h3', 'chart-section-title');
    title.textContent =
        options.displayCurrency === 'MIXED' ?
            t('Daily Token Cost (RMB aggregate)', '每日 Token 成本（人民币汇总）')
        :   t('Daily Token Cost', '每日 Token 成本');
    title.dataset.toggleCostCurrency = 'true';
    title.title = options.toggleTitle;
    section.appendChild(title);

    const wrapper = createElement('div', 'chart-wrapper');
    const canvas = document.createElement('canvas');
    canvas.id = 'chart-daily-cost';
    wrapper.appendChild(canvas);
    section.appendChild(wrapper);

    setTimeout(() => {
        dailyCostChart = renderCostChart(canvas.id, data, options.costChartCurrency, dailyCostChart);
    }, 0);
    return section;
}

/** 数据刷新：复用已创建的 Chart 实例仅替换数据，避免全量重建导致的频闪 */
export function updateCostTrendChart(data: MultiDayAnalysisResult, options: MultiDayRenderOptions): void {
    const canvas = document.getElementById('chart-daily-cost') as HTMLCanvasElement | null;
    if (!canvas) {
        return;
    }
    // 币种模式可能变化，同步标题与悬浮说明
    const title = canvas.closest('.chart-section')?.querySelector('.chart-section-title') as HTMLElement | null;
    if (title) {
        title.textContent =
            options.displayCurrency === 'MIXED' ?
                t('Daily Token Cost (RMB aggregate)', '每日 Token 成本（人民币汇总）')
            :   t('Daily Token Cost', '每日 Token 成本');
        title.title = options.toggleTitle;
    }
    dailyCostChart = renderCostChart(canvas.id, data, options.costChartCurrency, dailyCostChart);
}

function renderCostChart(
    canvasId: string,
    data: MultiDayAnalysisResult,
    currency: MultiDayChartCurrency,
    existing?: Chart
): Chart | undefined {
    const canvas = document.getElementById(canvasId) as HTMLCanvasElement | null;
    if (!canvas) {
        return existing;
    }
    const ctx = canvas.getContext('2d');
    if (!ctx) {
        return existing;
    }

    const { dates } = data;
    if (dates.length < 2) {
        existing?.destroy();
        setChartEmptyState(canvas, true);
        return undefined;
    }
    setChartEmptyState(canvas, false);

    const { labels, datasets } = buildCostChartData(data, currency);

    const chart =
        existing ??
        new Chart(ctx, {
            type: 'bar',
            data: { labels, datasets },
            options: buildCostChartOptions(currency)
        });
    chart.data.labels = labels;
    chart.data.datasets = datasets;
    applyCostChartOptions(chart, currency);
    chart.update('none');
    return chart;
}

function buildCostChartData(
    data: MultiDayAnalysisResult,
    currency: MultiDayChartCurrency
): { labels: string[]; datasets: TrendDataset[] } {
    const { dates } = data;
    const labels = data.trendSeries.dates.map((d: string) => d.slice(5));

    // 收集所有 provider 的每日成本
    const allProviderKeys = new Set<string>();
    const keyToName = new Map<string, string>();
    for (const d of dates) {
        for (const [k, ps] of Object.entries(d.providers)) {
            allProviderKeys.add(k);
            if (!keyToName.has(k)) {
                keyToName.set(k, ps.providerName || k);
            }
        }
    }

    const providers = new Map<string, number[]>();
    for (const key of allProviderKeys) {
        providers.set(key, []);
    }
    for (const d of dates) {
        for (const key of allProviderKeys) {
            const provider = d.providers[key];
            providers
                .get(key)!
                .push(getDisplayCostValue(provider?.estimatedCost, provider?.estimatedCostRmb, currency));
        }
    }

    const barDatasets: TrendDataset[] = Array.from(providers.entries()).map(([key, vals], i) => ({
        label: keyToName.get(key) || key,
        data: vals,
        backgroundColor: COLORS[i % COLORS.length],
        borderRadius: 2,
        type: 'bar' as const,
        stack: 'providers'
    }));

    const lineDataset: TrendDataset = {
        label: t('Total', '总量'),
        data: data.trendSeries.estimatedCost.map((usd, index) =>
            getDisplayCostValue(usd, data.trendSeries.estimatedCostRmb[index], currency)
        ),
        borderColor: '#e74c3c',
        backgroundColor: 'transparent',
        borderWidth: 2.5,
        tension: 0.3,
        type: 'line' as const,
        pointRadius: 3,
        pointBackgroundColor: '#e74c3c'
    };

    return { labels, datasets: [...barDatasets, lineDataset] };
}

function buildCostChartOptions(currency: MultiDayChartCurrency): ChartOptions {
    return {
        responsive: true,
        maintainAspectRatio: false,
        interaction: { mode: 'index', intersect: false },
        scales: {
            y: {
                stacked: true,
                beginAtZero: true,
                ticks: {
                    callback: makeCostYAxisTickCallback(currency)
                }
            }
        },
        plugins: {
            legend: { position: 'bottom', labels: { boxWidth: 12, padding: 8 } },
            tooltip: {
                callbacks: {
                    label: makeCostTooltipLabel(currency)
                },
                filter: item => (item.raw as number) > 0
            }
        }
    };
}

function makeCostYAxisTickCallback(currency: MultiDayChartCurrency): (v: number | string) => string {
    return v =>
        Number(v) === 0 ?
            getYAxisZeroLabel(currency)
        :   formatCost(Number(v), {
                fixedDecimals: 2,
                currencySymbol: currency === 'RMB' ? '¥' : '$'
            });
}

function makeCostTooltipLabel(currency: MultiDayChartCurrency) {
    return (ctx: { raw?: unknown; dataset: { label?: string } }) => {
        const val = ctx.raw as number;
        return `${ctx.dataset.label}: ${formatCost(val, { fixedDecimals: 2, currencySymbol: currency === 'RMB' ? '¥' : '$' })}`;
    };
}

/** 币种（或数据）变化时同步图表选项中的金额格式化回调 */
function applyCostChartOptions(chart: Chart, currency: MultiDayChartCurrency): void {
    chart.options.scales!.y!.ticks!.callback = makeCostYAxisTickCallback(currency);
    chart.options.plugins!.tooltip!.callbacks!.label = makeCostTooltipLabel(currency);
}
