/**
 * UsagesView 原生 TypeScript 入口
 */

import './style.less';
import 'chart.js/auto'; // 导入 Chart.js

import type { HostMessage, State } from './types';
import {
    getDefaultDisplayCurrency,
    getNextDisplayCurrency,
    getTodayDateString,
    normalizeDisplayCurrency,
    postToVSCode,
    t
} from './utils';
import { createElement } from '../utils';
import { LiveMetricsRenderer } from './liveMetricsRenderer';

// 导入组件
import { createSidebar, updateDateList } from './components/dateList';
import { createMainContent, updateMainContent } from './components/mainContent';
import {
    createRequestRecordsSection,
    fetchDetailByCurrentView,
    getTrackedRecordsLimit,
    getTrackedSessionIds,
    isStaleDetailError,
    isStaleDetailResponse,
    isTrackModeActive,
    refreshRequestRecordCosts,
    resetRequestRecordsState
} from './components/requestRecords';
import { shouldShowSessionGroupInFilter } from './components/sessionFilter';

// ============= 全局状态管理 =============

/**
 * 全局状态
 */
const state: State = {
    selectedDate: '',
    today: '',
    selectedSessionId: null,
    selectedSessionIds: [],
    displayCurrency: 'MIXED',
    dateList: [],
    dateDetails: null,
    loading: {
        dateDetails: false
    }
};

/**
 * 判断当前可视宽度是否需要折叠日期列表
 */
function shouldCollapseSidebar(): boolean {
    return window.matchMedia('(max-width: 999px)').matches;
}

/**
 * 状态监听器列表
 */
type StateListener = (state: State, prevState: State, patch: Partial<State>) => void;

const listeners: StateListener[] = [];

/**
 * 设置状态并通知监听器
 */
function setState(newState: Partial<State>): void {
    const prevState: State = {
        ...state,
        loading: state.loading,
        dateDetails: state.dateDetails,
        dateList: state.dateList
    };
    Object.assign(state, newState);
    listeners.forEach(listener => listener(state, prevState, newState));

    // 如果更新了 loading 状态，同步更新遮罩层
    if (newState.loading) {
        updateLoadingOverlay();
    }
}

/**
 * 订阅状态变化
 */
function subscribeState(listener: StateListener): () => void {
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
            text.textContent = t('Loading...', '加载中...');

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

// 实时流式指标渲染器：所有实时状态机、占位行 DOM、共享渲染时钟都在这里
// 依赖注入 getState，避免与 app.ts 全局状态耦合
const liveMetricsRenderer = new LiveMetricsRenderer({ getState: () => state });

/**
 * 处理来自 VSCode 的消息
 */
function handleVSCodeMessage(event: MessageEvent): void {
    const message = event.data as HostMessage;

    switch (message.command) {
        case 'updateDateList':
            setState({
                dateList: message.dateList,
                selectedDate: message.selectedDate || state.selectedDate,
                today: message.today || getTodayDateString()
            });
            break;

        case 'updateDateDetails': {
            const sessionGroups = message.sessionGroups;
            const dateChanged = state.dateDetails?.date !== message.date;
            let nextSelectedSessionId =
                (
                    !dateChanged &&
                    state.selectedSessionId &&
                    sessionGroups.some(group => group.sessionId === state.selectedSessionId)
                ) ?
                    state.selectedSessionId
                :   null;
            // 多选跟踪：同日实时刷新时保留仍存在的会话，切换日期时清空；
            // 不足 2 个时回落为单选，保持筛选栏高亮与详情视图一致
            let nextSelectedSessionIds =
                dateChanged ?
                    []
                :   state.selectedSessionIds.filter(id => sessionGroups.some(group => group.sessionId === id));
            if (nextSelectedSessionIds.length === 1) {
                nextSelectedSessionId = nextSelectedSessionIds[0];
                nextSelectedSessionIds = [];
            }

            if (dateChanged) {
                resetRequestRecordsState();
            }

            const prevDetails = state.dateDetails;
            const nextTrackMode = message.isToday && nextSelectedSessionIds.length >= 2;
            const nextRecordsView =
                dateChanged ? null
                : nextTrackMode ? null
                : nextSelectedSessionId ?
                    (
                        prevDetails?.recordsView?.mode === 'session' &&
                        prevDetails.recordsView.sessionId === nextSelectedSessionId
                    ) ?
                        prevDetails.recordsView
                    :   null
                : prevDetails?.recordsView?.mode === 'all' ? prevDetails.recordsView
                : null;
            const nextTrackRecords = dateChanged || !nextTrackMode ? null : (prevDetails?.trackRecords ?? null);
            const nextDetailLoading = dateChanged ? true : (prevDetails?.detailLoading ?? false);

            setState({
                selectedDate: message.date,
                selectedSessionId: nextSelectedSessionId,
                selectedSessionIds: nextSelectedSessionIds,
                displayCurrency: normalizeDisplayCurrency(state.displayCurrency, message.allTotals),
                dateDetails: {
                    date: message.date,
                    isToday: message.isToday,
                    isExtensionHostDebugMode: message.isExtensionHostDebugMode,
                    providers: message.providers,
                    hourlyStats: message.hourlyStats,
                    allSummary: message.allSummary,
                    allTotals: message.allTotals,
                    nativeSplitIndex: message.nativeSplitIndex,
                    sessionGroups,
                    updateSeq: message.updateSeq,
                    detailLoading: nextDetailLoading,
                    // 同日刷新仅在视图模式仍与当前选中状态一致时复用旧明细
                    recordsView: nextRecordsView,
                    trackRecords: nextTrackRecords,
                    detailError: null
                },
                loading: {
                    ...state.loading,
                    // 切日期时等首个明细响应到达后再关闭遮罩，避免先看到占位态再闪回真实内容
                    dateDetails: dateChanged ? state.loading.dateDetails : false
                }
            });

            // 通知实时指标渲染器：日期切换后立即重建表格（包括仍在运行的请求），
            // 并按需启停渲染时钟（切到非今天时停止，切回今天时由内部 isViewingToday 守卫恢复）
            liveMetricsRenderer.onDateChanged(message.isToday, dateChanged);

            // 仅在真正切换日期时，小屏模式才自动隐藏侧边栏
            if (dateChanged && shouldCollapseSidebar()) {
                toggleSidebar(false);
            }

            // 摘要到达后按当前视图状态拉取明细
            fetchDetailByCurrentView();
            break;
        }

        case 'recordsPage': {
            const details = state.dateDetails;
            // 过期响应：切日期 / 已进入跟踪模式 / 参数与最近请求不一致
            if (!details || details.date !== message.date || isTrackModeActive() || isStaleDetailResponse(message)) {
                break;
            }
            if (message.updateSeq < details.updateSeq) {
                // 响应落后于最新摘要：补偿重拉一次（扩展侧缓存已是最新，一次即收敛）
                postToVSCode({
                    command: 'getRecordsPage',
                    date: message.date,
                    mode: message.mode,
                    sessionId: message.sessionId,
                    page: message.page
                });
                break;
            }
            setState({
                dateDetails: {
                    ...details,
                    recordsView: {
                        mode: message.mode,
                        sessionId: message.sessionId,
                        page: message.page,
                        totalItems: message.totalItems,
                        records: message.records,
                        summary: message.summary,
                        totals: message.totals,
                        recoveryDebug: message.recoveryDebug
                    },
                    detailLoading: false,
                    trackRecords: null,
                    detailError: null
                },
                loading: {
                    ...state.loading,
                    dateDetails: false
                }
            });
            break;
        }

        case 'trackRecords': {
            const details = state.dateDetails;
            // 过期响应：切日期 / 已退出跟踪模式 / 参数与最近请求不一致
            if (!details || details.date !== message.date || !isTrackModeActive() || isStaleDetailResponse(message)) {
                break;
            }
            if (message.updateSeq < details.updateSeq) {
                // 响应落后于最新摘要：按当前跟踪会话补偿重拉一次
                const visibleGroups = details.sessionGroups.filter(shouldShowSessionGroupInFilter);
                const trackedIds = getTrackedSessionIds(new Set(visibleGroups.map(group => group.sessionId)));
                postToVSCode({
                    command: 'getTrackRecords',
                    date: message.date,
                    sessionIds: trackedIds,
                    limitPerSession: getTrackedRecordsLimit(trackedIds.length)
                });
                break;
            }
            setState({
                dateDetails: {
                    ...details,
                    trackRecords: { groups: message.groups },
                    detailLoading: false,
                    recordsView: null,
                    detailError: null
                },
                loading: {
                    ...state.loading,
                    dateDetails: false
                }
            });
            break;
        }

        case 'detailLoadError': {
            const details = state.dateDetails;
            if (!details || details.date !== message.date) {
                break;
            }
            if (isStaleDetailError(message)) {
                break;
            }
            if (message.updateSeq < details.updateSeq) {
                break;
            }
            setState({
                dateDetails: {
                    ...details,
                    detailLoading: false,
                    detailError: message,
                    recordsView: message.mode === 'track' ? null : details.recordsView,
                    trackRecords: message.mode === 'track' ? null : details.trackRecords
                },
                loading: {
                    ...state.loading,
                    dateDetails: false
                }
            });
            break;
        }

        case 'updateLiveMetrics':
            liveMetricsRenderer.handleEvent(message.event);
            break;
    }
}

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
            h2.textContent = t('Request Records', '请求记录');
            const container = createElement('div', '', { id: 'records-container' });
            recordsSection.appendChild(h2);
            recordsSection.appendChild(container);
            content.appendChild(recordsSection);
        }
    }

    if (recordsSection) {
        const existingContainer = recordsSection.querySelector('#records-container') as HTMLElement;
        if (existingContainer && state.dateDetails) {
            // 使用容器复用（页码与视图模式由 dateDetails.recordsView / trackRecords 维护）
            createRequestRecordsSection(state.dateDetails.sessionGroups, existingContainer);
        }
    }
}

/**
 * 刷新所有视图
 */
function refreshViews(prevState: State, patch: Partial<State>): void {
    if (patch.dateList || patch.selectedDate !== undefined || patch.today !== undefined) {
        updateDateList(state.dateList);
    }

    if (patch.dateDetails) {
        // 摘要未变（仅明细页刷新：翻页/跟踪响应）时跳过主内容区重建，避免图表闪烁；
        // 摘要刷新（updateSeq 变化）才重建 provider/hourly 统计与图表
        if (prevState.dateDetails?.updateSeq === state.dateDetails?.updateSeq) {
            updateRequestRecords();
        } else {
            updateMainContent();
            updateRequestRecords();
        }
        return;
    }

    if (patch.displayCurrency !== undefined && patch.displayCurrency !== prevState.displayCurrency) {
        updateMainContent({ currencyOnly: true });
        // 传 document 使侧边栏日期列表与 records-container 内的成本同步刷新
        refreshRequestRecordCosts(document);
    }
}

function toggleDisplayCurrency(): void {
    setState({
        displayCurrency: getNextDisplayCurrency(state.displayCurrency)
    });
}

// ============= 主应用 =============

/**
 * 切换侧边栏显示/隐藏
 */
function toggleSidebar(show?: boolean): void {
    const sidebar = document.querySelector('.sidebar') as HTMLElement;
    const toggleBtn = document.querySelector('.sidebar-toggle') as HTMLElement;

    if (!sidebar) {
        return;
    }

    const isHidden = sidebar.classList.contains('hidden');
    const shouldShow = show !== undefined ? show : isHidden;

    if (shouldShow) {
        sidebar.classList.remove('hidden');
        if (toggleBtn) {
            toggleBtn.innerHTML = `<span class="toggle-icon">◀</span> ${t('Collapse List', '收起列表')}`;
        }
        // 创建遮罩层
        createOrUpdateOverlay();
    } else {
        sidebar.classList.add('hidden');
        if (toggleBtn) {
            toggleBtn.innerHTML = `<span class="toggle-icon">☰</span> ${t('Date List', '日期列表')}`;
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
    button.innerHTML = `<span class="toggle-icon">☰</span> ${t('Date', '日期')}`;
    button.onclick = () => toggleSidebar();
    return button;
}

/**
 * 初始化应用
 */
function initApp(): void {
    state.displayCurrency = getDefaultDisplayCurrency();

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

    // 添加侧边栏切换按钮和 Tab 栏
    const content = document.querySelector('.content');
    if (content) {
        const toggleBtn = createSidebarToggle();
        content.insertBefore(toggleBtn, content.firstChild);
    }

    // 检查窗口宽度，如果小于450px，默认隐藏侧边栏
    if (shouldCollapseSidebar()) {
        toggleSidebar(false);
    }

    // 监听窗口大小变化
    window.addEventListener('resize', () => {
        const sidebar = document.querySelector('.sidebar') as HTMLElement;
        if (!sidebar) {
            return;
        }

        if (shouldCollapseSidebar()) {
            // 小屏幕时，默认隐藏侧边栏
            if (!sidebar.classList.contains('hidden')) {
                toggleSidebar(false);
            }
        } else {
            // 大屏幕时，默认显示侧边栏，并移除遮罩层
            if (sidebar.classList.contains('hidden')) {
                sidebar.classList.remove('hidden');
                const toggleBtn = document.querySelector('.sidebar-toggle') as HTMLElement;
                if (toggleBtn) {
                    toggleBtn.innerHTML = `<span class="toggle-icon">☰</span> ${t('Date', '日期')}`;
                }
            }
            // 确保移除遮罩层
            removeOverlay();
        }
    });

    // 设置今日日期
    state.today = getTodayDateString();

    // 订阅状态变化
    subscribeState((nextState, prevState, patch) => refreshViews(prevState, patch));

    // 注册消息监听
    window.addEventListener('message', handleVSCodeMessage);

    // 捕获阶段处理成本 span 的点击：优先完成币种切换并阻断冒泡，
    // 避免冒泡到日期条目/会话条目的选中 onclick 触发整页重载
    document.addEventListener(
        'click',
        event => {
            const target = (event.target as HTMLElement | null)?.closest('[data-toggle-cost-currency="true"]');
            if (!target) {
                return;
            }
            event.preventDefault();
            event.stopPropagation();
            toggleDisplayCurrency();
        },
        { capture: true }
    );

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
