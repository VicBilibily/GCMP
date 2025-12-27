/** @jsxImportSource vue */
/**
 * Token Usages View - Vapor 原生 JS 组件
 * Token 用量详细视图 - 使用纯 JS 实现，无 Vue 响应式系统
 */

import { ref } from './vendor/vue';
import type {
    DateSummary,
    ProviderData,
    HourlyStatsItem,
    UsageRecord,
    UpdateDateListMessage,
    UpdateDateDetailsMessage,
    UpdatePageRecordsMessage,
    UpdateStatsOnlyMessage,
    ModelData
} from './usagesViewBridge';
import { postToVSCode, selectDate, changePage, openStorageDir, refresh } from './usagesViewBridge';

// ============= 模块级别的状态 =============
let selectedDate = '';
let currentPage = 1;
let dateSummaries: DateSummary[] = [];
let providers: ProviderData[] = [];
let hourlyStats: Record<string, HourlyStatsItem> | undefined = undefined;
let records: UsageRecord[] = [];
const expandedProviders = new Set<string>();
let today = '';

// 响应式触发器 - 用于在数据更新时触发重新渲染
const refreshTrigger = ref(0);

// 初始化标志
let initialized = false;

/**
 * 初始化组件（模块级别初始化）
 */
function initializeComponent() {
    if (initialized) return;
    initialized = true;

    // 延迟确保VSCode API已准备好
    setTimeout(() => {
        postToVSCode({ command: 'getInitialData' } as any);
    }, 100);

    // 监听来自 VSCode 的消息
    const handleMessage = (event: MessageEvent<any>) => {
        const message = event.data;

        if (message.command === 'updateDateList') {
            const msg = message as UpdateDateListMessage;
            dateSummaries = msg.dateList;
            selectedDate = (message as any).selectedDate || selectedDate;
            today = (message as any).today || today;
            // 不重置页码，保持用户当前浏览状态
            refreshTrigger.value++; // 触发重新渲染
            console.log('[UsagesView] 已更新日期列表', dateSummaries.length, '当前页', currentPage);
        } else if (message.command === 'updateDateDetails') {
            const msg = message as UpdateDateDetailsMessage;
            providers = msg.providers;
            hourlyStats = msg.hourlyStats;
            records = msg.records;
            // 只在切换日期时重置页码，自动刷新时保持当前页码
            if (msg.date !== selectedDate) {
                currentPage = 1;
            } else {
                currentPage = msg.currentPage;
            }
            selectedDate = msg.date;
            refreshTrigger.value++; // 触发重新渲染
            console.log('[UsagesView] 已更新日期详情', providers.length, '记录', records.length, '页码', currentPage);
        } else if (message.command === 'updateStatsOnly') {
            const msg = message as UpdateStatsOnlyMessage;
            providers = msg.providers;
            hourlyStats = msg.hourlyStats;
            refreshTrigger.value++; // 触发重新渲染
            console.log('[UsagesView] 已更新统计数据', providers.length);
        } else if (message.command === 'updatePageRecords') {
            const msg = message as UpdatePageRecordsMessage;
            records = msg.records;
            refreshTrigger.value++; // 触发重新渲染
            console.log('[UsagesView] 已更新页面记录', records.length);
        }
    };

    window.addEventListener('message', handleMessage);
}

// ============= 在模块级别定义所有辅助函数和事件处理器 =============
const recordsPerPage = 20;

const getIsToday = () => selectedDate === today;
const getTotalRecords = () => records.length;
const getTotalPages = () => Math.ceil(getTotalRecords() / recordsPerPage);
const getStartIndex = () => (currentPage - 1) * recordsPerPage;
const getEndIndex = () => Math.min(getStartIndex() + recordsPerPage, getTotalRecords());
const getVisibleRecords = () => records.slice(getStartIndex(), getEndIndex());

const toggleProvider = (providerKey: string | undefined) => {
    if (providerKey) {
        if (expandedProviders.has(providerKey)) {
            expandedProviders.delete(providerKey);
        } else {
            expandedProviders.add(providerKey);
        }
    }
};

const handleSelectDate = (date: string) => {
    if (date !== selectedDate) {
        selectedDate = date;
        currentPage = 1;
        selectDate(date);
    }
};

const handleChangePage = (page: number) => {
    if (page >= 1 && page <= getTotalPages()) {
        currentPage = page;
        changePage(selectedDate, page);
    }
};

const handleOpenStorageDir = () => {
    openStorageDir();
};

const handleRefresh = () => {
    refresh();
};

// ============= 渲染函数 =============

const renderDateItem = (summary: DateSummary) => {
    const isSelected = selectedDate === summary.date;
    const isTodayItem = summary.date === today;
    const displayDate = isTodayItem ? `今日 (${summary.date})` : summary.date;

    return (
        <div class={`date-item ${isSelected ? 'selected' : ''}`} data-date={summary.date}>
            <div onClick={() => handleSelectDate(summary.date)}>
                <div class={`date-item-title ${isTodayItem ? 'today' : ''}`}>{displayDate}</div>
                <div class="date-item-stats">
                    请求: {summary.total_requests} | Token: {summary.totalTokensFormatted}
                </div>
            </div>
        </div>
    );
};

const renderModel = (model: ModelData) => (
    <tr style={{ opacity: '0.85' }}>
        <td style={{ paddingLeft: '24px' }}>└─ {model.modelName}</td>
        <td>{model.totalInputTokensFormatted}</td>
        <td>{model.totalCacheReadTokensFormatted}</td>
        <td>{model.totalOutputTokensFormatted}</td>
        <td>{model.totalTokensFormatted}</td>
        <td>{model.totalRequests}</td>
    </tr>
);

const renderProvider = (provider: ProviderData) => {
    const hasModels = provider.models && provider.models.length > 0;

    return (
        <>
            <tr style={{ backgroundColor: 'var(--vscode-editor-inactiveSelectionBackground)', fontWeight: 'bold' }}>
                <td>{provider.displayName}</td>
                <td>{provider.totalInputTokensFormatted}</td>
                <td>{provider.totalCacheReadTokensFormatted}</td>
                <td>{provider.totalOutputTokensFormatted}</td>
                <td>{provider.totalTokensFormatted}</td>
                <td>{provider.totalRequests}</td>
            </tr>
            {hasModels && provider.models!.map(renderModel)}
        </>
    );
};

const renderHourlyChart = () => {
    if (!hourlyStats) {
        return <div class="empty-message">暂无数据</div>;
    }

    const hours = Object.entries(hourlyStats)
        .filter(([, data]: [string, HourlyStatsItem]) => data.requests > 0)
        .sort((a, b) => a[0].localeCompare(b[0]))
        .map(([hour, data]: [string, HourlyStatsItem]) => ({
            hour,
            actualInput: data.actualInput || 0,
            cacheTokens: data.cacheTokens || 0,
            outputTokens: data.outputTokens || 0,
            requests: data.requests
        }));

    if (hours.length === 0) {
        return <div class="empty-message">暂无数据</div>;
    }

    const formatTokens = (tokens: number | undefined) => {
        if (tokens === undefined || tokens === null || isNaN(tokens)) {
            return '-';
        }
        if (tokens >= 1000000) {
            return (tokens / 1000000).toFixed(1) + 'M';
        } else if (tokens >= 1000) {
            return (tokens / 1000).toFixed(1) + 'K';
        } else {
            return tokens.toString();
        }
    };

    return (
        <table>
            <thead>
                <tr>
                    <th>时间</th>
                    <th>输入Tokens</th>
                    <th>缓存命中</th>
                    <th>输出Tokens</th>
                    <th>消耗Tokens</th>
                    <th>请求数</th>
                </tr>
            </thead>
            <tbody>
                {hours.map(hourStat => {
                    const total = hourStat.actualInput + hourStat.outputTokens;
                    return (
                        <tr>
                            <td>
                                <strong>{hourStat.hour}:00</strong>
                            </td>
                            <td>{formatTokens(hourStat.actualInput)}</td>
                            <td>{formatTokens(hourStat.cacheTokens)}</td>
                            <td>{formatTokens(hourStat.outputTokens)}</td>
                            <td>
                                <strong>{formatTokens(total)}</strong>
                            </td>
                            <td>{hourStat.requests}</td>
                        </tr>
                    );
                })}
            </tbody>
        </table>
    );
};

const renderRecord = (record: FormattedRecordData, index: number) => (
    <tr key={index}>
        <td class="time-cell">{record.time}</td>
        <td class="provider-cell">{record.providerName}</td>
        <td class="model-cell">{record.modelName}</td>
        <td class="value-cell">{record.inputDisplay}</td>
        <td class="value-cell">{record.cacheDisplay}</td>
        <td class="value-cell">{record.outputDisplay}</td>
        <td class={`status-cell ${record.statusClass}`}>{record.statusText}</td>
    </tr>
);

const renderPagination = () => {
    if (getTotalPages() <= 1) {
        return null;
    }

    const pages = [];
    const showPages = 5;
    let startPage = Math.max(1, currentPage - Math.floor(showPages / 2));
    const endPage = Math.min(getTotalPages(), startPage + showPages - 1);

    if (endPage - startPage + 1 < showPages) {
        startPage = Math.max(1, endPage - showPages + 1);
    }

    for (let i = startPage; i <= endPage; i++) {
        pages.push(i);
    }

    return (
        <div class="pagination">
            <button class="page-btn" disabled={currentPage === 1} onClick={() => handleChangePage(1)}>
                首页
            </button>
            <button class="page-btn" disabled={currentPage === 1} onClick={() => handleChangePage(currentPage - 1)}>
                上一页
            </button>

            {startPage > 1 && <span class="page-ellipsis">...</span>}

            {pages.map(page => (
                <button
                    key={page}
                    class={`page-btn ${page === currentPage ? 'active' : ''}`}
                    onClick={() => handleChangePage(page)}
                >
                    {page}
                </button>
            ))}

            {endPage < getTotalPages() && <span class="page-ellipsis">...</span>}

            <button
                class="page-btn"
                disabled={currentPage === getTotalPages()}
                onClick={() => handleChangePage(currentPage + 1)}
            >
                下一页
            </button>
            <button
                class="page-btn"
                disabled={currentPage === getTotalPages()}
                onClick={() => handleChangePage(getTotalPages())}
            >
                末页
            </button>

            <span class="page-info">
                第 {currentPage} / {getTotalPages()} 页，共 {getTotalRecords()} 条记录
            </span>
        </div>
    );
};

// 类型定义
interface FormattedRecordData extends UsageRecord {}

/**
 * UsagesView 主组件 - Vapor 原生 JS 组件
 * 纯函数组件，直接返回JSX块
 */
export default function UsagesViewComponent() {
    // 第一步：初始化
    initializeComponent();

    // 访问响应式触发器以建立依赖关系
    // 当数据更新时，refreshTrigger.value++ 会触发组件重新渲染
    refreshTrigger.value;

    // 直接返回JSX（Vapor需要直接返回块）
    return (
        <div class="usages-view">
            <div class="sidebar">
                <div class="sidebar-header">
                    <div class="sidebar-header-top">
                        <h1>Token 消耗统计</h1>
                        <button class="open-storage-button" onClick={handleOpenStorageDir} title="打开存储目录">
                            📁
                        </button>
                    </div>
                </div>
                <div class="date-list">{dateSummaries.map(renderDateItem)}</div>
            </div>
            <div class="content">
                <h2 id="details-title">{getIsToday() ? '今日' : selectedDate} 使用详情</h2>
                <div id="details-content">
                    {providers.length > 0 ? (
                        <>
                            <section>
                                <h2>按提供商统计</h2>
                                {providers.length > 0 ? (
                                    <table class="stats-table">
                                        <thead>
                                            <tr>
                                                <th>提供商/模型</th>
                                                <th>输入Tokens</th>
                                                <th>缓存命中</th>
                                                <th>输出Tokens</th>
                                                <th>消耗Tokens</th>
                                                <th>请求数</th>
                                            </tr>
                                        </thead>
                                        <tbody>{providers.map(renderProvider)}</tbody>
                                    </table>
                                ) : (
                                    <div class="empty-message">暂无数据</div>
                                )}
                            </section>
                            <section>
                                <h2>各小时用量</h2>
                                {renderHourlyChart()}
                            </section>
                        </>
                    ) : (
                        <div class="empty-message">💡 {getIsToday() ? '今日' : selectedDate} 暂无 Token 消耗记录</div>
                    )}
                </div>
                <h2 id="records-section">请求记录</h2>
                <div id="records-container">
                    {getVisibleRecords().length > 0 ? (
                        <>
                            {renderPagination()}
                            <table class="records-table">
                                <thead>
                                    <tr>
                                        <th>时间</th>
                                        <th>提供商</th>
                                        <th>模型</th>
                                        <th>输入</th>
                                        <th>缓存</th>
                                        <th>输出</th>
                                        <th>状态</th>
                                    </tr>
                                </thead>
                                <tbody>{getVisibleRecords().map(renderRecord)}</tbody>
                            </table>
                            {renderPagination()}
                        </>
                    ) : (
                        <div class="empty-message">暂无记录</div>
                    )}
                </div>
            </div>
        </div>
    );
}
