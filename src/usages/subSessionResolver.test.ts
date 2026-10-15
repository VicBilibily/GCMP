import assert from 'node:assert/strict';
import test from 'node:test';

import type { RequestOrigin } from '../handlers/classification/requestClassification';
import { encodeStatefulMarkerPayload } from '../handlers/stateful/statefulMarkerCodec';
import { resolveSubSessionId, type SubSessionMessageLike } from './subSessionResolver';

const ROLE_USER = 1;
const ROLE_ASSISTANT = 2;

function userMessage(text: string): SubSessionMessageLike {
    return { role: ROLE_USER, content: [{ value: text }] };
}

function assistantWithMarker(
    subSessionId: string | undefined,
    sessionId = 'parent-1',
    extension = 'vicanent.gcmp',
    continuity?: unknown
): SubSessionMessageLike {
    const data = encodeStatefulMarkerPayload('test-model', {
        extension,
        provider: 'test-provider',
        modelId: 'test-model',
        sdkMode: 'openai',
        sessionId,
        subSessionId,
        continuity,
        responseId: 'response-1'
    });
    return { role: ROLE_ASSISTANT, content: [{ mimeType: 'stateful_marker', data }] };
}

test('non-subagent request kinds resolve to undefined', () => {
    const messages = [userMessage('task')];
    assert.equal(resolveSubSessionId(messages, 'parent-1', 'main-agent', true), undefined);
    assert.equal(resolveSubSessionId(messages, 'parent-1', 'summarization', true), undefined);
    assert.equal(resolveSubSessionId(messages, 'parent-1', 'chat-title', true), undefined);
});

test('subagent without marker generates deterministic id in expected format', () => {
    const messages = [userMessage('Find all usages of captureAttempt')];
    const first = resolveSubSessionId(messages, 'parent-1', 'search-subagent', true);
    const second = resolveSubSessionId(messages, 'parent-1', 'search-subagent', true);
    assert.match(first ?? '', /^sub_[0-9a-f]{32}$/);
    assert.equal(first, second);
});

test('generated id varies with kind, task text and stable parent session', () => {
    const task = 'Inspect the failover manager';
    const search = resolveSubSessionId([userMessage(task)], 'parent-1', 'search-subagent', true);
    const execution = resolveSubSessionId([userMessage(task)], 'parent-1', 'execution-subagent', true);
    const otherTask = resolveSubSessionId([userMessage('Other task')], 'parent-1', 'search-subagent', true);
    const otherParent = resolveSubSessionId([userMessage(task)], 'parent-2', 'search-subagent', true);
    assert.notEqual(search, execution);
    assert.notEqual(search, otherTask);
    assert.notEqual(search, otherParent);
});

test('unstable parent session is not mixed into the deterministic anchor', () => {
    const messages = [userMessage('Same task')];
    const first = resolveSubSessionId(messages, 'random-uuid-a', 'search-subagent', false);
    const second = resolveSubSessionId(messages, 'random-uuid-b', 'search-subagent', false);
    assert.equal(first, second);
    assert.match(first ?? '', /^sub_[0-9a-f]{32}$/);
});

test('task text whitespace is normalized before hashing', () => {
    const compact = resolveSubSessionId([userMessage('a b')], 'parent-1', 'search-subagent', true);
    const spread = resolveSubSessionId([userMessage('a  \n\t b')], 'parent-1', 'search-subagent', true);
    assert.equal(compact, spread);
});

for (const parentSessionStable of [true, false]) {
    test(`long tasks preserve distinct suffixes with parent stability ${parentSessionStable}`, () => {
        const common = 'Shared context and existing contracts. '.repeat(200);
        assert.ok(common.length > 6000);
        const firstTask = [userMessage(`${common}Inspect queued request routing.`)];
        const secondTask = [userMessage(`${common}Inspect usage archive records.`)];
        const first = resolveSubSessionId(firstTask, 'parent-1', 'search-subagent', parentSessionStable);
        const second = resolveSubSessionId(secondTask, 'parent-1', 'search-subagent', parentSessionStable);

        assert.match(first ?? '', /^sub_[0-9a-f]{32}$/);
        assert.match(second ?? '', /^sub_[0-9a-f]{32}$/);
        assert.notEqual(first, second);
        assert.equal(resolveSubSessionId(firstTask, 'parent-1', 'search-subagent', parentSessionStable), first);
    });
}

test('subSessionId is read back from the most recent stateful marker', () => {
    const recorded = 'sub_' + 'a'.repeat(32);
    const messages = [userMessage('Changed task text'), assistantWithMarker(recorded)];
    assert.equal(resolveSubSessionId(messages, 'parent-1', 'execution-subagent', true), recorded);
});

test('malformed marker subSessionId falls back to generation', () => {
    const messages = [userMessage('Task'), assistantWithMarker('junk-value')];
    const resolved = resolveSubSessionId(messages, 'parent-1', 'search-subagent', true);
    assert.match(resolved ?? '', /^sub_[0-9a-f]{32}$/);
    assert.notEqual(resolved, 'junk-value');
});

test('marker from another parent session is ignored', () => {
    const recorded = 'sub_' + 'b'.repeat(32);
    const resolved = resolveSubSessionId(
        [userMessage('Task'), assistantWithMarker(recorded, 'parent-2')],
        'parent-1',
        'search-subagent',
        true
    );
    assert.match(resolved ?? '', /^sub_[0-9a-f]{32}$/);
    assert.notEqual(resolved, recorded);
});

test('marker from another extension is ignored', () => {
    const recorded = 'sub_' + 'c'.repeat(32);
    const resolved = resolveSubSessionId(
        [userMessage('Task'), assistantWithMarker(recorded, 'parent-1', 'other.extension')],
        'parent-1',
        'search-subagent',
        true
    );
    assert.match(resolved ?? '', /^sub_[0-9a-f]{32}$/);
    assert.notEqual(resolved, recorded);
});

test('latest matching marker without a valid subSessionId prevents stale marker reuse', () => {
    const stale = 'sub_' + 'd'.repeat(32);
    const resolved = resolveSubSessionId(
        [userMessage('Task'), assistantWithMarker(stale), assistantWithMarker(undefined)],
        'parent-1',
        'search-subagent',
        true
    );
    assert.match(resolved ?? '', /^sub_[0-9a-f]{32}$/);
    assert.notEqual(resolved, stale);
});

test('missing user message yields undefined', () => {
    const messages: SubSessionMessageLike[] = [{ role: ROLE_ASSISTANT, content: [{ value: 'no task' }] }];
    assert.equal(resolveSubSessionId(messages, 'parent-1', 'search-subagent', true), undefined);
});

const subagentContinuity = { version: 1, scope: 'subagent', agentRole: 'subagent' } as const;

test('显式 copilot-chat 保持四参数调用的既有确定性哈希', () => {
    const messages = [userMessage('Find all usages of captureAttempt')];
    assert.equal(
        resolveSubSessionId(messages, 'parent-1', 'search-subagent', true, 'copilot-chat'),
        resolveSubSessionId(messages, 'parent-1', 'search-subagent', true)
    );
});

test('通用 subagent 在旧 Copilot Chat 也有独立稳定哈希', () => {
    const messages = [userMessage('Same task')];
    const first = resolveSubSessionId(messages, 'parent-1', 'subagent', true, 'copilot-chat');
    assert.match(first ?? '', /^sub_[0-9a-f]{32}$/);
    assert.equal(first, resolveSubSessionId(messages, 'parent-1', 'subagent', true, 'copilot-chat'));
    assert.notEqual(first, resolveSubSessionId(messages, 'parent-1', 'search-subagent', true, 'copilot-chat'));
});

for (const origin of ['copilot-sdk', 'gcmp', 'other-extension', 'core', 'unknown'] satisfies RequestOrigin[]) {
    test(`${origin} 同文独立委派使用随机子会话，不共享父 marker 或文本哈希`, () => {
        const inherited = 'sub_' + 'e'.repeat(32);
        const messages = [userMessage('Same delegated task'), assistantWithMarker(inherited)];
        for (const kind of ['subagent', 'search-subagent', 'execution-subagent']) {
            const first = resolveSubSessionId(messages, 'parent-1', kind, true, origin);
            const second = resolveSubSessionId(messages, 'parent-1', kind, true, origin);
            assert.match(first ?? '', /^sub_[0-9a-f]{12}4[0-9a-f]{3}[89ab][0-9a-f]{15}$/);
            assert.match(second ?? '', /^sub_[0-9a-f]{32}$/);
            assert.notEqual(first, second);
            assert.notEqual(first, inherited);
        }
    });

    test(`${origin} 仅使用同链有效 subagent continuity marker 恢复通用子代理`, () => {
        const recorded = 'sub_' + 'a'.repeat(32);
        const messages = [assistantWithMarker(recorded, 'parent-1', 'vicanent.gcmp', subagentContinuity)];
        assert.equal(resolveSubSessionId(messages, 'parent-1', 'subagent', true, origin), recorded);
    });
}

test('SDK 已确认子代理无用户文本或稳定父身份也生成随机 ID', () => {
    const first = resolveSubSessionId([], 'unknown-parent', 'subagent', false, 'copilot-sdk');
    const second = resolveSubSessionId([], 'unknown-parent', 'subagent', false, 'copilot-sdk');
    assert.match(first ?? '', /^sub_[0-9a-f]{32}$/);
    assert.notEqual(first, second);
});

test('SDK 未确认子代理的用途不因历史 marker 获得子会话', () => {
    const recorded = 'sub_' + 'b'.repeat(32);
    const messages = [assistantWithMarker(recorded, 'parent-1', 'vicanent.gcmp', subagentContinuity)];
    for (const kind of ['unclassified', 'unknown', 'main-agent', 'summarization', 'background']) {
        assert.equal(resolveSubSessionId(messages, 'parent-1', kind, true, 'copilot-sdk'), undefined);
    }
});

test('SDK 不用缺失、损坏或非子代理 continuity 恢复子会话', () => {
    const recorded = 'sub_' + 'c'.repeat(32);
    for (const continuity of [
        undefined,
        null,
        {},
        { version: 2, scope: 'subagent', agentRole: 'subagent' },
        { version: 1, scope: 'chain', agentRole: 'subagent' },
        { version: 1, scope: 'subagent', agentRole: 'main' }
    ]) {
        const resolved = resolveSubSessionId(
            [assistantWithMarker(recorded, 'parent-1', 'vicanent.gcmp', continuity)],
            'parent-1',
            'subagent',
            true,
            'copilot-sdk'
        );
        assert.match(resolved ?? '', /^sub_[0-9a-f]{32}$/);
        assert.notEqual(resolved, recorded);
    }
});

test('SDK marker 不跨父链、扩展或角色恢复', () => {
    const recorded = 'sub_' + 'd'.repeat(32);
    for (const message of [
        assistantWithMarker(recorded, 'parent-2', 'vicanent.gcmp', subagentContinuity),
        assistantWithMarker(recorded, 'parent-1', 'foreign', subagentContinuity),
        { ...assistantWithMarker(recorded, 'parent-1', 'vicanent.gcmp', subagentContinuity), role: ROLE_USER }
    ]) {
        assert.notEqual(resolveSubSessionId([message], 'parent-1', 'subagent', true, 'copilot-sdk'), recorded);
    }
});

test('System 前 Assistant bridge 的同消息多个 marker 最新优先且不改原数据', () => {
    const stale = 'sub_' + 'a'.repeat(32);
    const newest = 'sub_' + 'b'.repeat(32);
    const messages: SubSessionMessageLike[] = [
        {
            role: ROLE_ASSISTANT,
            content: [
                ...assistantWithMarker(stale, 'parent-1', 'vicanent.gcmp', subagentContinuity).content,
                ...assistantWithMarker(newest, 'parent-1', 'vicanent.gcmp', subagentContinuity).content
            ]
        },
        { role: 0, content: [{ value: 'SDK identity' }] }
    ];
    const snapshot = structuredClone(messages);
    Object.freeze(messages[0].content);
    Object.freeze(messages);
    assert.equal(resolveSubSessionId(messages, 'parent-1', 'subagent', true, 'copilot-sdk'), newest);
    assert.deepEqual(messages, snapshot);
});

test('同消息最新父 marker 阻断 SDK 对更旧子 marker 的恢复', () => {
    const stale = 'sub_' + 'f'.repeat(32);
    const messages = [
        {
            role: ROLE_ASSISTANT,
            content: [
                ...assistantWithMarker(stale, 'parent-1', 'vicanent.gcmp', subagentContinuity).content,
                ...assistantWithMarker(undefined, 'parent-1', 'vicanent.gcmp', {
                    version: 1,
                    scope: 'chain',
                    agentRole: 'main'
                }).content
            ]
        }
    ];
    const resolved = resolveSubSessionId(messages, 'parent-1', 'subagent', true, 'copilot-sdk');
    assert.match(resolved ?? '', /^sub_[0-9a-f]{32}$/);
    assert.notEqual(resolved, stale);
});

test('子会话解析忽略损坏 marker 必要字段和不完整消息', () => {
    const recorded = 'sub_' + '1'.repeat(32);
    const validMarker = {
        extension: 'vicanent.gcmp',
        provider: 'slot',
        modelId: 'model',
        sdkMode: 'openai',
        sessionId: 'parent-1',
        subSessionId: recorded,
        responseId: '',
        continuity: subagentContinuity
    };
    for (const payload of [null, [], { ...validMarker, sdkMode: 'future-sdk' }, { ...validMarker, provider: null }]) {
        const messages = [
            userMessage('Task'),
            {
                role: ROLE_ASSISTANT,
                content: [{ mimeType: 'stateful_marker', data: encodeStatefulMarkerPayload('model', payload) }]
            }
        ];
        assert.notEqual(resolveSubSessionId(messages, 'parent-1', 'subagent', true, 'copilot-sdk'), recorded);
        assert.notEqual(resolveSubSessionId(messages, 'parent-1', 'search-subagent', true), recorded);
    }
    const messages = [
        null,
        { role: ROLE_ASSISTANT, content: null },
        userMessage('Task')
    ] as unknown as SubSessionMessageLike[];
    assert.match(resolveSubSessionId(messages, 'parent-1', 'search-subagent', true) ?? '', /^sub_[0-9a-f]{32}$/);
});
