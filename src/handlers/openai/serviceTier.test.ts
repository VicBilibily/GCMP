import assert from 'node:assert/strict';
import test from 'node:test';

import { applyOpenAIServiceTier } from './serviceTier';

const supportedModel = { serviceTier: ['default', 'priority'] };

test('Fast 服务等级发送 priority', () => {
    const requestBody: Record<string, unknown> = {};

    applyOpenAIServiceTier(requestBody, supportedModel, { serviceTier: 'priority' });

    assert.equal(requestBody.service_tier, 'priority');
});

test('Fast 服务等级发送 fast（GPT-6 起官方枚举）', () => {
    const requestBody: Record<string, unknown> = { service_tier: 'priority' };

    applyOpenAIServiceTier(requestBody, { serviceTier: ['default', 'fast'] }, { serviceTier: 'fast' }, 'codex');

    assert.equal(requestBody.service_tier, 'fast');
});

test('Ultrafast 服务等级发送 ultrafast', () => {
    const requestBody: Record<string, unknown> = {};

    applyOpenAIServiceTier(
        requestBody,
        { serviceTier: ['default', 'fast', 'ultrafast'] },
        { serviceTier: 'ultrafast' },
        'codex'
    );

    assert.equal(requestBody.service_tier, 'ultrafast');
});

test('模型未声明 ultrafast 时不发送', () => {
    const requestBody: Record<string, unknown> = { service_tier: 'fast' };

    applyOpenAIServiceTier(requestBody, { serviceTier: ['default', 'fast'] }, { serviceTier: 'ultrafast' });

    assert.equal('service_tier' in requestBody, false);
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

for (const serviceTier of ['default', 'auto', 'flex', 'priority', 'fast', 'ultrafast']) {
    test(`Compatible OpenAI 原样发送 ${serviceTier}`, () => {
        const requestBody: Record<string, unknown> = {};
        const model = { serviceTier: ['default', 'auto', 'flex', 'priority', 'fast', 'ultrafast'] };

        applyOpenAIServiceTier(requestBody, model, { serviceTier }, 'compatible');

        assert.equal(requestBody.service_tier, serviceTier);
    });
}

test('Compatible OpenAI 透传端点私有等级', () => {
    const requestBody: Record<string, unknown> = {};

    applyOpenAIServiceTier(requestBody, { serviceTier: ['default', 'scale'] }, { serviceTier: 'scale' }, 'compatible');

    assert.equal(requestBody.service_tier, 'scale');
});

test('Compatible OpenAI 删除模型未声明的等级', () => {
    const requestBody: Record<string, unknown> = { service_tier: 'priority' };

    applyOpenAIServiceTier(
        requestBody,
        { serviceTier: ['default', 'priority'] },
        { serviceTier: 'scale' },
        'compatible'
    );

    assert.equal('service_tier' in requestBody, false);
});

test('非 Compatible OpenAI 的 default 仍不发送', () => {
    const requestBody: Record<string, unknown> = { service_tier: 'priority' };

    applyOpenAIServiceTier(requestBody, supportedModel, { serviceTier: 'default' }, 'codex');

    assert.equal('service_tier' in requestBody, false);
});
