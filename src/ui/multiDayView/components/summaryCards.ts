import type { MultiDayAnalysisResult } from '../../../usages/multiDay/types';
import { t } from '../../usagesView/utils';
import { createElement } from '../../utils';

function abbrev(n: number): string {
    if (n >= 1_000_000) return (n / 1_000_000).toFixed(2) + 'M';
    if (n >= 1_000) return (n / 1_000).toFixed(1) + 'K';
    return String(n);
}

function formatNum(n: number): string {
    return n.toLocaleString('en-US');
}

export function createSummaryCards(data: MultiDayAnalysisResult): HTMLElement {
    const container = createElement('div', 'summary-cards');

    const card1 = makeCard(
        t('Total Tokens', '总 Token'),
        abbrev(data.summary.totalTokens),
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
        abbrev(data.summary.dailyAvgTokens),
        `${data.dayCount} ${t('days', '天')}`,
        'daily'
    );
    container.appendChild(card3);

    return container;
}

function makeCard(label: string, value: string, sub: string, cls: string): HTMLElement {
    const card = createElement('div', `summary-card type-${cls}`);
    card.innerHTML = `<div class="card-label">${label}</div><div class="card-value">${value}</div><div class="card-sub">${sub}</div>`;
    return card;
}
