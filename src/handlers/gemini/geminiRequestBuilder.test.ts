import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { buildGeminiRequest, buildGeminiThinkingConfig, normalizeGeminiUsage } from './geminiRequestBuilder';

describe('buildGeminiThinkingConfig', () => {
    it('未显式设置时省略 thinkingConfig（不支持思考的模型收到该字段会报错）', () => {
        assert.equal(buildGeminiThinkingConfig({}), undefined);
        assert.equal(buildGeminiThinkingConfig({ isSubRequest: false }), undefined);
    });

    it('显式启用时开启动态思考并返回思考文本', () => {
        assert.deepEqual(buildGeminiThinkingConfig({ thinking: 'enabled' }), { includeThoughts: true });
        assert.deepEqual(buildGeminiThinkingConfig({ thinking: 'auto' }), { includeThoughts: true });
        assert.deepEqual(buildGeminiThinkingConfig({ thinking: 'adaptive' }), { includeThoughts: true });
        assert.deepEqual(buildGeminiThinkingConfig({ reasoningEffort: 'high' }), { includeThoughts: true });
    });

    it('thinking: disabled 以 thinkingBudget: 0 真正关闭内部推理', () => {
        assert.deepEqual(buildGeminiThinkingConfig({ thinking: 'disabled' }), { thinkingBudget: 0 });
    });

    it('reasoningEffort none/minimal 以 thinkingBudget: 0 关闭推理', () => {
        assert.deepEqual(buildGeminiThinkingConfig({ reasoningEffort: 'none' }), { thinkingBudget: 0 });
        assert.deepEqual(buildGeminiThinkingConfig({ reasoningEffort: 'minimal' }), { thinkingBudget: 0 });
    });

    it('子请求强制以 thinkingBudget: 0 关闭推理（即使 thinking 为 enabled）', () => {
        assert.deepEqual(buildGeminiThinkingConfig({ thinking: 'enabled', isSubRequest: true }), { thinkingBudget: 0 });
    });
});

describe('buildGeminiRequest', () => {
    const contents = [{ role: 'user' as const, parts: [{ text: 'hello' }] }];

    it('组装基本请求：contents + maxOutputTokens', () => {
        const request = buildGeminiRequest({ contents, maxOutputTokens: 8192 });
        assert.equal(request.contents, contents);
        assert.deepEqual(request.generationConfig, { maxOutputTokens: 8192 });
    });

    it('systemInstruction 与 tools 按需写入', () => {
        const systemInstruction = { role: 'system' as const, parts: [{ text: 'sys' }] };
        const tools = [
            {
                functionDeclarations: [
                    { name: 'fn', description: 'd', parameters: { type: 'object' as const } }
                ]
            }
        ];
        const request = buildGeminiRequest({ contents, systemInstruction, tools, maxOutputTokens: 100 });
        assert.equal(request.systemInstruction, systemInstruction);
        assert.equal(request.tools, tools);
    });

    it('thinkingOptions 未显式设置时请求省略 generationConfig.thinkingConfig', () => {
        const request = buildGeminiRequest({
            contents,
            maxOutputTokens: 100,
            thinkingOptions: {}
        });
        assert.equal('thinkingConfig' in (request.generationConfig ?? {}), false);
    });

    it('thinkingOptions 禁用思考时以 thinkingBudget: 0 关闭推理', () => {
        const request = buildGeminiRequest({
            contents,
            maxOutputTokens: 100,
            thinkingOptions: { thinking: 'disabled' }
        });
        assert.deepEqual(request.generationConfig?.thinkingConfig, { thinkingBudget: 0 });
    });

    it('thinkingOptions 启用思考时写入 generationConfig.thinkingConfig', () => {
        const request = buildGeminiRequest({
            contents,
            maxOutputTokens: 100,
            thinkingOptions: { thinking: 'enabled' }
        });
        assert.deepEqual(request.generationConfig?.thinkingConfig, { includeThoughts: true });
    });

    it('extraBody 合并且不允许覆盖核心参数', () => {
        const request = buildGeminiRequest({
            contents,
            maxOutputTokens: 100,
            extraBody: {
                safetySettings: [{ category: 'HARM', threshold: 'OFF' }],
                customFlag: true,
                generationConfig: { temperature: 0.5 }
            }
        });
        // safetySettings / generationConfig 属受保护参数，被过滤
        assert.equal(request.safetySettings, undefined);
        assert.deepEqual(request.generationConfig, { maxOutputTokens: 100 });
        // 其他参数透传
        assert.equal(request.customFlag, true);
    });
});

describe('normalizeGeminiUsage', () => {
    it('undefined 返回 undefined', () => {
        assert.equal(normalizeGeminiUsage(undefined), undefined);
    });

    it('映射基础字段', () => {
        const usage = normalizeGeminiUsage({
            promptTokenCount: 10,
            candidatesTokenCount: 20,
            totalTokenCount: 30
        });
        assert.deepEqual(usage, {
            prompt_tokens: 10,
            completion_tokens: 20,
            total_tokens: 30
        });
    });

    it('totalTokenCount 缺省时由输入输出求和', () => {
        const usage = normalizeGeminiUsage({ promptTokenCount: 10, candidatesTokenCount: 20 });
        assert.equal(usage?.total_tokens, 30);
    });

    it('缓存与思考 token 映射到 details，思考 token 计入输出（按输出计费）', () => {
        const usage = normalizeGeminiUsage({
            promptTokenCount: 10,
            candidatesTokenCount: 20,
            totalTokenCount: 37,
            cachedContentTokenCount: 5,
            thoughtsTokenCount: 7
        });
        assert.deepEqual(usage, {
            prompt_tokens: 10,
            completion_tokens: 27,
            total_tokens: 37,
            prompt_tokens_details: { cached_tokens: 5 },
            completion_tokens_details: { reasoning_tokens: 7 }
        });
    });

    it('思考 token 是单独计费的输出：输入100/回答10/思考40/总计150 → 输出50', () => {
        const usage = normalizeGeminiUsage({
            promptTokenCount: 100,
            candidatesTokenCount: 10,
            thoughtsTokenCount: 40,
            totalTokenCount: 150
        });
        assert.deepEqual(usage, {
            prompt_tokens: 100,
            completion_tokens: 50,
            total_tokens: 150,
            completion_tokens_details: { reasoning_tokens: 40 }
        });
    });

    it('无思考 token 时不输出 reasoning details', () => {
        const usage = normalizeGeminiUsage({
            promptTokenCount: 10,
            candidatesTokenCount: 20,
            totalTokenCount: 30,
            thoughtsTokenCount: 0
        });
        assert.deepEqual(usage, {
            prompt_tokens: 10,
            completion_tokens: 20,
            total_tokens: 30
        });
    });
});
