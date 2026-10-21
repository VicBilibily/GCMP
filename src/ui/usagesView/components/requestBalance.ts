import type { RequestBalanceLog, RequestStatusSnapshot } from '../../../usages/fileLogger/types';
import type { BalanceQueryItem } from '../../../quota/compatible/balanceQuery';
import type { QuotaTable } from '../../../quota/types';
import { buildOpenCodeUsageSummary } from '../../../quota/parsers/opencodeUsage';
import { isKimiMonthlyCapEnabled } from '../../../quota/parsers/kimiUsageParser';
import { createElement } from '../../utils';
import { t as translateCurrent } from '../utils';

type Translate = (english: string, chinese: string) => string;

interface BalanceSection {
    id: string;
    text: string;
    tables: QuotaTable[];
    details?: string[];
    rowUpdates?: string[];
    balanceItems?: Array<BalanceQueryItem & { name: string }>;
    updatedAt: string;
    translate: Translate;
}

let nextTooltipId = 0;
let dismissTooltip: (() => void) | undefined;

function amount(value: number | undefined, currency: string, translate: Translate): string {
    if (value === undefined || !Number.isFinite(value)) {
        return '-';
    }
    if (value === Number.MAX_SAFE_INTEGER) {
        return translate('Unlimited', '无限制');
    }
    if (value === Number.MIN_SAFE_INTEGER) {
        return translate('Depleted', '耗尽');
    }
    if (currency === 'USD') {
        return `$${value.toFixed(2)}`;
    }
    if (currency === 'CNY' || currency === 'RMB') {
        return `\u00a5${value.toFixed(2)}`;
    }
    return `${Number.isInteger(value) ? value : value.toFixed(2)} ${currency}`;
}

function dateText(timestamp: number, separator?: string): string {
    if (!Number.isFinite(timestamp) || !Number.isFinite(new Date(timestamp).getTime())) {
        return '-';
    }
    try {
        const options: Intl.DateTimeFormatOptions = {
            year: 'numeric',
            month: '2-digit',
            day: '2-digit',
            hour: '2-digit',
            minute: '2-digit',
            second: '2-digit',
            hourCycle: 'h23'
        };
        const locale = globalThis.document?.documentElement?.lang || globalThis.navigator?.language || undefined;
        const formatter = new Intl.DateTimeFormat(locale, options);
        if (!separator) {
            return formatter.format(timestamp);
        }
        const parts = formatter.formatToParts(timestamp);
        const part = (name: Intl.DateTimeFormatPartTypes) => parts.find(value => value.type === name)?.value ?? '';
        return `${part('month')}${separator}${part('day')} ${part('hour')}:${part('minute')}`;
    } catch {
        return new Date(timestamp).toISOString();
    }
}

function countdown(resetAt: string | undefined, queriedAt: number, translate: Translate): string {
    if (!resetAt) {
        return '\u2014';
    }
    const seconds = Math.floor((new Date(resetAt).getTime() - queriedAt) / 1000);
    if (!Number.isFinite(seconds) || seconds <= 0) {
        return translate('Resets soon', '即将重置');
    }
    const days = Math.floor(seconds / 86400);
    const hours = Math.floor((seconds % 86400) / 3600);
    const minutes = Math.floor((seconds % 3600) / 60);
    if (days) {
        return `${days}d${hours ? ` ${String(hours).padStart(2, '0')}h` : ''}`;
    }
    if (hours) {
        return `${hours}h${minutes ? ` ${String(minutes).padStart(2, '0')}m` : ''}`;
    }
    return minutes ? `${minutes}m` : `${seconds}s`;
}

function balancesTable(items: Array<BalanceQueryItem & { name: string }>, translate: Translate): QuotaTable {
    const detailed = items.some(item => item.paid !== undefined || item.granted !== undefined);
    return {
        columns: [
            translate('Provider', '提供商'),
            ...(detailed ? [translate('Paid Balance', '充值余额'), translate('Granted', '赠金余额')] : []),
            translate('Available', '可用余额')
        ],
        rows: items.map(item => [
            item.name,
            ...(detailed ?
                [amount(item.paid, item.currency, translate), amount(item.granted, item.currency, translate)]
            :   []),
            amount(item.balance, item.currency, translate)
        ]),
        align: detailed ? ['left', 'right', 'right', 'right'] : ['left', 'right']
    };
}

function fromSnapshot(snapshot: RequestStatusSnapshot): BalanceSection | undefined {
    if (snapshot.version !== 1 || !Number.isFinite(snapshot.queriedAt)) {
        return undefined;
    }
    const translate = translateCurrent;
    const section: BalanceSection = {
        id: snapshot.provider,
        text: '',
        tables: [],
        updatedAt: dateText(snapshot.queriedAt),
        translate
    };
    switch (snapshot.provider) {
        case 'moonshot': {
            const { balanceInfo } = snapshot.data;
            section.text = `\u00a5${balanceInfo.available_balance.toFixed(2)}`;
            section.tables = [
                {
                    columns: [
                        translate('Currency', '货币'),
                        translate('Cash Balance', '现金余额'),
                        translate('Voucher', '代金券'),
                        translate('Available', '可用余额')
                    ],
                    rows: [
                        [
                            'CNY',
                            balanceInfo.cash_balance.toFixed(2),
                            balanceInfo.voucher_balance.toFixed(2),
                            balanceInfo.available_balance.toFixed(2)
                        ]
                    ],
                    align: ['left', 'right', 'right', 'right'],
                    boldColumns: [0, 3]
                }
            ];
            break;
        }
        case 'deepseek': {
            const { primaryBalance, allBalances } = snapshot.data;
            const value = Number.parseFloat(primaryBalance.total_balance);
            section.text =
                Number.isFinite(value) ?
                    `${primaryBalance.currency === 'USD' ? '$' : '\u00a5'}${value.toFixed(2)}`
                :   '-';
            section.tables = [
                {
                    columns: [
                        translate('Currency', '货币'),
                        translate('Paid Balance', '充值余额'),
                        translate('Granted', '赠金余额'),
                        translate('Available', '可用余额')
                    ],
                    rows: allBalances.map(balance => [
                        balance.currency,
                        balance.topped_up_balance,
                        balance.granted_balance,
                        balance.total_balance
                    ]),
                    align: ['left', 'right', 'right', 'right'],
                    boldColumns: [0, 3]
                }
            ];
            break;
        }
        case 'commandcode': {
            const data = snapshot.data;
            const remaining = (used: number, cap: number) =>
                cap <= 0 ? 100 : Math.max(0, Math.min(100, ((cap - used) / cap) * 100));
            const fiveHour = data.fiveHour ? remaining(data.fiveHour.used, data.fiveHour.cap) : undefined;
            const weekly = data.weekly ? remaining(data.weekly.used, data.weekly.cap) : undefined;
            const primary = weekly ?? fiveHour;
            section.text = primary === undefined ? `$${data.totalCredits.toFixed(2)}` : `${primary.toFixed(0)}%`;
            if (primary !== undefined) {
                if (weekly !== undefined && fiveHour !== undefined && fiveHour < 100) {
                    section.text += ` (${fiveHour.toFixed(0)}%)`;
                }
                if (data.purchasedCredits > 0) {
                    section.text += ` $${data.purchasedCredits.toFixed(2)}`;
                }
            }
            const rows: string[][] = [];
            for (const [window, label] of [
                [data.fiveHour, translate('5 Hours', '300 分钟')],
                [data.weekly, translate('Weekly quota', '每周额度')]
            ] as const) {
                if (window) {
                    rows.push([
                        label,
                        `${remaining(window.used, window.cap).toFixed(0)}%`,
                        countdown(window.resetAt, snapshot.queriedAt, translate),
                        window.resetAt ? dateText(new Date(window.resetAt).getTime(), '/') : '\u2014'
                    ]);
                }
            }
            if (rows.length) {
                section.tables.push({
                    columns: [
                        translate('Window', '限频类型'),
                        translate('Remaining', '剩余量'),
                        translate('Countdown', '倒计时'),
                        translate('Reset Time', '重置时间')
                    ],
                    rows,
                    align: ['left', 'right', 'right', 'right']
                });
            }
            section.tables.push({
                columns: [
                    translate('Monthly', '每月余额'),
                    translate('Purchased', '充值余额'),
                    translate('Granted', '赠送余额'),
                    translate('Available', '可用余额')
                ],
                rows: [
                    [
                        `$${data.monthlyCredits.toFixed(2)}`,
                        data.purchasedCredits > 0 ? `$${data.purchasedCredits.toFixed(2)}` : '\u2014',
                        data.freeCredits > 0 ? `$${data.freeCredits.toFixed(2)}` : '\u2014',
                        `$${data.totalCredits.toFixed(2)}`
                    ]
                ],
                align: ['right', 'right', 'right', 'right']
            });
            break;
        }
        case 'clinepass': {
            const { limits } = snapshot.data;
            const weekly = limits.find(limit => limit.type === 'weekly');
            const monthly = limits.find(limit => limit.type === 'monthly');
            const fiveHour = limits.find(limit => limit.type === 'five_hour');
            const mainRemain = Math.min(
                weekly ? 100 - weekly.percentUsed : 100,
                monthly ? 100 - monthly.percentUsed : 100
            );
            section.text =
                fiveHour && fiveHour.percentUsed > 0 ?
                    `${mainRemain}% (${100 - fiveHour.percentUsed}%)`
                :   `${mainRemain}%`;
            section.tables = [
                {
                    columns: [
                        translate('Window', '限频类型'),
                        translate('Remaining', '剩余量'),
                        translate('Countdown', '倒计时'),
                        translate('Reset Time', '重置时间')
                    ],
                    rows: limits.map(limit => [
                        limit.type === 'weekly' ? translate('Weekly limit', '每周限额')
                        : limit.type === 'monthly' ? translate('Monthly limit', '每月限额')
                        : translate('5 Hours', '300 分钟'),
                        `${100 - limit.percentUsed}%`,
                        countdown(limit.resetsAt, snapshot.queriedAt, translate),
                        limit.resetsAt ? dateText(new Date(limit.resetsAt).getTime(), '-') : '\u2014'
                    ]),
                    align: ['center', 'right', 'center', 'center'],
                    boldColumns: [0]
                }
            ];
            break;
        }
        case 'minimax-token': {
            const { limits } = snapshot.data;
            const weekly = limits.filter(limit => limit.limitType === 'weekly').map(limit => limit.remaining);
            const hourly = limits.filter(limit => limit.limitType === '5h').map(limit => limit.remaining);
            section.text =
                weekly.length ? `${Math.min(...weekly)}%`
                : hourly.length ? `${Math.min(...hourly)}%`
                : '-';
            if (weekly.length && hourly.length) {
                section.text += ` (${Math.min(...hourly)}%)`;
            }
            section.tables = [
                {
                    columns: [
                        translate('Window', '限频类型'),
                        translate('Remain', '剩余'),
                        translate('Reset Time', '重置时间')
                    ],
                    rows: limits.map(limit => [
                        limit.limitType === '5h' ?
                            translate('Every 5 Hours', '每 5 小时')
                        :   translate('Weekly quota', '每周限额'),
                        `${limit.remaining}%`,
                        limit.resetTime ? dateText(limit.resetTime, '-') : '-'
                    ]),
                    align: ['left', 'right', 'center'],
                    boldColumns: [0]
                }
            ];
            break;
        }
        case 'kimi': {
            const { summary, windows, boosterWallet: wallet, parallel } = snapshot.data;
            const windowRemains = windows
                .filter(window => window.detail.remaining < 100)
                .map(window => `${window.detail.remaining}%`);
            section.text = `${summary.remaining}%${windowRemains.length ? ` (${windowRemains.join(',')})` : ''}`;
            const currency = (value: string, unit: string, scale: number, unlimited = false): string => {
                const numeric = Number.parseInt(value, 10);
                if (!Number.isFinite(numeric)) {
                    return '-';
                }
                if (unlimited && numeric === 0) {
                    return translate('Unlimited', '无限制');
                }
                const symbol =
                    unit === 'USD' ? '$'
                    : unit === 'CNY' || unit === 'RMB' ? '\u00a5'
                    : '';
                return `${symbol}${(numeric / scale).toFixed(2)}`;
            };
            const units: Record<string, [string, string]> = {
                TIME_UNIT_SECOND: ['second', '秒'],
                TIME_UNIT_MINUTE: ['minute', '分钟'],
                TIME_UNIT_HOUR: ['hour', '小时'],
                TIME_UNIT_DAY: ['day', '天'],
                TIME_UNIT_MONTH: ['month', '月'],
                TIME_UNIT_YEAR: ['year', '年']
            };
            section.tables = [
                {
                    columns: [
                        translate('Window', '频限类型'),
                        translate('Remaining', '剩余量'),
                        translate('Reset Time', '重置时间')
                    ],
                    rows: [
                        [
                            summary.period === 'monthly' ?
                                translate('Monthly quota', '每月额度')
                            :   translate('Weekly quota', '每周额度'),
                            `${summary.remaining}%`,
                            dateText(Date.parse(summary.resetTime), '/')
                        ],
                        ...windows.map(window => {
                            const unit = units[window.timeUnit];
                            const label =
                                unit ?
                                    translate(`${unit[0]}${window.duration === 1 ? '' : 's'}`, unit[1])
                                :   window.timeUnit;
                            return [
                                `${window.duration} ${label}`,
                                `${window.detail.remaining}%`,
                                window.detail.resetTime ?
                                    dateText(Date.parse(window.detail.resetTime), '/')
                                :   translate('N/A', '无')
                            ];
                        })
                    ],
                    align: ['center', 'right', 'center'],
                    boldColumns: [0]
                }
            ];
            if (wallet && Number.parseInt(wallet.balance.amountLeft, 10) > 0) {
                section.text += ` ${currency(wallet.balance.amountLeft, wallet.topupLimit.currency, 1e8)}`;
            }
            if (wallet && Number.parseFloat(wallet.balance.amountLeft) > 0) {
                const state =
                    wallet.status === 'STATUS_ACTIVE' ? translate('Active', '已开启')
                    : wallet.status === 'STATUS_DISABLED' ? translate('Closed', '已关闭')
                    : wallet.status;
                section.tables.push({
                    title: `${translate('Quota Booster', '额度加油包')} (${state})`,
                    columns: [
                        translate('Current Bal.', '当前余额'),
                        translate('Monthly Used', '本月消费'),
                        translate('Monthly Cap', '本月限额')
                    ],
                    rows: [
                        [
                            currency(wallet.balance.amountLeft, wallet.topupLimit.currency, 1e8),
                            currency(wallet.monthlyUsed.priceInCents, wallet.monthlyUsed.currency, 100),
                            isKimiMonthlyCapEnabled(wallet.monthlyChargeLimitEnabled, wallet.monthlyChargeLimit) ?
                                currency(
                                    wallet.monthlyChargeLimit.priceInCents,
                                    wallet.monthlyChargeLimit.currency,
                                    100,
                                    true
                                )
                            :   translate('Unlimited', '无限制')
                        ]
                    ],
                    align: ['right', 'right', 'right']
                });
            }
            section.details =
                parallel ? [`${translate('Maximum concurrency', '最高并发上限')}: ${parallel.limit}`] : [];
            break;
        }
        case 'opencode':
        case 'grok':
        case 'codex': {
            const rows: string[][] = [];
            const row = (label: string, remaining: number, resetAt?: string) =>
                rows.push([
                    label,
                    `${remaining.toFixed(0)}%`,
                    countdown(resetAt, snapshot.queriedAt, translate),
                    resetAt ? dateText(Date.parse(resetAt), '/') : '\u2014'
                ]);
            if (snapshot.provider === 'opencode') {
                section.text = buildOpenCodeUsageSummary(snapshot.data);
                for (const window of snapshot.data.windows) {
                    row(
                        window.type === 'rolling' ? translate('5 Hours', '300 分钟')
                        : window.type === 'weekly' ? translate('Weekly quota', '每周额度')
                        : translate('Monthly quota', '每月额度'),
                        window.remainingPercent,
                        window.resetAt
                    );
                }
            } else if (snapshot.provider === 'grok') {
                const { usage } = snapshot.data;
                section.text = `${usage.remainingPercent.toFixed(0)}%`;
                row(
                    usage.type === 'weekly' ?
                        translate('Weekly quota', '每周额度')
                    :   translate('Monthly quota', '每月额度'),
                    usage.remainingPercent,
                    usage.resetAt
                );
            } else {
                const { primary_window: primary, secondary_window: secondary } = snapshot.data.rateLimit;
                const windowType = (seconds: number, secondary = false) => {
                    const windows: Array<[number, string]> = [
                        [18000, translate('5 Hours', '300 分钟')],
                        [86400, translate('Daily quota', '每日额度')],
                        [604800, translate('Weekly quota', '每周额度')],
                        [2592000, translate('Monthly quota', '每月额度')],
                        [31536000, translate('Annual quota', '每年额度')]
                    ];
                    return (
                        windows.find(([duration]) => seconds >= duration * 0.95 && seconds <= duration * 1.05) ??
                        ([
                            0,
                            secondary ? translate('Secondary limit', '次要额度') : translate('Usage limit', '用量额度')
                        ] as const)
                    );
                };
                const primaryType = windowType(primary.limit_window_seconds);
                const secondaryType = secondary && windowType(secondary.limit_window_seconds, true);
                const primaryRemaining = Math.max(0, 100 - primary.used_percent);
                const secondaryRemaining = secondary ? Math.max(0, 100 - secondary.used_percent) : 0;
                const main =
                    primaryType[0] === 18000 ?
                        secondaryType && secondaryType[0] !== 18000 ?
                            secondaryRemaining
                        :   0
                    :   primaryRemaining;
                const short =
                    primaryType[0] === 18000 ? primaryRemaining
                    : secondaryType?.[0] === 18000 ? secondaryRemaining
                    : 0;
                section.text = `${main.toFixed(0)}%${short > 0 ? ` (${short.toFixed(0)}%)` : ''}`;
                row(primaryType[1], primaryRemaining, new Date(primary.reset_at * 1000).toISOString());
                if (secondary && secondaryType) {
                    row(secondaryType[1], secondaryRemaining, new Date(secondary.reset_at * 1000).toISOString());
                }
            }
            section.tables = [
                {
                    columns: [
                        translate('Window', '限频类型'),
                        translate('Remaining', '剩余量'),
                        translate('Countdown', '倒计时'),
                        translate('Reset Time', '重置时间')
                    ],
                    rows,
                    align: ['center', 'right', 'center', 'center'],
                    boldColumns: [0, ...(snapshot.provider === 'opencode' ? [] : [1])]
                }
            ];
            break;
        }
        case 'zhipu': {
            const { limits, account } = snapshot.data;
            const tokens = limits.filter(limit => limit.type === 'TOKENS_LIMIT');
            const weekly = tokens.find(limit => limit.unit === 6);
            const hourly = tokens.find(limit => limit.unit === 3);
            const remaining = (percentage: number) => `${100 - (percentage ?? 0)}%`;
            section.text =
                weekly && hourly ? `${remaining(weekly.percentage)} (${remaining(hourly.percentage)})`
                : tokens.length ? remaining((weekly ?? hourly ?? tokens[0]).percentage)
                : '';
            if (account && (account.balance >= 0 || !limits.length)) {
                section.text = [section.text, `\u00a5${account.balance.toFixed(2)}`].filter(Boolean).join(' ');
            }
            if (limits.length) {
                section.tables.push({
                    columns: [
                        translate('Window', '限频类型'),
                        translate('Quota', '上限值'),
                        translate('Remaining', '剩余量'),
                        translate('Reset Time', '重置时间')
                    ],
                    rows: limits.map(limit => [
                        limit.type === 'TIME_LIMIT' ? translate('MCP Monthly', 'MCP每月')
                        : limit.unit === 3 ? translate('Every 5 Hours', '每 5 小时')
                        : limit.unit === 6 ? translate('Weekly quota', '每周限额')
                        : translate('Quota', '限额'),
                        limit.type === 'TIME_LIMIT' ? String(limit.usage ?? '-') : '-',
                        limit.type === 'TIME_LIMIT' ? String(limit.remaining ?? '-') : remaining(limit.percentage),
                        limit.nextResetTime ? dateText(limit.nextResetTime, '-') : '-'
                    ]),
                    align: ['left', 'right', 'right', 'right']
                });
            }
            if (
                account &&
                ((account.rechargeAmount ?? 0) > 0 || (account.giveAmount ?? 0) > 0 || account.balance < 0)
            ) {
                section.tables.push({
                    columns: [
                        translate('Recharge', '累计充值'),
                        translate('Granted', '赠送金额'),
                        translate('Spends', '消费金额'),
                        translate('Available', '可用余额')
                    ],
                    rows: [
                        [
                            account.rechargeAmount,
                            account.giveAmount,
                            account.totalSpendAmount,
                            account.availableBalance ?? account.balance
                        ].map(value => amount(value, 'CNY', translate))
                    ],
                    align: ['right', 'right', 'right', 'right']
                });
            }
            break;
        }
        case 'compatible': {
            const { providerId, providerName, balanceInfo } = snapshot.data;
            const items: BalanceQueryItem[] = balanceInfo.items?.length ? balanceInfo.items : [balanceInfo];
            section.id = providerId;
            section.text = items.map(item => amount(item.balance, item.currency, translate)).join(' ');
            section.balanceItems = items.map(item => ({
                ...item,
                name: item.displayName ? `${providerName} / ${item.displayName}` : providerName
            }));
            section.tables = [balancesTable(section.balanceItems, translate)];
            break;
        }
        default:
            return undefined;
    }
    return section.text ? section : undefined;
}

function sectionsFor(balance: RequestBalanceLog): BalanceSection[] {
    const sections: BalanceSection[] = [];
    for (const snapshot of Array.isArray(balance.statusSnapshots) ? balance.statusSnapshots : []) {
        try {
            const section = fromSnapshot(snapshot);
            if (section) {
                sections.push(section);
            }
        } catch {
            continue;
        }
    }
    sections.sort((left, right) => left.id.localeCompare(right.id));
    const covered = new Set(sections.map(section => section.id));
    const entries = (Array.isArray(balance.entries) ? balance.entries : []).filter(
        entry => entry && !covered.has(entry.id) && Number.isFinite(entry.balance) && typeof entry.currency === 'string'
    );
    const legacy = entries.flatMap(entry => {
        const items: BalanceQueryItem[] = Array.isArray(entry.items) && entry.items.length ? entry.items : [entry];
        return items
            .filter(item => item && Number.isFinite(item.balance) && typeof item.currency === 'string')
            .map(item => ({ ...item, name: item.displayName ?? entry.id }));
    });
    if (legacy.length) {
        sections.push({
            id: 'legacy',
            text: legacy.map(item => amount(item.balance, item.currency, translateCurrent)).join(' '),
            tables: [balancesTable(legacy, translateCurrent)],
            updatedAt: dateText(balance.queriedAt),
            translate: translateCurrent
        });
    }
    const compatible = sections.filter(section => section.balanceItems);
    const first = compatible[0];
    if (!first) {
        return sections;
    }
    const sharedUpdateTime = compatible.every(section => section.updatedAt === first.updatedAt);
    const combined: BalanceSection = {
        ...first,
        text: compatible.map(section => section.text).join(' '),
        tables: [
            balancesTable(
                compatible.flatMap(section => section.balanceItems ?? []),
                first.translate
            )
        ],
        updatedAt: sharedUpdateTime ? first.updatedAt : '',
        rowUpdates:
            sharedUpdateTime ? undefined : (
                compatible.flatMap(section =>
                    (section.balanceItems ?? []).map(
                        () => `${section.translate('Last updated', '最后更新')}: ${section.updatedAt}`
                    )
                )
            )
    };
    return sections.flatMap(section =>
        section === first ? [combined]
        : section.balanceItems ? []
        : [section]
    );
}

function appendTable(parent: HTMLElement, data: QuotaTable, rowUpdates?: string[]): void {
    const table = createElement('table', 'request-balance-table');
    if (data.title) {
        table.appendChild(createElement('caption', 'request-balance-table-title', { textContent: data.title }));
    }
    const head = createElement('thead');
    const header = createElement('tr');
    for (const [index, column] of data.columns.entries()) {
        const cell = createElement('th', '', { textContent: column });
        cell.style.textAlign = data.align?.[index] ?? 'left';
        header.appendChild(cell);
    }
    head.appendChild(header);
    const body = createElement('tbody');
    for (const [rowIndex, cells] of data.rows.entries()) {
        const row = createElement('tr');
        for (const [index, text] of cells.entries()) {
            const cell = createElement('td');
            if (index === 0 && rowUpdates?.[rowIndex]) {
                cell.append(
                    createElement('div', 'request-balance-provider', { textContent: text }),
                    createElement('div', 'request-balance-row-updated', { textContent: rowUpdates[rowIndex] })
                );
            } else {
                cell.textContent = text;
            }
            cell.style.textAlign = data.align?.[index] ?? 'left';
            if (data.boldColumns?.includes(index)) {
                cell.style.fontWeight = '600';
            }
            row.appendChild(cell);
        }
        body.appendChild(row);
    }
    table.append(head, body);
    parent.appendChild(table);
}

export function createRequestBalance(balance: RequestBalanceLog | null | undefined): HTMLElement | undefined {
    if (!balance) {
        return undefined;
    }
    const sections = sectionsFor(balance);
    if (!sections.length) {
        return undefined;
    }
    const element = createElement('div', 'prov-model-balance', { tabIndex: 0, title: '' });
    element.appendChild(
        createElement('span', 'request-balance-summary', {
            textContent: sections.map(section => section.text).join(' ')
        })
    );
    const tooltip = createElement('div', 'request-balance-tooltip', {
        id: `request-balance-tooltip-${++nextTooltipId}`,
        hidden: true
    });
    tooltip.setAttribute('role', 'tooltip');
    element.setAttribute('aria-describedby', tooltip.id);
    for (const section of sections) {
        const group = createElement(
            'section',
            section.balanceItems ?
                'request-balance-section request-balance-section-compatible'
            :   'request-balance-section'
        );
        for (const table of section.tables) {
            appendTable(group, table, section.rowUpdates);
        }
        for (const detail of section.details ?? []) {
            group.appendChild(createElement('div', 'request-balance-detail', { textContent: detail }));
        }
        if (section.updatedAt) {
            group.appendChild(
                createElement('div', 'request-balance-updated', {
                    textContent: `${section.translate('Last updated', '最后更新')}: ${section.updatedAt}`
                })
            );
        }
        tooltip.appendChild(group);
    }
    element.appendChild(tooltip);
    let observer: MutationObserver | undefined;
    let leaveTimer: ReturnType<typeof setTimeout> | undefined;
    const cancelLeave = () => {
        if (leaveTimer !== undefined) {
            clearTimeout(leaveTimer);
            leaveTimer = undefined;
        }
    };
    const hide = () => {
        cancelLeave();
        if (tooltip.hidden) {
            return;
        }
        tooltip.hidden = true;
        observer?.disconnect();
        observer = undefined;
        window.removeEventListener('scroll', onScroll, true);
        window.removeEventListener('resize', hide);
        document.removeEventListener('keydown', escape);
        element.appendChild(tooltip);
        if (dismissTooltip === hide) {
            dismissTooltip = undefined;
        }
    };
    const escape = (event: KeyboardEvent) => {
        if (event.key === 'Escape') {
            hide();
        }
    };
    const onScroll = (event: Event) => {
        if (event.target && event.target !== window && tooltip.contains(event.target as Node)) {
            return;
        }
        hide();
    };
    const leave = () => {
        cancelLeave();
        if (document.activeElement !== element) {
            leaveTimer = setTimeout(hide, 120);
        }
    };
    const show = () => {
        cancelLeave();
        if (!tooltip.hidden) {
            return;
        }
        dismissTooltip?.();
        dismissTooltip = hide;
        document.body.appendChild(tooltip);
        tooltip.hidden = false;
        const anchor = element.getBoundingClientRect();
        const bounds = tooltip.getBoundingClientRect();
        tooltip.style.left = `${Math.max(8, Math.min(anchor.left, window.innerWidth - bounds.width - 8))}px`;
        const top =
            anchor.bottom + bounds.height + 8 <= window.innerHeight ?
                anchor.bottom + 6
            :   anchor.top - bounds.height - 6;
        tooltip.style.top = `${Math.max(8, Math.min(top, window.innerHeight - bounds.height - 8))}px`;
        window.addEventListener('scroll', onScroll, true);
        window.addEventListener('resize', hide);
        document.addEventListener('keydown', escape);
        if (typeof MutationObserver !== 'undefined') {
            observer = new MutationObserver(() => {
                if (!element.isConnected) {
                    hide();
                }
            });
            observer.observe(document.body, { childList: true, subtree: true });
        }
    };
    element.onmouseenter = show;
    element.onfocus = show;
    element.onmouseleave = event => {
        if (!event.relatedTarget || !tooltip.contains(event.relatedTarget as Node)) {
            leave();
        }
    };
    element.onblur = hide;
    tooltip.onmouseenter = cancelLeave;
    tooltip.onmouseleave = event => {
        if (!event.relatedTarget || !element.contains(event.relatedTarget as Node)) {
            leave();
        }
    };
    return element;
}
