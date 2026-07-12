/**
 * 提供商统计组件
 * 负责渲染提供商和模型列表
 */

import type { ProviderData } from '../types';
import { createElement } from '../../utils';
import { TokenStats } from '../../../usages/fileLogger/types';
import {
    calculateTotalTokens,
    formatCost,
    formatTokens,
    calculateAverageSpeed,
    calculateAverageFirstTokenLatency,
    getProviderDisplayName,
    t
} from '../utils';

// ============= 工具函数 =============

/**
 * 创建表格单元格
 */
function createCell(content: string | number, className = '', title?: string): HTMLElement {
    const cell = createElement('td');
    if (className) {
        cell.className = className;
    }
    cell.textContent = String(content);
    if (title) {
        cell.title = title;
    }
    return cell;
}

function formatRequestBreakdown(completed: number, failed: number, cancelled: number): string {
    return `✅ ${completed} | ❌ ${failed} | 🚫 ${cancelled}`;
}

/**
 * 创建带内联成本的 Tokens 单元格
 * 上方显示 token 数，下方显示预估成本
 */
function createTokensCell(tokens: number, cost: number | undefined): HTMLElement {
    const cell = createElement('td');
    const tokenStr = tokens > 0 ? formatTokens(tokens) : '-';
    const costStr = cost !== undefined && cost > 0 ? formatCost(cost, 2) : '';
    if (costStr) {
        cell.innerHTML = [
            `<div class="tokens-row">${tokenStr}</div>`,
            '<div class="tokens-detail">',
            `<span class="tokens-cost">${costStr}</span>`,
            '</div>'
        ].join('');
    } else {
        cell.textContent = tokenStr;
    }
    if (tokens > 0) {
        cell.title = tokens.toLocaleString('en-US');
    }
    return cell;
}

// ============= 组件渲染 =============

/**
 * 创建提供商统计区域
 */
export function createProviderStats(providers: ProviderData[]): HTMLElement {
    const section = createElement('section');

    const h2 = createElement('h2');
    h2.textContent = t('By Provider', '按提供商统计');
    section.appendChild(h2);

    if (providers && providers.length > 0) {
        const table = createElement('table', 'provider-stats-table');
        const thead = createElement('thead');
        const headerRow = createElement('tr');

        const headers = [
            t('Provider / Model', '提供商/模型'),
            t('Input', '输入Tokens'),
            t('Cache', '缓存命中'),
            t('Output', '输出Tokens'),
            t('Tokens', '消耗Tokens'),
            t('Requests', '请求次数'),
            t('Latency', '平均延迟'),
            t('Speed', '平均速度')
        ];
        headers.forEach(h => {
            const th = createElement('th');
            th.textContent = h;
            headerRow.appendChild(th);
        });
        thead.appendChild(headerRow);
        table.appendChild(thead);

        const tbody = createElement('tbody');

        // 计算合计数据
        let totalInput = 0;
        let totalCache = 0;
        let totalOutput = 0;
        let totalRequests = 0;
        let totalCompletedRequests = 0;
        let totalFailedRequests = 0;
        let totalCancelledRequests = 0;
        let totalCost = 0;
        let totalInputCost = 0;
        let totalCacheReadCost = 0;
        let totalCacheWriteCost = 0;
        let totalOutputCost = 0;

        providers.forEach(provider => {
            // 累加合计数据
            const nonCacheInput = Math.max(0, (provider.actualInput || 0) - (provider.cacheTokens || 0));
            totalInput += nonCacheInput;
            totalCache += provider.cacheTokens || 0;
            totalOutput += provider.outputTokens || 0;
            totalRequests += provider.requests || 0;
            totalCompletedRequests += provider.completedRequests || 0;
            totalFailedRequests += provider.failedRequests || 0;
            totalCancelledRequests += provider.cancelledRequests || 0;
            totalCost += provider.estimatedCost || 0;
            totalInputCost += provider.inputCost || 0;
            totalCacheReadCost += provider.cacheReadCost || 0;
            totalCacheWriteCost += provider.cacheWriteCost || 0;
            totalOutputCost += provider.outputCost || 0;

            // 提供商行
            const providerRow = createElement('tr');
            providerRow.style.backgroundColor = 'var(--vscode-editor-inactiveSelectionBackground)';
            providerRow.style.fontWeight = 'bold';

            const totalTokens = calculateTotalTokens(provider);

            providerRow.appendChild(createCell(getProviderDisplayName(provider.providerKey, provider.providerName)));
            providerRow.appendChild(
                createTokensCell(nonCacheInput, (provider.inputCost || 0) + (provider.cacheWriteCost || 0))
            );
            providerRow.appendChild(createTokensCell(provider.cacheTokens, provider.cacheReadCost));
            providerRow.appendChild(createTokensCell(provider.outputTokens, provider.outputCost));
            providerRow.appendChild(createTokensCell(totalTokens, provider.estimatedCost));
            providerRow.appendChild(
                createCell(
                    provider.requests,
                    '',
                    formatRequestBreakdown(
                        provider.completedRequests || 0,
                        provider.failedRequests || 0,
                        provider.cancelledRequests || 0
                    )
                )
            );
            providerRow.appendChild(createCell(calculateAverageFirstTokenLatency(provider)));
            providerRow.appendChild(createCell(calculateAverageSpeed(provider)));

            tbody.appendChild(providerRow);

            // 模型行
            Object.entries(provider.models).forEach(([, stats]) => {
                const modelRow = createElement('tr') as HTMLTableRowElement;
                const totalTokens = calculateTotalTokens(stats);
                const modelNonCacheInput = Math.max(0, (stats.actualInput || 0) - (stats.cacheTokens || 0));

                modelRow.appendChild(createCell(`└─ ${stats.modelName}`, 'model-cell'));
                modelRow.appendChild(
                    createTokensCell(modelNonCacheInput, (stats.inputCost || 0) + (stats.cacheWriteCost || 0))
                );
                modelRow.appendChild(createTokensCell(stats.cacheTokens, stats.cacheReadCost));
                modelRow.appendChild(createTokensCell(stats.outputTokens, stats.outputCost));
                modelRow.appendChild(createTokensCell(totalTokens, stats.estimatedCost));
                modelRow.appendChild(createCell(stats.requests));
                modelRow.appendChild(createCell(calculateAverageFirstTokenLatency(stats)));
                modelRow.appendChild(createCell(calculateAverageSpeed(stats)));

                const cell = modelRow.cells[0] as HTMLElement;
                cell.style.paddingLeft = '24px';
                cell.style.opacity = '0.85';
                tbody.appendChild(modelRow);
            });
        });

        // 添加合计行
        const totalRow = createElement('tr');
        totalRow.style.backgroundColor = 'var(--vscode-editor-selectionBackground)';
        totalRow.style.fontWeight = 'bold';
        totalRow.style.borderTop = '2px solid var(--vscode-editor-selectionForeground)';

        const grandTotal = totalInput + totalCache + totalOutput;
        totalRow.appendChild(createCell(t('Total', '合计')));
        totalRow.appendChild(createTokensCell(totalInput, totalInputCost + totalCacheWriteCost));
        totalRow.appendChild(createTokensCell(totalCache, totalCacheReadCost));
        totalRow.appendChild(createTokensCell(totalOutput, totalOutputCost));
        totalRow.appendChild(createTokensCell(grandTotal, totalCost));
        totalRow.appendChild(
            createCell(
                totalRequests,
                '',
                formatRequestBreakdown(totalCompletedRequests, totalFailedRequests, totalCancelledRequests)
            )
        );
        const mean = (values: number[]): number => {
            const cleaned = values.filter(v => Number.isFinite(v) && v > 0);
            if (cleaned.length === 0) {
                return 0;
            }
            return cleaned.reduce((sum, v) => sum + v, 0) / cleaned.length;
        };

        // 合计口径：对“所有模型”的已聚合指标做算术平均（与 speed 聚合口径保持一致）。
        const allModelSpeeds: number[] = [];
        const allModelLatencies: number[] = [];
        providers.forEach(provider => {
            Object.values(provider.models).forEach(model => {
                if (model.outputSpeeds && model.outputSpeeds > 0) {
                    allModelSpeeds.push(model.outputSpeeds);
                }
                if (model.firstTokenLatency && model.firstTokenLatency > 0) {
                    allModelLatencies.push(model.firstTokenLatency);
                }
            });
        });

        const totalStats = {
            estimatedInput: 0,
            actualInput: 0,
            cacheTokens: 0,
            outputTokens: 0,
            requests: 0,
            completedRequests: totalCompletedRequests,
            failedRequests: totalFailedRequests,
            cancelledRequests: totalCancelledRequests,
            firstTokenLatency: mean(allModelLatencies),
            outputSpeeds: mean(allModelSpeeds)
        } as TokenStats;

        totalRow.appendChild(createCell(calculateAverageFirstTokenLatency(totalStats)));
        totalRow.appendChild(createCell(calculateAverageSpeed(totalStats)));

        tbody.appendChild(totalRow);
        table.appendChild(tbody);
        section.appendChild(table);
    } else {
        const empty = createElement('div', 'empty-message');
        empty.textContent = t('No provider data available', '暂无提供商数据');
        section.appendChild(empty);
    }

    return section;
}
