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
 * 会话级汇总信息
 */
export interface SessionSummary {
    requestCount: number;
    totalTokens: number;
    startTime?: number;
    endTime?: number;
    completedCount: number;
    failedCount: number;
    avgSpeed?: number;
}

/**
 * 会话分组结果，包含展示信息与原始记录
 */
export interface SessionGroup {
    sessionId: string;
    displayId: string;
    records: ExtendedTokenRequestLog[];
    summary: SessionSummary;
}

// ============= 重新导出类型供外部使用 =============

export type { DateSummary, ModelData, HourlyStats };
export type { ExtendedTokenRequestLog };

// ============= 消息类型定义 =============

/**
 * WebView 发送到 VSCode 的消息类型
 */
export type WebViewMessage =
    | { command: 'getInitialData' }
    | { command: 'refresh'; date?: string }
    | { command: 'selectDate'; date: string }
    | { command: 'openStorageDir' }
    | { command: 'openMultiDayTrend' };

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
    hourlyStats: Record<string, HourlyStats>;
    records: ExtendedTokenRequestLog[];
}

export type HostMessage = UpdateDateListMessage | UpdateDateDetailsMessage;

// ============= 应用状态类型 =============

/**
 * 简化状态（用于内部状态管理）
 */
export interface State {
    selectedDate: string;
    today: string;
    selectedSessionId: string | null;
    dateList: DateSummary[];
    dateDetails: DateDetails | null;
    loading: {
        dateDetails: boolean;
    };
}

/**
 * 日期详情（用于内部状态管理）
 */
export interface DateDetails {
    date: string;
    isToday: boolean;
    providers: ProviderData[];
    hourlyStats: Record<string, HourlyStats>;
    records: ExtendedTokenRequestLog[];
    sessionGroups: SessionGroup[];
}

/**
 * 扩展 Window 接口，添加应用状态
 */
declare global {
    interface Window {
        usagesState: State;
        usagesSetLoading: (type: 'dateDetails', isLoading: boolean) => void;
    }
}
