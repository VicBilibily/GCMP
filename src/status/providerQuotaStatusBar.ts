/*---------------------------------------------------------------------------------------------
 *  参数化配额状态栏
 *  由 config + QuotaStatusAdapter + 标题声明式初始化；表格/摘要/高亮/刷新策略
 *  全部来自 quota 层适配器，本类仅负责 VS Code 状态栏渲染。
 *---------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { ProviderStatusBarItem, StatusBarItemConfig } from './providerStatusBarItem';
import { StatusLogger } from '../utils/runtime/statusLogger';
import { t } from '../utils/runtime/l10n';
import { buildApiKeySwitchLink } from '../utils/config/configSetStore';
import type { QuotaStatusAdapter } from '../quota/statusAdapters';
import type { QuotaTable } from '../quota/types';

/** 通用配额状态栏构造参数 */
export interface ProviderQuotaStatusBarOptions<TRaw> {
    /** 状态栏配置（id/icon/priority/apiKeyProvider 等） */
    config: StatusBarItemConfig;
    /** 数据适配器（query/summary/tables/高亮/刷新提示） */
    adapter: QuotaStatusAdapter<TRaw>;
    /** Tooltip 标题（延迟求值以跟随语言设置） */
    title: () => string;
    /** 数据驱动的动态标题（如订阅套餐名）；提供时优先于 title 作为 tooltip 主标题 */
    titleOf?: (data: TRaw) => string | undefined;
    /** 从数据提取最后更新时间（提供时在 tooltip 尾部展示） */
    lastUpdatedOf?: (data: TRaw) => string | undefined;
}

export class ProviderQuotaStatusBar<TRaw> extends ProviderStatusBarItem<TRaw> {
    private readonly adapter: QuotaStatusAdapter<TRaw>;
    private readonly titleText: () => string;
    private readonly titleOf?: (data: TRaw) => string | undefined;
    private readonly lastUpdatedOf?: (data: TRaw) => string | undefined;

    constructor(options: ProviderQuotaStatusBarOptions<TRaw>) {
        super(options.config);
        this.adapter = options.adapter;
        this.titleText = options.title;
        this.titleOf = options.titleOf;
        this.lastUpdatedOf = options.lastUpdatedOf;
    }

    protected getDisplayText(data: TRaw): string {
        const summary = this.adapter.summary(data);
        return summary ? `${this.config.icon} ${summary}` : `${this.config.icon}`;
    }

    protected generateTooltip(data: TRaw): vscode.MarkdownString {
        const md = new vscode.MarkdownString();
        md.supportHtml = true;
        // 仅放行切换命令：配额表格内容来自 provider 响应，不能整体 trusted
        md.isTrusted = { enabledCommands: ['gcmp.configSet.switchKey'] };
        const heading = this.titleOf?.(data) ?? this.titleText();
        md.appendMarkdown(`#### ${heading}\n\n`);

        const tables = this.adapter.tables(data);
        for (const [index, table] of tables.entries()) {
            if (index > 0) {
                md.appendMarkdown('\n---\n');
            }
            if (table.title) {
                md.appendMarkdown(`${table.title}\n\n`);
            }
            appendQuotaTable(md, table);
        }

        const details = this.adapter.details?.(data) ?? [];
        if (details.length > 0) {
            md.appendMarkdown('\n---\n');
            for (const detail of details) {
                md.appendMarkdown(`${detail}\n`);
            }
        }

        const lastUpdated = this.lastUpdatedOf?.(data);
        if (lastUpdated) {
            md.appendMarkdown('\n---\n');
            md.appendMarkdown(`**${t('Last updated', '最后更新')}** ${lastUpdated}\n`);
        }

        const slot = this.config.apiKeyProvider;
        const switchLink = slot ? buildApiKeySwitchLink(slot) : undefined;
        if (switchLink) {
            md.appendMarkdown('\n---\n');
            md.appendMarkdown(`\n${switchLink}\n`);
        }

        md.appendMarkdown('\n---\n');
        md.appendMarkdown(`${t('Click the status bar to refresh manually', '点击状态栏可手动刷新')}\n`);
        return md;
    }

    /**
     * 查询状态数据（密钥检查与异常包装在 ProviderStatusBarItem 模板）
     */
    protected async performQuery(apiKey: string): Promise<TRaw> {
        return await this.adapter.query(apiKey);
    }

    protected shouldHighlightWarning(data: TRaw): boolean {
        return this.adapter.highlightWarning?.(data, this.HIGH_USAGE_THRESHOLD) ?? false;
    }

    /**
     * 缓存刷新：越过任一重置点（缓存写入早于该点）或超过 5 分钟固定阈值
     * 无缓存数据时刷新（如初始化查询失败后的周期重试，与 Grok/ChatGPT 状态栏行为一致）
     */
    protected shouldRefresh(): boolean {
        if (!this.lastStatusData) {
            return true;
        }

        const dataAge = Date.now() - this.lastStatusData.timestamp;
        const CACHE_EXPIRY_THRESHOLD = (5 * 60 - 10) * 1000;

        const resetPoints = this.adapter.refreshHints?.(this.lastStatusData.data, this.lastStatusData.timestamp) ?? [];
        const minReset = resetPoints.length > 0 ? Math.min(...resetPoints) : 0;
        if (minReset > 0 && this.lastStatusData.timestamp < minReset && Date.now() >= minReset) {
            StatusLogger.debug(`[${this.config.logPrefix}] 缓存写入早于重置点且已越过，触发API刷新`);
            return true;
        }

        if (dataAge > CACHE_EXPIRY_THRESHOLD) {
            StatusLogger.debug(
                `[${this.config.logPrefix}] 缓存时间(${(dataAge / 1000).toFixed(1)}秒)超过5分钟固定过期时间，触发API刷新`
            );
            return true;
        }

        return false;
    }
}

function appendQuotaTable(md: vscode.MarkdownString, table: QuotaTable): void {
    md.appendMarkdown(`| ${table.columns.join(' | ')} |\n`);
    // 对齐行由表格元数据声明（与各状态栏重构前逐列对齐一致），缺省左对齐
    const alignOf = (i: number): string => {
        const a = table.align?.[i] ?? 'left';
        return (
            a === 'center' ? ':---:'
            : a === 'right' ? '---:'
            : ':---'
        );
    };
    md.appendMarkdown(`| ${table.columns.map((_, i) => alignOf(i)).join(' | ')} |\n`);
    const bold = new Set(table.boldColumns ?? []);
    for (const row of table.rows) {
        md.appendMarkdown(`| ${row.map((cell, i) => (bold.has(i) ? `**${cell}**` : cell)).join(' | ')} |\n`);
    }
}
