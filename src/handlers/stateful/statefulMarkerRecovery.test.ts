import assert from 'node:assert/strict';
import test from 'node:test';
import type { RequestClassification } from '../classification/requestClassification';
import { canRestoreMarkerSession, getMarkerBalanceCredential } from './statefulMarkerRecovery';

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

const marker = {
    extension: 'vicanent.gcmp',
    sessionId: 'session',
    provider: 'slot',
    modelId: 'model',
    sdkMode: 'openai',
    subSessionId: undefined as string | undefined,
    balanceAffinity: { slot: 'slot', balanceKey: 's:session', credentialId: 'a'.repeat(64) }
};
const expected = {
    sessionId: 'session',
    subSessionId: undefined as string | undefined,
    provider: 'slot',
    modelId: 'model',
    sdkMode: 'openai',
    balanceKey: 's:session'
};

test('unknown roles can restore local statistics without acquiring a marker role', () => {
    const context = { ...classification(), requestKind: 'unknown' as const, agentRole: 'undetermined' as const };
    assert.equal(canRestoreMarkerSession(marker, context), true);
    assert.equal(context.agentRole, 'undetermined');
    assert.equal(canRestoreMarkerSession({ ...marker, extension: 'foreign' }, context), false);
});

test('a confirmed SDK subagent cannot identify itself with an inherited parent marker', () => {
    const child = { ...classification(), agentRole: 'subagent' as const };
    assert.equal(canRestoreMarkerSession(marker, child), false);
    assert.equal(
        canRestoreMarkerSession(
            {
                ...marker,
                subSessionId: 'sub_id',
                continuity: { version: 1, scope: 'subagent', agentRole: 'subagent' }
            },
            child
        ),
        true
    );
    assert.equal(canRestoreMarkerSession(marker, { ...child, requestOrigin: 'copilot-chat' }), true);
});

test('compatible marker affinity restores a fingerprint, never a credential secret', () => {
    assert.equal(getMarkerBalanceCredential(marker, expected), 'a'.repeat(64));
});

for (const field of ['extension', 'sessionId', 'subSessionId', 'provider', 'modelId', 'sdkMode'] as const) {
    test(`affinity rejects a marker with a different ${field}`, () => {
        assert.equal(getMarkerBalanceCredential({ ...marker, [field]: 'other' }, expected), undefined);
    });
}
for (const field of ['slot', 'balanceKey', 'credentialId'] as const) {
    test(`affinity rejects an invalid ${field}`, () => {
        assert.equal(
            getMarkerBalanceCredential(
                { ...marker, balanceAffinity: { ...marker.balanceAffinity, [field]: 'invalid' } },
                expected
            ),
            undefined
        );
    });
}

test('已确认主代理不能恢复子代理 marker，未知角色不从 marker 获取角色', () => {
    const childMarker = {
        ...marker,
        subSessionId: 'sub_id',
        continuity: { version: 1, scope: 'subagent', agentRole: 'subagent' }
    };
    assert.equal(canRestoreMarkerSession(childMarker, classification()), false);
    const unknown = { ...classification(), agentRole: 'undetermined' as const };
    assert.equal(canRestoreMarkerSession(childMarker, unknown), true);
    assert.equal(unknown.agentRole, 'undetermined');
});

test('会话恢复安全拒绝非对象、空会话和非字符串子会话', () => {
    for (const invalid of [
        undefined,
        null,
        [],
        'marker',
        {},
        { ...marker, sessionId: '' },
        { ...marker, sessionId: 123 },
        { ...marker, subSessionId: null },
        { ...marker, subSessionId: 123 },
        { ...marker, subSessionId: '' }
    ]) {
        assert.equal(canRestoreMarkerSession(invalid, classification()), false);
    }
});

test('非旧来源子代理恢复要求准确的 v1 子代理连续性，不接受空 ID', () => {
    const child = { ...classification(), requestKind: 'subagent' as const, agentRole: 'subagent' as const };
    for (const continuity of [
        undefined,
        null,
        [],
        {},
        { version: 2, scope: 'subagent', agentRole: 'subagent' },
        { version: '1', scope: 'subagent', agentRole: 'subagent' },
        { version: 1, scope: 'chain', agentRole: 'subagent' },
        { version: 1, scope: 'subagent', agentRole: 'main' }
    ]) {
        assert.equal(canRestoreMarkerSession({ ...marker, subSessionId: 'sub_id', continuity }, child), false);
    }
    for (const requestOrigin of ['copilot-sdk', 'gcmp', 'core', 'other-extension', 'unknown'] as const) {
        assert.equal(canRestoreMarkerSession(marker, { ...child, requestOrigin }), false);
    }
});

test('凭据恢复不将字符串外观对象、空字段和缺失 affinity 当作有效凭据', () => {
    for (const invalid of [undefined, null, [], 'marker', {}, { ...marker, balanceAffinity: null }]) {
        assert.equal(getMarkerBalanceCredential(invalid, expected), undefined);
    }
    for (const credentialId of [
        undefined,
        null,
        123,
        'A'.repeat(64),
        'a'.repeat(63),
        'a'.repeat(65),
        { toString: () => 'a'.repeat(64) }
    ]) {
        assert.equal(
            getMarkerBalanceCredential(
                { ...marker, balanceAffinity: { ...marker.balanceAffinity, credentialId } },
                expected
            ),
            undefined
        );
    }
    for (const field of ['sessionId', 'provider', 'modelId', 'sdkMode', 'balanceKey'] as const) {
        for (const value of ['', null, undefined, 123]) {
            const invalidExpected = { ...expected, [field]: value } as unknown as typeof expected;
            const matchingMarker = {
                ...marker,
                [field]: value,
                balanceAffinity: {
                    ...marker.balanceAffinity,
                    ...(field === 'balanceKey' ? { balanceKey: value } : {}),
                    ...(field === 'provider' ? { slot: value } : {})
                }
            };
            assert.equal(getMarkerBalanceCredential(matchingMarker, invalidExpected), undefined);
        }
    }
});

test('凭据恢复严格匹配子会话、slot 和实际 wire 模型，不放宽为外层模型别名', () => {
    const child = { ...marker, subSessionId: 'sub_id' };
    assert.equal(getMarkerBalanceCredential(child, { ...expected, subSessionId: 'sub_id' }), 'a'.repeat(64));
    assert.equal(getMarkerBalanceCredential(child, expected), undefined);
    assert.equal(getMarkerBalanceCredential(marker, { ...expected, subSessionId: 'sub_id' }), undefined);
    assert.equal(getMarkerBalanceCredential(marker, { ...expected, modelId: 'gcmp.slot:::model' }), undefined);
    assert.equal(
        getMarkerBalanceCredential(
            { ...marker, balanceAffinity: { ...marker.balanceAffinity, slot: 'other-slot' } },
            expected
        ),
        undefined
    );
    for (const subSessionId of ['', null, 123]) {
        assert.equal(
            getMarkerBalanceCredential({ ...marker, subSessionId }, {
                ...expected,
                subSessionId
            } as unknown as typeof expected),
            undefined
        );
    }
});

test('marker 边界忽略抛错访问器和撤销 Proxy，不阻断请求', () => {
    const invalid = Object.defineProperty({}, 'extension', {
        get() {
            throw new Error('broken marker');
        }
    });
    const revocable = Proxy.revocable({}, {});
    revocable.revoke();
    for (const value of [invalid, revocable.proxy]) {
        assert.equal(canRestoreMarkerSession(value, classification()), false);
        assert.equal(getMarkerBalanceCredential(value, expected), undefined);
    }
    for (const value of [undefined, null, revocable.proxy]) {
        assert.equal(getMarkerBalanceCredential(marker, value as unknown as typeof expected), undefined);
    }
});
