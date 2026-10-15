/*---------------------------------------------------------------------------------------------
 *  RequestKind 分类器
 *  通过分析系统提示词前缀和工具列表判断 Copilot 请求类型
 *  用于控制思考模式开关、工具流处理、日志记录等行为
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { REQUEST_KIND_DISPLAY_NAMES } from './requestKindDisplayNames';
import {
    CONVERSATION_COMPACTION_PROMPT_PREFIX,
    isConversationCompactionPromptText
} from '../conversationCompactionPrompt';
import { classifyModeOverlaySubagent } from './subagentModeClassifier';
import {
    SDK_COMPACTION_PROMPT_PREFIX,
    getSdkSessionContextHash,
    getSdkSystemPurposes,
    isSdkCompactionCandidate,
    isSharedHandoffSummary
} from './sdkRequestClassifier';
import type {
    AgentRole,
    DimensionEvidence,
    RequestClassification,
    RequestClassificationMetadata,
    RequestOrigin
} from './requestClassification';

/**
 * Copilot Chat 请求类型
 */
export type RequestKind =
    | 'main-agent' // 主 Agent 对话（用户发起）
    | 'terminal-steering' // 终端通知驱动的指引
    | 'terminal-command' // 终端命令建议（/explain 等）
    | 'terminal-quickfix' // 终端快速修复
    | 'terminal-explain' // 终端错误解释
    | 'explain-code' // 代码解释（/explain）
    | 'workspace-search' // 工作空间文本搜索助手
    | 'code-search' // 代码库语义搜索（搜索面板）
    | 'vscode-qa' // VS Code 知识问答
    | 'search-subagent' // 搜索/探索子 Agent（search_subagent / explore_subagent）
    | 'execution-subagent' // 执行子 Agent（execution_subagent）
    | 'subagent'
    | 'todo-tracker' // 待办列表跟踪
    | 'prompt-categorizer' // Prompt 分类
    | 'intent-detector' // 意图检测/参与者路由
    | 'settings-resolver' // 设置解析
    | 'chat-title' // 会话标题生成
    | 'inline-progress-message' // 内联进度消息
    | 'git-branch-name' // Git 分支名建议
    | 'vision-recognition' // 视觉图像识别请求
    | 'git-commit-message' // Git 提交消息生成
    | 'pr-description' // PR 描述生成
    | 'rename-suggestions' // 重命名建议
    | 'summarization' // 对话摘要（上下文压缩）
    | 'code-mapper' // 代码映射/重写
    | 'feedback-gen' // 代码反馈生成
    | 'debug-config' // 调试配置生成
    | 'workspace-gen' // 工作区/文件生成
    | 'test-gen' // 测试生成
    | 'goal-summary' // 目标摘要
    | 'risk-assessment' // 命令风险评估
    | 'patch-healer' // apply_patch/edit_file 失败后的补丁修复
    | 'notebook-gen' // Notebook 大纲/单元格生成
    | 'mcp-setup' // MCP 服务器配置生成
    | 'tool-clustering' // 虚拟工具聚类摘要
    | 'ai-evaluator' // AI 响应达标评估
    | 'unclassified'
    | 'background' // 历史未分类请求
    | 'unknown'; // 无法识别（空请求）

const SUB_REQUEST_TYPES = new Set<RequestKind>([
    'summarization',
    'terminal-command',
    'terminal-quickfix',
    'terminal-explain',
    'explain-code',
    'workspace-search',
    'code-search',
    'vscode-qa',
    'search-subagent',
    'execution-subagent',
    'subagent',
    'todo-tracker',
    'prompt-categorizer',
    'intent-detector',
    'settings-resolver',
    'chat-title',
    'inline-progress-message',
    'git-branch-name',
    'git-commit-message',
    'vision-recognition',
    'pr-description',
    'rename-suggestions',
    'code-mapper',
    'feedback-gen',
    'debug-config',
    'workspace-gen',
    'test-gen',
    'goal-summary',
    'risk-assessment',
    'patch-healer',
    'notebook-gen',
    'mcp-setup',
    'tool-clustering',
    'ai-evaluator'
]);

/** 系统提示词前缀 → RequestKind 映射
 * 来源文件路径基于 microsoft/vscode 仓库 `extensions/copilot/src/extension/`
 */
const SYSTEM_PROMPT_PREFIXES: [string, RequestKind][] = [
    // backgroundTodoAgentPrompt.tsx → todo-tracker
    ['You are a background task tracker', 'todo-tracker'],
    // promptCategorization.tsx → prompt-categorizer
    ['You are an expert classifier for AI coding assistant prompts', 'prompt-categorizer'],
    // settingsEditorSuggestQueryPrompt.tsx → settings-resolver
    [
        'You are a Visual Studio Code assistant. Your job is to assist users in using Visual Studio Code by returning settings',
        'settings-resolver'
    ],
    // title.tsx → chat-title
    ['You are an expert in crafting ultra-compact titles', 'chat-title'],
    ['You are an expert in crafting pithy titles', 'chat-title'],
    // progressMessagesPrompt.tsx → inline-progress-message
    ['You are an expert in writing short, catchy, and encouraging progress messages', 'inline-progress-message'],
    // gitBranch.tsx → git-branch-name
    ['You are an expert in crafting pithy branch names', 'git-branch-name'],
    // gitCommitMessagePrompt.tsx → git-commit-message
    [
        'You are an AI programming assistant, helping a software developer to come with the best git commit message',
        'git-commit-message'
    ],
    // renameSuggestionsPrompt.tsx → rename-suggestions
    ['You are a distinguished software engineer', 'rename-suggestions'],
    // summarizedConversationHistory.tsx → summarization
    ['Your task is to create a comprehensive, detailed summary of the entire conversation', 'summarization'],
    // searchSubagentPrompt.tsx → search-subagent
    ['You are an AI coding research assistant that uses search tools to gather information', 'search-subagent'],
    // executionSubagentPrompt.tsx → execution-subagent
    [
        'You are an AI coding research assistant that runs a series of terminal commands to perform a small execution-focused task',
        'execution-subagent'
    ],
    // terminal.tsx → terminal-command
    [
        'You are a programmer who specializes in using the command line. Your task is to help the Developer craft a command',
        'terminal-command'
    ],
    // terminalQuickFix.tsx → terminal-quickfix (变体1: 列出文件)
    [
        'You are a programmer who specializes in using the command line. Your task is to respond with a list of files',
        'terminal-quickfix'
    ],
    // terminalExplain.tsx → terminal-explain
    [
        'You are a programmer who specializes in using the command line. Your task is to help the Developer by giving a detailed answer',
        'terminal-explain'
    ],
    // terminalQuickFix.tsx → terminal-quickfix (变体2: 修复命令)
    [
        'You are a programmer who specializes in using the command line. Your task is to help the user fix a command',
        'terminal-quickfix'
    ],
    // explain.tsx → explain-code
    ['You are a world-class coding tutor', 'explain-code'],
    // search.tsx → workspace-search
    ['You are a VS Code search expert who helps to write search queries', 'workspace-search'],
    // searchPanelPrompt.tsx / searchPanelKeywordsPrompt.tsx → code-search
    ['You are a software engineer with expert knowledge of the codebase the user has open', 'code-search'],
    // vscode.tsx → vscode-qa
    [
        'You are a Visual Studio Code assistant. Your job is to assist users in using Visual Studio Code by providing knowledge',
        'vscode-qa'
    ],
    // newWorkspace.tsx → workspace-gen (文件生成)
    ['You are a Visual Studio Code assistant. Your job is to generate the contents of a new file', 'workspace-gen'],
    // languageToolsProvider.tsx → terminal-command (开发工具助手)
    ['You are an AI programming assistant that is specialized for usage of command-line tools', 'terminal-command'],
    // codeMapperPrompt.tsx → code-mapper
    [
        'You are an AI programming assistant that is specialized in applying code changes to an existing document',
        'code-mapper'
    ],
    // codeMapperPrompt.tsx（新文档变体）→ code-mapper
    ['You are an AI programming assistant that is specialized in generating code for a new document', 'code-mapper'],
    // setupTestsInvocation.tsx / setupTestsFrameworkQueryInvocation.tsx → test-gen
    ['You are a software engineer with expert knowledge around software testing frameworks', 'test-gen'],
    // startDebugging.tsx → debug-config
    [
        'You are a Visual Studio Code assistant who specializes in debugging and creating launch configurations',
        'debug-config'
    ],
    // intentDetector.tsx → intent-detector
    ['You are a helpful AI programming assistant. Your task is to choose one category', 'intent-detector'],
    // pullRequestDescriptionPrompt.tsx → pr-description
    ['You are an AI assistant for a software developer who is about to make a pull request', 'pr-description'],
    // provideFeedback.tsx → feedback-gen
    ['You are a world-class software engineer and the author and maintainer', 'feedback-gen'],
    // customizationCreatorService.ts → workspace-gen (Agent/Skill 创建引导)
    ['You are a helpful assistant that guides users through creating a new custom', 'workspace-gen'],
    // chatGoalSummaryService.ts → goal-summary
    ['You summarize a user', 'goal-summary'],
    // chatToolRiskAssessmentService.ts → risk-assessment
    ['You assess what one terminal command does', 'risk-assessment'],
    // applyPatchTool.tsx (Heal Patch 修复) → patch-healer
    ['You are an expert in file editing. The user has provided a patch that failed to apply', 'patch-healer'],
    // editFileHealing.tsx (edit_file 失败修复) → patch-healer
    ['You are an expert at analyzing files and patterns', 'patch-healer'],
    // codebaseAgentPrompt.tsx → code-search (@workspace 语义搜索代理，须在 main-agent 兜底之前)
    ['You are a code search expert', 'code-search'],
    // mcpToolCallingLoopPrompt.tsx → mcp-setup
    ['You are an expert in reading documentation and extracting relevant results', 'mcp-setup'],
    // virtualToolSummarizer.tsx → tool-clustering
    ['Context: You are given multiple groups of tools', 'tool-clustering'],
    // newNotebook.tsx → notebook-gen (大纲)
    ['You are an AI that creates a detailed content outline for a Jupyter notebook', 'notebook-gen'],
    // newNotebook.tsx → notebook-gen (单元格代码)
    ['You are an AI that writes Python code for a single section of a Jupyter notebook', 'notebook-gen'],
    // devContainerConfigPrompt.tsx → workspace-gen (首行带句号，须在兜底之前)
    [
        'You are an AI programming assistant.\nYou are helping a software developer to configure a Dev Container',
        'workspace-gen'
    ],
    // userQueryParser.tsx → test-gen (测试意图解析，copilot-utility-small)
    ['You are a helpful assistant that parses user queries', 'test-gen'],
    // aiEvaluationService.tsx → ai-evaluator
    ['You are a world class examiner and must decide whether a response fulfills a given criteria', 'ai-evaluator'],
    // ---- 以下为 main-agent 兜底，必须保持在数组末尾 ----
    // gpt5Prompt.tsx / gpt51Prompt.tsx / gpt52Prompt.tsx → main-agent (GPT-5 系列)
    ['You are a coding agent running in VS Code', 'main-agent'],
    // gpt5CodexPrompt.tsx / gpt51CodexPrompt.tsx → main-agent (Codex 系列)
    ['You are a coding agent based on', 'main-agent'],
    // hiddenModelMPrompt.tsx / gpt55BasePrompt.tsx → main-agent
    ['You have a vivid inner life as coding agent', 'main-agent'],
    // zaiPrompts.tsx → main-agent (GLM/ZAI 系列)
    ['You are a senior software architect and expert coding agent', 'main-agent'],
    // defaultAgentInstructions.tsx / gemini / anthropic / xAI / editCodePrompt2 → main-agent
    ['You are a highly sophisticated automated coding agent', 'main-agent'],
    // panelChatBasePrompt.tsx / editCodePrompt.tsx / inlineChat*.tsx → main-agent (面板/内联兜底)
    ['You are an AI programming assistant', 'main-agent'],
    // agentPrompt.tsx / minimaxPrompts.tsx / familyHPrompts.tsx → main-agent
    ['You are an expert AI programming assistant', 'main-agent']
];

export function isSubRequest(kind: RequestKind, metadata?: RequestClassificationMetadata): boolean {
    return SUB_REQUEST_TYPES.has(kind) && (metadata === undefined || hasStrongEvidence(metadata.evidence.purpose));
}

export function shouldDisableThinkingForRequest(
    kind: RequestKind | undefined,
    metadata?: RequestClassificationMetadata
): boolean {
    if (
        kind === undefined ||
        !isSubRequest(kind) ||
        kind === 'search-subagent' ||
        kind === 'execution-subagent' ||
        kind === 'subagent'
    ) {
        return false;
    }
    return (
        metadata === undefined ||
        (hasStrongEvidence(metadata.evidence.purpose) && metadata.agentRole === 'not-applicable')
    );
}

/**
 * 获取请求类型的友好显示名称（自动按语言切换中英文）
 * 支持扩展侧（vscode.env.language）和 webview 侧（document.documentElement.lang）两种环境
 */
export function getRequestKindDisplayName(kind: RequestKind): string {
    const names = REQUEST_KIND_DISPLAY_NAMES[kind];
    if (!names) {
        return kind;
    }

    // 优先使用 vscode API（扩展侧），其次检测 DOM（webview 侧）
    try {
        const lang =
            typeof vscode !== 'undefined' && vscode.env?.language ? vscode.env.language.toLowerCase()
            : typeof document !== 'undefined' ?
                (document.documentElement.lang || navigator.language || '').toLowerCase()
            :   '';
        const isCn = lang === 'zh-cn' || lang === 'zh' || lang.startsWith('zh-');
        return isCn ? names[1] : names[0];
    } catch {
        return names[0];
    }
}

const TERMINAL_NOTIFICATION_PATTERN = /^\[Terminal\s+\S+\s+notification:/;
const SDK_IDENTITY = 'You are an AI assistant using Copilot SDK in VS Code.';
const MAX_MESSAGES = 4096;
const MAX_PARTS = 16384;
const MAX_TOOLS = 1024;
const MAX_TEXT_BYTES = 256 * 1024;

export interface RequestClassificationOptions {
    requestInitiator?: string;
    tools?: readonly vscode.LanguageModelChatTool[];
    modelOptions?: { requestKind?: unknown };
}

export interface RequestBehavior {
    canRegisterUserInput: boolean;
    canObserveSummary: boolean;
    canObserveTitle: boolean;
    canUseLegacyRecovery: boolean;
}

interface RequestFeatures {
    systemTexts: string[];
    latestUserText: string;
    toolNames: string[];
    hasContent: boolean;
    failure?: 'extraction-budget-exceeded' | 'extraction-failed';
}

interface PurposeCandidate {
    kind: RequestKind;
    evidence: DimensionEvidence;
}

function hasStrongEvidence(evidence: DimensionEvidence): boolean {
    return (evidence.level === 'signature' || evidence.level === 'contract') && evidence.reasonCode === undefined;
}

function createClassification(
    requestOrigin: RequestOrigin,
    origin: DimensionEvidence,
    requestKind: RequestKind = 'unclassified',
    purpose: DimensionEvidence = { level: 'unknown' }
): RequestClassification {
    let agentRole: AgentRole = 'undetermined';
    if (hasStrongEvidence(purpose)) {
        if (requestKind === 'main-agent' || requestKind === 'terminal-steering') {
            agentRole = 'main';
        } else if (
            requestKind === 'search-subagent' ||
            requestKind === 'execution-subagent' ||
            requestKind === 'subagent'
        ) {
            agentRole = 'subagent';
        } else if (isSubRequest(requestKind)) {
            agentRole = 'not-applicable';
        }
    }
    return {
        version: 1,
        requestOrigin,
        requestKind,
        agentRole,
        evidence: {
            origin: { ...origin },
            purpose: { ...purpose },
            role: agentRole === 'undetermined' ? { level: 'unknown' } : { ...purpose }
        }
    };
}

function extractRequestFeatures(
    messages: readonly vscode.LanguageModelChatMessage[],
    tools?: readonly vscode.LanguageModelChatTool[]
): RequestFeatures {
    const features: RequestFeatures = { systemTexts: [], latestUserText: '', toolNames: [], hasContent: false };
    const encoder = new TextEncoder();
    let remainingBytes = MAX_TEXT_BYTES;
    let remainingUserBytes = MAX_TEXT_BYTES;
    let latestUserTruncated = false;
    let partCount = 0;

    function scanText(value: string, userText = false): string {
        const remaining = userText ? remainingUserBytes : remainingBytes;
        const prefix = value.slice(0, remaining);
        const bytes = encoder.encode(prefix);
        const text =
            bytes.length <= remaining ?
                prefix
            :   new TextDecoder().decode(bytes.subarray(0, remaining), { stream: true });
        if (prefix.length !== value.length || bytes.length > remaining) {
            if (userText) {
                latestUserTruncated = true;
            } else {
                features.failure = 'extraction-budget-exceeded';
            }
        }
        if (userText) {
            remainingUserBytes -= Math.min(bytes.length, remaining);
        } else {
            remainingBytes -= Math.min(bytes.length, remaining);
        }
        return text;
    }

    try {
        if (messages.length > MAX_MESSAGES) {
            features.failure = 'extraction-budget-exceeded';
        }
        let latestUserIndex = -1;
        for (let i = messages.length - 1; i >= Math.max(0, messages.length - MAX_MESSAGES); i--) {
            if (messages[i].role === vscode.LanguageModelChatMessageRole.User && messages[i].name !== 'gcmp-system') {
                latestUserIndex = i;
                break;
            }
        }
        for (let i = 0; i < Math.min(messages.length, MAX_MESSAGES); i++) {
            const message = messages[i];
            const isUser = message.role === vscode.LanguageModelChatMessageRole.User;
            const isSystem =
                message.role === vscode.LanguageModelChatMessageRole.System ||
                (isUser && message.name === 'gcmp-system');
            const content = message.content;
            let text = '';
            try {
                const partsToRead = Math.min(content.length, MAX_PARTS - partCount);
                if (partsToRead < content.length) {
                    features.failure = 'extraction-budget-exceeded';
                }
                for (let j = 0; j < partsToRead; j++) {
                    const part: unknown = content[j];
                    partCount++;
                    if (typeof part !== 'object' || part === null) {
                        continue;
                    }
                    if ('value' in part && typeof part.value === 'string') {
                        if (isSystem || i === latestUserIndex) {
                            const partText = scanText(part.value, !isSystem);
                            text += partText;
                            features.hasContent ||= partText.trim().length > 0;
                        } else {
                            features.hasContent ||= part.value.length > 0;
                        }
                    } else if ('data' in part && part.data instanceof Uint8Array) {
                        features.hasContent ||= part.data.byteLength > 0;
                    } else if ('callId' in part && typeof part.callId === 'string' && part.callId.length > 0) {
                        features.hasContent = true;
                    }
                }
            } finally {
                if (isSystem) {
                    features.systemTexts.push(text.trimStart());
                } else if (i === latestUserIndex) {
                    features.latestUserText = text.trimStart();
                }
            }
            if (partCount === MAX_PARTS) {
                if (i + 1 < messages.length) {
                    features.failure = 'extraction-budget-exceeded';
                }
                break;
            }
        }
        if (tools) {
            features.hasContent ||= tools.length > 0;
            if (tools.length > MAX_TOOLS) {
                features.failure = 'extraction-budget-exceeded';
            }
            for (let i = 0; i < Math.min(tools.length, MAX_TOOLS); i++) {
                const name = tools[i].name;
                if (typeof name === 'string') {
                    features.toolNames.push(scanText(name));
                }
            }
        }
        if (latestUserTruncated) {
            const prefix = features.latestUserText.replace(/\s+/g, ' ').trim();
            if (
                ['[Terminal', CONVERSATION_COMPACTION_PROMPT_PREFIX, SDK_COMPACTION_PROMPT_PREFIX].some(
                    candidate => prefix.startsWith(candidate) || candidate.startsWith(prefix)
                )
            ) {
                features.failure = 'extraction-budget-exceeded';
            }
        }
    } catch {
        features.failure ??= 'extraction-failed';
    }
    return features;
}

export function classifyRequestContext(
    messages: readonly vscode.LanguageModelChatMessage[],
    options?: RequestClassificationOptions
): RequestClassification {
    let requestOrigin: RequestOrigin = 'unknown';
    let origin: DimensionEvidence = { level: 'unknown' };
    try {
        const initiator = options?.requestInitiator;
        if (initiator === 'vicanent.gcmp') {
            const kind = options?.modelOptions?.requestKind;
            if (kind === 'vision-recognition' || kind === 'git-commit-message') {
                return createClassification('gcmp', { level: 'contract', ruleId: 'origin.gcmp' }, kind, {
                    level: 'contract',
                    ruleId: `gcmp.${kind}`
                });
            }
        }
        if (initiator === 'github.copilot-chat') {
            requestOrigin = 'copilot-chat';
            origin = { level: 'signature', ruleId: 'origin.copilot-chat-initiator' };
        } else if (initiator === 'core') {
            requestOrigin = 'core';
            origin = { level: 'heuristic', ruleId: 'origin.core-initiator' };
        } else if (typeof initiator === 'string' && initiator.length > 0) {
            requestOrigin = 'other-extension';
            origin = { level: 'heuristic', ruleId: 'origin.extension-initiator' };
        }

        const features = extractRequestFeatures(messages, options?.tools);
        const sdkPurposes = features.systemTexts.map(getSdkSystemPurposes);
        const sharedSummaries = features.systemTexts.map(isSharedHandoffSummary);
        const hasSharedSummary = sharedSummaries.some(Boolean);
        const allowSdkFrame = requestOrigin !== 'other-extension';
        const prefixes = features.systemTexts.map((text, index) =>
            (allowSdkFrame && sdkPurposes[index].length > 0) || sharedSummaries[index] ?
                undefined
            :   SYSTEM_PROMPT_PREFIXES.find(([prefix]) => text.startsWith(prefix))
        );
        const hasSdkIdentity = features.systemTexts.some(text => text.startsWith(SDK_IDENTITY));
        const hasSdkFrame = allowSdkFrame && sdkPurposes.some(purposes => purposes.length > 0);
        const hasLegacyIdentity = prefixes.some(prefix => prefix !== undefined);
        if ((hasSdkIdentity || hasSdkFrame) && hasLegacyIdentity) {
            return createClassification(
                'unknown',
                { level: 'unknown', reasonCode: 'classification-conflict' },
                'unclassified',
                { level: 'unknown', reasonCode: features.failure ?? 'classification-conflict' }
            );
        }
        if (hasSdkIdentity) {
            requestOrigin = 'copilot-sdk';
            origin = { level: 'signature', ruleId: 'origin.sdk-identity' };
        } else if (hasSdkFrame) {
            requestOrigin = 'copilot-sdk';
            origin = {
                level: 'signature',
                ruleId:
                    sdkPurposes.some(purposes => purposes.includes('main-agent')) ?
                        'origin.sdk.ad270aa.main-frame'
                    :   'origin.sdk.ad270aa.subagent-frame'
            };
        } else if (hasLegacyIdentity && requestOrigin !== 'other-extension') {
            requestOrigin = 'copilot-chat';
            origin = { level: 'signature', ruleId: 'origin.legacy-prefix' };
        }
        if (features.failure) {
            return createClassification(requestOrigin, origin, 'unclassified', {
                level: 'unknown',
                reasonCode: features.failure
            });
        }
        if (requestOrigin === 'copilot-sdk') {
            const kinds = new Set<RequestKind>(sdkPurposes.flat());
            if (hasSharedSummary) {
                kinds.add('summarization');
            }
            if (kinds.size > 1) {
                return createClassification(requestOrigin, origin, 'unclassified', {
                    level: 'unknown',
                    reasonCode: 'classification-conflict'
                });
            }
            const kind = kinds.values().next().value;
            if (kind && isSdkCompactionCandidate(features.latestUserText)) {
                return createClassification(requestOrigin, origin, 'summarization', {
                    level: 'heuristic',
                    ruleId: 'sdk.ad270aa.compaction-candidate',
                    reasonCode: 'sdk-compaction-unconfirmed'
                });
            }
            return createClassification(
                requestOrigin,
                origin,
                kind ?? (features.hasContent ? 'unclassified' : 'unknown'),
                kind ?
                    {
                        level: 'signature',
                        ruleId: kind === 'summarization' ? 'shared.handoff-summary' : `sdk.ad270aa.${kind}`
                    }
                :   undefined
            );
        }
        if (requestOrigin !== 'copilot-chat') {
            if (hasSharedSummary && requestOrigin !== 'other-extension') {
                return createClassification(requestOrigin, origin, 'summarization', {
                    level: 'signature',
                    ruleId: 'shared.handoff-summary'
                });
            }
            return createClassification(requestOrigin, origin, features.hasContent ? 'unclassified' : 'unknown');
        }

        const candidates: PurposeCandidate[] = [];
        for (let i = 0; i < features.systemTexts.length; i++) {
            const text = features.systemTexts[i];
            const prefixKind = sharedSummaries[i] ? 'summarization' : prefixes[i]?.[1];
            const overlay =
                prefixKind === undefined || prefixKind === 'main-agent' ?
                    classifyModeOverlaySubagent(text, features.toolNames)
                :   undefined;
            if (overlay) {
                candidates.push({
                    kind: overlay,
                    evidence: { level: 'signature', ruleId: `legacy.overlay.${overlay}` }
                });
            } else if (prefixKind) {
                candidates.push({
                    kind: prefixKind,
                    evidence: { level: 'signature', ruleId: `legacy.prefix.${prefixKind}` }
                });
            } else if (text.includes('<skills>') || text.includes('<agents>')) {
                candidates.push({
                    kind: 'main-agent',
                    evidence: { level: 'heuristic', ruleId: 'legacy.agent-markers' }
                });
            }
        }

        const userKind =
            TERMINAL_NOTIFICATION_PATTERN.test(features.latestUserText) ? 'terminal-steering'
            : isConversationCompactionPromptText(features.latestUserText) ? 'summarization'
            : undefined;
        if (userKind) {
            // 旧压缩/通知覆盖主身份前缀，但不掩盖其他辅助任务的冲突。
            for (let i = candidates.length - 1; i >= 0; i--) {
                if (candidates[i].kind === 'main-agent') {
                    candidates.splice(i, 1);
                }
            }
            candidates.push({ kind: userKind, evidence: { level: 'signature', ruleId: `legacy.user.${userKind}` } });
        }
        if (features.toolNames.length === 1) {
            const toolKind =
                features.toolNames[0] === 'manage_todo_list' ? 'todo-tracker'
                : features.toolNames[0] === 'categorize_prompt' ? 'prompt-categorizer'
                : undefined;
            if (toolKind) {
                candidates.push({
                    kind: toolKind,
                    evidence: { level: 'heuristic', ruleId: `legacy.single-tool.${toolKind}` }
                });
            }
        }
        const signatures = candidates.filter(candidate => hasStrongEvidence(candidate.evidence));
        const best = signatures.length > 0 ? signatures : candidates;
        if (new Set(best.map(candidate => candidate.kind)).size > 1) {
            return createClassification(requestOrigin, origin, 'unclassified', {
                level: 'unknown',
                reasonCode: 'classification-conflict'
            });
        }
        return createClassification(
            requestOrigin,
            origin,
            best[0]?.kind ?? (features.hasContent ? 'unclassified' : 'unknown'),
            best[0]?.evidence
        );
    } catch {
        return createClassification(requestOrigin, origin, 'unclassified', {
            level: 'unknown',
            reasonCode: 'classification-failed'
        });
    }
}

export function getSdkSessionContextKey(
    messages: readonly vscode.LanguageModelChatMessage[],
    classification: RequestClassification,
    requestInitiator?: string
): string | undefined {
    if (
        (requestInitiator && requestInitiator !== 'core' && requestInitiator !== 'github.copilot-chat') ||
        classification.requestOrigin !== 'copilot-sdk' ||
        !hasStrongEvidence(classification.evidence.origin) ||
        !(
            (classification.requestKind === 'main-agent' && classification.agentRole === 'main') ||
            (classification.requestKind === 'summarization' &&
                classification.evidence.purpose.ruleId === 'sdk.ad270aa.compaction-candidate' &&
                classification.evidence.purpose.reasonCode === 'sdk-compaction-unconfirmed')
        )
    ) {
        return undefined;
    }
    const features = extractRequestFeatures(messages);
    if (features.failure) {
        return undefined;
    }
    const keys = features.systemTexts
        .filter(text => text.startsWith(SDK_IDENTITY) || getSdkSystemPurposes(text).includes('main-agent'))
        .map(getSdkSessionContextHash);
    return keys.length > 0 && keys.every(key => key === keys[0]) ? keys[0] : undefined;
}

export function classifyRequest(
    messages: readonly vscode.LanguageModelChatMessage[],
    tools?: readonly vscode.LanguageModelChatTool[]
): RequestKind {
    return classifyRequestContext(messages, { tools }).requestKind;
}

export function getRequestBehavior(classification: RequestClassification): RequestBehavior {
    const verifiedLegacy =
        classification.requestOrigin === 'copilot-chat' &&
        hasStrongEvidence(classification.evidence.origin) &&
        hasStrongEvidence(classification.evidence.purpose) &&
        hasStrongEvidence(classification.evidence.role);
    const auxiliary = verifiedLegacy && classification.agentRole === 'not-applicable';
    return {
        canRegisterUserInput:
            verifiedLegacy && classification.agentRole === 'main' && classification.requestKind === 'main-agent',
        canObserveSummary: auxiliary && classification.requestKind === 'summarization',
        canObserveTitle: auxiliary && classification.requestKind === 'chat-title',
        canUseLegacyRecovery: verifiedLegacy && classification.agentRole !== 'undetermined'
    };
}

export function getRecommendedReasoningEffort(
    kind: RequestKind,
    configuredEffort: string | undefined,
    metadata?: RequestClassificationMetadata
): string | undefined {
    if (shouldDisableThinkingForRequest(kind, metadata)) {
        return 'none';
    }
    return configuredEffort;
}
