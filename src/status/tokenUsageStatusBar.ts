/*---------------------------------------------------------------------------------------------
 *  Token Usage Status Bar
 *  Token 用量状态栏 - 显示今日 Token 用量
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { TokenUsagesManager } from '../usages/usagesManager';
import { StatusLogger } from '../utils/statusLogger';
import { DateUtils } from '../usages/fileLogger/dateUtils';
import { UserActivityService } from './userActivityService';
import { InterInstanceBus } from '../interInstance';
import { LeaderElectionService } from './leaderElectionService';
import type { TokenUsageStatsFromFile } from '../usages/fileLogger/types';
import type { ExtendedTokenRequestLog } from '../usages/fileLogger/usageParser';
import { t } from '../utils/l10n';
import { formatCost } from '../ui/utils';

/**
 * Token 用量状态栏
 * 显示今日 Token 用量，点击打开详细视图
 */
export class TokenUsageStatusBar {
    private statusBarItem: vscode.StatusBarItem | undefined;
    private usagesManager: TokenUsagesManager;
    private updateTimer: NodeJS.Timeout | undefined;
    private lastUpdateTime = 0;
    private readonly UPDATE_INTERVAL = 30000; // 30秒更新一次
    private readonly UPDATE_COOLDOWN = 10000; // 最近更新后10秒内不重复更新

    constructor(private context: vscode.ExtensionContext) {
        this.usagesManager = TokenUsagesManager.instance;
    }

    /**
     * 初始化状态栏
     */
    async initialize(): Promise<void> {
        this.statusBarItem = vscode.window.createStatusBarItem(
            'gcmp.statusBar.tokenUsage',
            vscode.StatusBarAlignment.Right,
            11 // 优先级设置在 contextUsage(12) 之前
        );

        this.statusBarItem.name = 'GCMP: Token Usage';
        this.statusBarItem.command = 'gcmp.tokenUsage.showDetails';
        this.statusBarItem.text = '$(layers)';
        this.statusBarItem.tooltip = t('Loading token usage...', '正在加载 Token 统计...');

        // 先立即显示占位，避免首次异步统计读取较慢时状态栏完全不出现
        this.statusBarItem.show();

        // 初始更新显示
        void this.updateDisplay();

        // 监听本实例的统计更新事件
        this.context.subscriptions.push(
            this.usagesManager.onStatsUpdate(async () => {
                await this.updateDisplay();
            })
        );

        // 监听跨实例的 Token 用量更新事件
        this.context.subscriptions.push(
            InterInstanceBus.subscribe('tokenUsageUpdated', async () => {
                await this.updateDisplay();
            })
        );

        // 监听主/子实例角色变更事件
        this.context.subscriptions.push(
            LeaderElectionService.onLeaderChanged(async () => {
                await this.updateDisplay();
            })
        );

        // 启动定时更新
        this.startPeriodicUpdate();

        this.context.subscriptions.push(this.statusBarItem);
        StatusLogger.debug('[TokenUsageStatusBar] Initialized');
    }

    /**
     * 启动定时更新
     */
    private startPeriodicUpdate(): void {
        if (this.updateTimer) {
            clearInterval(this.updateTimer);
        }

        this.updateTimer = setInterval(async () => {
            await this.periodicUpdate();
        }, this.UPDATE_INTERVAL);

        StatusLogger.debug(`[TokenUsageStatusBar] Started periodic updates (${this.UPDATE_INTERVAL}ms)`);
    }

    /**
     * 停止定时更新
     */
    private stopPeriodicUpdate(): void {
        if (this.updateTimer) {
            clearInterval(this.updateTimer);
            this.updateTimer = undefined;
            StatusLogger.debug('[TokenUsageStatusBar] Stopped periodic updates');
        }
    }

    /**
     * 周期性更新回调
     */
    private async periodicUpdate(): Promise<void> {
        // 检查用户是否活跃
        if (!UserActivityService.isUserActive()) {
            StatusLogger.trace('[TokenUsageStatusBar] User inactive. Skipping update.');
            return;
        }

        // 检查是否在冷却期内
        const now = Date.now();
        const timeSinceLastUpdate = now - this.lastUpdateTime;
        if (timeSinceLastUpdate < this.UPDATE_COOLDOWN) {
            StatusLogger.trace(
                `[TokenUsageStatusBar] Last update was ${timeSinceLastUpdate}ms ago. Waiting for the next cycle.`
            );
            return;
        }

        // 执行更新
        await this.updateDisplay();
    }

    /**
     * 更新显示
     */
    async updateDisplay(): Promise<void> {
        if (!this.statusBarItem) {
            return;
        }

        // 主实例用实心图层图标，从实例用空心图层图标
        const roleIcon = LeaderElectionService.isLeader() ? '$(layers-dot)' : '$(layers)';

        try {
            const today = DateUtils.getTodayDateString();
            const todayStats = await this.usagesManager.getDateStats(today);

            // 计算今日总 token
            let totalInputTokens = 0;
            let totalOutputTokens = 0;
            let totalRequests = 0;

            for (const stats of Object.values(todayStats.providers)) {
                totalInputTokens += stats.actualInput;
                totalOutputTokens += stats.outputTokens;
                totalRequests += stats.requests;
            }

            const totalTokens = totalInputTokens + totalOutputTokens;

            // 更新状态栏文本：角色图标 + Token 用量 + 预估成本
            const tokenPart = totalRequests === 0 ? '' : ` ${this.formatTokens(totalTokens)}`;
            const costPart =
                todayStats.total.estimatedCost > 0 ? ` ${formatCost(todayStats.total.estimatedCost, 2)}` : '';
            this.statusBarItem.text = `${roleIcon}${tokenPart}${costPart}`;

            // 更新 Tooltip (异步生成)
            this.statusBarItem.tooltip = await this.generateTooltip(todayStats);
            this.statusBarItem.show();

            // 更新最后更新时间
            this.lastUpdateTime = Date.now();
        } catch (err) {
            StatusLogger.error('[TokenUsageStatusBar] Failed to update display:', err);
            this.statusBarItem.text = `${roleIcon}`;
            this.statusBarItem.show();
        }
    }

    /**
     * 生成 Tooltip（显示今日分提供商统计 + 最近历史记录）
     */
    private async generateTooltip(stats: TokenUsageStatsFromFile): Promise<vscode.MarkdownString> {
        const md = new vscode.MarkdownString();
        md.supportHtml = true;
        md.isTrusted = true;

        const roleLabel =
            LeaderElectionService.isLeader() ? t('Primary Instance', '主实例') : t('Sub Instance', '从实例');
        md.appendMarkdown(
            `**${t("GCMP: Today's Token Usage", 'GCMP: 今日 Token 消耗统计')}** <small>${roleLabel}</small>\n\n`
        );
        md.appendMarkdown('\n---\n');

        const providers = Object.values(stats.providers);
        if (providers.length === 0) {
            md.appendMarkdown(t('No usage records yet.', '暂无使用记录。'));
            md.appendMarkdown('\n\n---\n\n');
            md.appendMarkdown(this.buildActionLinks(false));
            return md;
        }

        // ========== 今日用量摘要 ==========
        const sortedProviders = providers.sort((a, b) => {
            const totalA = a.actualInput + a.outputTokens;
            const totalB = b.actualInput + b.outputTokens;
            return totalB - totalA;
        });
        md.appendMarkdown(
            `| ${t('Provider', '提供商')} | ${t('Input(+Cache)+Output=Total', '输入(+缓存)+输出=消耗Tokens')} | ${t('Cost', '预估成本')} | ${t('Requests', '请求数')} | ${t('Latency', '平均延迟')} | ${t('Speed', '平均速度')} |\n`
        );
        md.appendMarkdown('| :------------ | ------: | ---: | ----: | ------: | ------: |\n');
        for (const providerStats of sortedProviders) {
            const consumptionPath = this.formatConsumptionPath(
                providerStats.actualInput,
                providerStats.cacheTokens,
                providerStats.outputTokens
            );
            const avgSpeed = this.calculateAverageSpeed(providerStats);
            const avgLatency = this.calculateAverageFirstTokenLatency(providerStats.firstTokenLatency);
            const costStr = formatCost(providerStats.estimatedCost, 2);
            md.appendMarkdown(
                `| ${providerStats.providerName} | ${consumptionPath} | ` +
                    `${costStr} | ` +
                    `${providerStats.requests} | ${avgLatency} | ${avgSpeed} |\n`
            );
        }
        if (providers.length > 1) {
            const totalPath = this.formatConsumptionPath(
                stats.total.actualInput,
                stats.total.cacheTokens,
                stats.total.outputTokens
            );
            const avgSpeedTotal = this.calculateAverageSpeed(stats.total);
            const avgLatencyTotal = this.calculateAverageFirstTokenLatency(stats.total.firstTokenLatency);
            const totalCostStr = formatCost(stats.total.estimatedCost, 2);
            const eqIndex = totalPath.lastIndexOf('=');
            const formulaPart = totalPath.slice(0, eqIndex + 1);
            const resultPart = totalPath.slice(eqIndex + 1);
            md.appendMarkdown(
                `| **${t('Total', '合计')}** | ${formulaPart}**${resultPart}** | ` +
                    `**${totalCostStr}** | ` +
                    `**${stats.total.requests}** | **${avgLatencyTotal}** | **${avgSpeedTotal}** |\n`
            );
        }

        // ========== 最近请求记录表格 ==========
        try {
            const recentRequests = await this.usagesManager.getRecentRecords(3); // 获取最近 3 条

            if (recentRequests.length > 0) {
                md.appendMarkdown('\n\n ---- \n\n\n\n');
                // 创建表格标题
                md.appendMarkdown(
                    `| ${t('Provider', '提供商')} | ${t('Time', '请求时间')} | ${t('Status', '状态')} | ${t('Read+Write=Input', '读取+写入=输入量')} | ${t('Output', '输出量')} | ${t('Cost', '预估成本')} | ${t('Delay', 'TTFT')} | ${t('Duration', 'TPOT')} | ${t('Speed', '输出速度')} |\n`
                );
                md.appendMarkdown(
                    '| :----------- | :-----: | :----: | -----: | -----: | ---: | -----: | -----: | -----: |\n'
                );

                // 反转数组，让最近的请求在最下方显示
                const reversedRequests = [...recentRequests].reverse();
                for (const req of reversedRequests) {
                    const startTime = new Date(req.timestamp);
                    // 确定状态图标：仅当有 rawUsage 且状态为 completed 时才显示 ✅
                    let statusIcon = '⏳'; // 默认为进行中
                    if (req.status === 'completed' && req.rawUsage) {
                        statusIcon = '✅'; // 真正完成
                    } else if (req.status === 'failed') {
                        statusIcon = '❌'; // 失败
                    } else if (req.status === 'cancelled') {
                        statusIcon = '🚫'; // 已取消
                    } else if (req.status === 'estimated') {
                        statusIcon = '⏳'; // 预估中
                    }
                    const timeStr = startTime.toLocaleTimeString('zh-CN');

                    // 直接访问扩展属性
                    const outputTokens = req.outputTokens;
                    const totalTokens = req.totalTokens;

                    // 格式化输出速度
                    const speedStr = req.outputSpeed !== undefined ? `${req.outputSpeed.toFixed(1)} t/s` : '-';

                    // 格式化延迟与耗时
                    let latencyStr = '-';
                    let durationStr = '-';
                    if (req.streamStartTime !== undefined && req.timestamp !== undefined) {
                        const latency = req.streamStartTime - req.timestamp;
                        if (Number.isFinite(latency) && latency >= 0) {
                            latencyStr =
                                latency > 100 ? `${(latency / 1000).toFixed(1)} s` : `${Math.round(latency)} ms`;
                        }
                    }
                    if (req.streamEndTime !== undefined && req.streamStartTime !== undefined) {
                        const duration = req.streamEndTime - req.streamStartTime;
                        if (Number.isFinite(duration) && duration >= 0) {
                            durationStr =
                                duration > 100 ? `${(duration / 1000).toFixed(1)} s` : `${Math.round(duration)} ms`;
                        }
                    }

                    const inputStr = this.formatRecentInputTokens(req);

                    let outputStr = '-';
                    const hasActualUsage =
                        (req.status === 'completed' || req.status === 'cancelled') && !!req.rawUsage && totalTokens > 0;
                    if (hasActualUsage && outputTokens > 0) {
                        outputStr = this.formatTokens(outputTokens);
                    }

                    const costStr = formatCost(req.estimatedCost ?? 0);

                    md.appendMarkdown(
                        `| ${req.providerName} | ${timeStr} | ${statusIcon} | ${inputStr} | ${outputStr} | ${costStr} | ${latencyStr} | ${durationStr} | ${speedStr} |\n`
                    );
                }
            }
        } catch (err) {
            // 忽略错误，不影响基本功能
            StatusLogger.debug('[TokenUsageStatusBar] Failed to load recent request records:', err);
        }

        // ========== 统一底部栏：同步状态 + 点击引导 ==========
        md.appendMarkdown(`\n---\n\n${this.buildActionLinks(true)}`);

        return md;
    }

    /**
     * 构建底部操作链接
     * @param horizontal true 横向排列，false 纵向排列
     */
    private buildActionLinks(horizontal: boolean): string {
        const detailCmd = 'command:gcmp.tokenUsage.showDetails';
        const detailLabel = t('Click to view details', '点击查看详情');
        const syncCmd = 'command:gcmp.sync.configure';
        const syncLabel = t('Manage / Sync API Keys', '管理/同步 API Key');
        const modelSettingsCmd = 'command:gcmp.modelSettings.wizard';
        const modelSettingsLabel = t('Set auxiliary tool models', '设置辅助工具模型');

        const links = [
            `[${detailLabel}](${detailCmd})`,
            `[${syncLabel}](${syncCmd})`,
            `[${modelSettingsLabel}](${modelSettingsCmd})`
        ];

        return horizontal ? links.join(' │ ') : links.join('\n\n');
    }

    /**
     * 计算平均输出速度
     * 优先使用 outputSpeeds（已聚合后的平均速度）
     * @param stats 统计数据
     * @returns 格式化的平均速度字符串
     */
    private calculateAverageSpeed(stats: { outputSpeeds?: number }): string {
        if (stats.outputSpeeds && stats.outputSpeeds > 0) {
            return `${stats.outputSpeeds.toFixed(1)} t/s`;
        }
        return '-';
    }

    /**
     * 计算平均首Token延迟
     * @param firstTokenLatency 平均首 Token 延迟(毫秒)
     * @returns 格式化后的平均首 Token 延迟字符串
     */
    private calculateAverageFirstTokenLatency(firstTokenLatency?: number): string {
        if (!firstTokenLatency || firstTokenLatency <= 0) {
            return '-';
        }
        const avgLatency = firstTokenLatency;
        if (avgLatency >= 1000) {
            return `${(avgLatency / 1000).toFixed(1)} s`;
        }
        return `${Math.round(avgLatency)} ms`;
    }

    /**
     * 格式化 token 数量
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
     * 格式化消耗路径：输入(+缓存)+输出=总计
     * 例如：2.2K(+20.3M)+2000=22.5M
     */
    private formatConsumptionPath(actualInput: number, cacheTokens: number, outputTokens: number): string {
        const total = actualInput + outputTokens;
        if (total === 0) {
            return '0';
        }
        const nonCacheInput = actualInput - cacheTokens;
        const inputStr = this.formatTokens(nonCacheInput);
        const cacheStr = cacheTokens > 0 ? `(+${this.formatTokens(cacheTokens)})` : '';
        const outputStr = this.formatTokens(outputTokens);
        const totalStr = this.formatTokens(actualInput + outputTokens);
        return `${inputStr}${cacheStr}+${outputStr}=${totalStr}`;
    }

    /**
     * 格式化最近请求记录的输入Tokens：读取(缓存)+写入(新增)=输入Tokens
     * 预测阶段：若无增量(estimatedIncrement)则直接显示预测总量；
     *          否则显示 上一请求输入(缓存)+新增(写入)=总输入预计
     * 请求完成后：显示实际的 cacheReadTokens + (actualInput - cacheReadTokens) = actualInput
     */
    private formatRecentInputTokens(record: ExtendedTokenRequestLog): string {
        const hasActualUsage =
            (record.status === 'completed' || record.status === 'cancelled') &&
            !!record.rawUsage &&
            record.totalTokens > 0;

        if (hasActualUsage) {
            const totalInput = record.actualInput || 0;
            const readTokens = record.cacheReadTokens || 0;
            const writeTokens = Math.max(0, totalInput - readTokens);
            if (totalInput === 0) {
                return '0';
            }
            const readStr = this.formatTokens(readTokens);
            const writeStr = this.formatTokens(writeTokens);
            return `${readStr}+${writeStr}=${this.formatTokens(totalInput)}`;
        }

        const estimatedInput = record.estimatedInput || 0;
        if (estimatedInput === 0) {
            return '-';
        }

        const estimatedIncrement = record.estimatedIncrement;
        if (estimatedIncrement === undefined || estimatedIncrement <= 0 || estimatedIncrement >= estimatedInput) {
            return `~${this.formatTokens(estimatedInput)}`;
        }

        const previousInput = estimatedInput - estimatedIncrement;
        const readStr = this.formatTokens(previousInput);
        const writeStr = this.formatTokens(estimatedIncrement);
        return `${readStr}+${writeStr}=${this.formatTokens(estimatedInput)}`;
    }

    /**
     * 检查并显示状态
     */
    async checkAndShowStatus(): Promise<void> {
        if (this.statusBarItem) {
            this.statusBarItem.show();
        }
    }

    /**
     * 延迟更新
     */
    delayedUpdate(delayMs: number = 1000): void {
        setTimeout(() => {
            this.updateDisplay();
        }, delayMs);
    }

    /**
     * 销毁状态栏
     */
    dispose(): void {
        this.stopPeriodicUpdate();
        this.statusBarItem?.dispose();
    }
}
