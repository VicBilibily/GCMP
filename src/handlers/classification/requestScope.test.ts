import assert from 'node:assert/strict';
import test from 'node:test';
import { getScopedRequestClassification, type RequestClassification } from './requestClassification';
import { ProviderRequestScopes } from './requestScope';

function classification(origin: RequestClassification['requestOrigin'] = 'copilot-sdk'): RequestClassification {
    return {
        version: 1,
        requestKind: 'main-agent',
        requestOrigin: origin,
        agentRole: 'main',
        evidence: {
            origin: { level: 'signature' },
            purpose: { level: 'signature' },
            role: { level: 'signature' }
        }
    };
}

test('scope creation clones options and modelOptions and replaces stale projections', () => {
    const scopes = new ProviderRequestScopes();
    const options = Object.freeze({
        modelOptions: Object.freeze({ requestKind: 'chat-title', subSessionId: 'stale', temperature: 0 })
    });
    const result = scopes.create(options, () => classification());
    assert.notEqual(result, options);
    assert.notEqual(result.modelOptions, options.modelOptions);
    assert.equal(result.modelOptions.requestKind, 'main-agent');
    assert.equal(result.modelOptions.subSessionId, undefined);
    assert.equal(result.modelOptions.temperature, 0);
    assert.equal(options.modelOptions.requestKind, 'chat-title');
    assert.equal(options.modelOptions.subSessionId, 'stale');
    assert.equal(scopes.get(options), undefined);
});

test('scope clone 注册纯分类上下文且不把上下文写入原 options 或请求 body', () => {
    const scopes = new ProviderRequestScopes();
    const original = Object.freeze({ modelOptions: Object.freeze({ requestKind: 'chat-title', temperature: 0 }) });
    const context = classification();
    const scoped = scopes.create(original, () => context);
    assert.equal(getScopedRequestClassification(scoped), context);
    assert.equal(getScopedRequestClassification(original), undefined);
    assert.equal(scopes.get(scoped)?.classification, context);
    assert.deepEqual(Object.keys(scoped), ['modelOptions']);
    assert.deepEqual(Object.keys(scoped.modelOptions).sort(), ['requestKind', 'temperature']);
});

test('reusing original options creates independent classification and continuity contexts', async () => {
    const scopes = new ProviderRequestScopes();
    const original = { modelOptions: { requestKind: 'chat-title' } };
    const [left, right] = await Promise.all([
        Promise.resolve().then(() => scopes.create(original, () => classification())),
        Promise.resolve().then(() =>
            scopes.create(original, () => ({ ...classification('copilot-chat'), requestKind: 'summarization' }))
        )
    ]);
    assert.notEqual(left, right);
    assert.equal(scopes.get(left)?.classification.requestKind, 'main-agent');
    assert.equal(scopes.get(right)?.classification.requestKind, 'summarization');
    assert.equal(getScopedRequestClassification(left), scopes.get(left)?.classification);
    assert.equal(getScopedRequestClassification(right), scopes.get(right)?.classification);
    assert.equal(original.modelOptions.requestKind, 'chat-title');
});

test('only a one-shot delegated local scope is reused by a super entry', () => {
    const scopes = new ProviderRequestScopes();
    const local = scopes.create({}, () => classification());
    scopes.delegate(local);
    assert.equal(
        scopes.create(local, () => {
            throw new Error('must not classify preprocessed messages');
        }),
        local
    );
    const later = scopes.create(local, () => ({ ...classification(), requestKind: 'unknown' }));
    assert.notEqual(later, local);
    assert.equal(scopes.get(later)?.classification.requestKind, 'unknown');
    assert.equal(getScopedRequestClassification(local)?.requestKind, 'main-agent');
    assert.equal(getScopedRequestClassification(later)?.requestKind, 'unknown');
    const external = {};
    scopes.delegate(external);
    assert.notEqual(
        scopes.create(external, () => classification()),
        external
    );
});

test('source behavior preserves the existing origin, evidence, role and purpose gates', () => {
    for (const origin of ['copilot-sdk', 'copilot-chat', 'unknown', 'core', 'gcmp', 'other-extension'] as const) {
        for (const level of ['unknown', 'heuristic', 'signature', 'contract'] as const) {
            for (const role of ['main', 'subagent', 'undetermined', 'not-applicable'] as const) {
                for (const requestKind of ['main-agent', 'chat-title', 'summarization', 'subagent'] as const) {
                    const context = classification(origin);
                    context.evidence.purpose.level = level;
                    context.agentRole = role;
                    context.requestKind = requestKind;
                    const before = structuredClone(context);
                    const scopes = new ProviderRequestScopes();
                    const scoped = scopes.create({}, () => context);
                    const verified = origin === 'copilot-chat' && (level === 'signature' || level === 'contract');
                    assert.deepEqual(scopes.get(scoped)?.behavior, {
                        kind:
                            origin === 'copilot-sdk' ? 'sdk'
                            : verified ? 'copilot-chat'
                            : 'fallback',
                        cacheUsage: origin === 'copilot-sdk' && role === 'main' && requestKind === 'main-agent',
                        legacyTurnAffinity: verified && role === 'main' && requestKind === 'main-agent',
                        auxiliaryResponse:
                            !verified ? undefined
                            : requestKind === 'chat-title' ? 'title'
                            : requestKind === 'summarization' ? 'summary'
                            : undefined
                    });
                    assert.deepEqual(context, before);
                }
            }
        }
    }
});

test('delegation keeps the same behavior without putting policy into caller options', () => {
    const scopes = new ProviderRequestScopes();
    const original = { modelOptions: { requestKind: 'stale' } };
    const local = scopes.create(original, () => classification());
    const behavior = scopes.get(local)?.behavior;
    scopes.delegate(local);
    const delegated = scopes.create(local, () => classification('copilot-chat'));
    assert.equal(scopes.get(delegated)?.behavior, behavior);
    assert.equal('behavior' in local, false);
    assert.equal('behavior' in local.modelOptions, false);
    assert.equal('behavior' in original, false);
});
