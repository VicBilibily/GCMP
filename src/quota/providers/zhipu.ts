/*---------------------------------------------------------------------------------------------
 *  ZhipuAI (智谱) 配额查询与格式化
 *  订阅限额（quota/limit）+ 账户余额明细（query-customer-account-report）双源组合。
 *---------------------------------------------------------------------------------------------*/

import { VersionManager } from '../../utils/runtime/versionManager';
import { StatusLogger } from '../../utils/runtime/statusLogger';
import { t } from '../../utils/runtime/l10n';
import { formatCurrency, formatQuotaDateForSlot } from '../common';
import { QuotaProviderBase } from './base';
import type { QuotaQueryResult, QuotaTable } from '../types';

/** 智谱配额限制项（format 与 query 共用，状态栏展示直接复用） */
export interface ZhipuLimit {
    type: 'TIME_LIMIT' | 'TOKENS_LIMIT';
    unit: number;
    percentage: number;
    usage?: number;
    remaining?: number;
    nextResetTime?: number;
}

/** 智谱 API 响应 */
interface ZhipuQuotaLimitResponse {
    code: number;
    msg: string;
    data: { limits: ZhipuLimit[] };
    success: boolean;
}

/** 智谱账户报告响应（余额明细展示） */
interface ZhipuAccountReportResponse {
    code: number;
    msg: string;
    data: {
        balance?: number;
        rechargeAmount?: number;
        giveAmount?: number;
        totalSpendAmount?: number;
        availableBalance?: number;
    };
    success: boolean;
}

/** 账户余额明细（全人民币，balance 供摘要展示） */
export interface ZhipuAccountBalance {
    balance: number;
    rechargeAmount?: number;
    giveAmount?: number;
    totalSpendAmount?: number;
    availableBalance?: number;
}

/** fetchZhipuUsage 返回的完整快照（订阅限额 + 账户余额，状态栏与面板格式化共用） */
export interface ZhipuUsageSnapshot {
    limits: ZhipuLimit[];
    account?: ZhipuAccountBalance;
}

/** 订阅限额摘要（如 "64% (88%)"，无代币限额时返回空串） */
function buildZhipuLimitsSummary(limits: ZhipuLimit[]): string {
    const tokensLimits = limits.filter(limit => limit.type === 'TOKENS_LIMIT');
    const weekly = tokensLimits.find(limit => limit.unit === 6);
    const hourly = tokensLimits.find(limit => limit.unit === 3);
    const formatRemaining = (limit: ZhipuLimit) => `${100 - (limit.percentage ?? 0)}%`;
    if (weekly && hourly) {
        return `${formatRemaining(weekly)} (${formatRemaining(hourly)})`;
    }
    if (weekly) {
        return formatRemaining(weekly);
    }
    if (hourly) {
        return formatRemaining(hourly);
    }
    if (tokensLimits.length > 0) {
        return formatRemaining(tokensLimits[0]);
    }
    return '';
}

/** 账户余额展示（账户报告的 balance，人民币） */
function formatZhipuBalance(balance: number): string {
    return formatCurrency('CNY', balance);
}

/** 状态栏与面板共用的摘要文本（订阅与余额依次拼接，如 "64% (88%) ¥55.19"，仅余额时 "¥55.19"） */
export function buildZhipuUsageSummary(data: ZhipuUsageSnapshot): string {
    const parts: string[] = [];
    const usage = buildZhipuLimitsSummary(data.limits);
    if (usage) {
        parts.push(usage);
    }
    // 仅在有订阅摘要时隐藏负余额；纯余额场景保留负值
    if (data.account && (data.account.balance >= 0 || data.limits.length === 0)) {
        parts.push(formatZhipuBalance(data.account.balance));
    }
    return parts.join(' ');
}

/** 账户余额明细表（存在充值/赠送金额或欠费时显示：横向标题 + 下一行明细，人民币；否则 undefined） */
export function buildZhipuBalanceTable(account: ZhipuAccountBalance): QuotaTable | undefined {
    if (!((account.rechargeAmount ?? 0) > 0) && !((account.giveAmount ?? 0) > 0) && !(account.balance < 0)) {
        return undefined;
    }
    const cny = (value: number | undefined) => formatCurrency('CNY', value ?? Number.NaN);
    return {
        columns: [
            t('Recharge', '累计充值'),
            t('Granted', '赠送金额'),
            t('Spends', '消费金额'),
            t('Available', '可用余额')
        ],
        rows: [
            [
                cny(account.rechargeAmount),
                cny(account.giveAmount),
                cny(account.totalSpendAmount),
                cny(account.availableBalance ?? account.balance)
            ]
        ],
        align: ['right', 'right', 'right', 'right']
    };
}

/** 窗口标签：unit=3 → 5 小时限额，unit=6 → 每周限额，其余用 defaultLabel */
function getZhipuLimitLabel(limit: ZhipuLimit, defaultLabel: string): string {
    if (limit.unit === 3) {
        return t('Every 5 Hours', '每 5 小时');
    }
    if (limit.unit === 6) {
        return t('Weekly quota', '每周限额');
    }
    return defaultLabel;
}

/** 订阅限额表（列头与行数据，面板与状态栏共用；对齐/加粗等展示元数据由调用方附加） */
export function buildZhipuLimitsTable(limits: ZhipuLimit[]): QuotaTable {
    return {
        columns: [t('Window', '限频类型'), t('Quota', '上限值'), t('Remaining', '剩余量'), t('Reset Time', '重置时间')],
        rows: limits.map(limit => [
            limit.type === 'TIME_LIMIT' ? t('MCP Monthly', 'MCP每月') : getZhipuLimitLabel(limit, t('Quota', '限额')),
            limit.type === 'TIME_LIMIT' ? String(limit.usage ?? '-') : '-',
            limit.type === 'TIME_LIMIT' ? String(limit.remaining ?? '-') : `${100 - (limit.percentage ?? 0)}%`,
            limit.nextResetTime ? formatQuotaDateForSlot('zhipu', new Date(limit.nextResetTime)) : '-'
        ])
    };
}

/** bigmodel / api.z.ai 双站点请求构建（Authorization 直传 API Key） */
function buildZhipuRequest(apiKey: string, site: string | undefined, path: string): { url: string; init: RequestInit } {
    const baseUrl = site === 'api.z.ai' ? 'https://api.z.ai' : 'https://bigmodel.cn';
    return {
        url: `${baseUrl}${path}`,
        init: {
            method: 'GET',
            headers: {
                Authorization: apiKey,
                'Content-Type': 'application/json',
                'User-Agent': VersionManager.getUserAgent('Zhipu')
            }
        }
    };
}

class ZhipuQuotaProvider extends QuotaProviderBase<ZhipuLimit[]> {
    protected readonly providerKey = 'zhipu';

    protected buildRequest(apiKey: string, site: string | undefined): { url: string; init: RequestInit } {
        return buildZhipuRequest(apiKey, site, '/api/monitor/usage/quota/limit');
    }

    protected parseAndValidate(payload: unknown, response: Response): ZhipuLimit[] {
        const parsedResponse = payload as ZhipuQuotaLimitResponse;

        if (!response.ok || !parsedResponse.success || parsedResponse.code !== 200) {
            throw new Error(parsedResponse.msg || `HTTP ${response.status}`);
        }

        const limits = parsedResponse.data?.limits ?? [];
        if (limits.length === 0) {
            throw new Error(t('No remaining quota data was returned.', '未获取到剩余额度数据'));
        }

        return limits;
    }

    protected format(limits: ZhipuLimit[], lastUpdated: string): QuotaQueryResult {
        return formatZhipuUsage({ limits }, lastUpdated);
    }
}

class ZhipuBalanceProvider extends QuotaProviderBase<ZhipuAccountBalance> {
    protected readonly providerKey = 'zhipu';

    protected buildRequest(apiKey: string, site: string | undefined): { url: string; init: RequestInit } {
        return buildZhipuRequest(apiKey, site, '/api/biz/account/query-customer-account-report');
    }

    protected parseAndValidate(payload: unknown, response: Response): ZhipuAccountBalance {
        const parsedResponse = payload as ZhipuAccountReportResponse;

        if (!response.ok || !parsedResponse.success || parsedResponse.code !== 200) {
            throw new Error(parsedResponse.msg || `HTTP ${response.status}`);
        }

        // 报告中部分金额字段可能为 null（如 frozenBalance 的科学计数法 0、todaySpendAmount）
        const toFiniteNumber = (value: number | undefined): number | undefined =>
            typeof value === 'number' && Number.isFinite(value) ? value : undefined;

        const balance = toFiniteNumber(parsedResponse.data?.balance);
        if (balance === undefined) {
            throw new Error(t('No balance data was returned.', '未获取到余额数据'));
        }

        return {
            balance,
            rechargeAmount: toFiniteNumber(parsedResponse.data?.rechargeAmount),
            giveAmount: toFiniteNumber(parsedResponse.data?.giveAmount),
            totalSpendAmount: toFiniteNumber(parsedResponse.data?.totalSpendAmount),
            availableBalance: toFiniteNumber(parsedResponse.data?.availableBalance)
        };
    }

    protected format(account: ZhipuAccountBalance, lastUpdated: string): QuotaQueryResult {
        return formatZhipuUsage({ limits: [], account }, lastUpdated);
    }
}

// ============= 格式化 =============

/** 面板格式化：订阅限额表在前，存在可显示余额明细时追加余额表（类 kimi 订阅+加油包模式） */
export function formatZhipuUsage(data: ZhipuUsageSnapshot, lastUpdated: string): QuotaQueryResult {
    const tables: QuotaTable[] = [];
    if (data.limits.length > 0) {
        tables.push(buildZhipuLimitsTable(data.limits));
    }
    const balanceTable = data.account ? buildZhipuBalanceTable(data.account) : undefined;
    if (balanceTable) {
        tables.push(balanceTable);
    }

    return {
        metricType: data.limits.length > 0 ? 'usage' : 'balance',
        summary: buildZhipuUsageSummary(data) || '-',
        tables,
        lastUpdated
    };
}

// ============= 查询出口 =============

const zhipuProvider = new ZhipuQuotaProvider();
const zhipuBalanceProvider = new ZhipuBalanceProvider();

/** 双源组合查询：订阅限额与账户余额并行；任一成功即返回，全部失败抛订阅查询错误 */
export async function fetchZhipuUsage(apiKey: string, site: string | undefined): Promise<ZhipuUsageSnapshot> {
    const [limitsResult, accountResult] = await Promise.allSettled([
        zhipuProvider.fetch(apiKey, site),
        zhipuBalanceProvider.fetch(apiKey, site)
    ]);
    if (accountResult.status === 'rejected') {
        // 余额失败静默降级（不影响订阅展示），仅留日志排查"余额不显示"类反馈
        StatusLogger.debug(`[Zhipu] Balance query failed: ${String(accountResult.reason)}`);
    }
    const account = accountResult.status === 'fulfilled' ? accountResult.value : undefined;
    if (limitsResult.status === 'fulfilled') {
        return { limits: limitsResult.value, account };
    }
    if (account) {
        return { limits: [], account };
    }
    throw limitsResult.reason;
}

export const queryZhipuQuota = async (
    apiKey: string,
    site: string | undefined,
    lastUpdated: string
): Promise<QuotaQueryResult> => formatZhipuUsage(await fetchZhipuUsage(apiKey, site), lastUpdated);
