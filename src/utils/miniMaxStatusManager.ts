/*---------------------------------------------------------------------------------------------
 *  MiniMax Coding Plan 状态栏管理器
 *  在 VS Code 状态栏显示 MiniMax Coding Plan 使用量信息
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { StatusLogger } from './statusLogger';
import { MiniMaxRemainQuery, ModelRemainItem } from './minimaxRemainQuery';
import { ApiKeyManager } from './apiKeyManager';

/**
 * MiniMax 状态栏管理器
 *
 * 功能特性：
 * - 在 VS Code 状态栏显示 MiniMax Coding Plan 使用量信息
 * - 支持多模型用量展示，显示可用/总量和已使用百分比
 * - 防抖机制：API 请求后延时更新，避免频繁调用
 * - 动态显示：仅在设置了 Coding Plan 密钥时显示状态栏
 *
 * 初始化：在 MiniMaxProvider.createAndActivate() 中调用 initialize()
 *
 * 刷新机制：
 * 1. 手动刷新：点击状态栏或执行命令
 * 2. 延时刷新：API 请求后 2 秒执行，带 30 秒防抖
 */
export class MiniMaxStatusManager {
    private static statusBarItem: vscode.StatusBarItem | undefined;
    private static lastMaxPercentage = 0; // 存储上一次的最大使用量百分比
    private static updateDebouncer: NodeJS.Timeout | undefined; // 防抖定时器
    private static lastDelayedUpdateTime = 0; // 上次延时更新时间
    private static readonly MIN_DELAYED_UPDATE_INTERVAL = 30000; // 最小延时更新间隔 30 秒
    private static context: vscode.ExtensionContext | undefined; // 存储扩展上下文
    private static isLoading = false; // 加载状态标志
    private static cacheUpdateTimer: NodeJS.Timeout | undefined; // 缓存定时器
    private static readonly CACHE_UPDATE_INTERVAL = 10000; // 缓存加载间隔 10 秒

    private static lastStatusData: {
        formatted: ModelRemainItem[];
        maxUsageModel: ModelRemainItem;
        timestamp: number;
    } | null = null; // 存储完整的用量数据

    /**
     * 初始化状态栏项
     */
    static async initialize(context: vscode.ExtensionContext) {
        // 保存扩展上下文
        this.context = context;

        // 1. 创建 StatusBarItem（始终创建，以便后续可以动态显示/隐藏）
        this.statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
        this.statusBarItem.name = 'MiniMax Usage';
        this.statusBarItem.text = '$(gcmp-minimax)';
        this.statusBarItem.command = 'gcmp.refreshMiniMaxUsage';

        // 检查是否设置了 Coding Plan key，决定是否显示
        const hasCodingKey = await ApiKeyManager.hasValidApiKey('minimax-coding');
        if (hasCodingKey) {
            this.statusBarItem.show();
        } else {
            StatusLogger.trace('[MiniMax状态栏] 未设置 Coding Plan key，隐藏 MiniMax 状态栏');
        }

        // 注册刷新命令
        context.subscriptions.push(
            vscode.commands.registerCommand('gcmp.refreshMiniMaxUsage', () => {
                if (!this.isLoading) {
                    this.performRefresh();
                }
            })
        );

        // 初始更新
        this.performInitialUpdate();

        // 启动缓存定时器，每10秒更新一次
        this.startCacheUpdateTimer();

        // 注册清理逻辑
        context.subscriptions.push({
            dispose: () => {
                if (this.updateDebouncer) {
                    clearTimeout(this.updateDebouncer);
                    this.updateDebouncer = undefined;
                }
                if (this.cacheUpdateTimer) {
                    clearInterval(this.cacheUpdateTimer);
                    this.cacheUpdateTimer = undefined;
                }
                this.statusBarItem?.dispose();
                this.statusBarItem = undefined;
            }
        });
    }

    /**
     * 检查并显示状态栏（在设置 Coding Plan ApiKey 后调用）
     */
    static async checkAndShowStatus() {
        if (this.statusBarItem) {
            const hasCodingKey = await ApiKeyManager.hasValidApiKey('minimax-coding');
            if (hasCodingKey) {
                this.statusBarItem.show();
                this.performInitialUpdate();
            } else {
                this.statusBarItem.hide();
            }
        }
    }

    /**
     * 延时更新状态栏（在 API 请求后调用）
     * 包含防抖机制，避免频繁请求
     */
    static delayedUpdate(delayMs = 2000) {
        // 清除之前的防抖定时器
        if (this.updateDebouncer) {
            clearTimeout(this.updateDebouncer);
        }

        const now = Date.now();
        const timeSinceLastUpdate = now - this.lastDelayedUpdateTime;

        // 如果距离上次更新不足 30 秒，则等到满 30 秒再执行
        // 否则使用默认的延时时间
        const finalDelayMs =
            timeSinceLastUpdate < this.MIN_DELAYED_UPDATE_INTERVAL
                ? this.MIN_DELAYED_UPDATE_INTERVAL - timeSinceLastUpdate
                : delayMs;

        StatusLogger.debug(`[MiniMax状态栏] 设置延时更新，将在 ${finalDelayMs / 1000} 秒后执行`);

        // 设置新的防抖定时器
        this.updateDebouncer = setTimeout(async () => {
            try {
                StatusLogger.debug('[MiniMax状态栏] 执行延时更新');
                this.lastDelayedUpdateTime = Date.now();
                await this.performInitialUpdate();
            } catch (error) {
                StatusLogger.error('[MiniMax状态栏] 延时更新失败', error);
            } finally {
                this.updateDebouncer = undefined;
            }
        }, finalDelayMs);
    }

    /**
     * 执行初始更新（背景加载）
     */
    private static async performInitialUpdate() {
        // 检查是否设置了 Coding Plan ApiKey
        const hasCodingKey = await ApiKeyManager.hasValidApiKey('minimax-coding');

        // 如果没有设置 Coding Plan ApiKey，隐藏状态栏并返回
        if (!hasCodingKey) {
            if (this.statusBarItem) {
                this.statusBarItem.hide();
            }
            return;
        }

        // 确保状态栏显示
        if (this.statusBarItem) {
            this.statusBarItem.show();
        }

        // 执行 API 查询
        await this.performApiQuery();
    }

    /**
     * 执行用户刷新（带加载状态）
     */
    private static async performRefresh() {
        this.isLoading = true;

        try {
            // 显示加载中状态，保持之前的百分比（如果有的话）
            if (this.statusBarItem) {
                this.statusBarItem.text = `$(loading~spin) ${this.lastMaxPercentage}%`;
                this.statusBarItem.backgroundColor = undefined;
                this.statusBarItem.tooltip = '加载中...';
            }

            // 检查是否设置了 Coding Plan ApiKey
            const hasCodingKey = await ApiKeyManager.hasValidApiKey('minimax-coding');

            if (!hasCodingKey) {
                if (this.statusBarItem) {
                    this.statusBarItem.hide();
                }
                return;
            }

            // 确保状态栏显示
            if (this.statusBarItem) {
                this.statusBarItem.show();
            }

            // 执行 API 查询
            await this.performApiQuery();
        } finally {
            this.isLoading = false;
        }
    }

    /**
     * 从缓存读取并更新状态信息
     */
    private static updateFromCache() {
        if (!this.context || !this.statusBarItem) {
            return;
        }

        try {
            // 从全局状态读取缓存数据
            const cachedStatusData = this.context.globalState.get<{
                formatted: ModelRemainItem[];
                maxUsageModel: ModelRemainItem;
                timestamp: number;
            }>('minimax.statusData');

            if (cachedStatusData && cachedStatusData.maxUsageModel) {
                const dataAge = Date.now() - cachedStatusData.timestamp;

                // 检查是否需要根据 remainMs 触发刷新
                if (cachedStatusData.formatted && cachedStatusData.formatted.length > 0) {
                    const minRemainMs = Math.min(...cachedStatusData.formatted.map(m => m.remainMs || 0));

                    if (minRemainMs > 0 && dataAge > minRemainMs) {
                        StatusLogger.debug(
                            `[MiniMax状态栏] 缓存时间(${(dataAge / 1000).toFixed(1)}秒)超过最短重置时间(${(minRemainMs / 1000).toFixed(1)}秒)，触发API刷新`
                        );
                        // 触发API刷新
                        this.performInitialUpdate();
                        return;
                    }
                }

                // 检查基础过期
                if (dataAge > 30000) {
                    if (dataAge < 60000) {
                        StatusLogger.debug(
                            `[MiniMax状态栏] 缓存数据已过期 (${(dataAge / 1000).toFixed(1)}秒前)，跳过更新`
                        );
                    }
                    return;
                }

                // 更新内存中的数据
                this.lastMaxPercentage = cachedStatusData.maxUsageModel.percentage;
                this.lastStatusData = cachedStatusData;

                // 更新状态栏显示
                const percentage = cachedStatusData.maxUsageModel.percentage;
                this.statusBarItem.text = `$(gcmp-minimax) ${percentage}%`;
                if (percentage >= 90) {
                    this.statusBarItem.backgroundColor = new vscode.ThemeColor('statusBarItem.warningBackground');
                } else {
                    this.statusBarItem.backgroundColor = undefined;
                }

                // 更新 Tooltip
                this.statusBarItem.tooltip = this.generateTooltip(
                    cachedStatusData.formatted,
                    cachedStatusData.maxUsageModel
                );

                StatusLogger.debug(
                    `[MiniMax状态栏] 从缓存更新状态: ${percentage}% (缓存时间: ${(dataAge / 1000).toFixed(1)}秒前)`
                );
            }
        } catch (error) {
            StatusLogger.warn('[MiniMax状态栏] 从缓存更新状态失败', error);
        }
    }

    /**
     * 启动缓存更新定时器
     */
    private static startCacheUpdateTimer() {
        if (this.cacheUpdateTimer) {
            clearInterval(this.cacheUpdateTimer);
        }

        this.cacheUpdateTimer = setInterval(() => {
            this.updateFromCache();
        }, this.CACHE_UPDATE_INTERVAL);

        StatusLogger.debug(`[MiniMax状态栏] 缓存更新定时器已启动，间隔: ${this.CACHE_UPDATE_INTERVAL}ms`);
    }

    /**
     * 生成状态栏 Tooltip 内容
     */
    private static generateTooltip(formatted: ModelRemainItem[], maxUsageModel: ModelRemainItem) {
        const md = new vscode.MarkdownString();
        md.supportHtml = true;
        md.appendMarkdown('#### Coding Plan 使用情况\n\n');
        md.appendMarkdown('| 模型 | 可用/总量 | 已使用 |\n');
        md.appendMarkdown('| :--- | ------: | ---: |\n');
        for (const info of formatted) {
            md.appendMarkdown(`| ${info.model} | ${info.usageStatus} | ${info.percentage}% |\n`);
        }
        md.appendMarkdown('\n');
        if (maxUsageModel) {
            md.appendMarkdown('---\n');
            md.appendMarkdown(`**计量周期** ${maxUsageModel.range}\n`);
            md.appendMarkdown('\n');
        }
        md.appendMarkdown('---\n');
        md.appendMarkdown('点击状态栏可手动刷新\n');
        return md;
    }

    /**
     * 执行 API 查询
     */
    private static async performApiQuery() {
        try {
            StatusLogger.debug('[MiniMax状态栏] 开始执行 MiniMax 用量查询...');

            const result = await MiniMaxRemainQuery.queryRemain();

            if (result.success && result.formatted && result.formatted.length > 0) {
                if (this.statusBarItem) {
                    // 找出使用量最大的模型的百分比
                    const maxUsageModel = result.formatted.reduce((max, current) =>
                        current.percentage > max.percentage ? current : max
                    );
                    const percentage = maxUsageModel.percentage;

                    // 更新存储的最大使用量百分比
                    this.lastMaxPercentage = percentage;

                    // 保存完整的用量数据
                    this.lastStatusData = {
                        formatted: result.formatted,
                        maxUsageModel: maxUsageModel,
                        timestamp: Date.now()
                    };

                    // 保存到全局状态
                    if (this.context) {
                        this.context.globalState.update('minimax.lastMaxPercentage', percentage);
                        this.context.globalState.update('minimax.statusData', this.lastStatusData);
                    }

                    // 更新状态栏 UI
                    this.statusBarItem.text = `$(gcmp-minimax) ${percentage}%`;
                    if (percentage >= 90) {
                        this.statusBarItem.backgroundColor = new vscode.ThemeColor('statusBarItem.warningBackground');
                    } else {
                        this.statusBarItem.backgroundColor = undefined;
                    }

                    // 更新 Tooltip
                    this.statusBarItem.tooltip = this.generateTooltip(result.formatted, maxUsageModel);

                    StatusLogger.info(`[MiniMax状态栏] MiniMax Coding Plan 用量查询成功: ${percentage}%`);
                }
            } else {
                // 错误处理
                const errorMsg = result.error || '未知错误';

                if (this.statusBarItem) {
                    this.statusBarItem.text = '$(gcmp-minimax) ERR';
                    this.statusBarItem.tooltip = `获取失败: ${errorMsg}`;
                }

                StatusLogger.warn(`[MiniMax状态栏] MiniMax Coding Plan 用量查询失败: ${errorMsg}`);
            }
        } catch (error) {
            StatusLogger.error('[MiniMax状态栏] 更新状态栏失败', error);

            if (this.statusBarItem) {
                this.statusBarItem.text = '$(gcmp-minimax) ERR';
                this.statusBarItem.tooltip = `获取失败: ${error instanceof Error ? error.message : '未知错误'}`;
            }
        }
    }
}
