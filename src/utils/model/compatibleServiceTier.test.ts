import assert from 'node:assert/strict';
import test from 'node:test';

import {
    ANTHROPIC_COMPATIBLE_SERVICE_TIERS,
    getCompatibleServiceTierOptions,
    normalizeCompatibleServiceTiers,
    OPENAI_COMPATIBLE_SERVICE_TIERS
} from './compatibleServiceTier';

test('按 SDK 模式返回协议原生服务等级', () => {
    assert.deepEqual(getCompatibleServiceTierOptions('openai'), OPENAI_COMPATIBLE_SERVICE_TIERS);
    assert.deepEqual(getCompatibleServiceTierOptions('openai-sse'), OPENAI_COMPATIBLE_SERVICE_TIERS);
    assert.deepEqual(getCompatibleServiceTierOptions('openai-responses'), OPENAI_COMPATIBLE_SERVICE_TIERS);
    assert.deepEqual(getCompatibleServiceTierOptions('anthropic'), ANTHROPIC_COMPATIBLE_SERVICE_TIERS);
    assert.deepEqual(getCompatibleServiceTierOptions(), OPENAI_COMPATIBLE_SERVICE_TIERS);
});

test('OpenAI 服务等级过滤无效值并保序去重', () => {
    assert.deepEqual(
        normalizeCompatibleServiceTiers(['priority', 'default', 'priority', 'standard_only', null], 'openai'),
        ['priority', 'default']
    );
});

test('Anthropic 服务等级过滤无效值并保序去重', () => {
    assert.deepEqual(
        normalizeCompatibleServiceTiers(['auto', 'standard_only', 'auto', 'flex'], 'anthropic'),
        ['auto', 'standard_only']
    );
});

test('旧 Anthropic Compatible 等级映射为协议原生值', () => {
    assert.deepEqual(normalizeCompatibleServiceTiers(['default', 'priority'], 'anthropic'), [
        'standard_only',
        'auto'
    ]);
});

test('无合法服务等级时保持未配置', () => {
    assert.equal(normalizeCompatibleServiceTiers([], 'openai'), undefined);
    assert.equal(normalizeCompatibleServiceTiers(['standard_only'], 'openai'), undefined);
    assert.equal(normalizeCompatibleServiceTiers('priority', 'openai'), undefined);
});
