import assert from 'node:assert/strict';
import test from 'node:test';
import { RequestDiagnostics, type RequestDiagnosticEntry } from './requestDiagnostics';

const context = {
    requestId: 'request',
    sessionId: 'session',
    subSessionId: 'subagent',
    attempt: 1,
    provider: 'test',
    modelId: 'model',
    sdkMode: 'openai'
};

test('normal terminal cleanup does not turn a completed response into a request failure', () => {
    const entries: RequestDiagnosticEntry[] = [];
    const diagnostic = new RequestDiagnostics(
        context,
        entry => entries.push(entry),
        () => ({ tokenCancelled: false })
    );
    diagnostic.abort('terminal_cleanup');
    diagnostic.error(Object.assign(new TypeError('reader was released'), { code: 'ERR_INVALID_STATE' }), true);
    diagnostic.finish('completed');
    assert.equal(
        entries.some(entry => entry.phase === 'error'),
        false
    );
    assert.equal(entries.at(-1)?.firstErrorAt, undefined);
    assert.equal(entries.at(-1)?.outcome, 'completed');
    assert.equal(
        entries.some(entry => entry.phase === 'cleanup_error'),
        true
    );
});

test('terminal cleanup does not hide a subsequent request-processing failure', () => {
    const entries: RequestDiagnosticEntry[] = [];
    const diagnostic = new RequestDiagnostics(
        context,
        entry => entries.push(entry),
        () => ({ tokenCancelled: false })
    );
    diagnostic.abort('terminal_cleanup');
    diagnostic.error(new Error('postprocessing failed'));
    diagnostic.finish('failed');
    assert.equal(
        entries.some(entry => entry.phase === 'error'),
        true
    );
    assert.equal(typeof entries.at(-1)?.firstErrorAt, 'number');
});

test('parallel requests keep the initial transport failure separate from a peer cancellation', () => {
    const entries: RequestDiagnosticEntry[] = [];
    const first = new RequestDiagnostics(
        { ...context, requestId: 'first' },
        entry => entries.push(entry),
        () => ({ tokenCancelled: false })
    );
    let cancelled = false;
    const peer = new RequestDiagnostics(
        { ...context, requestId: 'peer' },
        entry => entries.push(entry),
        () => ({ tokenCancelled: cancelled })
    );
    first.error(Object.assign(new Error('other side closed'), { code: 'UND_ERR_SOCKET' }));
    cancelled = true;
    peer.abort('host_token');
    peer.error(new DOMException('aborted', 'AbortError'));
    first.finish('failed');
    peer.finish('cancelled');
    const firstSummary = entries.find(entry => entry.requestId === 'first' && entry.phase === 'finished')!;
    const peerSummary = entries.find(entry => entry.requestId === 'peer' && entry.phase === 'finished')!;
    assert.equal(firstSummary.errors?.[0].code, 'UND_ERR_SOCKET');
    assert.equal(firstSummary.tokenCancelled, false);
    assert.equal(peerSummary.errors?.[0].name, 'AbortError');
    assert.equal(peerSummary.tokenCancelled, true);
});

test('diagnostics keep the first failure before a cleanup abort and do not log each chunk', () => {
    const entries: RequestDiagnosticEntry[] = [];
    const controller = new AbortController();
    const diagnostic = new RequestDiagnostics(
        context,
        entry => entries.push(entry),
        () => ({ tokenCancelled: false })
    );
    diagnostic.bindSignal(controller.signal);
    diagnostic.headers(new Response(null, { headers: { 'x-request-id': 'upstream-1' } }));
    for (let index = 0; index < 100; index++) {
        diagnostic.data();
        diagnostic.streamEvent();
        diagnostic.progress();
    }
    diagnostic.error(
        new TypeError('terminated', {
            cause: Object.assign(new Error('other side closed'), { code: 'UND_ERR_SOCKET' })
        })
    );
    diagnostic.abort('finally_cleanup');
    controller.abort();
    diagnostic.error(new DOMException('aborted', 'AbortError'));
    diagnostic.finish('failed');
    diagnostic.finish('completed');
    assert.deepEqual(
        entries.map(entry => entry.phase),
        ['started', 'headers', 'first_data', 'first_event', 'first_progress', 'error', 'abort', 'finished']
    );
    const failure = entries.find(entry => entry.phase === 'error')!;
    const final = entries.at(-1)!;
    assert.equal(failure.signalAborted, false);
    assert.equal(final.signalAborted, true);
    assert.equal(final.outcome, 'failed');
    assert.equal(final.firstErrorAt, failure.firstErrorAt);
    assert.deepEqual(final.errors, failure.errors);
    assert.equal(final.errors?.[1].code, 'UND_ERR_SOCKET');
    assert.equal(final.hasReportedProgress, true);
    assert.equal(typeof final.lastDataAgoMs, 'number');
});

test('diagnostics omit arbitrary messages, request bodies, credentials and URL paths', () => {
    const entries: RequestDiagnosticEntry[] = [];
    const diagnostic = new RequestDiagnostics(
        context,
        entry => entries.push(entry),
        () => ({ tokenCancelled: false })
    );
    diagnostic.dispatched(
        'https://user:secret@example.test/private/prompt?api_key=secret',
        'http://proxy:secret@localhost:80'
    );
    const error = Object.assign(new Error('prompt contents and Bearer secret'), {
        code: 'sk-secret',
        body: 'prompt contents',
        headers: { authorization: 'secret' }
    });
    error.cause = error;
    diagnostic.error(error);
    diagnostic.finish('failed');
    const serialized = JSON.stringify(entries);
    for (const secret of ['secret', 'private', 'prompt contents', 'authorization', 'Bearer']) {
        assert.equal(serialized.includes(secret), false, secret);
    }
    assert.equal(entries[1].origin, 'https://example.test');
    assert.equal(entries[1].proxyMode, 'configured');
    assert.equal(entries.at(-1)?.errors?.length, 1);
});

test('proxy diagnostics distinguish the noproxy sentinel from system fallback', () => {
    const entries: RequestDiagnosticEntry[] = [];
    const diagnostic = new RequestDiagnostics(
        context,
        entry => entries.push(entry),
        () => ({ tokenCancelled: false })
    );
    for (const proxy of ['noproxy', ' NOPROXY ', '', undefined, 'http://localhost:7890']) {
        diagnostic.dispatched('https://example.test', proxy);
    }
    assert.deepEqual(
        entries.filter(entry => entry.phase === 'dispatched').map(entry => entry.proxyMode),
        ['direct', 'direct', 'system', 'system', 'configured']
    );
});

test('diagnostic failures never change request execution and error summaries are bounded', () => {
    const throwing = new RequestDiagnostics(
        context,
        () => {
            throw new Error('log unavailable');
        },
        () => ({ tokenCancelled: false })
    );
    assert.doesNotThrow(() => throwing.finish('completed'));
    const entries: RequestDiagnosticEntry[] = [];
    const diagnostic = new RequestDiagnostics(
        context,
        entry => entries.push(entry),
        () => ({ tokenCancelled: true })
    );
    let error: Error = new Error('other side closed');
    for (let index = 0; index < 100; index++) {
        error = new Error('terminated', { cause: error });
    }
    diagnostic.error(error);
    diagnostic.decision(false, 'cancelled');
    assert.equal(entries.at(-1)?.errors?.length, 8);
    assert.equal(entries.at(-1)?.tokenCancelled, true);
    assert.equal(entries.at(-1)?.reason, 'cancelled');
});
