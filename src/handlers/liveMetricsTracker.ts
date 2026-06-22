/*---------------------------------------------------------------------------------------------
 *  实时流式指标追踪器
 *  从 StreamReporter 抽离的纯逻辑类：维护首流延迟、输出字符数、速度等实时指标状态，
 *  并通过 onLiveMetrics 回调上报给 liveMetrics 事件总线。
 *
 *  本类不依赖 vscode，便于单元测试。
 *--------------------------------------------------------------------------------------------*/

import type { LiveStreamMetricEvent } from './liveMetrics';
import type { TikTokenizer } from '@microsoft/tiktokenizer';

/**
 * 安全 encode：未注入或 encode 失败时返回 undefined。所有 token 估算都是 best-effort。
 */
function safeEncodeTokens(tokenizer: TikTokenizer | undefined, text: string): number | undefined {
    if (!tokenizer || !text) {
        return undefined;
    }
    try {
        return tokenizer.encode(text).length;
    } catch {
        return undefined;
    }
}

/**
 * LiveMetricsTracker 配置选项
 */
export interface LiveMetricsTrackerOptions {
    /** 请求 ID（可选，缺省时 tracker 不发射任何事件） */
    requestId?: string;
    /** 请求开始时间戳（可选，缺省时 tracker 不发射任何事件） */
    requestStartTime?: number;
    /** 提供商名称 */
    providerName: string;
    /** 模型显示名称 */
    modelName: string;
    /** 实时指标回调 */
    onLiveMetrics?: (event: LiveStreamMetricEvent) => void;
    /** streamingUpdate 节流间隔（默认 350ms） */
    liveUpdateIntervalMs?: number;
    /**
     * 时钟函数（默认 Date.now）。注入后可让单元测试精确控制时间，
     * 避免基于真实墙钟的弱确定性断言。
     */
    now?: () => number;
    /**
     * 共享 tokenizer 实例（可选）。注入后由 tracker 自行缓冲文本并在达到阈值后批量 encode，
     * 避免大并发下每个 chunk 都触发 encode。未注入时退化为接受调用方预计算的 token 增量。
     */
    tokenizer?: TikTokenizer;
    /**
     * 触发批量 encode 的字符阈值（默认 512）。仅当 tokenizer 已注入时生效。
     * 缓冲文本累计到该阈值后才调用 encode 累加到 estimatedOutputTokens。
     * 设为远大于单 chunk 字符数的值（高速模型每 chunk 可达 100+ chars），
     * 确保累积多个 chunk 后才触发一次 encode，避免每个 chunk 都计算。
     */
    tokenBatchChars?: number;
    /**
     * 触发批量 encode 的时间阈值（默认 500ms）。仅当 tokenizer 已注入时生效。
     * 即使缓冲文本未达字符阈值，距上次 encode 超过该时长也会强制 flush，
     * 兼顾高速模型（避免单次 encode 字符数过大）与慢速模型（避免 UI 长期滞后）。
     */
    tokenBatchMs?: number;
}

/**
 * 实时流式指标追踪器
 *
 * 状态机：
 * - 初始：等待首个有效流事件（markStreamStarted 或 reportOutput 触发）
 * - 首流固定后：firstChunkLatencyMs 不再变化，outputChars / charsPerSecond 持续累计
 * - finishMetrics 幂等：可由 flushAll（正常完成）与 handler finally（异常）双路径调用
 *
 * 关键约定：
 * - heartbeat() 只触发受节流的轻量刷新，不会固定首流时间（避免 ping/空 chunk 过早固定）
 * - reportOutput() 在首流未固定时会用当前时间兜底固定首流时间
 * - charsPerSecond 在暂停期间保持冻结（仅在实际收到输出字符时更新）
 */
export class LiveMetricsTracker {
    private readonly requestId: string | undefined;
    private readonly requestStartTime: number | undefined;
    private readonly providerName: string;
    private readonly modelName: string;
    private readonly onLiveMetrics: ((event: LiveStreamMetricEvent) => void) | undefined;
    private readonly liveUpdateInterval: number;
    private readonly now: () => number;
    private readonly tokenizer: TikTokenizer | undefined;
    private readonly tokenBatchChars: number;
    private readonly tokenBatchMs: number;

    // 实时指标状态
    private firstChunkEmitted = false;
    private streamEnded = false;
    private outputChars = 0;
    private estimatedOutputTokens = 0;
    private pendingOutputText = ''; // 待批量 encode 的文本缓冲（仅 tokenizer 模式下使用）
    private lastEncodeAt = 0; // 上一次批量 encode 的时间戳（仅 tokenizer 模式下使用）
    private lastCharsPerSecond = 0;
    private lastTokensPerSecond = 0; // 仅在实际收到输出 token 时更新，暂停期间保持冻结
    private lastLiveUpdateAt = 0;
    private firstStreamTime = 0;
    private fixedFirstChunkLatencyMs = 0;

    constructor(options: LiveMetricsTrackerOptions) {
        this.requestId = options.requestId;
        this.requestStartTime = options.requestStartTime;
        this.providerName = options.providerName;
        this.modelName = options.modelName;
        this.onLiveMetrics = options.onLiveMetrics;
        this.liveUpdateInterval = options.liveUpdateIntervalMs ?? 350;
        this.now = options.now ?? (() => Date.now());
        this.tokenizer = options.tokenizer;
        this.tokenBatchChars = options.tokenBatchChars ?? 512;
        this.tokenBatchMs = options.tokenBatchMs ?? 500;
    }

    /**
     * 检查是否可以发送实时指标（requestId / requestStartTime / onLiveMetrics 均已配置）
     */
    canEmitMetrics(): boolean {
        return Boolean(
            this.requestId &&
            typeof this.requestStartTime === 'number' &&
            Number.isFinite(this.requestStartTime) &&
            this.onLiveMetrics
        );
    }

    /**
     * 标记流已开始（由 handler 在设置 streamStartTime 的同一时刻调用，共用同一个时间戳）。
     *
     * 各 handler 的首流事件时机不同：
     * - Anthropic: message_start
     * - OpenAI Chat SDK: 首个 chunk 事件
     * - OpenAI Responses: response.created
     * - Gemini/SSE: 首个有效 JSON event
     *
     * 本方法记录的是"首个流事件"，不等同于"首个可见文字"。幂等：重复调用不重置首流时间。
     */
    markStreamStarted(streamStartTime: number): void {
        if (this.firstChunkEmitted || !this.canEmitMetrics()) {
            return;
        }

        this.firstStreamTime = streamStartTime;
        this.fixedFirstChunkLatencyMs = Math.max(0, streamStartTime - this.requestStartTime!);
        this.firstChunkEmitted = true;

        this.onLiveMetrics!({
            type: 'firstChunk',
            requestId: this.requestId!,
            requestStartTime: this.requestStartTime!,
            streamStartTime,
            providerName: this.providerName,
            modelName: this.modelName,
            firstChunkLatencyMs: this.fixedFirstChunkLatencyMs
        });
    }

    /**
     * 获取已记录的流开始时间（只读，不触发指标事件）。
     * 供 handler 在缺少标准首流事件时回退使用。
     */
    getMetricStreamStartTime(): number | undefined {
        return this.firstStreamTime > 0 ? this.firstStreamTime : undefined;
    }

    /**
     * 心跳：触发受节流的轻量刷新。
     * 不得固定首流时间（避免 ping/空 chunk 过早固定）。
     */
    heartbeat(): void {
        this.emitStreamingUpdate(false);
    }

    /**
     * 上报输出字符增量（文本/思考/工具参数等 provider 实际回传内容）。
     * 在首流未固定时会用当前时间兜底固定首流时间。
     * 速度仅在收到实际输出字符时更新，暂停期间保持冻结。
     *
     * Token 估算策略（避免大并发下每个 chunk 都触发 encode）：
     * - 注入 tokenizer 且提供 text：缓冲到 tokenBatchChars 阈值后才批量 encode 累加
     * - 未注入 tokenizer：接受调用方预计算的 addedTokens（兼容旧路径）
     * - finishMetrics 会强制 flush 残留缓冲
     *
     * @param addedChars 字符数增量（必填，用于 chars/s 速度统计）
     * @param textOrTokens 增量原始文本（推荐，配合 tokenizer 批量 encode）
     *                     或调用方预计算的 token 增量（无 tokenizer 时的 fallback）
     */
    reportOutput(addedChars: number, textOrTokens?: string | number): void {
        if (!Number.isFinite(addedChars) || addedChars <= 0) {
            return;
        }

        const now = this.now();

        // 兼容 Responses / 第三方网关缺少 response.created / 首流事件的情况：
        // 只有真实输出字符到达时才兜底固定首流时间；不在 heartbeat 中固定
        if (!this.firstChunkEmitted && this.canEmitMetrics()) {
            this.markStreamStarted(now);
        }

        this.outputChars += addedChars;

        // Token 估算：优先使用 tokenizer + 文本缓冲（批量 encode），
        // 否则退化为调用方预计算的 token 增量
        if (this.tokenizer) {
            if (typeof textOrTokens === 'string' && textOrTokens.length > 0) {
                this.pendingOutputText += textOrTokens;
                // 首次进入缓冲：初始化 lastEncodeAt，避免首次即触发时间阈值
                if (this.lastEncodeAt === 0) {
                    this.lastEncodeAt = now;
                }
                // 双阈值触发：字符数达到 或 距上次 encode 超过时间阈值
                const reachedCharThreshold = this.pendingOutputText.length >= this.tokenBatchChars;
                const reachedTimeThreshold = now - this.lastEncodeAt >= this.tokenBatchMs;
                if (reachedCharThreshold || reachedTimeThreshold) {
                    this.flushPendingText(now);
                }
            }
        } else if (typeof textOrTokens === 'number' && Number.isFinite(textOrTokens) && textOrTokens > 0) {
            this.estimatedOutputTokens += textOrTokens;
        }

        const elapsedMs = this.firstStreamTime > 0 ? Math.max(1, now - this.firstStreamTime) : 0;
        this.lastCharsPerSecond = elapsedMs > 0 && this.outputChars > 0 ? (this.outputChars / elapsedMs) * 1000 : 0;
        // tokens/s：基于累计的 estimatedOutputTokens 计算（暂停期间保持冻结）
        this.lastTokensPerSecond =
            elapsedMs > 0 && this.estimatedOutputTokens > 0 ? (this.estimatedOutputTokens / elapsedMs) * 1000 : 0;

        this.emitStreamingUpdate(false);
    }

    /**
     * 强制 flush 残留的文本缓冲，累加到最后一次 estimatedOutputTokens。
     * 由 finishMetrics 自动调用，确保流结束时不丢失未达阈值的尾部 token。
     *
     * @param now 当前时间戳（可选，默认调用 this.now()）。flush 成功后更新 lastEncodeAt。
     */
    private flushPendingText(now: number = this.now()): void {
        if (!this.tokenizer || this.pendingOutputText.length === 0) {
            return;
        }
        const tokens = safeEncodeTokens(this.tokenizer, this.pendingOutputText);
        if (tokens !== undefined && tokens > 0) {
            this.estimatedOutputTokens += tokens;
        }
        this.pendingOutputText = '';
        this.lastEncodeAt = now;
    }

    /**
     * 结束实时指标上报（发送最后一帧 streamingUpdate，不发送 streamEnd）。
     * streamEnd 由 GenericModelProvider 在整个重试流程结束后发送。
     *
     * 幂等：由 flushAll()（正常完成）和 handler finally（异常/取消）双路径调用，
     * 通过 streamEnded 标志保证只有第一次调用生效。
     */
    finishMetrics(): void {
        if (this.streamEnded) {
            return;
        }
        this.streamEnded = true;

        if (!this.canEmitMetrics()) {
            return;
        }

        // 流结束前 flush 残留文本缓冲，确保尾部 token 不丢失
        this.flushPendingText();

        // flush 后 estimatedOutputTokens 可能增加，重新计算 tokensPerSecond
        const elapsedMs = this.firstStreamTime > 0 ? Math.max(1, this.now() - this.firstStreamTime) : 0;
        this.lastTokensPerSecond =
            elapsedMs > 0 && this.estimatedOutputTokens > 0 ? (this.estimatedOutputTokens / elapsedMs) * 1000 : 0;

        // 只有已收到首个有效流事件时，才发送最后一帧 streamingUpdate
        if (this.firstChunkEmitted) {
            this.emitStreamingUpdate(true);
        }
    }

    /**
     * 发送流式速度更新（受节流，结束时由 finishMetrics 强制最后一帧）
     */
    private emitStreamingUpdate(force: boolean): void {
        if (!this.canEmitMetrics()) {
            return;
        }

        const now = this.now();
        if (!force && now - this.lastLiveUpdateAt < this.liveUpdateInterval) {
            return;
        }

        // 首流延迟：已收到首流事件则使用固定值，否则从请求开始持续计时
        const firstChunkLatencyMs =
            this.firstChunkEmitted ? this.fixedFirstChunkLatencyMs : Math.max(0, now - this.requestStartTime!);

        this.onLiveMetrics!({
            type: 'streamingUpdate',
            requestId: this.requestId!,
            requestStartTime: this.requestStartTime!,
            streamStartTime: this.firstStreamTime > 0 ? this.firstStreamTime : undefined,
            providerName: this.providerName,
            modelName: this.modelName,
            firstChunkLatencyMs,
            outputChars: this.outputChars,
            charsPerSecond: this.lastCharsPerSecond,
            estimatedOutputTokens: this.estimatedOutputTokens,
            tokensPerSecond: this.lastTokensPerSecond
        });
        this.lastLiveUpdateAt = now;
    }
}
