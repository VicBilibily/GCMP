import Chart from 'chart.js/auto';
import type { MultiDayAnalysisResult } from '../../../usages/multiDay/types';
import { t } from '../../usagesView/utils';
import { createElement } from '../../utils';

const COLORS = ['#4a90d9', '#50c878', '#ff8c42', '#9b59b6', '#e74c3c', '#1abc9c', '#f39c12', '#3498db'];

function abbrev(n: number): string {
    if (n >= 1_000_000) return (n / 1_000_000).toFixed(2) + 'M';
    if (n >= 1_000) return (n / 1_000).toFixed(1) + 'K';
    return String(n);
}

export function createProviderModelRank(data: MultiDayAnalysisResult): HTMLElement {
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
    const table = createDonutTable(data.providerRanking, 'name');
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
    const modelTable = createDonutTable(data.modelRanking, 'name', true);
    right.appendChild(modelTable);
    container.appendChild(right);

    setTimeout(() => {
        renderDonut(canvas.id, data.providerRanking, 'name');
        renderDonut(modelCanvas.id, data.modelRanking, 'name');
    }, 0);

    return container;
}

function createDonutTable(items: Array<Record<string, unknown>>, nameKey: string, showProvider = false): HTMLElement {
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
        '<th>%</th>';
    table.innerHTML = '<thead><tr>' + headCells + '</tr></thead>';
    const tbody = document.createElement('tbody');
    for (const item of items) {
        const share = ((((item.totalTokens as number) || 0) / totalTokens) * 100).toFixed(1);
        const providerName = showProvider ? (item.providerName as string) || '-' : '';
        const modelName =
            showProvider ? (item.modelName as string) || (item[nameKey] as string) : (item[nameKey] as string) || '';
        const tr = document.createElement('tr');
        tr.innerHTML =
            (showProvider ? `<td>${providerName}</td>` : '') +
            `<td>${modelName}</td>` +
            `<td>${abbrev((item.totalInput as number) || 0)}</td>` +
            `<td>${abbrev((item.totalCache as number) || 0)}</td>` +
            `<td>${abbrev((item.totalOutput as number) || 0)}</td>` +
            `<td>${share}%</td>`;
        tbody.appendChild(tr);
    }
    table.appendChild(tbody);
    return table;
}

function renderDonut(canvasId: string, items: Array<Record<string, unknown>>, nameKey: string): void {
    const canvas = document.getElementById(canvasId) as HTMLCanvasElement;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
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
