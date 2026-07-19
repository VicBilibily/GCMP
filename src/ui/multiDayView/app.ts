/**
 * 多日消耗分析 WebView 入口
 */

import './style.less';
import 'chart.js/auto';

import type { MultiDayAnalysisResult } from '../../usages/multiDay/types';
import type { HostMessage, MultiDayDisplayCurrency, MultiDayRenderOptions, MultiDayState } from './types';
import {
    createDateRangePicker,
    createSummaryCards,
    createTrendChart,
    createCostTrendChart,
    createProviderModelRank,
    initDefaultRange,
    requestCurrentRangeAnalysis
} from './components/index';
import { t } from '../usagesView/utils';
import { createElement } from '../utils';

// ============= 全局状态 =============

const state: MultiDayState = {
    data: null,
    loading: false,
    error: null,
    displayCurrency: getDefaultDisplayCurrency(null)
};

function isChineseLocale(): boolean {
    const lang = (globalThis.document?.documentElement?.lang || globalThis.navigator?.language || '').toLowerCase();
    return lang === 'zh-cn' || lang === 'zh' || lang.startsWith('zh-');
}

function getAnalysisData(data?: MultiDayAnalysisResult | null): MultiDayAnalysisResult | null {
    if (data !== undefined) {
        return data;
    }

    return state?.data ?? null;
}

function hasExactRmbPricing(data?: MultiDayAnalysisResult | null): boolean {
    return (getAnalysisData(data)?.summary.nativeCosts.totalRmb ?? 0) > 0;
}

function normalizeDisplayCurrency(
    currentCurrency: MultiDayDisplayCurrency,
    data?: MultiDayAnalysisResult | null
): MultiDayDisplayCurrency {
    if (!isChineseLocale()) {
        return currentCurrency === 'MIXED' ? 'USD' : currentCurrency;
    }

    if (currentCurrency === 'MIXED' && !hasExactRmbPricing(data)) {
        return 'USD';
    }

    return currentCurrency;
}

function getDefaultDisplayCurrency(data?: MultiDayAnalysisResult | null): MultiDayDisplayCurrency {
    return isChineseLocale() ? normalizeDisplayCurrency('MIXED', data) : 'USD';
}

function getNextDisplayCurrency(
    currentCurrency: MultiDayDisplayCurrency,
    data?: MultiDayAnalysisResult | null
): MultiDayDisplayCurrency {
    const normalizedCurrency = normalizeDisplayCurrency(currentCurrency, data);

    if (!isChineseLocale()) {
        return normalizedCurrency === 'USD' ? 'RMB' : 'USD';
    }

    if (!hasExactRmbPricing(data)) {
        return normalizedCurrency === 'USD' ? 'RMB' : 'USD';
    }

    if (normalizedCurrency === 'MIXED') {
        return 'USD';
    }
    if (normalizedCurrency === 'USD') {
        return 'RMB';
    }
    return 'MIXED';
}

function getCostChartCurrency(
    currentCurrency: MultiDayDisplayCurrency,
    data?: MultiDayAnalysisResult | null
): 'USD' | 'RMB' {
    const normalizedCurrency = normalizeDisplayCurrency(currentCurrency, data);
    return normalizedCurrency === 'MIXED' ? 'RMB' : normalizedCurrency;
}

function getCurrencyModeLabel(currency: MultiDayDisplayCurrency): string {
    if (currency === 'MIXED') {
        return t('split currency view', '分币种显示');
    }

    return currency === 'RMB' ? t('RMB view', '统一人民币显示') : t('USD view', '统一美元显示');
}

function getCurrencyToggleTitle(currentCurrency: MultiDayDisplayCurrency): string {
    const normalizedCurrency = normalizeDisplayCurrency(currentCurrency);
    const nextCurrency = getNextDisplayCurrency(currentCurrency);
    return t(
        'Current: {0}. Click to switch to {1}.',
        '当前：{0}。点击切换到{1}。',
        getCurrencyModeLabel(normalizedCurrency),
        getCurrencyModeLabel(nextCurrency)
    );
}

function toggleDisplayCurrency(): void {
    state.displayCurrency = getNextDisplayCurrency(state.displayCurrency);
    render();
}

// ============= 消息处理 =============

function handleMessage(event: MessageEvent): void {
    const msg = event.data as HostMessage;
    if (msg.command === 'updateMultiDayAnalysis') {
        if (msg.requestId !== window.multiDayRequestId) {
            return;
        }
        const hadData = state.data !== null;
        state.data = msg.data;
        state.displayCurrency =
            hadData ? normalizeDisplayCurrency(state.displayCurrency, msg.data) : getDefaultDisplayCurrency(msg.data);
        state.loading = false;
        state.error = null;
        render();
    } else if (msg.command === 'multiDayError') {
        if (msg.requestId !== window.multiDayRequestId) {
            return;
        }
        state.loading = false;
        state.error = msg.error;
        render();
    } else if (msg.command === 'refreshMultiDayAnalysis') {
        // 跨实例统计更新（含 Leader 完成晚到的重建回执）：按当前范围静默重拉
        requestCurrentRangeAnalysis();
    }
}

function handleClick(event: MouseEvent): void {
    const target = event.target;
    if (!(target instanceof Element)) {
        return;
    }

    if (target.closest('[data-toggle-cost-currency="true"]')) {
        toggleDisplayCurrency();
    }
}

// ============= 渲染 =============

function render(): void {
    const root = document.getElementById('app');
    if (!root) {
        return;
    }
    root.innerHTML = '';

    // 标题 + 日期选择器
    const header = createElement('div', 'md-header');
    const title = createElement('h2');
    title.textContent = t('Multi-Day Consumption', '多日消耗分析');
    header.appendChild(title);
    root.appendChild(header);

    // 日期范围选择器
    const pickerWrap = createElement('div', 'md-picker-section');
    pickerWrap.appendChild(createDateRangePicker());
    root.appendChild(pickerWrap);

    // 加载中
    if (state.loading) {
        const msg = createElement('div', 'empty-message');
        msg.textContent = t('Loading...', '加载中...');
        root.appendChild(msg);
        return;
    }

    // 错误
    if (state.error) {
        const msg = createElement('div', 'empty-message');
        msg.style.color = 'var(--vscode-errorForeground)';
        msg.textContent = '❌ ' + state.error;
        root.appendChild(msg);
        return;
    }

    // 无数据
    if (!state.data) {
        const msg = createElement('div', 'empty-message');
        msg.innerHTML = '💡 ' + t('Select a date range and click Analyze', '选择日期范围点击「分析」');
        root.appendChild(msg);
        return;
    }

    // 渲染内容
    const data = state.data;
    const renderOptions: MultiDayRenderOptions = {
        displayCurrency: normalizeDisplayCurrency(state.displayCurrency, data),
        costChartCurrency: getCostChartCurrency(state.displayCurrency, data),
        toggleTitle: getCurrencyToggleTitle(state.displayCurrency)
    };
    if (data.missingDates.length > 0) {
        const warning = createElement('div', 'empty-message');
        warning.style.color = 'var(--vscode-editorWarning-foreground)';
        warning.textContent = `⚠ ${t('Partial data: {0}/{1} days loaded', '部分数据：已加载 {0}/{1} 天', data.dates.length, data.dates.length + data.missingDates.length)}`;
        root.appendChild(warning);
    }
    root.appendChild(createSummaryCards(data, renderOptions));
    root.appendChild(createTrendChart(data));
    root.appendChild(createCostTrendChart(data, renderOptions));
    root.appendChild(createProviderModelRank(data, renderOptions));
}

// ============= 启动 =============

window.multiDayState = state;
window.multiDayRender = render;
window.multiDayRequestId = 0;
window.addEventListener('message', handleMessage);
document.addEventListener('click', handleClick);
document.addEventListener('DOMContentLoaded', render);
render();
// 首次打开自动选中最近 7 天并分析
initDefaultRange();
