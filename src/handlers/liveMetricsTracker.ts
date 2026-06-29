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
 * 占位 ID 长度模拟 provider 实际 ID（约 24-36 字符，含前缀）。
 */
const PLACEHOLDER_CALL_ID = 'call_' + '0'.repeat(24);
const PLACEHOLDER_ANTHROPIC_ID = 'toolu_' + '0'.repeat(24);
const PLACEHOLDER_RESPONSES_ID = 'fc_' + '0'.repeat(24);

/**
 * 不同 provider 的 tool_call 结构开销校准系数。
 *
 * provider 的 output_tokens 基于其内部 chat template，而我们用 JSON.stringify 近似。
 * 各 provider 的 chat template 紧凑程度不同：
 * - openai/openai-responses: 计费结构与 JSON.stringify 高度一致，系数 1.0
 * - anthropic: 内部 chat template 把 schema 字段名（type/id/name/input）作为标签而非字符串，
 *   比 JSON.stringify 紧凑约 30%（实测反馈：JSON.stringify 系统性高估 tool_use 结构开销）
 * - gemini: protobuf 风格，与 JSON.stringify 接近，系数 1.0
 */
const TOOL_CALL_OVERHEAD_CALIBRATION: Record<'openai' | 'openai-responses' | 'anthropic' | 'gemini', number> = {
    openai: 1.0,
    'openai-responses': 1.0,
    anthropic: 2 / 3,
    gemini: 1.0
};

/**
 * 构造 provider 实际计费的完整 tool_call 结构。
 * 用于估算 provider 真实 output_tokens（包含 id/type/包装层等开销）。
 */
function buildProviderToolCallText(
    sdkMode: 'openai' | 'openai-responses' | 'anthropic' | 'gemini',
    name: string,
    argsJson: string
): string {
    // Anthropic/Gemini 的 args 在结构中是对象；解析失败时退化为空对象
    let argsObject: unknown = {};
    try {
        argsObject = JSON.parse(argsJson);
    } catch {
        // 解析失败：用空字符串作为 fallback，避免完全跳过 overhead 估算
        argsObject = {};
    }

    switch (sdkMode) {
        case 'anthropic':
            // Anthropic tool_use block: {"type":"tool_use","id":"toolu_xxx","name":...,"input":{...}}
            return JSON.stringify({
                type: 'tool_use',
                id: PLACEHOLDER_ANTHROPIC_ID,
                name,
                input: argsObject
            });
        case 'openai-responses':
            // Responses API: {"type":"function_call","id":"fc_xxx","call_id":"call_xxx","name":...,"arguments":"<argsJson>"}
            return JSON.stringify({
                type: 'function_call',
                id: PLACEHOLDER_RESPONSES_ID,
                call_id: PLACEHOLDER_CALL_ID,
                name,
                arguments: argsJson
            });
        case 'gemini':
            // Gemini: {"functionCall":{"name":...,"args":{...}}}
            return JSON.stringify({
                functionCall: {
                    name,
                    args: argsObject
                }
            });
        case 'openai':
        default:
            // OpenAI Chat Completions: {"id":"call_xxx","type":"function","function":{"name":...,"arguments":"<argsJson>"}}
            return JSON.stringify({
                id: PLACEHOLDER_CALL_ID,
                type: 'function',
                function: {
                    name,
                    arguments: argsJson
                }
            });
    }
}

/**
 * 构造 args 在 provider 计费结构中的"单独表示"。
 * - openai/openai-responses: args 是 stringified JSON（带转义），即 argsJson 原文
 * - anthropic/gemini: args 是对象，需要 parse + stringify（去除 argsJson 多余空白）
 */
function buildProviderArgsOnlyText(
    sdkMode: 'openai' | 'openai-responses' | 'anthropic' | 'gemini',
    argsJson: string
): string {
    if (sdkMode === 'anthropic' || sdkMode === 'gemini') {
        try {
            return JSON.stringify(JSON.parse(argsJson));
        } catch {
            return argsJson;
        }
    }
    return argsJson;
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
 * - heartbeat() 只触发受节流的实时指标更新，不会固定首流时间（避免 ping/空 chunk 过早固定）
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
    private estimatedOutputTokens = 0;
    private pendingOutputText = ''; // 待批量 encode 的文本缓冲（仅 tokenizer 模式下使用）
    // 待批量 encode 的 tool_call overhead 缓冲：fullText 与 argsOnlyText 配对累积，
    // flush 时统一 encode 再做减法，避免 BPE 边界效应在并行调用场景下的系统性高估
    private pendingToolCallFullText = '';
    private pendingToolCallArgsText = '';
    private lastToolCallFlushAt = 0; // 上一次 overhead 批量 encode 的时间戳
    private lastToolCallCalibration = 1.0; // 累积中 tool_call 的校准系数（取最后一次）
    private lastEncodeAt = 0; // 上一次批量 encode 的时间戳（仅 tokenizer 模式下使用）
    private lastTokensPerSecond = 0; // 仅在实际收到输出 token 时更新，暂停期间保持冻结
    /**
     * 最近一次 flush（text/tool_call overhead）新增的 token 数。
     * UI 展示为 `+xx`，反映"最近一次接收的预估增量"，而非易误解的累计值。
     */
    private lastFlushTokenDelta = 0;
    /**
     * flush 序号（单调递增）。每次 text/tool_call flush 自增。
     * UI 用它判断"是否真的有新 flush 到达"，避免依赖 delta 值大小变化做误判。
     */
    private flushSeq = 0;
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
     * 心跳：触发受节流的实时指标更新。
     * 不得固定首流时间（避免 ping/空 chunk 过早固定）。
     */
    heartbeat(): void {
        this.emitStreamingUpdate(false);
    }

    /**
     * 上报输出文本增量（文本/思考/工具参数等 provider 实际回传内容）。
     * 在首流未固定时会用当前时间兜底固定首流时间。
     * tokens/s 仅在收到实际输出 token 时更新，暂停期间保持冻结。
     *
     * Token 估算策略（避免大并发下每个 chunk 都触发 encode）：
     * - 注入 tokenizer 且提供 text：缓冲到 tokenBatchChars 阈值后才批量 encode 累加
     * - 未注入 tokenizer：接受调用方预计算的 addedTokens（兼容旧路径）
     * - finishMetrics 会强制 flush 残留缓冲
     *
     * @param textOrTokens 增量原始文本（推荐，配合 tokenizer 批量 encode）
     *                     或调用方预计算的 token 增量（无 tokenizer 时的 fallback）
     */
    reportOutput(textOrTokens?: string | number): void {
        // 无效输入直接跳过（不触发首流兜底、不发射 streamingUpdate）
        if (!this.hasOutputStreaming(textOrTokens)) {
            return;
        }

        const now = this.now();

        // 兼容 Responses / 第三方网关缺少 response.created / 首流事件的情况：
        // 只有真实输出文本到达时才兜底固定首流时间；不在 heartbeat 中固定
        if (!this.firstChunkEmitted && this.canEmitMetrics()) {
            this.markStreamStarted(now);
        }

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
        // tokens/s：基于累计的 estimatedOutputTokens 计算（暂停期间保持冻结）
        this.lastTokensPerSecond =
            elapsedMs > 0 && this.estimatedOutputTokens > 0 ? (this.estimatedOutputTokens / elapsedMs) * 1000 : 0;

        this.emitStreamingUpdate(false);
    }

    /**
     * 判断 textOrTokens 是否代表 provider 实际输出（用于首流时间兜底）。
     */
    private hasOutputStreaming(textOrTokens: string | number | undefined): boolean {
        if (typeof textOrTokens === 'string') {
            return textOrTokens.length > 0;
        }
        if (typeof textOrTokens === 'number') {
            return Number.isFinite(textOrTokens) && textOrTokens > 0;
        }
        return false;
    }

    /**
     * 报告工具调用的"非 args 部分开销"（函数名、调用 ID、JSON 结构包装等）。
     *
     * 背景：provider 实际报告的 output_tokens 包含完整的 tool_call 结构，
     * 各 provider 的真实计费结构差异较大：
     * - openai (Chat Completions): `{"id":"call_xxx","type":"function","function":{"name":...,"arguments":"<argsJson>"}}`
     * - openai-responses: `{"type":"function_call","id":"fc_xxx","call_id":"call_xxx","name":...,"arguments":"<argsJson>"}`
     * - anthropic: `{"type":"tool_use","id":"toolu_xxx","name":...,"input":<argsObject>}`
     * - gemini: `{"functionCall":{"name":...,"args":<argsObject>}}`
     *
     * 此前实现只编码了 `{"name":...,"arguments":argsJson}` 最小结构，仍比实际少约 50%。
     * 本方法构造接近 provider 实际计费的完整结构，再做 subtraction 扣除 args 单独编码的部分，
     * 把 name + id + type + JSON 包装开销累加到 estimatedOutputTokens。
     *
     * 不计入 outputChars / chars/s：这部分不是流式输出字符，仅作 token 估算修正。
     * 未注入 tokenizer 时为 no-op。
     *
     * @param sdkMode provider 计费结构模式
     * @param name 函数名
     * @param argsJson 已累积的 args JSON 字符串（用于计算扣除部分）
     */
    reportToolCallOverhead(
        sdkMode: 'openai' | 'openai-responses' | 'anthropic' | 'gemini',
        name: string,
        argsJson: string
    ): void {
        if (!this.tokenizer || !name) {
            return;
        }
        // 构造 provider 实际计费的完整结构（含 id/type 等字段开销）
        const fullText = buildProviderToolCallText(sdkMode, name, argsJson);
        // Anthropic/Gemini 的 args 在结构中是对象，需要把 argsJson 解析后重新 stringify，
        // 与 provider 计费的 args 字符表示保持一致
        const argsOnlyText = buildProviderArgsOnlyText(sdkMode, argsJson);

        // 批量缓冲策略：与 reportOutput 的批量 encode 对齐。
        // 并行调用场景下，独立 encode 每个 tool_call 会因 BPE 边界效应系统性高估（每个 JSON 结构
        // 的起始/分隔 token 无法跨 tool_call 复用）。改为累积多个 tool_call 后统一 encode。
        // 累积时用 '\n' 分隔，模拟 provider chat template 中连续 tool_use block 的边界。
        const separator = '\n';
        this.pendingToolCallFullText =
            this.pendingToolCallFullText ? this.pendingToolCallFullText + separator + fullText : fullText;
        this.pendingToolCallArgsText =
            this.pendingToolCallArgsText ? this.pendingToolCallArgsText + separator + argsOnlyText : argsOnlyText;

        const now = this.now();
        if (this.lastToolCallFlushAt === 0) {
            this.lastToolCallFlushAt = now;
        }

        // 应用 provider 校准系数
        const calibration = TOOL_CALL_OVERHEAD_CALIBRATION[sdkMode] ?? 1.0;
        this.lastToolCallCalibration = calibration;

        // 双阈值触发：字符数达到 或 距上次 flush 超过时间阈值
        const reachedCharThreshold = this.pendingToolCallFullText.length >= this.tokenBatchChars;
        const reachedTimeThreshold = now - this.lastToolCallFlushAt >= this.tokenBatchMs;
        if (reachedCharThreshold || reachedTimeThreshold) {
            this.flushPendingToolCallOverhead(calibration, now);
        }

        // 同步更新 tokens/s（即使未 flush，estimatedOutputTokens 也不会减少）
        const elapsedMs = this.firstStreamTime > 0 ? Math.max(1, now - this.firstStreamTime) : 0;
        this.lastTokensPerSecond =
            elapsedMs > 0 && this.estimatedOutputTokens > 0 ? (this.estimatedOutputTokens / elapsedMs) * 1000 : 0;
        this.emitStreamingUpdate(false);
    }

    /**
     * 强制 flush 待处理的 tool_call overhead 缓冲。
     * 在 finishMetrics 自动调用，确保流结束时不丢失未达阈值的尾部开销。
     *
     * @param calibration provider 校准系数
     * @param now 当前时间戳
     */
    private flushPendingToolCallOverhead(calibration: number, now: number): void {
        if (!this.tokenizer || this.pendingToolCallFullText.length === 0) {
            return;
        }
        // 统一 encode 累积的完整结构与 args 单独结构，再做减法
        // 这样多个 tool_call 之间的 BPE token 边界可以复用，避免独立 encode 的系统性高估
        const fullTokens = safeEncodeTokens(this.tokenizer, this.pendingToolCallFullText);
        const argsTokens = safeEncodeTokens(this.tokenizer, this.pendingToolCallArgsText);
        this.pendingToolCallFullText = '';
        this.pendingToolCallArgsText = '';
        this.lastToolCallFlushAt = now;
        if (fullTokens === undefined || argsTokens === undefined) {
            return;
        }
        let overhead = fullTokens - argsTokens;
        if (overhead <= 0) {
            return;
        }
        if (calibration !== 1.0) {
            overhead = Math.max(1, Math.round(overhead * calibration));
        }
        this.estimatedOutputTokens += overhead;
        // 覆盖最近一次 flush 的 delta 快照（最近一次接收的预估值）
        this.lastFlushTokenDelta = overhead;
        this.flushSeq++;
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
            // 覆盖最近一次 flush 的 delta 快照（最近一次接收的预估值）
            this.lastFlushTokenDelta = tokens;
            this.flushSeq++;
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
        // flush 残留的 tool_call overhead 缓冲，确保并行调用场景下不丢失尾部开销
        this.flushPendingToolCallOverhead(this.lastToolCallCalibration, this.now());

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
            estimatedOutputTokens: this.estimatedOutputTokens,
            // 最近一次 flush（text/tool_call overhead）新增的 token 数。
            // UI 用 `+xx` 展示"最近一次接收的预估增量"，比累计值更直观
            lastOutputTokenDelta: this.lastFlushTokenDelta,
            // flush 序号（单调递增）。UI 用它判断"是否真的有新 flush 到达"，
            // 避免依赖 delta 值大小变化做误判（稳定速度下连续 flush 的 delta 可能相同）
            lastFlushSeq: this.flushSeq,
            tokensPerSecond: this.lastTokensPerSecond
        });
        this.lastLiveUpdateAt = now;
    }
}
