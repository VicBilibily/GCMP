/**
 * UsagesView 统一类型定义
 * 直接使用存储服务的原始数据类型，避免重复定义和转换
 */

// ============= 从存储服务导入原始类型 =============

import type { DateSummary } from '../../usages/types';
import type {
    FileLoggerProviderStats as ProviderData,
    FileLoggerModelStats as ModelData,
    HourlyStats,
    TokenRequestLog as RequestRecord
} from '../../usages/fileLogger/types';
import type { ExtendedTokenRequestLog } from '../../usages/fileLogger/usageParser';

// ============= 重新导出类型供外部使用 =============

export type { DateSummary, ProviderData, ModelData, HourlyStats, RequestRecord };
export type { ExtendedTokenRequestLog };

// ============= 消息类型定义 =============

/**
 * WebView 发送到 VSCode 的消息类型
 */
export type WebViewMessage =
    | { command: 'getInitialData' }
    | { command: 'refresh'; date?: string; page?: number }
    | { command: 'selectDate'; date: string }
    | { command: 'changePage'; date: string; page: number }
    | { command: 'openStorageDir' };

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
    providers: ProviderData[];
    hourlyStats: Record<string, Omit<HourlyStats, 'providers'>>;
    records: ExtendedTokenRequestLog[];
    currentPage: number;
}

export interface UpdatePageRecordsMessage {
    command: 'updatePageRecords';
    records: ExtendedTokenRequestLog[];
    page: number;
}

export interface UpdateStatsOnlyMessage {
    command: 'updateStatsOnly';
    providers: ProviderData[];
    hourlyStats: Record<string, Omit<HourlyStats, 'providers'>>;
}

export type HostMessage =
    | UpdateDateListMessage
    | UpdateDateDetailsMessage
    | UpdatePageRecordsMessage
    | UpdateStatsOnlyMessage;

// ============= 应用状态类型 =============

/**
 * 简化状态（用于内部状态管理）
 */
export interface State {
    selectedDate: string;
    today: string;
    dateList: DateSummary[];
    dateDetails: DateDetails | null;
    loading: {
        dateDetails: boolean;
        pageRecords: boolean;
    };
}

/**
 * 日期详情（用于内部状态管理）
 */
export interface DateDetails {
    date: string;
    isToday: boolean;
    providers: ProviderData[];
    hourlyStats: Record<string, Omit<HourlyStats, 'providers'>>;
    records: ExtendedTokenRequestLog[];
    currentPage: number;
}

/**
 * 扩展 Window 接口，添加应用状态
 */
declare global {
    interface Window {
        usagesState: State;
        usagesSetLoading: (type: 'dateDetails' | 'pageRecords', isLoading: boolean) => void;
    }
}
