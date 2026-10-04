import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { APIConnectionError, APIError } from 'openai';
import * as vscode from 'vscode';
import { InterInstanceBus } from '../../../src/interInstance';
import { setBalanceHandoffDirectoryOverride } from '../../../src/interInstance/pathResolver';
import { LeaderElectionService } from '../../../src/status/leaderElectionService';
import { ApiKeyManager } from '../../../src/utils/config/apiKeyManager';
import { ConfigManager } from '../../../src/utils/config/configManager';
import { ConfigSetStore } from '../../../src/utils/config/configSetStore';
import { ApiKeyFailoverManager } from '../../../src/utils/config/failover/apiKeyFailoverManager';
import { BalanceAffinityCache } from '../../../src/utils/config/failover/balanceAffinityCache';
import {
    RetryProvider,
    createContext,
    defaultRetry,
    identity,
    slot,
    successResponse,
    trackedCancellation
} from './retryFixture';

suite('custom SSE retry and coordination', () => {
    const originalElection = {
        isInitialized: LeaderElectionService.isInitialized,
        isLeader: LeaderElectionService.isLeader,
        isAgentsWindow: LeaderElectionService.isAgentsWindow,
        getOwnedAuthorityTerm: LeaderElectionService.getOwnedAuthorityTerm,
        getAuthorityTerm: LeaderElectionService.getAuthorityTerm,
        getInstanceId: LeaderElectionService.getInstanceId
    };
    const originalBus = {
        getAuthorityTerm: InterInstanceBus.getAuthorityTerm,
        hasActiveTransport: InterInstanceBus.hasActiveTransport,
        publishIpcOnly: InterInstanceBus.publishIpcOnly
    };
    const originalFetch = ConfigManager.createProxyAwareFetch;
    const state = ApiKeyFailoverManager as unknown as {
        balanceLeaseRenewalTimers: Map<string, NodeJS.Timeout>;
        balanceAttemptSnapshots: Map<string, unknown>;
        balanceLeases: Map<string, unknown>;
    };
    let context: vscode.ExtensionContext;
    let cancellation: ReturnType<typeof trackedCancellation>;
    let wireKeys: string[];

    setup(async () => {
        ApiKeyFailoverManager.handleBalanceAuthorityLost();
        BalanceAffinityCache.instance.clear();
        setBalanceHandoffDirectoryOverride(mkdtempSync(join(tmpdir(), 'gcmp-custom-retry-')));
        context = createContext();
        cancellation = trackedCancellation();
        wireKeys = [];
        const term = `custom-retry:${randomUUID()}`;
        Object.assign(LeaderElectionService, {
            isInitialized: () => true,
            isLeader: () => true,
            isAgentsWindow: () => false,
            getOwnedAuthorityTerm: () => term,
            getAuthorityTerm: () => term,
            getInstanceId: () => 'custom-retry-instance'
        });
        Object.assign(InterInstanceBus, {
            getAuthorityTerm: () => term,
            hasActiveTransport: () => true,
            publishIpcOnly: () => true
        });
        ApiKeyManager.initialize(context);
        ConfigSetStore.initialize(context);
        for (const id of ['a', 'b']) {
            await ConfigSetStore.add(slot, { id, label: id }, `key-${id}`);
        }
        await ConfigSetStore.setActive(slot, 'a');
        await ApiKeyManager.setApiKey(slot, 'key-a');
        await ConfigSetStore.setSwitchMode(slot, 'off');
    });

    teardown(() => {
        ApiKeyFailoverManager.handleBalanceAuthorityLost();
        BalanceAffinityCache.instance.clear();
        cancellation.dispose();
        for (const disposable of context.subscriptions) {
            disposable.dispose();
        }
        setBalanceHandoffDirectoryOverride(undefined);
        Object.assign(LeaderElectionService, originalElection);
        Object.assign(InterInstanceBus, originalBus);
        ConfigManager.createProxyAwareFetch = originalFetch;
    });

    function transport(handler: (count: number, key: string) => Response): void {
        ConfigManager.createProxyAwareFetch = () => async (input, init) => {
            const request = new Request(input, init);
            assert.ok(request.url.endsWith('/chat/completions'));
            const key = request.headers.get('authorization')?.replace(/^Bearer /, '') ?? '';
            assert.ok(['key-a', 'key-b'].includes(key));
            wireKeys.push(key);
            return handler(wireKeys.length, key);
        };
    }

    function streamError(error: unknown, partial = false): Response {
        const prefix = partial ? 'data: {"choices":[{"index":0,"delta":{"content":"partial"}}]}\n\n' : '';
        return new Response(`${prefix}data: ${JSON.stringify({ error })}\n\ndata: [DONE]\n\n`, {
            headers: { 'content-type': 'text/event-stream' }
        });
    }

    function assertClean(grants: number, expected: number): void {
        assert.equal(wireKeys.length, expected);
        assert.equal(grants, expected);
        assert.equal(cancellation.disposals, cancellation.subscriptions);
        assert.equal(state.balanceLeaseRenewalTimers.size, 0);
        assert.equal(state.balanceAttemptSnapshots.size, 0);
        assert.equal(state.balanceLeases.size, 0);
    }

    for (const sample of [
        { message: 'Service Unavailable', code: 'usage_limit_reached' },
        { message: 'Bad Gateway', code: 'insufficient_credits' },
        { message: 'Service Unavailable', type: 'usage_limit_reached' },
        { message: 'Service Unavailable', current_balance: 0 },
        { message: 'Monthly quota exceeded' },
        { message: 'upstream rejected', code: 'rate_limit_exceeded', recover: true },
        { message: 'upstream rejected', type: 'rate_limit_error', recover: true },
        { message: 'Service Unavailable', recover: true }
    ]) {
        const { recover, ...detail } = sample;
        test(`structured SSE error retains ${JSON.stringify(detail)}`, async () => {
            transport(count => (recover && count > 1 ? successResponse('openai') : streamError(detail)));
            const observed = { grants: 0 };
            const parts: vscode.LanguageModelResponsePart[] = [];
            const result = RetryProvider.run('openai-sse', defaultRetry, observed, cancellation.token, parts);
            if (recover) {
                await result;
                assert.ok(
                    parts.some(part => part instanceof vscode.LanguageModelTextPart && part.value === 'recovered')
                );
            } else {
                await assert.rejects(result, error => {
                    assert.ok(error instanceof APIError);
                    assert.ok(!(error instanceof APIConnectionError));
                    assert.equal(error.status, undefined);
                    assert.equal(error.code, detail.code);
                    assert.equal(error.type, detail.type);
                    assert.equal(error.message, detail.message);
                    assert.deepEqual(error.error, detail);
                    return true;
                });
                assert.equal(parts.length, 0);
            }
            assertClean(observed.grants, recover ? 2 : 1);
        });
    }

    for (const error of ['Monthly quota exceeded', 42, { message: 42, code: 'usage_limit_reached' }]) {
        test(`malformed or string SSE error preserves readable fallback: ${JSON.stringify(error)}`, async () => {
            transport(() => streamError(error));
            const observed = { grants: 0 };
            await assert.rejects(
                RetryProvider.run('openai-sse', defaultRetry, observed, cancellation.token),
                failure => {
                    assert.ok(failure instanceof Error);
                    assert.equal(failure.message, typeof error === 'string' ? error : 'SSE response error');
                    return true;
                }
            );
            assertClean(observed.grants, 1);
        });
    }

    for (const placement of ['nested', 'flat'] as const) {
        for (const sample of [
            { status: 503, detail: { message: 'Service Unavailable', type: 'usage_limit_reached' }, recover: false },
            { status: 429, detail: { message: 'Service Unavailable', current_balance: 0 }, recover: false },
            { status: 400, detail: { message: 'upstream rejected', type: 'rate_limit_error' }, recover: true },
            { status: 503, detail: { message: 'Service Unavailable', code: 'usage_limit_reached' }, recover: false },
            { status: 429, detail: { message: 'upstream rejected', code: 'rate_limit_exceeded' }, recover: true },
            { status: 503, detail: { message: 'Service Unavailable' }, recover: true },
            { status: 200, detail: { message: 'Service Unavailable', code: 'usage_limit_reached' }, recover: false },
            { status: 200, detail: { message: 'upstream rejected', code: 'rate_limit_exceeded' }, recover: true },
            { status: 200, detail: { message: 'Service Unavailable', type: 'usage_limit_reached' }, recover: false },
            { status: 200, detail: { message: 'Service Unavailable', current_balance: 0 }, recover: false }
        ]) {
            test(`HTTP response classification: ${placement}, ${sample.status}, ${JSON.stringify(sample.detail)}`, async () => {
                transport(count =>
                    sample.recover && count > 1 ?
                        successResponse('openai')
                    :   new Response(
                            JSON.stringify(placement === 'nested' ? { error: sample.detail } : sample.detail),
                            {
                                status: sample.status,
                                headers: {
                                    'content-type': 'application/json',
                                    'x-request-id': 'custom-http-error',
                                    'retry-after': '7'
                                }
                            }
                        )
                );
                const observed = { grants: 0 };
                const parts: vscode.LanguageModelResponsePart[] = [];
                const result = RetryProvider.run('openai-sse', defaultRetry, observed, cancellation.token, parts);
                if (sample.recover) {
                    await result;
                    assert.ok(
                        parts.some(part => part instanceof vscode.LanguageModelTextPart && part.value === 'recovered')
                    );
                } else {
                    await assert.rejects(result, error => {
                        assert.ok(error instanceof APIError);
                        assert.ok(!(error instanceof APIConnectionError));
                        assert.equal(error.status, sample.status);
                        assert.equal(error.code, sample.detail.code);
                        assert.equal(error.type, sample.detail.type);
                        assert.equal(error.message, `${sample.status} ${sample.detail.message}`);
                        assert.equal(error.requestID, 'custom-http-error');
                        assert.equal(error.headers?.get('retry-after'), '7');
                        assert.deepEqual(error.error, sample.detail);
                        return true;
                    });
                    assert.equal(parts.length, 0);
                }
                assertClean(observed.grants, sample.recover ? 2 : 1);
            });
        }
    }

    for (const status of [400, 200]) {
        for (const sample of [
            {
                name: 'outer balance survives nested error',
                body: JSON.stringify({
                    current_balance: 0,
                    request_id: 'body-id',
                    error: { message: 'upstream rejected', type: 'rate_limit_error' }
                }),
                expected: {
                    current_balance: 0,
                    request_id: 'body-id',
                    message: 'upstream rejected',
                    type: 'rate_limit_error'
                }
            },
            {
                name: 'nested fields override outer fields',
                body: JSON.stringify({
                    message: 'outer',
                    code: 'outer-code',
                    type: 'outer-type',
                    error: {
                        message: 'inner',
                        code: 'usage_limit_reached',
                        type: 'inner-type',
                        param: 'model',
                        details: { budget: 0 }
                    }
                }),
                expected: {
                    message: 'inner',
                    code: 'usage_limit_reached',
                    type: 'inner-type',
                    param: 'model',
                    details: { budget: 0 }
                }
            },
            {
                name: 'string error',
                body: '{"error":"Monthly quota exceeded"}',
                expected: { message: 'Monthly quota exceeded' }
            },
            { name: 'string payload', body: '"upstream rejected"', expected: { message: 'upstream rejected' } },
            { name: 'malformed JSON', body: '{not-json', expected: { message: '{not-json' } },
            {
                name: 'numeric message',
                body: '{"error":{"message":42,"code":"usage_limit_reached"}}',
                expected: {
                    message: '{"error":{"message":42,"code":"usage_limit_reached"}}',
                    code: 'usage_limit_reached'
                }
            },
            { name: 'array payload', body: '["upstream rejected"]', expected: { message: '["upstream rejected"]' } },
            { name: 'null payload', body: 'null', expected: { message: 'null' } },
            { name: 'empty payload', body: '', expected: undefined }
        ]) {
            test(`HTTP error normalization: ${status}, ${sample.name}`, async () => {
                transport(
                    () =>
                        new Response(sample.body, {
                            status,
                            headers: { 'content-type': 'application/json', 'x-request-id': 'normalization-error' }
                        })
                );
                const observed = { grants: 0 };
                await assert.rejects(
                    RetryProvider.run('openai-sse', defaultRetry, observed, cancellation.token),
                    error => {
                        assert.ok(error instanceof APIError);
                        assert.ok(!(error instanceof APIConnectionError));
                        assert.equal(error.status, status);
                        assert.equal(error.requestID, 'normalization-error');
                        if (sample.expected) {
                            assert.deepEqual(error.error, sample.expected);
                            assert.equal(error.message, `${status} ${sample.expected.message}`);
                        } else {
                            assert.match(error.message, new RegExp(`^${status} .+`));
                            assert.deepEqual(error.error, { message: error.message.slice(String(status).length + 1) });
                        }
                        return true;
                    }
                );
                assertClean(observed.grants, 1);
            });
        }
    }

    for (const contentType of [
        'Application/JSON; charset=UTF-8',
        'application/problem+json',
        'application/vnd.gateway+json'
    ]) {
        test(`HTTP 200 recognizes JSON media type: ${contentType}`, async () => {
            transport(
                () =>
                    new Response('{"error":{"message":"rejected","type":"usage_limit_reached"}}', {
                        headers: { 'content-type': contentType }
                    })
            );
            const observed = { grants: 0 };
            await assert.rejects(RetryProvider.run('openai-sse', defaultRetry, observed, cancellation.token), error => {
                assert.ok(error instanceof APIError);
                assert.equal(error.status, 200);
                assert.equal(error.type, 'usage_limit_reached');
                return true;
            });
            assertClean(observed.grants, 1);
        });
    }

    for (const media of ['application/json', 'absent', 'text/plain'] as const) {
        for (const scenario of ['permanent', 'transient', 'balance', 'failover'] as const) {
            test(`HTTP inferred JSON: ${media}, ${scenario}`, async () => {
                const mode = scenario === 'balance' || scenario === 'failover' ? scenario : 'off';
                await ConfigSetStore.setSwitchMode(slot, mode);
                const detail = {
                    message: 'upstream rejected',
                    type: scenario === 'transient' ? 'rate_limit_error' : 'usage_limit_reached'
                };
                transport((count, key) => {
                    if ((scenario === 'transient' && count > 1) || (mode !== 'off' && key !== wireKeys[0])) {
                        return successResponse('openai');
                    }
                    return new Response(new TextEncoder().encode(JSON.stringify({ error: detail })), {
                        headers: {
                            ...(media === 'absent' ? {} : { 'content-type': media }),
                            'x-request-id': 'inferred-error'
                        }
                    });
                });
                const observed = { grants: 0 };
                const parts: vscode.LanguageModelResponsePart[] = [];
                const result = RetryProvider.run('openai-sse', defaultRetry, observed, cancellation.token, parts);
                if (scenario === 'permanent') {
                    await assert.rejects(result, error => {
                        assert.ok(error instanceof APIError);
                        assert.ok(!(error instanceof APIConnectionError));
                        assert.equal(error.status, 200);
                        assert.equal(error.requestID, 'inferred-error');
                        assert.deepEqual(error.error, detail);
                        return true;
                    });
                    assert.equal(parts.length, 0);
                } else {
                    await result;
                    assert.ok(
                        parts.some(part => part instanceof vscode.LanguageModelTextPart && part.value === 'recovered')
                    );
                }
                assertClean(
                    observed.grants,
                    scenario === 'permanent' ? 1
                    : scenario === 'transient' ? 2
                    : 4
                );
                if (mode !== 'off') {
                    assert.deepEqual(wireKeys, [
                        wireKeys[0],
                        wireKeys[0],
                        wireKeys[0],
                        wireKeys[0] === 'key-a' ? 'key-b' : 'key-a'
                    ]);
                }
            });
        }
        for (const status of [200, 503]) {
            for (const cancellationAt of ['none', 'before', 'during'] as const) {
                for (const mode of ['off', 'balance', 'failover'] as const) {
                    test(`HTTP body rejection: ${media}, ${status}, ${cancellationAt}, ${mode}`, async () => {
                        await ConfigSetStore.setSwitchMode(slot, mode);
                        const bodies: ReadableStream<Uint8Array>[] = [];
                        transport(count => {
                            if (count > 1) {
                                return successResponse('openai');
                            }
                            if (cancellationAt === 'before') {
                                cancellation.cancel();
                            }
                            const body = new ReadableStream<Uint8Array>({
                                start(controller) {
                                    controller.enqueue(new TextEncoder().encode('{"error":'));
                                },
                                pull(controller) {
                                    if (cancellationAt === 'during') {
                                        cancellation.cancel();
                                    }
                                    controller.error(new TypeError('terminated'));
                                }
                            });
                            bodies.push(body);
                            return new Response(body, {
                                status,
                                headers: media === 'absent' ? {} : { 'content-type': media }
                            });
                        });
                        const observed = { grants: 0 };
                        const parts: vscode.LanguageModelResponsePart[] = [];
                        const result = RetryProvider.run(
                            'openai-sse',
                            defaultRetry,
                            observed,
                            cancellation.token,
                            parts
                        );
                        if (cancellationAt === 'none') {
                            await result;
                            assert.ok(
                                parts.some(
                                    part => part instanceof vscode.LanguageModelTextPart && part.value === 'recovered'
                                )
                            );
                        } else {
                            await assert.rejects(result, vscode.CancellationError);
                            assert.equal(parts.length, 0);
                        }
                        assertClean(observed.grants, cancellationAt === 'none' ? 2 : 1);
                        assert.equal(ConfigSetStore.getBalanceExclusions(slot).length, 0);
                        assert.equal(await ApiKeyManager.getApiKey(slot), 'key-a');
                        if (status === 200 && media !== 'application/json') {
                            assert.ok(bodies.every(body => !body.locked));
                        }
                    });
                }
            }
        }
    }

    for (const media of ['absent', 'text/plain']) {
        for (const mode of ['off', 'balance', 'failover'] as const) {
            test(`inferred SSE partial output prevents replay: ${media}, ${mode}`, async () => {
                await ConfigSetStore.setSwitchMode(slot, mode);
                transport(() => {
                    const response = streamError({ message: 'upstream rejected', code: 'rate_limit_exceeded' }, true);
                    if (media === 'absent') {
                        response.headers.delete('content-type');
                    } else {
                        response.headers.set('content-type', media);
                    }
                    return response;
                });
                const observed = { grants: 0 };
                const parts: vscode.LanguageModelResponsePart[] = [];
                await assert.rejects(
                    RetryProvider.run('openai-sse', defaultRetry, observed, cancellation.token, parts)
                );
                assert.ok(parts.some(part => part instanceof vscode.LanguageModelTextPart && part.value === 'partial'));
                assertClean(observed.grants, 1);
                assert.equal(ConfigSetStore.getBalanceExclusions(slot).length, 0);
                assert.equal(await ApiKeyManager.getApiKey(slot), 'key-a');
            });
        }
        for (const placement of ['nested', 'flat']) {
            for (const width of [1, 7]) {
                test(`HTTP inferred JSON chunks: ${media}, ${placement}, ${width}`, async () => {
                    const detail = { message: '上游暂不可用', type: 'usage_limit_reached', current_balance: 0 };
                    const bytes = new TextEncoder().encode(
                        '\uFEFF \r\n\t' + JSON.stringify(placement === 'nested' ? { error: detail } : detail, null, 2)
                    );
                    const bodies: ReadableStream<Uint8Array>[] = [];
                    transport(() => {
                        const body = new ReadableStream<Uint8Array>({
                            start(controller) {
                                for (let offset = 0; offset < bytes.length; offset += width) {
                                    controller.enqueue(bytes.subarray(offset, offset + width));
                                }
                                controller.close();
                            }
                        });
                        bodies.push(body);
                        return new Response(body, { headers: media === 'absent' ? {} : { 'content-type': media } });
                    });
                    const observed = { grants: 0 };
                    const parts: vscode.LanguageModelResponsePart[] = [];
                    await assert.rejects(
                        RetryProvider.run('openai-sse', defaultRetry, observed, cancellation.token, parts),
                        error => {
                            assert.ok(error instanceof APIError);
                            assert.equal(error.status, 200);
                            assert.deepEqual(error.error, detail);
                            return true;
                        }
                    );
                    assertClean(observed.grants, 1);
                    assert.equal(parts.length, 0);
                    assert.ok(bodies.every(body => !body.locked));
                });
            }
        }
    }

    for (const media of ['application/json', 'absent', 'text/plain'] as const) {
        for (const scenario of ['permanent', 'transient', 'balance', 'failover'] as const) {
            test(`HTTP loopback media: ${media}, ${scenario}`, async () => {
                const mode = scenario === 'balance' || scenario === 'failover' ? scenario : 'off';
                await ConfigSetStore.setSwitchMode(slot, mode);
                const healthy = await successResponse('openai').text();
                const detail = {
                    message: 'upstream rejected',
                    type: scenario === 'transient' ? 'rate_limit_error' : 'usage_limit_reached'
                };
                const serverKeys: string[] = [];
                const mediaReceived: Array<string | null> = [];
                const server = createServer((request, response) => {
                    const key = String(request.headers.authorization ?? '').replace(/^Bearer /, '');
                    serverKeys.push(key);
                    const success =
                        (scenario === 'transient' && serverKeys.length > 1) ||
                        (mode !== 'off' && key !== serverKeys[0]);
                    response.writeHead(
                        200,
                        success ? { 'content-type': 'text/event-stream' }
                        : media === 'absent' ? {}
                        : { 'content-type': media }
                    );
                    response.end(success ? healthy : JSON.stringify({ error: detail }));
                });
                await new Promise<void>((resolve, reject) => {
                    server.once('error', reject);
                    server.listen(0, '127.0.0.1', resolve);
                });
                try {
                    const address = server.address();
                    assert.ok(address && typeof address === 'object');
                    ConfigManager.createProxyAwareFetch = () => async (input, init) => {
                        const request = new Request(input, init);
                        const key = request.headers.get('authorization')?.replace(/^Bearer /, '') ?? '';
                        assert.ok(['key-a', 'key-b'].includes(key));
                        wireKeys.push(key);
                        const response = await fetch(`http://127.0.0.1:${address.port}/chat/completions`, init);
                        mediaReceived.push(response.headers.get('content-type'));
                        return response;
                    };
                    const observed = { grants: 0 };
                    const parts: vscode.LanguageModelResponsePart[] = [];
                    const result = RetryProvider.run('openai-sse', defaultRetry, observed, cancellation.token, parts);
                    if (scenario === 'permanent') {
                        await assert.rejects(result, APIError);
                    } else {
                        await result;
                        assert.ok(
                            parts.some(
                                part => part instanceof vscode.LanguageModelTextPart && part.value === 'recovered'
                            )
                        );
                    }
                    assert.equal(mediaReceived[0], media === 'absent' ? null : media);
                    assert.deepEqual(serverKeys, wireKeys);
                    assertClean(
                        observed.grants,
                        scenario === 'permanent' ? 1
                        : scenario === 'transient' ? 2
                        : 4
                    );
                } finally {
                    server.closeAllConnections();
                    await new Promise<void>((resolve, reject) =>
                        server.close(error => (error ? reject(error) : resolve()))
                    );
                }
            });
        }
    }

    for (const media of ['text/event-stream', 'absent', 'text/plain']) {
        for (const newline of ['lf', 'crlf', 'cr']) {
            for (const multiline of [false, true]) {
                for (const scenario of ['healthy', 'permanent', 'transient', 'balance', 'failover'] as const) {
                    test(`SSE event framing: ${media}, ${newline}, ${multiline}, ${scenario}`, async () => {
                        const mode = scenario === 'balance' || scenario === 'failover' ? scenario : 'off';
                        await ConfigSetStore.setSwitchMode(slot, mode);
                        const eol =
                            newline === 'lf' ? '\n'
                            : newline === 'crlf' ? '\r\n'
                            : '\r';
                        const detail = {
                            message: 'upstream rejected',
                            type: scenario === 'transient' ? 'rate_limit_error' : 'usage_limit_reached'
                        };
                        transport((count, key) => {
                            const healthy =
                                scenario === 'healthy' ||
                                (scenario === 'transient' && count > 1) ||
                                (mode !== 'off' && key !== wireKeys[0]);
                            const payload =
                                healthy ?
                                    {
                                        id: 'framed',
                                        object: 'chat.completion.chunk',
                                        created: 0,
                                        model: 'retry-model',
                                        choices: [
                                            {
                                                index: 0,
                                                delta: { role: 'assistant', content: 'recovered' },
                                                finish_reason: 'stop'
                                            }
                                        ]
                                    }
                                :   { error: detail };
                            const text =
                                JSON.stringify(payload, null, multiline ? 2 : undefined)
                                    .split('\n')
                                    .map(line => `data: ${line}`)
                                    .join(eol) +
                                eol +
                                eol;
                            return new Response(new TextEncoder().encode(text), {
                                headers: media === 'absent' ? {} : { 'content-type': media }
                            });
                        });
                        const observed = { grants: 0 };
                        const parts: vscode.LanguageModelResponsePart[] = [];
                        const result = RetryProvider.run(
                            'openai-sse',
                            defaultRetry,
                            observed,
                            cancellation.token,
                            parts
                        );
                        if (scenario === 'permanent') {
                            await assert.rejects(result, error => {
                                assert.ok(error instanceof APIError);
                                assert.deepEqual(error.error, detail);
                                return true;
                            });
                            assert.equal(parts.length, 0);
                        } else {
                            await result;
                            assert.ok(
                                parts.some(
                                    part => part instanceof vscode.LanguageModelTextPart && part.value === 'recovered'
                                )
                            );
                        }
                        assertClean(
                            observed.grants,
                            scenario === 'healthy' || scenario === 'permanent' ? 1
                            : scenario === 'transient' ? 2
                            : 4
                        );
                        if (mode !== 'off') {
                            assert.deepEqual(wireKeys, [
                                wireKeys[0],
                                wireKeys[0],
                                wireKeys[0],
                                wireKeys[0] === 'key-a' ? 'key-b' : 'key-a'
                            ]);
                        }
                    });
                }
            }
        }
        for (const scenario of ['permanent', 'transient', 'partial', 'balance', 'failover', 'cancel'] as const) {
            test(`SSE abandoned HTTP response closes: ${media}, ${scenario}`, async () => {
                const mode = scenario === 'balance' || scenario === 'failover' ? scenario : 'off';
                await ConfigSetStore.setSwitchMode(slot, mode);
                const healthy = await successResponse('openai').text();
                const code =
                    scenario === 'transient' || scenario === 'partial' ? 'rate_limit_exceeded' : 'usage_limit_reached';
                const errorFrame = `data: ${JSON.stringify({ error: { message: 'upstream rejected', code } })}\n\n`;
                const partial = 'data: {"choices":[{"index":0,"delta":{"content":"partial"}}]}\n\n';
                const openErrors = new Set<import('node:http').ServerResponse>();
                const signals: AbortSignal[] = [];
                let clientFinished = false;
                let allClosed!: () => void;
                const closed = new Promise<void>(resolve => {
                    allClosed = resolve;
                });
                const server = createServer((request, response) => {
                    request.resume();
                    const key = String(request.headers.authorization ?? '').replace(/^Bearer /, '');
                    response.writeHead(200, media === 'absent' ? {} : { 'content-type': media });
                    if (mode !== 'off' && key !== wireKeys[0]) {
                        response.end(healthy);
                        return;
                    }
                    openErrors.add(response);
                    response.on('close', () => {
                        openErrors.delete(response);
                        if (clientFinished && openErrors.size === 0) {
                            allClosed();
                        }
                    });
                    response.write(
                        scenario === 'cancel' ? ': heartbeat\n\n' : (scenario === 'partial' ? partial : '') + errorFrame
                    );
                });
                await new Promise<void>((resolve, reject) => {
                    server.once('error', reject);
                    server.listen(0, '127.0.0.1', resolve);
                });
                let timeout: NodeJS.Timeout | undefined;
                try {
                    const address = server.address();
                    assert.ok(address && typeof address === 'object');
                    ConfigManager.createProxyAwareFetch = () => async (input, init) => {
                        const request = new Request(input, init);
                        wireKeys.push(request.headers.get('authorization')?.replace(/^Bearer /, '') ?? '');
                        assert.ok(init?.signal);
                        signals.push(init.signal);
                        const response = await fetch(`http://127.0.0.1:${address.port}/chat/completions`, init);
                        if (scenario === 'cancel') {
                            cancellation.cancel();
                        }
                        return response;
                    };
                    const observed = { grants: 0 };
                    const parts: vscode.LanguageModelResponsePart[] = [];
                    const result = RetryProvider.run(
                        'openai-sse',
                        {
                            ...defaultRetry,
                            maxAttempts: scenario === 'transient' ? 1 : 3
                        },
                        observed,
                        cancellation.token,
                        parts
                    );
                    if (scenario === 'cancel') {
                        await assert.rejects(result, vscode.CancellationError);
                    } else if (mode === 'off') {
                        await assert.rejects(result, APIError);
                    } else {
                        await result;
                        assert.ok(
                            parts.some(
                                part => part instanceof vscode.LanguageModelTextPart && part.value === 'recovered'
                            )
                        );
                    }
                    clientFinished = true;
                    if (openErrors.size === 0) {
                        allClosed();
                    }
                    assertClean(
                        observed.grants,
                        mode !== 'off' ? 4
                        : scenario === 'transient' ? 2
                        : 1
                    );
                    if (scenario === 'partial') {
                        assert.ok(
                            parts.some(part => part instanceof vscode.LanguageModelTextPart && part.value === 'partial')
                        );
                    }
                    assert.ok(signals.slice(0, mode !== 'off' ? 3 : signals.length).every(signal => signal.aborted));
                    await Promise.race([
                        closed,
                        new Promise<never>((_resolve, reject) => {
                            timeout = setTimeout(() => reject(new Error('abandoned SSE response remained open')), 1000);
                        })
                    ]);
                    assert.equal(openErrors.size, 0);
                } finally {
                    if (timeout) {
                        clearTimeout(timeout);
                    }
                    server.closeAllConnections();
                    await new Promise<void>((resolve, reject) =>
                        server.close(error => (error ? reject(error) : resolve()))
                    );
                }
            });
        }
    }

    for (const mode of ['off', 'balance', 'failover'] as const) {
        for (const status of [400, 200]) {
            for (const option of ['disabled', 'zero', 'cancel', 'cancel-read', 'exhausted'] as const) {
                test(`HTTP response boundaries: ${mode}, ${status}, ${option}`, async () => {
                    await ConfigSetStore.setSwitchMode(slot, mode);
                    transport(() => {
                        if (option === 'cancel') {
                            cancellation.cancel();
                        }
                        const payload = '{"error":{"message":"upstream rejected","type":"rate_limit_error"}}';
                        const body =
                            option === 'cancel-read' ?
                                new ReadableStream<Uint8Array>({
                                    start(controller) {
                                        controller.enqueue(new TextEncoder().encode(payload));
                                    },
                                    pull(controller) {
                                        cancellation.cancel();
                                        controller.close();
                                    }
                                })
                            :   payload;
                        return new Response(body, { status, headers: { 'content-type': 'application/json' } });
                    });
                    const observed = { grants: 0 };
                    const parts: vscode.LanguageModelResponsePart[] = [];
                    const retry = {
                        ...defaultRetry,
                        enabled: option !== 'disabled',
                        maxAttempts: option === 'zero' ? 0 : 3
                    };
                    const result = RetryProvider.run('openai-sse', retry, observed, cancellation.token, parts);
                    if (option === 'cancel' || option === 'cancel-read') {
                        await assert.rejects(result, vscode.CancellationError);
                    } else {
                        await assert.rejects(result, error => {
                            assert.ok(error instanceof APIError);
                            assert.equal(error.status, status);
                            assert.equal(error.type, 'rate_limit_error');
                            return true;
                        });
                    }
                    assert.equal(parts.length, 0);
                    assertClean(
                        observed.grants,
                        option === 'exhausted' ?
                            mode === 'off' ?
                                4
                            :   7
                        :   1
                    );
                    if (option !== 'exhausted') {
                        assert.equal(ConfigSetStore.getBalanceExclusions(slot).length, 0);
                        assert.equal(await ApiKeyManager.getApiKey(slot), 'key-a');
                    }
                });
            }
        }
        if (mode !== 'off') {
            for (const status of [503, 200]) {
                test(`HTTP permanent errors coordinate switching: ${mode}, ${status}`, async () => {
                    await ConfigSetStore.setSwitchMode(slot, mode);
                    transport((_count, key) =>
                        key === wireKeys[0] ?
                            new Response('{"error":{"message":"upstream rejected","type":"usage_limit_reached"}}', {
                                status,
                                headers: { 'content-type': 'application/json' }
                            })
                        :   successResponse('openai')
                    );
                    const observed = { grants: 0 };
                    const parts: vscode.LanguageModelResponsePart[] = [];
                    await RetryProvider.run('openai-sse', defaultRetry, observed, cancellation.token, parts);
                    assert.deepEqual(wireKeys, [
                        wireKeys[0],
                        wireKeys[0],
                        wireKeys[0],
                        wireKeys[0] === 'key-a' ? 'key-b' : 'key-a'
                    ]);
                    assert.ok(
                        parts.some(part => part instanceof vscode.LanguageModelTextPart && part.value === 'recovered')
                    );
                    assertClean(observed.grants, 4);
                    if (mode === 'balance') {
                        assert.equal(ConfigSetStore.getBalanceExclusions(slot)[0]?.credentialId, identity(wireKeys[0]));
                        assert.equal(await ApiKeyManager.getApiKey(slot), 'key-a');
                    } else {
                        assert.equal(await ApiKeyManager.getApiKey(slot), 'key-b');
                    }
                });
            }
        }
    }

    for (const mode of ['off', 'balance', 'failover'] as const) {
        for (const option of ['disabled', 'zero', 'cancel', 'partial', 'exhausted'] as const) {
            test(`${mode}: ${option} SSE failure respects request boundaries`, async () => {
                await ConfigSetStore.setSwitchMode(slot, mode);
                transport(() => {
                    if (option === 'cancel') {
                        cancellation.cancel();
                    }
                    return streamError(
                        { message: 'upstream rejected', code: 'rate_limit_exceeded' },
                        option === 'partial'
                    );
                });
                const observed = { grants: 0 };
                const parts: vscode.LanguageModelResponsePart[] = [];
                const retry = {
                    ...defaultRetry,
                    enabled: option !== 'disabled',
                    maxAttempts: option === 'zero' ? 0 : 3
                };
                const result = RetryProvider.run('openai-sse', retry, observed, cancellation.token, parts);
                if (option === 'cancel') {
                    await assert.rejects(result, vscode.CancellationError);
                } else {
                    await assert.rejects(result);
                }
                assertClean(
                    observed.grants,
                    option === 'exhausted' ?
                        mode === 'off' ?
                            4
                        :   7
                    :   1
                );
                if (option === 'partial') {
                    assert.ok(
                        parts.some(part => part instanceof vscode.LanguageModelTextPart && part.value === 'partial')
                    );
                }
                if (option !== 'exhausted') {
                    assert.equal(ConfigSetStore.getBalanceExclusions(slot).length, 0);
                    assert.equal(await ApiKeyManager.getApiKey(slot), 'key-a');
                }
            });
        }

        if (mode !== 'off') {
            test(`${mode}: permanent SSE failures still switch after three actual requests`, async () => {
                await ConfigSetStore.setSwitchMode(slot, mode);
                transport((_count, key) =>
                    key === wireKeys[0] ?
                        streamError({ message: 'upstream rejected', code: 'usage_limit_reached' })
                    :   successResponse('openai')
                );
                const observed = { grants: 0 };
                await RetryProvider.run('openai-sse', defaultRetry, observed, cancellation.token);
                assert.deepEqual(wireKeys, [
                    wireKeys[0],
                    wireKeys[0],
                    wireKeys[0],
                    wireKeys[0] === 'key-a' ? 'key-b' : 'key-a'
                ]);
                assertClean(observed.grants, 4);
                if (mode === 'balance') {
                    assert.equal(ConfigSetStore.getBalanceExclusions(slot)[0]?.credentialId, identity(wireKeys[0]));
                    assert.equal(await ApiKeyManager.getApiKey(slot), 'key-a');
                } else {
                    assert.equal(await ApiKeyManager.getApiKey(slot), 'key-b');
                }
            });
        }
    }
});
