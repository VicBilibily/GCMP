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
