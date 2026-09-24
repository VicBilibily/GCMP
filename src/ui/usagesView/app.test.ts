import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import test from 'node:test';
import { buildNativeCostSplitIndex, buildRequestTotals, summarizeSessionRecords } from './aggregation';
import type { HostMessage, UpdateDateDetailsMessage, WebViewMessage } from './types';

const require = createRequire(import.meta.url);
const NodeModule = require('node:module') as {
    prototype: { require: (id: string) => unknown };
};

class TestElement {
    id = '';
    className = '';
    textContent = '';
    onclick: (() => void) | null = null;
    children: TestElement[] = [];
    parentElement: TestElement | null = null;
    private html = '';
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

    querySelector(selector: string): TestElement | null {
        for (const child of this.children) {
            const matches =
                selector.startsWith('#') ? child.id === selector.slice(1)
                : selector.startsWith('.') ? child.classList.contains(selector.slice(1))
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
                    fetchDetailByCurrentView() {},
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
        const sendSummary = (date: string): void => {
            const message: UpdateDateDetailsMessage = {
                command: 'updateDateDetails',
                date,
                isToday: date === today,
                isExtensionHostDebugMode: false,
                providers: [],
                hourlyStats: {},
                allSummary: summarizeSessionRecords([]),
                allTotals: buildRequestTotals([]),
                nativeSplitIndex: buildNativeCostSplitIndex([]),
                sessionGroups: [],
                updateSeq: 1
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
        usagesState: { dateDetails: null, selectedSessionId: null, selectedSessionIds: [] },
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
