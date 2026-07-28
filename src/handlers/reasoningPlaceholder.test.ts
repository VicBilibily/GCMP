import assert from 'node:assert/strict';
import test from 'node:test';

import { shouldInjectReasoningPlaceholder } from './reasoningPlaceholder';

test('MiMo models require placeholder injection', () => {
    assert.equal(
        shouldInjectReasoningPlaceholder({
            providerKey: 'compatible',
            modelConfig: { id: 'mimo-v2.5-pro', baseUrl: 'https://api.xiaomimimo.com/v1' }
        }),
        true
    );
});

test('MiMo token-plan provider requires placeholder injection', () => {
    assert.equal(
        shouldInjectReasoningPlaceholder({
            providerKey: 'xiaomimimo-token',
            modelConfig: { id: 'custom-compatible-model' }
        }),
        true
    );
});

test('MiMo anthropic-compatible endpoint requires placeholder injection', () => {
    assert.equal(
        shouldInjectReasoningPlaceholder({
            providerKey: 'xiaomimimo-token',
            modelConfig: {
                id: 'mimo-v2.5-pro-token-plan',
                model: 'mimo-v2.5-pro',
                baseUrl: 'https://token-plan-cn.xiaomimimo.com/anthropic'
            }
        }),
        true
    );
});

test('DeepSeek-V4 requires placeholder injection', () => {
    assert.equal(
        shouldInjectReasoningPlaceholder({
            providerKey: 'compatible',
            modelConfig: { model: 'deepseek-v4-chat' }
        }),
        true
    );
    assert.equal(shouldInjectReasoningPlaceholder({ modelConfig: { model: 'deepseek-v4-flash' } }), true);
});

test('unrelated models do not inject placeholder', () => {
    assert.equal(
        shouldInjectReasoningPlaceholder({
            providerKey: 'compatible',
            modelConfig: { id: 'gpt-4.1-mini', baseUrl: 'https://api.openai.com/v1' }
        }),
        false
    );
    assert.equal(shouldInjectReasoningPlaceholder({ providerKey: 'openai', modelConfig: { id: 'gpt-4o' } }), false);
    assert.equal(
        shouldInjectReasoningPlaceholder({ providerKey: 'anthropic', modelConfig: { id: 'claude-sonnet-4-5' } }),
        false
    );
});
