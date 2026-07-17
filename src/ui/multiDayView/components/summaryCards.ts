import type { MultiDayAnalysisResult } from '../../../usages/multiDay/types';
import type { NativeCostSplit } from '../../../usages/fileLogger/types';
import type { MultiDayRenderOptions } from '../types';
import { formatDisplayCostAmount } from '../../costDisplay';
import { t } from '../../usagesView/utils';
import { createElement, formatTokens } from '../../utils';

function formatNum(n: number): string {
    return n.toLocaleString('en-US');
}

function divideNativeCostSplit(split: NativeCostSplit, divisor: number): NativeCostSplit {
    if (!(divisor > 0)) {
        return {
            totalUsd: 0,
            totalRmb: 0,
            inputUsd: 0,
            inputRmb: 0,
            outputUsd: 0,
            outputRmb: 0,
            cacheReadUsd: 0,
            cacheReadRmb: 0,
            cacheWriteUsd: 0,
            cacheWriteRmb: 0
        };
    }

    return {
        totalUsd: split.totalUsd / divisor,
        totalRmb: split.totalRmb / divisor,
        inputUsd: split.inputUsd / divisor,
        inputRmb: split.inputRmb / divisor,
        outputUsd: split.outputUsd / divisor,
        outputRmb: split.outputRmb / divisor,
        cacheReadUsd: split.cacheReadUsd / divisor,
        cacheReadRmb: split.cacheReadRmb / divisor,
        cacheWriteUsd: split.cacheWriteUsd / divisor,
        cacheWriteRmb: split.cacheWriteRmb / divisor
    };
}

export function createSummaryCards(data: MultiDayAnalysisResult, options: MultiDayRenderOptions): HTMLElement {
    const container = createElement('div', 'summary-cards');
    const dailyAvgNativeCosts = divideNativeCostSplit(data.summary.nativeCosts, data.dayCount);

    const card1 = makeCard(
        t('Total Tokens', '总 Token'),
        formatTokens(data.summary.totalTokens),
        data.summary.tokensChangePct !== null ?
            `${data.summary.tokensChangePct > 0 ? '↑' : '↓'} ${Math.abs(data.summary.tokensChangePct).toFixed(1)}% (${t('vs prev period', '环比')})`
        :   '-',
        'token'
    );
    container.appendChild(card1);

    const card2 = makeCard(
        t('Total Requests', '总请求'),
        formatNum(data.summary.totalRequests),
        `${t('Success Rate', '成功率')}: ${(data.summary.successRate * 100).toFixed(1)}%`,
        'request'
    );
    container.appendChild(card2);

    const card3 = makeCard(
        t('Daily Avg', '日均 Token'),
        formatTokens(data.summary.dailyAvgTokens),
        `${data.dayCount} ${t('days', '天')}`,
        'daily'
    );
    container.appendChild(card3);

    const card4 = makeCard(
        t('Total Cost', '总成本'),
        formatDisplayCostAmount({
            usd: data.summary.totalCost,
            rmb: data.summary.totalCostRmb,
            nativeUsd: data.summary.nativeCosts.totalUsd,
            nativeRmb: data.summary.nativeCosts.totalRmb,
            currency: options.displayCurrency,
            fixedDecimals: 2,
            exactRmb: data.summary.nativeCosts.totalRmb > 0
        }),
        `${t('Daily Avg', '日均')}: ${formatDisplayCostAmount({
            usd: data.summary.dailyAvgCost,
            rmb: data.summary.dailyAvgCostRmb,
            nativeUsd: dailyAvgNativeCosts.totalUsd,
            nativeRmb: dailyAvgNativeCosts.totalRmb,
            currency: options.displayCurrency,
            fixedDecimals: 2,
            exactRmb: dailyAvgNativeCosts.totalRmb > 0
        })}`,
        'cost',
        options.toggleTitle
    );
    container.appendChild(card4);

    return container;
}

function makeCard(label: string, value: string, sub: string, cls: string, toggleTitle?: string): HTMLElement {
    const card = createElement('div', `summary-card type-${cls}`);
    if (toggleTitle) {
        card.dataset.toggleCostCurrency = 'true';
        card.title = toggleTitle;
    }
    card.innerHTML = `<div class="card-label">${label}</div><div class="card-value">${value}</div><div class="card-sub">${sub}</div>`;
    return card;
}
