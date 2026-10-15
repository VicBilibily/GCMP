import assert from 'node:assert/strict';
import test from 'node:test';
import * as classification from './requestClassification';
import type { DimensionEvidence, RequestClassification, RequestClassificationMetadata } from './requestClassification';

function metadata(overrides: Partial<RequestClassificationMetadata> = {}): RequestClassificationMetadata {
    return {
        version: 1,
        requestOrigin: 'copilot-sdk',
        agentRole: 'undetermined',
        evidence: {
            origin: { level: 'signature', ruleId: 'origin.sdk-identity' },
            purpose: { level: 'unknown', reasonCode: 'no-purpose-evidence' },
            role: { level: 'unknown' }
        },
        ...overrides
    };
}

test('metadata 投影不重复 kind，不带私有文本，且嵌套字段独立', () => {
    const source: RequestClassification = { ...metadata(), requestKind: 'unclassified' };
    const projected = classification.getRequestClassificationMetadata(source);
    assert.deepEqual(projected, metadata());
    assert.equal(Object.hasOwn(projected, 'requestKind'), false);
    projected.evidence.origin.ruleId = 'changed';
    assert.equal(source.evidence.origin.ruleId, 'origin.sdk-identity');
});

test('normalize 忽略未知附加字段与 kind，仅输出白名单字段', () => {
    const source = { ...metadata(), requestKind: 'future-kind', privatePrompt: 'secret' };
    assert.deepEqual(classification.normalizeRequestClassification(source), metadata());
    const normalized = classification.normalizeRequestClassification(source);
    assert.ok(normalized);
    normalized.evidence.origin.ruleId = 'changed';
    assert.equal(source.evidence.origin.ruleId, 'origin.sdk-identity');
});

for (const value of [
    null,
    undefined,
    1,
    'copilot-sdk',
    [],
    {},
    { ...metadata(), version: 2 },
    { ...metadata(), version: '1' },
    { ...metadata(), requestOrigin: 'future-origin' },
    { ...metadata(), agentRole: 'future-role' },
    { ...metadata(), evidence: undefined },
    { ...metadata(), evidence: { origin: { level: 'signature' } } },
    { ...metadata(), evidence: { ...metadata().evidence, origin: { level: 'future-level' } } }
]) {
    test(`normalize 丢弃损坏/未来元数据 ${JSON.stringify(value)}`, () => {
        assert.equal(classification.normalizeRequestClassification(value), undefined);
    });
}

for (const field of ['ruleId', 'reasonCode'] as const) {
    for (const value of ['', 'x'.repeat(65), 'contains whitespace', '<summary>', '../secret', 1, null]) {
        test(`normalize 限制 ${field} 长度与格式 ${String(value).slice(0, 20)}`, () => {
            const source = metadata();
            const evidence = { ...source.evidence, purpose: { level: 'signature', [field]: value } };
            assert.equal(classification.normalizeRequestClassification({ ...source, evidence }), undefined);
        });
    }
    test(`normalize 接受 ${field} 的 64 字符边界`, () => {
        const source = metadata();
        Reflect.set(source.evidence.purpose, field, 'a'.repeat(64));
        assert.deepEqual(classification.normalizeRequestClassification(source), source);
    });
}

test('不安全访问器和已撤销 Proxy 不让元数据校验抛错', () => {
    const value = Object.defineProperty({}, 'version', {
        get() {
            throw new Error('broken metadata');
        }
    });
    const proxy = Proxy.revocable({}, {});
    proxy.revoke();
    for (const invalid of [value, proxy.proxy]) {
        assert.doesNotThrow(() => classification.normalizeRequestClassification(invalid));
        assert.equal(classification.normalizeRequestClassification(invalid), undefined);
        assert.equal(classification.normalizeRequestContinuity(invalid), undefined);
        assert.deepEqual(classification.mergeRequestClassification(metadata(), invalid), metadata());
    }
});

test('merge 缺失或损坏来值保留有效先前值，先前缺失时接受有效来值', () => {
    const valid = metadata();
    for (const invalid of [undefined, null, {}, { ...valid, version: 2 }]) {
        assert.deepEqual(classification.mergeRequestClassification(valid, invalid), valid);
        assert.deepEqual(classification.mergeRequestClassification(invalid, valid), valid);
    }
    assert.equal(classification.mergeRequestClassification({}, undefined), undefined);
});

const levels = ['unknown', 'heuristic', 'signature', 'contract'] as const;
for (const conflictLevel of levels) {
    test(`normalize 保留 ${conflictLevel} 冲突等级且不提升对外证据等级`, () => {
        const evidence: DimensionEvidence = { level: 'unknown', conflictLevel, reasonCode: 'classification-conflict' };
        const source = metadata({
            requestOrigin: 'unknown',
            evidence: { origin: evidence, purpose: evidence, role: evidence }
        });
        const restored = JSON.parse(JSON.stringify(source)) as unknown;
        const normalized = classification.normalizeRequestClassification(restored);
        assert.deepEqual(normalized, source);
        assert.ok(normalized);
        for (const dimension of ['origin', 'purpose', 'role'] as const) {
            assert.equal(normalized.evidence[dimension].level, 'unknown');
            assert.equal(normalized.evidence[dimension].reasonCode, 'classification-conflict');
        }
        normalized.evidence.purpose.conflictLevel = 'unknown';
        assert.equal(source.evidence.purpose.conflictLevel, conflictLevel);
    });
}

for (const conflictLevel of [null, 1, '', 'future-level', {}, []]) {
    test(`normalize 拒绝损坏的 conflictLevel ${JSON.stringify(conflictLevel)}`, () => {
        const source = metadata();
        assert.equal(
            classification.normalizeRequestClassification({
                ...source,
                evidence: {
                    ...source.evidence,
                    purpose: { level: 'unknown', reasonCode: 'classification-conflict', conflictLevel }
                }
            }),
            undefined
        );
    });
}

for (const evidence of [
    { level: 'signature', reasonCode: 'classification-conflict', conflictLevel: 'signature' },
    { level: 'contract', reasonCode: 'classification-conflict', conflictLevel: 'contract' },
    { level: 'unknown', conflictLevel: 'signature' },
    { level: 'unknown', reasonCode: 'no-purpose-evidence', conflictLevel: 'signature' }
]) {
    test(`normalize 仅允许冲突 unknown 证据携带 conflictLevel ${JSON.stringify(evidence)}`, () => {
        const source = metadata();
        assert.equal(
            classification.normalizeRequestClassification({
                ...source,
                evidence: { ...source.evidence, purpose: evidence }
            }),
            undefined
        );
    });
}

test('normalize 兼容未携带 conflictLevel 的旧冲突证据', () => {
    const evidence: DimensionEvidence = { level: 'unknown', reasonCode: 'classification-conflict' };
    const source = metadata({ evidence: { origin: evidence, purpose: evidence, role: evidence } });
    assert.deepEqual(classification.normalizeRequestClassification(source), source);
});

for (let earlier = 0; earlier < levels.length; earlier++) {
    for (let later = 0; later < levels.length; later++) {
        test(`merge 依据排序 ${levels[earlier]} -> ${levels[later]} 不采用最后写入`, () => {
            const oldEvidence: DimensionEvidence = { level: levels[earlier], ruleId: 'old-rule' };
            const newEvidence: DimensionEvidence = { level: levels[later], ruleId: 'new-rule' };
            const existing = metadata({ evidence: { origin: oldEvidence, purpose: oldEvidence, role: oldEvidence } });
            const incoming = metadata({
                requestOrigin: 'copilot-chat',
                agentRole: 'main',
                evidence: { origin: newEvidence, purpose: newEvidence, role: newEvidence }
            });
            const merged = classification.mergeRequestClassification(existing, incoming);
            assert.ok(merged);
            const strongerIncoming = later > earlier;
            const tied = later === earlier;
            assert.equal(
                merged.requestOrigin,
                tied ? 'unknown'
                : strongerIncoming ? 'copilot-chat'
                : 'copilot-sdk'
            );
            assert.equal(merged.agentRole, strongerIncoming ? 'main' : 'undetermined');
            assert.deepEqual(
                merged.evidence.origin,
                tied ? { level: 'unknown', conflictLevel: levels[earlier], reasonCode: 'classification-conflict' }
                : strongerIncoming ? newEvidence
                : oldEvidence
            );
            assert.equal(merged.evidence.purpose.ruleId, later >= earlier ? 'new-rule' : 'old-rule');
            assert.deepEqual(
                merged.evidence.role,
                tied ? { level: 'unknown', conflictLevel: levels[earlier], reasonCode: 'classification-conflict' }
                : strongerIncoming ? newEvidence
                : oldEvidence
            );
            assert.equal(merged.evidence.purpose.reasonCode, undefined);
            assert.equal(Object.hasOwn(merged, 'requestKind'), false);
        });
    }
}

test('merge 按维度挑选依据，并且不修改输入', () => {
    const existing = metadata({
        evidence: {
            origin: { level: 'contract', ruleId: 'old-origin' },
            purpose: { level: 'heuristic', ruleId: 'old-purpose' },
            role: { level: 'unknown' }
        }
    });
    const incoming = metadata({
        requestOrigin: 'copilot-chat',
        agentRole: 'main',
        evidence: {
            origin: { level: 'signature', ruleId: 'new-origin' },
            purpose: { level: 'signature', ruleId: 'new-purpose' },
            role: { level: 'signature', ruleId: 'new-role' }
        }
    });
    const snapshot = structuredClone({ existing, incoming });
    const merged = classification.mergeRequestClassification(existing, incoming);
    assert.ok(merged);
    assert.equal(merged.requestOrigin, 'copilot-sdk');
    assert.equal(merged.agentRole, 'main');
    assert.equal(merged.evidence.purpose.ruleId, 'new-purpose');
    assert.equal(merged.evidence.purpose.reasonCode, undefined);
    assert.deepEqual({ existing, incoming }, snapshot);
    merged.evidence.origin.ruleId = 'changed';
    assert.deepEqual({ existing, incoming }, snapshot);
});

test('merge 相同元数据不凭空产生冲突，冲突诊断在缺失更新后仍保留', () => {
    const valid = metadata();
    assert.deepEqual(classification.mergeRequestClassification(valid, valid), valid);
    const conflicting = metadata({ requestOrigin: 'copilot-chat' });
    const merged = classification.mergeRequestClassification(valid, conflicting);
    assert.ok(merged);
    assert.equal(merged.requestOrigin, 'unknown');
    assert.deepEqual(merged.evidence.origin, {
        level: 'unknown',
        conflictLevel: 'signature',
        reasonCode: 'classification-conflict'
    });
    assert.deepEqual(classification.mergeRequestClassification(merged, undefined), merged);
    assert.deepEqual(classification.mergeRequestClassification(merged, valid), merged);
});

for (let earlier = 0; earlier < levels.length; earlier++) {
    for (let later = 0; later < levels.length; later++) {
        test(`fields merge keeps kind and purpose paired ${levels[earlier]} -> ${levels[later]}`, () => {
            const existing = {
                requestKind: 'main-agent',
                requestClassification: metadata({
                    evidence: {
                        ...metadata().evidence,
                        purpose: { level: levels[earlier], ruleId: 'main-purpose' }
                    }
                })
            };
            const incoming = {
                requestKind: 'chat-title',
                requestClassification: metadata({
                    evidence: {
                        ...metadata().evidence,
                        purpose: { level: levels[later], ruleId: 'title-purpose' }
                    }
                })
            };
            const before = structuredClone({ existing, incoming });
            const merged = classification.mergeRequestClassificationFields(existing, incoming);
            const tied = earlier === later;
            const selected = later > earlier ? incoming : existing;
            assert.equal(merged.requestKind, tied ? 'unclassified' : selected.requestKind);
            assert.deepEqual(
                merged.requestClassification?.evidence.purpose,
                tied ?
                    { level: 'unknown', conflictLevel: levels[earlier], reasonCode: 'classification-conflict' }
                :   selected.requestClassification.evidence.purpose
            );
            assert.deepEqual(classification.mergeRequestClassificationFields(incoming, existing), merged);
            assert.deepEqual({ existing, incoming }, before);
            assert.ok(merged.requestClassification);
            merged.requestClassification.evidence.purpose.ruleId = 'changed';
            assert.deepEqual({ existing, incoming }, before);
        });
    }
}

test('fields merge missing kind cannot replace an existing kind or its purpose evidence', () => {
    const existing = { requestKind: 'main-agent', requestClassification: metadata() };
    const incoming = {
        requestClassification: metadata({
            requestOrigin: 'gcmp',
            agentRole: 'main',
            evidence: {
                origin: { level: 'contract' },
                purpose: { level: 'contract', ruleId: 'orphan-purpose' },
                role: { level: 'signature' }
            }
        })
    };
    const merged = classification.mergeRequestClassificationFields(existing, incoming);
    assert.equal(merged.requestKind, existing.requestKind);
    assert.deepEqual(merged.requestClassification?.evidence.purpose, existing.requestClassification.evidence.purpose);
    assert.equal(merged.requestClassification?.requestOrigin, 'gcmp');
    assert.equal(merged.requestClassification?.agentRole, 'main');
    assert.deepEqual(merged.requestClassification?.evidence.origin, incoming.requestClassification.evidence.origin);
    assert.deepEqual(merged.requestClassification?.evidence.role, incoming.requestClassification.evidence.role);
    const adopted = classification.mergeRequestClassificationFields(incoming, existing);
    assert.equal(adopted.requestKind, existing.requestKind);
    assert.deepEqual(adopted.requestClassification?.evidence.purpose, existing.requestClassification.evidence.purpose);
});

test('fields merge legacy and invalid metadata keeps kind paired with unknown purpose evidence', () => {
    const reliable = {
        requestKind: 'main-agent',
        requestClassification: metadata({
            evidence: {
                ...metadata().evidence,
                purpose: { level: 'contract', ruleId: 'main-purpose' }
            }
        })
    };
    for (const requestClassification of [undefined, null, { version: 2 }]) {
        const legacy = { requestKind: 'future-kind', requestClassification };
        assert.deepEqual(classification.mergeRequestClassificationFields(reliable, legacy), reliable);
        assert.deepEqual(classification.mergeRequestClassificationFields(legacy, reliable), reliable);
        const adopted = classification.mergeRequestClassificationFields(
            { requestClassification: reliable.requestClassification },
            legacy
        );
        assert.equal(adopted.requestKind, 'future-kind');
        assert.deepEqual(adopted.requestClassification?.evidence.purpose, { level: 'unknown' });
    }
    assert.deepEqual(classification.mergeRequestClassificationFields({}, { requestKind: 'future-kind' }), {
        requestKind: 'future-kind',
        requestClassification: undefined
    });
});

for (const evidences of [
    [{ level: 'unknown' }, { level: 'unknown', ruleId: 'another-rule' }, { level: 'unknown', ruleId: 'z-rule' }],
    [
        { level: 'signature', ruleId: 'a-rule', reasonCode: 'a-reason' },
        { level: 'signature', ruleId: 'a-rule', reasonCode: 'z-reason' },
        { level: 'signature', ruleId: 'z-rule' }
    ],
    [
        { level: 'contract', ruleId: 'same-rule' },
        { level: 'contract', ruleId: 'same-rule', reasonCode: 'a-reason' },
        { level: 'contract', ruleId: 'same-rule', reasonCode: 'z-reason' }
    ]
] satisfies DimensionEvidence[][]) {
    test(`fields merge same-value ${evidences[0].level} evidence selects stable ruleId/reasonCode across groups and orders`, () => {
        const [first, second, third] = evidences.map(evidence => ({
            requestKind: 'main-agent',
            requestClassification: metadata({ evidence: { origin: evidence, purpose: evidence, role: evidence } })
        }));
        const before = structuredClone([first, second, third]);
        for (const [a, b, c] of [
            [first, second, third],
            [first, third, second],
            [second, first, third],
            [second, third, first],
            [third, first, second],
            [third, second, first]
        ]) {
            const left = classification.mergeRequestClassificationFields(
                classification.mergeRequestClassificationFields(a, b),
                c
            );
            const right = classification.mergeRequestClassificationFields(
                a,
                classification.mergeRequestClassificationFields(b, c)
            );
            assert.deepEqual(left, first);
            assert.deepEqual(right, first);
        }
        assert.deepEqual([first, second, third], before);
    });
}

for (const conflictLevel of levels) {
    test(`fields merge serialized ${conflictLevel} conflicts reject equal/weaker updates but accept strictly stronger evidence`, () => {
        const evidence: DimensionEvidence = { level: conflictLevel, ruleId: 'original-rule' };
        const existing = {
            requestKind: 'main-agent',
            requestClassification: metadata({
                agentRole: 'main',
                evidence: { origin: evidence, purpose: evidence, role: evidence }
            })
        };
        const incoming = {
            requestKind: 'chat-title',
            requestClassification: {
                ...existing.requestClassification,
                requestOrigin: 'copilot-chat' as const,
                agentRole: 'subagent' as const
            }
        };
        const conflicted = classification.mergeRequestClassificationFields(existing, incoming);
        assert.equal(conflicted.requestKind, 'unclassified');
        assert.equal(conflicted.requestClassification?.requestOrigin, 'unknown');
        assert.equal(conflicted.requestClassification?.agentRole, 'undetermined');
        for (const dimension of ['origin', 'purpose', 'role'] as const) {
            assert.deepEqual(conflicted.requestClassification?.evidence[dimension], {
                level: 'unknown',
                conflictLevel,
                reasonCode: 'classification-conflict'
            });
        }
        const restored = JSON.parse(JSON.stringify(conflicted)) as typeof conflicted;
        assert.deepEqual(
            classification.normalizeRequestClassification(restored.requestClassification),
            conflicted.requestClassification
        );
        for (const updateLevel of levels) {
            const updateEvidence: DimensionEvidence = { level: updateLevel, ruleId: 'updated-rule' };
            const update = {
                requestKind: 'git-commit-message',
                requestClassification: metadata({
                    requestOrigin: 'gcmp',
                    agentRole: 'not-applicable',
                    evidence: { origin: updateEvidence, purpose: updateEvidence, role: updateEvidence }
                })
            };
            const expected = levels.indexOf(updateLevel) > levels.indexOf(conflictLevel) ? update : conflicted;
            assert.deepEqual(classification.mergeRequestClassificationFields(restored, update), expected);
            assert.deepEqual(classification.mergeRequestClassificationFields(update, restored), expected);
        }
        for (const update of [existing, incoming, {}, { requestKind: 'future-kind' }]) {
            assert.deepEqual(classification.mergeRequestClassificationFields(restored, update), conflicted);
            assert.deepEqual(classification.mergeRequestClassificationFields(update, restored), conflicted);
        }
    });
}

test('fields merge contract commit overrides signature main/title conflict across all orders, groups and serialization', () => {
    const records = [
        {
            requestKind: 'main-agent',
            requestOrigin: 'copilot-sdk',
            agentRole: 'main',
            level: 'signature',
            ruleId: 'main-purpose'
        },
        {
            requestKind: 'chat-title',
            requestOrigin: 'copilot-chat',
            agentRole: 'subagent',
            level: 'signature',
            ruleId: 'title-purpose'
        },
        {
            requestKind: 'git-commit-message',
            requestOrigin: 'gcmp',
            agentRole: 'not-applicable',
            level: 'contract',
            ruleId: 'commit-purpose'
        }
    ] as const;
    const [first, second, third] = records.map(record => {
        const evidence: DimensionEvidence = { level: record.level, ruleId: record.ruleId };
        return {
            requestKind: record.requestKind,
            requestClassification: metadata({
                requestOrigin: record.requestOrigin,
                agentRole: record.agentRole,
                evidence: { origin: evidence, purpose: evidence, role: evidence }
            })
        };
    });
    const before = structuredClone([first, second, third]);
    for (const [a, b, c] of [
        [first, second, third],
        [first, third, second],
        [second, first, third],
        [second, third, first],
        [third, first, second],
        [third, second, first]
    ]) {
        const ab = classification.mergeRequestClassificationFields(a, b);
        const bc = classification.mergeRequestClassificationFields(b, c);
        const restoredAB = JSON.parse(JSON.stringify(ab)) as typeof ab;
        const restoredBC = JSON.parse(JSON.stringify(bc)) as typeof bc;
        assert.deepEqual(classification.mergeRequestClassificationFields(ab, c), third);
        assert.deepEqual(classification.mergeRequestClassificationFields(a, bc), third);
        assert.deepEqual(classification.mergeRequestClassificationFields(restoredAB, c), third);
        assert.deepEqual(classification.mergeRequestClassificationFields(a, restoredBC), third);
    }
    assert.deepEqual([first, second, third], before);
});

test('fields merge legacy kind conflicts emits persistent unknown metadata', () => {
    const merged = classification.mergeRequestClassificationFields(
        { requestKind: 'main-agent' },
        { requestKind: 'chat-title' }
    );
    assert.equal(merged.requestKind, 'unclassified');
    assert.equal(merged.requestClassification?.requestOrigin, 'unknown');
    assert.equal(merged.requestClassification?.agentRole, 'undetermined');
    assert.deepEqual(merged.requestClassification?.evidence.purpose, {
        level: 'unknown',
        conflictLevel: 'unknown',
        reasonCode: 'classification-conflict'
    });
    assert.deepEqual(classification.mergeRequestClassificationFields(merged, { requestKind: 'main-agent' }), merged);
});

test('scoped classification uses object identity without mutating frozen options or serialized bodies', () => {
    const options = Object.freeze({ modelOptions: Object.freeze({ requestKind: 'chat-title', temperature: 0 }) });
    const other = { ...options };
    const source: RequestClassification = { ...metadata(), requestKind: 'main-agent' };
    const before = JSON.stringify(options);
    assert.equal(classification.getScopedRequestClassification(options), undefined);
    classification.setScopedRequestClassification(options, source);
    assert.equal(classification.getScopedRequestClassification(options), source);
    assert.equal(classification.getScopedRequestClassification(other), undefined);
    assert.equal(JSON.stringify(options), before);
    assert.deepEqual(Reflect.ownKeys(options), ['modelOptions']);
    const updated: RequestClassification = { ...source, requestKind: 'summarization' };
    classification.setScopedRequestClassification(options, updated);
    assert.equal(classification.getScopedRequestClassification(options), updated);
    assert.equal(JSON.stringify(options), before);
});

test('SDK known or unknown purposes do not use legacy text hashes or turn affinity', () => {
    const context: RequestClassification = {
        version: 1,
        requestKind: 'main-agent',
        requestOrigin: 'copilot-sdk',
        agentRole: 'main',
        evidence: {
            origin: { level: 'signature' },
            purpose: { level: 'signature' },
            role: { level: 'signature' }
        }
    };
    assert.equal(classification.usesLegacyTurnAffinity(context), false);
    const chat = { ...context, requestOrigin: 'copilot-chat' as const };
    assert.equal(classification.usesLegacyTurnAffinity(chat), true);
    assert.equal(classification.usesLegacyTurnAffinity({ ...chat, agentRole: 'undetermined' }), false);
    chat.evidence.purpose.level = 'heuristic';
    assert.equal(classification.usesLegacyTurnAffinity(chat), false);
});

for (const source of ['stateful-marker', 'trace-bridge', 'summary-bridge-exact', 'new-uuid', 'sdk-session']) {
    test(`continuity records ${source} without telemetry`, () => {
        assert.deepEqual(classification.getRequestContinuity(source), {
            version: 1,
            scope: 'chain',
            source:
                source === 'stateful-marker' ? 'marker'
                : source === 'new-uuid' ? 'new'
                : source === 'sdk-session' ? 'sdk-session'
                : 'legacy'
        });
        assert.equal(classification.getRequestContinuity(source, 'sub_id').scope, 'subagent');
    });
}

for (const scope of ['chain', 'subagent'] as const) {
    for (const source of ['marker', 'legacy', 'new', 'sdk-session'] as const) {
        test(`continuity 接受 v1 ${scope}/${source} 且只投影约定字段`, () => {
            assert.deepEqual(
                classification.normalizeRequestContinuity({ version: 1, scope, source, privateField: 'ignore' }),
                { version: 1, scope, source }
            );
        });
    }
}

for (const value of [
    undefined,
    null,
    [],
    {},
    { version: 2, scope: 'chain', source: 'marker' },
    { version: 1, scope: 'parent', source: 'marker' },
    { version: 1, scope: 'chain', source: 'future' }
]) {
    test(`continuity 丢弃损坏/未来值 ${JSON.stringify(value)}`, () => {
        assert.equal(classification.normalizeRequestContinuity(value), undefined);
    });
}
