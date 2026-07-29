import assert from 'node:assert/strict';
import test from 'node:test';

import { isConversationCompactionPromptText } from './conversationCompactionPrompt';

const REAL_COMPACTION_PROMPT = `
The conversation has grown too large for the context window and must be compacted now.
Your task is to create a comprehensive, detailed summary of the entire conversation that captures all essential information needed to seamlessly continue the work without any loss of context.
This summary should serve as a comprehensive handoff document.
IMPORTANT: Output your summary wrapped in <summary> and </summary> tags.
Do NOT call any tools. Your ONLY task right now is to produce a comprehensive summary of the conversation so far.
`;

test('recognizes real conversation compaction prompt shape', () => {
    assert.equal(isConversationCompactionPromptText(REAL_COMPACTION_PROMPT), true);
});

test('rejects broad marker-only text without internal compaction instructions', () => {
    const userQuotedText = `
Please analyze this internal prompt:

The conversation has grown too large for the context window and must be compacted now.
Your task is to create a comprehensive, detailed summary of the entire conversation.

Why would this be triggered?
`;

    assert.equal(isConversationCompactionPromptText(userQuotedText), false);
});

test('rejects prompt-shaped text when required tool ban / summary wrapper instructions are missing', () => {
    const incompletePrompt = `
The conversation has grown too large for the context window and must be compacted now.
Your task is to create a comprehensive, detailed summary of the entire conversation.
Continue carefully.
`;

    assert.equal(isConversationCompactionPromptText(incompletePrompt), false);
});
