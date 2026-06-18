import assert from 'node:assert/strict';
import test from 'node:test';

import { UsageParser } from './usageParser';

test('OpenAI-compatible: 标准口径 (prompt_tokens 包含 cached_tokens)', () => {
    const result = UsageParser.parseRawUsage({
        prompt_tokens: 150,
        completion_tokens: 30,
        total_tokens: 180,
        prompt_tokens_details: {
            cached_tokens: 45
        }
    });

    assert.equal(result.actualInput, 150);
    assert.equal(result.cacheReadTokens, 45);
    assert.equal(result.cacheCreationTokens, 105);
    assert.equal(result.outputTokens, 30);
    assert.equal(result.totalTokens, 180);
});

test('OpenAI-compatible: Hyper 网关口径 (prompt_tokens 仅表示未缓存输入, total_tokens 包含缓存)', () => {
    // Hyper 网关在命中缓存时的典型返回：
    // prompt_tokens=17 (仅新增/未缓存), cached_tokens=5801, total_tokens=5844, completion_tokens=26
    const result = UsageParser.parseRawUsage({
        prompt_tokens: 17,
        completion_tokens: 26,
        total_tokens: 5844,
        prompt_tokens_details: {
            cached_tokens: 5801
        }
    });

    // total_tokens - completion_tokens = 5844 - 26 = 5818 > prompt_tokens(17)
    // actualInput = Math.max(17, 5818) = 5818
    assert.equal(result.actualInput, 5818);
    // cacheReadTokens = Math.min(Math.max(0, 5801), 5818) = 5801
    assert.equal(result.cacheReadTokens, 5801);
    // cacheCreationTokens = 5818 - 5801 = 17
    assert.equal(result.cacheCreationTokens, 17);
    assert.equal(result.outputTokens, 26);
    // finalTotalTokens = Math.max(5844, 5818 + 26 = 5844) = 5844
    assert.equal(result.totalTokens, 5844);
});

test('OpenAI-compatible: cached_tokens 被 clamp 到 [0, actualInput]', () => {
    const result = UsageParser.parseRawUsage({
        prompt_tokens: 100,
        completion_tokens: 20,
        total_tokens: 120,
        prompt_tokens_details: {
            cached_tokens: 999
        }
    });

    // actualInput = Math.max(100, 120 - 20 = 100) = 100
    assert.equal(result.actualInput, 100);
    // cached_tokens 被 clamp: Math.min(999, 100) = 100
    assert.equal(result.cacheReadTokens, 100);
    // cacheCreationTokens = 100 - 100 = 0
    assert.equal(result.cacheCreationTokens, 0);
});

test('OpenAI-compatible: cached_tokens 为负数时被 clamp 到 0', () => {
    const result = UsageParser.parseRawUsage({
        prompt_tokens: 100,
        completion_tokens: 20,
        total_tokens: 120,
        prompt_tokens_details: {
            cached_tokens: -5
        }
    });

    assert.equal(result.cacheReadTokens, 0);
    assert.equal(result.actualInput, 100);
});

test('OpenAI-compatible: 无 cached_tokens 的标准场景', () => {
    const result = UsageParser.parseRawUsage({
        prompt_tokens: 100,
        completion_tokens: 20,
        total_tokens: 120
    });

    assert.equal(result.actualInput, 100);
    assert.equal(result.cacheReadTokens, 0);
    assert.equal(result.cacheCreationTokens, 100);
    assert.equal(result.outputTokens, 20);
    assert.equal(result.totalTokens, 120);
});

test('OpenAI-compatible: 空或异常数据返回默认值', () => {
    const result = UsageParser.parseRawUsage({
        prompt_tokens: 0,
        completion_tokens: 0,
        total_tokens: 0
    });

    assert.equal(result.actualInput, 0);
    assert.equal(result.outputTokens, 0);
    assert.equal(result.totalTokens, 0);
});

test('OpenAI-compatible: completion_tokens > total_tokens 的异常数据', () => {
    const result = UsageParser.parseRawUsage({
        prompt_tokens: 50,
        completion_tokens: 999,
        total_tokens: 100,
        prompt_tokens_details: {
            cached_tokens: 10
        }
    });

    // inputFromTotal = total - completion = 100 - 999 = -899 → 0 (被条件限制)
    // actualInput = Math.max(50, 0) = 50
    assert.equal(result.actualInput, 50);
    // cacheReadTokens = Math.min(Math.max(0, 10), 50) = 10
    assert.equal(result.cacheReadTokens, 10);
    // cacheCreationTokens = 50 - 10 = 40
    assert.equal(result.cacheCreationTokens, 40);
    assert.equal(result.outputTokens, 999);
    // finalTotalTokens = Math.max(100, 50 + 999 = 1049) = 1049
    assert.equal(result.totalTokens, 1049);
});

test('Anthropic 格式保持不变', () => {
    const result = UsageParser.parseRawUsage({
        input_tokens: 100,
        output_tokens: 30,
        cache_read_input_tokens: 20,
        cache_creation_input_tokens: 10
    });

    assert.equal(result.actualInput, 130); // 100 + 20 + 10
    assert.equal(result.cacheReadTokens, 20);
    assert.equal(result.cacheCreationTokens, 10);
    assert.equal(result.outputTokens, 30);
    assert.equal(result.totalTokens, 130 + 30);
});

test('Responses API 格式保持不变', () => {
    const result = UsageParser.parseRawUsage({
        input_tokens: 150,
        output_tokens: 30,
        total_tokens: 180,
        input_tokens_details: {
            cached_tokens: 45
        }
    });

    assert.equal(result.actualInput, 150);
    assert.equal(result.cacheReadTokens, 45);
    assert.equal(result.cacheCreationTokens, 0);
    assert.equal(result.outputTokens, 30);
    assert.equal(result.totalTokens, 180);
});

test('空 rawUsage 返回默认值', () => {
    const result = UsageParser.parseRawUsage(null);

    assert.equal(result.actualInput, 0);
    assert.equal(result.cacheReadTokens, 0);
    assert.equal(result.cacheCreationTokens, 0);
    assert.equal(result.outputTokens, 0);
    assert.equal(result.totalTokens, 0);
});
