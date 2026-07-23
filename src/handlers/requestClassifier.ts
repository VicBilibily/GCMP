/*---------------------------------------------------------------------------------------------
 *  RequestKind 分类器
 *  通过分析系统提示词前缀和工具列表判断 Copilot 请求类型
 *  用于控制思考模式开关、工具流处理、日志记录等行为
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { REQUEST_KIND_DISPLAY_NAMES } from './requestKindDisplayNames';

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
    | 'background' // 后台/工具请求（有内容但无法识别具体类型）
    | 'unknown'; // 无法识别（空请求）

/** 无需深度推理的子请求——可强制关闭思考模式 */
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

/**
 * 判断是否为无需深度推理的子请求
 */
export function isSubRequest(kind: RequestKind): boolean {
    return SUB_REQUEST_TYPES.has(kind);
}

/**
 * 获取请求来源的友好显示名称（自动按语言切换中英文）
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

/** 终端通知正则：匹配 [Terminal <sessionId> notification: ...] */
const TERMINAL_NOTIFICATION_PATTERN = /^\[Terminal\s+\S+\s+notification:/;

/**
 * 从 VS Code Provider API 格式的消息中分类请求
 * @param messages 聊天消息
 * @param tools 可用的工具列表
 */
export function classifyRequest(
    messages: readonly vscode.LanguageModelChatMessage[],
    tools?: readonly vscode.LanguageModelChatTool[]
): RequestKind {
    const firstText = getFirstMessageText(messages).trimStart();
    const latestUserText = getLatestUserText(messages).trimStart();
    const toolNames = tools?.map(t => t.name) ?? [];

    // 1. 终端通知 → 最高优先级（检查最新用户消息）
    if (TERMINAL_NOTIFICATION_PATTERN.test(latestUserText)) {
        return 'terminal-steering';
    }

    // 2. 工具名唯一匹配 → 精确识别子请求
    if (toolNames.length === 1 && toolNames[0] === 'manage_todo_list') {
        return 'todo-tracker';
    }
    if (toolNames.length === 1 && toolNames[0] === 'categorize_prompt') {
        return 'prompt-categorizer';
    }

    // 3. 系统提示前缀匹配
    for (const [prefix, kind] of SYSTEM_PROMPT_PREFIXES) {
        if (firstText.startsWith(prefix)) {
            return kind;
        }
    }

    // 4. 主 Agent 标记兜底
    if (firstText.includes('<skills>') || firstText.includes('<agents>')) {
        return 'main-agent';
    }

    // 5. 兜底
    if (toolNames.length > 0 || firstText.length > 0) {
        return 'background';
    }
    return 'unknown';
}

/**
 * 根据请求类型返回建议的 reasoningEffort 覆盖值
 * 子请求强制 none，主请求返回 undefined（让用户配置生效）
 */
export function getRecommendedReasoningEffort(
    kind: RequestKind,
    configuredEffort: string | undefined
): string | undefined {
    if (isSubRequest(kind)) {
        return 'none'; // 子请求强制关闭思考
    }
    return configuredEffort; // 主请求使用用户配置
}

/**
 * 获取首条消息的纯文本内容
 * 先查找系统消息（role === 0），找不到再回退到 messages[0]
 */
function getFirstMessageText(messages: readonly vscode.LanguageModelChatMessage[]): string {
    if (messages.length === 0) {
        return '';
    }
    // 优先找第一条系统消息
    const systemMsg = messages.find(m => m.role === vscode.LanguageModelChatMessageRole.System);
    if (systemMsg) {
        return extractText(systemMsg);
    }
    // 回退到 messages[0]
    return extractText(messages[0]);
}

/**
 * 获取最新一条用户消息的纯文本内容
 */
function getLatestUserText(messages: readonly vscode.LanguageModelChatMessage[]): string {
    for (let i = messages.length - 1; i >= 0; i--) {
        if (messages[i].role === vscode.LanguageModelChatMessageRole.User) {
            return extractText(messages[i]);
        }
    }
    return '';
}

/**
 * 提取消息中的所有文本内容
 */
function extractText(message: vscode.LanguageModelChatMessage): string {
    let text = '';
    for (const part of message.content) {
        if (part instanceof vscode.LanguageModelTextPart) {
            text += part.value;
        }
    }
    return text;
}
