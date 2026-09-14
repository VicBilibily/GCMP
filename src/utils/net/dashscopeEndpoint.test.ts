import assert from 'node:assert/strict';
import test from 'node:test';

import { configProviders } from '../../providers/config';
import { isDashscopeProviderSlot, resolveDashscopeBaseUrl } from './dashscopeEndpoint';

test('resolveDashscopeBaseUrl maps every China host to its international host', () => {
    assert.equal(
        resolveDashscopeBaseUrl('https://dashscope.aliyuncs.com/compatible-mode/v1', 'ap-southeast-1'),
        'https://dashscope-intl.aliyuncs.com/compatible-mode/v1'
    );
    assert.equal(
        resolveDashscopeBaseUrl('https://coding.dashscope.aliyuncs.com/apps/anthropic', 'ap-southeast-1'),
        'https://coding-intl.dashscope.aliyuncs.com/apps/anthropic'
    );
    assert.equal(
        resolveDashscopeBaseUrl('https://token-plan.cn-beijing.maas.aliyuncs.com/apps/anthropic', 'ap-southeast-1'),
        'https://token-plan.ap-southeast-1.maas.aliyuncs.com/apps/anthropic'
    );
});

test('resolveDashscopeBaseUrl keeps path and query string untouched', () => {
    assert.equal(
        resolveDashscopeBaseUrl('https://dashscope.aliyuncs.com/api/v1/mcps/WebSearch/mcp?x=1&y=2', 'ap-southeast-1'),
        'https://dashscope-intl.aliyuncs.com/api/v1/mcps/WebSearch/mcp?x=1&y=2'
    );
});

test('resolveDashscopeBaseUrl leaves the China site and unknown hosts unchanged', () => {
    const chinaUrl = 'https://coding.dashscope.aliyuncs.com/apps/anthropic';
    const intlUrl = 'https://coding-intl.dashscope.aliyuncs.com/apps/anthropic';
    const proxyUrl = 'https://proxy.example.com/v1';
    assert.equal(resolveDashscopeBaseUrl(chinaUrl, 'cn-beijing'), chinaUrl);
    assert.equal(resolveDashscopeBaseUrl(intlUrl, 'ap-southeast-1'), intlUrl);
    assert.equal(resolveDashscopeBaseUrl(proxyUrl, 'ap-southeast-1'), proxyUrl);
    assert.equal(
        resolveDashscopeBaseUrl('https://dashscope.aliyuncs.com:8443/v1', 'ap-southeast-1'),
        'https://dashscope.aliyuncs.com:8443/v1'
    );
    assert.equal(resolveDashscopeBaseUrl('', 'ap-southeast-1'), '');
    assert.equal(resolveDashscopeBaseUrl('not-a-url', 'ap-southeast-1'), 'not-a-url');
});

test('resolveDashscopeBaseUrl is idempotent', () => {
    const once = resolveDashscopeBaseUrl('https://dashscope.aliyuncs.com/compatible-mode/v1', 'ap-southeast-1');
    assert.equal(resolveDashscopeBaseUrl(once, 'ap-southeast-1'), once);
});

test('isDashscopeProviderSlot recognizes the standard slot and the built-in plan variants', () => {
    for (const slot of ['dashscope', 'dashscope-coding', 'dashscope-token', 'dashscope-token-personal']) {
        assert.equal(isDashscopeProviderSlot(slot), true, slot);
    }
});

test('isDashscopeProviderSlot rejects non-DashScope slots', () => {
    for (const slot of [undefined, '', 'compatible', 'zhipu', 'minimax-token', 'dashscope-relay']) {
        assert.equal(isDashscopeProviderSlot(slot), false, String(slot));
    }
});

test('isDashscopeProviderSlot covers every slot declared by the built-in DashScope models', () => {
    for (const model of configProviders.dashscope.models) {
        if (model.provider) {
            assert.equal(isDashscopeProviderSlot(model.provider), true, model.provider);
        }
    }
});