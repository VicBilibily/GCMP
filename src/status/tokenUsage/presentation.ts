import * as vscode from 'vscode';
import { LeaderElectionService } from '../leaderElectionService';
import { HarRecorder } from '../../utils/net/harRecorder';
import { t } from '../../utils/runtime/l10n';
import type { UsageStatusStats, UsageStatusTotals } from '../../usages/status/snapshot';

export class UsageStatusPresentation {
    render(stats: UsageStatusStats): { text: string; tooltip: vscode.MarkdownString } {
        const totalTokens = stats.total.actualInput + stats.total.outputTokens;
        const totalRequests = stats.total.requests;
        const tokenPart = totalRequests === 0 ? '' : ` ${this.formatTokens(totalTokens)}`;
        const cost = this.statusCost(stats);
        return { text: `${this.icon()}${tokenPart}${cost ? ` ${cost}` : ''}`, tooltip: this.generateTooltip(stats) };
    }

    icon(): string {
        if (typeof vscode.env.remoteName !== 'undefined') {
            return '$(layers-active)';
        }
        return LeaderElectionService.isLeader() ? '$(layers-dot)' : '$(layers)';
    }

    private isChineseLocale(): boolean {
        const language = vscode.env.language.toLowerCase();
        return language === 'zh' || language.startsWith('zh-');
    }

    private fixedCost(amount: number | undefined, currency: 'USD' | 'RMB'): string {
        return amount === undefined || amount <= 0 ? '-' : `${currency === 'RMB' ? '¥' : '$'}${amount.toFixed(2)}`;
    }

    private statusCost(stats: UsageStatusStats): string {
        if (!this.isChineseLocale()) {
            return stats.total.estimatedCost >= 0.01 ? this.fixedCost(stats.total.estimatedCost, 'USD') : '';
        }
        const parts: string[] = [];
        const usd = stats.total.nativeCosts?.totalUsd ?? 0;
        const rmb = stats.total.nativeCosts?.totalRmb ?? 0;
        if (usd >= 0.01) {
            parts.push(this.fixedCost(usd, 'USD'));
        }
        if (rmb >= 0.01) {
            parts.push(this.fixedCost(rmb, 'RMB'));
        }
        return parts.join('+');
    }

    private preferredCurrency(stats: UsageStatusTotals): 'USD' | 'RMB' {
        return this.isChineseLocale() && stats.costedRequests > 0 && stats.rmbExactRequests >= stats.costedRequests ?
                'RMB'
            :   'USD';
    }

    private tableCostMode(stats: UsageStatusStats): 'USD' | 'RMB' | 'MIXED' {
        if (!this.isChineseLocale()) {
            return 'USD';
        }
        const currencies = new Set<'USD' | 'RMB'>();
        for (const provider of Object.values(stats.providers)) {
            if (provider.estimatedCost <= 0 && provider.estimatedCostRmb <= 0) {
                continue;
            }
            currencies.add(this.preferredCurrency(provider));
        }
        return currencies.size > 1 ? 'MIXED' : (currencies.values().next().value ?? 'USD');
    }

    private displayCost(stats: UsageStatusTotals, currency = this.preferredCurrency(stats)): string {
        return this.fixedCost(currency === 'RMB' ? stats.estimatedCostRmb : stats.estimatedCost, currency);
    }

    generateTooltip(stats?: UsageStatusStats): vscode.MarkdownString {
        const md = new vscode.MarkdownString();
        md.supportHtml = true;
        md.isTrusted = {
            enabledCommands: [
                'gcmp.tokenUsage.showDetails',
                'gcmp.configSet.manage',
                'gcmp.modelSettings.wizard',
                'gcmp.har.revealCurrent'
            ]
        };
        const role =
            typeof vscode.env.remoteName !== 'undefined' ? t('Compatibility Mode', '兼容模式')
            : LeaderElectionService.isLeader() ? t('Primary Instance', '主实例')
            : t('Sub Instance', '从实例');
        md.appendMarkdown(
            `**${t("GCMP: Today's Token Usage", 'GCMP: 今日 Token 消耗统计')}** <small>${role}${this.harSuffix()}</small>\n\n`
        );
        md.appendMarkdown('\n---\n');
        const providers = Object.values(stats?.providers ?? {});
        if (!stats || (providers.length === 0 && stats.total.requests === 0)) {
            md.appendMarkdown(
                stats ?
                    t('No usage records yet.', '暂无使用记录。')
                :   t('Loading token usage...', '正在加载 Token 统计...')
            );
            md.appendMarkdown('\n\n---\n\n');
            md.appendMarkdown(this.actionLinks(false));
            return md;
        }
        if (providers.length === 0) {
            providers.push({ ...stats.total, providerName: t('Total', '合计') });
        }
        providers.sort((a, b) => b.actualInput + b.outputTokens - a.actualInput - a.outputTokens);
        md.appendMarkdown(
            `| ${t('Provider', '提供商')} | ${t('Input(+Cache)+Output=Total', '输入(+缓存)+输出=消耗Tokens')} | ${t('Cost', '预估成本')} | ${t('Requests', '请求数')} | ${t('Latency', '平均延迟')} | ${t('Speed', '平均速度')} |\n`
        );
        md.appendMarkdown('| :------------ | ------: | ---: | ----: | ------: | ------: |\n');
        for (const provider of providers) {
            const name = provider.providerName.replace(/[\\`*[\]()|<>]/g, '\\$&').replace(/[\r\n]/g, ' ');
            md.appendMarkdown(
                `| ${name} | ${this.consumption(provider)} | ${this.displayCost(provider)} | ${provider.requests} | ${this.latency(provider.firstTokenLatency)} | ${this.speed(provider.outputSpeeds)} |\n`
            );
        }
        if (providers.length > 1) {
            const mode = this.tableCostMode(stats);
            const path = this.consumption(stats.total);
            const index = path.lastIndexOf('=');
            const cost = mode === 'MIXED' ? '' : this.displayCost(stats.total, mode);
            md.appendMarkdown(
                `| **${t('Total', '合计')}** | ${path.slice(0, index + 1)}**${path.slice(index + 1)}** | ${cost ? `**${cost}**` : ''} | **${stats.total.requests}** | **${this.latency(stats.total.firstTokenLatency)}** | **${this.speed(stats.total.outputSpeeds)}** |\n`
            );
        }
        md.appendMarkdown(`\n---\n\n${this.actionLinks(true)}`);
        return md;
    }

    private harSuffix(): string {
        if (!HarRecorder.getInstance().isEnabled()) {
            return '';
        }
        return ` · ${t('PID', 'PID')} ${process.pid} · [${t('Open HAR file', '打开 HAR 文件')}](command:gcmp.har.revealCurrent)`;
    }

    private actionLinks(horizontal: boolean): string {
        const links = [
            `[${t('Click to view details', '点击查看详情')}](command:gcmp.tokenUsage.showDetails)`,
            `[${t('Manage API Keys', 'API Key 管理')}](command:gcmp.configSet.manage)`,
            `[${t('Set auxiliary preferences', '设置辅助偏好')}](command:gcmp.modelSettings.wizard)`
        ];
        return links.join(horizontal ? ' │ ' : '\n\n');
    }

    private speed(value?: number): string {
        return value && value > 0 ? `${value.toFixed(1)} t/s` : '-';
    }

    private latency(value?: number): string {
        if (!value || value <= 0) {
            return '-';
        }
        return value >= 1000 ? `${(value / 1000).toFixed(1)} s` : `${Math.round(value)} ms`;
    }

    private formatTokens(tokens: number): string {
        if (tokens >= 1000000) {
            return `${(tokens / 1000000).toFixed(1)}M`;
        }
        return tokens >= 1000 ? `${(tokens / 1000).toFixed(1)}K` : tokens.toString();
    }

    private consumption(stats: UsageStatusTotals): string {
        const total = stats.actualInput + stats.outputTokens;
        if (total === 0) {
            return '0';
        }
        const cache = stats.cacheTokens > 0 ? `(+${this.formatTokens(stats.cacheTokens)})` : '';
        return `${this.formatTokens(stats.actualInput - stats.cacheTokens)}${cache}+${this.formatTokens(stats.outputTokens)}=${this.formatTokens(total)}`;
    }
}
