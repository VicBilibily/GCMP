const CONVERSATION_COMPACTION_PROMPT_PREFIX =
    'The conversation has grown too large for the context window and must be compacted now.';

const CONVERSATION_COMPACTION_REQUIRED_MARKERS = [
    'Your task is to create a comprehensive, detailed summary of the entire conversation',
    'IMPORTANT: Output your summary wrapped in <summary> and </summary> tags.',
    'Do NOT call any tools. Your ONLY task right now is to produce a comprehensive summary of the conversation so far.'
] as const;

function normalizeWhitespace(text: string): string {
    return text.replace(/\s+/g, ' ').trim();
}

export function isConversationCompactionPromptText(text: string): boolean {
    const normalizedText = normalizeWhitespace(text);
    if (!normalizedText.startsWith(CONVERSATION_COMPACTION_PROMPT_PREFIX)) {
        return false;
    }

    return CONVERSATION_COMPACTION_REQUIRED_MARKERS.every(marker => normalizedText.includes(marker));
}
