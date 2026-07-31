import assert from 'node:assert/strict';
import test from 'node:test';

import { applyOpenAIServiceTier } from './serviceTier';

const supportedModel = { serviceTier: ['default', 'priority'] };

test('Fast 服务等级发送 priority', () => {
    const requestBody: Record<string, unknown> = {};

    applyOpenAIServiceTier(requestBody, supportedModel, { serviceTier: 'priority' });

    assert.equal(requestBody.service_tier, 'priority');
});

test('Standard 服务等级不发送 service_tier', () => {
    const requestBody: Record<string, unknown> = { service_tier: 'priority' };

    applyOpenAIServiceTier(requestBody, supportedModel, { serviceTier: 'default' });

    assert.equal('service_tier' in requestBody, false);
});

test('不支持服务等级的模型保留 extraBody 配置', () => {
    const requestBody: Record<string, unknown> = { service_tier: 'custom' };

    applyOpenAIServiceTier(requestBody, {}, { serviceTier: 'default' });

    assert.equal(requestBody.service_tier, 'custom');
});

test('未选择服务等级时保留 extraBody 配置', () => {
    const requestBody: Record<string, unknown> = { service_tier: 'priority' };

    applyOpenAIServiceTier(requestBody, supportedModel);

    assert.equal(requestBody.service_tier, 'priority');
});

test('模型未声明的服务等级不会发送', () => {
    const requestBody: Record<string, unknown> = { service_tier: 'priority' };

    applyOpenAIServiceTier(requestBody, supportedModel, { serviceTier: 'flex' });

    assert.equal('service_tier' in requestBody, false);
});
