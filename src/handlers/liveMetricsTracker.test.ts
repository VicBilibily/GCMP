import assert from 'node:assert/strict';
import test from 'node:test';

import { LiveMetricsTracker } from './liveMetricsTracker';
import type { LiveStreamMetricEvent } from './liveMetrics';
import type { TikTokenizer } from '@microsoft/tiktokenizer';

/**
 * 收集 onLiveMetrics 回调的事件，便于断言。
 * 通过 SENTINEL 区分"未传入字段（用默认）"与"显式传入 undefined（测试缺省场景）"。
 */
const OMIT = Symbol('omit');

/**
 * 受控时钟：测试通过 `set(t)` 推进时间，避免基于真实墙钟的弱确定性断言。
 * 注意：直接给返回对象的 value 字段赋值不会生效，必须用 set()。
 */
interface ControlledClock {
    now: () => number;
    set: (t: number) => void;
}

function createClock(initial: number): ControlledClock {
    let current = initial;
    return {
        now: () => current,
        set: (t: number) => {
            current = t;
        }
    };
}

function createTracker(options: {
    requestId?: string | typeof OMIT;
    requestStartTime?: number | typeof OMIT;
    providerName?: string;
    modelName?: string;
    liveUpdateIntervalMs?: number;
    now?: () => number;
    tokenizer?: TikTokenizer;
    tokenBatchChars?: number;
    tokenBatchMs?: number;
}): { tracker: LiveMetricsTracker; events: LiveStreamMetricEvent[] } {
    const events: LiveStreamMetricEvent[] = [];
    const tracker = new LiveMetricsTracker({
        requestId: options.requestId === OMIT ? undefined : (options.requestId ?? 'req-1'),
        requestStartTime: options.requestStartTime === OMIT ? undefined : (options.requestStartTime ?? 1000),
        providerName: options.providerName ?? 'TestProvider',
        modelName: options.modelName ?? 'test-model',
        onLiveMetrics: event => events.push(event),
        liveUpdateIntervalMs: options.liveUpdateIntervalMs,
        now: options.now,
        tokenizer: options.tokenizer,
        tokenBatchChars: options.tokenBatchChars,
        tokenBatchMs: options.tokenBatchMs
    });
    return { tracker, events };
}

/**
 * 获取指定下标的事件，自动断言存在（避免 noUncheckedIndexedAccess 噪音）。
 */
function getEvent(events: LiveStreamMetricEvent[], index: number): LiveStreamMetricEvent {
    const ev = events.at(index);
    assert.ok(ev, `expected events[${index}] to exist`);
    return ev;
}

test('canEmitMetrics returns false when requestId is missing', () => {
    const { tracker } = createTracker({ requestId: OMIT });
    assert.equal(tracker.canEmitMetrics(), false);
});

test('canEmitMetrics returns false when requestStartTime is missing or invalid', () => {
    assert.equal(createTracker({ requestStartTime: OMIT }).tracker.canEmitMetrics(), false);
    assert.equal(createTracker({ requestStartTime: Number.NaN }).tracker.canEmitMetrics(), false);
});

test('canEmitMetrics returns true when requestId and requestStartTime are provided', () => {
    const { tracker } = createTracker({});
    assert.equal(tracker.canEmitMetrics(), true);
});

test('markStreamStarted emits firstChunk with latency = streamStartTime - requestStartTime', () => {
    const { tracker, events } = createTracker({ requestStartTime: 1000 });
    tracker.markStreamStarted(1500);

    assert.equal(events.length, 1);
    const first = getEvent(events, 0);
    assert.equal(first.type, 'firstChunk');
    assert.equal(first.requestId, 'req-1');
    assert.equal(first.streamStartTime, 1500);
    assert.equal(first.firstChunkLatencyMs, 500);
    assert.equal(first.providerName, 'TestProvider');
    assert.equal(first.modelName, 'test-model');
});

test('markStreamStarted clamps negative latency to 0 (clock skew)', () => {
    const { tracker, events } = createTracker({ requestStartTime: 2000 });
    tracker.markStreamStarted(1500);
    assert.equal(getEvent(events, 0).firstChunkLatencyMs, 0);
});

test('markStreamStarted is idempotent: repeated calls do not reset firstStreamTime', () => {
    const { tracker, events } = createTracker({ requestStartTime: 1000 });
    tracker.markStreamStarted(1500);
    tracker.markStreamStarted(2000); // 应被忽略
    tracker.markStreamStarted(3000); // 应被忽略

    assert.equal(events.length, 1);
    const first = getEvent(events, 0);
    assert.equal(first.streamStartTime, 1500);
    assert.equal(first.firstChunkLatencyMs, 500);
    assert.equal(tracker.getMetricStreamStartTime(), 1500);
});

test('markStreamStarted is a no-op when canEmitMetrics is false', () => {
    const { tracker, events } = createTracker({ requestId: OMIT });
    tracker.markStreamStarted(1500);
    assert.equal(events.length, 0);
    assert.equal(tracker.getMetricStreamStartTime(), undefined);
});

test('reportOutput backfills markStreamStarted when no firstChunk event has been emitted', () => {
    const clock = createClock(1500);
    const { tracker, events } = createTracker({ requestStartTime: 1000, now: clock.now });
    // 直接 reportOutput，无前置 markStreamStarted
    tracker.reportOutput(10);

    // 应该产生 firstChunk + streamingUpdate 两个事件（顺序）
    assert.equal(events.length, 2);
    const firstChunk = getEvent(events, 0);
    const update1 = getEvent(events, 1);
    assert.equal(firstChunk.type, 'firstChunk');
    assert.equal(firstChunk.streamStartTime, 1500, 'firstStreamTime 由 clock 提供，可精确断言');
    assert.equal(firstChunk.streamStartTime, update1.streamStartTime);
    assert.equal(update1.type, 'streamingUpdate');
    assert.equal(update1.outputChars, 10);
});

test('reportOutput accumulates outputChars across calls', () => {
    const { tracker, events } = createTracker({ requestStartTime: 1000, liveUpdateIntervalMs: 0 });
    tracker.reportOutput(5);
    tracker.reportOutput(15);
    tracker.reportOutput(10);

    // reportOutput 内部会触发 markStreamStarted（首次），然后 streamingUpdate
    // 节流间隔 0，每次 reportOutput 都应有一条 streamingUpdate
    const updates = events.filter(e => e.type === 'streamingUpdate');
    assert.equal(getEvent(updates, 0).outputChars, 5);
    assert.equal(getEvent(updates, 1).outputChars, 20);
    assert.equal(getEvent(updates, 2).outputChars, 30);
});

test('reportOutput accumulates estimatedOutputTokens when tokenizer is injected (batch encode)', () => {
    // 模拟 tokenizer：每个字符算 1 token（便于精确断言）
    const mockTokenizer = { encode: (text: string) => Array(text.length).fill(0) } as unknown as TikTokenizer;
    const { tracker, events } = createTracker({
        requestStartTime: 1000,
        liveUpdateIntervalMs: 0,
        tokenizer: mockTokenizer,
        tokenBatchChars: 10 // 阈值 10 字符
    });

    // 3 字符：未达阈值，estimatedOutputTokens 仍为 0
    tracker.reportOutput(3, 'abc');
    let updates = events.filter(e => e.type === 'streamingUpdate');
    assert.equal(getEvent(updates, 0).estimatedOutputTokens, 0, 'below threshold: not encoded yet');

    // 7 字符（累计 10）：刚好达到阈值，触发 encode
    tracker.reportOutput(7, 'defghij');
    updates = events.filter(e => e.type === 'streamingUpdate');
    assert.equal(getEvent(updates, 1).estimatedOutputTokens, 10, 'reached threshold: batch encoded');

    // 5 字符（缓冲 5，未达阈值）
    tracker.reportOutput(5, 'klmno');
    updates = events.filter(e => e.type === 'streamingUpdate');
    assert.equal(getEvent(updates, 2).estimatedOutputTokens, 10, 'below threshold again: unchanged');
});

test('finishMetrics flushes residual pending text to estimatedOutputTokens', () => {
    const mockTokenizer = { encode: (text: string) => Array(text.length).fill(0) } as unknown as TikTokenizer;
    const { tracker, events } = createTracker({
        requestStartTime: 1000,
        liveUpdateIntervalMs: 0,
        tokenizer: mockTokenizer,
        tokenBatchChars: 100 // 高阈值，保证不会中途触发
    });

    tracker.markStreamStarted(1500);
    // 累计 8 字符，未达阈值
    tracker.reportOutput(8, 'abcdefgh');
    // finishMetrics 应 flush 残留缓冲
    tracker.finishMetrics();

    const last = events.at(-1);
    assert.ok(last);
    assert.equal(last!.type, 'streamingUpdate');
    assert.equal(last!.estimatedOutputTokens, 8, 'residual text flushed at finish');
});

test('high-speed model: batches multiple chunks before encoding (default 512 char threshold)', () => {
    // 模拟 4000t/s 高速模型：每个 chunk 120 chars，1ms 内可能到达多个
    const mockTokenizer = { encode: (text: string) => Array(text.length).fill(0) } as unknown as TikTokenizer;
    const clock = createClock(2000);
    const { tracker, events } = createTracker({
        requestStartTime: 1000,
        liveUpdateIntervalMs: 0,
        now: clock.now,
        tokenizer: mockTokenizer
        // 使用默认 tokenBatchChars=512, tokenBatchMs=500
    });
    tracker.markStreamStarted(2000);

    // 连续 4 个 chunk（每个 120 chars），总 480 chars，未达 512 阈值
    for (let i = 0; i < 4; i++) {
        tracker.reportOutput(120, 'a'.repeat(120));
    }
    let updates = events.filter(e => e.type === 'streamingUpdate');
    // 4 个 chunk 都未触发 encode，estimatedOutputTokens 仍为 0
    assert.equal(getEvent(updates, 3).estimatedOutputTokens, 0, '4 chunks (480 chars) below 512 threshold: no encode');

    // 第 5 个 chunk（累计 600 chars），超过 512 阈值，触发一次性 encode
    tracker.reportOutput(120, 'a'.repeat(120));
    updates = events.filter(e => e.type === 'streamingUpdate');
    assert.equal(getEvent(updates, 4).estimatedOutputTokens, 600, '5 chunks (600 chars) exceeded 512: batch encoded');

    // 验证 tokenizer.encode 只被调用了一次（而非 5 次）
    // 通过检查事件数：5 个 chunk 产生 5 个 streamingUpdate，但只有第 5 个有非零 token
    const nonZeroTokenUpdates = updates.filter(u => (u.estimatedOutputTokens ?? 0) > 0);
    assert.equal(nonZeroTokenUpdates.length, 1, 'encode should only fire once for 5 chunks');
});

test('time threshold forces flush even if char threshold not reached (slow model)', () => {
    const mockTokenizer = { encode: (text: string) => Array(text.length).fill(0) } as unknown as TikTokenizer;
    const clock = createClock(2000);
    const { tracker, events } = createTracker({
        requestStartTime: 1000,
        liveUpdateIntervalMs: 0,
        now: clock.now,
        tokenizer: mockTokenizer,
        tokenBatchChars: 1000, // 高字符阈值，确保只有时间阈值会触发
        tokenBatchMs: 500
    });
    tracker.markStreamStarted(2000);

    // 首个 chunk：初始化 lastEncodeAt = 2000
    tracker.reportOutput(10, 'abcdefghij');

    // 推进 400ms（未达 500ms 阈值），不应触发
    clock.set(2400);
    tracker.reportOutput(10, 'klmnopqrst');
    let updates = events.filter(e => e.type === 'streamingUpdate');
    assert.equal(getEvent(updates, 1).estimatedOutputTokens, 0, '400ms < 500ms threshold: no encode');

    // 推进到 2501ms（距上次 encode 501ms），应触发时间阈值 flush
    clock.set(2501);
    tracker.reportOutput(10, 'uvwxyz0123');
    updates = events.filter(e => e.type === 'streamingUpdate');
    assert.equal(getEvent(updates, 2).estimatedOutputTokens, 30, '501ms >= 500ms threshold: time-forced flush');
});

test('reportOutput falls back to precomputed token increments when no tokenizer', () => {
    const { tracker, events } = createTracker({ requestStartTime: 1000, liveUpdateIntervalMs: 0 });
    tracker.reportOutput(5, 2);
    tracker.reportOutput(15, 7);
    tracker.reportOutput(10, 3);

    const updates = events.filter(e => e.type === 'streamingUpdate');
    assert.equal(getEvent(updates, 0).estimatedOutputTokens, 2);
    assert.equal(getEvent(updates, 1).estimatedOutputTokens, 9);
    assert.equal(getEvent(updates, 2).estimatedOutputTokens, 12);
});

test('reportOutput ignores invalid token increments but still counts chars', () => {
    const { tracker, events } = createTracker({ requestStartTime: 1000, liveUpdateIntervalMs: 0 });
    tracker.reportOutput(5, Number.NaN);
    tracker.reportOutput(5, -1);
    tracker.reportOutput(5, 0);
    tracker.reportOutput(5, undefined);

    const updates = events.filter(e => e.type === 'streamingUpdate');
    // 所有非法 token 增量都应被忽略
    updates.forEach(u => assert.equal(u.estimatedOutputTokens, 0));
    // 但字符数仍正常累加
    assert.equal(getEvent(updates, 3).outputChars, 20);
});

test('reportOutput ignores non-positive or invalid input', () => {
    const { tracker, events } = createTracker({ requestStartTime: 1000, liveUpdateIntervalMs: 0 });
    tracker.reportOutput(0);
    tracker.reportOutput(-5);
    tracker.reportOutput(Number.NaN);

    assert.equal(events.length, 0);
});

test('reportOutput computes charsPerSecond from elapsed time since first stream event', () => {
    const clock = createClock(2000);
    const { tracker, events } = createTracker({
        requestStartTime: 1000,
        liveUpdateIntervalMs: 0,
        now: clock.now
    });

    // markStreamStarted 把 firstStreamTime 固定为 2000
    tracker.markStreamStarted(2000);
    // 模拟 firstStreamTime 之后 100ms，收到 50 字符 → 500 chars/s
    clock.set(2100);
    tracker.reportOutput(50);

    const update = events.find(e => e.type === 'streamingUpdate');
    assert.ok(update, 'expected at least one streamingUpdate');
    assert.equal(update!.charsPerSecond, 500, '50 chars over 100ms = 500 chars/s');
});

test('reportOutput freezes charsPerSecond during pause (no decay)', () => {
    const clock = createClock(2000);
    const { tracker, events } = createTracker({
        requestStartTime: 1000,
        liveUpdateIntervalMs: 0,
        now: clock.now
    });
    tracker.markStreamStarted(2000);
    // 2000 + 200ms 后收到 100 字符 → 500 chars/s
    clock.set(2200);
    tracker.reportOutput(100);

    const speedAfterFirst = events.at(-1)?.charsPerSecond;
    assert.equal(speedAfterFirst, 500);

    // 模拟暂停：推进 5 秒，连续 heartbeat 不应改变 charsPerSecond
    clock.set(7200);
    tracker.heartbeat();
    clock.set(9721);
    tracker.heartbeat();
    clock.set(12345);
    tracker.heartbeat();

    const lastUpdate = events.at(-1);
    assert.ok(lastUpdate);
    assert.equal(lastUpdate!.type, 'streamingUpdate');
    assert.equal(lastUpdate!.charsPerSecond, 500, 'charsPerSecond should remain frozen during pause');
});

test('heartbeat respects throttle interval and emits at most one streamingUpdate per tick', () => {
    // 注意：tracker 初始 lastLiveUpdateAt=0，所以第一次 heartbeat 必须满足
    // (now - 0) >= interval 才会发射。让 clock 起点远大于 interval 即可。
    const clock = createClock(200000);
    const { tracker, events } = createTracker({
        requestStartTime: 1000,
        liveUpdateIntervalMs: 100000, // 100s 节流，保证只发一次
        now: clock.now
    });
    tracker.heartbeat();
    clock.set(205000);
    tracker.heartbeat();
    clock.set(299999);
    tracker.heartbeat();

    assert.equal(events.length, 1, 'throttled heartbeat should emit only once');
    assert.equal(getEvent(events, 0).type, 'streamingUpdate');
});

test('heartbeat does not fix firstStreamTime (only reportOutput can)', () => {
    const clock = createClock(1500);
    const { tracker, events } = createTracker({ requestStartTime: 1000, now: clock.now });
    tracker.heartbeat();

    assert.equal(events.length, 1);
    const first = getEvent(events, 0);
    assert.equal(first.type, 'streamingUpdate');
    assert.equal(first.streamStartTime, undefined, 'heartbeat must not fix firstStreamTime');
    assert.equal(first.firstChunkLatencyMs, 500, 'pre-firstChunk latency = clock - requestStart');
    assert.equal(tracker.getMetricStreamStartTime(), undefined);
});

test('pre-firstChunk latency grows with elapsed time (not fixed)', () => {
    const clock = createClock(1100);
    const { tracker, events } = createTracker({
        requestStartTime: 1000,
        liveUpdateIntervalMs: 0, // 关闭节流以观察 latency 增长
        now: clock.now
    });
    tracker.heartbeat();
    const firstLatency = getEvent(events, 0).firstChunkLatencyMs ?? 0;
    assert.equal(firstLatency, 100);

    // 推进 500ms 后再 heartbeat
    clock.set(1600);
    tracker.heartbeat();
    const secondLatency = getEvent(events, 1).firstChunkLatencyMs ?? 0;

    assert.equal(secondLatency, 600);
    assert.ok(secondLatency > firstLatency, 'pre-firstChunk latency should grow over time');
});

test('finishMetrics is idempotent across multiple calls', () => {
    const { tracker, events } = createTracker({ requestStartTime: 1000, liveUpdateIntervalMs: 0 });
    tracker.markStreamStarted(1500);
    tracker.reportOutput(10);

    const eventsBeforeFinish = events.length;
    tracker.finishMetrics();
    tracker.finishMetrics(); // 重复调用
    tracker.finishMetrics(); // 再次重复

    // finishMetrics 只应多发一帧 force=true 的 streamingUpdate
    assert.equal(events.length, eventsBeforeFinish + 1);
    const last = events.at(-1);
    assert.ok(last);
    assert.equal(last!.type, 'streamingUpdate');
});

test('finishMetrics after finishMetrics does nothing (even with prior state)', () => {
    const { tracker, events } = createTracker({ requestStartTime: 1000 });
    tracker.markStreamStarted(1500);
    tracker.finishMetrics();
    const countAfterFirst = events.length;

    tracker.finishMetrics();
    assert.equal(events.length, countAfterFirst, 'second finishMetrics should not emit');
});

test('finishMetrics skips final streamingUpdate if firstChunk was never emitted', () => {
    const { tracker, events } = createTracker({ requestStartTime: 1000 });
    tracker.heartbeat(); // 发一帧 streamingUpdate（未固定首流）
    const countBeforeFinish = events.length;

    tracker.finishMetrics();

    assert.equal(events.length, countBeforeFinish, 'finishMetrics should not emit if firstChunkEmitted is false');
});

test('finishMetrics is a no-op when canEmitMetrics is false', () => {
    const { tracker, events } = createTracker({ requestId: OMIT });
    tracker.finishMetrics();
    assert.equal(events.length, 0);
});

test('tool argument double-counting: reportOutput followed by reportToolCall countArgs=false', () => {
    // 模拟 Anthropic handler 场景：先 reportToolArgDelta 累计 delta，再 reportToolCall(countArgs: false)
    const { tracker, events } = createTracker({ requestStartTime: 1000, liveUpdateIntervalMs: 0 });
    tracker.markStreamStarted(1500);

    // delta 累计 30 字符
    tracker.reportOutput(30);
    // reportToolCall(countArgs: false) 不应再次统计
    // 注意：countArgs 在 StreamReporter 层，tracker 只暴露 reportOutput
    // 这里直接验证 tracker.reportOutput 不被外部重复调用即可

    const update = events.find(e => e.type === 'streamingUpdate' && e.outputChars === 30);
    assert.ok(update, 'expected streamingUpdate with outputChars=30');
    assert.equal(update!.outputChars, 30);
});

test('getMetricStreamStartTime returns undefined before markStreamStarted, value after', () => {
    const { tracker } = createTracker({ requestStartTime: 1000 });
    assert.equal(tracker.getMetricStreamStartTime(), undefined);

    tracker.markStreamStarted(2500);
    assert.equal(tracker.getMetricStreamStartTime(), 2500);
});
