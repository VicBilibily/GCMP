/**
 * 多日消耗分析 - 前端类型定义
 */

import type { MultiDayAnalysisResult } from '../../usages/multiDay/types';

/** WebView → Host 消息 */
export interface WebViewMessage {
    command: 'getMultiDayAnalysis';
    dateFrom: string;
    dateTo: string;
    requestId: number;
}

/** Host → WebView 消息 */
export interface UpdateMultiDayAnalysisMessage {
    command: 'updateMultiDayAnalysis';
    data: MultiDayAnalysisResult;
    requestId: number;
}

export interface MultiDayErrorMessage {
    command: 'multiDayError';
    error: string;
    requestId: number;
}

export type HostMessage = UpdateMultiDayAnalysisMessage | MultiDayErrorMessage;

/** 前端状态 */
export interface MultiDayState {
    data: MultiDayAnalysisResult | null;
    loading: boolean;
    error: string | null;
}

declare global {
    interface Window {
        multiDayState: MultiDayState;
        multiDayRender: () => void;
        multiDayRequestId: number;
    }
}
