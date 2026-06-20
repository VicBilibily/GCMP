/**
 * UsagesView 原生 TypeScript 入口
 */

import './style.less';
import 'chart.js/auto'; // 导入 Chart.js

import type { HostMessage, State } from './types';
import type { LiveStreamMetricEvent } from '../../metrics/liveMetrics';
import { getTodayDateString, groupRecordsBySession, postToVSCode, t } from './utils';
import { createElement } from '../utils';

// 导入组件
import { createSidebar, updateDateList } from './components/dateList';
import { createMainContent, updateMainContent } from './components/mainContent';
import { createRequestRecordsSection, createRequestRecordsTable, resetRequestRecordsState } from './components/requestRecords';

// ============= 全局状态管理 =============

/**
 * 全局状态
 */
const state: State = {
    selectedDate: '',
    today: '',
    selectedSessionId: null,
    dateList: [],
    dateDetails: null,
    loading: {
        dateDetails: false
    }
};

// 跟踪上一次的日期，用于检测日期变化
let lastDateDetailsDate: string | null = null;

/**
 * 判断当前可视宽度是否需要折叠日期列表
 */
function shouldCollapseSidebar(): boolean {
    return window.matchMedia('(max-width: 999px)').matches;
}

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

/**
 * 单个请求的实时流式指标状态
 */
interface LiveMetricsState {
    requestStartTime: number;
    streamStartTime?: number;
    firstChunkLatencyMs: number;
    outputChars: number;
    charsPerSecond: number;
    lastOutputChangeAt: number; // 最后一次 provider 可计数字符增加的时间
    providerName?: string;
    modelName?: string;
}

// 支持多个并发请求的实时指标状态
const liveMetricsMap = new Map<string, LiveMetricsState>();

// 共享渲染时钟（rAF + 200ms 节流）
const LIVE_RENDER_INTERVAL_MS = 200;
let renderClockId: number | undefined;
let lastRenderAt = 0;

function startRenderClock(): void {
    if (renderClockId !== undefined) {
        return;
    }
    const tick = (frameTime: number): void => {
        if (liveMetricsMap.size === 0) {
            renderClockId = undefined;
            lastRenderAt = 0;
            return;
        }
        if (frameTime - lastRenderAt >= LIVE_RENDER_INTERVAL_MS) {
            updateRequestRecordsWithLiveMetrics();
            lastRenderAt = frameTime;
        }
        renderClockId = requestAnimationFrame(tick);
    };
    renderClockId = requestAnimationFrame(tick);
}

function stopRenderClock(): void {
    if (renderClockId !== undefined) {
        cancelAnimationFrame(renderClockId);
        renderClockId = undefined;
    }
    lastRenderAt = 0;
}

/**
 * 处理实时流式指标更新
 */
function handleLiveMetricsUpdate(event: LiveStreamMetricEvent): void {
    const { requestId } = event;

    switch (event.type) {
        case 'requestStarted':
            liveMetricsMap.set(requestId, {
                requestStartTime: event.requestStartTime,
                firstChunkLatencyMs: 0,
                outputChars: 0,
                charsPerSecond: 0,
                lastOutputChangeAt: 0,
                providerName: event.providerName,
                modelName: event.modelName
            });
            startRenderClock();
            break;

        case 'firstChunk': {
            // upsert：requestStarted 可能因面板未打开/日期切换而丢失
            const chunkState = liveMetricsMap.get(requestId) ?? {
                requestStartTime: event.requestStartTime,
                firstChunkLatencyMs: 0,
                outputChars: 0,
                charsPerSecond: 0,
                lastOutputChangeAt: 0,
                providerName: event.providerName,
                modelName: event.modelName
            };
            chunkState.requestStartTime = event.requestStartTime;
            chunkState.streamStartTime = event.streamStartTime;
            chunkState.firstChunkLatencyMs = event.firstChunkLatencyMs ?? 0;
            chunkState.providerName = chunkState.providerName || event.providerName;
            chunkState.modelName = chunkState.modelName || event.modelName;
            liveMetricsMap.set(requestId, chunkState);
            startRenderClock();
            break;
        }

        case 'streamingUpdate': {
            let state = liveMetricsMap.get(requestId);
            if (!state) {
                state = {
                    requestStartTime: event.requestStartTime,
                    streamStartTime: event.streamStartTime,
                    firstChunkLatencyMs: event.firstChunkLatencyMs ?? 0,
                    outputChars: 0,
                    charsPerSecond: 0,
                    lastOutputChangeAt: 0,
                    providerName: event.providerName,
                    modelName: event.modelName
                };
                liveMetricsMap.set(requestId, state);
                startRenderClock();
            }
            state.requestStartTime = event.requestStartTime;
            // 只在 outputChars 实际增加时更新 lastOutputChangeAt（避免 heartbeat/ping 误刷新）
            const previousOutputChars = state.outputChars;
            if (event.outputChars !== undefined && event.outputChars > previousOutputChars) {
                state.outputChars = event.outputChars;
                state.lastOutputChangeAt = Date.now();
            }
            state.charsPerSecond = event.charsPerSecond ?? state.charsPerSecond;
            // 补齐 provider/model（requestStarted 可能未被 WebView 接收到）
            state.providerName = state.providerName || event.providerName;
            state.modelName = state.modelName || event.modelName;
            if (event.streamStartTime !== undefined) {
                state.streamStartTime = event.streamStartTime;
            }
            if (event.firstChunkLatencyMs !== undefined) {
                state.firstChunkLatencyMs = event.firstChunkLatencyMs;
            }
            break;
        }

        case 'streamEnd': {
            removeLivePlaceholderRow(requestId);
            liveMetricsMap.delete(requestId);
            if (liveMetricsMap.size === 0) {
                stopRenderClock();
            }
            updateRequestRecordsWithLiveMetrics();
            return;
        }
    }

    // 触发请求记录区域的更新
    updateRequestRecordsWithLiveMetrics();
}

/**
 * 清理由实时指标创建的临时占位行（streamEnd 时调用）
 * 仅删除标记为 data-live-placeholder 的行，不误删由 updateDateDetails 渲染的真实记录行
 */
function removeLivePlaceholderRow(requestId: string): void {
    const recordsContainer = document.querySelector('#records-container') as HTMLElement | null;
    const tbody = recordsContainer?.querySelector('tbody');
    if (!tbody) {
        return;
    }
    const row = Array.from(tbody.querySelectorAll('tr'))
        .find(r => r.getAttribute('data-request-id') === requestId) as HTMLTableRowElement | undefined;
    if (row?.getAttribute('data-live-placeholder') === 'true') {
        row.remove();
        // 占位行删除后若表格为空，恢复"暂无请求记录"空行
        if (!tbody.querySelector('tr')) {
            const emptyRow = document.createElement('tr');
            const emptyCell = document.createElement('td');
            emptyCell.colSpan = 10;
            emptyCell.textContent = t('No request records yet', '暂无请求记录');
            emptyCell.style.textAlign = 'center';
            emptyRow.appendChild(emptyCell);
            tbody.appendChild(emptyRow);
        }
    }
}

/**
 * 判断当前是否在查看今天的请求记录（实时指标仅适用于今天）
 */
function isViewingToday(): boolean {
    const today = state.today || getTodayDateString();
    return state.dateDetails?.isToday === true || state.dateDetails?.date === today;
}

/**
 * 更新请求记录区域，显示实时指标
 * 策略：遍历所有正在流式的请求，通过 requestId 精确匹配表格行并更新
 */
function updateRequestRecordsWithLiveMetrics(): void {
    // 仅在今天页面渲染实时指标，不污染历史日期
    if (!isViewingToday()) {
        return;
    }

    const recordsContainer = document.querySelector('#records-container') as HTMLElement;
    if (!recordsContainer) {
        return;
    }

    let tbody = recordsContainer.querySelector('tbody');
    if (!tbody) {
        // 无 tbody（当天无记录），替换 .empty-message 为标准空表格，保留外层布局
        const emptyMessage = recordsContainer.querySelector('.empty-message');
        if (!emptyMessage) {
            return;
        }
        const table = createRequestRecordsTable([], []);
        emptyMessage.replaceWith(table);
        tbody = table.querySelector('tbody');
        if (!tbody) {
            return;
        }
    }

    const now = Date.now();
    // 有会话筛选时，新请求可能不属于当前会话，不创建占位行（真实行仍可更新）
    const hasSessionFilter = !!state.selectedSessionId;

    liveMetricsMap.forEach((metricState, requestId) => {
        let targetRow = Array.from(tbody!.querySelectorAll('tr'))
            .find(row => row.getAttribute('data-request-id') === requestId) as HTMLTableRowElement | undefined;

        // 占位行：liveMetrics 已有数据但表格行尚未创建（updateDateDetails 尚未到达）
        if (!targetRow) {
            // 有会话筛选时，新请求不属于当前会话，跳过占位行创建
            if (hasSessionFilter) {
                return;
            }
            targetRow = document.createElement('tr');
            targetRow.setAttribute('data-request-id', requestId);
            targetRow.setAttribute('data-request-status', 'streaming');
            targetRow.setAttribute('data-live-placeholder', 'true');

            // 时间
            const timeCell = document.createElement('td');
            timeCell.textContent = new Date(metricState.requestStartTime).toLocaleTimeString('zh-CN');
            targetRow.appendChild(timeCell);

            // 提供商
            const providerCell = document.createElement('td');
            providerCell.textContent = metricState.providerName || '-';
            targetRow.appendChild(providerCell);

            // 模型
            const modelCell = document.createElement('td');
            modelCell.textContent = metricState.modelName || '-';
            targetRow.appendChild(modelCell);

            // 输入令牌
            const inputCell = document.createElement('td');
            inputCell.textContent = '-';
            targetRow.appendChild(inputCell);

            // 缓存命中
            const cacheCell = document.createElement('td');
            cacheCell.textContent = '-';
            targetRow.appendChild(cacheCell);

            // 输出令牌
            const outputCell = document.createElement('td');
            outputCell.textContent = '-';
            targetRow.appendChild(outputCell);

            // 消耗令牌
            const totalCell = document.createElement('td');
            totalCell.textContent = '-';
            targetRow.appendChild(totalCell);

            // 首令延迟 + 输出耗时
            const timingCell = document.createElement('td');
            timingCell.setAttribute('data-metric', 'timing');
            targetRow.appendChild(timingCell);

            // 输出速度
            const speedCell = document.createElement('td');
            speedCell.setAttribute('data-metric', 'speed');
            targetRow.appendChild(speedCell);

            // 状态
            const statusCell = document.createElement('td');
            statusCell.className = 'status-estimated';
            statusCell.textContent = '⏳';
            targetRow.appendChild(statusCell);

            // 移除空状态行（如 "暂无请求记录"）并插入占位行
            const firstRow = tbody!.querySelector('tr');
            if (firstRow && firstRow.querySelector('td[colspan]')) {
                firstRow.remove();
            }
            tbody!.insertBefore(targetRow, tbody!.firstChild);
        }

        // 跳过已完成/失败的行，避免实时值覆盖最终统计
        const requestStatus = targetRow.getAttribute('data-request-status');
        if (requestStatus === 'completed' || requestStatus === 'failed') {
            return;
        }

        // 实时计算首令延迟：首流事件前持续增长，首流事件后固定
        const hasStreamStarted = metricState.streamStartTime !== undefined;
        const latencyMs = hasStreamStarted
            ? metricState.firstChunkLatencyMs
            : Math.max(0, now - metricState.requestStartTime);

        // 实时计算输出耗时：首流事件后开始计算
        const durationMs = hasStreamStarted
            ? Math.max(0, now - metricState.streamStartTime!)
            : 0;

        // 输出速度：使用 StreamReporter 缓存的值，暂停期间不会衰减
        const charsPerSecond = metricState.charsPerSecond ?? 0;

        // 更新首令延迟 + 输出耗时 + 速度
        const outputCell = targetRow.querySelector('td.records-output-merged[data-metric="output"]') as HTMLElement;
        if (outputCell) {
            const ttftSpan = outputCell.querySelector('.output-ttft') as HTMLElement;
            if (ttftSpan) {
                ttftSpan.textContent = latencyMs >= 1000 ?
                    `${(latencyMs / 1000).toFixed(1)}s` :
                    `${Math.round(latencyMs)}ms`;
            }
            const tpotSpan = outputCell.querySelector('.output-tpot') as HTMLElement;
            if (tpotSpan) {
                tpotSpan.textContent = durationMs > 0 ?
                    (durationMs >= 1000 ? `${(durationMs / 1000).toFixed(1)}s` : `${Math.round(durationMs)}ms`) :
                    '-';
            }
            // .output-tokens 在 streaming 阶段不更新，等最终 usage 回写
            const speedSpan = outputCell.querySelector('.output-speed') as HTMLElement;
            if (speedSpan) {
                // 过时检测：长时间没有新的 provider 输出时，避免冻结的旧 speed 被误解为仍在实时更新
                const lastOutputChangeAt = metricState.lastOutputChangeAt ?? 0;
                const outputStaleMs = lastOutputChangeAt > 0 ? now - lastOutputChangeAt : 0;
                const isStale = hasStreamStarted && metricState.outputChars > 0 && lastOutputChangeAt > 0 && outputStaleMs > 3000;

                if (isStale) {
                    speedSpan.textContent = t('⏳ waiting...', '⏳ 等待回传...');
                    speedSpan.title = t(
                        'No new provider output chunk has arrived recently. Some compatible endpoints buffer tool arguments and send them in a later chunk; speed will update when new output arrives.',
                        '近期未收到新的 provider 输出分片。部分兼容端点会缓冲工具参数并稍后一次性发送；速度将在收到新输出时更新。'
                    );
                } else if (charsPerSecond > 0) {
                    speedSpan.textContent = `~${charsPerSecond.toFixed(1)} chars/s`;
                    speedSpan.title = t(
                        'Live speed is estimated by streamed characters; final speed uses output tokens.',
                        '实时速度按流式字符估算，完成后以输出 token/s 为准。'
                    );
                } else {
                    speedSpan.textContent = '-';
                }
            }
        }
    });
}

/**
 * 处理来自 VSCode 的消息
 */
function handleVSCodeMessage(event: MessageEvent): void {
    const message = event.data as HostMessage;
    console.log('[UsagesView] Received message:', message.command, message);

    switch (message.command) {
        case 'updateDateList':
            setState({
                dateList: message.dateList,
                selectedDate: message.selectedDate || state.selectedDate,
                today: message.today || getTodayDateString()
            });
            break;

        case 'updateDateDetails': {
            const sessionGroups = groupRecordsBySession(message.records);
            const dateChanged = state.dateDetails?.date !== message.date;
            const nextSelectedSessionId =
                (
                    !dateChanged &&
                    state.selectedSessionId &&
                    sessionGroups.some(group => group.sessionId === state.selectedSessionId)
                ) ?
                    state.selectedSessionId
                    : null;

            if (dateChanged) {
                resetRequestRecordsState();
                // 切到非今天时停止实时渲染；切到今天时保留正在进行的 liveMetrics，
                // 避免 requestStarted 先到达后被 updateDateDetails 清空导致 TTFT 不显示
                if (!message.isToday) {
                    liveMetricsMap.clear();
                    stopRenderClock();
                }
            }

            setState({
                selectedSessionId: nextSelectedSessionId,
                dateDetails: {
                    date: message.date,
                    isToday: message.isToday,
                    providers: message.providers,
                    hourlyStats: message.hourlyStats,
                    records: message.records,
                    sessionGroups
                },
                loading: {
                    ...state.loading,
                    dateDetails: false
                }
            });

            // setState 会重建表格，立即重新覆盖仍在运行的请求
            updateRequestRecordsWithLiveMetrics();

            // 仅在真正切换日期时，小屏模式才自动隐藏侧边栏
            if (dateChanged && shouldCollapseSidebar()) {
                toggleSidebar(false);
            }
            break;
        }

        case 'updateLiveMetrics':
            handleLiveMetricsUpdate(message.event);
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
            // 检测日期是否变化
            const dateChanged = lastDateDetailsDate !== state.dateDetails.date;
            lastDateDetailsDate = state.dateDetails.date;

            // 仅在切换日期时重置页码；同日实时刷新保持当前页
            const page = dateChanged ? 1 : undefined;

            // 使用容器复用
            createRequestRecordsSection(state.dateDetails.sessionGroups, page, existingContainer);
        }
    }
}

/**
 * 刷新所有视图
 */
function refreshViews(): void {
    console.log('[UsagesView] State changed:', {
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
    console.log('[UsagesView] Initializing webview app');

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
