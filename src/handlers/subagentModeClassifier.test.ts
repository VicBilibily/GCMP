import assert from 'node:assert/strict';
import test from 'node:test';

import { classifyModeOverlaySubagent } from './subagentModeClassifier';

const MAIN_AGENT_PREFIX = 'You are an expert AI programming assistant, working with a user in the VS Code editor.';

test('classifies explore mode overlay prompt as search subagent', () => {
    const systemPrompt = `${MAIN_AGENT_PREFIX}\n<modeInstructions>\nYou are currently running in "Explore" mode.\n</modeInstructions>`;

    assert.equal(classifyModeOverlaySubagent(systemPrompt, ['fetch_webpage']), 'search-subagent');
});

test('classifies execution mode overlay prompt as execution subagent', () => {
    const systemPrompt = `${MAIN_AGENT_PREFIX}\n<modeInstructions>\nYou are currently running in "Execution" mode.\n</modeInstructions>`;

    assert.equal(classifyModeOverlaySubagent(systemPrompt, ['run_in_terminal']), 'execution-subagent');
});

test('treats generic mode overlay as ambiguous instead of forcing a subagent kind', () => {
    const systemPrompt = `${MAIN_AGENT_PREFIX}\n<modeInstructions>\nYou are currently running in "Reviewer" mode.\n</modeInstructions>`;

    assert.equal(classifyModeOverlaySubagent(systemPrompt, ['read_file', 'grep_search']), undefined);
});

test('ignores main-agent prompt without mode overlay marker', () => {
    assert.equal(classifyModeOverlaySubagent(MAIN_AGENT_PREFIX, ['fetch_webpage']), undefined);
});

test('rejects explore mode overlay when tool profile is execution-only', () => {
    const systemPrompt = `${MAIN_AGENT_PREFIX}\n<modeInstructions>\nYou are currently running in "Explore" mode.\n</modeInstructions>`;

    assert.equal(classifyModeOverlaySubagent(systemPrompt, ['run_in_terminal']), undefined);
});
