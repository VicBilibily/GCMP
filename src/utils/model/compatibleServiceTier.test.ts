import assert from 'node:assert/strict';
import test from 'node:test';

import {
    ANTHROPIC_COMPATIBLE_SERVICE_TIERS,
    getCompatibleServiceTierOptions,
    normalizeCompatibleServiceTiers,
    OPENAI_COMPATIBLE_SERVICE_TIERS
} from './compatibleServiceTier';

test('按 SDK 模式返回服务等级建议值', () => {
    assert.deepEqual(getCompatibleServiceTierOptions('openai'), OPENAI_COMPATIBLE_SERVICE_TIERS);
    assert.deepEqual(getCompatibleServiceTierOptions('openai-sse'), OPENAI_COMPATIBLE_SERVICE_TIERS);
    assert.deepEqual(getCompatibleServiceTierOptions('openai-responses'), OPENAI_COMPATIBLE_SERVICE_TIERS);
    // anthropic 建议值除官方 standard_only/auto 外，包含 MiniMax 等三方端点的 default/priority
    assert.deepEqual(getCompatibleServiceTierOptions('anthropic'), [
        ...ANTHROPIC_COMPATIBLE_SERVICE_TIERS,
        'default',
        'priority'
    ]);
    assert.deepEqual(getCompatibleServiceTierOptions(), OPENAI_COMPATIBLE_SERVICE_TIERS);
});

test('归一化仅过滤非字符串并保序去重', () => {
    assert.deepEqual(normalizeCompatibleServiceTiers(['priority', 'default', 'priority', null, 1, '']), [
        'priority',
        'default'
    ]);
});

test('三方端点私有值原样保留（透传，不做协议映射）', () => {
    assert.deepEqual(normalizeCompatibleServiceTiers(['default', 'priority']), ['default', 'priority']);
    assert.deepEqual(normalizeCompatibleServiceTiers(['standard_only', 'auto']), ['standard_only', 'auto']);
    assert.deepEqual(normalizeCompatibleServiceTiers(['scale', 'turbo']), ['scale', 'turbo']);
});

test('无合法服务等级时保持未配置', () => {
    assert.equal(normalizeCompatibleServiceTiers([]), undefined);
    assert.equal(normalizeCompatibleServiceTiers([null, 1, '']), undefined);
    assert.equal(normalizeCompatibleServiceTiers('priority'), undefined);
});
