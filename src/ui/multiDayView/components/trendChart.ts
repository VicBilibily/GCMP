import Chart from 'chart.js/auto';
import type { MultiDayAnalysisResult } from '../../../usages/multiDay/types';
import type { MultiDayChartCurrency, MultiDayRenderOptions } from '../types';
import { convertUsdToRmb } from '../../../utils/pricingCurrency';
import { t } from '../../usagesView/utils';
import { createElement, formatCost, formatTokens } from '../../utils';

const COLORS = ['#4a90d9', '#50c878', '#ff8c42', '#9b59b6', '#e74c3c', '#1abc9c', '#f39c12', '#3498db'];

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

    setTimeout(() => render(canvas.id, data), 0);
    return section;
}

function render(canvasId: string, data: MultiDayAnalysisResult): void {
    const canvas = document.getElementById(canvasId) as HTMLCanvasElement;
    if (!canvas) {
        return;
    }
    const ctx = canvas.getContext('2d');
    if (!ctx) {
        return;
    }

    const { dates } = data;
    if (dates.length < 2) {
        canvas.parentElement!.innerHTML = `<div class="empty-message">💡 ${t('Need at least 2 days', '至少需要 2 天数据')}</div>`;
        return;
    }

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

    const barDatasets = Array.from(providers.entries()).map(([key, vals], i) => ({
        label: keyToName.get(key) || key,
        data: vals,
        backgroundColor: COLORS[i % COLORS.length],
        borderRadius: 2,
        type: 'bar' as const,
        stack: 'providers'
    }));

    const lineDataset = {
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

    new Chart(ctx, {
        type: 'bar',
        data: { labels, datasets: [...barDatasets, lineDataset] },
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

    setTimeout(() => renderCostChart(canvas.id, data, options.costChartCurrency), 0);
    return section;
}

function renderCostChart(canvasId: string, data: MultiDayAnalysisResult, currency: MultiDayChartCurrency): void {
    const canvas = document.getElementById(canvasId) as HTMLCanvasElement;
    if (!canvas) {
        return;
    }
    const ctx = canvas.getContext('2d');
    if (!ctx) {
        return;
    }

    const { dates } = data;
    if (dates.length < 2) {
        canvas.parentElement!.innerHTML = `<div class="empty-message">💡 ${t('Need at least 2 days', '至少需要 2 天数据')}</div>`;
        return;
    }

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

    const barDatasets = Array.from(providers.entries()).map(([key, vals], i) => ({
        label: keyToName.get(key) || key,
        data: vals,
        backgroundColor: COLORS[i % COLORS.length],
        borderRadius: 2,
        type: 'bar' as const,
        stack: 'providers'
    }));

    const lineDataset = {
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

    new Chart(ctx, {
        type: 'bar',
        data: { labels, datasets: [...barDatasets, lineDataset] },
        options: {
            responsive: true,
            maintainAspectRatio: false,
            interaction: { mode: 'index', intersect: false },
            scales: {
                y: {
                    stacked: true,
                    beginAtZero: true,
                    ticks: {
                        callback: v =>
                            Number(v) === 0 ?
                                getYAxisZeroLabel(currency)
                            :   formatCost(Number(v), {
                                    fixedDecimals: 2,
                                    currencySymbol: currency === 'RMB' ? '¥' : '$'
                                })
                    }
                }
            },
            plugins: {
                legend: { position: 'bottom', labels: { boxWidth: 12, padding: 8 } },
                tooltip: {
                    callbacks: {
                        label: ctx => {
                            const val = ctx.raw as number;
                            return `${ctx.dataset.label}: ${formatCost(val, { fixedDecimals: 2, currencySymbol: currency === 'RMB' ? '¥' : '$' })}`;
                        }
                    },
                    filter: item => (item.raw as number) > 0
                }
            }
        }
    });
}
