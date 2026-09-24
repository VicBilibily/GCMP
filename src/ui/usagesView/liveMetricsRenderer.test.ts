import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import type { LiveMetricsRendererDeps } from './liveMetricsRenderer';
import { LiveMetricsRenderer } from './liveMetricsRenderer';
import type { NativeCostSplit } from '../../usages/fileLogger/types';
import type { State } from './types';
import type { LiveStreamMetricEvent } from '../../handlers/liveMetrics';

interface TestTextNode {
    textContent: string;
    title: string;
}

interface TestClassList {
    add: (...names: string[]) => void;
    remove: (...names: string[]) => void;
    contains: (name: string) => boolean;
}

interface TestStatusCell {
    classList: TestClassList;
    querySelector(selector: string): TestTextNode | null;
}

interface TestOutputCell {
    ttft: TestTextNode;
    tokens: TestTextNode;
    tpot: TestTextNode;
    speed: TestTextNode;
    innerHTML: string;
    querySelector(selector: string): TestTextNode | null;
}

interface TestRow {
    isConnected: boolean;
    dataset: { requestId: string };
    lastElementChild: TestStatusCell;
    getAttribute(name: string): string | null;
    querySelector(selector: string): TestOutputCell | null;
}

interface TestTBody {
    querySelectorAll(selector: string): TestRow[];
}

interface TestRecordsContainer {
    querySelectorAll(selector: string): TestTBody[];
}

interface TestDocument {
    querySelector(selector: string): TestRecordsContainer | null;
}

Reflect.set(globalThis, 'window', { __VS_CODE_LOCALE__: 'zh-cn' });
Reflect.set(globalThis, 'requestAnimationFrame', (_callback: FrameRequestCallback) => 1);
Reflect.set(globalThis, 'cancelAnimationFrame', (_handle: number) => undefined);

function createClassList(initial: string[] = []) {
    const set = new Set(initial);
    return {
        add: (...names: string[]) => names.forEach(name => set.add(name)),
        remove: (...names: string[]) => names.forEach(name => set.delete(name)),
        contains: (name: string) => set.has(name)
    };
}

function createTextNode() {
    return { textContent: '', title: '' };
}

function createOutputCell() {
    const ttft = createTextNode();
    const tokens = createTextNode();
    const tpot = createTextNode();
    const speed = createTextNode();
    for (const node of [ttft, tokens, tpot, speed]) {
        node.textContent = '-';
    }
    return {
        ttft,
        tokens,
        tpot,
        speed,
        innerHTML: '',
        querySelector(selector: string) {
            switch (selector) {
                case '.output-ttft':
                    return ttft;
                case '.output-tokens':
                    return tokens;
                case '.output-tpot':
                    return tpot;
                case '.output-speed':
                    return speed;
                default:
                    return null;
            }
        }
    };
}

function createRendererDom(requestId: string) {
    const statusLabel = createTextNode();
    const statusCell = {
        classList: createClassList(['status-estimated']),
        querySelector(selector: string) {
            return selector === '.status-label' ? statusLabel : null;
        }
    };
    const outputCell = createOutputCell();
    const row = {
        isConnected: true,
        dataset: { requestId, requestStatus: 'streaming' },
        lastElementChild: statusCell,
        getAttribute(name: string): string | null {
            if (name === 'data-request-id') {
                return requestId;
            }
            if (name === 'data-request-status') {
                return row.dataset.requestStatus;
            }
            return null;
        },
        querySelector(selector: string) {
            return selector === 'td.records-output-merged[data-metric="output"]' ? outputCell : null;
        }
    };
    const tbody = {
        querySelectorAll(selector: string) {
            return selector === 'tr' ? [row] : [];
        }
    };
    const recordsContainer = {
        querySelectorAll(selector: string) {
            return selector === 'tbody' ? [tbody] : [];
        }
    };

    const documentStub: TestDocument = {
        querySelector(selector: string) {
            return selector === '#records-container' ? recordsContainer : null;
        }
    };
    Reflect.set(globalThis, 'document', documentStub);

    return { row, statusCell, statusLabel, outputCell };
}

function createEmptyNativeCostSplit(): NativeCostSplit {
    return {
        totalUsd: 0,
        totalRmb: 0,
        inputUsd: 0,
        inputRmb: 0,
        outputUsd: 0,
        outputRmb: 0,
        cacheReadUsd: 0,
        cacheReadRmb: 0,
        cacheWriteUsd: 0,
        cacheWriteRmb: 0
    };
}

function createRendererDeps(): LiveMetricsRendererDeps {
    const state: State = {
        selectedDate: '2026-08-14',
        today: '2026-08-14',
        selectedSessionId: null,
        selectedSessionIds: [],
        displayCurrency: 'MIXED',
        dateList: [],
        dateLoadError: null,
        dateDetails: {
            date: '2026-08-14',
            isToday: true,
            isExtensionHostDebugMode: false,
            providers: [],
            hourlyStats: {},
            allSummary: {
                requestCount: 0,
                totalTokens: 0,
                completedCount: 0,
                failedCount: 0,
                cancelledCount: 0
            },
            allTotals: {
                inputTokens: 0,
                cacheTokens: 0,
                outputTokens: 0,
                totalCost: 0,
                totalCostRmb: 0,
                nativeCosts: createEmptyNativeCostSplit(),
                costedRequests: 0,
                rmbExactRequests: 0
            },
            nativeSplitIndex: {
                total: createEmptyNativeCostSplit(),
                providers: {},
                models: {},
                hours: {},
                hourProviders: {},
                hourModels: {}
            },
            sessionGroups: [],
            updateSeq: 0,
            detailLoading: false,
            recordsView: null,
            trackRecords: null,
            detailError: null
        },
        loading: {
            dateDetails: false
        }
    };

    return {
        getState: () => state
    };
}

test('LiveMetricsRenderer switches status label between WAIT and ACTIVE', () => {
    const { statusCell, statusLabel, outputCell } = createRendererDom('req-1');
    const renderer = new LiveMetricsRenderer(createRendererDeps());

    renderer.handleEvent({
        type: 'rateLimitWaiting',
        requestId: 'req-1',
        requestStartTime: 1000,
        providerName: 'GCMP',
        modelName: 'test-model',
        waitScope: 'local',
        queuePosition: 3
    });

    assert.equal(statusLabel.textContent, 'WAIT');
    assert.equal(statusLabel.title, '等待本地限流放行');
    assert.equal(statusCell.classList.contains('status-waiting'), true);
    assert.equal(outputCell.ttft.textContent, '-');
    assert.equal(outputCell.tpot.textContent, '#3');

    renderer.handleEvent({
        type: 'requestStarted',
        requestId: 'req-1',
        requestStartTime: 1200,
        providerName: 'GCMP',
        modelName: 'test-model'
    });

    assert.equal(statusLabel.textContent, 'ACTIVE');
    assert.equal(statusLabel.title, '');
    assert.equal(statusCell.classList.contains('status-estimated'), true);
});

test('LiveMetricsRenderer switches status to PACE when pacing wait has no queue position', () => {
    const { statusCell, statusLabel, outputCell } = createRendererDom('req-2');
    const renderer = new LiveMetricsRenderer(createRendererDeps());

    renderer.handleEvent({
        type: 'rateLimitWaiting',
        requestId: 'req-2',
        requestStartTime: 1000,
        providerName: 'GCMP',
        modelName: 'test-model',
        waitScope: 'local',
        queuePosition: 1
    });

    assert.equal(statusLabel.textContent, 'WAIT');

    renderer.handleEvent({
        type: 'rateLimitWaiting',
        requestId: 'req-2',
        requestStartTime: 1100,
        providerName: 'GCMP',
        modelName: 'test-model',
        waitScope: 'local'
    });

    assert.equal(statusLabel.textContent, 'PACE');
    assert.equal(statusCell.classList.contains('status-waiting'), true);
    assert.equal(outputCell.tpot.textContent, '-');
});

function createClockFixture(context: TestContext) {
    let now = 10_000;
    let nextFrameId = 0;
    const frames = new Map<number, FrameRequestCallback>();
    context.mock.method(Date, 'now', () => now);
    context.mock.method(globalThis, 'requestAnimationFrame', (callback: FrameRequestCallback) => {
        frames.set(++nextFrameId, callback);
        return nextFrameId;
    });
    context.mock.method(globalThis, 'cancelAnimationFrame', (id: number) => frames.delete(id));
    const deps = createRendererDeps();
    const renderer = new LiveMetricsRenderer(deps);
    context.after(() => renderer.dispose());
    const dom = createRendererDom('req-clock');
    const event: LiveStreamMetricEvent = {
        type: 'streamingUpdate',
        requestId: 'req-clock',
        requestStartTime: 1000,
        providerName: 'Test',
        modelName: 'Test',
        streamStartTime: 2000,
        estimatedOutputTokens: 100,
        lastOutputTokenDelta: 25,
        lastFlushSeq: 4,
        tokensPerSecond: 12.5
    };
    return {
        renderer,
        deps,
        dom,
        event,
        frameCount: () => frames.size,
        advance: (time: number) => {
            now = time;
            const pending = [...frames.values()];
            frames.clear();
            pending.forEach(callback => callback(time));
        }
    };
}

test('live clocks advance without provider output and resume after a date switch', context => {
    const { renderer, deps, dom, event, advance, frameCount } = createClockFixture(context);
    renderer.handleEvent({ ...event, type: 'requestStarted', streamStartTime: undefined });
    advance(11_000);
    assert.equal(dom.outputCell.ttft.textContent, '10.0s');
    assert.equal(dom.outputCell.tpot.textContent, '-');
    renderer.handleEvent(event);
    advance(15_000);
    assert.equal(dom.outputCell.ttft.textContent, '1.0s');
    assert.equal(dom.outputCell.tpot.textContent, '13.0s');
    assert.equal(dom.outputCell.tokens.textContent, '+25 tks');
    assert.equal(dom.outputCell.speed.textContent, '~');

    const details = deps.getState().dateDetails!;
    details.date = '2026-08-13';
    details.isToday = false;
    renderer.onDateChanged(false, true);
    assert.equal(frameCount(), 0);
    advance(20_000);
    assert.equal(dom.outputCell.tpot.textContent, '13.0s');
    details.date = '2026-08-14';
    details.isToday = true;
    renderer.onDateChanged(true, true);
    assert.equal(dom.outputCell.tpot.textContent, '18.0s');
    assert.equal(frameCount(), 1);
});

const replayCases: Array<{ name: string; event: Partial<LiveStreamMetricEvent> }> = [
    { name: 'duplicate requestStarted', event: { type: 'requestStarted' } },
    { name: 'duplicate firstChunk', event: { type: 'firstChunk' } },
    { name: 'replayed rate limit wait', event: { type: 'rateLimitWaiting', queuePosition: 3 } },
    { name: 'previous attempt start', event: { type: 'requestStarted', requestStartTime: 500 } },
    {
        name: 'previous attempt output',
        event: { requestStartTime: 500, streamStartTime: 600, lastFlushSeq: 20, lastOutputTokenDelta: 3 }
    },
    { name: 'older output flush', event: { lastFlushSeq: 3, estimatedOutputTokens: 75, lastOutputTokenDelta: 3 } }
];
for (const replay of replayCases) {
    test(`live metrics preserve progress after ${replay.name}`, context => {
        const { renderer, dom, event, advance } = createClockFixture(context);
        renderer.handleEvent(event);
        renderer.handleEvent({ ...event, ...replay.event });
        assert.equal(dom.outputCell.ttft.textContent, '1.0s');
        assert.equal(dom.outputCell.tpot.textContent, '8.0s');
        assert.equal(dom.outputCell.tokens.textContent, '+25 tks');
        assert.equal(dom.outputCell.speed.textContent, '12.5 t/s');
        advance(11_000);
        assert.equal(dom.outputCell.tpot.textContent, '9.0s');
    });
}

test('a new attempt resets metrics even when only its heartbeat arrives', context => {
    const { renderer, dom, event, advance } = createClockFixture(context);
    renderer.handleEvent(event);
    advance(16_000);
    renderer.handleEvent({
        ...event,
        requestStartTime: 15_000,
        streamStartTime: undefined,
        estimatedOutputTokens: 0,
        lastOutputTokenDelta: 0,
        lastFlushSeq: 0,
        tokensPerSecond: 0
    });
    assert.equal(dom.outputCell.ttft.textContent, '1.0s');
    assert.equal(dom.outputCell.tpot.textContent, '-');
    assert.equal(dom.outputCell.tokens.textContent, '-');
    renderer.handleEvent({ ...event, requestStartTime: 15_000, streamStartTime: 15_500, lastFlushSeq: 1 });
    assert.equal(dom.outputCell.ttft.textContent, '500ms');
    assert.equal(dom.outputCell.tpot.textContent, '500ms');
});

test('a genuine retry start clears prior output but duplicate starts remain idempotent', context => {
    const { renderer, dom, event, advance } = createClockFixture(context);
    renderer.handleEvent(event);
    advance(16_000);
    const retry = { ...event, type: 'requestStarted' as const, requestStartTime: 15_000 };
    renderer.handleEvent(retry);
    assert.equal(dom.outputCell.ttft.textContent, '1.0s');
    assert.equal(dom.outputCell.tpot.textContent, '-');
    assert.equal(dom.outputCell.tokens.textContent, '-');
    renderer.handleEvent({ ...event, requestStartTime: 15_000, streamStartTime: 15_500, lastFlushSeq: 1 });
    renderer.handleEvent(retry);
    assert.equal(dom.outputCell.ttft.textContent, '500ms');
    assert.equal(dom.outputCell.tpot.textContent, '500ms');
    assert.equal(dom.outputCell.tokens.textContent, '+25 tks');
});

test('ending a rate limit wait does not turn queue time into TTFT', context => {
    const { renderer, dom, event, frameCount } = createClockFixture(context);
    renderer.handleEvent({ ...event, type: 'rateLimitWaiting', queuePosition: 3 });
    renderer.handleEvent({ ...event, type: 'streamEnd' });
    assert.equal(dom.statusLabel.textContent, 'SYNC');
    assert.equal(dom.outputCell.ttft.textContent, '-');
    assert.equal(dom.outputCell.tpot.textContent, '-');
    assert.equal(frameCount(), 0);
});

test('rebuilding a real row restores live values immediately without another event or frame', context => {
    const { renderer, dom, event } = createClockFixture(context);
    renderer.handleEvent(event);
    dom.row.isConnected = false;
    const replacement = createRendererDom(event.requestId);
    renderer.render();
    assert.equal(replacement.outputCell.ttft.textContent, '1.0s');
    assert.equal(replacement.outputCell.tpot.textContent, '8.0s');
    assert.equal(replacement.outputCell.tokens.textContent, '+25 tks');
});

test('stream end freezes metrics until final records replace an estimated row', context => {
    const { renderer, dom, event, advance, frameCount } = createClockFixture(context);
    renderer.handleEvent({ ...event, requestStartTime: 1500 });
    renderer.handleEvent({ ...event, type: 'streamEnd' });
    assert.equal(frameCount(), 0);
    dom.row.isConnected = false;
    const replacement = createRendererDom(event.requestId);
    advance(15_000);
    renderer.render();
    assert.equal(replacement.outputCell.ttft.textContent, '500ms');
    assert.equal(replacement.outputCell.tpot.textContent, '8.0s');
    assert.equal(replacement.outputCell.tokens.textContent, '+25 tks');
    assert.equal(replacement.statusLabel.textContent, 'SYNC');

    replacement.row.dataset.requestStatus = 'completed';
    replacement.outputCell.tokens.textContent = '123 tks';
    renderer.render();
    assert.equal(replacement.outputCell.tokens.textContent, '123 tks');
    replacement.row.isConnected = false;
    const obsoleteRow = createRendererDom(event.requestId);
    renderer.render();
    assert.equal(obsoleteRow.outputCell.tpot.textContent, '-');
});

test('ended metrics expire and a fresh live event can resume a disconnected request', context => {
    const { renderer, dom, event, advance, frameCount } = createClockFixture(context);
    renderer.handleEvent(event);
    renderer.handleEvent({ ...event, type: 'streamEnd' });
    advance(15_000);
    renderer.handleEvent({ ...event, lastFlushSeq: 5 });
    assert.equal(frameCount(), 1);
    assert.equal(dom.statusLabel.textContent, 'ACTIVE');
    assert.equal(dom.outputCell.tpot.textContent, '13.0s');
    renderer.handleEvent({ ...event, type: 'streamEnd' });
    advance(45_001);
    dom.row.isConnected = false;
    const replacement = createRendererDom(event.requestId);
    renderer.render();
    assert.equal(replacement.outputCell.tpot.textContent, '-');
    assert.equal(frameCount(), 0);
});
