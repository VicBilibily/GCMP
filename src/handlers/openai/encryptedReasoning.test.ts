import assert from 'node:assert/strict';
import test from 'node:test';

import {
    isEncryptedReasoningEnabled,
    isEncryptedReasoningOriginMatch,
    isIncludeOverridden,
    isResponsesReasoningId,
    shouldReplayPlainThinking
} from './encryptedReasoning';

test('未接管 include：gpt 模型且配置 extraBody.reasoning 时启用', () => {
    assert.equal(
        isEncryptedReasoningEnabled({
            requestModel: 'gpt-5.4',
            extraBody: { reasoning: { effort: 'medium' } }
        }),
        true
    );
});

test('未接管 include：gpt 模型但无 extraBody.reasoning 时不启用', () => {
    assert.equal(isEncryptedReasoningEnabled({ requestModel: 'gpt-5.4', extraBody: {} }), false);
    assert.equal(isEncryptedReasoningEnabled({ requestModel: 'gpt-5.4' }), false);
});

test('未接管 include：非 gpt 模型即使配置 reasoning 也不启用', () => {
    assert.equal(
        isEncryptedReasoningEnabled({
            requestModel: 'glm-5-2',
            extraBody: { reasoning: { effort: 'medium' } }
        }),
        false
    );
});

test('接管 include：include 为 null 或空数组时不启用', () => {
    assert.equal(
        isEncryptedReasoningEnabled({
            requestModel: 'gpt-5.4',
            extraBody: { reasoning: { effort: 'medium' }, include: null }
        }),
        false
    );
    assert.equal(
        isEncryptedReasoningEnabled({
            requestModel: 'gpt-5.4',
            extraBody: { reasoning: { effort: 'medium' }, include: [] }
        }),
        false
    );
});

test('接管 include：include 含 reasoning.encrypted_content 时启用', () => {
    assert.equal(
        isEncryptedReasoningEnabled({
            requestModel: 'gpt-5.4',
            extraBody: { include: ['reasoning.encrypted_content'] }
        }),
        true
    );
});

test('接管 include：include 不含目标条目时不启用', () => {
    assert.equal(
        isEncryptedReasoningEnabled({
            requestModel: 'gpt-5.4',
            extraBody: { reasoning: { effort: 'medium' }, include: ['output_text.logprobs'] }
        }),
        false
    );
});

test('isIncludeOverridden：定义 include 键（含 null/[]）即视为接管', () => {
    assert.equal(isIncludeOverridden({ include: null }), true);
    assert.equal(isIncludeOverridden({ include: [] }), true);
    assert.equal(isIncludeOverridden({ include: ['reasoning.encrypted_content'] }), true);
});

test('isIncludeOverridden：未定义 include 键时不视为接管', () => {
    assert.equal(isIncludeOverridden({ reasoning: { effort: 'medium' } }), false);
    assert.equal(isIncludeOverridden({}), false);
    assert.equal(isIncludeOverridden(undefined), false);
});

test('shouldReplayPlainThinking：GPT 端点永远不回传明文（即使缺少 extraBody.reasoning）', () => {
    // issue #352：GPT 历史 reasoning 不能以明文摘要回放。
    assert.equal(shouldReplayPlainThinking({ requestModel: 'gpt-5.4', extraBody: {} }), false);
    assert.equal(shouldReplayPlainThinking({ requestModel: 'gpt-5.6-sol' }), false);
    assert.equal(
        shouldReplayPlainThinking({ requestModel: 'GPT-5.4', extraBody: { reasoning: { effort: 'medium' } } }),
        false
    );
});

test('shouldReplayPlainThinking：非 GPT 端点且 include 未接管时回传明文', () => {
    assert.equal(shouldReplayPlainThinking({ requestModel: 'deepseek-v4-flash' }), true);
    assert.equal(
        shouldReplayPlainThinking({ requestModel: 'glm-5-2', extraBody: { reasoning: { effort: 'medium' } } }),
        true
    );
});

test('shouldReplayPlainThinking：include 被显式接管时不回传明文', () => {
    assert.equal(shouldReplayPlainThinking({ requestModel: 'deepseek-v4-flash', extraBody: { include: null } }), false);
    assert.equal(shouldReplayPlainThinking({ requestModel: 'deepseek-v4-flash', extraBody: { include: [] } }), false);
});

test('isResponsesReasoningId：仅接受以 rs 开头的 Responses 签发 id', () => {
    assert.equal(isResponsesReasoningId('rs_abc123'), true);
    assert.equal(isResponsesReasoningId('rsn_123'), true);
    assert.equal(isResponsesReasoningId('thinking_0'), false);
    assert.equal(isResponsesReasoningId('msg_1'), false);
    assert.equal(isResponsesReasoningId(undefined), false);
});

test('isEncryptedReasoningOriginMatch：同 provider 跨模型可匹配', () => {
    assert.equal(
        isEncryptedReasoningOriginMatch(
            { provider: 'openai', modelId: 'gpt-5.4' },
            { provider: 'openai', modelId: 'gpt-5.6' }
        ),
        true
    );
});

test('isEncryptedReasoningOriginMatch：跨 provider 不匹配', () => {
    assert.equal(
        isEncryptedReasoningOriginMatch(
            { provider: 'anthropic', modelId: 'claude-sonnet-4-5' },
            { provider: 'openai', modelId: 'gpt-5.6' }
        ),
        false
    );
});
