import { createHash } from 'node:crypto';

type SdkPurpose = 'main-agent' | 'search-subagent' | 'execution-subagent' | 'subagent';

interface PromptBlock {
    name: string;
    lines: string[];
    children: Map<string, PromptBlock>;
}

interface PromptStructure {
    blocks: Map<string, PromptBlock>;
    text: string;
}

function readStructure(text: string): PromptStructure | undefined {
    const blocks = new Map<string, PromptBlock>();
    const stack: PromptBlock[] = [];
    const rootLines: string[] = [];
    let fence: string | undefined;
    for (const line of text.replace(/\r\n?/g, '\n').split('\n')) {
        const delimiter = /^\s*(`{3,}|~{3,})/.exec(line)?.[1];
        if (fence) {
            if (delimiter?.[0] === fence[0] && delimiter.length >= fence.length) {
                fence = undefined;
            }
            continue;
        }
        if (delimiter) {
            fence = delimiter;
            continue;
        }
        if (/^\s*>/.test(line)) {
            continue;
        }
        const inline = /^\s*<([a-z][a-z0-9_-]*)>([^<>]*)<\/\1>\s*$/.exec(line);
        const open = inline ?? /^\s*<([a-z][a-z0-9_-]*)>\s*$/.exec(line);
        if (open) {
            const parent = stack.at(-1);
            const siblings = parent?.children ?? blocks;
            if (
                siblings.has(open[1]) &&
                open[1] !== 'example' &&
                !(parent?.name === 'available_skills' && open[1] === 'skill')
            ) {
                return undefined;
            }
            const block: PromptBlock = { name: open[1], lines: inline ? [inline[2]] : [], children: new Map() };
            siblings.set(block.name, block);
            if (!inline) {
                stack.push(block);
            }
            continue;
        }
        const close = /<\/([a-z][a-z0-9_-]*)>\s*$/.exec(line);
        if (close) {
            const block = stack.pop();
            const content = line.slice(0, close.index);
            if (block?.name !== close[1] || /^\s*</.test(content) || /<\/[a-z][a-z0-9_-]*>/.test(content)) {
                return undefined;
            }
            block.lines.push(content);
            continue;
        }
        (stack.at(-1)?.lines ?? rootLines).push(line);
    }
    return stack.length === 0 && !fence ? { blocks, text: rootLines.join('\n').trim() } : undefined;
}

function startsWith(block: PromptBlock | undefined, prefix: string): boolean {
    return block?.lines.join('\n').trim().startsWith(prefix) === true;
}

function hasGuard(block: PromptBlock | undefined): boolean {
    return (
        startsWith(
            block,
            'Things you *must not* do (doing any one of these would violate our security and privacy policies):'
        ) &&
        block?.lines.some(line =>
            line.startsWith('You *must* avoid doing any of these things you cannot or must not do,')
        ) === true
    );
}

function hasToolCalling(block: PromptBlock | undefined): boolean {
    return (
        startsWith(block, 'You have the capability to call multiple tools in a single response.') &&
        block?.lines.some(line =>
            line.startsWith('For maximum efficiency, whenever you need to perform multiple independent operations,')
        ) === true
    );
}

function hasEnvironment(block: PromptBlock | undefined): boolean {
    return (
        startsWith(
            block,
            'You are working in the following environment. You do not need to make additional tool calls to verify this.'
        ) &&
        ['* Current working directory:', '* Operating System:', '* Available tools:'].every(prefix =>
            block?.lines.some(line => line.startsWith(prefix))
        )
    );
}

function hasTaskFrame(structure: PromptStructure): boolean {
    const { blocks, text } = structure;
    const code = blocks.get('code_change_instructions');
    return (
        startsWith(
            code?.children.get('rules_for_code_changes'),
            '* Make precise, complete, surgical changes that fully address the request;'
        ) &&
        startsWith(code?.children.get('linting_building_testing'), '* Use existing linters, builds, and tests;') &&
        code?.children.has('using_ecosystem_tools') === true &&
        code.children.has('style') &&
        startsWith(blocks.get('tips_and_tricks'), '* Reflect on command output before proceeding to next step') &&
        hasGuard(blocks.get('environment_limitations')?.children.get('prohibited_actions')) &&
        text.includes('Your goal is to deliver complete, working solutions.') &&
        startsWith(
            blocks.get('task_completion'),
            '* A task is not complete until the expected outcome is verified and persistent'
        ) &&
        text.includes('Respond concisely to the user, but be thorough in your work.')
    );
}

// 已验证的 SDK 运行模板仅作为组合签名，不代表上游用途或调用身份契约。
export function getSdkSystemPurposes(text: string): readonly SdkPurpose[] {
    const structure = readStructure(text);
    if (!structure) {
        return [];
    }
    const { blocks, text: root } = structure;
    const purposes: SdkPurpose[] = [];
    const taskFrame = hasTaskFrame(structure);
    if (
        taskFrame &&
        startsWith(
            blocks.get('system_notifications'),
            'The runtime may send <system_notification>-wrapped status updates,'
        ) &&
        (startsWith(blocks.get('solution_persistence'), 'Be extremely biased for action.') ||
            (startsWith(
                blocks.get('exploration_and_reading_files'),
                'Files are truncated at 20KB. Always use view_range for targeted reads on large files.'
            ) &&
                startsWith(
                    blocks.get('tools')?.children.get('tool_preferences'),
                    'Important: Whenever possible, use built-in tools rather than bash commands:'
                ) &&
                startsWith(
                    blocks.get('tools')?.children.get('code_search_tools'),
                    'For symbols, relationships, or concepts, prefer available code intelligence'
                )) ||
            (startsWith(
                blocks.get('user_progress_updates'),
                "As you work, frequently provide brief updates to let the user know what you're doing and why."
            ) &&
                startsWith(
                    blocks.get('reduce_aggressive_code_changes'),
                    'Review the problem statement carefully. Determine if just an explanation is enough or if a code change is being requested explicitly.'
                ) &&
                startsWith(
                    blocks.get('tools')?.children.get('file_paths_for_edit_view_create'),
                    'Before editing or creating files, verify that the file paths you plan to use are valid.'
                ) &&
                startsWith(
                    blocks.get('tools')?.children.get('tool_preferences'),
                    'Important: Use built-in tools instead of bash tools whenever possible.'
                )) ||
            (startsWith(
                blocks.get('tool_calling'),
                'When you launch a background task agent, treat it as a parallelism opportunity: immediately continue with your own independent tool calls'
            ) &&
                startsWith(
                    blocks.get('tools')?.children.get('code_search_tools'),
                    'For symbols, relationships, or concepts, prefer available code intelligence'
                )))
    ) {
        purposes.push('main-agent');
    }
    if (
        hasGuard(blocks.get('prohibited_actions')) &&
        hasToolCalling(blocks.get('tool_calling')) &&
        hasEnvironment(blocks.get('environment_context'))
    ) {
        if (
            root.includes('**CRITICAL: Ensure a response is returned to your caller.**') &&
            root.includes('- Your PRIMARY output channel is your response text')
        ) {
            purposes.push('subagent');
        } else if (
            root.includes('**CRITICAL: Do NOT write output to files.**') &&
            root.includes('- Your ONLY output channel is your response text')
        ) {
            if (root.startsWith('You are an exploration agent. Answer the question as fast as possible, then stop.')) {
                purposes.push('search-subagent');
            } else if (
                root.startsWith(
                    'You are a command execution agent that runs development commands and reports results efficiently.'
                )
            ) {
                purposes.push('execution-subagent');
            } else if (
                root.startsWith(
                    'You are a research specialist subagent responsible for executing detailed searches based on instructions from the main agent orchestrating a research project.'
                ) &&
                root.includes(
                    'You receive specific search instructions from the main agent. Execute those instructions and report comprehensive results.'
                )
            ) {
                purposes.push('search-subagent');
            } else if (
                (root.startsWith('You are a code review agent with an extremely high bar for feedback.') ||
                    root.startsWith(
                        'You are the security-review subagent, acting as a senior security engineer conducting a thorough security review of code changes.'
                    )) &&
                root.includes('**CRITICAL: You Must NEVER Modify Code.**')
            ) {
                purposes.push('subagent');
            }
        }
    }
    if (
        root.startsWith("As a sub-agent, complete your parent's task yourself;") &&
        root.includes('You are running in non-interactive mode and have no way to communicate with the user.') &&
        root.includes('**CRITICAL: Do NOT use /tmp or temporary directories for ANY file operations.**') &&
        taskFrame &&
        startsWith(
            blocks.get('tool_calling'),
            'When you launch a background task agent, treat it as a parallelism opportunity: immediately continue with your own independent tool calls'
        ) &&
        hasEnvironment(blocks.get('environment_context'))
    ) {
        purposes.push('subagent');
    }
    return purposes;
}

// 新旧入口共用交接摘要模板，不能据此确定运行来源。
export function isSharedHandoffSummary(text: string): boolean {
    const structure = readStructure(text);
    if (!structure) {
        return false;
    }
    const { blocks, text: root } = structure;
    return (
        root.startsWith('Your task is to create a comprehensive, detailed summary of the entire conversation') &&
        ['Recent Context Analysis', 'Analysis Process', 'Summary Structure', 'Quality Guidelines'].every(heading =>
            root.includes(`\n## ${heading}\n`)
        ) &&
        startsWith(blocks.get('analysis'), '[Chronological Review:') &&
        blocks.get('analysis')?.lines.some(line => line.startsWith('[Recent Commands Analysis:')) === true &&
        [
            'Conversation Overview',
            'Technical Foundation',
            'Codebase Status',
            'Problem Resolution',
            'Progress Tracking',
            'Active Work State',
            'Recent Operations',
            'Continuation Plan'
        ].every((heading, index) =>
            blocks.get('summary')?.lines.some(line => line.trim() === `${index + 1}. ${heading}:`)
        ) &&
        root.includes(
            'This summary should serve as a comprehensive handoff document that enables seamless continuation of all active work streams'
        )
    );
}

export function getSdkSessionContextHash(text: string): string | undefined {
    const purposes = getSdkSystemPurposes(text);
    if (purposes.length !== 1 || purposes[0] !== 'main-agent') {
        return undefined;
    }
    const block = readStructure(text)?.blocks.get('session_context');
    if (!block || block.children.size > 0) {
        return undefined;
    }
    const context = block.lines.join('\n').trim();
    const folder =
        /^Session folder: ((?:[a-z]:[\\/]|\/)[^\r\n<>]*[\\/]session-state[\\/][0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12})\n\nContents:\n- files\/: Persistent storage for session artifacts(?:\n|$)/i.exec(
            context
        )?.[1];
    if (
        !folder ||
        folder.length > 4096 ||
        !context.endsWith(
            "files/ persists across checkpoints for artifacts that shouldn't be committed (e.g., architecture diagrams, task breakdowns, user preferences)."
        )
    ) {
        return undefined;
    }
    const normalized = folder.replace(/\\/g, '/');
    return createHash('sha256')
        .update(/^[a-z]:/i.test(folder) ? normalized.toLowerCase() : normalized)
        .digest('hex');
}

export const SDK_COMPACTION_PROMPT_PREFIX =
    "Please create a detailed summary of the conversation so far. The history is being compacted so moving forward, all conversation history will be removed and you'll only have this summary to work from.";

export function isSdkCompactionCandidate(text: string): boolean {
    const normalized = text.replace(/\r\n?/g, '\n');
    return (
        normalized.startsWith(SDK_COMPACTION_PROMPT_PREFIX) &&
        normalized.includes('\nThe summary should include the following parts:\n') &&
        ['overview', 'history', 'work_done', 'technical_details', 'important_files', 'next_steps'].every(
            (name, index) => normalized.includes(`\n${index + 1}. <${name}> - `)
        ) &&
        normalized.includes('\n## Section Guidelines\n') &&
        ['Overview', 'History', 'Work Done', 'Technical Details', 'Important Files', 'Next Steps'].every(name =>
            normalized.includes(`\n### ${name}\n`)
        )
    );
}
