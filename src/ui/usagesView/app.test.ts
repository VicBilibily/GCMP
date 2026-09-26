import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import test from 'node:test';
import { buildNativeCostSplitIndex, buildRequestTotals, summarizeSessionRecords } from './aggregation';
import type {
    HostMessage,
    RecordsPageMessage,
    State,
    UpdateDateDetailsMessage,
    UpdateDateStatsMessage,
    WebViewMessage
} from './types';

const require = createRequire(import.meta.url);
const NodeModule = require('node:module') as {
    prototype: { require: (id: string) => unknown };
};

class TestElement {
    id = '';
    className = '';
    textContent = '';
    scrollLeft = 0;
    scrollTop = 0;
    readonly dataset: Record<string, string> = {};
    onclick: (() => void) | null = null;
    children: TestElement[] = [];
    parentElement: TestElement | null = null;
    private html = '';
    private rect = { top: 0, bottom: 0, left: 0, right: 0, width: 0, height: 0 };
    readonly classList = {
        add: (...names: string[]) => {
            this.className = [...new Set([...this.className.split(' '), ...names])].join(' ');
        },
        remove: (...names: string[]) => {
            this.className = this.className
                .split(' ')
                .filter(name => !names.includes(name))
                .join(' ');
        },
        contains: (name: string) => this.className.split(' ').includes(name)
    };

    constructor(readonly tagName: string) {}

    get firstChild(): TestElement | null {
        return this.children[0] ?? null;
    }

    get innerHTML(): string {
        return this.html;
    }

    set innerHTML(value: string) {
        this.html = value;
        this.children = [];
    }

    appendChild(child: TestElement): TestElement {
        child.parentElement = this;
        this.children.push(child);
        return child;
    }

    insertBefore(child: TestElement, before: TestElement | null): void {
        child.parentElement = this;
        const index = before ? this.children.indexOf(before) : -1;
        this.children.splice(index < 0 ? this.children.length : index, 0, child);
    }

    remove(): void {
        if (this.parentElement) {
            this.parentElement.children = this.parentElement.children.filter(child => child !== this);
            this.parentElement = null;
        }
    }

    setRect(top: number, bottom: number): void {
        this.rect = { top, bottom, left: 0, right: 100, width: 100, height: bottom - top };
    }

    getBoundingClientRect(): typeof this.rect {
        return this.rect;
    }

    contains(target: TestElement): boolean {
        return target === this || this.children.some(child => child.contains(target));
    }

    focus(): void {
        Reflect.set(globalThis.document, 'activeElement', this);
    }

    setAttribute(name: string, value: string): void {
        if (name === 'id') {
            this.id = value;
        } else if (name === 'class') {
            this.className = value;
        }
    }

    querySelector(selector: string): TestElement | null {
        for (const child of this.children) {
            const focusKey = /^\[data-records-focus-key="(.+)"\]$/.exec(selector)?.[1];
            const matches =
                selector.startsWith('#') ? child.id === selector.slice(1)
                : selector.startsWith('.') ? child.classList.contains(selector.slice(1))
                : focusKey !== undefined ? child.dataset.recordsFocusKey === focusKey
                : child.tagName === selector;
            if (matches) {
                return child;
            }
            const nested = child.querySelector(selector);
            if (nested) {
                return nested;
            }
        }
        return null;
    }
}

test('date summary failures end loading, preserve prior data and expose a working retry', async t => {
    const originalRequire = NodeModule.prototype.require;
    const originalWindow = Object.getOwnPropertyDescriptor(globalThis, 'window');
    const originalDocument = Object.getOwnPropertyDescriptor(globalThis, 'document');
    const body = new TestElement('body');
    const posts: WebViewMessage[] = [];
    let renderedSections = 0;
    let renderedLoadingSections = 0;
    let renderedErrorSections = 0;
    let cachedPages = 0;
    let prefetchRuns = 0;
    let primedPages = 0;
    const liveRenderSections: number[] = [];
    let initialize!: () => void;
    let onMessage!: (event: { data: HostMessage }) => void;
    Reflect.set(globalThis, 'document', {
        readyState: 'loading',
        body,
        createElement: (tag: string) => new TestElement(tag),
        querySelector: (selector: string) => body.querySelector(selector),
        getElementById: (id: string) => body.querySelector(`#${id}`),
        addEventListener: (event: string, listener: () => void) => {
            if (event === 'DOMContentLoaded') {
                initialize = listener;
            }
        }
    });
    Reflect.set(globalThis, 'window', {
        vscode: { postMessage: (message: WebViewMessage) => posts.push(message) },
        matchMedia: () => ({ matches: false }),
        addEventListener: (event: string, listener: typeof onMessage) => {
            if (event === 'message') {
                onMessage = listener;
            }
        }
    });

    try {
        NodeModule.prototype.require = function (id: string): unknown {
            if (id.endsWith('.less') || id === 'chart.js/auto') {
                return {};
            }
            if (id.endsWith('/liveMetricsRenderer')) {
                return {
                    LiveMetricsRenderer: class {
                        onDateChanged() {}
                        handleEvent() {}
                        render() {
                            liveRenderSections.push(renderedSections);
                        }
                    }
                };
            }
            if (id.endsWith('/components/dateList')) {
                return {
                    createSidebar: () => Object.assign(new TestElement('aside'), { className: 'sidebar' }),
                    updateDateList() {}
                };
            }
            if (id.endsWith('/components/requestRecords')) {
                return {
                    createRequestRecordsSection() {
                        renderedSections++;
                        window.usagesRenderLiveMetrics?.();
                    },
                    createRecordsLoadingSection() {
                        renderedLoadingSections++;
                    },
                    createRecordsErrorSection() {
                        renderedErrorSections++;
                    },
                    cacheRecordsPage() {
                        cachedPages++;
                        return true;
                    },
                    fetchDetailByCurrentView() {},
                    prefetchRecordsPages() {
                        prefetchRuns++;
                    },
                    primeCurrentRecordsPage() {
                        primedPages++;
                    },
                    preserveRecordsViewport(update: () => void) {
                        update();
                    },
                    resetRequestRecordsState() {},
                    getTrackedRecordsLimit: () => 10,
                    getTrackedSessionIds: () => [],
                    isStaleDetailError: () => false,
                    isStaleDetailResponse: () => false,
                    isTrackModeActive: () => window.usagesState.selectedSessionIds.length >= 2,
                    refreshRequestRecordCosts() {}
                };
            }
            if (id.endsWith('/components/sessionFilter')) {
                return { shouldShowSessionGroupInFilter: () => true };
            }
            if (id.endsWith('/providerStats')) {
                return { createProviderStats: () => new TestElement('div') };
            }
            if (id.endsWith('/hourlyStats')) {
                return { createHourlyStats: () => new TestElement('div') };
            }
            if (id.endsWith('/hourlyChart')) {
                return { createHourlyChart: () => new TestElement('div') };
            }
            return originalRequire.call(this, id);
        };
        await import('./app');
        initialize();
        const state = window.usagesState;
        const today = state.today;
        const sendSummary = (date: string, requestId?: string): void => {
            const records =
                requestId ?
                    [
                        {
                            requestId,
                            timestamp: new Date(`${date}T12:00:00`).getTime(),
                            isoTime: `${date}T12:00:00.000Z`,
                            providerKey: 'test',
                            providerName: 'Test',
                            modelId: 'model',
                            modelName: 'Model',
                            estimatedInput: 1,
                            rawUsage: null,
                            status: 'completed' as const,
                            actualInput: 1,
                            cacheReadTokens: 0,
                            cacheCreationTokens: 0,
                            outputTokens: 0,
                            totalTokens: 1
                        }
                    ]
                :   [];
            const summary = summarizeSessionRecords(records);
            const totals = buildRequestTotals(records);
            const message: UpdateDateDetailsMessage = {
                command: 'updateDateDetails',
                date,
                isToday: date === today,
                isExtensionHostDebugMode: false,
                providers: [],
                hourlyStats: {},
                allSummary: summary,
                allTotals: totals,
                nativeSplitIndex: buildNativeCostSplitIndex(records),
                sessionGroups: [],
                initialRecordsPage: {
                    mode: 'all',
                    page: 1,
                    pageSize: 20,
                    totalItems: records.length,
                    records,
                    summary,
                    totals
                },
                updateSeq: 1
            };
            onMessage({ data: message });
        };
        const sendStats = (date: string): void => {
            const message: UpdateDateStatsMessage = {
                command: 'updateDateStats',
                date,
                isToday: date === today,
                isExtensionHostDebugMode: false,
                providers: [],
                hourlyStats: {}
            };
            onMessage({ data: message });
        };

        await t.test('initial failure without a prior summary releases the overlay', () => {
            window.usagesSetLoading('dateDetails', true);
            onMessage({ data: { command: 'dateLoadError', date: today } });
            assert.equal(state.loading.dateDetails, false);
            assert.equal(state.dateDetails, null);
            assert.ok(body.querySelector('.date-load-error'));
        });

        await t.test('retry sends the selected date and successful summary clears the error', () => {
            const retry = body.querySelector('.date-load-error')?.querySelector('button');
            assert.ok(retry?.onclick);
            retry.onclick();
            assert.equal(state.loading.dateDetails, true);
            assert.deepEqual(posts.at(-1), { command: 'selectDate', date: today });
            sendSummary(today);
            assert.equal(body.querySelector('.date-load-error'), null);
            assert.equal(state.dateDetails?.date, today);
            onMessage({
                data: {
                    command: 'recordsPage',
                    date: today,
                    mode: 'all',
                    page: 1,
                    pageSize: 20,
                    totalItems: 0,
                    records: [],
                    summary: summarizeSessionRecords([]),
                    totals: buildRequestTotals([]),
                    updateSeq: 1
                }
            });
            assert.equal(state.loading.dateDetails, false);
        });

        await t.test('fast stats release the overlay before the full summary arrives', () => {
            const previewDate = '2026-09-21';
            state.selectedDate = previewDate;
            window.usagesSetLoading('dateDetails', true);
            sendStats(previewDate);
            assert.equal(state.loading.dateDetails, false);
            assert.equal(state.dateDetails, null);
            assert.equal(state.dateStatsPreview?.date, previewDate);
            assert.equal(renderedLoadingSections > 0, true);
            sendSummary(today);
        });

        await t.test('full summary installs the authoritative first page without a second page response', () => {
            const date = '2026-09-18';
            state.selectedDate = date;
            sendStats(date);
            sendSummary(date, 'authoritative-record');
            assert.equal(state.dateDetails?.recordsView?.records[0]?.requestId, 'authoritative-record');
            assert.equal(state.dateDetails?.detailLoading, false);
            assert.equal(primedPages > 0, true);
        });

        await t.test('overview failure replaces the request loading skeleton with an error state', () => {
            const date = '2026-09-17';
            state.selectedDate = date;
            sendStats(date);
            const loadingCount = renderedLoadingSections;
            onMessage({ data: { command: 'dateLoadError', date } });
            assert.equal(renderedLoadingSections, loadingCount);
            assert.equal(renderedErrorSections > 0, true);
        });

        await t.test('same-date fast stats preserve the loaded records while refreshing totals', () => {
            sendSummary(today);
            onMessage({
                data: {
                    command: 'recordsPage',
                    date: today,
                    mode: 'all',
                    page: 1,
                    pageSize: 20,
                    totalItems: 1,
                    records: [],
                    summary: summarizeSessionRecords([]),
                    totals: buildRequestTotals([]),
                    updateSeq: 1
                }
            });
            const previousDetails = state.dateDetails;
            window.usagesSetLoading('dateDetails', true);
            sendStats(today);
            assert.equal(state.loading.dateDetails, false);
            assert.equal(state.dateDetails, previousDetails);
            assert.equal(state.dateDetails?.recordsView?.totalItems, 1);
        });

        await t.test('prefetched pages are cached without replacing the visible page', () => {
            sendSummary(today);
            onMessage({
                data: {
                    command: 'recordsPage',
                    date: today,
                    mode: 'all',
                    page: 1,
                    pageSize: 20,
                    totalItems: 60,
                    records: [],
                    summary: summarizeSessionRecords([]),
                    totals: buildRequestTotals([]),
                    updateSeq: 1
                }
            });
            cachedPages = 0;
            prefetchRuns = 0;
            onMessage({
                data: {
                    command: 'recordsPage',
                    date: today,
                    mode: 'all',
                    page: 2,
                    pageSize: 20,
                    totalItems: 60,
                    records: [],
                    summary: summarizeSessionRecords([]),
                    totals: buildRequestTotals([]),
                    updateSeq: 1,
                    prefetch: true
                }
            });
            assert.equal(state.dateDetails?.recordsView?.page, 1);
            assert.equal(cachedPages, 1);
            assert.equal(prefetchRuns, 1);
        });

        await t.test('failed date switch retains the previous successful summary', () => {
            const previous = state.dateDetails;
            state.selectedDate = '2026-09-20';
            window.usagesSetLoading('dateDetails', true);
            onMessage({ data: { command: 'dateLoadError', date: state.selectedDate } });
            assert.equal(state.loading.dateDetails, false);
            assert.equal(state.dateDetails, previous);
            const error = body.querySelector('.date-load-error');
            assert.ok(error);
            assert.ok(error.children.some(child => child.textContent.includes('2026-09-20')));
            error.querySelector('button')?.onclick?.();
            assert.deepEqual(posts.at(-1), { command: 'selectDate', date: '2026-09-20' });
        });

        await t.test('stale failure does not stop loading for a newer selection', () => {
            state.selectedDate = '2026-09-19';
            window.usagesSetLoading('dateDetails', true);
            onMessage({ data: { command: 'dateLoadError', date: '2026-09-20' } });
            assert.equal(state.loading.dateDetails, true);
            assert.equal(body.querySelector('.date-load-error'), null);
        });

        await t.test('page and track responses synchronously reapply live metrics after rebuilding rows', () => {
            sendSummary(today);
            liveRenderSections.length = 0;
            onMessage({
                data: {
                    command: 'recordsPage',
                    date: today,
                    mode: 'all',
                    page: 1,
                    pageSize: 20,
                    totalItems: 0,
                    records: [],
                    summary: summarizeSessionRecords([]),
                    totals: buildRequestTotals([]),
                    updateSeq: 1
                }
            });
            assert.deepEqual(liveRenderSections, [renderedSections]);
            liveRenderSections.length = 0;
            state.selectedSessionIds = ['first', 'second'];
            onMessage({
                data: {
                    command: 'trackRecords',
                    date: today,
                    groups: [],
                    updateSeq: 1
                }
            });
            assert.deepEqual(liveRenderSections, [renderedSections]);
        });
    } finally {
        NodeModule.prototype.require = originalRequire;
        if (originalWindow) {
            Object.defineProperty(globalThis, 'window', originalWindow);
        } else {
            Reflect.deleteProperty(globalThis, 'window');
        }
        if (originalDocument) {
            Object.defineProperty(globalThis, 'document', originalDocument);
        } else {
            Reflect.deleteProperty(globalThis, 'document');
        }
    }
});

test('request records component notifies live rendering after replacing its contents', async context => {
    const originalWindow = Object.getOwnPropertyDescriptor(globalThis, 'window');
    const originalDocument = Object.getOwnPropertyDescriptor(globalThis, 'document');
    context.after(() => {
        for (const [key, descriptor] of [
            ['window', originalWindow],
            ['document', originalDocument]
        ] as const) {
            if (descriptor) {
                Object.defineProperty(globalThis, key, descriptor);
            } else {
                Reflect.deleteProperty(globalThis, key);
            }
        }
    });
    const container = new TestElement('div');
    let renders = 0;
    Reflect.set(globalThis, 'document', { createElement: (tag: string) => new TestElement(tag) });
    Reflect.set(globalThis, 'window', {
        usagesState: {
            dateDetails: null,
            selectedSessionId: null,
            selectedSessionIds: []
        },
        usagesRenderLiveMetrics: () => {
            assert.ok(container.querySelector('.empty-message'));
            renders++;
        }
    });
    const { createRequestRecordsSection } = await import('./components/requestRecords');
    createRequestRecordsSection([], container as unknown as HTMLElement);
    createRequestRecordsSection([], container as unknown as HTMLElement);
    assert.equal(renders, 2);
});

test('request records redraw preserves viewport scroll and pagination focus', async context => {
    const originalWindow = Object.getOwnPropertyDescriptor(globalThis, 'window');
    const originalDocument = Object.getOwnPropertyDescriptor(globalThis, 'document');
    context.after(() => {
        for (const [key, descriptor] of [
            ['window', originalWindow],
            ['document', originalDocument]
        ] as const) {
            if (descriptor) {
                Object.defineProperty(globalThis, key, descriptor);
            } else {
                Reflect.deleteProperty(globalThis, key);
            }
        }
    });

    const body = new TestElement('body');
    const content = new TestElement('main');
    content.className = 'content';
    content.scrollTop = 240;
    content.setRect(0, 600);
    const records = new TestElement('div');
    records.id = 'records-container';
    records.setRect(100, 700);
    const detail = new TestElement('div');
    detail.className = 'records-detail-content';
    detail.scrollLeft = 36;
    const focusedPage = new TestElement('button');
    focusedPage.dataset.recordsFocusKey = 'page-next';
    records.appendChild(detail);
    records.appendChild(focusedPage);
    content.appendChild(records);
    body.appendChild(content);
    Reflect.set(globalThis, 'document', {
        body,
        activeElement: focusedPage,
        querySelector: (selector: string) => body.querySelector(selector)
    });
    Reflect.set(globalThis, 'window', { usagesState: { dateDetails: null } });

    const { preserveRecordsViewport } = await import('./components/requestRecords');
    let replacementDetail!: TestElement;
    let replacementPage!: TestElement;
    preserveRecordsViewport(() => {
        records.setRect(140, 740);
        records.innerHTML = '';
        replacementDetail = new TestElement('div');
        replacementDetail.className = 'records-detail-content';
        replacementPage = new TestElement('button');
        replacementPage.dataset.recordsFocusKey = 'page-next';
        records.appendChild(replacementDetail);
        records.appendChild(replacementPage);
    });

    assert.equal(content.scrollTop, 280);
    assert.equal(replacementDetail.scrollLeft, 36);
    assert.equal(globalThis.document.activeElement, replacementPage);
});

test('request records prefetches pages sequentially and uses a cached page immediately', async context => {
    const originalWindow = Object.getOwnPropertyDescriptor(globalThis, 'window');
    const originalDocument = Object.getOwnPropertyDescriptor(globalThis, 'document');
    context.after(() => {
        for (const [key, descriptor] of [
            ['window', originalWindow],
            ['document', originalDocument]
        ] as const) {
            if (descriptor) {
                Object.defineProperty(globalThis, key, descriptor);
            } else {
                Reflect.deleteProperty(globalThis, key);
            }
        }
    });

    const posts: WebViewMessage[] = [];
    const summary = summarizeSessionRecords([]);
    const totals = buildRequestTotals([]);
    const state: State = {
        selectedDate: '2026-09-22',
        today: '2026-09-26',
        selectedSessionId: null,
        selectedSessionIds: [],
        displayCurrency: 'MIXED',
        dateList: [],
        dateStatsPreview: null,
        dateDetails: {
            date: '2026-09-22',
            isToday: false,
            isExtensionHostDebugMode: false,
            providers: [],
            hourlyStats: {},
            allSummary: summary,
            allTotals: totals,
            nativeSplitIndex: buildNativeCostSplitIndex([]),
            sessionGroups: [],
            updateSeq: 5,
            detailLoading: false,
            recordsView: {
                mode: 'all',
                page: 1,
                totalItems: 80,
                records: [],
                summary,
                totals
            },
            trackRecords: null,
            detailError: null
        },
        dateLoadError: null,
        loading: { dateDetails: false }
    };
    Reflect.set(globalThis, 'document', { querySelector: () => null });
    Reflect.set(globalThis, 'window', {
        vscode: { postMessage: (message: WebViewMessage) => posts.push(message) },
        usagesState: state,
        usagesLiveMetrics: new Map()
    });

    const {
        cacheRecordsPage,
        changeRecordsPage,
        fetchDetailByCurrentView,
        prefetchRecordsPages,
        resetRequestRecordsState
    } = await import('./components/requestRecords');
    resetRequestRecordsState();
    fetchDetailByCurrentView();
    posts.length = 0;

    const createPage = (page: number, prefetchRequestId: number): RecordsPageMessage => ({
        command: 'recordsPage',
        date: '2026-09-22',
        mode: 'all',
        page,
        pageSize: 20,
        totalItems: 80,
        records: [],
        summary,
        totals,
        updateSeq: 5,
        prefetch: true,
        prefetchRequestId
    });

    prefetchRecordsPages();
    const page2Prefetch = posts[0] as Extract<WebViewMessage, { command: 'getRecordsPage' }>;
    assert.equal(page2Prefetch.page, 2);
    assert.equal(page2Prefetch.prefetch, true);
    assert.equal(typeof page2Prefetch.prefetchRequestId, 'number');
    assert.equal(cacheRecordsPage(createPage(2, page2Prefetch.prefetchRequestId! + 1)), false);
    assert.equal(cacheRecordsPage(createPage(2, page2Prefetch.prefetchRequestId!)), true);
    prefetchRecordsPages();
    const page3Prefetch = posts.at(-1) as Extract<WebViewMessage, { command: 'getRecordsPage' }>;
    assert.equal(page3Prefetch.page, 3);
    assert.equal(cacheRecordsPage(createPage(3, page3Prefetch.prefetchRequestId!)), true);
    posts.length = 0;

    changeRecordsPage(2);
    assert.equal(state.dateDetails?.recordsView?.page, 2);
    const page4Prefetch = posts[0] as Extract<WebViewMessage, { command: 'getRecordsPage' }>;
    assert.equal(page4Prefetch.page, 4);
    assert.equal(page4Prefetch.prefetch, true);

    changeRecordsPage(4);
    const normalPage4 = { ...createPage(4, 0), prefetch: undefined, prefetchRequestId: undefined };
    assert.equal(cacheRecordsPage(normalPage4), true);
    assert.equal(cacheRecordsPage(createPage(4, page4Prefetch.prefetchRequestId!)), false);
});
