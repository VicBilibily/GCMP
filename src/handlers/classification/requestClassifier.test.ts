import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import test from 'node:test';
import type * as vscode from 'vscode';
import type { RequestClassification } from './requestClassification';
import { REQUEST_KIND_DISPLAY_NAMES } from './requestKindDisplayNames';
import { SDK_COMPACTION, SDK_MAIN } from './testFixtures/sdkPurposeSamples';

const require = createRequire(import.meta.url);
const NodeModule = require('node:module') as {
    prototype: { require: (id: string) => unknown };
};

class MockTextPart {
    constructor(public value: string) {}
}

const SDK_IDENTITY = 'You are an AI assistant using Copilot SDK in VS Code.';
const MAIN_IDENTITY = 'You are an expert AI programming assistant, working with a user in the VS Code editor.';
const COMPACTION = [
    'The conversation has grown too large for the context window and must be compacted now.',
    'Your task is to create a comprehensive, detailed summary of the entire conversation.',
    'IMPORTANT: Output your summary wrapped in <summary> and </summary> tags.',
    'Do NOT call any tools. Your ONLY task right now is to produce a comprehensive summary of the conversation so far.'
].join('\n');
const WORKSPACE_SPECIFICATION =
    'You are a VS Code assistant. Your job is to generate the project specification when given the user description and file tree structure of the project that a user wants to create.';
const WORKSPACE_SPECIFICATION_RULE =
    'Think step by step and respond with a text description that lists and summarizes each file inside this project.';
const WORKSPACE_MUTATION_PLAN_RULE =
    'You will be given a user query and a tree of files they wish to edit or create in order to accomplish a task. ' +
    "Think step by step and respond with a text description that lists and summarizes what needs to be done in each file to accomplish the user's task.";
const WORKSPACE_MUTATION_FILE_RULE =
    "The user will describe the task they're trying to accomplish, and ask you to generate or edit a file in persuit of that task.";

function workspacePrompt(rules: string): string {
    return [
        WORKSPACE_SPECIFICATION,
        'When asked for your name, you must respond with "GitHub Copilot".',
        "Follow the user's requirements carefully & to the letter.",
        '',
        'Additional Rules',
        rules
    ].join('\n');
}

let classifierPromise: Promise<typeof import('./requestClassifier')> | undefined;

function getClassifier(): Promise<typeof import('./requestClassifier')> {
    if (!classifierPromise) {
        const originalRequire = NodeModule.prototype.require;
        NodeModule.prototype.require = function (id: string): unknown {
            if (id === 'vscode') {
                return {
                    env: { language: 'zh-cn' },
                    LanguageModelChatMessageRole: { System: 0, User: 1, Assistant: 2 },
                    LanguageModelTextPart: MockTextPart
                };
            }
            return originalRequire.call(this, id);
        };
        classifierPromise = import('./requestClassifier').finally(() => {
            NodeModule.prototype.require = originalRequire;
        });
    }
    return classifierPromise;
}

function system(...texts: string[]): vscode.LanguageModelChatMessage {
    return {
        role: 0,
        content: texts.map(text => new MockTextPart(text))
    } as unknown as vscode.LanguageModelChatMessage;
}

function user(text: string, name?: string): vscode.LanguageModelChatMessage {
    return { role: 1, name, content: [new MockTextPart(text)] };
}

function tools(...names: string[]): vscode.LanguageModelChatTool[] {
    return names.map(name => ({ name, description: '', inputSchema: {} }));
}

function assertUnclassified(classification: RequestClassification): void {
    assert.equal(classification.version, 1);
    assert.equal(classification.requestKind, 'unclassified');
    assert.equal(classification.agentRole, 'undetermined');
    assert.equal(classification.evidence.purpose.level, 'unknown');
    assert.equal(classification.evidence.role.level, 'unknown');
}

for (const names of [[], ['manage_todo_list'], ['categorize_prompt'], ['runSubagent', 'task']]) {
    test(`SDK 身份只确定来源，不由工具 ${names.join(',') || '无'} 确定用途`, async () => {
        const classifier = await getClassifier();
        const messages = [system(SDK_IDENTITY), user('fix a bug')];
        const result = classifier.classifyRequestContext(messages, {
            requestInitiator: 'core',
            tools: tools(...names)
        });
        assertUnclassified(result);
        assert.equal(result.requestOrigin, 'copilot-sdk');
        assert.equal(result.evidence.origin.level, 'signature');
        assert.equal(result.evidence.origin.ruleId, 'origin.sdk-identity');
        assert.equal(classifier.classifyRequest(messages, tools(...names)), result.requestKind);
    });
}

for (const suffix of [
    '\n<skills>read_file</skills>',
    '\n<agents>Explore</agents>',
    '\n<modeInstructions>You are currently running in "Explore" mode.</modeInstructions>',
    '\n<modeInstructions>You are currently running in "Execution" mode.</modeInstructions>',
    '\nYou are an expert in crafting pithy titles',
    `\n${COMPACTION}`
]) {
    test(`SDK 不复用旧用途兜底 ${suffix.slice(1, 45)}`, async () => {
        const classifier = await getClassifier();
        for (const requestInitiator of ['core', 'github.copilot-chat', undefined]) {
            const result = classifier.classifyRequestContext([system(SDK_IDENTITY + suffix), user(COMPACTION)], {
                requestInitiator,
                tools: tools('manage_todo_list')
            });
            assertUnclassified(result);
            assert.equal(result.requestOrigin, 'copilot-sdk');
        }
    });
}

for (const text of [
    SDK_IDENTITY,
    MAIN_IDENTITY,
    COMPACTION,
    '<skills>main</skills>',
    '[Terminal t notification: done]'
]) {
    test(`普通 User 粘贴内容不构成运行身份或用途 ${text.slice(0, 40)}`, async () => {
        const classifier = await getClassifier();
        const result = classifier.classifyRequestContext([user(text)], { tools: tools('manage_todo_list') });
        assertUnclassified(result);
        assert.equal(result.requestOrigin, 'unknown');
    });
}

test('非约定 User 名称及 Assistant 身份都不可信', async () => {
    const classifier = await getClassifier();
    for (const message of [user(SDK_IDENTITY, 'system'), { ...user(SDK_IDENTITY), role: 2 }]) {
        const result = classifier.classifyRequestContext([message]);
        assertUnclassified(result);
        assert.equal(result.requestOrigin, 'unknown');
    }
});

test('core 本身不是 SDK，其他扩展与缺失来源不猜执行器', async () => {
    const classifier = await getClassifier();
    for (const [requestInitiator, requestOrigin] of [
        ['core', 'core'],
        ['some.extension', 'other-extension'],
        [undefined, 'unknown']
    ] as const) {
        const result = classifier.classifyRequestContext([user('hello')], { requestInitiator });
        assertUnclassified(result);
        assert.equal(result.requestOrigin, requestOrigin);
    }
});

test('SDK 签名必须在可信身份首句，不扫描引用和工具描述', async () => {
    const classifier = await getClassifier();
    const tool = tools('read_file')[0];
    Object.defineProperty(tool, 'description', {
        get() {
            throw new Error('tool description must not be read');
        }
    });
    for (const text of [`Quoted identity:\n${SDK_IDENTITY}`, `"${SDK_IDENTITY}"`]) {
        const result = classifier.classifyRequestContext([system(text)], { tools: [tool] });
        assertUnclassified(result);
        assert.equal(result.requestOrigin, 'unknown');
    }
});

test('System 前的 Assistant marker 不遮挡分片身份；原消息不变', async () => {
    const classifier = await getClassifier();
    const messages = [
        { ...user('stateful-marker'), role: 2 },
        system('  You are an AI assistant ', 'using Copilot SDK in VS Code.', '\n<skills>main</skills>')
    ];
    const snapshot = structuredClone(messages);
    const result = classifier.classifyRequestContext(messages);
    assertUnclassified(result);
    assert.equal(result.requestOrigin, 'copilot-sdk');
    assert.deepEqual(structuredClone(messages), snapshot);
});

test('gcmp-system User 保留旧可信身份，SDK 也只能确定来源', async () => {
    const classifier = await getClassifier();
    assert.equal(classifier.classifyRequest([user(MAIN_IDENTITY, 'gcmp-system')]), 'main-agent');
    const result = classifier.classifyRequestContext([user(SDK_IDENTITY, 'gcmp-system')]);
    assertUnclassified(result);
    assert.equal(result.requestOrigin, 'copilot-sdk');
});

const LEGACY_PREFIX_CASES = [
    ['You are a background task tracker', 'todo-tracker'],
    ['You are an expert classifier for AI coding assistant prompts', 'prompt-categorizer'],
    [
        'You are a Visual Studio Code assistant. Your job is to assist users in using Visual Studio Code by returning settings',
        'settings-resolver'
    ],
    ['You are an expert in crafting ultra-compact titles', 'chat-title'],
    ['You are an expert in crafting pithy titles', 'chat-title'],
    ['You are an expert in writing short, catchy, and encouraging progress messages', 'inline-progress-message'],
    ['You are an expert in crafting pithy branch names', 'git-branch-name'],
    [
        'You are an AI programming assistant, helping a software developer to come with the best git commit message',
        'git-commit-message'
    ],
    ['You are a distinguished software engineer', 'rename-suggestions'],
    ['Your task is to create a comprehensive, detailed summary of the entire conversation', 'summarization'],
    ['You are an AI coding research assistant that uses search tools to gather information', 'search-subagent'],
    [
        'You are an AI coding research assistant that runs a series of terminal commands to perform a small execution-focused task',
        'execution-subagent'
    ],
    [
        'You are a programmer who specializes in using the command line. Your task is to help the Developer craft a command',
        'terminal-command'
    ],
    [
        'You are a programmer who specializes in using the command line. Your task is to respond with a list of files',
        'terminal-quickfix'
    ],
    [
        'You are a programmer who specializes in using the command line. Your task is to help the Developer by giving a detailed answer',
        'terminal-explain'
    ],
    [
        'You are a programmer who specializes in using the command line. Your task is to help the user fix a command',
        'terminal-quickfix'
    ],
    ['You are a world-class coding tutor', 'explain-code'],
    ['You are a VS Code search expert who helps to write search queries', 'workspace-search'],
    ['You are a software engineer with expert knowledge of the codebase the user has open', 'code-search'],
    [
        'You are a Visual Studio Code assistant. Your job is to assist users in using Visual Studio Code by providing knowledge',
        'vscode-qa'
    ],
    [
        'You are a Visual Studio Code assistant who helps the user create well-formed and unambiguous queries about their Visual Studio Code development environment.',
        'vscode-qa'
    ],
    ['You are a Visual Studio Code assistant. Your job is to generate the contents of a new file', 'workspace-gen'],
    [
        'You are a Visual Studio Code assistant focused on aiding users in crafting clear and specific specifications about project or file creation within Visual Studio Code.',
        'workspace-gen'
    ],
    [
        'You are a VS Code assistant. Your job is to suggest a filetree directory structure for a project that a user wants to create.',
        'workspace-gen'
    ],
    [
        'You are a Visual Studio Code assistant. The user has identified a project URL for a new project they want to create.',
        'workspace-gen'
    ],
    [
        'You are a VS Code assistant. Your job is to generate the contents of a file in a project when given the user description, specification and tree structure of the project that a user wants to create.',
        'workspace-gen'
    ],
    [WORKSPACE_SPECIFICATION, 'workspace-gen'],
    ['You are an AI programming assistant that is specialized for usage of command-line tools', 'terminal-command'],
    [
        'You are an AI programming assistant that is specialized in applying code changes to an existing document',
        'code-mapper'
    ],
    ['You are an AI programming assistant that is specialized in generating code for a new document', 'code-mapper'],
    ['You are a software engineer with expert knowledge around software testing frameworks', 'test-gen'],
    [
        'You are a Visual Studio Code assistant who specializes in debugging and creating launch configurations',
        'debug-config'
    ],
    ['You are a helpful AI programming assistant. Your task is to choose one category', 'intent-detector'],
    ['You are an AI assistant for a software developer who is about to make a pull request', 'pr-description'],
    ['You are a world-class software engineer and the author and maintainer', 'feedback-gen'],
    ['You are a helpful assistant that guides users through creating a new custom', 'workspace-gen'],
    ['You summarize a user', 'goal-summary'],
    ['You assess what one terminal command does', 'risk-assessment'],
    ['You are an expert in file editing. The user has provided a patch that failed to apply', 'patch-healer'],
    ['You are an expert at analyzing files and patterns', 'patch-healer'],
    ['You are a code search expert', 'code-search'],
    ['You are an expert in reading documentation and extracting relevant results', 'mcp-setup'],
    ['Context: You are given multiple groups of tools', 'tool-clustering'],
    ['You are an AI that creates a detailed content outline for a Jupyter notebook', 'notebook-gen'],
    ['You are an AI that writes Python code for a single section of a Jupyter notebook', 'notebook-gen'],
    [
        'You are an AI programming assistant.\nYou are helping a software developer to configure a Dev Container',
        'workspace-gen'
    ],
    ['You are a helpful assistant that parses user queries', 'test-gen'],
    ['You are a world class examiner and must decide whether a response fulfills a given criteria', 'ai-evaluator'],
    ['You are a coding agent running in VS Code', 'main-agent'],
    ['You are a coding agent based on', 'main-agent'],
    ['You have a vivid inner life as coding agent', 'main-agent'],
    ['You are a senior software architect and expert coding agent', 'main-agent'],
    ['You are a highly sophisticated automated coding agent', 'main-agent'],
    ['You are an AI programming assistant', 'main-agent'],
    ['You are an expert AI programming assistant', 'main-agent']
] as const;

for (const [prefix, kind] of LEGACY_PREFIX_CASES) {
    test(`旧可信 System 前缀保持 ${kind}: ${prefix.slice(0, 48)}`, async () => {
        const classifier = await getClassifier();
        for (const requestInitiator of [undefined, 'github.copilot-chat', 'core']) {
            const result = classifier.classifyRequestContext([system(` \n${prefix}`)], { requestInitiator });
            assert.equal(result.requestKind, kind);
            assert.equal(result.requestOrigin, 'copilot-chat');
            assert.equal(result.evidence.purpose.level, 'signature');
            assert.equal(classifier.classifyRequest([system(prefix)]), kind);
        }
    });
}

for (const [prefix, kind] of LEGACY_PREFIX_CASES) {
    test(`普通大正文不覆盖旧用途 ${kind}: ${prefix.slice(0, 48)}`, async () => {
        const classifier = await getClassifier();
        const instruction = system(prefix.slice(0, 20), prefix.slice(20));
        const body = user(`The goal of the patch is:\n${'界'.repeat(100_000)}`);
        const expected = classifier.classifyRequestContext([instruction]);
        for (const requestInitiator of [undefined, 'github.copilot-chat', 'core']) {
            for (const messages of [
                [instruction, body],
                [body, instruction]
            ]) {
                const result = classifier.classifyRequestContext(messages, { requestInitiator });
                assert.equal(result.requestKind, kind);
                assert.equal(result.requestOrigin, 'copilot-chat');
                assert.deepEqual(result.evidence, expected.evidence);
                assert.equal(result.agentRole, expected.agentRole);
                assert.deepEqual(classifier.getRequestBehavior(result), classifier.getRequestBehavior(expected));
                assert.equal(
                    classifier.getRecommendedReasoningEffort(kind, 'high', result),
                    classifier.getRecommendedReasoningEffort(kind, 'high', expected)
                );
            }
        }
    });
}

for (const [label, rules, kind] of [
    ['project specification', WORKSPACE_SPECIFICATION_RULE, 'workspace-gen'],
    ['test setup plan', WORKSPACE_MUTATION_PLAN_RULE, 'test-gen'],
    [
        'test setup new file',
        `${WORKSPACE_MUTATION_FILE_RULE}\nPrint the entire contents of the file you propose.`,
        'test-gen'
    ],
    ['test setup edit file', `${WORKSPACE_MUTATION_FILE_RULE}\nDo not include comments in json files.`, 'test-gen']
] as const) {
    test(`共用项目规格首句按固定规则区分 ${label}`, async () => {
        const classifier = await getClassifier();
        for (const requestInitiator of [undefined, 'github.copilot-chat', 'core']) {
            for (const text of [
                workspacePrompt(rules),
                workspacePrompt(rules.replace(/ /g, '  ')).replace(/\n/g, '\r\n')
            ]) {
                for (const message of [system(text.slice(0, 35), text.slice(35)), user(text, 'gcmp-system')]) {
                    const messages = [message, user('Synthetic request.')];
                    const snapshot = structuredClone(messages);
                    const result = classifier.classifyRequestContext(messages, { requestInitiator });
                    assert.equal(result.requestKind, kind);
                    assert.equal(result.requestOrigin, 'copilot-chat');
                    assert.equal(result.agentRole, 'not-applicable');
                    assert.equal(result.evidence.purpose.level, 'signature');
                    assert.equal(classifier.getRecommendedReasoningEffort(kind, 'high', result), 'none');
                    assert.equal(classifier.getRequestBehavior(result).canRegisterUserInput, false);
                    assert.deepEqual(structuredClone(messages), snapshot);
                }
            }
        }
    });
}

for (const [label, text] of [
    ['missing heading', `${WORKSPACE_SPECIFICATION}\n${WORKSPACE_MUTATION_PLAN_RULE}`],
    ['partial plan', workspacePrompt(WORKSPACE_MUTATION_PLAN_RULE.split(' Think step by step')[0])],
    ['later example', workspacePrompt(`${WORKSPACE_SPECIFICATION_RULE}\n## Example\n${WORKSPACE_MUTATION_PLAN_RULE}`)],
    ['quoted rule', workspacePrompt(`> ${WORKSPACE_MUTATION_PLAN_RULE}`)],
    ['fenced rule', workspacePrompt(`\`\`\`text\n${WORKSPACE_MUTATION_PLAN_RULE}\n\`\`\``)],
    [
        'fenced heading',
        `${WORKSPACE_SPECIFICATION}\n\`\`\`text\nAdditional Rules\n${WORKSPACE_MUTATION_PLAN_RULE}\n\`\`\``
    ],
    [
        'tilde fenced heading',
        `${WORKSPACE_SPECIFICATION}\n~~~text\nAdditional Rules\n${WORKSPACE_MUTATION_FILE_RULE}\n~~~`
    ],
    ['quoted heading', `${WORKSPACE_SPECIFICATION}\n> Additional Rules\n${WORKSPACE_MUTATION_FILE_RULE}`]
] as const) {
    test(`项目规格引用或不完整规则不提升为测试配置: ${label}`, async () => {
        const classifier = await getClassifier();
        const result = classifier.classifyRequestContext([system(text)], { requestInitiator: 'github.copilot-chat' });
        assert.equal(result.requestKind, 'workspace-gen');
    });
}

test('项目规格与测试规则不能跨消息拼接，两份完整用途冲突仍降级', async () => {
    const classifier = await getClassifier();
    for (const messages of [
        [system(WORKSPACE_SPECIFICATION), system(`Additional Rules\n${WORKSPACE_MUTATION_PLAN_RULE}`)],
        [system(WORKSPACE_SPECIFICATION), user(`Additional Rules\n${WORKSPACE_MUTATION_PLAN_RULE}`)]
    ]) {
        assert.equal(classifier.classifyRequestContext(messages).requestKind, 'workspace-gen');
    }
    const conflict = classifier.classifyRequestContext([
        system(workspacePrompt(WORKSPACE_SPECIFICATION_RULE)),
        system(workspacePrompt(WORKSPACE_MUTATION_PLAN_RULE))
    ]);
    assertUnclassified(conflict);
    assert.equal(conflict.evidence.purpose.reasonCode, 'classification-conflict');
});

test('新增工作区和问答签名不信任普通 User、Assistant 或其他扩展', async () => {
    const classifier = await getClassifier();
    const texts = [
        ...LEGACY_PREFIX_CASES.filter(([, kind]) => kind === 'workspace-gen' || kind === 'vscode-qa').map(
            ([text]) => text
        ),
        workspacePrompt(WORKSPACE_MUTATION_PLAN_RULE),
        workspacePrompt(WORKSPACE_MUTATION_FILE_RULE)
    ];
    for (const text of texts) {
        for (const message of [user(text), { ...user(text), role: 2 }]) {
            assertUnclassified(
                classifier.classifyRequestContext([message], { requestInitiator: 'github.copilot-chat' })
            );
            assert.equal(
                classifier.classifyRequestContext([system(MAIN_IDENTITY), message], {
                    requestInitiator: 'github.copilot-chat'
                }).requestKind,
                'main-agent'
            );
        }
        const foreign = classifier.classifyRequestContext([system(text)], { requestInitiator: 'another.extension' });
        assertUnclassified(foreign);
        assert.equal(foreign.requestOrigin, 'other-extension');
        const sdk = classifier.classifyRequestContext([system(SDK_MAIN), user(text)], { requestInitiator: 'core' });
        assert.equal(sdk.requestOrigin, 'copilot-sdk');
        assert.equal(sdk.requestKind, 'main-agent');
    }
});

test('普通大正文不遮挡后续可信 System 的冲突，也不为其他扩展授予旧用途', async () => {
    const classifier = await getClassifier();
    const title = system('You are an expert in crafting pithy titles');
    const summary = system('Your task is to create a comprehensive, detailed summary of the entire conversation');
    const body = user(`The goal of the patch is:\n${'x'.repeat(300_000)}`);
    for (const messages of [
        [body, title, summary],
        [title, body, summary]
    ]) {
        const result = classifier.classifyRequestContext(messages);
        assertUnclassified(result);
        assert.equal(result.evidence.purpose.reasonCode, 'classification-conflict');
    }
    const foreign = classifier.classifyRequestContext([title, body], { requestInitiator: 'another.extension' });
    assertUnclassified(foreign);
    assert.equal(foreign.requestOrigin, 'other-extension');
    assert.equal(classifier.getRequestBehavior(foreign).canObserveTitle, false);
});

test('SDK 普通大正文保留主用途，后续旧身份仍产生来源冲突', async () => {
    const classifier = await getClassifier();
    const body = user(`The goal of the patch is:\n${'x'.repeat(300_000)}`);
    for (const messages of [
        [system(SDK_MAIN), body],
        [body, system(SDK_MAIN)]
    ]) {
        const result = classifier.classifyRequestContext(messages, { requestInitiator: 'core' });
        assert.equal(result.requestOrigin, 'copilot-sdk');
        assert.equal(result.requestKind, 'main-agent');
        assert.equal(result.evidence.purpose.level, 'signature');
        assert.equal(classifier.getRequestBehavior(result).canUseLegacyRecovery, false);
    }
    const conflicting = classifier.classifyRequestContext([body, system(SDK_MAIN), system(MAIN_IDENTITY)]);
    assertUnclassified(conflicting);
    assert.equal(conflicting.evidence.origin.reasonCode, 'classification-conflict');
    assert.equal(conflicting.evidence.purpose.reasonCode, 'classification-conflict');
});

for (const prefix of [COMPACTION, SDK_COMPACTION, '[Terminal t notification:', ' ']) {
    test(`截断的用户控制模板保持保守降级: ${prefix.slice(0, 50)}`, async () => {
        const classifier = await getClassifier();
        for (const identity of [MAIN_IDENTITY, SDK_MAIN]) {
            const result = classifier.classifyRequestContext([
                system(identity),
                user(prefix === ' ' ? ' '.repeat(300_000) : `${prefix}\n${'x'.repeat(300_000)}`)
            ]);
            assertUnclassified(result);
            assert.equal(result.evidence.purpose.reasonCode, 'extraction-budget-exceeded');
        }
    });
}

test('多字节前导空白被截断时不把未读取的控制模板当普通正文', async () => {
    const classifier = await getClassifier();
    for (const text of ['\u3000'.repeat(100_000) + COMPACTION, '\u2003'.repeat(100_000) + SDK_COMPACTION]) {
        const result = classifier.classifyRequestContext([system(MAIN_IDENTITY), user(text)]);
        assertUnclassified(result);
        assert.equal(result.evidence.purpose.reasonCode, 'extraction-budget-exceeded');
    }
});

test('System 恰好用满文本预算时，空消息和普通 User 不构成超限', async () => {
    const classifier = await getClassifier();
    const prefix = 'You are an expert at analyzing files and patterns';
    const instruction = system(prefix + 'x'.repeat(256 * 1024 - prefix.length));
    for (const body of ['', 'The goal of the patch is to fix context.']) {
        assert.equal(classifier.classifyRequest([instruction, user(body)]), 'patch-healer');
    }
    const exceeded = classifier.classifyRequestContext([instruction, user(''), system('x')]);
    assertUnclassified(exceeded);
    assert.equal(exceeded.evidence.purpose.reasonCode, 'extraction-budget-exceeded');
});

for (const [mode, tool, kind] of [
    ['Explore', 'fetch_webpage', 'search-subagent'],
    ['Execution', 'run_in_terminal', 'execution-subagent']
] as const) {
    test(`旧 ${mode} overlay 保持子代理用途，普通 User 不采用`, async () => {
        const classifier = await getClassifier();
        const text = `${MAIN_IDENTITY}\n<modeInstructions>You are currently running in "${mode}" mode.</modeInstructions>`;
        const result = classifier.classifyRequestContext([system(text)], { tools: tools(tool) });
        assert.equal(result.requestKind, kind);
        assert.equal(result.agentRole, 'subagent');
        assertUnclassified(classifier.classifyRequestContext([user(text)], { tools: tools(tool) }));
    });
}

test('旧完整压缩与终端通知仅采用可信旧来源，SDK 和未知来源不采用', async () => {
    const classifier = await getClassifier();
    for (const [text, kind] of [
        [COMPACTION, 'summarization'],
        ['[Terminal t notification: done]', 'terminal-steering']
    ] as const) {
        assert.equal(classifier.classifyRequestContext([system(MAIN_IDENTITY), user(text)]).requestKind, kind);
        assertUnclassified(classifier.classifyRequestContext([system(SDK_IDENTITY), user(text)]));
        assertUnclassified(classifier.classifyRequestContext([user(text)]));
    }
    assert.equal(classifier.classifyRequest([system(MAIN_IDENTITY), user(COMPACTION.slice(0, 160))]), 'main-agent');
});

for (const [name, kind] of [
    ['manage_todo_list', 'todo-tracker'],
    ['categorize_prompt', 'prompt-categorizer']
] as const) {
    test(`旧 initiator 限定的单工具 ${name} 保持兼容，工具名不能单独证明用途`, async () => {
        const classifier = await getClassifier();
        assert.equal(
            classifier.classifyRequestContext([], { requestInitiator: 'github.copilot-chat', tools: tools(name) })
                .requestKind,
            kind
        );
        const result = classifier.classifyRequestContext([], {
            requestInitiator: 'github.copilot-chat',
            tools: tools(name)
        });
        assert.equal(result.evidence.purpose.level, 'heuristic');
        assert.equal(result.agentRole, 'undetermined');
        assert.equal(classifier.shouldDisableThinkingForRequest(kind, result), false);
        assert.equal(classifier.getRequestBehavior(result).canUseLegacyRecovery, false);
        assertUnclassified(classifier.classifyRequestContext([], { tools: tools(name) }));
    });
}

test('skills/agents 兜底只保留在旧来源内且为弱依据', async () => {
    const classifier = await getClassifier();
    for (const text of ['<skills>main</skills>', '<agents>main</agents>']) {
        const result = classifier.classifyRequestContext([system(text)], { requestInitiator: 'github.copilot-chat' });
        assert.equal(result.requestKind, 'main-agent');
        assert.equal(result.evidence.purpose.level, 'heuristic');
        assertUnclassified(classifier.classifyRequestContext([system(text)]));
        assert.equal(classifier.getRequestBehavior(result).canRegisterUserInput, false);
    }
});

test('多 System 保留边界，不能跨消息拼出 SDK 身份或用途模板', async () => {
    const classifier = await getClassifier();
    const result = classifier.classifyRequestContext([
        system('You are an AI assistant '),
        system('using Copilot SDK in VS Code.')
    ]);
    assertUnclassified(result);
    assert.equal(result.requestOrigin, 'unknown');
});

test('多个同等级旧用途冲突时保留来源并降级，而不是首个匹配赢', async () => {
    const classifier = await getClassifier();
    const title = system('You are an expert in crafting pithy titles');
    const summary = system('Your task is to create a comprehensive, detailed summary of the entire conversation');
    for (const messages of [
        [title, summary],
        [summary, title]
    ]) {
        const result = classifier.classifyRequestContext(messages);
        assertUnclassified(result);
        assert.equal(result.requestOrigin, 'copilot-chat');
        assert.equal(result.evidence.purpose.reasonCode, 'classification-conflict');
        assert.equal(classifier.getRequestBehavior(result).canObserveSummary, false);
        assert.equal(classifier.getRequestBehavior(result).canObserveTitle, false);
    }
    assert.equal(classifier.classifyRequest([title, title]), 'chat-title');
});

for (const kind of ['git-commit-message', 'vision-recognition'] as const) {
    test(`GCMP 显式自发契约 ${kind} 是高等级依据`, async () => {
        const classifier = await getClassifier();
        const result = classifier.classifyRequestContext([system(SDK_IDENTITY)], {
            requestInitiator: 'vicanent.gcmp',
            modelOptions: { requestKind: kind }
        });
        assert.equal(result.requestKind, kind);
        assert.equal(result.requestOrigin, 'gcmp');
        assert.equal(result.agentRole, 'not-applicable');
        assert.equal(result.evidence.purpose.level, 'contract');
    });
}

test('不信任旧注入值、其他 initiator 或 GCMP 非自发类型；options 可复用', async () => {
    const classifier = await getClassifier();
    for (const requestInitiator of ['core', 'github.copilot-chat', 'vicanent.gcmp', undefined]) {
        for (const requestKind of ['main-agent', 'subagent', 'chat-title', 'summarization', 'background', {}, 1]) {
            assertUnclassified(
                classifier.classifyRequestContext([system(SDK_IDENTITY)], {
                    requestInitiator,
                    modelOptions: { requestKind }
                })
            );
        }
    }
    for (const requestInitiator of ['core', 'other.extension', undefined]) {
        for (const requestKind of ['git-commit-message', 'vision-recognition']) {
            assertUnclassified(
                classifier.classifyRequestContext([user('hello')], { requestInitiator, modelOptions: { requestKind } })
            );
        }
    }
    const options = { requestInitiator: 'core', modelOptions: { requestKind: 'chat-title' } };
    assert.equal(classifier.classifyRequestContext([system(MAIN_IDENTITY)], options).requestKind, 'main-agent');
    assertUnclassified(classifier.classifyRequestContext([system(SDK_IDENTITY)], options));
    assert.equal(options.modelOptions.requestKind, 'chat-title');
    assert.notEqual(
        classifier.classifyRequestContext([user('hello')], { requestInitiator: 'vicanent.gcmp' }).requestOrigin,
        'gcmp'
    );
});

test('空文本、空 data 与无消息为 unknown；有效结果/data/call 为 unclassified', async () => {
    const classifier = await getClassifier();
    const withPart = (part: unknown) => [{ role: 1, content: [part] }] as unknown as vscode.LanguageModelChatMessage[];
    for (const messages of [[], [user(' \n ')], withPart({ data: new Uint8Array(), mimeType: 'image/png' })]) {
        assert.equal(classifier.classifyRequestContext(messages).requestKind, 'unknown');
    }
    for (const part of [
        { data: new Uint8Array([1]), mimeType: 'image/png' },
        { callId: 'tool-1', content: [new MockTextPart('result')] },
        { callId: 'tool-1', name: 'read_file', input: {} }
    ]) {
        assertUnclassified(classifier.classifyRequestContext(withPart(part)));
    }
});

test('256KiB 内的大样本仍可完整分类；超限保留已识别来源且用途降级', async () => {
    const classifier = await getClassifier();
    const withinBudget = system(`${MAIN_IDENTITY}\n${'x'.repeat(100_000)}`);
    assert.equal(classifier.classifyRequest([withinBudget]), 'main-agent');
    for (const identity of [MAIN_IDENTITY, SDK_IDENTITY]) {
        const messages = [system(`${identity}\n${'x'.repeat(300_000)}`)];
        const snapshot = structuredClone(messages);
        const result = classifier.classifyRequestContext(messages);
        assertUnclassified(result);
        assert.equal(result.requestOrigin, identity === SDK_IDENTITY ? 'copilot-sdk' : 'copilot-chat');
        assert.equal(result.evidence.purpose.reasonCode, 'extraction-budget-exceeded');
        assert.deepEqual(structuredClone(messages), snapshot);
    }
});

test('消息、parts、工具数量均有界，超限不产生完整用途依据', async () => {
    const classifier = await getClassifier();
    for (const [messages, availableTools] of [
        [[system(MAIN_IDENTITY), ...Array.from({ length: 5000 }, () => user(''))], undefined],
        [[system(MAIN_IDENTITY, ...Array.from({ length: 20_000 }, () => ''))], undefined],
        [[system(MAIN_IDENTITY)], tools(...Array.from({ length: 2000 }, () => 'read_file'))]
    ] as const) {
        const result = classifier.classifyRequestContext(messages, { tools: availableTools });
        assertUnclassified(result);
        assert.equal(result.evidence.purpose.reasonCode, 'extraction-budget-exceeded');
    }
});

test('历史 Assistant 和旧 User 正文不参与分类文本扫描预算', async () => {
    const classifier = await getClassifier();
    const messages = [
        system(MAIN_IDENTITY),
        user('x'.repeat(400_000)),
        { ...user('x'.repeat(400_000)), role: 2 },
        user('continue')
    ];
    const result = classifier.classifyRequestContext(messages);
    assert.equal(result.requestKind, 'main-agent');
    assert.equal(result.evidence.purpose.level, 'signature');
});

test('集中策略只允许有足够依据的旧用途产生登记副作用', async () => {
    const classifier = await getClassifier();
    const main = classifier.classifyRequestContext([system(MAIN_IDENTITY)]);
    assert.deepEqual(classifier.getRequestBehavior(main), {
        canRegisterUserInput: true,
        canObserveSummary: false,
        canObserveTitle: false,
        canUseLegacyRecovery: true
    });
    const summary = classifier.classifyRequestContext([system(MAIN_IDENTITY), user(COMPACTION)]);
    assert.equal(classifier.getRequestBehavior(summary).canObserveSummary, true);
    const title = classifier.classifyRequestContext([system('You are an expert in crafting pithy titles')]);
    assert.equal(classifier.getRequestBehavior(title).canObserveTitle, true);
    const sdk = classifier.classifyRequestContext([system(SDK_IDENTITY)]);
    assert.deepEqual(classifier.getRequestBehavior(sdk), {
        canRegisterUserInput: false,
        canObserveSummary: false,
        canObserveTitle: false,
        canUseLegacyRecovery: false
    });
    assert.equal(
        classifier.getRequestBehavior({
            ...summary,
            evidence: { ...summary.evidence, purpose: { level: 'heuristic' } }
        }).canObserveSummary,
        false
    );
});

test('新用途显示只提供目标类型；历史 background 仍显示未分类请求', async () => {
    const classifier = await getClassifier();
    assert.equal(classifier.getRequestKindDisplayName('subagent'), '子代理');
    assert.equal(classifier.getRequestKindDisplayName('unclassified'), '未分类请求');
    assert.equal(classifier.getRequestKindDisplayName('background'), '未分类请求');
    assert.deepEqual(REQUEST_KIND_DISPLAY_NAMES.subagent, ['Subagent', '子代理']);
    assert.deepEqual(REQUEST_KIND_DISPLAY_NAMES.unclassified, ['Unclassified Request', '未分类请求']);
    assert.deepEqual(REQUEST_KIND_DISPLAY_NAMES.background, REQUEST_KIND_DISPLAY_NAMES.unclassified);
});

test('已知其他扩展不能借旧 System 模板进入旧来源用途规则', async () => {
    const classifier = await getClassifier();
    for (const text of [MAIN_IDENTITY, 'You are an expert in crafting pithy titles']) {
        const result = classifier.classifyRequestContext([system(text), user(COMPACTION)], {
            requestInitiator: 'some.extension',
            tools: tools('manage_todo_list')
        });
        assertUnclassified(result);
        assert.equal(result.requestOrigin, 'other-extension');
    }
});

test('用途签名优先于旧来源的弱单工具线索', async () => {
    const classifier = await getClassifier();
    for (const [text, kind] of [
        [MAIN_IDENTITY, 'main-agent'],
        ['You are an expert in crafting pithy titles', 'chat-title']
    ] as const) {
        const result = classifier.classifyRequestContext([system(text)], { tools: tools('manage_todo_list') });
        assert.equal(result.requestKind, kind);
        assert.equal(result.evidence.purpose.level, 'signature');
    }
});

test('相互冲突的可信来源不从任一来源借用用途', async () => {
    const classifier = await getClassifier();
    for (const messages of [
        [system(MAIN_IDENTITY), system(SDK_IDENTITY)],
        [system(SDK_IDENTITY), system(MAIN_IDENTITY)]
    ]) {
        const result = classifier.classifyRequestContext(messages, {
            requestInitiator: 'github.copilot-chat',
            tools: tools('manage_todo_list')
        });
        assertUnclassified(result);
        assert.equal(result.requestOrigin, 'unknown');
        assert.equal(result.evidence.origin.reasonCode, 'classification-conflict');
        assert.equal(result.evidence.purpose.reasonCode, 'classification-conflict');
        assert.equal(classifier.getRequestBehavior(result).canUseLegacyRecovery, false);
    }
});

test('普通 User 中的旧辅助前缀不改变当前主身份', async () => {
    const classifier = await getClassifier();
    for (const text of ['You are an expert in crafting pithy titles', SDK_IDENTITY, '<agents>Explore</agents>']) {
        const result = classifier.classifyRequestContext([system(MAIN_IDENTITY), user(text)]);
        assert.equal(result.requestKind, 'main-agent');
        assert.equal(result.requestOrigin, 'copilot-chat');
        assert.equal(result.agentRole, 'main');
    }
});

test('旧 overlay 不能跨 System 边界拼接角色结构', async () => {
    const classifier = await getClassifier();
    const result = classifier.classifyRequestContext(
        [
            system(`${MAIN_IDENTITY}\n<modeInstructions>`),
            system('You are currently running in "Explore" mode.</modeInstructions>')
        ],
        { tools: tools('fetch_webpage') }
    );
    assert.equal(result.requestKind, 'main-agent');
    assert.equal(result.agentRole, 'main');
});

test('UTF-8 多字节文本按字节预算降级且不丢已识别来源', async () => {
    const classifier = await getClassifier();
    assert.equal(classifier.classifyRequest([system(`${MAIN_IDENTITY}\n${'界'.repeat(80_000)}`)]), 'main-agent');
    const result = classifier.classifyRequestContext([system(`${MAIN_IDENTITY}\n${'界'.repeat(100_000)}`)]);
    assertUnclassified(result);
    assert.equal(result.requestOrigin, 'copilot-chat');
    assert.equal(result.evidence.purpose.reasonCode, 'extraction-budget-exceeded');
});

test('part 提取异常保留已知来源但不产生用途或登记副作用', async () => {
    const classifier = await getClassifier();
    const brokenPart = Object.defineProperty({}, 'value', {
        get() {
            throw new Error('unreadable part');
        }
    });
    for (const identity of [MAIN_IDENTITY, SDK_IDENTITY]) {
        const messages = [
            { role: 0, content: [new MockTextPart(identity), brokenPart] }
        ] as unknown as vscode.LanguageModelChatMessage[];
        const result = classifier.classifyRequestContext(messages);
        assertUnclassified(result);
        assert.equal(result.requestOrigin, identity === SDK_IDENTITY ? 'copilot-sdk' : 'copilot-chat');
        assert.equal(result.evidence.purpose.reasonCode, 'extraction-failed');
        assert.equal(classifier.getRequestBehavior(result).canRegisterUserInput, false);
        assert.equal(classifier.getRequestBehavior(result).canUseLegacyRecovery, false);
        assert.equal(classifier.classifyRequest(messages), 'unclassified');
    }
});

test('分类选项读取异常不阻断请求', async () => {
    const classifier = await getClassifier();
    const result = classifier.classifyRequestContext([system(MAIN_IDENTITY)], {
        requestInitiator: 'core',
        get tools(): vscode.LanguageModelChatTool[] {
            throw new Error('unreadable tools');
        }
    });
    assertUnclassified(result);
    assert.equal(result.requestOrigin, 'core');
    assert.equal(result.evidence.purpose.reasonCode, 'classification-failed');
});

test('modelOptions 内注入分类及返回结果的修改均不成为下次请求依据', async () => {
    const classifier = await getClassifier();
    const main = classifier.classifyRequestContext([system(MAIN_IDENTITY)]);
    const options = {
        requestInitiator: 'core',
        modelOptions: { requestKind: 'chat-title', requestClassification: main }
    };
    const snapshot = structuredClone(options);
    const first = classifier.classifyRequestContext([system(SDK_IDENTITY)], options);
    first.requestKind = 'chat-title';
    first.evidence.purpose.level = 'contract';
    assertUnclassified(classifier.classifyRequestContext([system(SDK_IDENTITY)], options));
    assert.deepEqual(options, snapshot);
});
