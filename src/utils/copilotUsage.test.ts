import assert from 'node:assert/strict';
import test from 'node:test';

import { buildCopilotUsageData } from './copilotUsage';

test('buildCopilotUsageData keeps OpenAI usage details intact', () => {
    const usage = buildCopilotUsageData({
        prompt_tokens: 120,
        completion_tokens: 30,
        total_tokens: 150,
        prompt_tokens_details: {
            cached_tokens: 45,
            audio_tokens: 3
        },
        completion_tokens_details: {
            reasoning_tokens: 7
        }
    });

    assert.deepEqual(usage, {
        prompt_tokens: 120,
        completion_tokens: 30,
        total_tokens: 150,
        prompt_tokens_details: {
            cached_tokens: 45,
            audio_tokens: 3
        },
        completion_tokens_details: {
            reasoning_tokens: 7
        }
    });
});

test('buildCopilotUsageData converts Anthropic usage into Copilot format', () => {
    const usage = buildCopilotUsageData({
        input_tokens: 80,
        output_tokens: 20,
        cache_read_input_tokens: 40,
        cache_creation_input_tokens: 10
    });

    assert.deepEqual(usage, {
        prompt_tokens: 130,
        completion_tokens: 20,
        total_tokens: 150,
        prompt_tokens_details: {
            cached_tokens: 40,
            cache_creation_tokens: 10
        }
    });
});

test('buildCopilotUsageData converts Responses API usage into completion usage shape', () => {
    const usage = buildCopilotUsageData({
        input_tokens: 140,
        output_tokens: 25,
        total_tokens: 165,
        input_tokens_details: {
            cached_tokens: 60
        },
        output_tokens_details: {
            reasoning_tokens: 9
        }
    });

    assert.deepEqual(usage, {
        prompt_tokens: 140,
        completion_tokens: 25,
        total_tokens: 165,
        prompt_tokens_details: {
            cached_tokens: 60
        },
        completion_tokens_details: {
            reasoning_tokens: 9
        }
    });
});

test('buildCopilotUsageData keeps nested cache_creation details from anthropic-style usage', () => {
    const usage = buildCopilotUsageData({
        input_tokens: 6,
        output_tokens: 30,
        cache_creation_input_tokens: 27217,
        cache_read_input_tokens: 0,
        cache_creation: {
            ephemeral_5m_input_tokens: 27217
        }
    });

    assert.deepEqual(usage, {
        prompt_tokens: 27223,
        completion_tokens: 30,
        total_tokens: 27253,
        prompt_tokens_details: {
            cache_creation_ephemeral_5m_input_tokens: 27217,
            cached_tokens: 0,
            cache_creation_tokens: 27217
        }
    });
});

test('buildCopilotUsageData skips empty usage payloads', () => {
    assert.equal(buildCopilotUsageData({}), undefined);
    assert.equal(buildCopilotUsageData(undefined), undefined);
});

test('buildCopilotUsageData includes copilot_usage when nanoAiu is provided', () => {
    const usage = buildCopilotUsageData(
        {
            prompt_tokens: 120,
            completion_tokens: 30,
            total_tokens: 150,
            prompt_tokens_details: {
                cached_tokens: 45
            }
        },
        23226
    );

    assert.deepEqual(usage, {
        prompt_tokens: 120,
        completion_tokens: 30,
        total_tokens: 150,
        prompt_tokens_details: {
            cached_tokens: 45
        },
        copilot_usage: {
            total_nano_aiu: 23226
        }
    });
});

test('buildCopilotUsageData ignores invalid nanoAiu values', () => {
    const usage = buildCopilotUsageData(
        {
            prompt_tokens: 12,
            completion_tokens: 3,
            total_tokens: 15
        },
        -1
    );

    assert.deepEqual(usage, {
        prompt_tokens: 12,
        completion_tokens: 3,
        total_tokens: 15,
        prompt_tokens_details: {
            cached_tokens: 0
        }
    });
});
