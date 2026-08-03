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

for (const serviceTier of ['default', 'auto', 'flex', 'priority']) {
    test(`Compatible OpenAI 原样发送 ${serviceTier}`, () => {
        const requestBody: Record<string, unknown> = {};
        const model = { serviceTier: ['default', 'auto', 'flex', 'priority'] };

        applyOpenAIServiceTier(requestBody, model, { serviceTier }, 'compatible');

        assert.equal(requestBody.service_tier, serviceTier);
    });
}

test('Compatible OpenAI 删除非法服务等级', () => {
    const requestBody: Record<string, unknown> = { service_tier: 'priority' };

    applyOpenAIServiceTier(requestBody, { serviceTier: ['default', 'priority'] }, { serviceTier: 'custom' }, 'compatible');

    assert.equal('service_tier' in requestBody, false);
});

test('非 Compatible OpenAI 的 default 仍不发送', () => {
    const requestBody: Record<string, unknown> = { service_tier: 'priority' };

    applyOpenAIServiceTier(requestBody, supportedModel, { serviceTier: 'default' }, 'codex');

    assert.equal('service_tier' in requestBody, false);
});
