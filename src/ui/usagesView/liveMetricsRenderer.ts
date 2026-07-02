/*---------------------------------------------------------------------------------------------
 *  实时流式指标渲染器
 *  从 app.ts 抽离：维护实时指标状态机、占位行 DOM、共享渲染时钟，
 *  并把 streamingUpdate / firstChunk / requestStarted / streamEnd 事件映射到表格行的实时更新。
 *
 *  通过构造函数注入 getState 与 createEmptyTable，避免与 app.ts 的全局状态耦合。
 *--------------------------------------------------------------------------------------------*/

import type { LiveStreamMetricEvent } from '../../handlers/liveMetrics';
import type { State } from './types';
import { getTodayDateString, t } from './utils';

/**
 * 单个请求的实时流式指标状态
 *
 * 注意：后端事件里的 requestStartTime 已经是当前 attempt 的开始时间
 *（GenericModelProvider 每次 retry 都会用 liveAttemptStartTime 重建 handler 与 StreamReporter），
 * 因此 attemptStartTime 用于 live TTFT 计算，displayStartTime 仅用于时间列展示。
 */
interface LiveMetricsState {
    displayStartTime: number; // 首次观测到的请求开始时间（时间列展示）
    attemptStartTime: number; // 当前 attempt 开始时间（live TTFT 计算）
    streamStartTime?: number; // 当前 attempt 首流事件时间
    firstChunkLatencyMs: number; // 当前 attempt 固定的首流延迟
    estimatedOutputTokens: number; // 实时估算的输出 token（带边界误差，仅供展示）
    lastOutputTokenDelta: number; // 最近一次 flush 新增的 token 数（UI 显示为 +xx）
    lastFlushSeq: number; // flush 序号（单调递增），用于过时检测判断"是否真的有新 flush"
    tokensPerSecond: number; // 实时估算的输出 token 速度（暂停期间冻结）
    lastOutputChangeAt: number; // 最后一次 flush 接收到非零 token 增量的时间
    providerName?: string;
    modelName?: string;
    hasFirstChunk: boolean; // 首流延迟/流开始时间已固定（retry 幂等）
}

/**
 * LiveMetricsRenderer 依赖注入接口
 */
export interface LiveMetricsRendererDeps {
    /** 读取最新应用状态（用于 isViewingToday / selectedSessionId） */
    getState: () => State;
}

// 共享渲染时钟（rAF + 200ms 节流）
const LIVE_RENDER_INTERVAL_MS = 200;

export class LiveMetricsRenderer {
    private readonly getState: () => State;
    private readonly liveMetricsMap = new Map<string, LiveMetricsState>();
    /**
     * requestId → 表格行的缓存，避免每次 render 都 querySelectorAll 全表扫描。
     * 行被 updateDateDetails 重建后，缓存会自动失效（dataset.requestId 不匹配）。
     * streamEnd / dispose 时清理对应条目。
     */
    private readonly rowCache = new Map<string, HTMLTableRowElement>();
    private renderClockId: number | undefined;
    private lastRenderAt = 0;

    constructor(deps: LiveMetricsRendererDeps) {
        this.getState = deps.getState;
    }

    // ============= 事件入口 =============

    /**
     * 处理实时流式指标更新
     *
     * 注意：后端事件里的 requestStartTime 已经是当前 attempt 的开始时间
     *（GenericModelProvider 每次 retry 都会用 liveAttemptStartTime 重新创建 handler 与 StreamReporter），
     * 因此 WebView 端应将 event.requestStartTime 作为 attemptStartTime 计算 live TTFT，
     * 而不应保留“首次” requestStartTime。展示用的时间列使用单独保存的 displayStartTime。
     */
    handleEvent(event: LiveStreamMetricEvent): void {
        const { requestId } = event;

        switch (event.type) {
            case 'requestStarted': {
                const existing = this.liveMetricsMap.get(requestId);
                const state = existing ?? this.createEmptyLiveMetricsState(event);
                // 保留首次观测到的开始时间用于展示；每次 retry 更新当前 attempt 时间
                state.displayStartTime = existing?.displayStartTime ?? event.requestStartTime;
                state.attemptStartTime = event.requestStartTime;
                state.streamStartTime = undefined;
                state.firstChunkLatencyMs = 0;
                state.hasFirstChunk = false;
                this.resetAttemptOutput(state);
                state.providerName = existing?.providerName || event.providerName;
                state.modelName = existing?.modelName || event.modelName;
                this.liveMetricsMap.set(requestId, state);
                this.startRenderClock();
                break;
            }

            case 'firstChunk': {
                // upsert：requestStarted 可能因面板未打开/日期切换而丢失
                const state = this.liveMetricsMap.get(requestId) ?? this.createEmptyLiveMetricsState(event);
                state.attemptStartTime = event.requestStartTime;
                state.streamStartTime = event.streamStartTime;
                state.firstChunkLatencyMs = this.computeFirstChunkLatency(
                    event.streamStartTime,
                    event.requestStartTime,
                    event.firstChunkLatencyMs
                );
                state.hasFirstChunk = true;
                this.resetAttemptOutput(state);
                state.providerName = state.providerName || event.providerName;
                state.modelName = state.modelName || event.modelName;
                this.liveMetricsMap.set(requestId, state);
                this.startRenderClock();
                break;
            }

            case 'streamingUpdate': {
                let state = this.liveMetricsMap.get(requestId);
                if (!state) {
                    state = this.createEmptyLiveMetricsState(event);
                    this.liveMetricsMap.set(requestId, state);
                    this.startRenderClock();
                }
                state.attemptStartTime = event.requestStartTime;

                // 检测 attempt 切换（firstChunk 丢失时的兜底）：通过 streamStartTime 变化判断
                const isNewAttempt =
                    event.streamStartTime !== undefined && event.streamStartTime !== state.streamStartTime;

                if (isNewAttempt || !state.hasFirstChunk) {
                    state.streamStartTime = event.streamStartTime;
                    state.firstChunkLatencyMs = this.computeFirstChunkLatency(
                        event.streamStartTime,
                        event.requestStartTime,
                        event.firstChunkLatencyMs
                    );
                    if (isNewAttempt) {
                        this.resetAttemptOutput(state);
                    }
                    state.hasFirstChunk = true;
                }

                // 用 flushSeq 判断"是否真的有新 flush 到达"，避免稳定速度下 delta 值相同被误判为无变化
                const previousSeq = state.lastFlushSeq;
                const newSeq = Math.max(previousSeq, event.lastFlushSeq ?? previousSeq);
                if (newSeq > previousSeq) {
                    state.lastOutputChangeAt = Date.now();
                }
                // 同步最新的 token 预估（增量 encode 累加值，由 StreamReporter 上报）
                if (event.estimatedOutputTokens !== undefined) {
                    state.estimatedOutputTokens = event.estimatedOutputTokens;
                }
                state.lastOutputTokenDelta = event.lastOutputTokenDelta ?? state.lastOutputTokenDelta;
                state.lastFlushSeq = newSeq;
                state.tokensPerSecond = event.tokensPerSecond ?? state.tokensPerSecond;
                // 补齐 provider/model（requestStarted 可能未被 WebView 接收到）
                state.providerName = state.providerName || event.providerName;
                state.modelName = state.modelName || event.modelName;
                break;
            }

            case 'streamEnd': {
                this.liveMetricsMap.delete(requestId);
                this.rowCache.delete(requestId);
                if (this.liveMetricsMap.size === 0) {
                    this.stopRenderClock();
                }
                this.render();
                return;
            }
        }

        // 触发请求记录区域的更新
        this.render();
    }

    /**
     * 通知日期详情切换：在 updateDateDetails 处理后由 app.ts 调用。
     * - 切到非今天时停止渲染时钟，但保留 liveMetricsMap 中的活动状态；
     *   切回今天时由 startRenderClock() 内部的 isViewingToday() 守卫自动恢复
     * - 总是立即刷新一次表格（包括仍在运行的请求）
     */
    onDateChanged(isToday: boolean, dateChanged: boolean): void {
        if (dateChanged && !isToday) {
            this.stopRenderClock();
        }
        this.render();
        if (isToday && this.liveMetricsMap.size > 0) {
            this.startRenderClock();
        }
    }

    /**
     * 判断当前是否在查看今天的请求记录（实时指标仅适用于今天）
     */
    isViewingToday(): boolean {
        const appState = this.getState();
        const today = appState.today || getTodayDateString();
        return appState.dateDetails?.isToday === true || appState.dateDetails?.date === today;
    }

    /**
     * 释放资源（取消 rAF、清空活动状态）
     */
    dispose(): void {
        this.stopRenderClock();
        this.liveMetricsMap.clear();
        this.rowCache.clear();
    }

    // ============= 内部：渲染时钟 =============

    private startRenderClock(): void {
        if (!this.isViewingToday() || this.liveMetricsMap.size === 0 || this.renderClockId !== undefined) {
            return;
        }
        const tick = (frameTime: number): void => {
            if (!this.isViewingToday() || this.liveMetricsMap.size === 0) {
                this.renderClockId = undefined;
                this.lastRenderAt = 0;
                return;
            }
            if (frameTime - this.lastRenderAt >= LIVE_RENDER_INTERVAL_MS) {
                this.render();
                this.lastRenderAt = frameTime;
            }
            this.renderClockId = requestAnimationFrame(tick);
        };
        this.renderClockId = requestAnimationFrame(tick);
    }

    private stopRenderClock(): void {
        if (this.renderClockId !== undefined) {
            cancelAnimationFrame(this.renderClockId);
            this.renderClockId = undefined;
        }
        this.lastRenderAt = 0;
    }

    // ============= 内部：状态构造与计算 =============

    private createEmptyLiveMetricsState(event: LiveStreamMetricEvent): LiveMetricsState {
        return {
            displayStartTime: event.requestStartTime,
            attemptStartTime: event.requestStartTime,
            firstChunkLatencyMs: 0,
            estimatedOutputTokens: 0,
            lastOutputTokenDelta: 0,
            lastFlushSeq: 0,
            tokensPerSecond: 0,
            lastOutputChangeAt: 0,
            providerName: event.providerName,
            modelName: event.modelName,
            hasFirstChunk: false
        };
    }

    private resetAttemptOutput(state: LiveMetricsState): void {
        state.estimatedOutputTokens = 0;
        state.lastOutputTokenDelta = 0;
        state.lastFlushSeq = 0;
        state.tokensPerSecond = 0;
        state.lastOutputChangeAt = 0;
    }

    private computeFirstChunkLatency(
        streamStartTime: number | undefined,
        attemptStartTime: number,
        fallbackLatency?: number
    ): number {
        if (
            streamStartTime !== undefined &&
            Number.isFinite(streamStartTime) &&
            Number.isFinite(attemptStartTime) &&
            attemptStartTime > 0
        ) {
            return Math.max(0, streamStartTime - attemptStartTime);
        }
        return fallbackLatency ?? 0;
    }

    // ============= 内部：占位行 DOM 管理 =============

    /**
     * 解析指定 requestId 对应的表格行：
     * 1. 优先返回缓存（验证 dataset.requestId 一致 + 仍在 DOM 中）
     * 2. 缓存未命中时回退到全表扫描，命中则回填缓存
     * 3. 仍未找到返回 undefined
     *
     * 这样 render() 不必每次都 querySelectorAll 全表扫描。
     * 表格被 updateDateDetails 重建后，旧引用会因 isConnected=false 失效。
     */
    private resolveTargetRow(tbody: HTMLElement, requestId: string): HTMLTableRowElement | undefined {
        const cached = this.rowCache.get(requestId);
        if (cached && cached.isConnected && cached.dataset.requestId === requestId) {
            return cached;
        }
        // 缓存失效或未命中，回退到 DOM 查询
        const found = Array.from(tbody.querySelectorAll<HTMLTableRowElement>('tr')).find(
            row => row.getAttribute('data-request-id') === requestId
        );
        if (found) {
            this.rowCache.set(requestId, found);
        } else {
            this.rowCache.delete(requestId);
        }
        return found;
    }

    // ============= 内部：表格行渲染 =============

    /**
     * 更新请求记录区域，显示实时指标
     * 策略：遍历所有正在流式的请求，通过 requestId 精确匹配已存在的真实记录行并更新。
     * 不创建任何占位行——如果当前页/筛选下没有该请求的真实行，实时指标就不展示，
     * 等 updateDateDetails 后续把记录写入正确位置时（用户切到对应页/取消筛选）再显示。
     */
    private render(): void {
        // 仅在今天页面渲染实时指标，不污染历史日期
        if (!this.isViewingToday()) {
            return;
        }

        const recordsContainer = document.querySelector('#records-container') as HTMLElement;
        if (!recordsContainer) {
            return;
        }

        const tbody = recordsContainer.querySelector('tbody');
        if (!tbody) {
            return;
        }

        const now = Date.now();

        this.liveMetricsMap.forEach((metricState, requestId) => {
            // 只更新已存在的真实记录行；找不到就跳过（不创建占位行）
            const targetRow = this.resolveTargetRow(tbody, requestId);
            if (!targetRow) {
                return;
            }

            // 跳过已完成/失败的行，避免实时值覆盖最终统计
            const requestStatus = targetRow.getAttribute('data-request-status');
            if (requestStatus === 'completed' || requestStatus === 'failed' || requestStatus === 'cancelled') {
                return;
            }

            // 实时计算首流延迟：首流事件前持续增长，首流事件后固定
            const hasStreamStarted = metricState.streamStartTime !== undefined;
            const latencyMs =
                hasStreamStarted ? metricState.firstChunkLatencyMs : Math.max(0, now - metricState.attemptStartTime);

            // 实时计算输出耗时：首流事件后开始计算
            const durationMs = hasStreamStarted ? Math.max(0, now - metricState.streamStartTime!) : 0;

            // 输出速度：使用 tracker 缓存的 tokensPerSecond，暂停期间不会衰减
            const tokensPerSecond = metricState.tokensPerSecond ?? 0;

            // 更新首流延迟 + 输出耗时 + 速度
            const outputCell = targetRow.querySelector('td.records-output-merged[data-metric="output"]') as HTMLElement;
            if (outputCell) {
                // 防御性兜底：兼容旧 DOM 或未来变更，确保 span 结构存在
                if (!outputCell.querySelector('.output-ttft')) {
                    outputCell.innerHTML =
                        '<div class="output-row"><span class="output-ttft">-</span><span class="output-tokens">-</span></div>' +
                        '<div class="output-detail"><span class="output-tpot">-</span><span class="output-speed">-</span></div>';
                }
                const ttftSpan = outputCell.querySelector('.output-ttft') as HTMLElement;
                if (ttftSpan) {
                    ttftSpan.title = '首流延迟：从 provider 开始处理请求到首个流事件的近似耗时，不一定是首个可见文字';
                    ttftSpan.textContent =
                        latencyMs >= 1000 ? `${(latencyMs / 1000).toFixed(1)}s` : `${Math.round(latencyMs)}ms`;
                }
                const tpotSpan = outputCell.querySelector('.output-tpot') as HTMLElement;
                if (tpotSpan) {
                    tpotSpan.textContent =
                        durationMs > 0 ?
                            durationMs >= 1000 ?
                                `${(durationMs / 1000).toFixed(1)}s`
                            :   `${Math.round(durationMs)}ms`
                        :   '-';
                }
                // .output-tokens 在 streaming 阶段显示"最近一次接收的预估增量"（+xx），
                // 不显示累计预估值（估算误差大易引起误解），等完成后由真实 usage 记录覆盖
                const tokensSpan = outputCell.querySelector('.output-tokens') as HTMLElement;
                if (tokensSpan) {
                    const lastDelta = metricState.lastOutputTokenDelta ?? 0;
                    if (lastDelta > 0) {
                        tokensSpan.textContent = `+${lastDelta.toLocaleString('en-US')} tks`;
                        tokensSpan.title = t(
                            'Tokens received in the last estimation window (approximate, for live speed feedback only)',
                            '最近一次估算窗口接收到的 token（近似值，仅用于实时速度反馈）'
                        );
                    } else {
                        tokensSpan.textContent = '-';
                    }
                }
                const speedSpan = outputCell.querySelector('.output-speed') as HTMLElement;
                if (speedSpan) {
                    // 过时检测：长时间没有新的 provider 输出时，避免冻结的旧 speed 被误解为仍在实时更新
                    const lastOutputChangeAt = metricState.lastOutputChangeAt ?? 0;
                    const outputStaleMs = lastOutputChangeAt > 0 ? now - lastOutputChangeAt : 0;
                    const isStale =
                        hasStreamStarted &&
                        metricState.estimatedOutputTokens > 0 &&
                        lastOutputChangeAt > 0 &&
                        outputStaleMs > 3000;

                    if (isStale) {
                        speedSpan.textContent = '~';
                        speedSpan.title = t(
                            'No new provider output chunk has arrived recently. Some compatible endpoints buffer tool arguments and send them in a later chunk; speed will update when new output arrives.',
                            '近期未收到新的 provider 输出分片。部分兼容端点会缓冲工具参数并稍后一次性发送；速度将在收到新输出时更新。'
                        );
                    } else if (tokensPerSecond > 0 && hasStreamStarted) {
                        speedSpan.textContent = `${tokensPerSecond.toFixed(1)} t/s`;
                        speedSpan.title = t(
                            'Estimated output tokens/s from the first stream event to the latest output of the current attempt; completed requests show usage-based output tokens/s.',
                            '实时估算的输出 token 速度：按当前尝试从首个流事件到最近一次输出的 token 总量估算；请求完成后显示基于 usage 的输出 token/s。'
                        );
                    } else {
                        speedSpan.textContent = '-';
                    }
                }
            }
        });
    }
}
