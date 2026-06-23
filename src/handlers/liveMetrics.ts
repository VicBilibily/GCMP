/*---------------------------------------------------------------------------------------------
 *  Live Metrics
 *  实时流式指标事件通道：供 StreamReporter 派发，TokenUsagesView/WebView 订阅。
 *  不依赖 status 层，仅作为轻量 typed event bus。
 *---------------------------------------------------------------------------------------------*/

export interface LiveStreamMetricEvent {
    type: 'requestStarted' | 'firstChunk' | 'streamingUpdate' | 'streamEnd';
    requestId: string;
    requestStartTime: number;
    providerName: string;
    modelName: string;
    streamStartTime?: number;
    firstChunkLatencyMs?: number;
    /**
     * 实时估算的输出 token 数（基于增量 encode 累加，存在 token 边界误差）。
     * 仅用于 streaming 阶段的预估展示，最终值仍以 usage 回写为准。
     */
    estimatedOutputTokens?: number;
    /**
     * 最近一次 flush（text/tool_call overhead）新增的 token 数。
     * UI 展示为 `+xx`，反映"最近一次接收的预估增量"，比累计值更直观。
     */
    lastOutputTokenDelta?: number;
    /**
     * flush 序号（单调递增）。UI 用它判断"是否真的有新 flush 到达"，
     * 避免依赖 delta 值大小变化做误判（稳定速度下连续 flush 的 delta 可能相同）。
     */
    lastFlushSeq?: number;
    /**
     * 实时估算的输出 token 速度（tokens/s）。基于 estimatedOutputTokens 与流耗时计算。
     * 暂停期间保持冻结。
     */
    tokensPerSecond?: number;
}

type LiveMetricsListener = (event: LiveStreamMetricEvent) => void;

const listeners = new Set<LiveMetricsListener>();

/**
 * 活跃请求的最新事件快照（requestId → 最新事件）。
 * 面板中途打开时用于补发当前流式状态，避免因订阅晚于事件发送而丢失数据。
 */
const activeMetrics = new Map<string, LiveStreamMetricEvent>();

export function onLiveMetrics(listener: LiveMetricsListener): { dispose(): void } {
    listeners.add(listener);
    return {
        dispose: () => {
            listeners.delete(listener);
        }
    };
}

export function emitLiveMetrics(event: LiveStreamMetricEvent): void {
    // 快照更新 — 无论是否有 listener 都必须执行，否则面板未打开时无法缓存
    if (event.type === 'streamEnd') {
        activeMetrics.delete(event.requestId);
    } else {
        activeMetrics.set(event.requestId, event);
    }

    if (listeners.size === 0) {
        return;
    }

    for (const listener of listeners) {
        try {
            listener(event);
        } catch (error) {
            console.warn('[LiveMetrics] listener failed:', error);
        }
    }
}

/**
 * 获取当前活跃请求的最新事件快照。
 * 供面板打开 / 日期切换时补发当前流式状态。
 */
export function getActiveMetricsSnapshot(): LiveStreamMetricEvent[] {
    return Array.from(activeMetrics.values());
}
