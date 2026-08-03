import assert from 'node:assert/strict';
import test from 'node:test';

import { applyAnthropicServiceTier } from './serviceTier';

const compatibleModel = { serviceTier: ['standard_only', 'auto'] };

test('Compatible Anthropic 原样发送 standard_only', () => {
    const requestBody: Record<string, unknown> = {};

    applyAnthropicServiceTier(requestBody, compatibleModel, { serviceTier: 'standard_only' }, 'compatible');

    assert.equal(requestBody.service_tier, 'standard_only');
});

test('Compatible Anthropic 原样发送 auto', () => {
    const requestBody: Record<string, unknown> = {};

    applyAnthropicServiceTier(requestBody, compatibleModel, { serviceTier: 'auto' }, 'compatible');

    assert.equal(requestBody.service_tier, 'auto');
});

test('Compatible Anthropic 删除模型未声明的等级', () => {
    const requestBody: Record<string, unknown> = { service_tier: 'auto' };

    applyAnthropicServiceTier(requestBody, { serviceTier: ['standard_only'] }, { serviceTier: 'auto' }, 'compatible');

    assert.equal('service_tier' in requestBody, false);
});

test('Compatible Anthropic 未启用等级时保留 extraBody', () => {
    const requestBody: Record<string, unknown> = { service_tier: 'custom' };

    applyAnthropicServiceTier(requestBody, {}, { serviceTier: 'auto' }, 'compatible');

    assert.equal(requestBody.service_tier, 'custom');
});

test('未选择等级时保留 extraBody', () => {
    const requestBody: Record<string, unknown> = { service_tier: 'standard_only' };

    applyAnthropicServiceTier(requestBody, compatibleModel, undefined, 'compatible');

    assert.equal(requestBody.service_tier, 'standard_only');
});

test('非 Compatible Anthropic 保持旧等级行为', () => {
    const priorityBody: Record<string, unknown> = {};
    const defaultBody: Record<string, unknown> = { service_tier: 'priority' };

    applyAnthropicServiceTier(priorityBody, { serviceTier: ['default', 'priority'] }, { serviceTier: 'priority' });
    applyAnthropicServiceTier(defaultBody, { serviceTier: ['default', 'priority'] }, { serviceTier: 'default' });

    assert.equal(priorityBody.service_tier, 'priority');
    assert.equal('service_tier' in defaultBody, false);
});
