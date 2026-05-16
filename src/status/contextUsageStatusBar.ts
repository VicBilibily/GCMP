/*---------------------------------------------------------------------------------------------
 *  模型上下文窗口占用情况状态栏
 *  显示最近一次请求的模型上下文窗口占用情况
 *  独立实现，不使用缓存机制
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { StatusLogger } from '../utils/statusLogger';
import { t } from '../utils/l10n';

/**
 * 提示词部分的 token 占用详情
 */
export interface PromptPartTokens {
    /** 系统提示词 token 数 */
    systemPrompt?: number;
    /** 可用工具描述 token 数 */
    availableTools?: number;
    /** 环境信息 token 数 (environment_info 和 workspace_info) */
    environment?: number;
    /** 用户助手消息 token 数 (user + assistant + tool roles 合并) */
    userAssistantMessage?: number;
    /** 历史消息 token 数 (本轮对话之前的所有消息) */
    historyMessages?: number;
    /** 本轮消息 token 数 (从最后一个 user text 消息开始的所有消息) */
    currentRoundMessages?: number;
    /** 本轮图片 token 数 (仅统计本轮消息中的图片 DataPart) */
    currentRoundImages?: number;
    /** 思考过程 token 数 (thinking 内容) */
    thinking?: number;
    /** 自动压缩部分 token 数 */
    autoCompressed?: number;
    /** 上下文内容 token 数 (总和) */
    context?: number;
}

/**
 * 模型上下文窗口占用情况数据接口
 */
export interface ContextUsageData {
    /** 模型 ID */
    modelId: string;
    /** 模型名称 */
    modelName: string;
    /** 输入 token 数量 */
    inputTokens: number;
    /** 最大输入 token 数量 */
    maxInputTokens: number;
    /** 占用百分比 */
    percentage: number;
    /** 请求时间戳 */
    timestamp: number;
    /** 提示词各部分的 token 占用细节 */
    promptParts?: PromptPartTokens;
    /** 剩余可用 token 数 */
    remainingTokens?: number;
}

/**
 * 模型上下文窗口占用情况状态栏
 * 独立实现，不依赖缓存机制
 * 只在请求时通过 updateContextUsage 直接更新状态
 */
export class ContextUsageStatusBar {
    // 静态实例，用于全局访问
    private static instance: ContextUsageStatusBar | undefined;

    // 状态栏项
    private statusBarItem: vscode.StatusBarItem | undefined;

    // 默认数据，显示 0%
    private readonly defaultData: ContextUsageData = {
        modelId: '',
        modelName: t('No requests yet', '暂无请求'),
        inputTokens: 0,
        maxInputTokens: 0,
        percentage: 0,
        timestamp: 0
    };

    constructor() {
        // 保存实例引用
        ContextUsageStatusBar.instance = this;
    }

    /**
     * 获取全局实例
     */
    static getInstance(): ContextUsageStatusBar | undefined {
        return ContextUsageStatusBar.instance;
    }

    /**
     * 初始化状态栏
     */
    async initialize(context: vscode.ExtensionContext): Promise<void> {
        this.statusBarItem = vscode.window.createStatusBarItem(
            'gcmp.statusBar.contextUsage',
            vscode.StatusBarAlignment.Right,
            12
        );

        this.statusBarItem.name = 'GCMP: Context Usage';

        // 初始显示
        this.updateUI(this.defaultData);
        this.statusBarItem.show();

        context.subscriptions.push(this.statusBarItem);
        StatusLogger.debug('[Model Context Window Usage StatusBar] Initialization complete');
    }

    /**
     * 更新上下文占用数据（外部调用）
     */
    updateContextUsage(data: ContextUsageData): void {
        StatusLogger.debug(
            `[Model Context Window Usage StatusBar] Updating context usage data: ${data.inputTokens}/${data.maxInputTokens}`
        );

        // 直接更新 UI（无缓存）
        this.updateUI(data);

        // 确保状态栏可见
        if (this.statusBarItem) {
            this.statusBarItem.show();
        }
    }

    /**
     * 更新状态栏 UI
     */
    private updateUI(data: ContextUsageData): void {
        if (!this.statusBarItem) {
            return;
        }

        // 更新文本
        this.statusBarItem.text = this.getDisplayText(data);

        // 更新 Tooltip
        this.statusBarItem.tooltip = this.generateTooltip(data);
    }

    /**
     * 根据百分比获取图标
     */
    private getPieChartIcon(percentage: number): string {
        if (percentage === 0) {
            return '$(gcmp-tokens)'; // 0%
        } else if (percentage <= 25) {
            return '$(gcmp-token1)'; // 1/8
        } else if (percentage <= 35) {
            return '$(gcmp-token2)'; // 2/8
        } else if (percentage <= 45) {
            return '$(gcmp-token3)'; // 3/8
        } else if (percentage <= 55) {
            return '$(gcmp-token4)'; // 4/8
        } else if (percentage <= 65) {
            return '$(gcmp-token5)'; // 5/8
        } else if (percentage <= 75) {
            return '$(gcmp-token6)'; // 6/8
        } else if (percentage <= 85) {
            return '$(gcmp-token7)'; // 7/8
        } else {
            return '$(gcmp-token8)'; // 8/8 (满)
        }
    }

    /**
     * 格式化 token 数量为易读的格式（如 2K、96K）
     */
    private formatTokens(tokens: number): string {
        if (tokens >= 1000000) {
            return (tokens / 1000000).toFixed(1) + 'M';
        } else if (tokens >= 1000) {
            return (tokens / 1000).toFixed(1) + 'K';
        } else {
            return tokens.toString();
        }
    }

    /**
     * 获取显示文本
     */
    protected getDisplayText(data: ContextUsageData): string {
        // const percentage = data.percentage.toFixed(1);
        const icon = this.getPieChartIcon(data.percentage);
        // return data.percentage === 0 ? icon : `${icon} ${percentage}%`;
        return icon;
    }

    /**
     * 生成 Tooltip 内容
     */
    private generateTooltip(data: ContextUsageData): vscode.MarkdownString {
        const md = new vscode.MarkdownString();
        md.supportHtml = true;

        md.appendMarkdown(`#### ${t('Model Context Window Usage', '模型上下文窗口占用情况')}\n\n`);

        // 如果是默认数据（无请求），显示提示信息
        if (data.inputTokens === 0 && data.maxInputTokens === 0) {
            md.appendMarkdown(
                `💡 ${t('Shown after any GCMP model request is sent.', '发送任意 GCMP 提供的模型请求后显示')}\n`
            );
            return md;
        }

        md.appendMarkdown('\n---\n');
        md.appendMarkdown('|        |          |\n');
        md.appendMarkdown('| ------ | :------- |\n');

        const requestTime = new Date(data.timestamp);
        const requestTimeStr = requestTime.toLocaleString(
            vscode.env.language.toLowerCase().startsWith('zh') ? 'zh-CN' : 'en-US'
        );
        md.appendMarkdown(`| **${t('Request Time', '请求时间')}** | ${requestTimeStr} |\n`);
        md.appendMarkdown(`| **${t('Model Name', '模型名称')}** | ${data.modelName} |\n`);
        const usageString = `${this.formatTokens(data.inputTokens)}/${this.formatTokens(data.maxInputTokens)}`;
        md.appendMarkdown(`| **${t('Usage', '占用情况')}** | **${data.percentage.toFixed(1)}%** \t ${usageString} |\n`);

        if (data.promptParts) {
            md.appendMarkdown('\n---\n');
            const parts = data.promptParts;
            const totalTokens = data.inputTokens;

            // 表头行（显示窗口信息，三列格式）
            md.appendMarkdown('|          |          |          |\n');
            md.appendMarkdown('| :------- | -------: | -------: |\n');

            // 1. 系统提示词
            if (parts.systemPrompt !== undefined && parts.systemPrompt > 0) {
                const percent = totalTokens > 0 ? ((parts.systemPrompt / totalTokens) * 100).toFixed(1) : '0';
                md.appendMarkdown(
                    `| **${t('System Prompt', '系统提示')}** | ${percent}% | ${this.formatTokens(parts.systemPrompt)} |\n`
                );
            }
            // 2. 可用的工具
            if (parts.availableTools !== undefined && parts.availableTools > 0) {
                const percent = totalTokens > 0 ? ((parts.availableTools / totalTokens) * 100).toFixed(1) : '0';
                md.appendMarkdown(
                    `| **${t('Available Tools', '可用工具')}** | ${percent}% | ${this.formatTokens(parts.availableTools)} |\n`
                );
            }
            // 3. 环境信息
            if (parts.environment !== undefined && parts.environment > 0) {
                const percent = totalTokens > 0 ? ((parts.environment / totalTokens) * 100).toFixed(1) : '0';
                md.appendMarkdown(
                    `| **${t('Environment Info', '环境信息')}** | ${percent}% | ${this.formatTokens(parts.environment)} |\n`
                );
            }
            // 4. 压缩的消息
            if (parts.autoCompressed !== undefined && parts.autoCompressed > 0) {
                const percent = totalTokens > 0 ? ((parts.autoCompressed / totalTokens) * 100).toFixed(1) : '0';
                md.appendMarkdown(
                    `| **${t('Compressed Messages', '压缩消息')}** | ${percent}% | ${this.formatTokens(parts.autoCompressed)} |\n`
                );
            }
            // 5. 历史消息
            if (parts.historyMessages !== undefined && parts.historyMessages > 0) {
                const percent = totalTokens > 0 ? ((parts.historyMessages / totalTokens) * 100).toFixed(1) : '0';
                md.appendMarkdown(
                    `| **${t('History Messages', '历史消息')}** | ${percent}% | ${this.formatTokens(parts.historyMessages)} |\n`
                );
            }
            // 6. 思考内容
            if (parts.thinking !== undefined && parts.thinking > 0) {
                const percent = totalTokens > 0 ? ((parts.thinking / totalTokens) * 100).toFixed(1) : '0';
                md.appendMarkdown(
                    `| **${t('Thinking', '思考内容')}** | ${percent}% | ${this.formatTokens(parts.thinking)} |\n`
                );
            }
            // 7. 本轮图片附件
            if (parts.currentRoundImages !== undefined && parts.currentRoundImages > 0) {
                const currentRoundImages = parts.currentRoundImages;
                const percent = totalTokens > 0 ? ((currentRoundImages / totalTokens) * 100).toFixed(1) : '0';
                md.appendMarkdown(
                    `| **${t('Current Round Images', '本轮图片')}** | ${percent}% | ${this.formatTokens(currentRoundImages)} |\n`
                );
            }
            // 8. 本轮会话消息
            if (parts.currentRoundMessages !== undefined && parts.currentRoundMessages > 0) {
                const currentRoundMessages = parts.currentRoundMessages;
                const percent = totalTokens > 0 ? ((currentRoundMessages / totalTokens) * 100).toFixed(1) : '0';
                md.appendMarkdown(
                    `| **${t('Current Round Messages', '本轮消息')}** | ${percent}% | ${this.formatTokens(currentRoundMessages)} |\n`
                );
            }
            md.appendMarkdown('\n');
        }

        md.appendMarkdown('\n---\n');
        md.appendMarkdown(
            `💡 ${t('This shows the estimate from the most recent request.', '此数据显示最近一次请求的预估值')}\n`
        );

        return md;
    }

    /**
     * 检查并显示状态
     * Token 占用状态栏总是显示
     */
    async checkAndShowStatus(): Promise<void> {
        if (this.statusBarItem) {
            this.statusBarItem.show();
        }
    }

    /**
     * 根据各部分 token 占用来更新状态
     * @param modelName 模型名称
     * @param maxInputTokens 最大输入 token 数
     * @param promptParts 提示词各部分的 token 占用
     */
    updateWithPromptParts(modelName: string, maxInputTokens: number, promptParts: PromptPartTokens): void {
        // 使用 context 作为总 token 占用（已包含所有部分）
        const inputTokens = promptParts.context || 0;
        const remainingTokens = maxInputTokens - inputTokens;
        const percentage = (inputTokens / maxInputTokens) * 100;
        const data: ContextUsageData = {
            modelId: modelName,
            modelName,
            inputTokens,
            maxInputTokens,
            percentage,
            timestamp: Date.now(),
            promptParts,
            remainingTokens
        };
        this.updateContextUsage(data);
    }

    /**
     * 延迟更新（不使用，上下文占用由外部驱动）
     */
    delayedUpdate(_delayMs?: number): void {
        // 上下文占用状态栏不需要定时更新
        // 数据通过 updateContextUsage() 外部驱动
    }

    /**
     * 销毁状态栏
     */
    dispose(): void {
        this.statusBarItem?.dispose();
        StatusLogger.debug('[Model Context Window Usage StatusBar] Disposed');
    }
}
