/**
 * UsagesView 统一类型定义
 * 直接使用存储服务的原始数据类型，避免重复定义和转换
 */

// ============= 从存储服务导入原始类型 =============

import type { DateSummary } from '../../usages/types';
import type {
    FileLoggerProviderStats,
    FileLoggerModelStats as ModelData,
    HourlyStats
} from '../../usages/fileLogger/types';
import type { ExtendedTokenRequestLog } from '../../usages/fileLogger/usageParser';
import type { LiveStreamMetricEvent } from '../../handlers/liveMetrics';
import type { RateLimitWaitScope } from '../../types/sharedTypes';
import type {
    NativeCostSplitIndex,
    RequestTotals,
    SessionGroupSummary,
    SessionRecoveryDebugSummary,
    SessionSummary
} from '../../usages/query/types';

export interface LiveRequestUiState {
    isRateLimitWaiting: boolean;
    waitScope?: RateLimitWaitScope;
    queuePosition?: number;
}

// ============= UI 层数据类型 =============

/**
 * UI 层的提供商数据类型
 * 扩展自 FileLoggerProviderStats，添加 providerKey 字段
 * 因为在 UI 层使用数组形式，需要保留 providerKey 信息
 */
export interface ProviderData extends FileLoggerProviderStats {
    providerKey: string;
}

/**
 * 明细分页视图状态（WebView 持有，按需从扩展侧拉取）
 */
export interface RecordsViewState {
    mode: 'all' | 'session';
    sessionId?: string;
    page: number;
    totalItems: number;
    records: ExtendedTokenRequestLog[];
    summary: SessionSummary;
    totals: RequestTotals;
    recoveryDebug?: SessionRecoveryDebugSummary;
}

/**
 * 多选跟踪视图状态（每会话最新 N 条）
 */
export interface TrackRecordsState {
    groups: Array<{ sessionId: string; records: ExtendedTokenRequestLog[] }>;
}

// ============= 重新导出类型供外部使用 =============

export type { DateSummary, ModelData, HourlyStats };
export type { ExtendedTokenRequestLog };
export type {
    NativeCostSplitIndex,
    RequestTotals,
    SessionGroup,
    SessionGroupSummary,
    SessionRecoveryDebugSummary,
    SessionSummary
} from '../../usages/query/types';

// ============= 消息类型定义 =============

/**
 * WebView 发送到 VSCode 的消息类型
 */
export type WebViewMessage =
    | { command: 'getInitialData' }
    | { command: 'selectDate'; date: string }
    | { command: 'openStorageDir' }
    | { command: 'openMultiDayTrend' }
    | {
          command: 'getRecordsPage';
          date: string;
          mode: 'all' | 'session';
          sessionId?: string;
          page: number;
          pageSize?: number;
      }
    | {
          command: 'getTrackRecords';
          date: string;
          sessionIds: string[];
          limitPerSession: number;
      };

/**
 * VSCode 发送到 WebView 的消息类型
 */
export interface UpdateDateListMessage {
    command: 'updateDateList';
    dateList: DateSummary[];
    selectedDate: string;
    today: string;
}

export interface UpdateDateDetailsMessage {
    command: 'updateDateDetails';
    date: string;
    isToday: boolean;
    isExtensionHostDebugMode: boolean;
    providers: ProviderData[];
    hourlyStats: Record<string, HourlyStats>;
    /** 扩展侧聚合结果（明细不再随摘要推送，由 WebView 按页拉取） */
    allSummary: SessionSummary;
    allTotals: RequestTotals;
    nativeSplitIndex: NativeCostSplitIndex;
    sessionGroups: SessionGroupSummary[];
    /** 单调递增序列号，页拉取防竞态 */
    updateSeq: number;
}

/**
 * 明细分页响应消息
 */
export interface RecordsPageMessage {
    command: 'recordsPage';
    date: string;
    mode: 'all' | 'session';
    sessionId?: string;
    page: number;
    pageSize: number;
    totalItems: number;
    records: ExtendedTokenRequestLog[];
    summary: SessionSummary;
    totals: RequestTotals;
    recoveryDebug?: SessionRecoveryDebugSummary;
    updateSeq: number;
}

/**
 * 多选跟踪明细响应消息（每会话最新 N 条）
 */
export interface TrackRecordsMessage {
    command: 'trackRecords';
    date: string;
    updateSeq: number;
    groups: Array<{ sessionId: string; records: ExtendedTokenRequestLog[] }>;
}

export interface DetailLoadErrorMessage {
    command: 'detailLoadError';
    date: string;
    mode: 'all' | 'session' | 'track';
    sessionId?: string;
    sessionIds?: string[];
    page?: number;
    updateSeq: number;
}

export interface DateLoadErrorMessage {
    command: 'dateLoadError';
    date: string;
}

/**
 * 实时流式指标更新消息
 */
export interface UpdateLiveMetricsMessage {
    command: 'updateLiveMetrics';
    event: LiveStreamMetricEvent;
}

export type HostMessage =
    | UpdateDateListMessage
    | UpdateDateDetailsMessage
    | RecordsPageMessage
    | TrackRecordsMessage
    | DetailLoadErrorMessage
    | DateLoadErrorMessage
    | UpdateLiveMetricsMessage;

// ============= 应用状态类型 =============

/**
 * 简化状态（用于内部状态管理）
 */
export interface State {
    selectedDate: string;
    today: string;
    selectedSessionId: string | null;
    /** 活跃日期下多选跟踪的会话 ID 列表（最多 3 个），非活跃日期保持为空 */
    selectedSessionIds: string[];
    displayCurrency: 'MIXED' | 'USD' | 'RMB';
    dateList: DateSummary[];
    dateDetails: DateDetails | null;
    dateLoadError: string | null;
    loading: {
        dateDetails: boolean;
    };
}

/**
 * 日期详情（用于内部状态管理）
 * 明细记录不再整体驻留：仅保留扩展侧推送的聚合摘要与当前拉取的页数据。
 */
export interface DateDetails {
    date: string;
    isToday: boolean;
    isExtensionHostDebugMode: boolean;
    providers: ProviderData[];
    hourlyStats: Record<string, HourlyStats>;
    allSummary: SessionSummary;
    allTotals: RequestTotals;
    nativeSplitIndex: NativeCostSplitIndex;
    sessionGroups: SessionGroupSummary[];
    updateSeq: number;
    /** 明细请求进行中时为 true；保留旧表格，避免切换时闪屏 */
    detailLoading: boolean;
    /** 当前明细分页视图（全部会话或单个会话），null 表示尚未拉取 */
    recordsView: RecordsViewState | null;
    /** 多选跟踪视图（每会话最新 N 条），null 表示未处于跟踪模式 */
    trackRecords: TrackRecordsState | null;
    /** 最近一次明细加载失败信息，null 表示当前无错误 */
    detailError: DetailLoadErrorMessage | null;
}

/**
 * 扩展 Window 接口，添加应用状态
 */
declare global {
    interface Window {
        usagesState: State;
        usagesSetLoading: (type: 'dateDetails', isLoading: boolean) => void;
        usagesLiveMetrics: Map<string, LiveRequestUiState>;
        usagesRenderLiveMetrics?: () => void;
    }
}
