import assert from 'node:assert/strict';
import test from 'node:test';

import { formatChatGPTPlanType } from './chatgptPlanType';

test('formatChatGPTPlanType maps personal seats to Codex TUI names', () => {
    assert.equal(formatChatGPTPlanType('free'), 'Free');
    assert.equal(formatChatGPTPlanType('go'), 'Go');
    assert.equal(formatChatGPTPlanType('plus'), 'Plus');
    assert.equal(formatChatGPTPlanType('pro'), 'Pro');
    assert.equal(formatChatGPTPlanType('prolite'), 'Pro Lite');
});

test('formatChatGPTPlanType maps team-like seats to Business', () => {
    assert.equal(formatChatGPTPlanType('team'), 'Business');
    assert.equal(formatChatGPTPlanType('self_serve_business_usage_based'), 'Business');
    assert.equal(formatChatGPTPlanType('self_serve_business_prolite'), 'Business Premium');
});

test('formatChatGPTPlanType maps business-like seats to Enterprise', () => {
    assert.equal(formatChatGPTPlanType('business'), 'Enterprise');
    assert.equal(formatChatGPTPlanType('ent26'), 'Enterprise');
    assert.equal(formatChatGPTPlanType('enterprise'), 'Enterprise');
    assert.equal(formatChatGPTPlanType('hc'), 'Enterprise');
    assert.equal(formatChatGPTPlanType('enterprise_cbp_usage_based'), 'Enterprise');
    assert.equal(formatChatGPTPlanType('enterprise_cbp_automation'), 'Enterprise (Automation)');
});

test('formatChatGPTPlanType maps education seats to Edu names', () => {
    assert.equal(formatChatGPTPlanType('edu'), 'Edu');
    assert.equal(formatChatGPTPlanType('education'), 'Edu');
    assert.equal(formatChatGPTPlanType('edu_plus'), 'Edu Plus');
    assert.equal(formatChatGPTPlanType('edu_pro'), 'Edu Pro');
});

test('formatChatGPTPlanType is case-insensitive and preserves unknown values', () => {
    assert.equal(formatChatGPTPlanType('TEAM'), 'Business');
    assert.equal(formatChatGPTPlanType(' Plus '), 'Plus');
    assert.equal(formatChatGPTPlanType('unknown_plan'), 'unknown_plan');
    assert.equal(formatChatGPTPlanType(''), '');
    assert.equal(formatChatGPTPlanType(undefined), '');
});
