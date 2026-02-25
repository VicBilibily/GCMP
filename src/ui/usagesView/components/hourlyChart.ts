/*---------------------------------------------------------------------------------------------
 *  小时统计图表组件
 *  使用 Chart.js 展示提供商的性能指标趋势
 *--------------------------------------------------------------------------------------------*/

import type { HourlyStats } from '../types';
import { createElement } from '../../utils';
import { getProviderDisplayName } from '../utils';
import { Chart } from 'chart.js/auto';

// 保存图表实例引用，避免重复创建导致闪烁
let speedChartInstance: Chart | null = null;
let latencyChartInstance: Chart | null = null;

/**
 * 创建或更新小时统计图表（包含三个子图表）
 * 如果容器已存在，只更新数据；否则创建新图表
 */
export function createHourlyChart(
    hourlyStats: Record<string, HourlyStats>,
    existingContainer?: HTMLElement
): HTMLElement {
    // 如果传入了已存在的容器，只更新数据
    if (existingContainer) {
        const speedCanvas = existingContainer.querySelector('#speed-chart') as HTMLCanvasElement;
        const latencyCanvas = existingContainer.querySelector('#latency-chart') as HTMLCanvasElement;

        if (speedCanvas && latencyCanvas) {
            // 容器存在，只更新图表数据
            setTimeout(() => {
                initSpeedChart(speedCanvas, hourlyStats);
                initLatencyChart(latencyCanvas, hourlyStats);
            }, 0);
            return existingContainer;
        }
    }

    // 创建新容器
    const section = createElement('section', 'hourly-chart-section');

    const h2 = createElement('h2');
    h2.textContent = '📊 提供商性能指标趋势';
    section.appendChild(h2);

    if (!hourlyStats || Object.keys(hourlyStats).length === 0) {
        const empty = createElement('div', 'empty-message');
        empty.textContent = '暂无小时统计数据';
        section.appendChild(empty);
        return section;
    }

    // 检查是否有有效数据（包含速度相关数据的小时）
    // 老旧数据可能没有速度字段，需要过滤
    const validHoursCount = Object.values(hourlyStats).filter(stats => {
        if (!stats.providers || Object.keys(stats.providers).length === 0) {
            return false;
        }
        // 检查是否有提供商包含速度相关数据
        return Object.values(stats.providers).some(
            provider =>
                provider.totalStreamDuration !== undefined ||
                provider.validStreamRequests !== undefined ||
                provider.validStreamOutputTokens !== undefined ||
                provider.totalFirstTokenLatency !== undefined
        );
    }).length;

    if (validHoursCount < 1) {
        const empty = createElement('div', 'empty-message');
        empty.textContent = '暂无有效速度数据';
        section.appendChild(empty);
        return section;
    }

    // 创建切换按钮
    const toggleContainer = createElement('div', 'chart-toggle-container');
    const speedButton = createElement('button', 'chart-toggle-button active');
    speedButton.textContent = '⚡ 速度';
    const latencyButton = createElement('button', 'chart-toggle-button');
    latencyButton.textContent = '⏱️ 延迟';
    toggleContainer.appendChild(speedButton);
    toggleContainer.appendChild(latencyButton);
    section.appendChild(toggleContainer);

    // 创建两个独立的图表容器
    const chartsWrapper = createElement('div', 'charts-wrapper');

    // 1. 输出速度图表
    const speedSection = createElement('div', 'chart-item chart-visible');
    const speedTitle = createElement('h3');
    speedTitle.textContent = '⚡ 平均输出速度 (tokens/秒)';
    speedSection.appendChild(speedTitle);
    const speedContainer = createElement('div', 'chart-container');
    const speedCanvas = createElement('canvas', 'speed-chart') as HTMLCanvasElement;
    speedCanvas.id = 'speed-chart'; // 添加 id 以便后续查找
    speedContainer.appendChild(speedCanvas);
    speedSection.appendChild(speedContainer);
    chartsWrapper.appendChild(speedSection);

    // 2. 延迟图表
    const latencySection = createElement('div', 'chart-item chart-hidden');
    const latencyTitle = createElement('h3');
    latencyTitle.textContent = '⏱️ 首 Token 平均延迟 (毫秒)';
    latencySection.appendChild(latencyTitle);
    const latencyContainer = createElement('div', 'chart-container');
    const latencyCanvas = createElement('canvas', 'latency-chart') as HTMLCanvasElement;
    latencyCanvas.id = 'latency-chart'; // 添加 id 以便后续查找
    latencyContainer.appendChild(latencyCanvas);
    latencySection.appendChild(latencyContainer);
    chartsWrapper.appendChild(latencySection);

    section.appendChild(chartsWrapper);

    // 延迟初始化图表（确保 DOM 已渲染）
    setTimeout(() => {
        initSpeedChart(speedCanvas, hourlyStats);
        initLatencyChart(latencyCanvas, hourlyStats);

        // 添加切换事件
        speedButton.onclick = () => {
            speedButton.classList.add('active');
            latencyButton.classList.remove('active');
            speedSection.classList.remove('chart-hidden');
            speedSection.classList.add('chart-visible');
            latencySection.classList.remove('chart-visible');
            latencySection.classList.add('chart-hidden');
        };

        latencyButton.onclick = () => {
            latencyButton.classList.add('active');
            speedButton.classList.remove('active');
            latencySection.classList.remove('chart-hidden');
            latencySection.classList.add('chart-visible');
            speedSection.classList.remove('chart-visible');
            speedSection.classList.add('chart-hidden');
        };
    }, 100);

    return section;
}

/**
 * 计算平均首token延迟
 */
function calcFirstTokenLatency(stats: { totalFirstTokenLatency?: number; validStreamRequests?: number }): number {
    if (!stats.totalFirstTokenLatency || !stats.validStreamRequests || stats.validStreamRequests <= 0) {
        return 0;
    }
    return stats.totalFirstTokenLatency / stats.validStreamRequests; // 毫秒
}

/**
 * 初始化输出速度图表
 */
function initSpeedChart(canvas: HTMLCanvasElement, hourlyStats: Record<string, HourlyStats>): void {
    const hourKeys = Object.keys(hourlyStats).sort((a, b) => {
        const hourA = parseInt(a, 10);
        const hourB = parseInt(b, 10);
        return hourA - hourB;
    });

    const hours = hourKeys.map(h => parseInt(h, 10));

    // Map 结构: providerId -> { name: string, data: Map<hour, value> }
    const providerMap = new Map<string, { name: string; data: Map<number, number> }>();

    hourKeys.forEach(hourKey => {
        const stats = hourlyStats[hourKey];
        if (stats && stats.providers) {
            const hour = parseInt(hourKey, 10);
            Object.entries(stats.providers).forEach(([providerId, providerStats]) => {
                // 使用 providerId 作为唯一标识，避免相同名称的 provider 被合并
                if (!providerMap.has(providerId)) {
                    providerMap.set(providerId, {
                        name: getProviderDisplayName(providerId, providerStats.providerName),
                        data: new Map()
                    });
                }
                const outputSpeed =
                    providerStats.totalOutputSpeeds &&
                    providerStats.validStreamRequests &&
                    providerStats.validStreamRequests > 0
                        ? providerStats.totalOutputSpeeds / providerStats.validStreamRequests
                        : 0;
                providerMap.get(providerId)!.data.set(hour, outputSpeed);
            });
        }
    });

    const datasets = createDatasetsFromMap(providerMap, hours);

    // 检查现有图表实例是否有效（canvas 是否还在 DOM 中）
    if (speedChartInstance && speedChartInstance.canvas === canvas) {
        updateChartData(speedChartInstance, hours, datasets);
    } else {
        // 如果 canvas 不匹配，销毁旧实例并创建新图表
        if (speedChartInstance) {
            speedChartInstance.destroy();
            speedChartInstance = null;
        }
        speedChartInstance = createSingleChart(canvas, hours, datasets, '输出速度 (tokens/秒)', 'tokens/秒');
    }
}

/**
 * 初始化延迟图表
 */
function initLatencyChart(canvas: HTMLCanvasElement, hourlyStats: Record<string, HourlyStats>): void {
    const hourKeys = Object.keys(hourlyStats).sort((a, b) => {
        const hourA = parseInt(a, 10);
        const hourB = parseInt(b, 10);
        return hourA - hourB;
    });

    const hours = hourKeys.map(h => parseInt(h, 10));

    // Map 结构: providerId -> { name: string, data: Map<hour, value> }
    const providerMap = new Map<string, { name: string; data: Map<number, number> }>();

    hourKeys.forEach(hourKey => {
        const stats = hourlyStats[hourKey];
        if (stats && stats.providers) {
            const hour = parseInt(hourKey, 10);
            Object.entries(stats.providers).forEach(([providerId, providerStats]) => {
                // 使用 providerId 作为唯一标识，避免相同名称的 provider 被合并
                if (!providerMap.has(providerId)) {
                    providerMap.set(providerId, {
                        name: getProviderDisplayName(providerId, providerStats.providerName),
                        data: new Map()
                    });
                }
                const latency = calcFirstTokenLatency(providerStats);
                providerMap.get(providerId)!.data.set(hour, latency);
            });
        }
    });

    const datasets = createDatasetsFromMap(providerMap, hours);

    // 检查现有图表实例是否有效（canvas 是否还在 DOM 中）
    if (latencyChartInstance && latencyChartInstance.canvas === canvas) {
        updateChartData(latencyChartInstance, hours, datasets);
    } else {
        // 如果 canvas 不匹配，销毁旧实例并创建新图表
        if (latencyChartInstance) {
            latencyChartInstance.destroy();
            latencyChartInstance = null;
        }
        latencyChartInstance = createSingleChart(canvas, hours, datasets, '首 Token 延迟 (毫秒)', '毫秒');
    }
}

/**
 * 从数据映射创建数据集
 */
function createDatasetsFromMap(
    providerMap: Map<string, { name: string; data: Map<number, number> }>,
    hours: number[]
): Array<{
    label: string;
    data: (number | null)[];
    borderColor: string;
    backgroundColor: string;
    tension: number;
    borderWidth: number;
    pointRadius: number;
    pointHoverRadius: number;
}> {
    const datasets: Array<{
        label: string;
        data: (number | null)[];
        borderColor: string;
        backgroundColor: string;
        tension: number;
        borderWidth: number;
        pointRadius: number;
        pointHoverRadius: number;
    }> = [];

    const providerColors = [
        { border: 'rgb(59, 130, 246)', bg: 'rgba(59, 130, 246, 0.1)' }, // 蓝色
        { border: 'rgb(34, 197, 94)', bg: 'rgba(34, 197, 94, 0.1)' }, // 绿色
        { border: 'rgb(249, 115, 22)', bg: 'rgba(249, 115, 22, 0.1)' }, // 橙色
        { border: 'rgb(234, 179, 8)', bg: 'rgba(234, 179, 8, 0.1)' }, // 黄色
        { border: 'rgb(20, 184, 166)', bg: 'rgba(20, 184, 166, 0.1)' }, // 青色
        { border: 'rgb(139, 92, 246)', bg: 'rgba(139, 92, 246, 0.1)' }, // 紫罗兰
        { border: 'rgb(6, 182, 212)', bg: 'rgba(6, 182, 212, 0.1)' }, // 浅蓝
        { border: 'rgb(132, 204, 22)', bg: 'rgba(132, 204, 22, 0.1)' }, // 青柠
        { border: 'rgb(99, 102, 241)', bg: 'rgba(99, 102, 241, 0.1)' }, // 靛蓝
        { border: 'rgb(21, 128, 61)', bg: 'rgba(21, 128, 61, 0.1)' }, // 深绿
        { border: 'rgb(124, 45, 18)', bg: 'rgba(124, 45, 18, 0.1)' }, // 棕色
        { border: 'rgb(107, 114, 128)', bg: 'rgba(107, 114, 128, 0.1)' }, // 灰色
        { border: 'rgb(128, 0, 128)', bg: 'rgba(128, 0, 128, 0.1)' }, // 紫色
        { border: 'rgb(0, 100, 0)', bg: 'rgba(0, 100, 0, 0.1)' }, // 暗绿
        { border: 'rgb(70, 130, 180)', bg: 'rgba(70, 130, 180, 0.1)' } // 钢蓝
    ];

    let colorIndex = 0;
    providerMap.forEach((providerInfo, _providerId) => {
        const { name: providerName, data: hourData } = providerInfo;
        const data = hours.map(hour => {
            const value = hourData.get(hour) || 0;
            return value > 0 ? value : null; // null 会让 Chart.js 跳过该点并连接相邻有效点
        });

        if (data.some(v => v !== null && v > 0)) {
            const color = providerColors[colorIndex % providerColors.length];
            datasets.push({
                label: providerName, // 使用友好名称作为显示标签
                data: data,
                borderColor: color.border,
                backgroundColor: color.bg,
                tension: 0.3,
                borderWidth: 2,
                pointRadius: 4,
                pointHoverRadius: 6
            });
            colorIndex++;
        }
    });

    datasets.sort((a, b) => {
        const sumA = a.data.reduce((s: number, v) => s + (v || 0), 0);
        const sumB = b.data.reduce((s: number, v) => s + (v || 0), 0);
        return sumB - sumA;
    });

    return datasets;
}

/**
 * 更新图表数据
 */
function updateChartData(
    chart: Chart,
    hours: number[],
    datasets: Array<{
        label: string;
        data: (number | null)[];
        borderColor: string;
        backgroundColor: string;
        tension: number;
        borderWidth: number;
        pointRadius: number;
        pointHoverRadius: number;
    }>
): void {
    const labels = hours.map(h => `${String(h).padStart(2, '0')}:00`);

    // 根据图表类型设置不同的点样式
    // 通过检查 canvas id 来判断图表类型
    const canvasId = chart.canvas.id;
    const isSpeedChart = canvasId === 'speed-chart';
    const pointStyle = isSpeedChart ? 'circle' : 'rectRot';

    chart.data.labels = labels;
    chart.data.datasets = datasets.map(ds => ({
        ...ds,
        pointStyle: pointStyle
    }));

    // 使用 'none' 模式：禁用动画，立即更新
    chart.update('none');
}

/**
 * 创建单图表
 */
function createSingleChart(
    canvas: HTMLCanvasElement,
    hours: number[],
    datasets: Array<{
        label: string;
        data: (number | null)[];
        borderColor: string;
        backgroundColor: string;
        tension: number;
        borderWidth: number;
        pointRadius: number;
        pointHoverRadius: number;
    }>,
    yAxisTitle: string,
    unit: string
): Chart {
    const labels = hours.map(h => `${String(h).padStart(2, '0')}:00`);

    // 根据图表类型设置不同的点样式
    const isSpeedChart = unit === 'tokens/秒';
    const pointStyle = isSpeedChart ? 'circle' : 'rectRot';

    const chart = new Chart(canvas, {
        type: 'line',
        data: {
            labels: labels,
            datasets: datasets.map(ds => ({
                ...ds,
                pointStyle: pointStyle
            }))
        },
        options: {
            responsive: true,
            maintainAspectRatio: false, // 禁用自动宽高比，使用固定高度
            animation: false, // 禁用所有动画
            spanGaps: true, // 自动跳过 null 值并连接相邻有效数据点
            interaction: {
                mode: 'index',
                intersect: false
            },
            plugins: {
                legend: {
                    display: true,
                    position: 'top',
                    labels: {
                        usePointStyle: true,
                        padding: 15,
                        font: {
                            size: 11
                        }
                    }
                },
                tooltip: {
                    enabled: true,
                    mode: 'index',
                    intersect: false,
                    backgroundColor: 'rgba(0, 0, 0, 0.8)',
                    titleFont: {
                        size: 14,
                        weight: 'bold'
                    },
                    bodyFont: {
                        size: 12
                    },
                    padding: 12,
                    callbacks: {
                        label: function (context) {
                            let label = context.dataset.label || '';
                            if (label) {
                                label += ': ';
                            }
                            const value = context.parsed.y;
                            if (value !== null && value !== undefined && value > 0) {
                                label += formatValue(value, unit);
                            }
                            return label;
                        }
                    }
                },
                title: {
                    display: false
                }
            },
            scales: {
                x: {
                    display: true,
                    title: {
                        display: true,
                        text: '时间',
                        font: {
                            size: 11,
                            weight: 'bold'
                        }
                    },
                    grid: {
                        display: false
                    },
                    ticks: {
                        maxRotation: 0,
                        autoSkip: true,
                        maxTicksLimit: 24
                    }
                },
                y: {
                    display: true,
                    title: {
                        display: true,
                        text: yAxisTitle,
                        font: {
                            size: 11,
                            weight: 'bold'
                        }
                    },
                    grid: {
                        color: 'rgba(0, 0, 0, 0.05)'
                    },
                    ticks: {
                        callback: function (value) {
                            if (typeof value === 'number') {
                                return formatValue(value, unit);
                            }
                            return String(value);
                        }
                    }
                }
            }
        }
    });

    return chart;
}

/**
 * 格式化数值显示
 */
function formatValue(value: number, unit: string): string {
    if (unit === 'Tokens') {
        if (value >= 1e6) {
            return `${(value / 1e6).toFixed(1)}M`;
        }
        if (value >= 1e3) {
            return `${(value / 1e3).toFixed(1)}K`;
        }
        return String(value);
    }

    if (unit === '毫秒') {
        if (value >= 1000) {
            return `${(value / 1000).toFixed(1)}s`;
        }
        return `${Math.round(value)}ms`;
    }

    // tokens/秒
    if (value >= 1000) {
        return `${(value / 1000).toFixed(1)}k`;
    }
    return `${value.toFixed(1)}`;
}
