/**
 * 多日消耗分析 WebView 入口
 */

import './style.less';
import 'chart.js/auto';

import type { HostMessage, MultiDayState } from './types';
import {
    createDateRangePicker,
    createSummaryCards,
    createTrendChart,
    createProviderModelRank,
    initDefaultRange
} from './components/index';
import { t } from '../usagesView/utils';
import { createElement } from '../utils';

// ============= 全局状态 =============

const state: MultiDayState = {
    data: null,
    loading: false,
    error: null
};

// ============= 消息处理 =============

function handleMessage(event: MessageEvent): void {
    const msg = event.data as HostMessage;
    if (msg.command === 'updateMultiDayAnalysis') {
        if (msg.requestId !== window.multiDayRequestId) return;
        state.data = msg.data;
        state.loading = false;
        state.error = null;
        render();
    } else if (msg.command === 'multiDayError') {
        if (msg.requestId !== window.multiDayRequestId) return;
        state.loading = false;
        state.error = msg.error;
        render();
    }
}

// ============= 渲染 =============

function render(): void {
    const root = document.getElementById('app');
    if (!root) return;
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
    if (data.missingDates.length > 0) {
        const warning = createElement('div', 'empty-message');
        warning.style.color = 'var(--vscode-editorWarning-foreground)';
        warning.textContent = `⚠ ${t('Partial data: {0}/{1} days loaded', '部分数据：已加载 {0}/{1} 天', data.dates.length, data.dates.length + data.missingDates.length)}`;
        root.appendChild(warning);
    }
    root.appendChild(createSummaryCards(data));
    root.appendChild(createTrendChart(data));
    root.appendChild(createProviderModelRank(data));
}

// ============= 启动 =============

window.multiDayState = state;
window.multiDayRender = render;
window.multiDayRequestId = 0;
window.addEventListener('message', handleMessage);
document.addEventListener('DOMContentLoaded', render);
render();
// 首次打开自动选中最近 7 天并分析
initDefaultRange();
