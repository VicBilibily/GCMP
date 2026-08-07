import assert from 'node:assert/strict';
import test from 'node:test';

import { isEncryptedReasoningEnabled } from './encryptedReasoning';

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
