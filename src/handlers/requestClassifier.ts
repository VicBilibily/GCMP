/*---------------------------------------------------------------------------------------------
 *  RequestKind 分类器
 *  通过分析系统提示词前缀和工具列表判断 Copilot 请求类型
 *  用于控制思考模式开关、工具流处理、日志记录等行为
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';

/**
 * Copilot Chat 请求类型
 */
export type RequestKind =
    | 'main-agent' // 主 Agent 对话（用户发起）
    | 'terminal-steering' // 终端通知驱动的指引
    | 'todo-tracker' // 待办列表跟踪
    | 'prompt-categorizer' // Prompt 分类
    | 'settings-resolver' // 设置解析
    | 'chat-title' // 会话标题生成
    | 'inline-progress-message' // 内联进度消息
    | 'git-branch-name' // Git 分支名建议
    | 'git-commit-message' // Git 提交消息生成
    | 'rename-suggestions' // 重命名建议
    | 'background' // 后台/工具请求（有内容但无法识别具体类型）
    | 'unknown'; // 无法识别（空请求）

/** 无需深度推理的子请求——可强制关闭思考模式 */
const SUB_REQUEST_TYPES = new Set<RequestKind>([
    'todo-tracker',
    'prompt-categorizer',
    'settings-resolver',
    'chat-title',
    'inline-progress-message',
    'git-branch-name',
    'git-commit-message',
    'rename-suggestions'
]);

/** 系统提示词前缀 → RequestKind 映射 */
const SYSTEM_PROMPT_PREFIXES: [string, RequestKind][] = [
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
    ['You are an expert AI programming assistant', 'main-agent']
];

/**
 * 判断是否为无需深度推理的子请求
 */
export function isSubRequest(kind: RequestKind): boolean {
    return SUB_REQUEST_TYPES.has(kind);
}

/**
 * 请求来源的友好显示名称映射（[英文, 中文]）
 */
export const REQUEST_KIND_DISPLAY_NAMES: Record<RequestKind, [string, string]> = {
    'main-agent': ['Agent Chat', 'Agent 对话'],
    'terminal-steering': ['Terminal Steering', '终端引导'],
    'todo-tracker': ['Todo Tracker', '待办跟踪'],
    'prompt-categorizer': ['Prompt Categorizer', 'Prompt 分类'],
    'settings-resolver': ['Settings Resolver', '设置解析'],
    'chat-title': ['Chat Title', '会话标题'],
    'inline-progress-message': ['Progress Message', '进度消息'],
    'git-branch-name': ['Branch Naming', '分支命名'],
    'git-commit-message': ['Commit Message', '提交消息'],
    'rename-suggestions': ['Rename Suggestions', '重命名建议'],
    background: ['Background Request', '后台请求'],
    unknown: ['Unknown', '未知']
};

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
 * @param isCommit 是否为插件自身的提交消息生成请求（由 modelOptions.commit 标识）
 */
export function classifyRequest(
    messages: readonly vscode.LanguageModelChatMessage[],
    tools?: readonly vscode.LanguageModelChatTool[],
    isCommit?: boolean
): RequestKind {
    const firstText = getFirstMessageText(messages).trimStart();
    const latestUserText = getLatestUserText(messages).trimStart();
    const toolNames = tools?.map(t => t.name) ?? [];

    // 0. 插件自身的提交消息生成 → 直接定向
    if (isCommit) {
        return 'git-commit-message';
    }

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
 */
function getFirstMessageText(messages: readonly vscode.LanguageModelChatMessage[]): string {
    if (messages.length === 0) {
        return '';
    }
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
