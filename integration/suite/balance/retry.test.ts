import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { APIConnectionTimeoutError, APIError, APIUserAbortError } from 'openai';
import * as vscode from 'vscode';
import { InterInstanceBus } from '../../../src/interInstance';
import type { ApiKeyBalanceFailureReportedEvent } from '../../../src/interInstance/eventProtocol';
import { setBalanceHandoffDirectoryOverride } from '../../../src/interInstance/pathResolver';
import { LeaderElectionService } from '../../../src/status/leaderElectionService';
import { ApiKeyManager } from '../../../src/utils/config/apiKeyManager';
import { ConfigManager } from '../../../src/utils/config/configManager';
import { ConfigSetStore } from '../../../src/utils/config/configSetStore';
import {
    ApiKeyFailoverManager,
    type ApiKeyFailoverAttempt,
    type ApiKeyFailoverDecision
} from '../../../src/utils/config/failover/apiKeyFailoverManager';
import { BalanceAffinityCache } from '../../../src/utils/config/failover/balanceAffinityCache';
import { RetryManager } from '../../../src/utils/retry/retryManager';
import {
    RetryProvider,
    balanceKey,
    createContext,
    defaultRetry,
    errorResponse,
    identity,
    slot,
    successResponse,
    trackedCancellation
} from './retryFixture';

interface PendingFailure {
    slot: string;
    timer: NodeJS.Timeout & { _destroyed: boolean; _onTimeout(): void };
}

interface ManagerState {
    pendingBalanceFailures: Map<string, PendingFailure>;
    balanceLeaseRenewalTimers: Map<string, NodeJS.Timeout>;
    balanceAttemptSnapshots: Map<string, { slot: string; attempt: ApiKeyFailoverAttempt }>;
}

const managerState = ApiKeyFailoverManager as unknown as ManagerState;
const stopped: ApiKeyFailoverDecision = { handled: true, shouldRetry: false, switched: false };
const switched: ApiKeyFailoverDecision = { handled: true, shouldRetry: true, switched: true };

suite('balance retry and coordination', () => {
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
    let term: string;
    let published: ApiKeyBalanceFailureReportedEvent['payload'][];
    let pendingTimers: PendingFailure['timer'][];
    let cancellations: ReturnType<typeof trackedCancellation>[];
    let wireKeys: string[];

    setup(async () => {
        ApiKeyFailoverManager.handleBalanceAuthorityLost();
        BalanceAffinityCache.instance.clear();
        setBalanceHandoffDirectoryOverride(mkdtempSync(join(tmpdir(), 'gcmp-balance-retry-')));
        published = [];
        pendingTimers = [];
        cancellations = [];
        wireKeys = [];
        term = `balance-retry:${randomUUID()}`;
        Object.assign(LeaderElectionService, {
            isInitialized: () => true,
            isLeader: () => true,
            isAgentsWindow: () => false,
            getOwnedAuthorityTerm: () => term,
            getAuthorityTerm: () => term,
            getInstanceId: () => 'retry-instance'
        });
        InterInstanceBus.getAuthorityTerm = () => term;
        InterInstanceBus.hasActiveTransport = () => true;
        InterInstanceBus.publishIpcOnly = event => {
            if (event.type === 'apiKeyBalanceFailureReported') {
                const payload = event.payload as ApiKeyBalanceFailureReportedEvent['payload'];
                published.push(payload);
                const pending = managerState.pendingBalanceFailures.get(payload.requestId);
                assert.ok(pending);
                pendingTimers.push(pending.timer);
            }
            return true;
        };
        const context = createContext();
        ApiKeyManager.initialize(context);
        ConfigSetStore.initialize(context);
        for (const id of ['a', 'b']) {
            await ConfigSetStore.add(slot, { id, label: id }, `key-${id}`);
        }
        await ConfigSetStore.setActive(slot, 'a');
        await ApiKeyManager.setApiKey(slot, 'key-a');
        await ConfigSetStore.setSwitchMode(slot, 'balance');
    });

    teardown(() => {
        ApiKeyFailoverManager.handleBalanceAuthorityLost();
        BalanceAffinityCache.instance.clear();
        for (const timer of pendingTimers) {
            clearTimeout(timer);
        }
        for (const cancellation of cancellations) {
            cancellation.dispose();
        }
        setBalanceHandoffDirectoryOverride(undefined);
        Object.assign(LeaderElectionService, originalElection);
        Object.assign(InterInstanceBus, originalBus);
        ConfigManager.createProxyAwareFetch = originalFetch;
    });

    function cancellation(cancelOnSubscribe = false) {
        const tracked = trackedCancellation(cancelOnSubscribe);
        cancellations.push(tracked);
        return tracked;
    }

    function transport(handler: (key: string, count: number) => Response, sdkMode: 'openai' | 'openai-responses') {
        ConfigManager.createProxyAwareFetch = () => async (input, init) => {
            const request = new Request(input, init);
            assert.ok(request.url.endsWith(sdkMode === 'openai' ? '/chat/completions' : '/responses'));
            const key = request.headers.get('authorization')?.replace(/^Bearer /, '') ?? '';
            assert.ok(['key-a', 'key-b'].includes(key));
            wireKeys.push(key);
            return handler(key, wireKeys.length);
        };
    }

    function reportFailure(requestSlot = slot, token?: vscode.CancellationToken): Promise<ApiKeyFailoverDecision> {
        LeaderElectionService.isLeader = () => false;
        const attempt: ApiKeyFailoverAttempt = {
            mode: 'balance',
            activeId: 'a',
            apiKey: 'key-a',
            identity: identity('key-a'),
            balanceLeaseId: 'retry-lease',
            balanceLeaseExpiresAt: Date.now() + 30_000,
            balanceAuthorityTerm: term
        };
        return ApiKeyFailoverManager.handleFailure(
            requestSlot,
            new Error('service unavailable'),
            attempt,
            new Set(),
            3,
            undefined,
            false,
            undefined,
            undefined,
            undefined,
            balanceKey,
            token
        );
    }

    function reply(index = 0, decision = switched): void {
        ApiKeyFailoverManager.resolveBalanceFailure({
            requestId: published[index].requestId,
            targetInstanceId: 'retry-instance',
            authorityTerm: term,
            ...decision
        });
    }

    function assertClean(tracked: ReturnType<typeof trackedCancellation>): void {
        assert.equal(managerState.pendingBalanceFailures.size, 0);
        assert.equal(tracked.subscriptions, 1);
        assert.equal(tracked.disposals, 1);
        assert.ok(pendingTimers.every(timer => timer._destroyed));
    }

    test('SDK connection timeouts are retryable without a cause or the default message', () => {
        for (const error of [
            new APIConnectionTimeoutError(),
            new APIConnectionTimeoutError({ message: 'upstream connection timeout' }),
            Object.assign(new APIConnectionTimeoutError(), { code: null })
        ]) {
            assert.equal(error.cause, undefined);
            assert.equal(RetryManager.isNetworkError(error), true);
        }
    });

    test('SDK connection timeout classification preserves the permanent error veto', () => {
        for (const error of [
            new APIConnectionTimeoutError({ message: 'monthly quota exceeded' }),
            new APIConnectionTimeoutError({ message: 'billing issue' }),
            Object.assign(new APIConnectionTimeoutError(), { code: 'usage_limit_reached' }),
            Object.assign(new APIConnectionTimeoutError(), {
                cause: new Error('Maximum context length exceeded')
            })
        ]) {
            assert.equal(RetryManager.isNetworkError(error), false);
        }
    });

    test('timeout text alone does not widen network error classification', () => {
        assert.equal(RetryManager.isNetworkError(new Error('Request timed out.')), false);
        assert.equal(RetryManager.isNetworkError(new Error('business operation timeout')), false);
    });

    test('SDK user aborts and VS Code cancellations are not network timeouts', () => {
        assert.equal(RetryManager.isNetworkError(new APIUserAbortError()), false);
        assert.equal(RetryManager.isNetworkError(new vscode.CancellationError()), false);
    });

    for (const sdkMode of ['openai', 'openai-responses'] as const) {
        test(`${sdkMode}: three real failed requests switch to the next key and retain its affinity`, async () => {
            transport(key => (key === wireKeys[0] ? errorResponse() : successResponse(sdkMode)), sdkMode);
            const observed = { grants: 0 };
            const parts: vscode.LanguageModelResponsePart[] = [];
            await RetryProvider.run(sdkMode, defaultRetry, observed, cancellation().token, parts);
            assert.deepEqual(wireKeys, [
                wireKeys[0],
                wireKeys[0],
                wireKeys[0],
                wireKeys[0] === 'key-a' ? 'key-b' : 'key-a'
            ]);
            assert.equal(observed.grants, 4);
            assert.equal(BalanceAffinityCache.instance.get(slot, balanceKey), identity(wireKeys[3]));
            assert.equal(ConfigSetStore.getBalanceExclusions(slot)[0]?.credentialId, identity(wireKeys[0]));
            assert.equal(await ApiKeyManager.getApiKey(slot), 'key-a');
            assert.equal(managerState.balanceLeaseRenewalTimers.size, 0);
            assert.equal(managerState.balanceAttemptSnapshots.size, 0);
            assert.ok(parts.some(part => part instanceof vscode.LanguageModelTextPart && part.value === 'recovered'));
        });

        for (const option of ['disabled', 'zero'] as const) {
            test(`${sdkMode}: ${option} retry allows exactly one real request`, async () => {
                transport(() => errorResponse(), sdkMode);
                const retry = {
                    ...defaultRetry,
                    enabled: option !== 'disabled',
                    maxAttempts: option === 'zero' ? 0 : 3
                };
                const observed = { grants: 0 };
                await assert.rejects(RetryProvider.run(sdkMode, retry, observed, cancellation().token));
                assert.equal(wireKeys.length, 1);
                assert.equal(observed.grants, 1);
                assert.equal(ConfigSetStore.getBalanceExclusions(slot).length, 0);
            });
        }

        test(`${sdkMode}: ordinary retries reacquire the grant for every real request`, async () => {
            await ConfigSetStore.setSwitchMode(slot, 'off');
            transport((_key, count) => (count <= 2 ? errorResponse() : successResponse(sdkMode)), sdkMode);
            const observed = { grants: 0 };
            await RetryProvider.run(sdkMode, defaultRetry, observed, cancellation().token);
            assert.deepEqual(wireKeys, ['key-a', 'key-a', 'key-a']);
            assert.equal(observed.grants, 3);
        });

        for (const kind of ['timeout', 'reset'] as const) {
            test(`${sdkMode}: ordinary connection ${kind} retries through the central grant`, async () => {
                await ConfigSetStore.setSwitchMode(slot, 'off');
                transport((_key, count) => {
                    if (count === 1) {
                        throw new TypeError('fetch failed', {
                            cause: new Error(kind === 'timeout' ? 'connect ETIMEDOUT' : 'read ECONNRESET')
                        });
                    }
                    return successResponse(sdkMode);
                }, sdkMode);
                const observed = { grants: 0 };
                const parts: vscode.LanguageModelResponsePart[] = [];
                await RetryProvider.run(sdkMode, defaultRetry, observed, cancellation().token, parts);
                assert.deepEqual(wireKeys, ['key-a', 'key-a']);
                assert.equal(observed.grants, 2);
                assert.equal(ConfigSetStore.getBalanceExclusions(slot).length, 0);
                assert.ok(
                    parts.some(part => part instanceof vscode.LanguageModelTextPart && part.value === 'recovered')
                );
            });
        }

        for (const option of ['disabled', 'zero'] as const) {
            test(`${sdkMode}: ${option} ordinary timeout retry allows exactly one real request`, async () => {
                await ConfigSetStore.setSwitchMode(slot, 'off');
                transport(() => {
                    throw new TypeError('fetch failed', { cause: new Error('connect ETIMEDOUT') });
                }, sdkMode);
                const observed = { grants: 0 };
                await assert.rejects(
                    RetryProvider.run(
                        sdkMode,
                        { ...defaultRetry, enabled: option !== 'disabled', maxAttempts: option === 'zero' ? 0 : 3 },
                        observed,
                        cancellation().token
                    ),
                    APIConnectionTimeoutError
                );
                assert.deepEqual(wireKeys, ['key-a']);
                assert.equal(observed.grants, 1);
            });
        }

        test(`${sdkMode}: ordinary connection timeouts stop at the configured retry budget`, async () => {
            await ConfigSetStore.setSwitchMode(slot, 'off');
            transport(() => {
                throw new TypeError('fetch failed', { cause: new Error('connect ETIMEDOUT') });
            }, sdkMode);
            const observed = { grants: 0 };
            await assert.rejects(
                RetryProvider.run(sdkMode, defaultRetry, observed, cancellation().token),
                APIConnectionTimeoutError
            );
            assert.deepEqual(wireKeys, ['key-a', 'key-a', 'key-a', 'key-a']);
            assert.equal(observed.grants, 4);
            assert.equal(managerState.pendingBalanceFailures.size, 0);
            assert.equal(managerState.balanceLeaseRenewalTimers.size, 0);
            assert.equal(managerState.balanceAttemptSnapshots.size, 0);
        });

        test(`${sdkMode}: cancellation during a connection timeout stops without retry`, async () => {
            await ConfigSetStore.setSwitchMode(slot, 'off');
            const tracked = cancellation();
            transport(() => {
                tracked.cancel();
                throw new TypeError('fetch failed', { cause: new Error('connect ETIMEDOUT') });
            }, sdkMode);
            const observed = { grants: 0 };
            await assert.rejects(
                RetryProvider.run(sdkMode, defaultRetry, observed, tracked.token),
                vscode.CancellationError
            );
            assert.deepEqual(wireKeys, ['key-a']);
            assert.equal(observed.grants, 1);
            assert.equal(tracked.disposals, tracked.subscriptions);
            assert.equal(managerState.pendingBalanceFailures.size, 0);
        });

        test(`${sdkMode}: ordinary permanent errors are not retried by the SDK`, async () => {
            await ConfigSetStore.setSwitchMode(slot, 'off');
            transport(() => errorResponse(400, 'Maximum context length exceeded'), sdkMode);
            const observed = { grants: 0 };
            await assert.rejects(RetryProvider.run(sdkMode, defaultRetry, observed, cancellation().token));
            assert.equal(wireKeys.length, 1);
            assert.equal(observed.grants, 1);
        });

        for (const sample of [
            { status: 200, message: 'Invalid timeout value: must be positive', code: null },
            { status: 200, message: 'Maximum context length exceeded; request timeout' },
            { status: 200, message: 'Insufficient credits; billing timeout' },
            { status: 200, message: 'Monthly quota exceeded; request timed out.' },
            { status: 200, message: 'Request timed out.', code: 'usage_limit_reached' },
            { status: 200, message: 'Service Unavailable', type: 'usage_limit_reached' },
            { status: 400, message: 'Invalid timeout value: must be positive', code: null },
            { status: 400, message: 'Maximum context length exceeded; request timeout' },
            { status: 403, message: 'Insufficient credits; billing timeout' },
            { status: 429, message: 'Monthly quota exceeded; request timed out.' },
            { status: 429, message: 'Request timed out.', code: 'usage_limit_reached' },
            { status: 502, message: 'Bad Gateway', code: 'usage_limit_reached' },
            { status: 503, message: 'Service Unavailable', code: 'insufficient_credits' },
            { status: 500, message: 'Internal Server Error', code: 'usage_limit_reached' },
            { status: 504, message: 'Gateway Timeout', type: 'usage_limit_reached' }
        ]) {
            test(`${sdkMode}: HTTP ${sample.status} ${sample.message} preserves its error without retry`, async () => {
                await ConfigSetStore.setSwitchMode(slot, 'off');
                transport(() => errorResponse(sample.status, sample.message, sample.code, sample.type), sdkMode);
                const observed = { grants: 0 };
                await assert.rejects(
                    RetryProvider.run(sdkMode, defaultRetry, observed, cancellation().token),
                    error => {
                        assert.equal(wireKeys.length, 1);
                        assert.equal(observed.grants, 1);
                        assert.ok(error instanceof APIError);
                        assert.ok(!(error instanceof APIConnectionTimeoutError));
                        assert.equal(error.status, sample.status);
                        assert.equal(error.code, sample.code);
                        assert.equal(error.type, sample.type);
                        assert.deepEqual(error.error, {
                            message: sample.message,
                            ...(sample.code !== undefined ? { code: sample.code } : {}),
                            ...(sample.type !== undefined ? { type: sample.type } : {})
                        });
                        assert.ok(error.message.includes(sample.message));
                        assert.equal(error.requestID, 'retry-http-error');
                        assert.equal(error.headers?.get('retry-after'), '2');
                        return true;
                    }
                );
            });
        }

        test(`${sdkMode}: top-level JSON HTTP errors retain their message and permanent code`, async () => {
            await ConfigSetStore.setSwitchMode(slot, 'off');
            transport(
                () =>
                    new Response(JSON.stringify({ message: 'upstream rejection', code: 'usage_limit_reached' }), {
                        status: 429,
                        headers: { 'content-type': 'application/json' }
                    }),
                sdkMode
            );
            const observed = { grants: 0 };
            await assert.rejects(RetryProvider.run(sdkMode, defaultRetry, observed, cancellation().token), error => {
                assert.equal(wireKeys.length, 1);
                assert.equal(observed.grants, 1);
                assert.ok(error instanceof APIError);
                assert.equal(error.status, 429);
                assert.equal(error.code, 'usage_limit_reached');
                assert.ok(error.message.includes('upstream rejection'));
                return true;
            });
        });

        for (const status of [200, 429]) {
            const message = 'Monthly quota exceeded';
            for (const [name, payload, expectedMessage] of [
                ['JSON string', message, message],
                ['JSON array', [message], message],
                ['true error', { error: true, message }, message],
                ['false error', { error: false, message }, message],
                ['null error', { error: null, message }, message],
                ['empty error', { error: {}, message }, message],
                ['empty message', { error: { message: '' }, message }, message],
                ['blank message', { error: { message: ' ' }, message }, message],
                ['raw fallback', { error: true, details: { message } }, message],
                ['nested code', { error: { code: 'usage_limit_reached' }, message }, message],
                ['outer code', { error: 'Request timed out.', code: 'usage_limit_reached' }, 'Request timed out.'],
                [
                    'outer balance',
                    { error: { message: 'Service Unavailable' }, current_balance: 0 },
                    'Service Unavailable'
                ]
            ] as const) {
                test(`${sdkMode}: HTTP ${status} ${name} retains its permanent error`, async () => {
                    await ConfigSetStore.setSwitchMode(slot, 'off');
                    transport(
                        () =>
                            new Response(JSON.stringify(payload), {
                                status,
                                headers: { 'content-type': 'application/json', 'x-request-id': 'json-fallback' }
                            }),
                        sdkMode
                    );
                    const observed = { grants: 0 };
                    const parts: vscode.LanguageModelResponsePart[] = [];
                    await assert.rejects(
                        RetryProvider.run(sdkMode, defaultRetry, observed, cancellation().token, parts),
                        error => {
                            assert.deepEqual(wireKeys, ['key-a']);
                            assert.equal(observed.grants, 1);
                            assert.ok(error instanceof APIError);
                            assert.ok(!(error instanceof APIConnectionTimeoutError));
                            assert.equal(error.status, status);
                            assert.equal(error.requestID, 'json-fallback');
                            assert.ok(error.message.includes(expectedMessage));
                            if (name === 'nested code' || name === 'outer code') {
                                assert.equal(error.code, 'usage_limit_reached');
                            }
                            return true;
                        }
                    );
                    assert.equal(parts.length, 0);
                });
            }
        }

        for (const option of ['retry', 'disabled', 'zero', 'cancel'] as const) {
            test(`${sdkMode}: HTTP200 transient business errors respect ${option}`, async () => {
                await ConfigSetStore.setSwitchMode(slot, 'off');
                const tracked = cancellation();
                transport((_key, count) => {
                    if (option === 'cancel') {
                        tracked.cancel();
                    }
                    return count === 1 ? errorResponse(200) : successResponse(sdkMode);
                }, sdkMode);
                const observed = { grants: 0 };
                const retry = {
                    ...defaultRetry,
                    enabled: option !== 'disabled',
                    maxAttempts: option === 'zero' ? 0 : 3
                };
                const request = RetryProvider.run(sdkMode, retry, observed, tracked.token);
                if (option === 'retry') {
                    await request;
                } else {
                    await assert.rejects(request, option === 'cancel' ? vscode.CancellationError : APIError);
                }
                assert.equal(wireKeys.length, option === 'retry' ? 2 : 1);
                assert.equal(observed.grants, wireKeys.length);
                assert.equal(tracked.disposals, tracked.subscriptions);
            });
        }

        if (sdkMode === 'openai-responses') {
            test('Responses JSON errors without Content-Type retain their permanent code', async () => {
                await ConfigSetStore.setSwitchMode(slot, 'off');
                transport(() => {
                    const body = JSON.stringify({
                        error: { message: 'Request timed out.', code: 'usage_limit_reached' }
                    });
                    const response = new Response(new TextEncoder().encode(body), {
                        headers: { 'x-request-id': 'sniffed-json' }
                    });
                    Object.defineProperty(response, 'url', { value: 'https://balance-retry.test/v1/responses' });
                    return response;
                }, sdkMode);
                const observed = { grants: 0 };
                await assert.rejects(
                    RetryProvider.run(sdkMode, defaultRetry, observed, cancellation().token),
                    error => {
                        assert.equal(wireKeys.length, 1);
                        assert.equal(observed.grants, 1);
                        assert.ok(error instanceof APIError);
                        assert.equal(error.status, 200);
                        assert.equal(error.code, 'usage_limit_reached');
                        assert.equal(error.requestID, 'sniffed-json');
                        assert.equal(error.headers?.get('content-type'), null);
                        return true;
                    }
                );
            });
        }

        for (const format of ['string', 'text'] as const) {
            test(`${sdkMode}: ${format} HTTP permanent errors retain their original message`, async () => {
                await ConfigSetStore.setSwitchMode(slot, 'off');
                const message = 'Monthly quota exceeded; request timeout';
                transport(
                    () =>
                        new Response(format === 'string' ? JSON.stringify({ error: message }) : message, {
                            status: 429,
                            headers: { 'content-type': format === 'string' ? 'application/json' : 'text/plain' }
                        }),
                    sdkMode
                );
                const observed = { grants: 0 };
                await assert.rejects(
                    RetryProvider.run(sdkMode, defaultRetry, observed, cancellation().token),
                    error => {
                        assert.equal(wireKeys.length, 1);
                        assert.equal(observed.grants, 1);
                        assert.ok(error instanceof APIError);
                        assert.ok(!(error instanceof APIConnectionTimeoutError));
                        assert.equal(error.status, 429);
                        assert.ok(error.message.includes(message));
                        return true;
                    }
                );
            });
        }

        for (const status of [429, 502, 503, 504]) {
            test(`${sdkMode}: plain-text HTTP ${status} retries by status with one grant per request`, async () => {
                await ConfigSetStore.setSwitchMode(slot, 'off');
                transport(
                    (_key, count) =>
                        count === 1 ?
                            new Response('upstream rejection', { status, headers: { 'content-type': 'text/plain' } })
                        :   successResponse(sdkMode),
                    sdkMode
                );
                const observed = { grants: 0 };
                const parts: vscode.LanguageModelResponsePart[] = [];
                await RetryProvider.run(sdkMode, defaultRetry, observed, cancellation().token, parts);
                assert.deepEqual(wireKeys, ['key-a', 'key-a']);
                assert.equal(observed.grants, 2);
                assert.ok(
                    parts.some(part => part instanceof vscode.LanguageModelTextPart && part.value === 'recovered')
                );
            });
        }

        for (const format of ['sse', 'response.failed', 'error'] as const) {
            if (sdkMode === 'openai' && format !== 'sse') {
                continue;
            }
            for (const sample of [
                { message: 'Service Unavailable', code: 'usage_limit_reached' },
                { message: 'Bad Gateway', code: 'insufficient_credits' },
                { message: 'Service Unavailable', type: 'usage_limit_reached' },
                { message: 'Service Unavailable', current_balance: 0 },
                { message: 'Monthly quota exceeded' },
                { message: 'upstream rejected', code: 'rate_limit_exceeded', recover: true },
                { message: 'Service Unavailable', recover: true }
            ]) {
                if (format === 'error' && sample.type) {
                    continue;
                }
                const detail = {
                    message: sample.message,
                    ...(sample.code !== undefined ? { code: sample.code } : {}),
                    ...(sample.type !== undefined ? { type: sample.type } : {}),
                    ...(sample.current_balance !== undefined ? { current_balance: sample.current_balance } : {})
                };
                const event =
                    format === 'sse' ? { error: detail }
                    : format === 'response.failed' ?
                        { type: format, response: { id: 'stream-error', status: 'failed', output: [], error: detail } }
                    :   { type: 'error', sequence_number: 0, param: null, ...detail };
                test(`${sdkMode}: ${format} preserves ${JSON.stringify(detail)}`, async () => {
                    await ConfigSetStore.setSwitchMode(slot, 'off');
                    transport(
                        (_key, count) =>
                            sample.recover && count > 1 ?
                                successResponse(sdkMode)
                            :   new Response(`data: ${JSON.stringify(event)}\n\ndata: [DONE]\n\n`, {
                                    headers: { 'content-type': 'text/event-stream', 'x-request-id': 'sse-error' }
                                }),
                        sdkMode
                    );
                    const tracked = cancellation();
                    const observed = { grants: 0 };
                    const parts: vscode.LanguageModelResponsePart[] = [];
                    const request = RetryProvider.run(sdkMode, defaultRetry, observed, tracked.token, parts);
                    if (sample.recover) {
                        await request;
                        assert.ok(
                            parts.some(
                                part => part instanceof vscode.LanguageModelTextPart && part.value === 'recovered'
                            )
                        );
                    } else {
                        await assert.rejects(request, error => {
                            assert.ok(error instanceof APIError);
                            assert.equal(error.status, undefined);
                            assert.equal(error.code, sample.code);
                            assert.equal(error.message, sample.message);
                            assert.deepEqual(error.error, format === 'error' ? event : detail);
                            if (format === 'sse') {
                                assert.equal(error.requestID, 'sse-error');
                            }
                            return true;
                        });
                        assert.equal(parts.length, 0);
                    }
                    assert.equal(wireKeys.length, sample.recover ? 2 : 1);
                    assert.equal(observed.grants, wireKeys.length);
                    assert.equal(tracked.disposals, tracked.subscriptions);
                });
            }
        }

        test(`${sdkMode}: an exhausted balance pool stops at the central retry budget`, async () => {
            transport(() => errorResponse(), sdkMode);
            const observed = { grants: 0 };
            await assert.rejects(RetryProvider.run(sdkMode, defaultRetry, observed, cancellation().token));
            assert.equal(observed.grants, 7);
            assert.equal(wireKeys.length, observed.grants);
            assert.equal(managerState.balanceLeaseRenewalTimers.size, 0);
            assert.equal(managerState.balanceAttemptSnapshots.size, 0);
        });
    }

    for (const boundary of ['reply', 'publish-failure', 'timeout', 'mode-change', 'authority-loss'] as const) {
        test(`failure coordination cleans the timer and listener on ${boundary}`, async () => {
            const tracked = cancellation();
            if (boundary === 'publish-failure') {
                const originalPublish = InterInstanceBus.publishIpcOnly;
                InterInstanceBus.publishIpcOnly = event => {
                    originalPublish(event);
                    return false;
                };
            }
            const decision = reportFailure(undefined, tracked.token);
            assert.equal(published.length, 1);
            if (boundary === 'reply') {
                reply();
            } else if (boundary === 'timeout') {
                pendingTimers[0]._onTimeout();
            } else if (boundary === 'mode-change') {
                ApiKeyFailoverManager.handleBalanceModeChanged(slot);
            } else if (boundary === 'authority-loss') {
                ApiKeyFailoverManager.handleBalanceAuthorityLost();
            }
            assert.deepEqual(
                await decision,
                boundary === 'reply' ? switched
                : boundary === 'publish-failure' ? { handled: false, shouldRetry: false, switched: false }
                : stopped
            );
            assertClean(tracked);
            reply();
            tracked.cancel();
            assertClean(tracked);
        });
    }

    test('publication exceptions preserve the error and clean the pending resources', async () => {
        const tracked = cancellation();
        const originalPublish = InterInstanceBus.publishIpcOnly;
        const error = new Error('transport closed');
        InterInstanceBus.publishIpcOnly = event => {
            originalPublish(event);
            throw error;
        };
        await assert.rejects(reportFailure(undefined, tracked.token), caught => caught === error);
        assertClean(tracked);
        reply();
        assertClean(tracked);
    });

    test('cancellation ends an already-published failure wait without its timeout', async () => {
        const tracked = cancellation();
        const decision = reportFailure(undefined, tracked.token);
        tracked.cancel();
        assert.equal(
            await Promise.race([
                decision.then(() => 'settled'),
                new Promise<string>(resolve => setImmediate(() => resolve('pending')))
            ]),
            'settled'
        );
        assert.deepEqual(await decision, stopped);
        assertClean(tracked);
        reply();
        assertClean(tracked);
    });

    test('already-cancelled failure does not publish or subscribe', async () => {
        const tracked = cancellation();
        tracked.cancel();
        assert.deepEqual(await reportFailure(undefined, tracked.token), stopped);
        assert.equal(published.length, 0);
        assert.equal(tracked.subscriptions, 0);
        assert.equal(managerState.pendingBalanceFailures.size, 0);
    });

    test('cancellation during listener registration disposes the subscription without publication', async () => {
        const tracked = cancellation(true);
        const decision = reportFailure(undefined, tracked.token);
        assert.equal(published.length, 0);
        assert.deepEqual(await decision, stopped);
        assertClean(tracked);
    });

    test('cancellation during publication wins over a late switched reply', async () => {
        const tracked = cancellation();
        const originalPublish = InterInstanceBus.publishIpcOnly;
        InterInstanceBus.publishIpcOnly = event => {
            originalPublish(event);
            tracked.cancel();
            reply();
            return true;
        };
        assert.deepEqual(await reportFailure(undefined, tracked.token), stopped);
        assertClean(tracked);
    });

    test('a reply received before cancellation keeps its decision and disposes only once', async () => {
        const tracked = cancellation();
        const decision = reportFailure(undefined, tracked.token);
        reply();
        tracked.cancel();
        assert.deepEqual(await decision, switched);
        assertClean(tracked);
    });

    test('mode changes stop only the affected slot and preserve other waits', async () => {
        await ConfigSetStore.setSwitchMode('other-slot', 'balance');
        const first = cancellation();
        const second = cancellation();
        const firstDecision = reportFailure(undefined, first.token);
        const secondDecision = reportFailure('other-slot', second.token);
        ApiKeyFailoverManager.handleBalanceModeChanged(slot);
        assert.deepEqual(await firstDecision, stopped);
        assert.equal(first.disposals, 1);
        assert.equal(second.disposals, 0);
        assert.equal(managerState.pendingBalanceFailures.size, 1);
        reply(1);
        assert.deepEqual(await secondDecision, switched);
        assert.equal(second.disposals, 1);
        assert.ok(pendingTimers.every(timer => timer._destroyed));
    });

    test('an off-mode failure does not publish or register a cancellation listener', async () => {
        await ConfigSetStore.setSwitchMode(slot, 'off');
        const tracked = cancellation();
        assert.deepEqual(await reportFailure(undefined, tracked.token), {
            handled: false,
            shouldRetry: false,
            switched: false
        });
        assert.equal(published.length, 0);
        assert.equal(tracked.subscriptions, 0);
    });

    test('cancelling the third Follower failure releases its snapshot and heartbeat exactly once', async () => {
        LeaderElectionService.isLeader = () => false;
        const tracked = cancellation();
        const leaseId = 'follower-retry-lease';
        const released: string[] = [];
        let reportStarted: (() => void) | undefined;
        const reporting = new Promise<void>(resolve => {
            reportStarted = resolve;
        });
        const originalPublish = InterInstanceBus.publishIpcOnly;
        InterInstanceBus.publishIpcOnly = event => {
            if (event.type === 'apiKeyBalanceAssignmentRequested') {
                const payload = event.payload as { requestId: string };
                queueMicrotask(() =>
                    ApiKeyFailoverManager.resolveBalanceAssignment({
                        requestId: payload.requestId,
                        targetInstanceId: 'retry-instance',
                        authorityTerm: term,
                        handled: true,
                        configId: 'a',
                        credentialId: identity('key-a'),
                        leaseId,
                        expiresAt: Date.now() + 30_000
                    })
                );
            } else if (event.type === 'apiKeyBalanceFailureReported') {
                originalPublish(event);
                reportStarted?.();
            } else if (event.type === 'apiKeyBalanceLeaseReleased') {
                released.push((event.payload as { leaseId: string }).leaseId);
            }
            return true;
        };
        transport(() => errorResponse(), 'openai');
        const observed = { grants: 0 };
        const request = RetryProvider.run('openai', defaultRetry, observed, tracked.token);
        const completed = request.then(
            () => 'resolved',
            () => 'rejected'
        );
        await Promise.race([reporting, request]);
        assert.equal(published.length, 1);
        assert.equal(managerState.balanceLeaseRenewalTimers.has(leaseId), true);
        tracked.cancel();
        assert.equal(
            await Promise.race([completed, new Promise<string>(resolve => setImmediate(() => resolve('pending')))]),
            'rejected'
        );
        assert.equal(observed.grants, 3);
        assert.deepEqual(wireKeys, ['key-a', 'key-a', 'key-a']);
        assert.deepEqual(released, [leaseId]);
        assert.equal(managerState.pendingBalanceFailures.size, 0);
        assert.equal(managerState.balanceLeaseRenewalTimers.has(leaseId), false);
        assert.equal(managerState.balanceAttemptSnapshots.size, 0);
        assert.equal(tracked.disposals, tracked.subscriptions);
    });
});
