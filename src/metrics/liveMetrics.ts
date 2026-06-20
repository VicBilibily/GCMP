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
    elapsedMs?: number;
    charsPerSecond?: number;
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
