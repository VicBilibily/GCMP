import assert from 'node:assert/strict';
import test from 'node:test';

import { UsageParser } from './usageParser';

test('Gemini usage includes thought output and tool-use input tokens', () => {
    const result = UsageParser.parseRawUsage({
        promptTokenCount: 100,
        candidatesTokenCount: 20,
        thoughtsTokenCount: 30,
        toolUsePromptTokenCount: 40,
        cachedContentTokenCount: 25,
        totalTokenCount: 190
    });

    assert.equal(result.actualInput, 140);
    assert.equal(result.cacheReadTokens, 25);
    assert.equal(result.cacheCreationTokens, 115);
    assert.equal(result.outputTokens, 50);
    assert.equal(result.totalTokens, 190);
});

test('Gemini usage prefers responseTokenCount when both output fields are present', () => {
    const result = UsageParser.parseRawUsage({
        promptTokenCount: 10,
        responseTokenCount: 7,
        candidatesTokenCount: 5,
        totalTokenCount: 17
    });

    assert.equal(result.outputTokens, 7);
    assert.equal(result.totalTokens, 17);
});

test('Gemini usage does not add thoughts already included in responseTokenCount', () => {
    const result = UsageParser.parseRawUsage({
        promptTokenCount: 334,
        responseTokenCount: 56,
        thoughtsTokenCount: 44,
        totalTokenCount: 390
    });

    assert.equal(result.actualInput, 334);
    assert.equal(result.outputTokens, 56);
    assert.equal(result.totalTokens, 390);
});

test('Gemini usage accepts omitted zero candidate count', () => {
    const result = UsageParser.parseRawUsage({
        promptTokenCount: 10,
        thoughtsTokenCount: 4,
        totalTokenCount: 14
    });

    assert.equal(result.actualInput, 10);
    assert.equal(result.outputTokens, 4);
    assert.equal(result.totalTokens, 14);
});

test('Gemini usage preserves response-only partial metadata', () => {
    const result = UsageParser.parseRawUsage({ responseTokenCount: 7 });

    assert.equal(result.actualInput, 0);
    assert.equal(result.outputTokens, 7);
    assert.equal(result.totalTokens, 7);
});

test('Gemini usage preserves candidate and thought-only partial metadata', () => {
    const result = UsageParser.parseRawUsage({ candidatesTokenCount: 5, thoughtsTokenCount: 3 });

    assert.equal(result.actualInput, 0);
    assert.equal(result.outputTokens, 8);
    assert.equal(result.totalTokens, 8);
});

test('Gemini usage preserves total-only partial metadata', () => {
    const result = UsageParser.parseRawUsage({ totalTokenCount: 11 });

    assert.equal(result.actualInput, 0);
    assert.equal(result.outputTokens, 0);
    assert.equal(result.totalTokens, 11);
});

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

test('Responses API cached_tokens 为 0 仍按 Responses 口径解析', () => {
    const result = UsageParser.parseRawUsage({
        input_tokens: 100,
        output_tokens: 20,
        total_tokens: 120,
        input_tokens_details: {
            cached_tokens: 0,
            cache_write_tokens: 12
        }
    });

    assert.equal(result.actualInput, 100);
    assert.equal(result.cacheReadTokens, 0);
    assert.equal(result.cacheCreationTokens, 0);
    assert.equal(result.outputTokens, 20);
    assert.equal(result.totalTokens, 120);
});

test('Responses API 含 cache_write_tokens', () => {
    // cache_write_tokens 由 costCalculator 的 getExplicitCacheWriteTokens 单独提取，
    // UsageParser 不将其计入 cacheCreationTokens（避免叠加/包含模式歧义）。
    const result = UsageParser.parseRawUsage({
        input_tokens: 335712,
        output_tokens: 1307,
        total_tokens: 337019,
        input_tokens_details: {
            cached_tokens: 332974,
            cache_write_tokens: 841
        }
    });

    assert.equal(result.actualInput, 335712);
    assert.equal(result.cacheReadTokens, 332974);
    assert.equal(result.cacheCreationTokens, 0);
    assert.equal(result.outputTokens, 1307);
    assert.equal(result.totalTokens, 337019);
});

test('空 rawUsage 返回默认值', () => {
    const result = UsageParser.parseRawUsage(null);

    assert.equal(result.actualInput, 0);
    assert.equal(result.cacheReadTokens, 0);
    assert.equal(result.cacheCreationTokens, 0);
    assert.equal(result.outputTokens, 0);
    assert.equal(result.totalTokens, 0);
});

for (const status of ['estimated', 'completed', 'cancelled', 'failed'] as const) {
    for (const hasOutputTimes of [false, true]) {
        test(`extendLog preserves tracker throughput only while estimated: ${status}, outputTimes=${hasOutputTimes}`, () => {
            const result = UsageParser.extendLog({
                requestId: 'pending-throughput',
                timestamp: 1000,
                isoTime: new Date(1000).toISOString(),
                providerKey: 'test',
                providerName: 'Test',
                modelId: 'test',
                modelName: 'Test',
                estimatedInput: 10,
                rawUsage: null,
                status,
                requestMetricStartTime: 1000,
                streamStartTime: 1250,
                firstOutputTime: hasOutputTimes ? 1500 : undefined,
                lastOutputTime: hasOutputTimes ? 3500 : undefined,
                outputTokens: 26,
                outputSpeed: 12.5
            });

            assert.equal(result.outputSpeed, status === 'estimated' ? 12.5 : undefined);
            assert.equal(result.timePerOutputToken, status === 'estimated' ? 80 : undefined);
            assert.equal(result.firstTokenLatency, hasOutputTimes ? 500 : 250);
            assert.equal(result.timingSource, hasOutputTimes ? 'output' : 'stream');
            assert.equal(result.outputTokens, 0);
            assert.equal(result.totalTokens, 10);
        });
    }
}

test('parseFromLog preserves actual TTFT and computes speed from all output tokens over stream duration', () => {
    const result = UsageParser.parseFromLog({
        requestId: 'timing-exact',
        timestamp: 1000,
        isoTime: new Date(1000).toISOString(),
        providerKey: 'test',
        providerName: 'Test',
        modelId: 'test-model',
        modelName: 'Test Model',
        estimatedInput: 10,
        rawUsage: { prompt_tokens: 10, completion_tokens: 101, total_tokens: 111 },
        status: 'completed',
        requestMetricStartTime: 1100,
        streamStartTime: 1200,
        streamEndTime: 2500,
        firstOutputTime: 1400,
        lastOutputTime: 2400
    });

    assert.equal(result.firstTokenLatency, 300);
    assert.equal(result.streamDuration, 1300);
    assert.equal(result.timePerOutputToken, 1300 / 101);
    assert.equal(result.outputSpeed, (101 / 1300) * 1000);
    assert.equal(result.timingSource, 'output');
});

test('parseFromLog includes Gemini thought tokens in the original average speed formula', () => {
    const result = UsageParser.parseFromLog({
        requestId: 'timing-gemini-thoughts',
        timestamp: 1000,
        isoTime: new Date(1000).toISOString(),
        providerKey: 'test',
        providerName: 'Test',
        modelId: 'gemini',
        modelName: 'Gemini',
        estimatedInput: 10,
        rawUsage: {
            promptTokenCount: 10,
            candidatesTokenCount: 21,
            thoughtsTokenCount: 80,
            totalTokenCount: 111
        },
        status: 'completed',
        requestMetricStartTime: 1100,
        streamStartTime: 1200,
        streamEndTime: 2500,
        firstOutputTime: 1400,
        lastOutputTime: 2400,
        firstContentOutputTime: 1400,
        lastContentOutputTime: 2400
    });

    assert.equal(result.outputTokens, 101);
    assert.equal(result.timePerOutputToken, 1300 / 101);
    assert.equal(result.outputSpeed, (101 / 1300) * 1000);
    assert.equal(result.timingSource, 'output');
});

for (const { rawUsage, outputTokens } of [
    { rawUsage: { promptTokenCount: 1, candidatesTokenCount: 11, thoughtsTokenCount: 100 }, outputTokens: 111 },
    {
        rawUsage: { prompt_tokens: 1, completion_tokens: 111, completion_tokens_details: { reasoning_tokens: 100 } },
        outputTokens: 111
    },
    {
        rawUsage: { input_tokens: 1, output_tokens: 111, output_tokens_details: { reasoning_tokens: 100 } },
        outputTokens: 111
    },
    { rawUsage: { promptTokenCount: 1, candidatesTokenCount: 11, thoughtsTokenCount: 0 }, outputTokens: 11 }
]) {
    test(`parseFromLog average speed does not depend on the content-only window: ${JSON.stringify(rawUsage)}`, () => {
        const log = {
            requestId: 'timing-thinking',
            timestamp: 1000,
            isoTime: new Date(1000).toISOString(),
            providerKey: 'test',
            providerName: 'Test',
            modelId: 'test',
            modelName: 'Test',
            estimatedInput: 1,
            status: 'completed' as const,
            rawUsage,
            requestMetricStartTime: 1000,
            streamStartTime: 1200,
            streamEndTime: 14000,
            firstOutputTime: 1200,
            lastOutputTime: 14000,
            firstContentOutputTime: 11200,
            lastContentOutputTime: 12200
        };
        const result = UsageParser.parseFromLog(log);
        assert.equal(result.firstTokenLatency, 200);
        assert.equal(result.outputTokens, outputTokens);
        assert.equal(result.timePerOutputToken, 12800 / outputTokens);
        assert.equal(result.outputSpeed, (outputTokens / 12800) * 1000);
        for (const window of [
            { firstContentOutputTime: undefined, lastContentOutputTime: undefined },
            { firstContentOutputTime: 11200, lastContentOutputTime: 11200 },
            { firstContentOutputTime: 11200, lastContentOutputTime: 11214 },
            { firstContentOutputTime: 11200, lastContentOutputTime: 10000 }
        ]) {
            const withContentWindow = UsageParser.parseFromLog({ ...log, ...window });
            assert.equal(withContentWindow.firstTokenLatency, 200);
            assert.equal(withContentWindow.timePerOutputToken, 12800 / outputTokens);
            assert.equal(withContentWindow.outputSpeed, (outputTokens / 12800) * 1000);
        }
    });
}

test('parseFromLog does not replace missing stream duration with the actual output window', () => {
    const log = {
        requestId: 'timing-anthropic',
        timestamp: 1000,
        isoTime: new Date(1000).toISOString(),
        providerKey: 'test',
        providerName: 'Test',
        modelId: 'test',
        modelName: 'Test',
        estimatedInput: 1,
        status: 'completed' as const,
        rawUsage: { input_tokens: 1, output_tokens: 111 },
        firstOutputTime: 1200,
        lastOutputTime: 12200,
        firstContentOutputTime: 11200,
        lastContentOutputTime: 12200
    };
    const result = UsageParser.parseFromLog(log);
    assert.equal(result.firstTokenLatency, 200);
    assert.equal(result.timePerOutputToken, undefined);
    assert.equal(result.outputSpeed, undefined);
});

test('parseFromLog computes average speed for a batched single output event', () => {
    const result = UsageParser.parseFromLog({
        requestId: 'timing-batched',
        timestamp: 1000,
        isoTime: new Date(1000).toISOString(),
        providerKey: 'test',
        providerName: 'Test',
        modelId: 'test-model',
        modelName: 'Test Model',
        estimatedInput: 10,
        rawUsage: { prompt_tokens: 10, completion_tokens: 100, total_tokens: 110 },
        status: 'completed',
        requestMetricStartTime: 1100,
        streamStartTime: 1200,
        streamEndTime: 1214,
        firstOutputTime: 1210,
        lastOutputTime: 1210,
        outputSpeed: 100000
    });

    assert.equal(result.firstTokenLatency, 110);
    assert.equal(result.timePerOutputToken, 14 / 100);
    assert.equal(result.outputSpeed, (100 / 14) * 1000);
    assert.equal(result.timingSource, 'output');
});

test('parseFromLog preserves average speed for a 14ms legacy stream', () => {
    const result = UsageParser.parseFromLog({
        requestId: 'timing-legacy-short',
        timestamp: 1000,
        isoTime: new Date(1000).toISOString(),
        providerKey: 'test',
        providerName: 'Test',
        modelId: 'test-model',
        modelName: 'Test Model',
        estimatedInput: 10,
        rawUsage: { prompt_tokens: 10, completion_tokens: 65, total_tokens: 75 },
        status: 'completed',
        requestMetricStartTime: 1100,
        streamStartTime: 1200,
        streamEndTime: 1214,
        outputSpeed: 4642.9
    });

    assert.equal(result.firstTokenLatency, 100);
    assert.equal(result.streamDuration, 14);
    assert.equal(result.timePerOutputToken, 14 / 65);
    assert.equal(result.outputSpeed, (65 / 14) * 1000);
    assert.equal(result.timingSource, 'stream');
});

test('parseFromLog counts every output token in a legacy stream', () => {
    const result = UsageParser.parseFromLog({
        requestId: 'timing-legacy',
        timestamp: 1000,
        isoTime: new Date(1000).toISOString(),
        providerKey: 'test',
        providerName: 'Test',
        modelId: 'test-model',
        modelName: 'Test Model',
        estimatedInput: 10,
        rawUsage: { prompt_tokens: 10, completion_tokens: 101, total_tokens: 111 },
        status: 'completed',
        requestMetricStartTime: 1100,
        streamStartTime: 1200,
        streamEndTime: 2200
    });

    assert.equal(result.firstTokenLatency, 100);
    assert.equal(result.timePerOutputToken, 1000 / 101);
    assert.equal(result.outputSpeed, 101);
    assert.equal(result.timingSource, 'stream');
});

for (const duration of [1, 3, 14, 99, 100]) {
    for (const outputTokens of [1, 65]) {
        test(`parseTiming preserves average speed for ${outputTokens} tokens in ${duration}ms`, () => {
            const result = UsageParser.parseTiming(
                { timestamp: 1000, streamStartTime: 1200, streamEndTime: 1200 + duration },
                outputTokens
            );
            assert.equal(result.streamDuration, duration);
            assert.equal(result.outputSpeed, (outputTokens / duration) * 1000);
            assert.equal(result.timePerOutputToken, duration / outputTokens);
        });
    }
}

test('parseTiming falls back to the log timestamp when stream start is missing', () => {
    const result = UsageParser.parseTiming({ timestamp: 1000, requestMetricStartTime: 1005, streamEndTime: 1014 }, 1);
    assert.equal(result.streamDuration, 14);
    assert.equal(result.outputSpeed, (1 / 14) * 1000);
    assert.equal(result.timePerOutputToken, 14);
});

for (const duration of [0, -1]) {
    test(`parseTiming does not divide by a non-positive stream duration: ${duration}ms`, () => {
        const result = UsageParser.parseTiming(
            { timestamp: 1000, streamStartTime: 1200, streamEndTime: 1200 + duration },
            1
        );
        assert.equal(result.outputSpeed, undefined);
        assert.equal(result.timePerOutputToken, undefined);
    });
}

test('parseTiming does not invent average speed without output tokens', () => {
    const result = UsageParser.parseTiming({ timestamp: 1000, streamStartTime: 1200, streamEndTime: 1214 }, 0);
    assert.equal(result.streamDuration, 14);
    assert.equal(result.outputSpeed, undefined);
    assert.equal(result.timePerOutputToken, undefined);
});
