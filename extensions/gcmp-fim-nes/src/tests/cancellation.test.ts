import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { runInNewContext } from 'node:vm';
import { transformSync } from 'esbuild';

const source = readFileSync(
    resolve(dirname(fileURLToPath(import.meta.url)), '../copilot/completionProvider.ts'),
    'utf8'
);
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
    dispose(cancel = false): void {
        if (cancel) {
            this.cancel();
        }
        this.disposed = true;
        this.emitter.dispose();
    }
}
class Breaker {
    failures = 0;
    cancellations = 0;
    allowRequest(): boolean {
        return true;
    }
    recordSuccess = noop;
    recordFailure(): void {
        this.failures++;
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
}
interface Position {
    line: number;
    character: number;
}
interface Provider {
    _fimProvider: {
        getInlineCompletions(document: unknown, position: Position, token: Token): Promise<unknown>;
        dispose(): void;
    };
    _nesProvider: { getNextEdit(uri: object, token: Token): Promise<unknown>; dispose(): void };
    nesWorkspaceAdapter: { syncDocument(document: Document): void };
    fimCircuitBreaker: Breaker;
    nesCircuitBreaker: Breaker;
    provideInlineCompletionItems(
        document: Document,
        position: Position,
        context: { triggerKind: number },
        token: Token
    ): Promise<unknown>;
    _invokeFIMProvider(
        document: Document,
        position: Position,
        tokens: { completionsCts: TokenSource }
    ): Promise<unknown>;
    _invokeNESProvider(document: Document, tokens: { nesCts: TokenSource }): Promise<unknown>;
    dispose(): void;
}
function fixture(mode: 'FIM' | 'NES', cancelsOperation = true) {
    const timers = new Map<number, { callback(): void; ms: number }>();
    const sources: TokenSource[] = [];
    const cancellation = new Error('cancelled');
    let nextTimer = 1;
    const module: { exports: { InlineCompletionProvider?: new (context: object) => Provider } } = { exports: {} };
    const document: Document = {
        fileName: 'test.ts',
        uri: { toString: () => 'file:///test.ts' },
        languageId: 'typescript',
        version: 1,
        getText: () => ''
    };
    const config = { enabled: true, debounceMs: 500, timeoutMs: 5000, manualOnly: false };
    const vscode = {
        EventEmitter: Emitter,
        CancellationTokenSource: class extends TokenSource {
            constructor() {
                super();
                sources.push(this);
            }
        },
        InlineCompletionTriggerKind: { Invoke: 0, Automatic: 1 },
        window: { activeTextEditor: { document } }
    };
    runInNewContext(transformSync(source, { loader: 'ts', format: 'cjs', target: 'es2022' }).code, {
        module,
        exports: module.exports,
        Error,
        setTimeout: (callback: () => void, ms: number) => {
            const id = nextTimer++;
            timers.set(id, { callback, ms });
            return id;
        },
        clearTimeout: (id: number) => timers.delete(id),
        require: (id: string) => {
            if (id === 'vscode') {
                return vscode;
            }
            if (id === '../gcmpServices') {
                return {
                    completionLogger: { trace: noop, debug: noop, info: noop, warn: noop, error: noop }
                };
            }
            if (id === '../utils/completionConfig') {
                return {
                    getNESConfig: () => config,
                    getFIMConfig: () => ({ ...config, enabled: mode === 'FIM' })
                };
            }
            if (id === './completionCircuitBreaker') {
                return { CompletionCircuitBreaker: Breaker };
            }
            if (id === '../utils/cancellationError') {
                return { isCancellationError: (error: unknown) => error === cancellation };
            }
            if (id.endsWith('/textDocument')) {
                return { CopilotTextDocument: { create: () => ({}) } };
            }
            return {};
        }
    });
    assert.ok(module.exports.InlineCompletionProvider);
    const provider = new module.exports.InlineCompletionProvider({ subscriptions: [] });
    const core = new TokenSource();
    let resolveOperation!: (value: undefined) => void;
    let rejectOperation!: (error: Error) => void;
    let settled = false;
    let delivered = 0;
    let captured: Token | undefined;
    const operation = new Promise<undefined>((resolve, reject) => {
        resolveOperation = resolve;
        rejectOperation = reject;
    });
    const complete = () => {
        settled = true;
        resolveOperation(undefined);
    };
    const fail = (error: Error) => {
        settled = true;
        rejectOperation(error);
    };
    const register = (token: Token) => {
        captured = token;
        token.onCancellationRequested(() => {
            delivered++;
            if (cancelsOperation) {
                fail(cancellation);
            }
        });
        return operation;
    };
    provider._fimProvider = { getInlineCompletions: (_document, _position, token) => register(token), dispose: noop };
    provider._nesProvider = { getNextEdit: (_uri, token) => register(token), dispose: noop };
    provider.nesWorkspaceAdapter = { syncDocument: noop };
    const fire = (ms: number) => {
        const entry = [...timers].find(([, timer]) => timer.ms === ms);
        assert.ok(entry, `Missing ${ms}ms timer`);
        timers.delete(entry[0]);
        entry[1].callback();
    };
    const start = () =>
        mode === 'FIM' ?
            provider._invokeFIMProvider(document, { line: 0, character: 0 }, { completionsCts: core })
        :   provider._invokeNESProvider(document, { nesCts: core });
    return {
        provider,
        document,
        core,
        sources,
        timers,
        fire,
        start,
        complete,
        fail,
        breaker: mode === 'FIM' ? provider.fimCircuitBreaker : provider.nesCircuitBreaker,
        get captured() {
            return captured;
        },
        get delivered() {
            return delivered;
        },
        get settled() {
            return settled;
        }
    };
}

for (const triggerKind of [0, 1]) {
    test(`${triggerKind === 0 ? 'manual' : 'automatic'} NES forwards cancellation while the request is pending`, async () => {
        const f = fixture('NES');
        const request = f.provider.provideInlineCompletionItems(
            f.document,
            { line: 0, character: 0 },
            { triggerKind },
            f.core.token
        );
        if (triggerKind === 1) {
            f.fire(500);
        }
        try {
            assert.ok(f.captured);
            assert.equal(f.core.emitter.listeners.size, 1);
            f.core.cancel();
            assert.equal(f.delivered, 1);
            assert.equal(f.captured.isCancellationRequested, true);
            assert.equal(await request, undefined);
            await tick();
            assert.equal(f.core.emitter.listeners.size, 0);
            assert.equal(
                f.sources.every(source => source.disposed),
                true
            );
            assert.equal(f.breaker.failures, 0);
            assert.equal(f.breaker.cancellations, 1);
        } finally {
            f.complete();
            await request;
            await tick();
            f.provider.dispose();
        }
    });
}

test('manual NES retains its token until completion, then releases its cancellation listener', async () => {
    const f = fixture('NES');
    const request = f.provider.provideInlineCompletionItems(
        f.document,
        { line: 0, character: 0 },
        { triggerKind: 0 },
        f.core.token
    );
    try {
        assert.equal(f.sources.length, 1);
        assert.equal(f.sources[0].disposed, false);
        assert.equal(f.core.emitter.listeners.size, 1);
        f.complete();
        assert.equal(await request, undefined);
        assert.equal(f.sources[0].disposed, true);
        assert.equal(f.core.emitter.listeners.size, 0);
    } finally {
        f.complete();
        await request;
        f.provider.dispose();
    }
});

test('manual NES releases cancellation resources after an upstream error', async () => {
    const f = fixture('NES');
    const request = f.provider.provideInlineCompletionItems(
        f.document,
        { line: 0, character: 0 },
        { triggerKind: 0 },
        f.core.token
    );
    try {
        f.fail(new Error('upstream failed'));
        assert.equal(await request, undefined);
        assert.equal(f.core.emitter.listeners.size, 0);
        assert.equal(
            f.sources.every(source => source.disposed),
            true
        );
        assert.equal(f.breaker.failures, 1);
    } finally {
        f.complete();
        await request;
        f.provider.dispose();
    }
});

for (const mode of ['FIM', 'NES'] as const) {
    for (const cancelsOperation of [true, false]) {
        test(`${mode} timeout cancels the provider token and stays a failure (provider handles cancellation=${cancelsOperation})`, async () => {
            const f = fixture(mode, cancelsOperation);
            const request = f.start();
            try {
                assert.ok(f.captured);
                f.fire(5000);
                assert.equal(await request, undefined);
                assert.equal(f.captured.isCancellationRequested, true);
                assert.equal(f.delivered, 1);
                assert.equal(f.settled, cancelsOperation);
                assert.equal(f.breaker.failures, 1);
                assert.equal(f.breaker.cancellations, 0);
                assert.equal(f.timers.size, 0);
                f.complete();
                await tick();
                assert.equal(f.breaker.failures, 1);
            } finally {
                f.complete();
                await request;
                f.core.dispose();
                f.provider.dispose();
            }
        });
    }
    test(`${mode} normal completion clears its deadline without cancelling the provider`, async () => {
        const f = fixture(mode);
        const request = f.start();
        try {
            f.complete();
            assert.equal(await request, undefined);
            assert.equal(f.core.token.isCancellationRequested, false);
            assert.equal(f.delivered, 0);
            assert.equal(f.timers.size, 0);
        } finally {
            f.complete();
            await request;
            f.core.dispose();
            f.provider.dispose();
        }
    });
    test(`${mode} non-timeout errors keep the original failure classification`, async () => {
        const f = fixture(mode);
        const request = f.start();
        try {
            f.fail(new Error('upstream failed'));
            assert.equal(await request, undefined);
            assert.equal(f.core.token.isCancellationRequested, false);
            assert.equal(f.breaker.failures, 1);
            assert.equal(f.breaker.cancellations, 0);
            assert.equal(f.timers.size, 0);
        } finally {
            f.complete();
            await request;
            f.core.dispose();
            f.provider.dispose();
        }
    });
    test(`${mode} user cancellation is not counted as timeout failure`, async () => {
        const f = fixture(mode);
        const request = f.start();
        try {
            f.core.cancel();
            assert.equal(await request, undefined);
            assert.equal(f.delivered, 1);
            assert.equal(f.breaker.failures, 0);
            assert.equal(f.breaker.cancellations, 1);
            assert.equal(f.timers.size, 0);
        } finally {
            f.complete();
            await request;
            f.core.dispose();
            f.provider.dispose();
        }
    });
}
