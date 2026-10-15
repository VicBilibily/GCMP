import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import test from 'node:test';
import type * as vscode from 'vscode';
import { resolveSubSessionId } from '../../usages/subSessionResolver';
import { encodeStatefulMarkerPayload } from '../stateful/statefulMarkerCodec';
import { canRestoreMarkerSession } from '../stateful/statefulMarkerRecovery';
import { usesLegacyTurnAffinity } from './requestClassification';
import { isSharedHandoffSummary } from './sdkRequestClassifier';
import {
    SDK_CLAUDE_MAIN,
    SDK_CODE_REVIEW_SUBAGENT,
    SDK_COMPACTION,
    SDK_CUSTOM_SUBAGENT,
    SDK_EXPLORE_SUBAGENT,
    SDK_GENERAL_SUBAGENT,
    SDK_GENERIC_MAIN,
    SDK_GENERIC_MAIN_WITH_SKILLS,
    SDK_GEMINI_MAIN,
    SDK_HOST_IDENTITY,
    SDK_MAIN,
    SDK_RESEARCH_SUBAGENT,
    SDK_SECURITY_REVIEW_SUBAGENT,
    SDK_SELECTED_CUSTOM_MAIN,
    SDK_SESSION_CONTEXT,
    SDK_SKILL_CATALOG,
    SDK_TASK_SUBAGENT,
    SHARED_HANDOFF_SUMMARY
} from './testFixtures/sdkPurposeSamples';

const require = createRequire(import.meta.url);
const NodeModule = require('node:module') as { prototype: { require: (id: string) => unknown } };
let classifierPromise: Promise<typeof import('./requestClassifier')> | undefined;

function getClassifier(): Promise<typeof import('./requestClassifier')> {
    if (!classifierPromise) {
        const original = NodeModule.prototype.require;
        NodeModule.prototype.require = function (id: string): unknown {
            if (id === 'vscode') {
                return {
                    env: { language: 'zh-cn' },
                    LanguageModelChatMessageRole: { System: 0, User: 1, Assistant: 2 }
                };
            }
            return original.call(this, id);
        };
        classifierPromise = import('./requestClassifier').finally(() => {
            NodeModule.prototype.require = original;
        });
    }
    return classifierPromise;
}

function system(...texts: string[]): vscode.LanguageModelChatMessage {
    return { role: 0, content: texts.map(value => ({ value })) } as unknown as vscode.LanguageModelChatMessage;
}

function user(value: string): vscode.LanguageModelChatMessage {
    return { role: 1, content: [{ value }] } as unknown as vscode.LanguageModelChatMessage;
}

const childCases = [
    ['custom', SDK_CUSTOM_SUBAGENT, 'subagent'],
    ['explore', SDK_EXPLORE_SUBAGENT, 'search-subagent'],
    ['task', SDK_TASK_SUBAGENT, 'execution-subagent'],
    ['code-review', SDK_CODE_REVIEW_SUBAGENT, 'subagent'],
    ['security-review', SDK_SECURITY_REVIEW_SUBAGENT, 'subagent'],
    ['research', SDK_RESEARCH_SUBAGENT, 'search-subagent'],
    ['general-purpose', SDK_GENERAL_SUBAGENT, 'subagent']
] as const;

for (const [name, prompt] of [
    ['default', SDK_MAIN],
    ['claude', SDK_CLAUDE_MAIN],
    ['gemini', SDK_GEMINI_MAIN],
    ['generic', SDK_GENERIC_MAIN],
    ['generic with skills', SDK_GENERIC_MAIN_WITH_SKILLS],
    ['selected custom', SDK_SELECTED_CUSTOM_MAIN]
] as const) {
    test(`SDK ${name} 完整主流程组合证明主用途，不推广旧行为策略`, async () => {
        const classifier = await getClassifier();
        for (const requestInitiator of ['core', 'github.copilot-chat', undefined]) {
            for (const tools of [[], [{ name: 'task', description: '', inputSchema: {} }]]) {
                const result = classifier.classifyRequestContext([system(prompt), user('Synthetic assignment.')], {
                    requestInitiator,
                    tools
                });
                assert.equal(result.requestOrigin, 'copilot-sdk');
                assert.equal(result.requestKind, 'main-agent');
                assert.equal(result.agentRole, 'main');
                assert.equal(result.evidence.purpose.level, 'signature');
                assert.equal(result.evidence.purpose.ruleId, 'sdk.ad270aa.main-agent');
                assert.equal(result.evidence.role.level, 'signature');
                assert.equal(classifier.shouldDisableThinkingForRequest(result.requestKind, result), false);
                assert.equal(usesLegacyTurnAffinity(result), false);
                assert.deepEqual(classifier.getRequestBehavior(result), {
                    canRegisterUserInput: false,
                    canObserveSummary: false,
                    canObserveTitle: false,
                    canUseLegacyRecovery: false
                });
            }
        }
    });
}

for (const [name, prompt, kind] of childCases) {
    test(`SDK ${name} 的实际子代理框架证明来源和角色，不依赖身份首句或工具`, async () => {
        const classifier = await getClassifier();
        assert.equal(prompt.includes(SDK_HOST_IDENTITY), false);
        for (const requestInitiator of ['core', undefined]) {
            const result = classifier.classifyRequestContext([system(prompt), user('Synthetic assignment.')], {
                requestInitiator
            });
            assert.equal(result.requestOrigin, 'copilot-sdk');
            assert.equal(result.requestKind, kind);
            assert.equal(result.agentRole, 'subagent');
            assert.equal(result.evidence.origin.level, 'signature');
            assert.equal(result.evidence.origin.ruleId, 'origin.sdk.ad270aa.subagent-frame');
            assert.equal(result.evidence.purpose.level, 'signature');
            assert.equal(result.evidence.purpose.ruleId, `sdk.ad270aa.${kind}`);
            assert.equal(classifier.shouldDisableThinkingForRequest(kind, result), false);
            assert.equal(usesLegacyTurnAffinity(result), false);
        }
    });
}

for (const block of ['code_change_instructions', 'system_notifications', 'solution_persistence', 'task_completion']) {
    test(`SDK 主框架缺少完整 ${block} 不提升用途`, async () => {
        const classifier = await getClassifier();
        for (const prompt of [
            SDK_MAIN.replace(new RegExp(`<${block}>[\\s\\S]*?</${block}>`), ''),
            SDK_MAIN.replace(`</${block}>`, '')
        ]) {
            const result = classifier.classifyRequestContext([system(prompt)], { requestInitiator: 'core' });
            assert.equal(result.requestOrigin, 'copilot-sdk');
            assert.equal(result.requestKind, 'unclassified');
            assert.equal(result.agentRole, 'undetermined');
        }
    });
}

for (const block of ['prohibited_actions', 'tool_calling', 'environment_context']) {
    test(`SDK 自定义子框架缺少完整 ${block} 不把任意 core 判为子代理`, async () => {
        const classifier = await getClassifier();
        for (const prompt of [
            SDK_CUSTOM_SUBAGENT.replace(new RegExp(`<${block}>[\\s\\S]*?</${block}>`), ''),
            SDK_CUSTOM_SUBAGENT.replace(`</${block}>`, '')
        ]) {
            const result = classifier.classifyRequestContext([system(prompt)], { requestInitiator: 'core' });
            assert.equal(result.requestOrigin, 'core');
            assert.equal(result.requestKind, 'unclassified');
            assert.equal(result.agentRole, 'undetermined');
        }
    });
}

test('SDK 子框架只有角色首句、caller 页脚或旧 agents/skills 标签时保持未确定', async () => {
    const classifier = await getClassifier();
    for (const prompt of [
        "As a sub-agent, complete your parent's task yourself;",
        'You are an exploration agent. Answer the question as fast as possible, then stop.',
        'You are a command execution agent that runs development commands and reports results efficiently.',
        '**CRITICAL: Ensure a response is returned to your caller.**',
        SDK_CUSTOM_SUBAGENT.replace('**CRITICAL: Ensure a response is returned to your caller.**', 'Synthetic footer.'),
        `${SDK_HOST_IDENTITY}\n<agent_instructions>Synthetic assignment.</agent_instructions>`,
        `${SDK_HOST_IDENTITY}\n<skills>main</skills>\n<agents>Explore</agents>`
    ]) {
        const result = classifier.classifyRequestContext([system(prompt)], { requestInitiator: 'core' });
        assert.equal(result.requestKind, 'unclassified');
        assert.equal(result.agentRole, 'undetermined');
    }
});

test('SDK 运行框架不能从 User、Assistant、引用块、代码围栏或工具说明借用', async () => {
    const classifier = await getClassifier();
    for (const prompt of [SDK_MAIN, SDK_CUSTOM_SUBAGENT, SDK_GENERAL_SUBAGENT]) {
        const quoted = prompt
            .split('\n')
            .map(line => `> ${line}`)
            .join('\n');
        for (const messages of [
            [user(prompt)],
            [{ ...user(prompt), role: 2 }],
            [system(`\`\`\`text\n${prompt}\n\`\`\``)],
            [system(quoted)],
            [system(`<example>\n${prompt}\n</example>`)],
            [system(SDK_HOST_IDENTITY), user(prompt)]
        ]) {
            const result = classifier.classifyRequestContext(messages, {
                requestInitiator: 'core',
                tools: [{ name: 'task', description: prompt, inputSchema: {} }]
            });
            assert.equal(result.requestKind, 'unclassified');
            assert.equal(result.agentRole, 'undetermined');
        }
        assert.equal(classifier.classifyRequestContext([system(SDK_MAIN), user(prompt)]).requestKind, 'main-agent');
    }
});

for (const tag of ['reference_prompt', 'reference-prompt']) {
    test(`SDK 引用包装 ${tag} 不提供运行用途或会话标识`, async () => {
        const classifier = await getClassifier();
        for (const prompt of [SDK_MAIN, SDK_CUSTOM_SUBAGENT, SDK_GENERAL_SUBAGENT]) {
            const input = [
                system(`<${tag}>\n${prompt}\n${SDK_SESSION_CONTEXT}\n</${tag}>`),
                user('Explain the quote.')
            ];
            const classified = classifier.classifyRequestContext(input, { requestInitiator: 'core' });
            assert.equal(classified.requestKind, 'unclassified');
            assert.equal(classified.agentRole, 'undetermined');
            assert.equal(classifier.getSdkSessionContextKey(input, classified), undefined);
        }
    });

    test(`SDK 根框架不受 ${tag} 中的子框架与会话引用影响`, async () => {
        const classifier = await getClassifier();
        const root = `${SDK_MAIN}\n${SDK_SESSION_CONTEXT}`;
        const original = [system(root)];
        const key = classifier.getSdkSessionContextKey(original, classifier.classifyRequestContext(original));
        assert.ok(key);
        const quotedContext = SDK_SESSION_CONTEXT.replace(
            '11111111-1111-4111-8111-111111111111',
            '22222222-2222-4222-8222-222222222222'
        );
        const input = [system(`${root}\n<${tag}>\n${SDK_CUSTOM_SUBAGENT}\n${quotedContext}\n</${tag}>`)];
        const classified = classifier.classifyRequestContext(input);
        assert.equal(classified.requestKind, 'main-agent');
        assert.equal(classified.agentRole, 'main');
        assert.equal(classifier.getSdkSessionContextKey(input, classified), key);
        const contextOnly = [system(`${SDK_MAIN}\n<${tag}>\n${SDK_SESSION_CONTEXT}\n</${tag}>`)];
        assert.equal(
            classifier.getSdkSessionContextKey(contextOnly, classifier.classifyRequestContext(contextOnly)),
            undefined
        );
    });
}

test('SDK 不完整或错配的连字符引用标签不能使内部框架泄漏到根层', async () => {
    const classifier = await getClassifier();
    for (const [open, close] of [
        ['<reference-prompt>', '</reference_prompt>'],
        ['<reference-prompt>', ''],
        ['<reference-prompt>', '<reference-note></reference-note></reference-prompt>']
    ]) {
        const input = [system(`${open}\n${SDK_MAIN}\n${SDK_SESSION_CONTEXT}\n${close}`)];
        const classified = classifier.classifyRequestContext(input);
        assert.equal(classified.requestKind, 'unclassified');
        assert.equal(classifier.getSdkSessionContextKey(input, classified), undefined);
    }
});

test('SDK 连字符标签支持缩进、CRLF 与行内子字段，但隐藏闭合标签仍拒绝', async () => {
    const classifier = await getClassifier();
    const quoted = `<reference-prompt>\n  <source-name>synthetic</source-name>\n${SDK_CUSTOM_SUBAGENT}\n</reference-prompt>`;
    for (const suffix of [quoted, quoted.replace(/\n/g, '\r\n')]) {
        assert.equal(classifier.classifyRequestContext([system(`${SDK_MAIN}\n${suffix}`)]).requestKind, 'main-agent');
    }
    const broken = quoted.replace('</reference-prompt>', 'text</reference-note> text</reference-prompt>');
    assert.equal(classifier.classifyRequestContext([system(`${SDK_MAIN}\n${broken}`)]).requestKind, 'unclassified');
});

test('SDK 顶层自定义代理的配置中引用子代理框架不改变主角色', async () => {
    const classifier = await getClassifier();
    const prompt = `${SDK_MAIN}\n<agent_instructions>\n${SDK_CUSTOM_SUBAGENT}\n</agent_instructions>`;
    const result = classifier.classifyRequestContext([system(prompt)]);
    assert.equal(result.requestKind, 'main-agent');
    assert.equal(result.agentRole, 'main');
});

test('SDK 子代理自定义首句恰好匹配旧泛化身份时不误用旧主身份', async () => {
    const classifier = await getClassifier();
    const prompt = SDK_CUSTOM_SUBAGENT.replace(
        'Synthetic research assignment.',
        'You are an expert AI programming assistant.'
    );
    const result = classifier.classifyRequestContext([system(prompt)], { requestInitiator: 'core' });
    assert.equal(result.requestOrigin, 'copilot-sdk');
    assert.equal(result.requestKind, 'subagent');
    assert.equal(result.agentRole, 'subagent');
});

test('已知其他扩展不能凭无 SDK 身份的子框架进入 SDK 来源规则', async () => {
    const classifier = await getClassifier();
    for (const [, prompt] of childCases) {
        const result = classifier.classifyRequestContext([system(prompt)], { requestInitiator: 'some.extension' });
        assert.equal(result.requestOrigin, 'other-extension');
        assert.equal(result.requestKind, 'unclassified');
        assert.equal(result.agentRole, 'undetermined');
    }
});

test('同级 SDK 主子框架冲突降级，不按先后顺序选主代理', async () => {
    const classifier = await getClassifier();
    for (const messages of [
        [system(SDK_MAIN), system(SDK_CUSTOM_SUBAGENT)],
        [system(SDK_CUSTOM_SUBAGENT), system(SDK_MAIN)],
        [system(`${SDK_MAIN}\n${SDK_CUSTOM_SUBAGENT}`)]
    ]) {
        const result = classifier.classifyRequestContext(messages, { requestInitiator: 'core' });
        assert.equal(result.requestOrigin, 'copilot-sdk');
        assert.equal(result.requestKind, 'unclassified');
        assert.equal(result.agentRole, 'undetermined');
        assert.equal(result.evidence.purpose.reasonCode, 'classification-conflict');
    }
    assert.equal(classifier.classifyRequestContext([system(SDK_MAIN), system(SDK_MAIN)]).requestKind, 'main-agent');
});

test('可信 SDK 子框架与独立旧 System 来源冲突，不借用其中任何用途', async () => {
    const classifier = await getClassifier();
    const result = classifier.classifyRequestContext([
        system(SDK_CUSTOM_SUBAGENT),
        system('You are an expert AI programming assistant.')
    ]);
    assert.equal(result.requestOrigin, 'unknown');
    assert.equal(result.requestKind, 'unclassified');
    assert.equal(result.evidence.origin.reasonCode, 'classification-conflict');
});

test('同条 System 分片和前置 marker 保留用途，跨 System 拼接则不构成完整组合', async () => {
    const classifier = await getClassifier();
    const split = SDK_MAIN.indexOf('<solution_persistence>');
    const messages = [
        { ...user('Synthetic marker.'), role: 2 },
        system(SDK_MAIN.slice(0, split), SDK_MAIN.slice(split))
    ];
    const snapshot = structuredClone(messages);
    assert.equal(classifier.classifyRequestContext(messages).requestKind, 'main-agent');
    assert.deepEqual(structuredClone(messages), snapshot);
    const separate = classifier.classifyRequestContext([
        system(SDK_MAIN.slice(0, split)),
        system(SDK_MAIN.slice(split))
    ]);
    assert.equal(separate.requestKind, 'unclassified');
    assert.equal(separate.agentRole, 'undetermined');
    assert.equal(
        classifier.classifyRequestContext([system(SDK_MAIN.replace(/\n/g, '\r\n'))]).requestKind,
        'main-agent'
    );
    const translated = { ...user(SDK_MAIN), name: 'gcmp-system' };
    assert.equal(classifier.classifyRequestContext([translated]).requestKind, 'main-agent');
});

test('SDK 压缩模板记录为弱证据摘要，不因用户原样粘贴获得辅助行为权限', async () => {
    const classifier = await getClassifier();
    for (const template of [
        SDK_COMPACTION,
        `${SDK_COMPACTION}\n### Checkpoint Title\nSynthetic checkpoint guidance.`
    ]) {
        const messages = [
            system(SDK_MAIN),
            user('Synthetic earlier assignment.'),
            { ...user('Synthetic response.'), role: 2 },
            user(template)
        ];
        for (const history of [messages, [system(SDK_MAIN), user(template)]]) {
            const result = classifier.classifyRequestContext(history, { requestInitiator: 'core' });
            assert.equal(result.requestOrigin, 'copilot-sdk');
            assert.equal(result.requestKind, 'summarization');
            assert.equal(result.agentRole, 'undetermined');
            assert.equal(result.evidence.purpose.level, 'heuristic');
            assert.equal(result.evidence.purpose.reasonCode, 'sdk-compaction-unconfirmed');
            assert.equal(classifier.shouldDisableThinkingForRequest('summarization', result), false);
            assert.equal(classifier.isSubRequest('summarization', result), false);
            assert.equal(classifier.getRequestBehavior(result).canObserveSummary, false);
        }
    }
    for (const text of [
        'Please create a detailed summary of the conversation so far.',
        `Review this quoted template:\n${SDK_COMPACTION}`
    ]) {
        assert.equal(classifier.classifyRequestContext([system(SDK_MAIN), user(text)]).requestKind, 'main-agent');
    }
    assert.equal(
        classifier.classifyRequestContext([system(SDK_MAIN), user(SDK_COMPACTION), user('Synthetic next task.')])
            .requestKind,
        'main-agent'
    );
});

test('rename_chat 工具的存在不把 SDK 主调用改成标题请求', async () => {
    const classifier = await getClassifier();
    const result = classifier.classifyRequestContext([system(SDK_MAIN)], {
        tools: [{ name: 'rename_chat', description: '', inputSchema: {} }]
    });
    assert.equal(result.requestKind, 'main-agent');
    assert.equal(classifier.getRequestBehavior(result).canObserveTitle, false);
});

test('SDK 超限、重复 options 和坏 part 不产生完整用途或跨次缓存', async () => {
    const classifier = await getClassifier();
    const options = { requestInitiator: 'core', modelOptions: { requestKind: 'chat-title', subSessionId: 'stale' } };
    const snapshot = structuredClone(options);
    assert.equal(classifier.classifyRequestContext([system(SDK_MAIN)], options).requestKind, 'main-agent');
    assert.equal(classifier.classifyRequestContext([system(SDK_CUSTOM_SUBAGENT)], options).requestKind, 'subagent');
    assert.equal(classifier.classifyRequestContext([system(SDK_HOST_IDENTITY)], options).requestKind, 'unclassified');
    assert.deepEqual(options, snapshot);
    const invalid = Object.defineProperty({}, 'value', {
        get() {
            throw new Error('Synthetic unreadable part.');
        }
    });
    for (const messages of [
        [system(`${SDK_MAIN}\n${'x'.repeat(300_000)}`)],
        [{ role: 0, content: [{ value: SDK_MAIN }, invalid] } as unknown as vscode.LanguageModelChatMessage]
    ]) {
        const result = classifier.classifyRequestContext(messages, options);
        assert.equal(result.requestOrigin, 'copilot-sdk');
        assert.equal(result.requestKind, 'unclassified');
        assert.equal(result.agentRole, 'undetermined');
        assert.match(result.evidence.purpose.reasonCode ?? '', /^extraction-/);
    }
});

test('SDK 确认子代理首次独立委派随机分离，父 marker 不定身份，自身 marker 才延续', async () => {
    const classifier = await getClassifier();
    const classification = classifier.classifyRequestContext([
        system(SDK_CUSTOM_SUBAGENT),
        user('Synthetic repeated assignment.')
    ]);
    assert.equal(classification.agentRole, 'subagent');
    const parent = {
        extension: 'vicanent.gcmp',
        sessionId: 'synthetic-parent',
        provider: 'slot',
        modelId: 'model',
        sdkMode: 'openai',
        responseId: ''
    };
    assert.equal(canRestoreMarkerSession(parent, classification), false);
    const messages = [system(SDK_CUSTOM_SUBAGENT), user('Synthetic repeated assignment.')];
    const first = resolveSubSessionId(
        messages,
        parent.sessionId,
        classification.requestKind,
        true,
        classification.requestOrigin
    );
    const second = resolveSubSessionId(
        messages,
        parent.sessionId,
        classification.requestKind,
        true,
        classification.requestOrigin
    );
    assert.match(first ?? '', /^sub_[0-9a-f]{32}$/);
    assert.match(second ?? '', /^sub_[0-9a-f]{32}$/);
    assert.notEqual(first, second);
    const child = {
        ...parent,
        subSessionId: first,
        continuity: { version: 1, scope: 'subagent', agentRole: 'subagent' }
    };
    assert.equal(canRestoreMarkerSession(child, classification), true);
    const continuation = [
        { role: 2, content: [{ mimeType: 'stateful_marker', data: encodeStatefulMarkerPayload('model', child) }] },
        ...messages
    ];
    assert.equal(
        resolveSubSessionId(
            continuation,
            parent.sessionId,
            classification.requestKind,
            true,
            classification.requestOrigin
        ),
        first
    );
    assert.equal(canRestoreMarkerSession(child, classifier.classifyRequestContext([system(SDK_MAIN)])), false);
});

test('SDK 通用子代理要求自己的完整执行框架，不借用其他子代理工具说明', async () => {
    const classifier = await getClassifier();
    const otherCalling = SDK_CUSTOM_SUBAGENT.match(/<tool_calling>[\s\S]*?<\/tool_calling>/)?.[0];
    assert.ok(otherCalling);
    for (const prompt of [
        SDK_GENERAL_SUBAGENT.replace(/<tool_calling>[\s\S]*?<\/tool_calling>/, otherCalling),
        SDK_GENERAL_SUBAGENT.replace('</tool_calling>', ''),
        SDK_GENERAL_SUBAGENT.replace(
            'You are running in non-interactive mode and have no way to communicate with the user.',
            ''
        ),
        SDK_GENERAL_SUBAGENT.replace(
            '**CRITICAL: Do NOT use /tmp or temporary directories for ANY file operations.**',
            ''
        )
    ]) {
        const result = classifier.classifyRequestContext([system(prompt)], { requestInitiator: 'core' });
        assert.equal(result.requestOrigin, 'core');
        assert.equal(result.requestKind, 'unclassified');
        assert.equal(result.agentRole, 'undetermined');
    }
});

test('SDK 主框架覆盖 identity 不变成旧来源，也不启用旧会话和轮次策略', async () => {
    const classifier = await getClassifier();
    for (const identity of ['Synthetic alternative identity.', 'You are an expert AI programming assistant.']) {
        const prompt = SDK_MAIN.replace(SDK_HOST_IDENTITY, identity);
        const result = classifier.classifyRequestContext([system(prompt), user('Synthetic assignment.')], {
            requestInitiator: 'core'
        });
        assert.equal(result.requestOrigin, 'copilot-sdk');
        assert.equal(result.requestKind, 'main-agent');
        assert.equal(result.agentRole, 'main');
        assert.equal(result.evidence.origin.ruleId, 'origin.sdk.ad270aa.main-frame');
        assert.equal(usesLegacyTurnAffinity(result), false);
        assert.equal(classifier.getRequestBehavior(result).canUseLegacyRecovery, false);
        assert.equal(classifier.getRequestBehavior(result).canRegisterUserInput, false);
        const foreign = classifier.classifyRequestContext([system(prompt)], { requestInitiator: 'some.extension' });
        assert.equal(foreign.requestOrigin, 'other-extension');
        assert.equal(foreign.requestKind, 'unclassified');
    }
});

for (const [name, prompt, required] of [
    ['claude', SDK_CLAUDE_MAIN, 'exploration_and_reading_files'],
    ['gemini', SDK_GEMINI_MAIN, 'reduce_aggressive_code_changes']
] as const) {
    test(`SDK ${name} 主框架完整组合与引用边界`, async () => {
        const classifier = await getClassifier();
        const overridden = prompt.replace(SDK_HOST_IDENTITY, 'You are an expert AI programming assistant.');
        const result = classifier.classifyRequestContext([system(overridden)], { requestInitiator: 'core' });
        assert.equal(result.requestOrigin, 'copilot-sdk');
        assert.equal(result.requestKind, 'main-agent');
        assert.equal(usesLegacyTurnAffinity(result), false);
        for (const malformed of [
            prompt.replace(new RegExp(`<${required}>[\\s\\S]*?</${required}>`), ''),
            prompt.replace(`</${required}>`, ''),
            prompt.replace(/<tool_preferences>[\s\S]*?<\/tool_preferences>/, ''),
            `${prompt}\n<task_completion>\nDuplicate\n</task_completion>`
        ]) {
            assert.equal(classifier.classifyRequestContext([system(malformed)]).requestKind, 'unclassified');
        }
        for (const quoted of [
            `\`\`\`text\n${prompt}\n\`\`\``,
            prompt
                .split('\n')
                .map(line => `> ${line}`)
                .join('\n'),
            `<example>\n${prompt}\n</example>\n<example>\n${prompt}\n</example>`
        ]) {
            assert.equal(classifier.classifyRequestContext([system(quoted)]).requestKind, 'unclassified');
        }
        const foreign = classifier.classifyRequestContext([system(overridden)], {
            requestInitiator: 'other.extension'
        });
        assert.equal(foreign.requestOrigin, 'other-extension');
        assert.equal(foreign.requestKind, 'unclassified');
    });
}

for (const [name, prompt] of [
    ['code-review', SDK_CODE_REVIEW_SUBAGENT],
    ['security-review', SDK_SECURITY_REVIEW_SUBAGENT],
    ['research', SDK_RESEARCH_SUBAGENT]
] as const) {
    test(`SDK ${name} 子代理不能只靠角色首句或被引用内容命中`, async () => {
        const classifier = await getClassifier();
        for (const invalid of [
            prompt.split('\n')[0],
            prompt.replace(/<prohibited_actions>[\s\S]*?<\/prohibited_actions>/, ''),
            prompt.replace('**CRITICAL: Do NOT write output to files.**', ''),
            `<agent_instructions>\n${prompt}\n</agent_instructions>`,
            `\`\`\`text\n${prompt}\n\`\`\``
        ]) {
            assert.equal(
                classifier.classifyRequestContext([system(invalid)], { requestInitiator: 'core' }).requestKind,
                'unclassified'
            );
        }
        assert.equal(classifier.classifyRequestContext([system(SDK_MAIN), user(prompt)]).requestKind, 'main-agent');
        const nested = `${SDK_MAIN}\n<agent_instructions>\n${prompt}\n</agent_instructions>`;
        assert.equal(classifier.classifyRequestContext([system(nested)]).requestKind, 'main-agent');
    });
}

for (const requestInitiator of ['core', undefined, 'github.copilot-chat']) {
    test(`共用交接摘要模板确定用途而不伪造来源：${requestInitiator}`, async () => {
        const classifier = await getClassifier();
        const result = classifier.classifyRequestContext(
            [system(SHARED_HANDOFF_SUMMARY), user('Synthetic summary request.')],
            { requestInitiator }
        );
        assert.equal(result.requestKind, 'summarization');
        assert.equal(result.agentRole, 'not-applicable');
        assert.equal(
            result.requestOrigin,
            requestInitiator === 'github.copilot-chat' ? 'copilot-chat' : (requestInitiator ?? 'unknown')
        );
        assert.equal(
            classifier.getRequestBehavior(result).canObserveSummary,
            requestInitiator === 'github.copilot-chat'
        );
        assert.equal(
            classifier.getRequestBehavior(result).canUseLegacyRecovery,
            requestInitiator === 'github.copilot-chat'
        );
        assert.equal(usesLegacyTurnAffinity(result), false);
        assert.equal(classifier.shouldDisableThinkingForRequest(result.requestKind, result), true);
    });
}

test('共用摘要的用户引用、其他扩展及 SDK 主用途冲突不获得辅助权限', async () => {
    const classifier = await getClassifier();
    assert.equal(
        classifier.classifyRequestContext([system(SDK_MAIN), user(SHARED_HANDOFF_SUMMARY)]).requestKind,
        'main-agent'
    );
    assert.equal(
        classifier.classifyRequestContext([system(SHARED_HANDOFF_SUMMARY)], { requestInitiator: 'other.extension' })
            .requestKind,
        'unclassified'
    );
    for (const requestInitiator of ['core', undefined, 'github.copilot-chat']) {
        for (const prompt of [SDK_MAIN, SDK_CLAUDE_MAIN, SDK_GEMINI_MAIN, SDK_CUSTOM_SUBAGENT]) {
            for (const texts of [
                [prompt, SHARED_HANDOFF_SUMMARY],
                [SHARED_HANDOFF_SUMMARY, prompt]
            ]) {
                const conflict = classifier.classifyRequestContext(
                    texts.map(text => system(text)),
                    {
                        requestInitiator
                    }
                );
                assert.equal(conflict.requestOrigin, 'copilot-sdk');
                assert.equal(conflict.evidence.origin.level, 'signature');
                assert.equal(conflict.evidence.origin.reasonCode, undefined);
                assert.equal(conflict.requestKind, 'unclassified');
                assert.equal(conflict.agentRole, 'undetermined');
                assert.equal(conflict.evidence.purpose.reasonCode, 'classification-conflict');
                assert.equal(classifier.getRequestBehavior(conflict).canObserveSummary, false);
                assert.equal(classifier.getRequestBehavior(conflict).canUseLegacyRecovery, false);
                assert.equal(classifier.shouldDisableThinkingForRequest(conflict.requestKind, conflict), false);
            }
        }
    }
});

test('共用交接摘要不与独立 SDK 身份构成来源冲突', async () => {
    const classifier = await getClassifier();
    for (const requestInitiator of ['core', undefined, 'github.copilot-chat']) {
        for (const texts of [
            [SDK_HOST_IDENTITY, SHARED_HANDOFF_SUMMARY],
            [SHARED_HANDOFF_SUMMARY, SDK_HOST_IDENTITY]
        ]) {
            const result = classifier.classifyRequestContext(
                texts.map(text => system(text)),
                { requestInitiator }
            );
            assert.equal(result.requestOrigin, 'copilot-sdk');
            assert.equal(result.evidence.origin.ruleId, 'origin.sdk-identity');
            assert.equal(result.evidence.origin.reasonCode, undefined);
            assert.equal(result.requestKind, 'summarization');
            assert.equal(result.agentRole, 'not-applicable');
            assert.equal(result.evidence.purpose.ruleId, 'shared.handoff-summary');
            assert.equal(classifier.getRequestBehavior(result).canObserveSummary, false);
            assert.equal(classifier.getRequestBehavior(result).canUseLegacyRecovery, false);
            assert.equal(classifier.shouldDisableThinkingForRequest(result.requestKind, result), true);
        }
    }
});

test('共用交接摘要签名要求完整结构且不从引用中提取', () => {
    assert.equal(isSharedHandoffSummary(SHARED_HANDOFF_SUMMARY.replace(/\n/g, '\r\n')), true);
    for (const invalid of [
        SHARED_HANDOFF_SUMMARY.split('\n')[0],
        SHARED_HANDOFF_SUMMARY.replace('</summary>', ''),
        SHARED_HANDOFF_SUMMARY.replace('8. Continuation Plan:', ''),
        SHARED_HANDOFF_SUMMARY.replace('[Recent Commands Analysis:', '[Synthetic:'),
        `\`\`\`text\n${SHARED_HANDOFF_SUMMARY}\n\`\`\``,
        SHARED_HANDOFF_SUMMARY.split('\n')
            .map(line => `> ${line}`)
            .join('\n'),
        `<example>\n${SHARED_HANDOFF_SUMMARY}\n</example>`
    ]) {
        assert.equal(isSharedHandoffSummary(invalid), false);
    }
});

test('SDK 旁路用途不可从任意 modelOptions 注入，共用摘要超限也降级', async () => {
    const classifier = await getClassifier();
    const options = {
        requestInitiator: 'core',
        modelOptions: { requestKind: 'summarization', interactionType: 'conversation-compaction' }
    };
    const main = classifier.classifyRequestContext([system(SDK_MAIN), user('Synthetic assignment.')], options);
    assert.equal(main.requestKind, 'main-agent');
    const result = classifier.classifyRequestContext(
        [system(`${SHARED_HANDOFF_SUMMARY}\n${'x'.repeat(300_000)}`)],
        options
    );
    assert.equal(result.requestKind, 'unclassified');
    assert.equal(result.agentRole, 'undetermined');
    assert.equal(classifier.shouldDisableThinkingForRequest('summarization', result), false);
    assert.equal(classifier.getRequestBehavior(result).canUseLegacyRecovery, false);
});

test('SDK 技能目录允许行内字段、缩进和重复技能，但不改变已有用途', async () => {
    const classifier = await getClassifier();
    for (const [prompt, kind] of [
        [SDK_MAIN, 'main-agent'],
        [SDK_CLAUDE_MAIN, 'main-agent'],
        [SDK_GEMINI_MAIN, 'main-agent'],
        [SDK_GENERIC_MAIN, 'main-agent'],
        ...childCases.map(([, prompt, kind]) => [prompt, kind])
    ]) {
        for (const catalog of [SDK_SKILL_CATALOG, SDK_SKILL_CATALOG.replace(/^(<\/?skill>)$/gm, '  $1')]) {
            const result = classifier.classifyRequestContext([system(`${prompt}\n${catalog}`)], {
                requestInitiator: 'core'
            });
            assert.equal(result.requestKind, kind);
            assert.equal(result.requestOrigin, 'copilot-sdk');
        }
    }
    assert.equal(
        classifier.classifyRequestContext([system(SDK_GENERIC_MAIN_WITH_SKILLS.replace(/\n/g, '\r\n'))]).requestKind,
        'main-agent'
    );
});

test('SDK 行内标签仍拒绝错误闭合及重复关键块', async () => {
    const classifier = await getClassifier();
    for (const catalog of [
        SDK_SKILL_CATALOG.replace('</name>', '</description>'),
        SDK_SKILL_CATALOG.replace('</skill>', ''),
        SDK_SKILL_CATALOG.replace('</available_skills>', ''),
        SDK_SKILL_CATALOG.replace('  <name>synthetic-first</name>', '  <name>first</name>\n  <name>duplicate</name>'),
        '<skill>first</skill>\n<skill>duplicate</skill>'
    ]) {
        assert.equal(
            classifier.classifyRequestContext([system(`${SDK_MAIN}\n${catalog}`)]).requestKind,
            'unclassified'
        );
    }
    for (const prompt of [
        `${SDK_MAIN}\n<task_completion>* A task is not complete until the expected outcome is verified and persistent</task_completion>`,
        `<task_completion>Duplicate</task_completion>\n${SDK_MAIN}`,
        SDK_GENERIC_MAIN.replace('</tool_calling>', '</tools>'),
        SDK_GENERIC_MAIN.replace(
            '</task_completion>',
            '</task_completion><task_completion>Duplicate</task_completion>'
        ),
        SDK_GENERIC_MAIN.replace('</tool_calling>', '<unexpected></tool_calling>')
    ]) {
        assert.equal(classifier.classifyRequestContext([system(prompt)]).requestKind, 'unclassified');
    }
});

test('SDK 通用主框架仍要求完整任务、通知、工具调用与搜索结构', async () => {
    const classifier = await getClassifier();
    for (const block of [
        'code_change_instructions',
        'system_notifications',
        'tool_calling',
        'code_search_tools',
        'task_completion'
    ]) {
        for (const prompt of [
            SDK_GENERIC_MAIN.replace(new RegExp(`<${block}>[\\s\\S]*?</${block}>`), ''),
            SDK_GENERIC_MAIN.replace(`</${block}>`, '')
        ]) {
            const result = classifier.classifyRequestContext([system(prompt)], { requestInitiator: 'core' });
            assert.equal(result.requestKind, 'unclassified');
            assert.equal(result.agentRole, 'undetermined');
        }
    }
    for (const identity of ['Synthetic identity.', 'You are an expert AI programming assistant.']) {
        const prompt = SDK_GENERIC_MAIN_WITH_SKILLS.replace(SDK_HOST_IDENTITY, identity);
        const result = classifier.classifyRequestContext([system(prompt)], { requestInitiator: 'core' });
        assert.equal(result.requestKind, 'main-agent');
        assert.equal(result.requestOrigin, 'copilot-sdk');
        const foreign = classifier.classifyRequestContext([system(prompt)], { requestInitiator: 'other.extension' });
        assert.equal(foreign.requestOrigin, 'other-extension');
        assert.equal(foreign.requestKind, 'unclassified');
    }
});

test('SDK 技能内容和引用中的框架不能提升用途或填补缺失块', async () => {
    const classifier = await getClassifier();
    for (const prompt of [SDK_GENERIC_MAIN_WITH_SKILLS, SDK_CUSTOM_SUBAGENT]) {
        const nested = `<available_skills>\n<skill>\n<description>\n${prompt}\n</description>\n</skill>\n</available_skills>`;
        for (const messages of [
            [system(nested)],
            [system(`\`\`\`text\n${prompt}\n\`\`\``)],
            [
                system(
                    prompt
                        .split('\n')
                        .map(line => `> ${line}`)
                        .join('\n')
                )
            ],
            [system(SDK_HOST_IDENTITY), user(prompt)],
            [system(SDK_HOST_IDENTITY), { ...user(prompt), role: 2 }],
            [system(SDK_GENERIC_MAIN.replace(/<tool_calling>[\s\S]*?<\/tool_calling>/, '') + '\n' + nested)]
        ]) {
            const result = classifier.classifyRequestContext(messages, { requestInitiator: 'core' });
            assert.equal(result.requestKind, 'unclassified');
            assert.equal(result.agentRole, 'undetermined');
        }
        assert.equal(
            classifier.classifyRequestContext([system(`${SDK_GENERIC_MAIN}\n${nested}`)]).requestKind,
            'main-agent'
        );
    }
});

test('SDK 通用主模板记录弱证据压缩摘要并保持同级用途冲突降级', async () => {
    const classifier = await getClassifier();
    const compact = classifier.classifyRequestContext([system(SDK_GENERIC_MAIN_WITH_SKILLS), user(SDK_COMPACTION)]);
    assert.equal(compact.requestKind, 'summarization');
    assert.equal(compact.evidence.purpose.reasonCode, 'sdk-compaction-unconfirmed');
    assert.equal(classifier.shouldDisableThinkingForRequest('summarization', compact), false);
    for (const other of [SDK_CUSTOM_SUBAGENT, SDK_GENERAL_SUBAGENT, SHARED_HANDOFF_SUMMARY]) {
        const result = classifier.classifyRequestContext([system(SDK_GENERIC_MAIN_WITH_SKILLS), system(other)]);
        assert.equal(result.requestOrigin, 'copilot-sdk');
        assert.equal(result.requestKind, 'unclassified');
        assert.equal(result.evidence.purpose.reasonCode, 'classification-conflict');
    }
});

test('SDK 根 System 会话标识在主请求和压缩间稳定，输出仅为哈希', async () => {
    const classifier = await getClassifier();
    const prompt = `${SDK_GENERIC_MAIN_WITH_SKILLS}\n${SDK_SESSION_CONTEXT}`;
    let expected: string | undefined;
    for (const latest of ['Synthetic task.', SDK_COMPACTION, 'Synthetic continuation.']) {
        const input = [system(prompt), user(latest)];
        const classification = classifier.classifyRequestContext(input, { requestInitiator: 'core' });
        const key = classifier.getSdkSessionContextKey(input, classification);
        assert.match(key ?? '', /^[a-f0-9]{64}$/);
        expected ??= key;
        assert.equal(key, expected);
        assert.equal(
            classifier.getSdkSessionContextKey([system(prompt.replace(/\n/g, '\r\n')), user(latest)], classification),
            expected
        );
        assert.equal(
            classifier.getSdkSessionContextKey(
                [{ ...user(prompt), name: 'gcmp-system' }, user(latest)],
                classification
            ),
            expected
        );
    }
    const changed = [
        system(prompt.replace('11111111-1111-4111-8111-111111111111', '22222222-2222-4222-8222-222222222222'))
    ];
    assert.notEqual(classifier.getSdkSessionContextKey(changed, classifier.classifyRequestContext(changed)), expected);
    const posix = [
        system(prompt.replace('C:\\Synthetic\\.copilot\\session-state\\', '/synthetic/.copilot/session-state/'))
    ];
    assert.match(
        classifier.getSdkSessionContextKey(posix, classifier.classifyRequestContext(posix)) ?? '',
        /^[a-f0-9]{64}$/
    );
    const sameIdentity = [system(prompt)];
    assert.equal(
        classifier.getSdkSessionContextKey(
            sameIdentity,
            classifier.classifyRequestContext(sameIdentity),
            'other.extension'
        ),
        undefined
    );
});

test('SDK 会话标识不能从历史、子代理、引用、冲突或不完整框架借用', async () => {
    const classifier = await getClassifier();
    const prompt = `${SDK_MAIN}\n${SDK_SESSION_CONTEXT}`;
    for (const input of [
        [system(SDK_MAIN), user(SDK_SESSION_CONTEXT)],
        [system(SDK_MAIN), { ...user(SDK_SESSION_CONTEXT), role: 2 }],
        [system(`${SDK_MAIN}\n<example>\n${SDK_SESSION_CONTEXT}\n</example>`)],
        [system(`${SDK_MAIN}\n\`\`\`text\n${SDK_SESSION_CONTEXT}\n\`\`\``)],
        [
            system(
                `${SDK_MAIN}\n${SDK_SESSION_CONTEXT.split('\n')
                    .map(line => `> ${line}`)
                    .join('\n')}`
            )
        ],
        [system(`${SDK_HOST_IDENTITY}\n${SDK_SESSION_CONTEXT}`)],
        [system(`${SDK_CUSTOM_SUBAGENT}\n${SDK_SESSION_CONTEXT}`)],
        [system(`${SDK_GENERAL_SUBAGENT}\n${SDK_SESSION_CONTEXT}`)],
        [system(`${SDK_MAIN}\n${SDK_SESSION_CONTEXT}\n${SDK_SESSION_CONTEXT}`)],
        [system(prompt.replace('11111111-1111-4111-8111-111111111111', 'invalid-session'))],
        [system(prompt.replace('session-state', 'unrelated-folder'))],
        [system(prompt.replace('C:\\Synthetic\\.copilot\\', 'relative\\'))],
        [system(prompt.replace('files/ persists across checkpoints', 'unverified footer'))],
        [
            system(prompt),
            system(prompt.replace('11111111-1111-4111-8111-111111111111', '22222222-2222-4222-8222-222222222222'))
        ],
        [system(prompt), system(SDK_MAIN)],
        [system(prompt), system(SDK_CUSTOM_SUBAGENT)],
        [system(`${prompt}\n${'x'.repeat(300_000)}`)]
    ]) {
        const classification = classifier.classifyRequestContext(input, { requestInitiator: 'core' });
        assert.equal(classifier.getSdkSessionContextKey(input, classification), undefined);
    }
    const foreign = [system(prompt.replace(SDK_HOST_IDENTITY, 'Synthetic identity.'))];
    assert.equal(
        classifier.getSdkSessionContextKey(
            foreign,
            classifier.classifyRequestContext(foreign, { requestInitiator: 'other.extension' })
        ),
        undefined
    );
});
