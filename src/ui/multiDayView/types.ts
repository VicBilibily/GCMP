/**
 * 多日消耗分析 - 前端类型定义
 */

import type { MultiDayAnalysisResult } from '../../usages/multiDay/types';
import type { DisplayCurrency } from '../costDisplay';

export type MultiDayDisplayCurrency = DisplayCurrency;
export type MultiDayChartCurrency = 'USD' | 'RMB';

export interface MultiDayRenderOptions {
    displayCurrency: MultiDayDisplayCurrency;
    costChartCurrency: MultiDayChartCurrency;
    toggleTitle: string;
}

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

/** Host → WebView：统计有跨实例更新，按当前日期范围后台静默重拉 */
export interface RefreshMultiDayAnalysisMessage {
    command: 'refreshMultiDayAnalysis';
}

export type HostMessage = UpdateMultiDayAnalysisMessage | MultiDayErrorMessage | RefreshMultiDayAnalysisMessage;

/** 前端状态 */
export interface MultiDayState {
    data: MultiDayAnalysisResult | null;
    loading: boolean;
    error: string | null;
    displayCurrency: MultiDayDisplayCurrency;
}

declare global {
    interface Window {
        multiDayState: MultiDayState;
        multiDayRender: () => void;
        multiDayRequestId: number;
    }
}
