/*---------------------------------------------------------------------------------------------
 *  请求来源显示名称映射
 *  集中维护 RequestKind → [英文, 中文] 的映射，供扩展进程和 WebView 复用。
 *  本文件仅包含纯数据与类型，不依赖 vscode 等运行时模块，可被 WebView bundle 安全引入。
 *--------------------------------------------------------------------------------------------*/

/**
 * 请求来源显示名称映射（[英文, 中文]）
 */
export const REQUEST_KIND_DISPLAY_NAMES: Record<string, [string, string]> = {
    'main-agent': ['Agent Chat', 'Agent 对话'],
    'terminal-steering': ['Terminal Steering', '终端引导'],
    'terminal-command': ['Terminal Command', '终端命令'],
    'terminal-quickfix': ['Terminal Quick Fix', '终端修复'],
    'terminal-explain': ['Terminal Explain', '终端解释'],
    'explain-code': ['Explain Code', '代码解释'],
    'workspace-search': ['Workspace Search', '搜索助手'],
    'code-search': ['Code Search', '代码搜索'],
    'vscode-qa': ['VS Code Q&A', 'VS Code 问答'],
    'search-subagent': ['Search Subagent', '搜索子代理'],
    'execution-subagent': ['Execution Subagent', '执行子代理'],
    'todo-tracker': ['Todo Tracker', '待办跟踪'],
    'prompt-categorizer': ['Prompt Categorizer', 'Prompt 分类'],
    'intent-detector': ['Intent Detector', '意图检测'],
    'settings-resolver': ['Settings Resolver', '设置解析'],
    'chat-title': ['Chat Title', '会话标题'],
    'inline-progress-message': ['Progress Message', '进度消息'],
    'git-branch-name': ['Branch Naming', '分支命名'],
    'git-commit-message': ['Commit Message', '提交消息'],
    'pr-description': ['PR Description', 'PR 描述'],
    'rename-suggestions': ['Rename Suggestions', '重命名建议'],
    summarization: ['Summarization', '对话摘要'],
    'code-mapper': ['Code Mapper', '代码映射'],
    'feedback-gen': ['Feedback', '代码反馈'],
    'debug-config': ['Debug Config', '调试配置'],
    'workspace-gen': ['Workspace Gen', '文件生成'],
    'test-gen': ['Test Gen', '测试生成'],
    'goal-summary': ['Goal Summary', '目标摘要'],
    'risk-assessment': ['Risk Assessment', '风险评估'],
    'patch-healer': ['Patch Healer', '补丁修复'],
    'notebook-gen': ['Notebook Gen', 'Notebook 生成'],
    'mcp-setup': ['MCP Setup', 'MCP 配置'],
    'tool-clustering': ['Tool Clustering', '工具聚类'],
    'ai-evaluator': ['AI Evaluator', 'AI 评估'],
    'vision-recognition': ['Vision Recognition', '视觉识别'],
    background: ['Background Request', '后台请求'],
    unknown: ['Unknown', '未知']
};
