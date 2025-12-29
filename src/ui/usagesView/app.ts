/**
 * UsagesView 原生 TypeScript 入口
 */

import './style.less';

import type { HostMessage, State } from './types';
import { getTodayDateString, postToVSCode } from './utils';

// 导入组件
import { createSidebar, updateDateList } from './components/dateList';
import { createMainContent, updateMainContent } from './components/mainContent';
import { createRequestRecordsSection } from './components/requestRecords';

// ============= 全局状态管理 =============

/**
 * 全局状态
 */
const state: State = {
    selectedDate: '',
    today: '',
    dateList: [],
    dateDetails: null,
    loading: {
        dateDetails: false,
        pageRecords: false
    }
};

/**
 * 状态监听器列表
 */
const listeners: ((state: State) => void)[] = [];

/**
 * 设置状态并通知监听器
 */
function setState(newState: Partial<State>): void {
    Object.assign(state, newState);
    listeners.forEach(listener => listener(state));

    // 如果更新了 loading 状态，同步更新遮罩层
    if (newState.loading) {
        updateLoadingOverlay();
    }
}

/**
 * 订阅状态变化
 */
function subscribeState(listener: (state: State) => void): () => void {
    listeners.push(listener);
    return () => {
        const index = listeners.indexOf(listener);
        if (index > -1) {
            listeners.splice(index, 1);
        }
    };
}

/**
 * 设置加载状态
 */
function setLoading(type: 'dateDetails' | 'pageRecords', isLoading: boolean): void {
    setState({
        loading: {
            ...state.loading,
            [type]: isLoading
        }
    });

    // 更新 loading-overlay 的显示状态
    updateLoadingOverlay();
}

/**
 * 更新加载遮罩层的显示状态
 */
function updateLoadingOverlay(): void {
    let overlay = document.getElementById('loading-overlay');

    // 如果需要显示loading且overlay不存在，则创建
    const isLoading = state.loading.dateDetails || state.loading.pageRecords;

    if (isLoading) {
        if (!overlay) {
            overlay = createElement('div', 'loading-overlay');
            overlay.id = 'loading-overlay';

            const content = createElement('div', 'loading-content');
            const spinner = createElement('div', 'loading-spinner');
            const text = createElement('div', 'loading-text');
            text.textContent = '加载中...';

            content.appendChild(spinner);
            content.appendChild(text);
            overlay.appendChild(content);
            document.body.appendChild(overlay);
        }

        // 使用 setTimeout 确保 DOM 更新后再添加 visible 类
        setTimeout(() => {
            overlay?.classList.add('visible');
        }, 0);
    } else {
        // 隐藏并移除 overlay
        if (overlay) {
            overlay.classList.remove('visible');
            setTimeout(() => {
                overlay?.remove();
            }, 200); // 等待过渡动画完成
        }
    }
}

/**
 * 处理来自 VSCode 的消息
 */
function handleVSCodeMessage(event: MessageEvent): void {
    const message = event.data as HostMessage;
    console.log('[UsagesView] 收到消息:', message.command, message);

    switch (message.command) {
        case 'updateDateList':
            setState({
                dateList: message.dateList,
                selectedDate: message.selectedDate || state.selectedDate,
                today: message.today || getTodayDateString()
            });
            break;

        case 'updateDateDetails':
            setState({
                dateDetails: {
                    date: message.date,
                    isToday: message.isToday,
                    providers: message.providers,
                    hourlyStats: message.hourlyStats,
                    records: message.records,
                    currentPage: message.currentPage
                },
                loading: {
                    ...state.loading,
                    dateDetails: false
                }
            });
            break;

        case 'updatePageRecords':
            if (state.dateDetails) {
                setState({
                    dateDetails: {
                        ...state.dateDetails,
                        records: message.records,
                        currentPage: message.page
                    },
                    loading: {
                        ...state.loading,
                        pageRecords: false
                    }
                });
            }
            break;

        case 'updateStatsOnly':
            if (state.dateDetails) {
                setState({
                    dateDetails: {
                        ...state.dateDetails,
                        providers: message.providers,
                        hourlyStats: message.hourlyStats
                    }
                });
            }
            break;
    }
}

// ============= DOM 工具函数 =============

/**
 * 创建元素
 */
function createElement(tag: string, className: string = '', attributes: Record<string, unknown> = {}): HTMLElement {
    const element = document.createElement(tag);
    if (className) {
        element.className = className;
    }
    Object.assign(element, attributes);
    return element;
}

// ============= 视图更新 =============

/**
 * 更新请求记录
 */
function updateRequestRecords(): void {
    // 找到请求记录容器，如果不存在则创建
    let recordsSection = document.querySelector('#records-section')?.parentElement;
    if (!recordsSection) {
        const content = document.querySelector('.content');
        if (content) {
            recordsSection = createElement('section');
            const h2 = createElement('h2', '', { id: 'records-section' });
            h2.textContent = '请求记录';
            const container = createElement('div', '', { id: 'records-container' });
            recordsSection.appendChild(h2);
            recordsSection.appendChild(container);
            content.appendChild(recordsSection);
        }
    }

    if (recordsSection) {
        const container = recordsSection.querySelector('#records-container') || recordsSection.querySelector('div');
        if (container && state.dateDetails) {
            container.innerHTML = '';
            container.appendChild(
                createRequestRecordsSection(state.dateDetails.records, state.dateDetails.currentPage)
            );
        }
    }
}

/**
 * 刷新所有视图
 */
function refreshViews(): void {
    console.log('[UsagesView] 状态变化:', {
        state,
        selectedDate: state.selectedDate,
        dateListLength: state.dateList.length,
        hasDetails: !!state.dateDetails
    });
    updateDateList(state.dateList);
    updateMainContent();
    updateRequestRecords();
}

// ============= 主应用 =============

/**
 * 初始化应用
 */
function initApp(): void {
    console.log('[UsagesView] 初始化原生 JS 应用');

    // 将状态和工具函数挂载到 window 对象，供所有组件访问
    window.usagesState = state;
    window.usagesSetLoading = setLoading;

    // 创建主容器
    const container = createElement('div', 'container');
    container.id = 'usages-view-container';

    // 创建侧边栏和主内容区
    const sidebar = createSidebar();
    const mainContent = createMainContent();

    container.appendChild(sidebar);
    container.appendChild(mainContent);

    // 添加到文档
    document.body.innerHTML = '';
    document.body.appendChild(container);

    // 设置今日日期
    state.today = getTodayDateString();

    // 订阅状态变化
    subscribeState(() => refreshViews());

    // 注册消息监听
    window.addEventListener('message', handleVSCodeMessage);

    // 请求初始数据
    postToVSCode({ command: 'getInitialData' });
}

// ============= 启动 =============

// 当 DOM 准备好时启动应用
if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initApp);
} else {
    initApp();
}
