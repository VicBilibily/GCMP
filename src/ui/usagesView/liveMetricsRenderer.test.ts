import test from 'node:test';
import assert from 'node:assert/strict';
import type { LiveMetricsRendererDeps } from './liveMetricsRenderer';
import { LiveMetricsRenderer } from './liveMetricsRenderer';
import type { NativeCostSplit } from '../../usages/fileLogger/types';
import type { State } from './types';

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
        dataset: { requestId },
        lastElementChild: statusCell,
        getAttribute(name: string) {
            if (name === 'data-request-id') {
                return requestId;
            }
            if (name === 'data-request-status') {
                return 'streaming';
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

    return { statusCell, statusLabel, outputCell };
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

test('LiveMetricsRenderer clears queue badge after leaving queue', () => {
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

    renderer.handleEvent({
        type: 'rateLimitWaiting',
        requestId: 'req-2',
        requestStartTime: 1100,
        providerName: 'GCMP',
        modelName: 'test-model',
        waitScope: 'local'
    });

    assert.equal(statusLabel.textContent, 'ACTIVE');
    assert.equal(statusCell.classList.contains('status-estimated'), true);
    assert.equal(outputCell.tpot.textContent, '-');
});
