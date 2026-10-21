import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import test from 'node:test';
import type { RequestBalanceLog, RequestStatusSnapshot, TokenRequestLog } from '../../usages/fileLogger/types';
import { UsageParser } from '../../usages/fileLogger/usageParser';
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

test('request records section shares the statistics table minimum width', async () => {
    const styles = await readFile(new URL('./style.less', import.meta.url), 'utf8');
    const sectionRule = styles.match(/\.content\s*\{[\s\S]*?> section\s*\{([^}]*)\}/)?.[1];
    assert.ok(sectionRule);
    assert.match(sectionRule, /min-width:\s*580px\b/);
});

test('compatible balance cells allow long unit labels to wrap while keeping emphasis', async () => {
    const styles = await readFile(new URL('./style.less', import.meta.url), 'utf8');
    const cellRule = styles.match(/\.request-balance-section-compatible\s*\{[\s\S]*?td:last-child\s*\{([^}]*)\}/)?.[1];
    assert.ok(cellRule);
    assert.match(cellRule, /font-weight:\s*600\b/);
    assert.doesNotMatch(cellRule, /white-space:\s*nowrap\b/);
});

class TestElement {
    id = '';
    className = '';
    textContent = '';
    title = '';
    scrollLeft = 0;
    scrollTop = 0;
    readonly style: Record<string, string> = {};
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
        child.remove();
        child.parentElement = this;
        this.children.push(child);
        return child;
    }

    append(...children: TestElement[]): void {
        children.forEach(child => this.appendChild(child));
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

test('request records render output duration and average speed in static and total rows', async context => {
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
    const documentListeners = new Map<string, EventListener>();
    const windowListeners = new Map<string, EventListener>();
    const documentStub = {
        documentElement: { lang: 'zh-CN' },
        body: new TestElement('body'),
        createElement: (tag: string) => new TestElement(tag),
        addEventListener: (event: string, listener: EventListener) => documentListeners.set(event, listener),
        removeEventListener: (event: string) => documentListeners.delete(event)
    };
    Reflect.set(globalThis, 'document', documentStub);
    Reflect.set(globalThis, 'window', {
        usagesState: { selectedSessionId: null, selectedSessionIds: [], displayCurrency: 'USD' },
        usagesLiveMetrics: new Map(),
        innerWidth: 800,
        innerHeight: 600,
        addEventListener: (event: string, listener: EventListener) => windowListeners.set(event, listener),
        removeEventListener: (event: string) => windowListeners.delete(event)
    });
    const { createRequestRecordsTable } = await import('./components/requestRecords');
    const render = (overrides: Partial<TokenRequestLog> = {}) => {
        const record = UsageParser.extendLog({
            requestId: 'timing',
            timestamp: 1000,
            isoTime: new Date(1000).toISOString(),
            providerKey: 'test',
            providerName: 'Test',
            modelId: 'model',
            modelName: 'Model',
            estimatedInput: 99,
            status: 'completed',
            requestMetricStartTime: 1000,
            streamStartTime: 1100,
            streamEndTime: 6000,
            rawUsage: { prompt_tokens: 10, completion_tokens: 21, total_tokens: 31 },
            ...overrides
        });
        const table = createRequestRecordsTable(
            [record],
            summarizeSessionRecords([record]),
            buildRequestTotals([record]),
            new Set()
        ) as unknown as TestElement;
        const rows = table.querySelector('tbody')!.children;
        return {
            header: table.querySelector('thead')!.children[0].children[3].innerHTML,
            providerModel: rows[0].children[1],
            output: rows[0].children[3].innerHTML,
            total: rows[1].children[3].innerHTML
        };
    };

    await context.test('request rows show only the captured API key name', () => {
        const apiKeyHash = '0123456789abcdef';
        const named = render({ apiKeyName: '  Primary Key  ', apiKeyHash }).providerModel;
        const namedKey = named.children[0].children[1];
        assert.equal(namedKey.className, 'prov-model-key');
        assert.equal(namedKey.textContent, 'Primary Key');
        assert.equal(namedKey.title, 'Primary Key');
        assert.equal(named.textContent.includes(apiKeyHash), false);
        assert.equal(namedKey.title.includes(apiKeyHash), false);

        for (const apiKeyName of [undefined, '', '   ']) {
            const unnamed = render({ apiKeyName, apiKeyHash }).providerModel.children[0].children[1];
            assert.equal(unnamed.className, 'prov-model-key');
            assert.equal(unnamed.textContent, '');
            assert.equal(unnamed.title, '');
        }
    });

    await context.test('request rows show saved balance after the key with an offline tooltip', () => {
        const providerModel = render({
            providerKey: 'moonshot',
            apiKeyName: 'Primary Key',
            balance: {
                queriedAt: 1000,
                entries: [{ id: 'moonshot', balance: 12.5, currency: 'CNY', paid: 10, granted: 2.5 }],
                statusSnapshots: [
                    {
                        version: 1,
                        provider: 'moonshot',
                        queriedAt: 1000,
                        data: {
                            balanceInfo: { available_balance: 12.5, cash_balance: 10, voucher_balance: 2.5 },
                            lastUpdated: '1970-01-01 00:00:01'
                        }
                    }
                ]
            }
        }).providerModel;
        const header = providerModel.children[0];
        assert.equal(header.children[1].textContent, 'Primary Key');
        const balance = header.children[2];
        assert.ok(balance?.classList.contains('prov-model-balance'));
        assert.equal(balance.querySelector('.request-balance-summary')?.textContent, '¥12.50');
        const tooltip = balance.querySelector('.request-balance-tooltip');
        assert.ok(tooltip);
        assert.equal(Reflect.get(tooltip, 'hidden'), true);
        assert.equal(tooltip.querySelector('.request-balance-title'), null);
        assert.equal(tooltip.children[0].firstChild?.tagName, 'table');
        assert.equal(tooltip.querySelector('th')?.textContent, '货币');
        const enter: () => void = Reflect.get(balance, 'onmouseenter');
        const focus: () => void = Reflect.get(balance, 'onfocus');
        enter();
        assert.equal(Reflect.get(tooltip, 'hidden'), false);
        assert.equal(tooltip.parentElement, documentStub.body);
        assert.ok(tooltip.style.left.endsWith('px'));
        documentListeners.get('keydown')?.(Object.assign(new Event('keydown'), { key: 'Escape' }));
        assert.equal(Reflect.get(tooltip, 'hidden'), true);
        assert.equal(tooltip.parentElement, balance);
        assert.equal(windowListeners.size, 0);
        assert.equal(documentListeners.size, 0);
        focus();
        assert.equal(Reflect.get(tooltip, 'hidden'), false);
        windowListeners.get('scroll')?.(new Event('scroll'));
        assert.equal(Reflect.get(tooltip, 'hidden'), true);
        assert.equal(windowListeners.size, 0);
        assert.equal(documentListeners.size, 0);
    });

    await context.test('request rows without balance data keep the key-only header', () => {
        const header = render({ apiKeyName: 'Legacy Key' }).providerModel.children[0];
        assert.equal(header.children.length, 2);
        assert.equal(header.querySelector('.prov-model-balance'), null);
    });

    await context.test('request balance tooltip stays inside the viewport for offscreen anchors', () => {
        const providerModel = render({
            balance: { queriedAt: 1000, entries: [{ id: 'test', balance: 1, currency: 'USD' }] }
        }).providerModel;
        const balance = providerModel.querySelector('.prov-model-balance')!;
        const tooltip = balance.querySelector('.request-balance-tooltip')!;
        balance.setRect(700, 710);
        tooltip.setRect(0, 200);
        const enter: () => void = Reflect.get(balance, 'onmouseenter');
        const blur: () => void = Reflect.get(balance, 'onblur');
        try {
            enter();
            assert.equal(tooltip.style.top, '392px');
        } finally {
            blur();
        }
    });

    const queriedAt = Date.parse('2026-10-21T00:00:00Z');
    const snapshotContext = {
        icon: '$(credit-card)',
        title: 'Saved balance',
        language: 'en',
        locale: 'en-US',
        timeZone: 'Asia/Shanghai'
    };
    const commandcodeSnapshot: RequestStatusSnapshot = {
        version: 1,
        provider: 'commandcode',
        queriedAt,
        context: snapshotContext,
        data: {
            monthlyCredits: 10,
            purchasedCredits: 2,
            freeCredits: 3,
            totalCredits: 15,
            fiveHour: { used: 20, cap: 100, exceeded: false, resetAt: '2026-10-21T02:30:00Z' },
            weekly: { used: 10, cap: 100, exceeded: false, resetAt: '2026-10-23T00:00:00Z' },
            lastUpdated: 'saved query time'
        }
    };
    const compatibleSnapshot: RequestStatusSnapshot = {
        version: 1,
        provider: 'compatible',
        queriedAt,
        context: snapshotContext,
        data: {
            providerId: 'custom',
            providerName: '<img src=x onerror=alert(1)>',
            balanceInfo: {
                balance: 3,
                currency: 'USD',
                items: [
                    { balance: 0, paid: 0, granted: 0, currency: 'CNY', displayName: 'Wallet' },
                    { balance: 3, currency: 'USD', displayName: 'Credits' }
                ]
            },
            lastUpdated: '2026-10-21T00:00:00Z'
        }
    };
    const localTime = (timestamp: number, separator: string) => {
        const date = new Date(timestamp);
        const pad = (value: number) => String(value).padStart(2, '0');
        return `${pad(date.getMonth() + 1)}${separator}${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
    };
    const fixtures: Array<{
        name: string;
        language?: string;
        snapshot: RequestStatusSnapshot;
        summary: string;
        cells: string[];
    }> = [
        {
            name: 'MiniMax preserves minimum weekly and five-hour quotas',
            summary: '70% (65%)',
            cells: ['Weekly quota', 'Every 5 Hours', '65%', localTime(queriedAt + 3600000, '-')],
            snapshot: {
                version: 1,
                provider: 'minimax-token',
                queriedAt,
                context: snapshotContext,
                data: {
                    limits: [
                        { label: '5 Hours', limitType: '5h', remaining: 65, resetTime: queriedAt + 3600000 },
                        { label: 'Weekly', limitType: 'weekly', remaining: 80 },
                        { label: 'Weekly lower', limitType: 'weekly', remaining: 70 }
                    ]
                }
            }
        },
        {
            name: 'Kimi preserves all windows, booster details and concurrency',
            summary: '75% (90%) $12.50',
            cells: [
                'Monthly quota',
                '5 hours',
                'N/A',
                'Quota Booster (Active)',
                '$12.50',
                '¥2.50',
                'Unlimited',
                'Maximum concurrency: 10'
            ],
            snapshot: {
                version: 1,
                provider: 'kimi',
                queriedAt,
                context: snapshotContext,
                data: {
                    summary: {
                        period: 'monthly',
                        limit: 100,
                        used: 25,
                        remaining: 75,
                        resetTime: '2026-10-23T00:00:00Z'
                    },
                    windows: [
                        { duration: 5, timeUnit: 'TIME_UNIT_HOUR', detail: { limit: 100, used: 10, remaining: 90 } }
                    ],
                    parallel: { limit: 10 },
                    boosterWallet: {
                        balance: { amountLeft: '1250000000' },
                        topupLimit: { currency: 'USD' },
                        status: 'STATUS_ACTIVE',
                        monthlyChargeLimitEnabled: false,
                        monthlyChargeLimit: { currency: 'USD', priceInCents: '100' },
                        monthlyUsed: { currency: 'CNY', priceInCents: '250' }
                    }
                }
            }
        },
        {
            name: 'OpenCode preserves rolling and both long windows',
            summary: '60% (90%)',
            cells: ['5 Hours', 'Weekly quota', 'Monthly quota', '60%', '2h 30m', localTime(queriedAt + 9000000, '/')],
            snapshot: {
                version: 1,
                provider: 'opencode',
                queriedAt,
                context: snapshotContext,
                data: {
                    windows: [
                        {
                            type: 'rolling',
                            usedPercent: 10,
                            remainingPercent: 90,
                            status: 'ok',
                            resetAt: '2026-10-21T02:30:00Z'
                        },
                        { type: 'weekly', usedPercent: 25, remainingPercent: 75, status: 'ok' },
                        { type: 'monthly', usedPercent: 40, remainingPercent: 60, status: 'ok' }
                    ],
                    lastUpdated: 'saved query time'
                }
            }
        },
        {
            name: 'Codex reproduces monthly quota instead of treating it as weekly',
            summary: '60% (90%)',
            cells: ['Monthly quota', '5 Hours', '60%', '2h 30m', localTime(queriedAt + 9000000, '/')],
            snapshot: {
                version: 1,
                provider: 'codex',
                queriedAt,
                context: snapshotContext,
                data: {
                    planType: 'free',
                    codeReviewUsedPercent: 0,
                    lastUpdated: 'saved query time',
                    rateLimit: {
                        allowed: true,
                        limit_reached: false,
                        primary_window: {
                            used_percent: 40,
                            limit_window_seconds: 2592000,
                            reset_at: (queriedAt + 9000000) / 1000
                        },
                        secondary_window: {
                            used_percent: 10,
                            limit_window_seconds: 18000,
                            reset_at: (queriedAt + 9000000) / 1000
                        }
                    }
                }
            }
        },
        {
            name: 'Grok uses current language with recorded quota and original countdown',
            language: 'zh-cn',
            summary: '75%',
            cells: ['每周额度', '75%', '即将重置', localTime(queriedAt - 60000, '/')],
            snapshot: {
                version: 1,
                provider: 'grok',
                queriedAt,
                context: { ...snapshotContext, language: 'zh-cn' },
                data: {
                    usage: {
                        type: 'weekly',
                        usedPercent: 25,
                        remainingPercent: 75,
                        windowMinutes: 10080,
                        subscriptionTier: 'SuperGrok',
                        resetAt: '2026-10-20T23:59:00Z'
                    },
                    lastUpdated: 'saved query time'
                }
            }
        },
        {
            name: 'DeepSeek preserves currency order and raw decimal strings',
            summary: '$3.12',
            cells: ['USD', '3.120000', 'CNY', '10.0000'],
            snapshot: {
                version: 1,
                provider: 'deepseek',
                queriedAt,
                context: snapshotContext,
                data: {
                    primaryBalance: {
                        currency: 'USD',
                        total_balance: '3.120000',
                        topped_up_balance: '3.000000',
                        granted_balance: '0.120000'
                    },
                    allBalances: [
                        {
                            currency: 'USD',
                            total_balance: '3.120000',
                            topped_up_balance: '3.000000',
                            granted_balance: '0.120000'
                        },
                        {
                            currency: 'CNY',
                            total_balance: '10.0000',
                            topped_up_balance: '10.0000',
                            granted_balance: '0.0000'
                        }
                    ],
                    lastUpdated: 'saved query time'
                }
            }
        },
        {
            name: 'CommandCode freezes countdown and uses the current timezone',
            snapshot: commandcodeSnapshot,
            summary: '90% (80%) $2.00',
            cells: ['2h 30m', '2d', localTime(queriedAt + 9000000, '/'), '$15.00']
        },
        {
            name: 'CommandCode without windows shows total credits',
            summary: '$15.00',
            cells: ['$10.00', '$2.00', '$3.00'],
            snapshot: {
                ...commandcodeSnapshot,
                data: { ...commandcodeSnapshot.data, fiveHour: undefined, weekly: undefined }
            }
        },
        {
            name: 'Zhipu quota-only snapshots use the current language',
            language: 'zh-cn',
            summary: '75% (90%)',
            cells: ['每周限额', '每 5 小时', localTime(queriedAt + 3600000, '-')],
            snapshot: {
                version: 1,
                provider: 'zhipu',
                queriedAt,
                context: { ...snapshotContext, language: 'zh-cn' },
                data: {
                    limits: [
                        { type: 'TOKENS_LIMIT', unit: 6, percentage: 25 },
                        { type: 'TOKENS_LIMIT', unit: 3, percentage: 10, nextResetTime: queriedAt + 3600000 }
                    ]
                }
            }
        },
        {
            name: 'ClinePass quota-only snapshots retain all windows and the original countdown',
            summary: '60% (90%)',
            cells: ['5 Hours', 'Weekly limit', 'Monthly limit', '60%', '2h 30m', localTime(queriedAt + 9000000, '-')],
            snapshot: {
                version: 1,
                provider: 'clinepass',
                queriedAt,
                context: snapshotContext,
                data: {
                    limits: [
                        { type: 'five_hour', percentUsed: 10, resetsAt: '2026-10-21T02:30:00Z' },
                        { type: 'weekly', percentUsed: 25, resetsAt: '2026-10-23T00:00:00Z' },
                        { type: 'monthly', percentUsed: 40 }
                    ],
                    lastUpdated: 'saved query time'
                }
            }
        },
        {
            name: 'ClinePass preserves depleted quota and omits an unused short window from the summary',
            language: 'zh-cn',
            summary: '0%',
            cells: ['300 分钟', '每周限额', '每月限额', '100%', '0%', '即将重置'],
            snapshot: {
                version: 1,
                provider: 'clinepass',
                queriedAt,
                context: { ...snapshotContext, language: 'zh-cn' },
                data: {
                    limits: [
                        { type: 'five_hour', percentUsed: 0 },
                        { type: 'weekly', percentUsed: 100, resetsAt: '2026-10-20T23:59:00Z' },
                        { type: 'monthly', percentUsed: 90 }
                    ],
                    lastUpdated: 'saved query time'
                }
            }
        },
        {
            name: 'Zhipu preserves negative account balances without quotas',
            summary: '¥-1.25',
            cells: ['¥-1.25', '¥2.00'],
            snapshot: {
                version: 1,
                provider: 'zhipu',
                queriedAt,
                context: snapshotContext,
                data: { limits: [], account: { balance: -1.25, rechargeAmount: 2 } }
            }
        },
        {
            name: 'Compatible preserves multiple units and treats provider names as text',
            snapshot: compatibleSnapshot,
            summary: '¥0.00 $3.00',
            cells: ['<img src=x onerror=alert(1)> / Wallet', '$3.00', '¥0.00']
        }
    ];
    for (const fixture of fixtures) {
        await context.test(fixture.name, subtest => {
            const previousLanguage = documentStub.documentElement.lang;
            subtest.after(() => {
                documentStub.documentElement.lang = previousLanguage;
            });
            documentStub.documentElement.lang = fixture.language ?? 'en';
            subtest.mock.method(Date, 'now', () => Date.parse('2030-01-01T00:00:00Z'));
            const providerModel = render({
                balance: { queriedAt, entries: [], statusSnapshots: [fixture.snapshot] }
            }).providerModel;
            assert.equal(providerModel.querySelector('.request-balance-summary')?.textContent, fixture.summary);
            const tooltip = providerModel.querySelector('.request-balance-tooltip')!;
            assert.equal(tooltip.querySelector('.request-balance-title'), null);
            assert.equal(tooltip.children[0].firstChild?.tagName, 'table');
            const collect = (node: TestElement): string[] => [node.textContent, ...node.children.flatMap(collect)];
            const text = collect(tooltip);
            for (const cell of fixture.cells) {
                assert.ok(text.includes(cell), `Missing saved cell: ${cell}`);
            }
            assert.equal(tooltip.querySelector('img'), null);
            assert.equal(tooltip.querySelector('a'), null);
            if (fixture.snapshot.provider === 'compatible') {
                const localClock = new Intl.DateTimeFormat('en', {
                    hour: '2-digit',
                    minute: '2-digit',
                    second: '2-digit',
                    hourCycle: 'h23'
                }).format(queriedAt);
                assert.ok(tooltip.querySelector('.request-balance-updated')!.textContent.includes(localClock));
            }
        });
    }

    for (const fixture of fixtures) {
        for (const language of ['en', 'zh-cn']) {
            await context.test(`${fixture.name} ignores legacy presentation metadata in ${language}`, subtest => {
                const previousLanguage = documentStub.documentElement.lang;
                subtest.after(() => {
                    documentStub.documentElement.lang = previousLanguage;
                });
                documentStub.documentElement.lang = language;
                const snapshot = structuredClone(fixture.snapshot);
                const collect = (node: TestElement): string[] => [node.textContent, ...node.children.flatMap(collect)];
                const full = render({
                    balance: { queriedAt, entries: [], statusSnapshots: [snapshot] }
                }).providerModel.querySelector('.request-balance-tooltip')!;
                const expected = collect(full);
                Reflect.deleteProperty(snapshot, 'context');
                if (snapshot.provider === 'commandcode') {
                    for (const window of [snapshot.data.fiveHour, snapshot.data.weekly]) {
                        if (window) {
                            Reflect.deleteProperty(window, 'exceeded');
                        }
                    }
                } else if (snapshot.provider === 'kimi') {
                    for (const detail of [
                        snapshot.data.summary,
                        ...snapshot.data.windows.map(window => window.detail)
                    ]) {
                        Reflect.deleteProperty(detail, 'limit');
                        Reflect.deleteProperty(detail, 'used');
                    }
                } else if (snapshot.provider === 'opencode') {
                    for (const window of snapshot.data.windows) {
                        Reflect.deleteProperty(window, 'status');
                    }
                } else if (snapshot.provider === 'codex') {
                    Reflect.deleteProperty(snapshot.data, 'codeReviewUsedPercent');
                    Reflect.deleteProperty(snapshot.data.rateLimit, 'allowed');
                    Reflect.deleteProperty(snapshot.data.rateLimit, 'limit_reached');
                    for (const window of [
                        snapshot.data.rateLimit.primary_window,
                        snapshot.data.rateLimit.secondary_window
                    ]) {
                        if (window) {
                            Reflect.deleteProperty(window, 'reset_after_seconds');
                        }
                    }
                } else if (snapshot.provider === 'grok') {
                    Reflect.deleteProperty(snapshot.data.usage, 'usedPercent');
                    Reflect.deleteProperty(snapshot.data.usage, 'windowMinutes');
                }
                const balance: RequestBalanceLog = { queriedAt, entries: [], statusSnapshots: [snapshot] };
                const fresh = render({ balance }).providerModel.querySelector('.request-balance-tooltip')!;
                assert.ok(fresh);
                assert.equal(/[\u4e00-\u9fff]/u.test(fresh.querySelector('th')!.textContent), language === 'zh-cn');
                assert.deepEqual(collect(fresh), expected);
                Reflect.set(snapshot, 'context', {
                    icon: 'old-icon',
                    title: 'old localized title',
                    language: language === 'en' ? 'zh-cn' : 'en',
                    locale: 'invalid_locale',
                    timeZone: 'invalid/timezone'
                });
                if (snapshot.provider === 'minimax-token') {
                    for (const limit of snapshot.data.limits) {
                        limit.label = 'old localized window label';
                    }
                }
                const legacy = render({ balance }).providerModel.querySelector('.request-balance-tooltip')!;
                assert.deepEqual(collect(legacy), expected);
                assert.equal(collect(legacy).includes('old localized title'), false);
            });
        }
    }

    for (const scenario of ['legacy', 'unknown-version', 'broken-data', 'malformed-items'] as const) {
        await context.test(`${scenario} falls back to recorded balances without breaking the row`, () => {
            const snapshot = structuredClone(compatibleSnapshot);
            if (scenario === 'unknown-version') {
                Reflect.set(snapshot, 'version', 2);
            }
            if (scenario === 'broken-data') {
                Reflect.set(snapshot, 'data', null);
            }
            const balance: RequestBalanceLog = {
                queriedAt,
                entries: [{ id: 'custom', balance: 0, currency: 'USD' }],
                statusSnapshots: scenario === 'legacy' || scenario === 'malformed-items' ? undefined : [snapshot]
            };
            if (scenario === 'malformed-items') {
                Reflect.set(balance.entries[0], 'items', [null, { balance: 0, currency: 'USD' }]);
            }
            const providerModel = render({ balance }).providerModel;
            assert.equal(providerModel.querySelector('.request-balance-summary')?.textContent, '$0.00');
            const tooltip = providerModel.querySelector('.request-balance-tooltip')!;
            assert.equal(tooltip.querySelector('.request-balance-title'), null);
            assert.equal(tooltip.children[0].firstChild?.tagName, 'table');
        });
    }

    await context.test('saved compatible snapshots replace matching normalized entries and keep other entries', () => {
        const providerModel = render({
            balance: {
                queriedAt,
                entries: [
                    { id: 'custom', balance: 3, currency: 'USD' },
                    { id: 'other', balance: 5, currency: 'CNY' }
                ],
                statusSnapshots: [compatibleSnapshot]
            }
        }).providerModel;
        assert.equal(providerModel.querySelector('.request-balance-summary')?.textContent, '¥0.00 $3.00 ¥5.00');
    });

    await context.test('compatible usages join sorted summaries and share one detailed result table', subtest => {
        const previousLanguage = documentStub.documentElement.lang;
        subtest.after(() => {
            documentStub.documentElement.lang = previousLanguage;
        });
        documentStub.documentElement.lang = 'en';
        const wallet: RequestStatusSnapshot = {
            ...compatibleSnapshot,
            data: { ...compatibleSnapshot.data, providerId: 'custom::z-wallet', providerName: 'Wallet query' }
        };
        const tokens: RequestStatusSnapshot = {
            ...compatibleSnapshot,
            queriedAt: queriedAt - 1000,
            data: {
                providerId: 'custom::a-tokens',
                providerName: 'Token query',
                queryScope: 'provider',
                balanceInfo: { balance: 120, currency: 'Tokens' },
                lastUpdated: '2026-10-20T23:59:59Z'
            }
        };
        const providerModel = render({
            balance: { queriedAt, entries: [], statusSnapshots: [wallet, tokens] }
        }).providerModel;
        assert.equal(providerModel.querySelector('.request-balance-summary')?.textContent, '120 Tokens ¥0.00 $3.00');
        const tooltip = providerModel.querySelector('.request-balance-tooltip')!;
        const descendants = (node: TestElement): TestElement[] =>
            node.children.flatMap(child => [child, ...descendants(child)]);
        const nodes = descendants(tooltip);
        const tables = nodes.filter(node => node.classList.contains('request-balance-table'));
        assert.equal(tables.length, 1);
        assert.deepEqual(
            descendants(tables[0])
                .filter(node => node.tagName === 'th')
                .map(cell => cell.textContent),
            ['Provider', 'Paid Balance', 'Granted', 'Available']
        );
        assert.deepEqual(
            descendants(tables[0])
                .filter(node => node.tagName === 'td')
                .slice(0, 4)
                .map(cell => cell.querySelector('.request-balance-provider')?.textContent ?? cell.textContent),
            ['Token query', '-', '-', '120 Tokens']
        );
        const times = nodes
            .filter(node => node.classList.contains('request-balance-row-updated'))
            .map(cell => cell.textContent);
        assert.equal(times.length, 3);
        assert.match(times[0], /07:59:59/);
        assert.match(times[1], /08:00:00/);
        assert.equal(times[1], times[2]);
        assert.equal(tooltip.querySelector('.request-balance-detail'), null);
    });

    for (const language of ['en', 'zh-CN']) {
        for (const sameTime of [false, true]) {
            await context.test(`compatible update times stay compact: ${language}, shared=${sameTime}`, subtest => {
                const previousLanguage = documentStub.documentElement.lang;
                subtest.after(() => {
                    documentStub.documentElement.lang = previousLanguage;
                });
                documentStub.documentElement.lang = language;
                const subscription: RequestStatusSnapshot = {
                    ...compatibleSnapshot,
                    data: {
                        providerId: 'botcf::a-subscription',
                        providerName: 'BotCF / Subscription',
                        balanceInfo: {
                            balance: 27.45,
                            currency: 'USD',
                            items: [{ balance: 27.45, currency: 'USD', displayName: '#317' }]
                        }
                    }
                };
                const wallet: RequestStatusSnapshot = {
                    ...compatibleSnapshot,
                    queriedAt: sameTime ? queriedAt : queriedAt - 1000,
                    data: {
                        providerId: 'botcf::z-wallet',
                        providerName: 'BotCF / <Wallet>',
                        balanceInfo: { balance: 575.03, currency: 'CNY' }
                    }
                };
                const { providerModel } = render({
                    balance: { queriedAt, entries: [], statusSnapshots: [wallet, subscription] }
                });
                const tooltip = providerModel.querySelector('.request-balance-tooltip')!;
                const descendants = (node: TestElement): TestElement[] =>
                    node.children.flatMap(child => [child, ...descendants(child)]);
                const nodes = descendants(tooltip);
                const times = nodes.filter(node => node.classList.contains('request-balance-row-updated'));
                const footers = nodes.filter(node => node.classList.contains('request-balance-updated'));
                assert.equal(tooltip.querySelector('.request-balance-title'), null);
                assert.equal(tooltip.children[0].firstChild?.tagName, 'table');
                assert.equal(providerModel.querySelector('.request-balance-summary')?.textContent, '$27.45 ¥575.03');
                assert.equal(nodes.filter(node => node.tagName === 'table').length, 1);
                assert.equal(tooltip.querySelector('.request-balance-detail'), null);
                assert.equal(times.length, sameTime ? 0 : 2);
                assert.equal(footers.length, sameTime ? 1 : 0);
                const expectedTime = (timestamp: number) =>
                    new Intl.DateTimeFormat(language, {
                        year: 'numeric',
                        month: '2-digit',
                        day: '2-digit',
                        hour: '2-digit',
                        minute: '2-digit',
                        second: '2-digit',
                        hourCycle: 'h23'
                    }).format(timestamp);
                const label = language === 'en' ? 'Last updated' : '最后更新';
                if (sameTime) {
                    assert.equal(footers[0].textContent, `${label}: ${expectedTime(queriedAt)}`);
                } else {
                    assert.deepEqual(
                        times.map(time => time.textContent),
                        [`${label}: ${expectedTime(queriedAt)}`, `${label}: ${expectedTime(queriedAt - 1000)}`]
                    );
                    const providerCells = nodes.filter(node => node.tagName === 'td' && node.children.length > 0);
                    assert.deepEqual(
                        providerCells.map(cell => cell.querySelector('.request-balance-provider')?.textContent),
                        ['BotCF / Subscription / #317', 'BotCF / <Wallet>']
                    );
                    assert.ok(providerCells.every(cell => cell.querySelector('.request-balance-row-updated')));
                }
            });
        }
    }

    await context.test('empty saved balances do not create an empty control', () => {
        assert.equal(
            render({ balance: { queriedAt, entries: [] } }).providerModel.querySelector('.prov-model-balance'),
            null
        );
    });

    for (const [requestKind, cssClass, label] of [
        ['subagent', 'request-kind-subagent', '子代理'],
        ['unclassified', 'request-kind-unclassified', '未分类请求'],
        ['background', 'request-kind-unclassified', '未分类请求']
    ] as const) {
        await context.test(`${requestKind} renders only its target kind without origin or role details`, () => {
            documentStub.documentElement.lang = 'zh-CN';
            const record = UsageParser.extendLog({
                requestId: 'classification-ui',
                timestamp: 1000,
                isoTime: new Date(1000).toISOString(),
                providerKey: 'test',
                providerName: 'Test',
                modelId: 'model',
                modelName: 'Model',
                estimatedInput: 10,
                status: 'completed',
                rawUsage: { prompt_tokens: 10, completion_tokens: 5 },
                requestKind,
                requestInitiator: 'core',
                requestClassification: {
                    version: 1,
                    requestOrigin: 'copilot-sdk',
                    agentRole: 'subagent',
                    evidence: {
                        origin: { level: 'signature', ruleId: 'hidden-origin-rule' },
                        purpose: { level: 'unknown', reasonCode: 'hidden-purpose-reason' },
                        role: { level: 'contract', ruleId: 'hidden-role-rule' }
                    }
                }
            });
            const table = createRequestRecordsTable(
                [record],
                summarizeSessionRecords([record]),
                buildRequestTotals([record]),
                new Set()
            ) as unknown as TestElement;
            const time = table.querySelector('tbody')!.children[0].children[0];
            assert.ok(time.innerHTML.includes(cssClass));
            assert.ok(time.innerHTML.includes(label));
            assert.equal(time.title, label);
            const rendered = JSON.stringify(table, (key, value: unknown) =>
                key === 'parentElement' ? undefined : value
            );
            assert.doesNotMatch(
                rendered,
                /copilot-sdk|copilot-chat|hidden-origin-rule|hidden-purpose-reason|hidden-role-rule|SDK|Chat badge/
            );
        });
    }

    await context.test('unknown future request kind is text rather than executable HTML', () => {
        const requestKind = '<img src=x onerror="attack()">&future';
        const record = UsageParser.extendLog({
            requestId: 'future-ui',
            timestamp: 1000,
            isoTime: new Date(1000).toISOString(),
            providerKey: 'test',
            providerName: 'Test',
            modelId: 'model',
            modelName: 'Model',
            estimatedInput: 10,
            status: 'completed',
            rawUsage: null,
            requestKind
        });
        const table = createRequestRecordsTable(
            [record],
            summarizeSessionRecords([record]),
            buildRequestTotals([record]),
            new Set()
        ) as unknown as TestElement;
        const time = table.querySelector('tbody')!.children[0].children[0];
        assert.equal(time.title, requestKind);
        assert.doesNotMatch(time.innerHTML, /<img|<script/);
        assert.ok(time.innerHTML.includes('&lt;img'));
        assert.ok(time.innerHTML.includes('&amp;future'));
        assert.ok(time.innerHTML.includes('request-kind-unknown'));
    });

    for (const lang of ['zh-CN', 'en']) {
        await context.test(`static and total output labels match their values in ${lang}`, () => {
            documentStub.documentElement.lang = lang;
            const { header, output, total } = render();
            assert.equal(
                header,
                lang === 'zh-CN' ?
                    '<span>输出耗时</span><span>输出速度</span>'
                :   '<span>Duration</span><span>Output</span>'
            );
            for (const html of [output, total]) {
                assert.match(html, /class="output-duration"[^>]*>4\.9s</);
                assert.match(html, /class="output-speed"[^>]*>4\.3 t\/s</);
                assert.doesNotMatch(html, /TPOT|ms\/token|≈|legacy|approximation|稳健均值/);
            }
            assert.match(output, /title="Output duration: 4\.9s"/);
            assert.match(output, /title="Average speed: 4\.3 t\/s"/);
            assert.doesNotMatch(total, /title=/);
        });
    }

    await context.test('average speed includes all output tokens in the stream window', () => {
        const { output, total } = render({
            rawUsage: { promptTokenCount: 10, candidatesTokenCount: 11, thoughtsTokenCount: 20, totalTokenCount: 41 }
        });
        for (const html of [output, total]) {
            assert.match(html, /class="output-duration"[^>]*>4\.9s</);
            assert.match(html, /class="output-speed"[^>]*>6\.3 t\/s</);
        }
        assert.doesNotMatch(output, /reasoning|thinking|protocol|window/);
    });

    await context.test('legacy timings display plain values without approximation symbols or explanations', () => {
        const { output, total } = render();
        for (const html of [output, total]) {
            assert.match(html, /class="output-duration"[^>]*>4\.9s</);
            assert.doesNotMatch(html, /≈|legacy|approximation|protocol|稳健均值/);
        }
        assert.match(output, /class="output-ttft"[^>]*>100ms</);
        assert.match(output, /class="output-speed"[^>]*>4\.3 t\/s</);
        assert.doesNotMatch(total, /title=/);
    });

    await context.test('zero and short stream spans use stream timing', () => {
        for (const duration of [0, 14]) {
            const { output, total } = render({ streamEndTime: 1100 + duration });
            const expectedSpeed = duration === 0 ? '-' : '1500.0';
            const expectedDuration = duration === 0 ? '0ms' : '14ms';
            for (const html of [output, total]) {
                assert.match(html, new RegExp(`class="output-duration"[^>]*>${expectedDuration}<`));
                assert.match(
                    html,
                    duration === 0 ? /class="output-speed"[^>]*>-</ : (
                        new RegExp(`class="output-speed"[^>]*>${expectedSpeed} t/s<`)
                    )
                );
            }
        }
    });

    for (const duration of [1, 3, 14]) {
        await context.test(`static and total rows display single-token speed for a ${duration}ms response`, () => {
            const { output, total } = render({
                streamEndTime: 1100 + duration,
                rawUsage: { prompt_tokens: 10, completion_tokens: 1, total_tokens: 11 }
            });
            const speed = `${(1000 / duration).toFixed(1)} t/s`;
            for (const html of [output, total]) {
                assert.match(html, new RegExp(`class="output-duration"[^>]*>${duration}ms<`));
                assert.ok(html.includes(`>${speed}<`));
                assert.doesNotMatch(html, /≈|100ms可靠|reliable window/);
            }
        });
    }

    await context.test('incomplete, reversed or non-finite stream timestamps do not produce timing', () => {
        for (const timestamps of [
            { streamStartTime: undefined, streamEndTime: undefined },
            { streamStartTime: 2000, streamEndTime: 1000 },
            { streamStartTime: Number.NaN, streamEndTime: 6000 },
            { streamStartTime: 1100, streamEndTime: Number.POSITIVE_INFINITY }
        ]) {
            const { output, total } = render(timestamps);
            for (const html of [output, total]) {
                assert.match(html, /class="output-duration"[^>]*>-</);
                assert.match(html, /class="output-speed"[^>]*>-</);
            }
        }
    });

    await context.test('pending protocol events do not present completed output duration or TTFT', () => {
        const { output } = render({
            status: 'estimated',
            rawUsage: null,
            streamStartTime: undefined,
            streamEndTime: undefined
        });
        assert.match(output, /class="output-ttft"[^>]*>-</);
        assert.match(output, /class="output-duration"[^>]*>-</);
    });
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
