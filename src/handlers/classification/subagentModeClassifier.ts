export type ModeOverlaySubagentKind = 'search-subagent' | 'execution-subagent';

const EXPLORE_MODE_PATTERN = /you are currently running in\s+["']?explore["']?\s+mode/i;
const EXECUTION_MODE_PATTERN = /you are currently running in\s+["']?execution["']?\s+mode/i;

const SEARCH_TOOL_NAMES = new Set([
    'fetch_webpage',
    'file_search',
    'grep_search',
    'read_file',
    'github_repo',
    'github_text_search',
    'mcp_context7_query-docs',
    'mcp_context7_resolve-library-id',
    'gcmp_kimiwebsearch',
    'gcmp_minimaxwebsearch',
    'gcmp_stepfunwebsearch',
    'gcmp_zhipuwebsearch'
]);

const EXECUTION_TOOL_NAMES = new Set([
    'run_in_terminal',
    'send_to_terminal',
    'get_terminal_output',
    'run_task',
    'create_and_run_task',
    'run_notebook_cell',
    'run_playwright_code'
]);

function normalizeToolName(toolName: string): string {
    return toolName.trim().toLowerCase();
}

function countMatchingTools(toolNames: readonly string[], expectedToolNames: ReadonlySet<string>): number {
    let matches = 0;
    for (const toolName of toolNames) {
        if (expectedToolNames.has(normalizeToolName(toolName))) {
            matches++;
        }
    }
    return matches;
}

export function classifyModeOverlaySubagent(
    systemPromptText: string,
    toolNames: readonly string[]
): ModeOverlaySubagentKind | undefined {
    if (!systemPromptText.includes('<modeInstructions>')) {
        return undefined;
    }

    const searchToolMatches = countMatchingTools(toolNames, SEARCH_TOOL_NAMES);
    const executionToolMatches = countMatchingTools(toolNames, EXECUTION_TOOL_NAMES);

    if (EXPLORE_MODE_PATTERN.test(systemPromptText)) {
        if (executionToolMatches > 0 && searchToolMatches === 0) {
            return undefined;
        }
        return 'search-subagent';
    }

    if (EXECUTION_MODE_PATTERN.test(systemPromptText)) {
        if (searchToolMatches > 0 && executionToolMatches === 0) {
            return undefined;
        }
        return 'execution-subagent';
    }

    // runSubagent 与顶层自定义 mode 在当前提示形态下不可可靠区分。
    return undefined;
}
