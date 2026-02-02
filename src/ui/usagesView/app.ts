/**
 * UsagesView 原生 TypeScript 入口
 */

import './style.less';
import 'chart.js/auto'; // 导入 Chart.js

import type { HostMessage, State } from './types';
import { getTodayDateString, postToVSCode } from './utils';
import { createElement } from '../utils';

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
        dateDetails: false
    }
};

// 跟踪上一次的日期，用于检测日期变化
let lastDateDetailsDate: string | null = null;

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
function setLoading(type: 'dateDetails', isLoading: boolean): void {
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
    const isLoading = state.loading.dateDetails;

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
                    records: message.records
                },
                loading: {
                    ...state.loading,
                    dateDetails: false
                }
            });

            // 如果是小屏幕模式，切换日期后自动隐藏侧边栏
            if (window.innerWidth <= 768) {
                toggleSidebar(false);
            }
            break;
    }
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
        const existingContainer = recordsSection.querySelector('#records-container') as HTMLElement;
        if (existingContainer && state.dateDetails) {
            // 检测日期是否变化
            const dateChanged = lastDateDetailsDate !== state.dateDetails.date;
            lastDateDetailsDate = state.dateDetails.date;

            // 如果日期变化了，重置页码；否则保持当前页码
            const page = dateChanged ? 1 : undefined;

            // 使用容器复用
            createRequestRecordsSection(
                state.dateDetails.records,
                page, // 日期变化时重置页码，否则保持当前页码
                existingContainer
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
 * 切换侧边栏显示/隐藏
 */
function toggleSidebar(show?: boolean): void {
    const sidebar = document.querySelector('.sidebar') as HTMLElement;
    const content = document.querySelector('.content') as HTMLElement;
    const toggleBtn = document.querySelector('.sidebar-toggle') as HTMLElement;

    if (!sidebar || !content) {
        return;
    }

    const isHidden = sidebar.classList.contains('hidden');
    const shouldShow = show !== undefined ? show : isHidden;

    if (shouldShow) {
        sidebar.classList.remove('hidden');
        content.classList.add('sidebar-open');
        if (toggleBtn) {
            toggleBtn.innerHTML = '<span class="toggle-icon">◀</span> 收起列表';
        }
        // 创建遮罩层
        createOrUpdateOverlay();
    } else {
        sidebar.classList.add('hidden');
        content.classList.remove('sidebar-open');
        if (toggleBtn) {
            toggleBtn.innerHTML = '<span class="toggle-icon">☰</span> 日期列表';
        }
        // 移除遮罩层
        removeOverlay();
    }
}

/**
 * 创建或更新遮罩层
 */
function createOrUpdateOverlay(): void {
    let overlay = document.getElementById('sidebar-overlay');
    if (!overlay) {
        overlay = createElement('div', 'sidebar-overlay');
        overlay.id = 'sidebar-overlay';
        // 点击遮罩层关闭侧边栏
        overlay.onclick = () => toggleSidebar(false);
        document.body.appendChild(overlay);
    }
}

/**
 * 移除遮罩层
 */
function removeOverlay(): void {
    const overlay = document.getElementById('sidebar-overlay');
    if (overlay) {
        overlay.remove();
    }
}

/**
 * 创建侧边栏切换按钮
 */
function createSidebarToggle(): HTMLElement {
    const button = createElement('button', 'sidebar-toggle');
    button.innerHTML = '<span class="toggle-icon">☰</span> 日期';
    button.onclick = () => toggleSidebar();
    return button;
}

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

    // 添加侧边栏切换按钮
    const content = document.querySelector('.content');
    if (content) {
        const toggleBtn = createSidebarToggle();
        content.insertBefore(toggleBtn, content.firstChild);
    }

    // 检查窗口宽度，如果小于768px，默认隐藏侧边栏
    if (window.innerWidth <= 768) {
        toggleSidebar(false);
    }

    // 监听窗口大小变化
    window.addEventListener('resize', () => {
        const sidebar = document.querySelector('.sidebar') as HTMLElement;
        if (!sidebar) {
            return;
        }

        if (window.innerWidth <= 768) {
            // 小屏幕时，默认隐藏侧边栏
            if (!sidebar.classList.contains('hidden')) {
                toggleSidebar(false);
            }
        } else {
            // 大屏幕时，默认显示侧边栏，并移除遮罩层
            if (sidebar.classList.contains('hidden')) {
                sidebar.classList.remove('hidden');
                const content = document.querySelector('.content') as HTMLElement;
                const toggleBtn = document.querySelector('.sidebar-toggle') as HTMLElement;
                if (content) {
                    content.classList.remove('sidebar-open');
                }
                if (toggleBtn) {
                    toggleBtn.innerHTML = '<span class="toggle-icon">☰</span> 日期';
                }
            }
            // 确保移除遮罩层
            removeOverlay();
        }
    });

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
