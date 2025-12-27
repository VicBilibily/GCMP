/**
 * UsagesView Bridge
 * 页面与 VSCode 扩展之间的通信桥接
 */

// ============= 基础类型定义 =============

export interface DateSummary {
    date: string;
    total_requests: number;
    totalTokensFormatted: string;
}

export interface ModelData {
    modelId: string;
    modelName: string;
    totalInputTokens: number;
    totalInputTokensFormatted: string;
    totalCacheReadTokens: number;
    totalCacheReadTokensFormatted: string;
    totalOutputTokens: number;
    totalOutputTokensFormatted: string;
    totalTokensFormatted: string;
    totalRequests: number;
}

export interface ProviderData {
    providerKey: string;
    providerName: string;
    displayName: string;
    totalInputTokens: number;
    totalInputTokensFormatted: string;
    totalCacheReadTokens: number;
    totalCacheReadTokensFormatted: string;
    totalOutputTokens: number;
    totalOutputTokensFormatted: string;
    totalTokensFormatted: string;
    totalRequests: number;
    models?: ModelData[];
}

export interface HourlyStatsItem {
    hour: number;
    requests: number;
    estimatedInput: number;
    actualInput: number;
    cacheTokens: number;
    outputTokens: number;
    completedRequests: number;
    failedRequests: number;
}

export type HourlyStats = Record<string, HourlyStatsItem>;

export interface UsageRecord {
    time: string;
    providerName: string;
    modelName: string;
    inputDisplay: string;
    cacheDisplay: string;
    outputDisplay: string;
    statusClass: string;
    statusText: string;
}

export interface VSCodeApi {
    postMessage(message: WebViewMessage): void;
}

// ============= WebView 消息类型定义 =============

/**
 * WebView 发送的消息类型
 */
export type WebViewMessage =
    | { command: 'refresh'; date?: string; page?: number }
    | { command: 'selectDate'; date: string }
    | { command: 'changePage'; date: string; page: number }
    | { command: 'loadMoreDates'; currentLimit: number }
    | { command: 'openStorageDir' };

// ============= Host 消息类型定义（拆分节点） =============

export interface UpdateDateListMessage {
    command: 'updateDateList';
    dateList: DateSummary[];
}

export interface UpdateDateDetailsMessage {
    command: 'updateDateDetails';
    date: string;
    isToday: boolean;
    providers: ProviderData[];
    hourlyStats: HourlyStats;
    records: UsageRecord[];
    currentPage: number;
}

export interface UpdatePageRecordsMessage {
    command: 'updatePageRecords';
    records: UsageRecord[];
    page: number;
}

export interface UpdateStatsOnlyMessage {
    command: 'updateStatsOnly';
    providers: ProviderData[];
    hourlyStats: HourlyStats;
}

export interface AppendDatesMessage {
    command: 'appendDates';
    dates: DateSummary[];
    newLimit: number;
    remainingCount: number;
}

/**
 * 扩展发送到 WebView 的消息类型（组合节点）
 */
export type HostMessage =
    | UpdateDateListMessage
    | UpdateDateDetailsMessage
    | UpdatePageRecordsMessage
    | UpdateStatsOnlyMessage
    | AppendDatesMessage;

/**
 * WebView 初始化数据类型
 */
export interface UsagesViewInitialData {
    dateSummaries: DateSummary[];
    selectedDate: string;
    today: string;
    currentPage: number;
    datesLimit: number;
    providers: ProviderData[];
    hourlyStats?: HourlyStats;
    records: UsageRecord[];
}

/**
 * WebView 消息处理程序类型
 */
export type WebViewMessageHandler = (message: WebViewMessage) => void | Promise<void>;

/**
 * 创建消息通道
 *
 * @example
 * const bridge = createUsagesViewBridge();
 *
 * bridge.onMessage((message) => {
 *   switch (message.command) {
 *     case 'selectDate':
 *       handleSelectDate(message.date);
 *       break;
 *   }
 * });
 *
 * bridge.sendMessage({
 *   command: 'updateDateDetails',
 *   date: '2025-12-27',
 * });
 */
export function createUsagesViewBridge() {
    const handlers = new Set<WebViewMessageHandler>();

    const onMessage = (handler: WebViewMessageHandler) => {
        handlers.add(handler);
        return () => handlers.delete(handler);
    };

    const sendMessage = (message: HostMessage) => {
        if (typeof window !== 'undefined' && window.parent) {
            window.parent.postMessage(message, '*');
        }
    };

    const handleIncomingMessage = (event: MessageEvent<WebViewMessage>) => {
        if (event.data && event.data.command) {
            handlers.forEach(handler => {
                try {
                    handler(event.data);
                } catch (error) {
                    console.error('[UsagesViewBridge] 消息处理出错:', error);
                }
            });
        }
    };

    if (typeof window !== 'undefined') {
        window.addEventListener('message', handleIncomingMessage);
    }

    return {
        onMessage,
        sendMessage,
        dispose: () => {
            handlers.clear();
            if (typeof window !== 'undefined') {
                window.removeEventListener('message', handleIncomingMessage);
            }
        }
    };
}

/**
 * 获取全局 VSCode API（在 WebView 中可用）
 */
export function getVSCodeApi(): VSCodeApi {
    if (typeof window !== 'undefined') {
        const vscodeApi = (window as unknown as Record<string, VSCodeApi | undefined>).vscode;
        if (vscodeApi) {
            return vscodeApi;
        }
    }
    throw new Error('VSCode API not available. Make sure you are in a WebView context.');
}

/**
 * 向 VSCode 发送消息
 */
export function postToVSCode(message: WebViewMessage) {
    try {
        const vscode = getVSCodeApi();
        vscode.postMessage(message);
    } catch (error) {
        console.error('[UsagesViewBridge] 发送消息到 VSCode 失败:', error);
    }
}

/**
 * 在 VSCode 中打开存储目录
 */
export function openStorageDir() {
    postToVSCode({ command: 'openStorageDir' });
}

/**
 * 刷新页面
 */
export function refresh(date?: string, page?: number) {
    postToVSCode({ command: 'refresh', date, page });
}

/**
 * 选择日期
 */
export function selectDate(date: string) {
    postToVSCode({ command: 'selectDate', date });
}

/**
 * 改变页码
 */
export function changePage(date: string, page: number) {
    postToVSCode({ command: 'changePage', date, page });
}

/**
 * 加载更多日期
 */
export function loadMoreDates(currentLimit: number) {
    postToVSCode({ command: 'loadMoreDates', currentLimit });
}

export default {
    createUsagesViewBridge,
    getVSCodeApi,
    postToVSCode,
    openStorageDir,
    refresh,
    selectDate,
    changePage,
    loadMoreDates
};
