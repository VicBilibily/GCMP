/*---------------------------------------------------------------------------------------------
 *  模型上下文窗口占用情况状态栏
 *  显示最近一次请求的模型上下文窗口占用情况
 *  独立实现，不使用缓存机制
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { StatusLogger } from '../utils/statusLogger';

/**
 * 模型上下文窗口占用情况数据接口
 */
export interface TokenUsageData {
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
}

/**
 * 模型上下文窗口占用情况状态栏
 * 独立实现，不依赖缓存机制
 * 只在请求时通过 updateTokenUsage 直接更新状态
 */
export class TokenUsageStatusBar {
    // 静态实例，用于全局访问
    private static instance: TokenUsageStatusBar | undefined;

    // 状态栏项
    private statusBarItem: vscode.StatusBarItem | undefined;

    // 当前状态数据
    private currentData: TokenUsageData | undefined;

    // 默认数据，显示 0%
    private readonly defaultData: TokenUsageData = {
        modelId: '',
        modelName: '暂无请求',
        inputTokens: 0,
        maxInputTokens: 0,
        percentage: 0,
        timestamp: 0
    };

    constructor() {
        // 保存实例引用
        TokenUsageStatusBar.instance = this;
    }

    /**
     * 获取全局实例
     */
    static getInstance(): TokenUsageStatusBar | undefined {
        return TokenUsageStatusBar.instance;
    }

    /**
     * 初始化状态栏
     */
    async initialize(context: vscode.ExtensionContext): Promise<void> {
        this.statusBarItem = vscode.window.createStatusBarItem(
            'gcmp.statusBar.tokenUsage',
            vscode.StatusBarAlignment.Right,
            11
        );

        this.statusBarItem.name = 'GCMP: 模型上下文窗口占用情况';

        // 初始显示
        this.updateUI(this.defaultData);
        this.statusBarItem.show();

        context.subscriptions.push(this.statusBarItem);
        StatusLogger.debug('[模型上下文窗口占用状态栏] 初始化完成');
    }

    /**
     * 更新 token 使用数据（外部调用）
     */
    updateTokenUsage(data: TokenUsageData): void {
        StatusLogger.debug(
            `[模型上下文窗口占用状态栏] 更新 token 使用数据: ${data.inputTokens}/${data.maxInputTokens}`
        );

        // 保存当前数据
        this.currentData = data;

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
    private updateUI(data: TokenUsageData): void {
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
    protected getDisplayText(data: TokenUsageData): string {
        // const percentage = data.percentage.toFixed(1);
        const icon = this.getPieChartIcon(data.percentage);
        // return data.percentage === 0 ? icon : `${icon} ${percentage}%`;
        return icon;
    }

    /**
     * 生成 Tooltip 内容
     */
    private generateTooltip(data: TokenUsageData): vscode.MarkdownString {
        const md = new vscode.MarkdownString();
        md.supportHtml = true;

        md.appendMarkdown('#### 模型上下文窗口占用情况\n\n');

        // 如果是默认数据（无请求），显示提示信息
        if (data.inputTokens === 0 && data.maxInputTokens === 0) {
            md.appendMarkdown('💡 发送任意 GCMP 提供的模型请求后显示\n');
            return md;
        }

        md.appendMarkdown('|  项目  | 值 |\n');
        md.appendMarkdown('| :----: | :---- |\n');
        md.appendMarkdown(`| **模型名称** | ${data.modelName} |\n`);

        const usageString = `${this.formatTokens(data.inputTokens)}/${this.formatTokens(data.maxInputTokens)}`;
        md.appendMarkdown(`| **占用情况** | **${data.percentage.toFixed(1)}%** ${usageString} |\n`);

        const requestTime = new Date(data.timestamp);
        const requestTimeStr = requestTime.toLocaleString('zh-CN');
        md.appendMarkdown(`| **请求时间** | ${requestTimeStr} |\n`);

        md.appendMarkdown('\n---\n');
        md.appendMarkdown('💡 此数据显示最近一次请求的上下文占用情况\n');

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
     * 延迟更新（不使用，Token 占用由外部驱动）
     */
    delayedUpdate(_delayMs?: number): void {
        // Token 占用状态栏不需要定时更新
        // 数据通过 updateTokenUsage() 外部驱动
    }

    /**
     * 销毁状态栏
     */
    dispose(): void {
        this.statusBarItem?.dispose();
        StatusLogger.debug('[模型上下文窗口占用状态栏] 已销毁');
    }
}
