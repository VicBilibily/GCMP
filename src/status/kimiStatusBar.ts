/*---------------------------------------------------------------------------------------------
 *  Kimi For Coding 状态栏项
 *  继承 ProviderStatusBarItem，显示 Kimi For Coding 使用量信息
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { ProviderStatusBarItem, StatusBarItemConfig } from './providerStatusBarItem';
import { StatusLogger } from '../utils/statusLogger';
import { Logger } from '../utils/logger';
import { ApiKeyManager } from '../utils/apiKeyManager';
import { VersionManager } from '../utils/versionManager';
import { t } from '../utils/l10n';
import { ConfigManager } from '../utils/configManager';

/**
 * Kimi 使用量窗口数据
 */
export interface KimiUsageWindow {
    /** 持续时间 */
    duration: number;
    /** 时间单位 */
    timeUnit: string;
    /** 详细信息 */
    detail: {
        /** 限制值（可能是百分比100或Token量） */
        limit: number;
        /** 已使用值（API不返回时默认为0） */
        used: number;
        /** 剩余值 */
        remaining: number;
        /** 重置时间 */
        resetTime?: string;
    };
}

/**
 * Kimi 使用量摘要数据
 */
export interface KimiUsageSummary {
    /** 总限制值（可能是百分比100或Token量） */
    limit: number;
    /** 已使用值 */
    used: number;
    /** 剩余值 */
    remaining: number;
    /** 重置时间 */
    resetTime: string;
}

/**
 * Kimi 并发上限数据
 */
export interface KimiParallelInfo {
    /** 并发上限 */
    limit: number;
}

/**
 * Kimi 加油包余额信息
 */
export interface KimiBoosterWalletBalance {
    /** 余额 ID */
    id: string;
    /** 功能类型 */
    feature: string;
    /** 余额类型 */
    type: string;
    /** 总余额金额 */
    amount: string;
    /** 剩余余额金额 */
    amountLeft: string;
    /** 余额单位 */
    unit: string;
    /** 有效期开始时间 */
    periodStart: string;
    /** 有效期结束时间 */
    periodEnd: string;
    /** 订阅 ID */
    subscriptionId: string;
    /** 用户 ID */
    userId: string;
    /** 创建时间 */
    createTime: string;
    /** 更新时间 */
    updateTime: string;
}

/**
 * Kimi 加油包金额限制
 */
export interface KimiBoosterWalletLimit {
    /** 货币代码 */
    currency: string;
    /** 金额（单位：分） */
    priceInCents: string;
}

/**
 * Kimi 加油包钱包数据
 */
export interface KimiBoosterWallet {
    /** 钱包 ID */
    id: string;
    /** 用户 ID */
    userId: string;
    /** 余额信息 */
    balance: KimiBoosterWalletBalance;
    /** 状态（如 STATUS_ACTIVE / STATUS_DISABLED） */
    status: string;
    /** 是否允许充值 */
    allowTopup: boolean;
    /** 单次充值上限 */
    topupLimit: KimiBoosterWalletLimit;
    /** 自动续费金额 */
    autoRefillCharge: KimiBoosterWalletLimit;
    /** 自动续费触发阈值 */
    autoRefillThreshold: KimiBoosterWalletLimit;
    /** 是否启用月度扣费上限 */
    monthlyChargeLimitEnabled: boolean;
    /** 月度扣费上限 */
    monthlyChargeLimit: KimiBoosterWalletLimit;
    /** 当月已用金额 */
    monthlyUsed: KimiBoosterWalletLimit;
    /** 创建时间 */
    createdAt: string;
    /** 更新时间 */
    updatedAt: string;
}

/**
 * Kimi 状态数据
 */
export interface KimiStatusData {
    /** 总体用量信息 */
    summary: KimiUsageSummary;
    /** 详细使用限制 */
    windows: KimiUsageWindow[];
    /** 并发上限（可选） */
    parallel?: KimiParallelInfo;
    /** 加油包钱包（可选） */
    boosterWallet?: KimiBoosterWallet;
}

/**
 * Kimi For Coding 状态栏项
 * 显示 Kimi For Coding 的使用量信息，包括：
 * - 剩余/总量
 * - 已使用百分比
 * - 支持多时间窗口展示
 */
export class KimiStatusBar extends ProviderStatusBarItem<KimiStatusData> {
    constructor() {
        const config: StatusBarItemConfig = {
            id: 'gcmp.statusBar.kimi',
            name: 'GCMP: Kimi For Coding',
            alignment: vscode.StatusBarAlignment.Right,
            priority: 90,
            refreshCommand: 'gcmp.kimi.refreshUsage',
            apiKeyProvider: 'kimi',
            cacheKeyPrefix: 'kimi',
            logPrefix: 'Kimi Status Bar',
            icon: '$(gcmp-kimi)'
        };
        super(config);
    }

    /**
     * 获取显示文本
     */
    protected getDisplayText(data: KimiStatusData): string {
        const { summary, windows, boosterWallet } = data;
        let displayText = `${this.config.icon} ${summary.remaining}%`;
        // 如果有窗口数据，添加每个窗口的剩余（排除剩余100%的窗口）
        if (windows.length > 0) {
            const windowTexts = windows
                .filter(window => window.detail.remaining < 100)
                .map(window => `${window.detail.remaining}%`);
            if (windowTexts.length > 0) {
                displayText += ` (${windowTexts.join(',')})`;
            }
        }
        // 有加油包且余额大于 0 时，在右侧显示余额
        if (boosterWallet) {
            const amountLeft = parseInt(boosterWallet.balance.amountLeft, 10);
            if (amountLeft > 0) {
                const balanceText = this.formatBoosterCurrency(
                    boosterWallet.topupLimit.currency,
                    boosterWallet.balance.amountLeft
                );
                displayText += ` ${balanceText}`;
            }
        }
        return displayText;
    }

    /**
     * 生成 Tooltip 内容
     */
    protected generateTooltip(data: KimiStatusData): vscode.MarkdownString {
        const md = new vscode.MarkdownString();
        md.supportHtml = true;

        const { summary, windows } = data;
        md.appendMarkdown(`#### ${t('Kimi For Coding Usage', 'Kimi For Coding 使用情况')}\n\n`);

        // 百分比模式：显示频限类型、剩余量、重置时间
        md.appendMarkdown(
            `| ${t('Window', '频限类型')} | ${t('Remaining', '剩余量')} | ${t('Reset Time', '重置时间')} |\n`
        );
        md.appendMarkdown('| :----: | ----: | :----: |\n');

        // 添加每周额度
        const resetTime = new Date(summary.resetTime);
        const resetTimeStr = this.formatDateTime(resetTime);
        md.appendMarkdown(`| **${t('Weekly quota', '每周额度')}** | ${summary.remaining}% | ${resetTimeStr} |\n`);

        // 添加窗口限制
        if (windows.length > 0) {
            for (const window of windows) {
                const timeUnit = this.translateTimeUnit(window.timeUnit, window.duration);
                const { detail, duration } = window;
                const windowResetTime = detail.resetTime ? new Date(detail.resetTime) : undefined;
                const windowResetTimeStr = windowResetTime ? this.formatDateTime(windowResetTime) : t('N/A', '无');
                md.appendMarkdown(`| **${duration} ${timeUnit}** | ${detail.remaining}% | ${windowResetTimeStr} |\n`);
            }
        }

        // 添加加油包信息：仅当加油包存在且余额大于 0 时显示
        if (data.boosterWallet) {
            const wallet = data.boosterWallet;
            const amountLeft = parseInt(wallet.balance.amountLeft, 10);
            if (amountLeft > 0) {
                md.appendMarkdown('\n---\n');

                // 状态行：放到标题右侧，标题加粗但状态不加粗
                const statusText = this.translateBoosterStatus(wallet.status);
                md.appendMarkdown(`**${t('Quota Booster', '额度加油包')}** (${statusText})\n\n`);

                // 加油包信息表格：横向表头，金额保留两位小数
                md.appendMarkdown(
                    `| ${t('Current Bal.', '当前余额')} | ${t('Monthly Used', '本月消费')} | ${t('Monthly Cap', '本月限额')} |\n`
                );
                md.appendMarkdown('| ---: | ---: | ---: |\n');

                const balanceText = this.formatBoosterCurrency(wallet.topupLimit.currency, wallet.balance.amountLeft);
                const monthlyUsedText = this.formatCurrencyLimit(wallet.monthlyUsed, false, 2);
                const monthlyLimitText =
                    wallet.monthlyChargeLimitEnabled ?
                        this.formatCurrencyLimit(wallet.monthlyChargeLimit, true, 2)
                    :   t('Unlimited', '无限制');
                md.appendMarkdown(`| ${balanceText} | ${monthlyUsedText} | ${monthlyLimitText} |\n`);
            }
        }

        // 添加并发上限行
        if (data.parallel) {
            md.appendMarkdown('\n---\n');
            md.appendMarkdown(`**${t('Maximum concurrency', '最高并发上限')}**: ${data.parallel.limit}\n`);
        }

        md.appendMarkdown('\n---\n');
        md.appendMarkdown(`${t('Click the status bar to refresh manually', '点击状态栏可手动刷新')}\n`);
        return md;
    }

    /**
     * 执行 API 查询
     * 直接实现 Kimi For Coding 余量查询逻辑
     */
    protected async performApiQuery(): Promise<{ success: boolean; data?: KimiStatusData; error?: string }> {
        const REMAIN_QUERY_URL = 'https://api.kimi.com/coding/v1/usages';
        const KIMI_KEY = 'kimi';

        try {
            // 检查 Kimi For Coding 密钥是否存在
            const hasCodingKey = await ApiKeyManager.hasValidApiKey(KIMI_KEY);
            if (!hasCodingKey) {
                return {
                    success: false,
                    error: t(
                        'The Kimi For Coding key is not configured. Set the Kimi For Coding API key first.',
                        'Kimi For Coding 专用密钥未配置，请先设置 Kimi For Coding API 密钥'
                    )
                };
            }

            // 获取 Kimi For Coding 密钥
            const apiKey = await ApiKeyManager.getApiKey(KIMI_KEY);
            if (!apiKey) {
                return {
                    success: false,
                    error: t('Unable to get the Kimi For Coding key.', '无法获取 Kimi For Coding 专用密钥')
                };
            }

            Logger.debug('Triggering Kimi For Coding usage query');
            StatusLogger.debug(`[${this.config.logPrefix}] Starting Kimi For Coding quota query...`);

            // 构建请求
            const requestOptions: RequestInit = {
                method: 'GET',
                headers: {
                    'Content-Type': 'application/json',
                    'User-Agent': VersionManager.getUserAgent('Kimi'),
                    Authorization: `Bearer ${apiKey}`
                }
            };

            // 发送请求
            const response = await ConfigManager.fetchWithProxy(REMAIN_QUERY_URL, requestOptions, {
                providerKey: 'kimi'
            });
            const responseText = await response.text();

            StatusLogger.debug(
                `[${this.config.logPrefix}] Quota query response status: ${response.status} ${response.statusText}`
            );

            // 解析响应
            interface KimiBillingResponse {
                user?: {
                    userId: string;
                    region: string;
                    membership: {
                        level: string;
                    };
                    businessId?: string;
                };
                usage?: {
                    limit: string | number;
                    used?: string | number;
                    remaining?: string | number;
                    resetTime: string;
                };
                limits?: {
                    window: {
                        duration: number;
                        timeUnit: string;
                    };
                    detail: {
                        limit: string | number;
                        used?: string | number;
                        remaining?: string | number;
                        resetTime?: string;
                    };
                }[];
                parallel?: {
                    limit: string | number;
                };
                totalQuota?: {
                    limit: string | number;
                    remaining: string | number;
                };
                authentication?: {
                    method: string;
                    scope: string;
                };
                subType?: string;
                boosterWallet?: {
                    id: string;
                    userId: string;
                    balance: {
                        id: string;
                        feature: string;
                        type: string;
                        amount: string;
                        amountLeft: string;
                        unit: string;
                        periodStart: string;
                        periodEnd: string;
                        subscriptionId: string;
                        userId: string;
                        createTime: string;
                        updateTime: string;
                    };
                    status: string;
                    allowTopup: boolean;
                    topupLimit: {
                        currency: string;
                        priceInCents: string;
                    };
                    autoRefillCharge: {
                        currency: string;
                        priceInCents: string;
                    };
                    autoRefillThreshold: {
                        currency: string;
                        priceInCents: string;
                    };
                    monthlyChargeLimitEnabled: boolean;
                    monthlyChargeLimit: {
                        currency: string;
                        priceInCents: string;
                    };
                    monthlyUsed: {
                        currency: string;
                        priceInCents: string;
                    };
                    createdAt: string;
                    updatedAt: string;
                };
                code?: string;
                details?: {
                    type: string;
                    value: string;
                    debug?: {
                        reason: string;
                        localizedMessage?: {
                            locale: string;
                            message: string;
                        };
                    };
                }[];
            }

            let parsedResponse: KimiBillingResponse;
            try {
                parsedResponse = JSON.parse(responseText);
            } catch (parseError) {
                Logger.error(`Failed to parse response JSON: ${parseError}`);
                return {
                    success: false,
                    error: t('Invalid response format: {0}', '响应格式错误: {0}', responseText.substring(0, 200))
                };
            }

            // 检查响应状态
            if (!response.ok) {
                const errorMessage = `HTTP ${response.status}`;
                Logger.error(`Quota query failed: ${errorMessage}`);
                return {
                    success: false,
                    error: t('Query failed: {0}', '查询失败: {0}', errorMessage)
                };
            }

            // 检查具体的认证错误
            if (parsedResponse.code === 'unauthenticated') {
                const errorMessage = t(
                    'The API key is invalid or expired. Check your Kimi API key.',
                    'API密钥无效或已过期，请检查您的Kimi API密钥'
                );
                Logger.error(`Authentication failed: ${errorMessage}`);
                return {
                    success: false,
                    error: t('Authentication failed: {0}', '认证失败: {0}', errorMessage)
                };
            }

            // 检查其他 API 错误
            if (parsedResponse.code !== undefined && parsedResponse.code !== 'unauthenticated') {
                const errorMessage = t('API error: {0}', 'API错误: {0}', parsedResponse.code);
                Logger.error(`Quota API query failed: ${errorMessage}`);
                return {
                    success: false,
                    error: t('API query failed: {0}', 'API查询失败: {0}', errorMessage)
                };
            }

            // 解析成功响应
            StatusLogger.debug(`[${this.config.logPrefix}] Quota query succeeded`);

            // 计算格式化信息
            if (!parsedResponse.usage) {
                return {
                    success: false,
                    error: t('No usage data was returned.', '未获取到用量数据')
                };
            }

            const usage = parsedResponse.usage;

            // 解析数值
            const used = typeof usage.used === 'string' ? parseInt(usage.used, 10) : (usage.used ?? 0);
            const limit = typeof usage.limit === 'string' ? parseInt(usage.limit, 10) : usage.limit;
            const remaining =
                typeof usage.remaining === 'string' ? parseInt(usage.remaining, 10) : (usage.remaining ?? 0);

            // 总体用量信息
            const summary: KimiUsageSummary = {
                limit,
                used,
                remaining,
                resetTime: usage.resetTime
            };

            // 详细使用限制
            const windows: KimiUsageWindow[] = [];
            if (parsedResponse.limits && parsedResponse.limits.length > 0) {
                for (const limitItem of parsedResponse.limits) {
                    const detail = limitItem.detail;
                    const detailUsed = typeof detail.used === 'string' ? parseInt(detail.used, 10) : (detail.used ?? 0);
                    const detailLimit = typeof detail.limit === 'string' ? parseInt(detail.limit, 10) : detail.limit;
                    const detailRemaining =
                        typeof detail.remaining === 'string' ? parseInt(detail.remaining, 10) : (detail.remaining ?? 0);

                    windows.push({
                        duration: limitItem.window.duration,
                        timeUnit: limitItem.window.timeUnit,
                        detail: {
                            limit: detailLimit,
                            used: detailUsed,
                            remaining: detailRemaining,
                            resetTime: detail.resetTime
                        }
                    });
                }
            }

            // 并发上限
            let parallel: KimiParallelInfo | undefined;
            if (parsedResponse.parallel) {
                const parallelLimit =
                    typeof parsedResponse.parallel.limit === 'string' ?
                        parseInt(parsedResponse.parallel.limit, 10)
                    :   parsedResponse.parallel.limit;
                parallel = { limit: parallelLimit };
            }

            // 加油包钱包
            let boosterWallet: KimiBoosterWallet | undefined;
            if (parsedResponse.boosterWallet) {
                const wallet = parsedResponse.boosterWallet;
                boosterWallet = {
                    id: wallet.id,
                    userId: wallet.userId,
                    balance: wallet.balance,
                    status: wallet.status,
                    allowTopup: wallet.allowTopup,
                    topupLimit: wallet.topupLimit,
                    autoRefillCharge: wallet.autoRefillCharge,
                    autoRefillThreshold: wallet.autoRefillThreshold,
                    monthlyChargeLimitEnabled: wallet.monthlyChargeLimitEnabled,
                    monthlyChargeLimit: wallet.monthlyChargeLimit,
                    monthlyUsed: wallet.monthlyUsed,
                    createdAt: wallet.createdAt,
                    updatedAt: wallet.updatedAt
                };
            }

            return {
                success: true,
                data: {
                    summary,
                    windows,
                    parallel,
                    boosterWallet
                }
            };
        } catch (error) {
            const errorMessage = error instanceof Error ? error.message : t('Unknown error', '未知错误');
            Logger.error(`Quota query exception: ${errorMessage}`);
            return {
                success: false,
                error: t('Query error: {0}', '查询异常: {0}', errorMessage)
            };
        }
    }

    /**
     * 检查是否需要高亮警告（剩余百分比低于阈值或任意窗口剩余百分比低于阈值）
     */
    protected shouldHighlightWarning(data: KimiStatusData): boolean {
        const { summary, windows } = data;

        // 检查总体剩余是否低于阈值
        const usedPercentage = summary.used;

        if (usedPercentage >= this.HIGH_USAGE_THRESHOLD) {
            return true;
        }

        // 检查是否存在任意窗口剩余低于阈值
        if (windows.length > 0) {
            for (const window of windows) {
                if (window.detail.used >= this.HIGH_USAGE_THRESHOLD) {
                    return true;
                }
            }
        }

        return false;
    }

    /**
     * 检查是否需要刷新缓存
     * 缓存超过5分钟固定过期时间则刷新
     */
    protected shouldRefresh(): boolean {
        if (!this.lastStatusData) {
            return false;
        }

        const dataAge = Date.now() - this.lastStatusData.timestamp;
        const CACHE_EXPIRY_THRESHOLD = (5 * 60 - 10) * 1000; // 缓存过期阈值 5 分钟

        // 检查缓存是否超过5分钟固定过期时间
        if (dataAge > CACHE_EXPIRY_THRESHOLD) {
            StatusLogger.debug(
                `[${this.config.logPrefix}] 缓存时间(${(dataAge / 1000).toFixed(1)}秒)超过5分钟固定过期时间，触发API刷新`
            );
            return true;
        }

        return false;
    }

    /**
     * 将时间单位转换为中文
     */
    private translateTimeUnit(timeUnit: string, duration: number): string {
        const unitMap: Record<string, { singular: string; plural: string; zh: string }> = {
            TIME_UNIT_SECOND: { singular: 'second', plural: 'seconds', zh: '秒' },
            TIME_UNIT_MINUTE: { singular: 'minute', plural: 'minutes', zh: '分钟' },
            TIME_UNIT_HOUR: { singular: 'hour', plural: 'hours', zh: '小时' },
            TIME_UNIT_DAY: { singular: 'day', plural: 'days', zh: '天' },
            TIME_UNIT_MONTH: { singular: 'month', plural: 'months', zh: '月' },
            TIME_UNIT_YEAR: { singular: 'year', plural: 'years', zh: '年' }
        };
        const unit = unitMap[timeUnit];
        if (!unit) {
            return timeUnit;
        }

        return (
            vscode.env.language.toLowerCase().startsWith('zh') ? unit.zh
            : duration === 1 ? unit.singular
            : unit.plural
        );
    }

    /**
     * 格式化日期时间为 MM/DD HH:mm 格式
     */
    private formatDateTime(date: Date): string {
        const month = String(date.getMonth() + 1).padStart(2, '0');
        const day = String(date.getDate()).padStart(2, '0');
        const hours = String(date.getHours()).padStart(2, '0');
        const minutes = String(date.getMinutes()).padStart(2, '0');
        return `${month}/${day} ${hours}:${minutes}`;
    }

    /**
     * 根据货币代码返回符号
     */
    private getCurrencySymbol(currency: string): string {
        switch (currency) {
            case 'USD':
                return '$';
            case 'CNY':
            case 'RMB':
                return '¥';
            default:
                return '';
        }
    }

    /**
     * 格式化加油包金额限制（分 -> 元）
     * 注意：金额为 0 时对于“已用”应显示 ¥0.00，只有上限为 0 时才表示无限制。
     */
    private formatCurrencyLimit(
        limit: { currency: string; priceInCents: string },
        treatZeroAsUnlimited = false,
        decimals = 2
    ): string {
        const amount = parseInt(limit.priceInCents, 10);
        if (amount === 0 && treatZeroAsUnlimited) {
            return t('Unlimited', '无限制');
        }
        const symbol = this.getCurrencySymbol(limit.currency);
        return `${symbol}${(amount / 100).toFixed(decimals)}`;
    }

    /**
     * 格式化加油包余额金额
     * 官方 API 返回的金额是放大 10^8 后的整数字符串，需要还原为以元为单位的显示金额。
     * 加油包余额展示统一保留两位小数，作为默认精度。
     * @param currency 货币代码（如 CNY、USD），用于推断货币符号
     */
    private formatBoosterCurrency(currency: string, amount: string, decimals = 2): string {
        const numericAmount = parseInt(amount, 10);
        const symbol = this.getCurrencySymbol(currency);
        return `${symbol}${(numericAmount / 1e8).toFixed(decimals)}`;
    }

    /**
     * 翻译加油包状态
     */
    private translateBoosterStatus(status: string): string {
        const statusMap: Record<string, { en: string; zh: string }> = {
            STATUS_ACTIVE: { en: 'Active', zh: '已开启' },
            STATUS_DISABLED: { en: 'Closed', zh: '已关闭' }
        };
        const mapped = statusMap[status];
        if (!mapped) {
            return status;
        }
        return vscode.env.language.toLowerCase().startsWith('zh') ? mapped.zh : mapped.en;
    }

    /**
     * 访问器：获取最后的状态数据（用于测试和调试）
     */
    getLastStatusData(): { data: KimiStatusData; timestamp: number } | null {
        return this.lastStatusData;
    }
}
