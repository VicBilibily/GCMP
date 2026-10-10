import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { runInNewContext } from 'node:vm';
import { transformSync } from 'esbuild';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const noop = (): void => {};
const tick = () => new Promise<void>(resolve => setImmediate(resolve));
interface Token {
    isCancellationRequested: boolean;
    onCancellationRequested(listener: () => void): { dispose(): void };
}
class Emitter {
    readonly listeners = new Set<() => void>();
    readonly event = (listener: () => void) => {
        this.listeners.add(listener);
        return { dispose: () => this.listeners.delete(listener) };
    };
    fire(): void {
        for (const listener of [...this.listeners]) {
            listener();
        }
    }
    dispose(): void {
        this.listeners.clear();
    }
}
class TokenSource {
    readonly emitter = new Emitter();
    readonly token: Token = { isCancellationRequested: false, onCancellationRequested: this.emitter.event };
    disposed = false;
    cancel(): void {
        if (this.token.isCancellationRequested) {
            return;
        }
        this.token.isCancellationRequested = true;
        this.emitter.fire();
    }
    dispose(): void {
        this.disposed = true;
        this.emitter.dispose();
    }
}
class Breaker {
    failures = 0;
    successes = 0;
    cancellations = 0;
    allowRequest(): boolean {
        return true;
    }
    recordFailure(): void {
        this.failures++;
    }
    recordSuccess(): void {
        this.successes++;
    }
    recordCancellation(): void {
        this.cancellations++;
    }
}
interface Document {
    fileName: string;
    uri: { toString(): string };
    languageId: string;
    version: number;
    getText(): string;
    lineAt(line: number): { text: string };
    positionAt(offset: number): { line: number; character: number };
}
interface Engine {
    provideInlineCompletionItems(
        document: Document,
        position: { line: number; character: number },
        context: { triggerKind: number },
        token: Token
    ): Promise<unknown>;
    activate(): void;
    dispose(): void;
    onDidChange: Emitter['event'];
}
interface Heavy extends Engine {
    _fimProvider: {
        getInlineCompletions(document: unknown, position: unknown, token: Token): Promise<unknown>;
        dispose(): void;
    };
    _nesProvider: { getNextEdit(uri: object, token: Token): Promise<unknown>; handleShown(): void; dispose(): void };
    nesWorkspaceAdapter: { syncDocument(document: Document): void };
    fimCircuitBreaker: Breaker;
    nesCircuitBreaker: Breaker;
}
interface Shim extends Engine {
    _realProvider: Engine | null;
    _loadingPromise: Promise<Engine | null> | null;
}
function deferred<T>() {
    let resolve!: (value: T) => void;
    let reject!: (error: Error) => void;
    const promise = new Promise<T>((ok, fail) => {
        resolve = ok;
        reject = fail;
    });
    return { promise, resolve, reject };
}
type Mode = 'manual NES' | 'automatic NES' | 'automatic FIM' | 'automatic NES with FIM fallback';
function fixture(mode: Mode, layer: 'provider' | 'shim') {
    const timers = new Map<number, { callback(): void; ms: number }>();
    const sources: TokenSource[] = [];
    const logs: string[] = [];
    const logger = {
        disposed: false,
        closedWrites: 0,
        trace: write,
        debug: write,
        info: write,
        warn: write,
        error: write,
        dispose() {
            this.disposed = true;
        }
    };
    function write(message: string): void {
        if (logger.disposed) {
            logger.closedWrites++;
            throw new Error('Channel has been closed');
        }
        logs.push(message);
    }
    let nextTimer = 0;
    let fimStarts = 0;
    let nesStarts = 0;
    let shown = 0;
    let upstreamDisposals = 0;
    let stopped = false;
    let captured: Token | undefined;
    const operation = deferred<unknown>();
    const document: Document = {
        fileName: 'lifecycle.ts',
        uri: { toString: () => 'file:///lifecycle.ts' },
        languageId: 'typescript',
        version: 1,
        getText: () => 'const value = 1;',
        lineAt: () => ({ text: 'const value = 1;' }),
        positionAt: offset => ({ line: 0, character: offset })
    };
    const config = { enabled: true, debounceMs: 500, timeoutMs: 5000, manualOnly: false };
    const fimEnabled = mode.includes('FIM');
    const nesEnabled = mode !== 'automatic FIM';
    const sdk = {
        EventEmitter: Emitter,
        CancellationTokenSource: class extends TokenSource {
            constructor() {
                super();
                sources.push(this);
            }
        },
        InlineCompletionTriggerKind: { Invoke: 0, Automatic: 1 },
        InlineCompletionItem: class {
            constructor(
                readonly insertText: string,
                readonly range: object
            ) {}
        },
        InlineCompletionList: class {
            constructor(readonly items: object[]) {}
        },
        Range: class {
            readonly start: { line: number; character: number };
            readonly end: { line: number; character: number };
            constructor(
                start: number | { line: number; character: number },
                end: number | { line: number; character: number },
                endLine = 0,
                endCharacter = 0
            ) {
                this.start = typeof start === 'number' ? { line: start, character: end as number } : start;
                this.end = typeof end === 'number' ? { line: endLine, character: endCharacter } : end;
            }
        },
        window: { activeTextEditor: { document } },
        workspace: {
            getConfiguration: (section: string) => ({
                get: (_key: string, fallback: unknown) =>
                    section === 'gcmp.fimCompletion' ? fimEnabled
                    : section === 'gcmp.nesCompletion' ? nesEnabled
                    : fallback
            })
        }
    };
    function load<T>(filename: string): T {
        const module = { exports: {} };
        runInNewContext(
            transformSync(readFileSync(resolve(root, filename), 'utf8'), {
                loader: 'ts',
                format: 'cjs',
                target: 'es2022'
            }).code,
            {
                module,
                exports: module.exports,
                Error,
                setTimeout: (callback: () => void, ms: number) => {
                    const id = ++nextTimer;
                    timers.set(id, { callback, ms });
                    return id;
                },
                clearTimeout: (id: number) => timers.delete(id),
                require: (id: string) => {
                    if (id === 'vscode') {
                        return sdk;
                    }
                    if (id === '../gcmpServices') {
                        return { completionLogger: logger, isGcmpServicesAvailable: () => true };
                    }
                    if (id === '../utils/completionConfig') {
                        return {
                            getFIMConfig: () => ({ ...config, enabled: fimEnabled }),
                            getNESConfig: () => ({ ...config, enabled: nesEnabled })
                        };
                    }
                    if (id === './completionCircuitBreaker') {
                        return { CompletionCircuitBreaker: Breaker };
                    }
                    if (id === '../utils/cancellationError') {
                        return {
                            isCancellationError: (error: unknown) =>
                                error instanceof Error && error.name === 'CancellationError'
                        };
                    }
                    if (id.endsWith('/textDocument')) {
                        return { CopilotTextDocument: { create: () => ({}) } };
                    }
                    if (id === '../utils/l10n') {
                        return { t: (text: string) => text };
                    }
                    return {};
                }
            }
        );
        return module.exports as T;
    }
    const context = { subscriptions: [] };
    const heavy = new (load<{ InlineCompletionProvider: new (context: object) => Heavy }>(
        'copilot/completionProvider.ts'
    ).InlineCompletionProvider)(context);
    heavy._fimProvider = {
        getInlineCompletions: (_document, _position, token) => {
            fimStarts++;
            captured = token;
            return operation.promise;
        },
        dispose: () => {
            upstreamDisposals++;
        }
    };
    heavy._nesProvider = {
        getNextEdit: (_uri, token) => {
            nesStarts++;
            captured = token;
            return operation.promise;
        },
        handleShown: () => {
            shown++;
        },
        dispose: () => {
            upstreamDisposals++;
        }
    };
    heavy.nesWorkspaceAdapter = { syncDocument: noop };
    const shim = new (load<{ InlineCompletionShim: new (context: object) => Shim }>(
        'copilot/inlineCompletionShim.ts'
    ).InlineCompletionShim)(context);
    shim._realProvider = heavy;
    const target = layer === 'shim' ? shim : heavy;
    const core = new TokenSource();
    const invoke = () =>
        target.provideInlineCompletionItems(
            document,
            { line: 0, character: 0 },
            { triggerKind: mode === 'manual NES' ? 0 : 1 },
            core.token
        );
    async function start() {
        const observed = invoke().then(
            value => ({ value, error: null }),
            (error: unknown) => ({ value: undefined, error })
        );
        await tick();
        if (mode !== 'manual NES') {
            const entry = [...timers].find(([, timer]) => timer.ms === 500);
            assert.ok(entry, 'Automatic request must reach the real debounce callback');
            timers.delete(entry[0]);
            entry[1].callback();
        }
        assert.ok(captured, 'Request must reach the deferred upstream boundary');
        return { observed };
    }
    function stop(): void {
        if (stopped) {
            return;
        }
        stopped = true;
        target.dispose();
        logger.dispose();
    }
    const edit =
        mode === 'automatic FIM' ?
            [{ insertText: 'value', range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } } }]
        :   { result: { newText: 'value', range: { start: 0, endExclusive: 1 } } };
    return {
        heavy,
        shim,
        target,
        core,
        sources,
        timers,
        logs,
        logger,
        operation,
        start,
        invoke,
        stop,
        edit,
        get captured() {
            return captured;
        },
        get fimStarts() {
            return fimStarts;
        },
        get nesStarts() {
            return nesStarts;
        },
        get shown() {
            return shown;
        },
        get upstreamDisposals() {
            return upstreamDisposals;
        },
        cleanup() {
            operation.resolve(undefined);
            core.dispose();
            stop();
        }
    };
}
const modes: Mode[] = ['manual NES', 'automatic NES', 'automatic FIM', 'automatic NES with FIM fallback'];
for (const mode of modes) {
    for (const layer of ['provider', 'shim'] as const) {
        for (const result of ['empty', 'edit', 'error'] as const) {
            test(`${layer}: ${mode} discards late ${result} without logging, showing edits or starting fallback after disposal`, async () => {
                const f = fixture(mode, layer);
                const { observed } = await f.start();
                try {
                    f.stop();
                    const count = f.logs.length;
                    if (result === 'error') {
                        f.operation.reject(new Error('late upstream failure'));
                    } else {
                        f.operation.resolve(result === 'edit' ? f.edit : undefined);
                    }
                    const outcome = await observed;
                    await tick();
                    assert.equal(outcome.error, null);
                    assert.equal(outcome.value, undefined);
                    assert.equal(f.logger.closedWrites, 0);
                    assert.equal(f.logs.length, count);
                    assert.equal(f.shown, 0);
                    assert.equal(f.captured?.isCancellationRequested, true);
                    assert.equal(f.timers.size, 0);
                    assert.ok(f.sources.every(source => source.disposed));
                    assert.equal(f.core.emitter.listeners.size, 0);
                    assert.equal(f.heavy.fimCircuitBreaker.failures + f.heavy.nesCircuitBreaker.failures, 0);
                    if (mode === 'automatic NES with FIM fallback') {
                        assert.equal(f.fimStarts, 0);
                    }
                } finally {
                    f.operation.resolve(undefined);
                    await observed;
                    f.cleanup();
                }
            });
        }
        test(`${layer}: ${mode} still delivers a live edit and releases its cancellation resources`, async () => {
            const f = fixture(mode, layer);
            const { observed } = await f.start();
            try {
                f.operation.resolve(f.edit);
                const outcome = await observed;
                await tick();
                assert.equal(outcome.error, null);
                assert.ok(outcome.value && typeof outcome.value === 'object' && 'items' in outcome.value);
                assert.equal((outcome.value.items as object[]).length, 1);
                assert.equal(f.captured?.isCancellationRequested, false);
                assert.ok(f.sources.every(source => source.disposed));
                assert.equal(f.core.emitter.listeners.size, 0);
                assert.equal(f.timers.size, 0);
                assert.equal(f.heavy.fimCircuitBreaker.successes + f.heavy.nesCircuitBreaker.successes, 1);
                assert.equal(f.logger.closedWrites, 0);
            } finally {
                f.operation.resolve(undefined);
                await observed;
                f.cleanup();
            }
        });
    }
    test(`${mode} disposal settles promptly even if upstream ignores cancellation`, async () => {
        const f = fixture(mode, 'provider');
        const { observed } = await f.start();
        let settled = false;
        void observed.then(() => {
            settled = true;
        });
        try {
            f.stop();
            await tick();
            await tick();
            assert.equal(settled, true, 'Disposal must not wait for the upstream response or request deadline');
            assert.equal(f.timers.size, 0);
            assert.equal(f.captured?.isCancellationRequested, true);
            assert.equal(f.logger.closedWrites, 0);
        } finally {
            f.operation.resolve(undefined);
            await observed;
            f.cleanup();
        }
    });
}
for (const layer of ['provider', 'shim'] as const) {
    test(`${layer}: externally cancelled manual NES remains safe when its empty response arrives after disposal`, async () => {
        const f = fixture('manual NES', layer);
        const { observed } = await f.start();
        try {
            f.core.cancel();
            f.stop();
            f.operation.resolve(undefined);
            const outcome = await observed;
            assert.equal(outcome.error, null);
            assert.equal(outcome.value, undefined);
            assert.equal(f.logger.closedWrites, 0);
        } finally {
            f.operation.resolve(undefined);
            await observed;
            f.cleanup();
        }
    });
    test(`${layer}: disposed entry rejects new requests without reviving a provider or writing logs`, async () => {
        const f = fixture('manual NES', layer);
        try {
            f.stop();
            assert.equal(await f.invoke(), undefined);
            assert.equal(f.fimStarts + f.nesStarts, 0);
            assert.equal(f.logger.closedWrites, 0);
        } finally {
            f.cleanup();
        }
    });
    test(`${layer}: repeated disposal is safe after the native logger closes`, () => {
        const f = fixture('manual NES', layer);
        try {
            f.stop();
            assert.doesNotThrow(() => f.target.dispose());
            assert.equal(f.upstreamDisposals, 2);
            assert.equal(f.logger.closedWrites, 0);
        } finally {
            f.cleanup();
        }
    });
}
for (const result of ['edit', 'error'] as const) {
    test(`shim discards a delegated late ${result} even if the loaded provider ignores disposal`, async () => {
        const f = fixture('manual NES', 'shim');
        const operation = deferred<unknown>();
        let began = false;
        f.shim._realProvider = {
            activate: noop,
            dispose: noop,
            onDidChange: new Emitter().event,
            provideInlineCompletionItems: () => {
                began = true;
                return operation.promise;
            }
        };
        const observed = f.invoke().then(
            value => ({ value, error: null }),
            (error: unknown) => ({ value: undefined, error })
        );
        try {
            await tick();
            assert.equal(began, true);
            f.heavy.dispose();
            f.stop();
            if (result === 'error') {
                operation.reject(new Error('late delegated failure'));
            } else {
                operation.resolve({ items: [{ insertText: 'late edit' }] });
            }
            const outcome = await observed;
            assert.equal(outcome.error, null);
            assert.equal(outcome.value, undefined);
            assert.equal(f.logger.closedWrites, 0);
        } finally {
            operation.resolve(undefined);
            await observed;
            f.cleanup();
        }
    });
}
test('shim disposed while awaiting a loaded provider never dispatches the late load result', async () => {
    const f = fixture('manual NES', 'shim');
    const loading = deferred<Engine | null>();
    let dispatched = 0;
    const loaded: Engine = {
        activate: noop,
        dispose: noop,
        onDidChange: new Emitter().event,
        provideInlineCompletionItems: async () => {
            dispatched++;
            return undefined;
        }
    };
    f.shim._realProvider = null;
    f.shim._loadingPromise = loading.promise;
    const observed = f.invoke().then(
        value => ({ value, error: null }),
        (error: unknown) => ({ value: undefined, error })
    );
    try {
        await tick();
        f.heavy.dispose();
        f.stop();
        loading.resolve(loaded);
        const outcome = await observed;
        assert.equal(outcome.error, null);
        assert.equal(outcome.value, undefined);
        assert.equal(dispatched, 0);
        assert.equal(f.logger.closedWrites, 0);
    } finally {
        loading.resolve(null);
        f.operation.resolve(undefined);
        await observed;
        f.cleanup();
    }
});
