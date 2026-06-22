/*---------------------------------------------------------------------------------------------
 *  Live Metrics
 *  实时流式指标事件通道：供 StreamReporter 派发，TokenUsagesView/WebView 订阅。
 *  不依赖 status 层，仅作为轻量 typed event bus。
 *---------------------------------------------------------------------------------------------*/

import { Logger } from '../utils/logger';

export interface LiveStreamMetricEvent {
    type: 'requestStarted' | 'firstChunk' | 'streamingUpdate' | 'streamEnd';
    requestId: string;
    requestStartTime: number;
    providerName: string;
    modelName: string;
    streamStartTime?: number;
    firstChunkLatencyMs?: number;
    outputChars?: number;
    charsPerSecond?: number;
    /**
     * 实时估算的输出 token 数（基于增量 encode 累加，存在 token 边界误差）。
     * 仅用于 streaming 阶段的预估展示，最终值仍以 usage 回写为准。
     */
    estimatedOutputTokens?: number;
    /**
     * 实时估算的输出 token 速度（tokens/s）。基于 estimatedOutputTokens 与流耗时计算。
     * 暂停期间保持冻结（与 charsPerSecond 行为一致）。
     */
    tokensPerSecond?: number;
}

type LiveMetricsListener = (event: LiveStreamMetricEvent) => void;

const listeners = new Set<LiveMetricsListener>();

export function onLiveMetrics(listener: LiveMetricsListener): { dispose(): void } {
    listeners.add(listener);
    return {
        dispose: () => {
            listeners.delete(listener);
        }
    };
}

export function emitLiveMetrics(event: LiveStreamMetricEvent): void {
    if (listeners.size === 0) {
        return;
    }

    for (const listener of listeners) {
        try {
            listener(event);
        } catch (error) {
            Logger.warn('[LiveMetrics] listener failed:', error);
        }
    }
}
