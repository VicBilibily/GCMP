import assert from 'node:assert/strict';
import test from 'node:test';

import { getReasoningReplayPolicy, shouldInjectReasoningPlaceholder } from './reasoningReplayPolicy';

test('MiMo models replay reasoning from marker — unified to always-inject like DeepSeek-V4', () => {
    const policy = getReasoningReplayPolicy({
        providerKey: 'compatible',
        modelConfig: {
            id: 'mimo-v2.5-pro',
            baseUrl: 'https://api.xiaomimimo.com/v1'
        }
    });

    assert.deepEqual(policy, {
        restoreFromStatefulMarker: true,
        missingReasoningFieldPolicy: 'always'
    });
    assert.equal(shouldInjectReasoningPlaceholder(policy, false, false), true);
    assert.equal(shouldInjectReasoningPlaceholder(policy, true, false), true);
});

test('MiMo token-plan provider still requires placeholder when marker says tool calls existed', () => {
    const policy = getReasoningReplayPolicy({
        providerKey: 'xiaomimimo-token',
        modelConfig: {
            id: 'custom-compatible-model'
        }
    });

    assert.equal(policy.restoreFromStatefulMarker, true);
    assert.equal(shouldInjectReasoningPlaceholder(policy, false, true), true);
});

test('MiMo anthropic-compatible endpoint uses the same always-inject policy', () => {
    const policy = getReasoningReplayPolicy({
        providerKey: 'xiaomimimo-token',
        modelConfig: {
            id: 'mimo-v2.5-pro-token-plan',
            model: 'mimo-v2.5-pro',
            baseUrl: 'https://token-plan-cn.xiaomimimo.com/anthropic'
        }
    });

    assert.deepEqual(policy, {
        restoreFromStatefulMarker: true,
        missingReasoningFieldPolicy: 'always'
    });
    assert.equal(shouldInjectReasoningPlaceholder(policy, true, false), true);
});

test('DeepSeek-V4 always keeps a reasoning_content placeholder fallback', () => {
    const policy = getReasoningReplayPolicy({
        providerKey: 'compatible',
        modelConfig: {
            model: 'deepseek-v4-chat'
        }
    });

    assert.deepEqual(policy, {
        restoreFromStatefulMarker: true,
        missingReasoningFieldPolicy: 'always'
    });
    assert.equal(shouldInjectReasoningPlaceholder(policy, false, false), true);
});

test('Unrelated OpenAI-compatible models do not backfill reasoning_content', () => {
    const policy = getReasoningReplayPolicy({
        providerKey: 'compatible',
        modelConfig: {
            id: 'gpt-4.1-mini',
            baseUrl: 'https://api.openai.com/v1'
        }
    });

    assert.deepEqual(policy, {
        restoreFromStatefulMarker: false,
        missingReasoningFieldPolicy: 'never'
    });
    assert.equal(shouldInjectReasoningPlaceholder(policy, true, true), false);
});

// ── Converter 级集成决策测试 ──
// 模拟 convertAssistantMessage 和 apiMessageToAnthropicContent 中的完整判定链路。
// 这些测试不直接导入 converter（需要 VS Code 运行时），但精确复现其决策树。

/**
 * 模拟 OpenAI convertAssistantMessage 的 thinking 恢复决策：
 *  1. 调 getReasoningReplayPolicy
 *  2. 若无 ThinkingPart 且 policy.restoreFromStatefulMarker：
 *     a. 从 marker 取 completeThinking / hasToolCalls
 *     b. 有 completeThinking → 直接用
 *     c. 否则走 shouldInjectReasoningPlaceholder
 */
function simulateOpenAIAssistantThinkingRecovery(
    policyContext: Parameters<typeof getReasoningReplayPolicy>[0],
    markerCompleteThinking: string | undefined,
    markerHasToolCalls: boolean | undefined,
    currentToolCallsCount: number
): string | null {
    const policy = getReasoningReplayPolicy(policyContext);
    if (!policy.restoreFromStatefulMarker) {
        return null;
    }
    if (markerCompleteThinking) {
        return markerCompleteThinking;
    }
    if (shouldInjectReasoningPlaceholder(policy, currentToolCallsCount > 0, markerHasToolCalls)) {
        return ' ';
    }
    return null;
}

/**
 * 模拟 Anthropic apiMessageToAnthropicContent 的 thinking 恢复决策：
 *  1. 调 getReasoningReplayPolicy
 *  2. 若 thinkingBlocks 为空且 policy.restoreFromStatefulMarker：
 *     a. 从 marker 取 thinking / hasToolCalls
 *     b. 检查 otherBlocks 是否有 tool_use
 *     c. marker.thinking 非空 或 shouldInjectReasoningPlaceholder → 补 thinking 块
 */
function simulateAnthropicThinkingRecovery(
    policyContext: Parameters<typeof getReasoningReplayPolicy>[0],
    markerThinking: string | undefined,
    markerHasToolCalls: boolean | undefined,
    hasToolUseBlocks: boolean
): { thinking: string; signature: string } | null {
    const policy = getReasoningReplayPolicy(policyContext);
    if (!policy.restoreFromStatefulMarker) {
        return null;
    }
    if (markerThinking || shouldInjectReasoningPlaceholder(policy, hasToolUseBlocks, markerHasToolCalls)) {
        return { thinking: markerThinking || ' ', signature: '' };
    }
    return null;
}

test('OpenAI: MiMo with marker completeThinking uses it directly', () => {
    const result = simulateOpenAIAssistantThinkingRecovery(
        { providerKey: 'xiaomimimo', modelConfig: { id: 'mimo-v2.5-pro' } },
        'full reasoning from marker',
        true,
        2
    );
    assert.equal(result, 'full reasoning from marker');
});

test('OpenAI: MiMo always injects placeholder even without marker thinking or tool calls', () => {
    const result = simulateOpenAIAssistantThinkingRecovery(
        { providerKey: 'xiaomimimo-token', modelConfig: { id: 'mimo-v2.5' } },
        undefined,
        undefined,
        0
    );
    // Unified with DeepSeek-V4: always inject placeholder
    assert.equal(result, ' ');
});

test('OpenAI: MiMo without marker thinking but with current tool calls DOES inject placeholder', () => {
    const result = simulateOpenAIAssistantThinkingRecovery(
        { providerKey: 'compatible', modelConfig: { baseUrl: 'https://token-plan-cn.xiaomimimo.com/v1' } },
        undefined,
        false,
        1
    );
    assert.equal(result, ' ');
});

test('OpenAI: MiMo without marker thinking but marker says history had tool calls injects placeholder', () => {
    const result = simulateOpenAIAssistantThinkingRecovery(
        { providerKey: 'xiaomimimo-token', modelConfig: { id: 'mimo-v2-omni' } },
        undefined,
        true,
        0
    );
    assert.equal(result, ' ');
});

test('OpenAI: DeepSeek-V4 always injects placeholder regardless of tool calls', () => {
    const result = simulateOpenAIAssistantThinkingRecovery(
        { modelConfig: { model: 'deepseek-v4-flash' } },
        undefined,
        undefined,
        0
    );
    assert.equal(result, ' ');
    const result2 = simulateOpenAIAssistantThinkingRecovery(
        { modelConfig: { model: 'deepseek-v4-chat' } },
        'full reasoning',
        true,
        0
    );
    assert.equal(result2, 'full reasoning');
});

test('OpenAI: Unrelated models skip entire recovery path', () => {
    const result = simulateOpenAIAssistantThinkingRecovery(
        { providerKey: 'openai', modelConfig: { id: 'gpt-4o' } },
        'ignored reasoning',
        true,
        3
    );
    assert.equal(result, null);
});

test('Anthropic: MiMo with marker thinking uses it directly', () => {
    const result = simulateAnthropicThinkingRecovery(
        { providerKey: 'xiaomimimo-token', modelConfig: { id: 'mimo-v2.5-pro-token-plan' } },
        'full anthropic thinking',
        true,
        false
    );
    assert.deepEqual(result, { thinking: 'full anthropic thinking', signature: '' });
});

test('Anthropic: MiMo always injects thinking block even without marker thinking or tool_use', () => {
    const result = simulateAnthropicThinkingRecovery(
        { providerKey: 'compatible', modelConfig: { id: 'mimo-v2.5-pro', baseUrl: 'https://api.xiaomimimo.com/v1' } },
        undefined,
        false,
        false
    );
    // Unified with DeepSeek-V4: always inject placeholder
    assert.deepEqual(result, { thinking: ' ', signature: '' });
});

test('Anthropic: MiMo without marker thinking but with tool_use blocks DOES inject placeholder', () => {
    const result = simulateAnthropicThinkingRecovery(
        { providerKey: 'xiaomimimo-token', modelConfig: { baseUrl: 'https://token-plan-cn.xiaomimimo.com/anthropic' } },
        undefined,
        false,
        true
    );
    assert.deepEqual(result, { thinking: ' ', signature: '' });
});

test('Anthropic: MiMo without marker thinking but marker says history had tool calls injects placeholder', () => {
    const result = simulateAnthropicThinkingRecovery(
        { providerKey: 'xiaomimimo-token', modelConfig: { id: 'mimo-v2-pro-token-plan' } },
        undefined,
        true,
        false
    );
    assert.deepEqual(result, { thinking: ' ', signature: '' });
});

test('Anthropic: DeepSeek-V4 always produces a thinking block', () => {
    const result = simulateAnthropicThinkingRecovery(
        { modelConfig: { model: 'deepseek-v4' } },
        undefined,
        false,
        false
    );
    assert.deepEqual(result, { thinking: ' ', signature: '' });
});

test('Anthropic: Unrelated models skip recovery entirely', () => {
    const result = simulateAnthropicThinkingRecovery(
        { providerKey: 'anthropic', modelConfig: { id: 'claude-sonnet-4-5' } },
        'ignored',
        true,
        true
    );
    assert.equal(result, null);
});
