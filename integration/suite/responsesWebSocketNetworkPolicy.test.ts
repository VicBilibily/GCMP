import assert from 'node:assert/strict';
import { createLiveResponsesFixture } from '../fixtures/responsesWebSocketLiveFixture';
import type { LiveResponsesOptions } from '../fixtures/responsesWebSocketLiveFixture';

interface PolicyCase {
    name: string;
    options: LiveResponsesOptions;
    succeeds: boolean;
    usesProxy?: boolean;
}

const policies: readonly PolicyCase[] = [
    { name: 'trusted direct WSS', options: { network: { tls: 'valid' }, trusted: true }, succeeds: true },
    {
        name: 'production untrusted WSS',
        options: { network: { tls: 'valid' }, productionRouting: true },
        succeeds: false
    },
    {
        name: 'production explicit CONNECT',
        options: { network: { proxy: 'forward' }, proxy: 'configured', productionRouting: true },
        succeeds: true,
        usesProxy: true
    },
    {
        name: 'production authenticated CONNECT',
        options: { network: { proxy: 'auth' }, proxy: 'configured', productionRouting: true },
        succeeds: true,
        usesProxy: true
    },
    {
        name: 'production rejected proxy never bypasses',
        options: { network: { proxy: 'reject' }, proxy: 'configured', productionRouting: true },
        succeeds: false,
        usesProxy: true
    },
    {
        name: 'trusted WSS via CONNECT',
        options: { network: { tls: 'valid', proxy: 'forward' }, proxy: 'configured', trusted: true },
        succeeds: true,
        usesProxy: true
    },
    {
        name: 'untrusted target never bypasses',
        options: { network: { tls: 'valid', proxy: 'forward' }, proxy: 'configured' },
        succeeds: false,
        usesProxy: true
    },
    {
        name: 'independently trusted HTTPS proxy',
        options: {
            network: { tls: 'valid', proxy: 'forward', secureProxy: true },
            proxy: 'configured',
            trusted: true,
            proxyTrusted: true
        },
        succeeds: true,
        usesProxy: true
    },
    {
        name: 'untrusted HTTPS proxy never bypasses',
        options: { network: { tls: 'valid', proxy: 'forward', secureProxy: true }, proxy: 'configured', trusted: true },
        succeeds: false
    },
    {
        name: 'controlled environment proxy',
        options: { network: { proxy: 'forward' }, proxy: 'system', environment: 'proxy' },
        succeeds: true,
        usesProxy: true
    },
    {
        name: 'controlled NO_PROXY',
        options: { network: { proxy: 'reject' }, proxy: 'system', environment: 'no-proxy' },
        succeeds: true
    },
    {
        name: 'production noproxy overrides environment',
        options: { network: { proxy: 'reject' }, productionRouting: true, environment: 'proxy' },
        succeeds: true
    }
];

suite('Responses WebSocket roundtrip network policy', function () {
    this.timeout(30_000);
    if (process.env.GCMP_WS_HOST_E2E !== '1') {
        return;
    }
    for (const policy of policies) {
        test(`WS-LOOP-06: public network ${policy.name}`, async () => {
            const environmentKeys = ['HTTP_PROXY', 'http_proxy', 'HTTPS_PROXY', 'https_proxy', 'NO_PROXY', 'no_proxy'];
            const previousEnvironment = environmentKeys.map(key => process.env[key]);
            const fixture = await createLiveResponsesFixture('text', policy.options);
            try {
                if (!policy.options.productionRouting) {
                    assert.deepEqual(
                        environmentKeys.map(key => process.env[key]),
                        previousEnvironment
                    );
                }
                const result = fixture
                    .begin(fixture.history('network policy'), 1)
                    .result.catch(async (error: unknown) => {
                        if (!policy.succeeds) {
                            throw error;
                        }
                        const cause = error instanceof Error ? error.cause : undefined;
                        const nested = cause instanceof Error ? cause.cause : undefined;
                        throw new Error(
                            JSON.stringify({
                                error: error instanceof Error ? error.message : 'unknown',
                                cause: cause instanceof Error ? cause.message : undefined,
                                nested: nested instanceof Error ? nested.message : undefined,
                                snapshot: await fixture.mock.snapshot(),
                                network: fixture.networkDiagnostics(),
                                counters: fixture.counters(),
                                statuses: fixture.updates.map(update => update.status)
                            })
                        );
                    });
                if (policy.succeeds) {
                    const parts = await result;
                    assert.equal(fixture.text(parts), 'mock response');
                    fixture.assertNoMarkers(parts);
                    assert.equal(fixture.updates.filter(update => update.status === 'completed').length, 1);
                } else {
                    await assert.rejects(result);
                    assert.equal(
                        fixture.updates.filter(update => update.status === 'failed').length,
                        1,
                        JSON.stringify(fixture.updates)
                    );
                }
                const observed = await fixture.mock.snapshot();
                assert.equal(observed.accepted, policy.succeeds ? 1 : 0);
                assert.equal(observed.handshakes, policy.succeeds ? 1 : 0);
                assert.equal(observed.httpAccepted, 0);
                if (policy.usesProxy) {
                    assert.ok(observed.connects >= 1);
                } else {
                    assert.equal(observed.connects, 0);
                }
                assert.equal(fixture.estimates.length, 1);
                assert.equal(fixture.provider.grants, policy.succeeds ? 1 : 2);
                if (policy.succeeds) {
                    assert.equal(fixture.counters().captures, 0);
                }
                await fixture.close();
            } finally {
                await fixture.dispose();
            }
        });
    }
});
